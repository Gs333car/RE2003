/* 3D Viewer: the studio's landing screen. Open a mod folder → the main car
   model loads into a full-screen Three.js viewport, textured from the mod's
   own .mip files, with Blender-style orbit/pan/zoom. Edit options: skin the
   car with any .car paint from the folder or the Paint Booth scheme, replace
   textures (baked into the rebuilt .dat), export OBJ/STL.
   Classic script on purpose (THREE from vendored UMD build) so the app keeps
   working when RE2003.html is opened straight from the Finder (file:// blocks
   ES modules). */
const Viewer = (() => {

const $ = (id) => document.getElementById(id);

/* kiosk knobs from the load URL: field=N caps the pit-stall field (physics +
   render), res=S scales the renderer pixelRatio. 0/1 = off (desktop default). */
const _kq = new URLSearchParams(location.search);
const KIOSK_FIELD = /^\d+$/.test(_kq.get('field') || '') ? parseInt(_kq.get('field'), 10) : 0;
const KIOSK_RES = /^(\d+(\.\d+)?)$/.test(_kq.get('res') || '') ? parseFloat(_kq.get('res')) : 1;

/* ---------- state ---------- */
let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let trackControlSpan = 100;
const SHOWROOM_CTRL = { rotateSpeed: 1, zoomSpeed: 1, panSpeed: 1, keyPanSpeed: 7, dampingFactor: 0.08, minDistance: 0, maxDistance: Infinity };
let modelGroup = null;
let trackGroup = null;
let carFieldGroup = null;    /* grid + pit-stall copies of the loaded car */
let carEnvMap = null;        /* shared cubemap reflection worn by every car */
let carEnvRT = null;         /* its render target (disposed on re-bake) */
let carEnvCam = null;        /* reused CubeCamera — re-rendered live while driving */
let _envFrame = 0;           /* frame counter throttling the live re-bake */
const _envProbePos = new THREE.Vector3();
/* frame profiler — `Driving.perf(true)` in the console, then load the state and
   read the 1 Hz [perf] line. Buckets the per-frame cost so lag has an EXACT
   source instead of a guess. Every probe is guarded by PERF.on → ~0 cost when off. */
const PERF = { on: false, n: 0, t0: 0, update: 0, probe: 0, render: 0, sense: 0, step: 0, aiDec: 0, carcar: 0, fieldR: 0, substeps: 0, cars: 0, draws: 0, tris: 0, geo: 0, tex: 0, prog: 0 };
function perfReport(now) {
  const n = PERF.n || 1, dur = (now - PERF.t0) || 1;
  if (PERF.cars > 0) {   /* only while a field is racing — no showroom spam */
    const a = (x) => (x / n).toFixed(2), b = (x) => (x / n).toFixed(1);
    console.log(`[perf] ${(n * 1000 / dur).toFixed(0)}fps ${b(dur)}ms/f | update ${b(PERF.update)}`
      + ` (sense ${a(PERF.sense)} step ${b(PERF.step)}[ai ${a(PERF.aiDec)}] carcar ${a(PERF.carcar)} fieldR ${a(PERF.fieldR)})`
      + ` | probe ${a(PERF.probe)} render ${b(PERF.render)} | draws ${PERF.draws} tris ${(PERF.tris / 1000).toFixed(0)}k`
      + ` | geo ${PERF.geo} tex ${PERF.tex} prog ${PERF.prog}`   /* climbing = a leak */
      + ` | substeps ${a(PERF.substeps)} cars ${PERF.cars}`);
  }
  PERF.n = 0; PERF.t0 = now;
  PERF.update = PERF.probe = PERF.render = PERF.sense = PERF.step = PERF.aiDec = PERF.carcar = PERF.fieldR = PERF.substeps = 0;
}
let sunLight = null;         /* directional "sun" for lit track scenery */
let skyLight = null;         /* hemisphere sky/ground ambient */
let lastFrameMs = 0;         /* animation-loop timestamp for physics dt */
/* part hover/selection: hovered part glows red, selected part glows amber.
   hoverTex mirrors the same red glow across every mesh that shares a texture */
let hoverMaterial = null;
let selectMaterial = null;
let hoverIndex = null;
let hoverTex = null;
let paintCommitted = null;   /* last committed .car paint (hover = preview only) */
let paintPreviewing = false; /* true while a hover scheme is on the mesh */
let selectedIndex = null;

/* current mod: dat archive items (live-editable), loose files, car paints */
let mod = null; /* { folderName, datName, datHeader, datItems, looseFiles,
                     carFiles, modelName, modelItem, carMakeIdx, activePaintCar,
                     meshes, bodyTexture, dirty } */
/* loaded track (scenery from game assets, car parked in a pit stall) */
let track = null; /* { folderName, name, datItems, refs, meta, stall } */
const materialByTexture = new Map(); /* lower-case mip name (+ '|glass'/'|cull' variant suffixes) -> THREE.Material */
const alphaDataByTexture = new Map(); /* lower-case mip name -> ImageData | null */
const SHOWROOM_BG = 0x393939;   /* Blender viewport gray */
const TRACK_BG = 0xc8daef;      /* pale horizon blue — scene clear color */
const SKY_LIGHT = 0xbcd2ea;         /* hemisphere: daylight sky (from above) */
const GROUND_LIGHT = 0x4a4038;      /* hemisphere: warm dark ground bounce (below) */
const HEMI_INTENSITY = 0.62;        /* ambient floor + gentle top-down gradient */
const SUN_COLOR = 0xfff4e2;         /* directional sun, faintly warm */
const SUN_INTENSITY = 0.55;         /* SKY_top + SUN ≈ 1.17 peak on sun-facing faces */
const SUN_DIR = [-0.35, 1.0, 0.28]; /* high afternoon sun, scene Y-up */
const CUSTOM_SUN_ELEVATION_DEG = 52; /* RE2003 procedural day sky sun height */
/* Night tracks (folder/name has "night"): the game switches objects to their
   night texture variants (day_night=2 — darker sheets with baked-lit windows),
   kills the sun, and lights the scene from the stadium light towers
   (PointLightDescriptors, decoded F12). We reproduce that: a dim cool ambient +
   a near-black sky, plus real point lights clustered per tower for the light
   pools. Tunable, like the day constants. */
const NIGHT_SKY_LIGHT = 0x2a3850;    /* dim cool night sky ambient */
const NIGHT_GROUND_LIGHT = 0x0a0d13;
const NIGHT_HEMI_INTENSITY = 0.5;    /* enough to read the night skins, still dark */
const NIGHT_SUN_COLOR = 0x33425f;    /* faint moonlight, not a day sun */
const NIGHT_SUN_INTENSITY = 0.1;
const NIGHT_BG = 0x0a1017;
/* stadium tower lights: co-located bulbs (a rack of 12/6 at z≈36 m) are clustered
   into one light per tower so the count stays small and cheap */
const TOWER_LIGHT_CELL_M = 20;       /* cluster bulbs within this radius (bigger = fewer lights) */
const MAX_TOWER_LIGHTS = 24;
const TOWER_LIGHT_COLOR = 0xfdf6e6;  /* metal-halide near-white, faint warm */
const TOWER_LIGHT_INTENSITY = 1.25;  /* softened so objects under a tower don't blow out */
const TOWER_LIGHT_DISTANCE = 150;    /* metres to falloff (towers are tall) */
const TOWER_LIGHT_DECAY = 1.4;       /* faster falloff → tighter, softer pools */

/* ---- HDR render pipeline: ACES filmic tone mapping + exposure/contrast, and
   a single car-FOLLOWING sun-shadow cascade. Lightweight by design — output is
   already sRGB with sRGB textures, so tone mapping drops in for free (no extra
   pass), and the one shadow map covers only a tight ~68 m box around the car
   (crisp at 2048, cheap because the frustum culls the rest of the 4 km track).
   All of it is user-dial-able and can be switched off for FPS. */
const BAKED = (typeof RE2003_BAKED_DEFAULTS !== 'undefined') ? RE2003_BAKED_DEFAULTS : null;
const EXPOSURE_DEFAULT = BAKED?.gfx?.exposure ?? 0.9;   /* Cameron factory default */
const CONTRAST_DEFAULT = BAKED?.gfx?.contrast ?? 0.26;
const SATURATION_DEFAULT = BAKED?.gfx?.saturation ?? 1.0;
const LIFT_DEFAULT = BAKED?.gfx?.lift ?? 0.0;
const MASS_DEFAULT = BAKED?.gfx?.mass ?? 1.0;
const SHADOW_MAP_DEFAULT = 2048;      /* tight frustum → sharp at this size */
const SHADOW_HALF_M = 34;             /* half-width of the shadowed box around the car */
const SHADOW_DIST_M = 90;             /* ortho light origin distance along the sun dir */
const SHADOW_DEPTH_M = 85;            /* ± ortho depth so tall trackside objects still cast */
const GFX_LS_KEY = 're2003.gfx.v3';   /* v3: adds saturation + wider contrast range */
let gfx = { exposure: EXPOSURE_DEFAULT, contrast: CONTRAST_DEFAULT, saturation: SATURATION_DEFAULT,
  lift: LIFT_DEFAULT, mass: MASS_DEFAULT, shadows: false, shadowSize: SHADOW_MAP_DEFAULT,
  reflections: BAKED?.gfx?.reflections ?? true, reflectHigh: BAKED?.gfx?.reflectHigh ?? false,
  reflStrength: BAKED?.gfx?.reflStrength ?? 0.15 };
let _baseSun = SUN_INTENSITY, _baseHemi = HEMI_INTENSITY;   /* pre-contrast day/night intensities */
let _shadowFocus = null, _sunDirN = null;   /* THREE.Vector3, built in initGraphics */


function updateSceneBackground() {
  if (!scene) return;
  let col;
  if (!trackGroup) col = SHOWROOM_BG;
  else if (track && track.isNight) col = NIGHT_BG;
  else col = TRACK_BG;
  scene.background = new THREE.Color(col);
}

function syncRendererViewport() {
  if (!renderer || !renderer.domElement) return;
  const w = renderer.domElement.width;
  const h = renderer.domElement.height;
  if (w < 1 || h < 1) return;
  renderer.setRenderTarget(null);
  renderer.setViewport(0, 0, w, h);
  renderer.setScissor(0, 0, w, h);
  renderer.setScissorTest(false);
  const gl = renderer.getContext();
  if (gl) gl.viewport(0, 0, w, h);
}


/* Apply the day or night light rig + background. skyLight/sunLight are created
   in initScene; only lit (Lambert) scenery responds to them. */
function setSceneLighting(isNight) {
  if (!skyLight || !sunLight) return;
  if (isNight) {
    skyLight.color.set(NIGHT_SKY_LIGHT);
    skyLight.groundColor.set(NIGHT_GROUND_LIGHT);
    sunLight.color.set(NIGHT_SUN_COLOR);
    _baseHemi = NIGHT_HEMI_INTENSITY; _baseSun = NIGHT_SUN_INTENSITY;
  } else {
    skyLight.color.set(SKY_LIGHT);
    skyLight.groundColor.set(GROUND_LIGHT);
    sunLight.color.set(SUN_COLOR);
    _baseHemi = HEMI_INTENSITY; _baseSun = SUN_INTENSITY;
  }
  applyGfxContrast();   /* the single writer of the actual intensities (base × contrast) */
  updateSunForTrack(isNight);   /* place the sun (dir + visible disc) for this track */
  updateSceneBackground();
}

/* contrast = the lit:ambient RATIO. >1 pushes the sun up and drops the sky
   fill, so sun-facing panels punch and shadowed sides deepen — a real 3-D
   contrast with no post-process pass. Paired with tone-mapping exposure below. */
function applyGfxContrast() {
  if (!sunLight || !skyLight) return;
  const c = gfx.contrast;                 /* c = 1 → the untouched base intensities */
  sunLight.intensity = _baseSun * c;      /* >1: punchier sun ... */
  skyLight.intensity = _baseHemi * (2 - c);   /* ...and dimmer ambient fill → deeper shadow */
}

/* SATURATION: a CustomToneMapping that replicates three's EXACT ACES filmic curve
   (so saturation = 1.0 is pixel-identical to the built-in ACESFilmicToneMapping)
   and then blends the result toward its luma. Folded into the existing tone-map
   stage — no extra render pass. The value is baked into the shader, so a change
   recompiles (done on slider RELEASE, not every drag). */
let _tmChunk0 = null;
function applySaturation() {
  if (!renderer || typeof THREE.CustomToneMapping === 'undefined') return;
  if (_tmChunk0 === null) _tmChunk0 = THREE.ShaderChunk.tonemapping_pars_fragment;
  const stub = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
  if (_tmChunk0.indexOf(stub) === -1) {   /* three's chunk shape changed — safe fallback, no saturation */
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    return;
  }
  const sat = gfx.saturation.toFixed(4);
  const lift = gfx.lift.toFixed(4);   /* black level: raise the black point (lifts shadows) */
  const custom =
    'vec3 CustomToneMapping( vec3 color ) {\n' +
    '  const mat3 ACESInputMat = mat3(vec3(0.59719,0.07600,0.02840),vec3(0.35458,0.90834,0.13383),vec3(0.04823,0.01566,0.83777));\n' +
    '  const mat3 ACESOutputMat = mat3(vec3(1.60475,-0.10208,-0.00327),vec3(-0.53108,1.10813,-0.07276),vec3(-0.07367,-0.00605,1.07602));\n' +
    '  color *= toneMappingExposure / 0.6;\n' +
    '  color = ACESInputMat * color;\n' +
    '  vec3 a = color * ( color + 0.0245786 ) - 0.000090537;\n' +
    '  vec3 b = color * ( 0.983729 * color + 0.4329510 ) + 0.238081;\n' +
    '  color = a / b;\n' +
    '  color = ACESOutputMat * color;\n' +
    '  color = clamp( color, 0.0, 1.0 );\n' +
    '  float l = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );\n' +
    '  color = mix( vec3( l ), color, ' + sat + ' );\n' +
    '  color = color * ( 1.0 - ' + lift + ' ) + ' + lift + ';\n' +   /* black-level lift: raise the black point */
    '  return clamp( color, 0.0, 1.0 );\n' +
    '}';
  THREE.ShaderChunk.tonemapping_pars_fragment = _tmChunk0.replace(stub, custom);
  renderer.toneMapping = THREE.CustomToneMapping;
  recompileSceneMaterials();
}

/* ---- sun direction (lighting + shadows) ---- */
let _sunDir = new THREE.Vector3(SUN_DIR[0], SUN_DIR[1], SUN_DIR[2]).normalize();

/* Fixed sun elevation for day tracks. */
function sunElevationFromSky() {
  return CUSTOM_SUN_ELEVATION_DEG * Math.PI / 180;
}

/* set the sun direction for this track (default azimuth, sky-derived height) and
   point the light + shadow the same way. Called from setSceneLighting. */
function updateSunForTrack(isNight) {
  _sunDir.set(SUN_DIR[0], SUN_DIR[1], SUN_DIR[2]).normalize();
  if (!isNight) {
    const el = sunElevationFromSky();
    const hx = SUN_DIR[0], hz = SUN_DIR[2], hl = Math.hypot(hx, hz) || 1;
    _sunDir.set((hx / hl) * Math.cos(el), Math.sin(el), (hz / hl) * Math.cos(el)).normalize();
  }
  if (_sunDirN) _sunDirN.copy(_sunDir);
  if (sunLight) sunLight.position.copy(_sunDir);
}

/* Sun/moon are painted on the procedural sky dome texture only — no 3D billboards. */
function removeLegacySunMeshes() {
  if (!scene) return;
  for (const name of ['sky:sun', 'sky:sun-halo', 'sky:moon']) {
    const o = scene.getObjectByName(name);
    if (!o) continue;
    scene.remove(o);
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  }
}

/* ACES tone mapping + car-following sun shadow, wired once from initScene. */
function initGraphics() {
  if (!renderer || !scene || !sunLight) return;
  _shadowFocus = new THREE.Vector3();
  _sunDirN = _sunDir.clone();   /* shadow frustum follows the (per-track) sun direction */
  seedBakedDefaultsToStorage();
  loadGfxPrefs();
  if (typeof Physics !== 'undefined' && Physics.setMassScale) Physics.setMassScale(gfx.mass);   /* cars born at the saved weight */
  applySaturation();   /* CustomToneMapping = exact ACES + saturation (identical to ACES at 1.0) */
  renderer.toneMappingExposure = gfx.exposure;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.enabled = false;   /* shadows removed entirely */
  sunLight.castShadow = false;           /* the sun light shades scenery but never casts */
  sunLight.shadow.mapSize.set(gfx.shadowSize, gfx.shadowSize);
  sunLight.shadow.bias = -0.0005;         /* trims surface acne on the banked road */
  sunLight.shadow.normalBias = 0.05;      /* trims peter-panning at the tyre contact */
  const sc = sunLight.shadow.camera;      /* Orthographic — the car-box frustum */
  sc.left = -SHADOW_HALF_M; sc.right = SHADOW_HALF_M;
  sc.top = SHADOW_HALF_M; sc.bottom = -SHADOW_HALF_M;
  sc.near = SHADOW_DIST_M - SHADOW_DEPTH_M;
  sc.far = SHADOW_DIST_M + SHADOW_DEPTH_M;
  sc.updateProjectionMatrix();
  scene.add(sunLight.target);   /* target must be in-graph so its matrix updates */
  applyGfxContrast();
  bindGraphicsUI();
}

/* keep the ortho shadow frustum centred on the car each frame — the whole
   lightweight trick: one small, crisp map that travels with the action instead
   of a giant one spanning the entire track. Sun DIRECTION stays fixed (only the
   frustum origin moves), so shading is unchanged — just the shadowed region. */
function updateShadowFrustum() {
  if (!renderer.shadowMap.enabled || !sunLight.castShadow || !_shadowFocus) return;
  const f = _shadowFocus;
  /* centre the shadow box on the CAMERA SUBJECT (the focused/spectated car),
     not always the player — so a car you're watching via TV still casts */
  if (typeof Driving !== 'undefined' && Driving.focusWorldPos && Driving.focusWorldPos(f)) { /* got it */ }
  else if (modelGroup && modelGroup.parent) modelGroup.getWorldPosition(f);
  else f.set(0, 0, 0);
  sunLight.target.position.copy(f);
  sunLight.position.copy(f).addScaledVector(_sunDirN, SHADOW_DIST_M);
  sunLight.target.updateMatrixWorld();
  sunLight.updateMatrixWorld();
}

/* cast/receive flags by role: the road + ground receive; cars, walls and
   scenery cast + receive; the sky/horizon backdrops and the grid do neither.
   The flat surface does NOT cast (it shadows nothing and would just cost the
   pass). Idempotent — safe to re-run on any (re)build. */
function applyShadowFlags(root) {
  if (!root) return;
  root.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    if (o.userData.isHorizon || /grid|sky|backdrop|cloud/i.test(o.name || '')) {
      o.castShadow = false; o.receiveShadow = false; return;
    }
    o.receiveShadow = true;
    o.castShadow = !/^surface:/.test(o.name || '');
  });
}

function loadGfxPrefs() {
  try {
    const bakedRaw = localStorage.getItem('re2003.bakedFactory.v1');
    if (bakedRaw) {
      const bf = JSON.parse(bakedRaw);
      if (bf && bf.gfx) Object.assign(gfx, bf.gfx);
    }
    const raw = localStorage.getItem(GFX_LS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return;
    if (Number.isFinite(s.exposure)) gfx.exposure = Math.min(2.5, Math.max(0.3, s.exposure));
    if (Number.isFinite(s.contrast)) gfx.contrast = Math.min(1.8, Math.max(-0.5, s.contrast));
    if (Number.isFinite(s.saturation)) gfx.saturation = Math.min(1.3, Math.max(0.2, s.saturation));
    if (Number.isFinite(s.lift)) gfx.lift = Math.min(0.5, Math.max(-0.6, s.lift));
    if (Number.isFinite(s.mass)) gfx.mass = Math.min(2, Math.max(0.5, s.mass));
    /* shadows removed — ignore any saved shadow pref so it can't re-enable */
    if (typeof s.reflections === 'boolean') gfx.reflections = s.reflections;
    if (typeof s.reflectHigh === 'boolean') gfx.reflectHigh = s.reflectHigh;
    if (Number.isFinite(s.reflStrength)) gfx.reflStrength = Math.min(1, Math.max(0, s.reflStrength));
    if (s.shadowSize === 1024 || s.shadowSize === 2048) gfx.shadowSize = s.shadowSize;
  } catch (err) { console.error('gfx prefs load', err); }
}
function saveGfxPrefs() {
  try { localStorage.setItem(GFX_LS_KEY, JSON.stringify(gfx)); }
  catch (err) { console.error('gfx prefs save', err); }
}

/* Force every material in the scene to genuinely REBUILD its shader.
   Marking needsUpdate alone is not enough: three caches compiled programs by a
   key that does NOT include ShaderChunk *content*, so after we rewrite the
   tone-map chunk (saturation) three happily reuses the program it built at the
   first saturation value — the swap is ignored and the grade never reaches the
   cars, the track surface or anything else already compiled. Handing each
   material a changing customProgramCacheKey busts that cache, so on the next
   render every scene material re-assembles its fragment shader from the CURRENT
   chunk. That is what makes exposure/contrast/saturation affect everything on
   screen, not just materials created after the last change. */
let _gradeGen = 0;
const _gradeCacheKey = () => 'grade' + _gradeGen;
function recompileSceneMaterials() {
  _gradeGen++;
  scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      m.customProgramCacheKey = _gradeCacheKey;   /* changing key → real rebuild */
      m.needsUpdate = true;
    }
  });
}


function getPanelSectionsCollapsedPref() {
  try {
    const raw = localStorage.getItem('re2003.bakedFactory.v1');
    if (raw) {
      const bf = JSON.parse(raw);
      if (bf && bf.ui && typeof bf.ui.panelSectionsCollapsed === 'boolean') return bf.ui.panelSectionsCollapsed;
    }
  } catch (e) { console.error('panel sections pref', e); }
  return BAKED?.ui?.panelSectionsCollapsed !== false;
}

function applyPanelSectionsPref() {
  if (!getPanelSectionsCollapsedPref()) return;
  const root = document.getElementById('panel-sections');
  if (!root) return;
  root.querySelectorAll('details[open]').forEach((d) => d.removeAttribute('open'));
}

function seedBakedDefaultsToStorage() {
  if (!BAKED) return;
  try {
    if (!localStorage.getItem('re2003.bakedFactory.v1')) {
      const o = {
        _ver: BAKED.ver || 1,
        _savedAt: BAKED.savedAt || '',
        gfx: { ...gfx },
        steerSens: BAKED.steerSens,
        playerPeakHp: BAKED.playerPeakHp,
        aiPeakHp: BAKED.aiPeakHp,
        noDamage: BAKED.noDamage,
        aiTune: BAKED.aiTune ? { ...BAKED.aiTune } : null,
        rideNCS22: BAKED.rideNCS22,
        aiParams: BAKED.aiParams ? { ...BAKED.aiParams } : {},
        driveControls: BAKED.driveControls || null,
        ui: BAKED.ui ? { ...BAKED.ui } : { panelSectionsCollapsed: true },
      };
      localStorage.setItem('re2003.bakedFactory.v1', JSON.stringify(o));
    }
    if (!localStorage.getItem(GFX_LS_KEY) && BAKED.gfx) localStorage.setItem(GFX_LS_KEY, JSON.stringify(BAKED.gfx));
    if (!localStorage.getItem('re2003.aiParams2') && BAKED.aiParams) {
      localStorage.setItem('re2003.aiParams2', JSON.stringify({ _ver: 4, ...BAKED.aiParams }));
    }
    if (!localStorage.getItem('re2003.aiTune') && BAKED.aiTune) localStorage.setItem('re2003.aiTune', JSON.stringify(BAKED.aiTune));
    if (!localStorage.getItem('re2003.steerSens') && Number.isFinite(BAKED.steerSens)) localStorage.setItem('re2003.steerSens', String(BAKED.steerSens));
    if (!localStorage.getItem('re2003.playerPeakHp') && Number.isFinite(BAKED.playerPeakHp)) localStorage.setItem('re2003.playerPeakHp', String(BAKED.playerPeakHp));
    if (!localStorage.getItem('re2003.aiPeakHp') && Number.isFinite(BAKED.aiPeakHp)) localStorage.setItem('re2003.aiPeakHp', String(BAKED.aiPeakHp));
    if (!localStorage.getItem('re2003.noDamage') && typeof BAKED.noDamage === 'boolean') localStorage.setItem('re2003.noDamage', BAKED.noDamage ? '1' : '0');
  } catch (e) { console.error('seed baked defaults', e); }
}


function formatBakedJsFile(baked) {
  const savedAt = baked.savedAt || baked._savedAt || '';
  const body = JSON.stringify(baked, null, 2);
  return (
    `/* Cameron factory slider defaults — baked ${savedAt} from the live RE2003 session.\n` +
    '   Fresh loads (no localStorage) and every Reset-to-defaults path reads this file. */\n' +
    `const RE2003_BAKED_DEFAULTS = ${body};\n`
  );
}

async function exportBakedDefaultsFile(baked) {
  const text = formatBakedJsFile(baked);
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: 'baked-defaults.js',
        types: [{ description: 'JavaScript', accept: { 'application/javascript': ['.js'] } }],
      });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      return 'saved';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  const blob = new Blob([text], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'baked-defaults.js';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return 'downloaded';
}

function bakedPayloadFromSnap(snap) {
  return {
    ver: snap._ver,
    savedAt: snap._savedAt,
    gfx: snap.gfx,
    steerSens: snap.steerSens,
    playerPeakHp: snap.playerPeakHp,
    aiPeakHp: snap.aiPeakHp,
    noDamage: snap.noDamage,
    aiTune: snap.aiTune,
    rideNCS22: snap.rideNCS22,
    aiParams: snap.aiParams,
    driveControls: snap.driveControls,
    ui: snap.ui,
  };
}

async function captureCurrentDefaults() {
  const num = (id, fb) => { const el = $(id); const v = el ? parseFloat(el.value) : NaN; return Number.isFinite(v) ? v : fb; };
  const snap = {
    _ver: (BAKED && BAKED.ver) || 1,
    _savedAt: new Date().toISOString().slice(0, 10),
    gfx: { ...gfx },
    steerSens: (typeof Driving !== 'undefined' && Driving.getSteerSensitivity)
      ? Driving.getSteerSensitivity() : num('vp-steer-sens', 0.6),
    playerPeakHp: (typeof Driving !== 'undefined' && Driving.getPlayerPeakHp)
      ? Driving.getPlayerPeakHp() : num('vp-player-hp', 750),
    aiPeakHp: (typeof Driving !== 'undefined' && Driving.getAiPeakHp)
      ? Driving.getAiPeakHp() : num('vp-ai-hp', 750),
    noDamage: (typeof Physics !== 'undefined' && Physics.getNoDamage)
      ? Physics.getNoDamage() : !!($('vp-no-damage') && $('vp-no-damage').checked),
    aiTune: (typeof Driving !== 'undefined' && Driving.aiTune)
      ? { ...Driving.aiTune } : { speed: num('vp-ai-speed', 1), aggro: num('vp-ai-aggro', 0.5), laneFreq: num('vp-ai-lane', 0) },
    rideNCS22: num('vp-ride', 0.025),
    aiParams: {},
    driveControls: (typeof DriveControls !== 'undefined' && DriveControls.get) ? DriveControls.get() : null,
    ui: {
      panelSectionsCollapsed: !document.querySelector('#panel-sections details[open]'),
    },
  };
  if (typeof Driving !== 'undefined' && Driving.getAiParams) {
    for (const prm of Driving.getAiParams()) snap.aiParams[prm.key] = prm.value;
  }
  try {
    localStorage.setItem('re2003.bakedFactory.v1', JSON.stringify(snap));
    localStorage.setItem(GFX_LS_KEY, JSON.stringify(snap.gfx));
    localStorage.setItem('re2003.aiParams2', JSON.stringify({ _ver: 4, ...snap.aiParams }));
    localStorage.setItem('re2003.aiTune', JSON.stringify(snap.aiTune));
    localStorage.setItem('re2003.steerSens', String(snap.steerSens));
    localStorage.setItem('re2003.playerPeakHp', String(snap.playerPeakHp));
    localStorage.setItem('re2003.aiPeakHp', String(snap.aiPeakHp));
    localStorage.setItem('re2003.noDamage', snap.noDamage ? '1' : '0');
    if (snap.driveControls && typeof DriveControls !== 'undefined' && DriveControls.save) DriveControls.save(snap.driveControls);
  } catch (e) {
    console.error('save defaults (localStorage)', e);
    log('ERROR: could not save defaults to localStorage — ' + e.message);
    return snap;
  }
  const baked = bakedPayloadFromSnap(snap);
  if (typeof RE2003_BAKED_DEFAULTS !== 'undefined') Object.assign(RE2003_BAKED_DEFAULTS, baked);
  try {
    const how = await exportBakedDefaultsFile(baked);
    if (how === 'cancelled') log('Defaults saved to localStorage. File export cancelled.');
    else if (how === 'saved') log('Defaults saved — replace js/baked-defaults.js in the repo with the file you picked.');
    else log('Defaults saved — baked-defaults.js downloaded; drop it into js/ in the repo.');
  } catch (e) {
    console.error('save defaults (file)', e);
    log('Defaults saved to localStorage. Could not export baked-defaults.js — ' + e.message);
  }
  return snap;
}


function bindCollisionUI() {
  if (typeof Driving === 'undefined' || !Driving.getCollisionTune) return;
  const tune = Driving.getCollisionTune();
  const wire = (id, valId, key, fmt, patch) => {
    const inp = $(id), val = $(valId);
    if (!inp) return;
    const v0 = tune[key];
    if (Number.isFinite(v0)) inp.value = v0;
    const show = () => { if (val) val.textContent = fmt(parseFloat(inp.value)); };
    show();
    inp.addEventListener('input', () => {
      Driving.setCollisionTune({ [patch || key]: parseFloat(inp.value) });
      show();
    });
  };
  wire('vp-wreck-lift', 'vp-wreck-lift-val', 'wreckLift', v => v.toFixed(2));
  wire('vp-wreck-gate', 'vp-wreck-gate-val', 'wreckGate', v => v.toFixed(1) + ' m/s');
  wire('vp-hit-impulse', 'vp-hit-impulse-val', 'hitImpulse', v => v.toFixed(2) + '×');
  wire('vp-car-bounce', 'vp-car-bounce-val', 'restitution', v => v.toFixed(2));
}

function bindGraphicsUI() {
  const exp = $('vp-exposure'), expV = $('vp-exposure-val');
  const con = $('vp-contrast'), conV = $('vp-contrast-val');
  const sat = $('vp-saturation'), satV = $('vp-saturation-val');
  const mass = $('vp-mass'), massV = $('vp-mass-val');
  const sh = $('vp-shadows'), shq = $('vp-shadow-q');
  const lift = $('vp-lift'), liftV = $('vp-lift-val');
  const showExp = () => { if (expV) expV.textContent = gfx.exposure.toFixed(2) + '×'; };
  const showSat = () => { if (satV) satV.textContent = Math.round(gfx.saturation * 100) + '%'; };
  const showLift = () => { if (liftV) liftV.textContent = Math.round(gfx.lift * 100) + '%'; };
  const showCon = () => { if (conV) conV.textContent = gfx.contrast.toFixed(2) + '×'; };
  const showMass = () => { if (massV) massV.textContent = gfx.mass.toFixed(2) + '× (' + Math.round(gfx.mass * 3500) + ' lb)'; };   /* 1587.6 kg == 3500 lb by design */
  if (exp) {
    exp.value = gfx.exposure; showExp();
    exp.addEventListener('input', () => {
      gfx.exposure = parseFloat(exp.value) || EXPOSURE_DEFAULT;
      renderer.toneMappingExposure = gfx.exposure; showExp(); saveGfxPrefs();
    });
  }
  if (con) {
    con.value = gfx.contrast; showCon();
    con.addEventListener('input', () => {
      gfx.contrast = parseFloat(con.value) || CONTRAST_DEFAULT;
      applyGfxContrast(); showCon(); saveGfxPrefs();
    });
  }
  if (sat) {
    sat.value = gfx.saturation; showSat();
    /* live label on drag, but recompile the tone-map shader only on RELEASE */
    sat.addEventListener('input', () => { gfx.saturation = parseFloat(sat.value) || SATURATION_DEFAULT; showSat(); });
    sat.addEventListener('change', () => { applySaturation(); saveGfxPrefs(); });
  }
  if (lift) {
    lift.value = gfx.lift; showLift();
    /* black level: live label on drag, recompile the tone-map shader on RELEASE (same as saturation) */
    lift.addEventListener('input', () => { gfx.lift = parseFloat(lift.value) || LIFT_DEFAULT; showLift(); });
    lift.addEventListener('change', () => { applySaturation(); saveGfxPrefs(); });
  }
  if (mass) {
    mass.value = gfx.mass; showMass();
    /* live: every car (player + AI) gets lighter/heavier as you drag */
    mass.addEventListener('input', () => {
      gfx.mass = parseFloat(mass.value) || MASS_DEFAULT;
      if (typeof Driving !== 'undefined' && Driving.setMassScale) Driving.setMassScale(gfx.mass);
      showMass(); saveGfxPrefs();
    });
  }
  const pHp = $('vp-player-hp'), pHpV = $('vp-player-hp-val');
  if (pHp && typeof Driving !== 'undefined' && Driving.setPlayerPeakHp) {
    pHp.value = Driving.getPlayerPeakHp ? Driving.getPlayerPeakHp() : 750;
    const showPHp = () => { if (pHpV) pHpV.textContent = `${Math.round(parseFloat(pHp.value) || 750)} HP`; };
    showPHp();
    pHp.addEventListener('input', () => { Driving.setPlayerPeakHp(parseFloat(pHp.value)); showPHp(); });
  }
  const aHp = $('vp-ai-hp'), aHpV = $('vp-ai-hp-val');
  if (aHp && typeof Driving !== 'undefined' && Driving.setAiPeakHp) {
    aHp.value = Driving.getAiPeakHp ? Driving.getAiPeakHp() : 750;
    const showAHp = () => { if (aHpV) aHpV.textContent = `${Math.round(parseFloat(aHp.value) || 750)} HP`; };
    showAHp();
    aHp.addEventListener('input', () => { Driving.setAiPeakHp(parseFloat(aHp.value)); showAHp(); });
  }
  const ss = $('vp-steer-sens'), ssV = $('vp-steer-sens-val');
  if (ss && typeof Driving !== 'undefined' && Driving.setSteerSensitivity) {
    ss.value = Driving.getSteerSensitivity ? Driving.getSteerSensitivity() : 0.8;
    const showSs = () => { if (ssV) ssV.textContent = Math.round(parseFloat(ss.value) * 100) + '%'; };
    showSs();
    ss.addEventListener('input', () => { Driving.setSteerSensitivity(parseFloat(ss.value)); showSs(); });
  }
  /* "Disable damage" — global collision-damage kill (via Physics), persisted */
  const saveDef = $('vp-save-defaults');
  if (saveDef) saveDef.addEventListener('click', () => captureCurrentDefaults());
  const nd = $('vp-no-damage');
  if (nd && typeof Physics !== 'undefined' && Physics.setNoDamage) {
    let ndSaved = false;
    try { const _nd = localStorage.getItem('re2003.noDamage'); ndSaved = _nd === null ? !!(BAKED && BAKED.noDamage) : _nd === '1'; } catch (e) {}
    nd.checked = ndSaved;
    Physics.setNoDamage(ndSaved);
    nd.addEventListener('change', () => {
      Physics.setNoDamage(nd.checked);
      try { localStorage.setItem('re2003.noDamage', nd.checked ? '1' : '0'); } catch (e) {}
    });
  }
  if (sh) {
    sh.checked = gfx.shadows;
    sh.addEventListener('change', () => {
      gfx.shadows = sh.checked;
      renderer.shadowMap.enabled = gfx.shadows;
      recompileSceneMaterials();   /* shadow shader define flipped */
      saveGfxPrefs();
    });
  }
  if (shq) {
    shq.value = String(gfx.shadowSize);
    shq.addEventListener('change', () => {
      gfx.shadowSize = parseInt(shq.value, 10) === 1024 ? 1024 : 2048;
      sunLight.shadow.mapSize.set(gfx.shadowSize, gfx.shadowSize);
      if (sunLight.shadow.map) { sunLight.shadow.map.dispose(); sunLight.shadow.map = null; }   /* re-alloc */
      saveGfxPrefs();
    });
  }
  const rfl = $('vp-reflections');
  if (rfl) {
    rfl.checked = gfx.reflections;
    rfl.addEventListener('change', () => { setCarReflections(rfl.checked); });
  }
  const rq = $('vp-reflect-q');
  if (rq) {
    rq.value = gfx.reflectHigh ? 'high' : 'low';
    rq.addEventListener('change', () => { setReflectQuality(rq.value === 'high'); });
  }
  /* Reflection strength: live re-wear of the env on every car material — the
     probe keeps running untouched, only the Mix amount changes */
  const rs = $('vp-refl-strength'), rsV = $('vp-refl-strength-val');
  if (rs) {
    const showRs = () => { if (rsV) rsV.textContent = Math.round(gfx.reflStrength * 100) + '%'; };
    rs.value = gfx.reflStrength; showRs();
    rs.addEventListener('input', () => {
      gfx.reflStrength = Math.min(1, Math.max(0, parseFloat(rs.value) || 0));
      showRs();
      applyCarEnvMap(modelGroup);
      applyCarEnvMap(carFieldGroup);
      saveGfxPrefs();
    });
  }
  const air = $('vp-ai-race');
  if (air && typeof Driving !== 'undefined') {
    air.checked = Driving.aiRace;
    air.addEventListener('change', () => Driving.setAiRace(air.checked));
  }
  const lanes = $('vp-ai-lanes');
  if (lanes && typeof Driving !== 'undefined') {
    lanes.checked = Driving.aiLanes;
    lanes.addEventListener('change', () => Driving.setAiLanes(lanes.checked));
  }
  const tandem = $('vp-ai-tandem');
  if (tandem && typeof Driving !== 'undefined') {
    tandem.checked = Driving.aiTandem;
    tandem.addEventListener('change', () => Driving.setAiTandem(tandem.checked));
  }
  bindAiTuneSliders();
  bindCollisionUI();
  bindAiParamSliders();
  bindAiLaneEditors();
}

/* Editable AI racing lanes — one slider (± dlat metres) per lane with a remove
   button, plus an Add button. Live: dragging moves that groove around the whole
   track and rebuilds the overlay if it's showing. */
function bindAiLaneEditors() {
  if (typeof Driving === 'undefined' || !Driving.getAiLaneOffsets) return;
  const host = $('vp-ai-lane-list');
  if (!host) return;
  const offs = Driving.getAiLaneOffsets();
  let html = '';
  for (let i = 0; i < offs.length; i++) {
    html += `<label class="vp-slider">Lane ${i + 1} <span id="vpl-val-${i}"></span>`
      + `<span style="display:flex;gap:6px;align-items:center">`
      + `<input type="range" id="vpl-${i}" min="-20" max="20" step="0.1" value="${offs[i]}" style="flex:1">`
      + `<button type="button" id="vpl-del-${i}" title="Remove this lane" style="flex:0 0 auto;width:22px;height:22px;line-height:1;padding:0;cursor:pointer">&#10005;</button>`
      + `</span></label>`;
  }
  host.innerHTML = html;
  for (let i = 0; i < offs.length; i++) {
    const inp = $('vpl-' + i), val = $('vpl-val-' + i), del = $('vpl-del-' + i);
    if (val) val.textContent = parseFloat(offs[i]).toFixed(1) + ' m';
    if (inp) inp.addEventListener('input', () => {
      Driving.setAiLaneOffset(i, parseFloat(inp.value));
      if (val) val.textContent = parseFloat(inp.value).toFixed(1) + ' m';
    });
    if (del) del.addEventListener('click', () => { Driving.removeAiLane(i); bindAiLaneEditors(); });
  }
  const add = $('vp-ai-lane-add');
  if (add && !add.dataset.bound) {
    add.dataset.bound = '1';
    add.addEventListener('click', () => { Driving.addAiLane(); bindAiLaneEditors(); });
  }
}

/* AI speed / aggression / lane-change sliders — live, no re-arm */
function bindAiTuneSliders() {
  if (typeof Driving === 'undefined') return;
  const tune = Driving.aiTune;
  const wire = (id, key, fmt) => {
    const inp = $(id), val = $(id + '-val');
    if (!inp) return;
    inp.value = tune[key];
    const show = () => { if (val) val.textContent = fmt(parseFloat(inp.value)); };
    show();
    inp.addEventListener('input', () => { Driving.setAiTune({ [key]: parseFloat(inp.value) }); show(); });
  };
  const pct = (v) => Math.round(v * 100) + '%';
  wire('vp-ai-speed', 'speed', (v) => v.toFixed(2) + '×');
  wire('vp-ai-aggro', 'aggro', pct);
  wire('vp-ai-lane', 'laneFreq', pct);
  const mom = $('vp-ai-momentum'), momV = $('vp-ai-momentum-val');
  if (mom && Driving.getAiParams && Driving.setAiParam) {
    const gs = Driving.getAiParams().find(p => p.key === 'grooveSmooth');
    if (gs) mom.value = gs.value;
    const showMom = () => { if (momV) momV.textContent = parseFloat(mom.value).toFixed(2) + ' s'; };
    showMom();
    mom.addEventListener('input', () => { Driving.setAiParam('grooveSmooth', parseFloat(mom.value)); showMom(); });
  }
  const yel = $('vp-ai-yellow'), yelV = $('vp-ai-yellow-val');
  if (yel && Driving.getAiParams && Driving.setAiParam) {
    const im = Driving.getAiParams().find(p => p.key === 'insideMargin');
    if (im) yel.value = im.value;
    const showYel = () => { if (yelV) yelV.textContent = parseFloat(yel.value).toFixed(2) + ' m'; };
    showYel();
    yel.addEventListener('input', () => { Driving.setAiParam('insideMargin', parseFloat(yel.value)); showYel(); });
  }
}

/* Advanced AI sliders — one per tunable param, built dynamically from the Driving
   registry so the markup stays tiny. Live: dragging retunes the whole field mid-
   race (most params instantly; aggression/skill on the next field arm). */
function bindAiParamSliders() {
  if (typeof Driving === 'undefined' || !Driving.getAiParams) return;
  const host = $('vp-ai-params');
  if (!host) return;
  const params = Driving.getAiParams();
  const dec = (step) => (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
  if (!host.dataset.built) {
    let html = '', group = null;
    for (const p of params) {
      if (p.g !== group) { group = p.g; html += `<div class="vp-ctrl-divider">${group}</div>`; }
      html += `<label class="vp-slider">${p.label} <span id="vpp-${p.key}-val"></span>`
        + `<input type="range" id="vpp-${p.key}" min="${p.min}" max="${p.max}" step="${p.step}"></label>`;
    }
    host.innerHTML = html;
    host.dataset.built = '1';
    for (const p of params) {
      const inp = $('vpp-' + p.key);
      if (!inp) continue;
      inp.addEventListener('input', () => {
        Driving.setAiParam(p.key, parseFloat(inp.value));
        const val = $('vpp-' + p.key + '-val');
        if (val) val.textContent = parseFloat(inp.value).toFixed(dec(p.step));
      });
    }
    const reset = $('vp-ai-params-reset');
    if (reset) reset.addEventListener('click', () => { Driving.resetAiParams(); bindAiParamSliders(); });
  }
  /* (re)sync every slider to the current value — initial fill + after a reset */
  for (const p of params) {
    const inp = $('vpp-' + p.key), val = $('vpp-' + p.key + '-val');
    if (inp) inp.value = p.value;
    if (val) val.textContent = (+p.value).toFixed(dec(p.step));
  }
}

function log(msg) {
  const el = $('vp-log');
  el.textContent += msg + '\n';
  el.scrollTop = el.scrollHeight;
}

/* Render-loop resilience: three.js only schedules the NEXT frame after the
   setAnimationLoop callback RETURNS, so a single uncaught throw inside it
   permanently freezes the game (this is exactly how the old btnValue ReferenceError
   bricked it, and how a controller quirk / bad frame does). We catch per-frame,
   keep rendering, and LOG the real error (not swallow it) so the cause — e.g. the
   exact button that crashed — is diagnosable. Rate-limited to avoid console spam. */
let _loopErrN = 0;
function loopError(where, err) {
  _loopErrN++;
  if (_loopErrN <= 3 || _loopErrN % 300 === 0) {
    console.error(`[RE2003] ${where} error (frame kept alive, #${_loopErrN}):`, err);
    if (_loopErrN === 1) {
      try { log('Caught a frame error (details in the browser console) — the view stays live; respawn or reload if driving stalls.'); } catch (e) {}
    }
  }
}

/* ---------- three.js scene ---------- */
function initScene() {
  applyPanelSectionsPref();
  const host = $('viewer-canvas-host');
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio * KIOSK_RES);
  renderer.outputEncoding = THREE.sRGBEncoding;
  host.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  updateSceneBackground();

  camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
  camera.position.set(...DEFAULT_SHOWROOM_CAM);   /* start on the Camera 1 pose, not a raw 5,2.5,5 */

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  configureShowroomControls();
  controls.listenToKeyEvents(renderer.domElement);
  renderer.domElement.tabIndex = 0;
  /* orbit-only by default: the pivot stays locked on the car so "Free Camera"
     orbits around it rather than flying off. Tracks re-enable pan (see
     frameTrackCar) since they're too big to view from a fixed pivot. */
  /* any user input (drag/zoom) means we've left the preset view — drop the
     dropdown onto its "Free Camera" entry so the picker reflects reality. */
  controls.addEventListener('start', () => {
    const camSel = $('vp-camera');
    if (!camSel) return;
    if ([...camSel.options].some(o => o.value === 'free')) camSel.value = 'free';
    else camSel.selectedIndex = -1;
  });

  /* Daytime sun + sky ambient for lit track scenery (see constants above).
     Only Lambert scenery meshes respond; MeshBasic cars/surface ignore them. */
  skyLight = new THREE.HemisphereLight(SKY_LIGHT, GROUND_LIGHT, HEMI_INTENSITY);
  scene.add(skyLight);
  sunLight = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  sunLight.position.set(...SUN_DIR);   /* directional: position sets direction, target at origin */
  scene.add(sunLight);
  removeLegacySunMeshes();

  const grid = new THREE.GridHelper(30, 30, 0x4a4a4a, 0x424242);
  grid.name = 'grid';
  scene.add(grid);

  initGraphics();   /* HDR tone mapping + exposure/contrast */

  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight;
    if (w < 2 || h < 2) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    syncRendererViewport();
  };
  new ResizeObserver(resize).observe(host);
  resize();


  renderer.setAnimationLoop((tms) => {
    const now = tms || 0;
    const dt = lastFrameMs ? (now - lastFrameMs) / 1000 : 0;
    lastFrameMs = now;
    /* per-frame logic — guarded so one throw (a controller quirk, a bad sim
       frame) can't kill the loop and freeze the game for good */
    try {
      const _pu = PERF.on ? performance.now() : 0;
      if (Driving.active) Driving.update(dt);   /* player physics + car-mounted cam */
      else if (Driving.carFollow) Driving.tickCarCamera(dt, null);
      else if (Driving.tickTrackCamera(dt)) { /* TV camera aimed at the focused car */ }
      else controls.update();
      if (PERF.on) PERF.update += performance.now() - _pu;
      if (typeof WindTunnel !== 'undefined' && WindTunnel.active) WindTunnel.tick(dt);
      /* drive-time flow smoke: self-gating (runs only while driving with the
         Controls-panel toggle on, tears itself down otherwise) */
      if (typeof WindTunnel !== 'undefined') WindTunnel.tickDriveSmoke(dt);
      /* tire smoke ages from the MAIN loop so puffs keep drifting after the
         drive session ends; pxPerM converts world puff size → point pixels */
      if (typeof TireFX !== 'undefined' && TireFX.group) {
        const wPx = renderer.domElement.clientWidth || 800;
        const hPx = renderer.domElement.clientHeight || 600;
        /* camera + screen dims let the perf probe compute smoke overdraw */
        TireFX.tick(dt, hPx / (2 * Math.tan((camera.fov * Math.PI / 180) / 2)),
          camera, wPx, hPx);
      }
    } catch (err) { loopError('update', err); }
    /* render ALWAYS runs (in its own guard) so the view stays live even if the
       update above threw — the loop survives and the user can recover */
    try {
      const wtRoom = (typeof WindTunnel !== 'undefined' && WindTunnel.active) ? WindTunnel.scene : null;
      if (!wtRoom) updateShadowFrustum();   /* shadow box follows the view */
      /* live car reflections: High renders ONE sharp 256² face EVERY frame
         (round-robin — the cube stays live at frame rate). It must NOT render
         all six faces per frame: that re-drew the whole track 6× every frame
         (~6× the scene's draw calls) and was THE hidden FPS collapse — and the
         High pref persists in localStorage, so it followed every build after
         f192 while pre-f194 builds ignored it (why SOLID17 stayed smooth and
         reverting never cured it). Low amortises one 128² face every few
         frames. Off when the toggle is disabled.
         f203: no longer track-gated — the probe follows the ACTIVE scene, so
         the showroom (grid + backdrop) and the wind-tunnel room reflect on the
         car too, not just a loaded track. */
      const _pp = PERF.on ? performance.now() : 0;
      const liveProbeScene = wtRoom || (trackGroup ? scene : null);
      const wantLiveProbe = Driving.active
        || (typeof WindTunnel !== 'undefined' && WindTunnel.active);
      if (gfx.reflections && carEnvCam && modelGroup && liveProbeScene && wantLiveProbe) {
        if (gfx.reflectHigh) {
          renderCarEnvProbe(liveProbeScene);
        } else if (++_envFrame >= CAR_ENV_FACE_EVERY) {
          _envFrame = 0; renderCarEnvProbe(liveProbeScene);
        }
      }
      if (PERF.on) PERF.probe += performance.now() - _pp;
      const _pr = PERF.on ? performance.now() : 0;
      syncRendererViewport();
      renderer.render(wtRoom || scene, camera);
      if (PERF.on) {
        PERF.render += performance.now() - _pr;
        PERF.draws = renderer.info.render.calls;       /* this frame's draw calls */
        PERF.tris = renderer.info.render.triangles;    /* …and triangles submitted */
        PERF.geo = renderer.info.memory.geometries;    /* live GPU resource counts — */
        PERF.tex = renderer.info.memory.textures;      /* if these climb every second, */
        PERF.prog = renderer.info.programs ? renderer.info.programs.length : 0;  /* it's a leak */
        PERF.n++;
        if (!PERF.t0) PERF.t0 = now;
        if (now - PERF.t0 >= 1000) perfReport(now);
      }
      updateCamReadout();
      updateFpsReadout(now);
    } catch (err) { loopError('render', err); }
  });
}

/* live camera position in the top-left HUD, next to the parts/tris line */
function ensureCarCamOptionsSaved() {
  const sel = $('vp-camera');
  if (sel && carCamOptionsHtml === null) carCamOptionsHtml = sel.innerHTML;
}

function configureShowroomControls() {
  controls.enablePan = false;
  controls.rotateSpeed = SHOWROOM_CTRL.rotateSpeed;
  controls.zoomSpeed = SHOWROOM_CTRL.zoomSpeed;
  controls.panSpeed = SHOWROOM_CTRL.panSpeed;
  controls.keyPanSpeed = SHOWROOM_CTRL.keyPanSpeed;
  controls.dampingFactor = SHOWROOM_CTRL.dampingFactor;
  controls.minDistance = SHOWROOM_CTRL.minDistance;
  controls.maxDistance = SHOWROOM_CTRL.maxDistance;
  controls.screenSpacePanning = true;
}


function configureTrackControls(span) {
  trackControlSpan = Math.max(span, 8);
  const s = trackControlSpan;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.rotateSpeed = Math.min(2.2, 0.85 + s / 350);
  controls.zoomSpeed = Math.min(3.2, 1.4 + s / 280);
  controls.panSpeed = Math.min(3.5, 1.2 + s / 220);
  controls.keyPanSpeed = Math.min(36, 10 + s / 45);
  controls.dampingFactor = 0.06;
  controls.minDistance = 1.5;
  controls.maxDistance = Math.max(8000, s * 8);
}

/* rolling FPS beside the cam numbers — counted over 0.5 s windows so the value
   is readable, and the DOM is only touched when the rounded number changes */
const FPS_SAMPLE_MS = 500;
let _fpsFrames = 0, _fpsWindowStart = 0, _fpsShown = '';
function updateFpsReadout(now) {
  const el = $('viewer-fps');
  if (!el) return;
  _fpsFrames++;
  if (!_fpsWindowStart) { _fpsWindowStart = now; _fpsFrames = 0; return; }
  const span = now - _fpsWindowStart;
  if (span < FPS_SAMPLE_MS) return;
  const s = Math.round(_fpsFrames * 1000 / span) + ' fps';
  _fpsFrames = 0; _fpsWindowStart = now;
  if (s !== _fpsShown) { _fpsShown = s; el.textContent = s; }
}

function updateCamReadout() {
  const el = $('viewer-cam');
  if (!el || !camera) return;
  if (Driving.active) return;   /* driving mode writes its own speed/gear HUD */
  const p = camera.position;
  const s = `cam ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
  if (s !== el.textContent) el.textContent = s;   /* only touch the DOM on change */
}

const Driving = (() => {
  const KEY = { throttle: false, brake: false, steerLeft: false, steerRight: false, lockUp: false };
  const GRASS_GRIP = 0.35;         /* off-surface tire ROLLING grip multiplier —
                                      low, so the car slides around on grass */
  const GRASS_DIG = 1.4;           /* off-surface DIG multiplier (separate from
                                      rolling grip): grass/dirt grabs a sliding
                                      body panel / sideways tire harder than
                                      smooth asphalt, so a loose car TRIPS and
                                      rolls instead of gliding — stock-car behavior */
  const GRASS_ROLL_DRAG = 4.0;     /* off-surface rolling-resistance multiplier —
                                      grass plows and drags the car down */
  /* Chase = profile id 4 (mode 6). Nose = MACC record 0 (mode 10) — separate handlers. */

  let active = false;             /* physics + WASD armed (auto on track load) */
  let carFollow = null;           /* car-mounted view name; null = orbit/free */
  let followMount = null;         /* chase or MACC offsets for the active follow view */
  let followFov = 78;
  /* camera FOCUS: which car the views frame. null = the player's own car; a
     fieldCar = spectate an AI (V / Shift+V / Ctrl+V, or the driver dropdown).
     The player keeps DRIVING regardless — focus only moves the camera. */
  let focusCar = null;
  let focusProxy = null;          /* Object3D parked at the focused AI car for the cams */
  const CAR_FOLLOW_VIEWS = new Set([
    'chase', 'farChase', 'rearChase', 'hood',
    'gearbox', 'onCar', 'rollBar', 'fSusp', 'rSusp',
  ]);
  const DRIVE_ARM_VIEWS = new Set(['chase', 'farChase', 'rearChase', 'hood']);
  const MACC_FOLLOW_VIEWS = new Set(['hood', 'gearbox', 'onCar', 'rollBar', 'fSusp', 'rSusp']);
  let padBound = false;
  let padIdx = null;               /* locked gamepad slot after connect / canvas click */
  let padRespawnHeld = false;
  let padAxisRest = null;       /* resting trigger values after normTrigger */

  let car = null;                  /* Physics.Car */
  let fieldCars = [];              /* drivable/crashable pit-stall cars (see FIELD CARS) */
  let progress = { seg: 0, u: 0 }; /* incremental track-projection seed */
  let floorZ = 0;                  /* car tyre-contact offset (mod.floorZ) */
  let savedFov = null;
  let keyHandlersBound = false;
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  const camUp = new THREE.Vector3();
  const _camPivot = new THREE.Vector3();
  const _worldUp = new THREE.Vector3(0, 1, 0); /* three-world up: track z-up is
                                     rotated -90° into y-up (trackGroup.rotation.x) */
  const UPRIGHT_BLEND_Z = 0.4;    /* car-up.y below this eases the cam toward
                                     world-up so a flipping/banked car never
                                     rolls the chase view upside down */
  const CAM_PULL_REST = 0.935;    /* stationary framing (~6.5% closer than raw mount) */
  const CAM_PULL_DRIVE = 1.0;     /* slight pull-back at speed (raw mount distance) */
  const CAM_PULL_FULL_MPH = 80;   /* speed where the pull-back reaches full */
  let camPullSm = CAM_PULL_REST;  /* eased both ways — starts at rest, drifts out with speed */
  const _chasePivot = new THREE.Vector3();
  const _chasePivotPrev = new THREE.Vector3();
  const _pivotDelta = new THREE.Vector3();
  let camPivotInit = false;
  let camInit = false;
  let camSmoothInit = false;

  /* user orbit offset in drive / car-mounted cameras (mouse drag + pad axes) */
  let driveOrbitYaw = 0;
  let driveOrbitPitch = 0;
  let driveOrbitDist = 1;
  let driveOrbitDragging = false;
  let driveOrbitLastX = 0;
  let driveOrbitLastY = 0;
  let driveOrbitBound = false;
  const DRIVE_ORBIT_ROT = 0.0045;
  const DRIVE_ORBIT_PAD = 2.2;
  const _olv = new THREE.Vector3();
  const _ola = new THREE.Vector3();
  const _oe = new THREE.Euler();
  const _oq = new THREE.Quaternion();

  function resetDriveOrbit() {
    driveOrbitYaw = 0;
    driveOrbitPitch = 0;
    driveOrbitDist = 1;
    driveOrbitDragging = false;
  }

  function driveOrbitInvert() {
    return (typeof DriveControls !== 'undefined') && !!DriveControls.get().pad.orbitInvert;
  }

  function applyDriveOrbitLocal(pos, aim) {
    const inv = driveOrbitInvert() ? -1 : 1;
    _olv.copy(pos).multiplyScalar(driveOrbitDist);
    _ola.copy(aim);
    _oe.set(driveOrbitPitch * inv, 0, driveOrbitYaw * inv, 'ZXY');
    _oq.setFromEuler(_oe);
    _olv.applyQuaternion(_oq);
    _ola.applyQuaternion(_oq);
    pos.copy(_olv);
    aim.copy(_ola);
  }

  function updateDriveOrbitPad(dt) {
    if (!carFollow || !driveInputAllowed()) return;
    const pad = activePad();
    if (!pad) return;
    const pcfg = (typeof DriveControls !== 'undefined') ? DriveControls.get().pad : null;
    if (!pcfg) return;
    const dead = padDead();
    const inv = driveOrbitInvert() ? -1 : 1;
    const norm = (v) => {
      const a = Math.abs(v);
      if (a < dead) return 0;
      return (v - Math.sign(v) * dead) / (1 - dead);
    };
    /* never let a DRIVING axis double as an orbit axis (a non-standard pad
       mapping can alias them — then every steer/pedal input swings the
       camera, which reads as the whole car lurching) */
    const taken = [pcfg.steerAxis, pcfg.throttleAxis, pcfg.brakeAxis];
    const h = taken.includes(pcfg.orbitAxis) ? 0 : norm(pad.axes[pcfg.orbitAxis] || 0);
    const v = taken.includes(pcfg.orbitAxisV) ? 0 : norm(pad.axes[pcfg.orbitAxisV] || 0);
    if (!h && !v) return;
    driveOrbitYaw -= h * DRIVE_ORBIT_PAD * dt * inv;
    driveOrbitPitch += v * DRIVE_ORBIT_PAD * dt * inv;
    driveOrbitPitch = clamp(driveOrbitPitch, -1.15, 1.15);
  }

  function onDriveOrbitDown(e) {
    if (!carFollow || e.button !== 0 || e.target !== renderer.domElement) return;
    driveOrbitDragging = true;
    driveOrbitLastX = e.clientX;
    driveOrbitLastY = e.clientY;
    renderer.domElement.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onDriveOrbitMove(e) {
    if (!driveOrbitDragging || !carFollow) return;
    const inv = driveOrbitInvert() ? -1 : 1;
    const dx = e.clientX - driveOrbitLastX;
    const dy = e.clientY - driveOrbitLastY;
    driveOrbitLastX = e.clientX;
    driveOrbitLastY = e.clientY;
    driveOrbitYaw += dx * DRIVE_ORBIT_ROT * inv;
    driveOrbitPitch += dy * DRIVE_ORBIT_ROT * inv;
    driveOrbitPitch = clamp(driveOrbitPitch, -1.15, 1.15);
  }

  function onDriveOrbitUp(e) {
    if (e.button === 0) driveOrbitDragging = false;
    try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (err) { /* ok */ }
  }

  function onDriveOrbitWheel(e) {
    if (!carFollow) return;
    e.preventDefault();
    const z = e.deltaY > 0 ? 1.06 : 0.94;
    driveOrbitDist = clamp(driveOrbitDist * z, 0.5, 1.55);
  }

  function bindDriveOrbit() {
    if (driveOrbitBound) return;
    const el = renderer.domElement;
    el.addEventListener('pointerdown', onDriveOrbitDown);
    window.addEventListener('pointermove', onDriveOrbitMove);
    window.addEventListener('pointerup', onDriveOrbitUp);
    el.addEventListener('wheel', onDriveOrbitWheel, { passive: false });
    driveOrbitBound = true;
  }

  function unbindDriveOrbit() {
    if (!driveOrbitBound) return;
    const el = renderer.domElement;
    el.removeEventListener('pointerdown', onDriveOrbitDown);
    window.removeEventListener('pointermove', onDriveOrbitMove);
    window.removeEventListener('pointerup', onDriveOrbitUp);
    el.removeEventListener('wheel', onDriveOrbitWheel);
    driveOrbitBound = false;
    driveOrbitDragging = false;
  }

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function onKey(down) {
    return (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
                t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (typeof DriveControls !== 'undefined' && DriveControls.listeningPad && DriveControls.listeningPad()) {
        return;
      }
      if (!driveInputAllowed()) return;
      if (typeof DriveControls !== 'undefined' && DriveControls.cancelListen) DriveControls.cancelListen();
      const kid = (typeof DriveControls !== 'undefined') ? DriveControls.keyId(e) : e.key.toLowerCase();
      const k = (typeof DriveControls !== 'undefined') ? DriveControls.get().keys
        : { throttle: 'w', brake: 's', steerLeft: 'a', steerRight: 'd', respawn: 'r', lockUp: 'x' };
      let hit = true;
      if (kid === k.throttle || (kid === 'arrowup' && k.throttle === 'w')) KEY.throttle = down;
      else if (kid === k.brake || (kid === 'arrowdown' && k.brake === 's')) KEY.brake = down;
      else if (kid === k.steerLeft || (kid === 'arrowleft' && k.steerLeft === 'a')) KEY.steerLeft = down;
      else if (kid === k.steerRight || (kid === 'arrowright' && k.steerRight === 'd')) KEY.steerRight = down;
      else if (kid === k.respawn && down) respawn();
      else if (kid === k.lockUp) KEY.lockUp = down;
      else if (e.key === 'Escape' && down) leaveDriveCam(true);
      /* NR-style focus: V next driver, Shift+V previous, Ctrl+V back to your car.
         Your car keeps driving — this only moves the camera. */
      else if (down && (e.key === 'v' || e.key === 'V')) {
        if (e.ctrlKey || e.metaKey) focusPlayer();
        else if (e.shiftKey) cycleFocus(-1);
        else cycleFocus(1);
      }
      else hit = false;
      if (hit) e.preventDefault();
    };
  }
  const keyDown = onKey(true);
  const keyUp = onKey(false);

  function bindKeys() {
    if (keyHandlersBound) return;
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    keyHandlersBound = true;
  }
  function unbindKeys() {
    if (!keyHandlersBound) return;
    window.removeEventListener('keydown', keyDown);
    window.removeEventListener('keyup', keyUp);
    keyHandlersBound = false;
    KEY.throttle = KEY.brake = KEY.steerLeft = KEY.steerRight = KEY.lockUp = false;
  }

  /* start-pose from the start/finish line (falls back to current stall) */
  function spawnPose() {
    const sf = track && track.surface && startFinishPlacement(track.surface);
    if (sf) return sf;
    if (track && track.stall && track.stall.world) return track.stall.world;
    return { x: 0, y: 0, z: 0, heading: 0 };
  }

  function respawn() {
    if (!car) return;
    const pose = spawnPose();
    car.reset(pose);
    resetSimInterp();   /* fresh pose — don't interpolate across the teleport */
    progress = null;    /* start/finish is NOT segment 0 on every track —
                           force a global surface re-lock on the next sample */
    SpawnDiag.begin(pose);
    camInit = false;
    camSmoothInit = false;
    camPivotInit = false;
    camPullSm = CAM_PULL_REST;
  }

  /* --- quick save / restore of the live drive state (testing aid) ---
     Captures the full Physics.Car dynamic state + the track-projection seed,
     so "Load state" teleports the car back mid-corner at speed, wheels
     spinning, same gear/rpm — exactly where testing left off. Persisted to
     localStorage so it survives a page refresh (the edit-code-refresh loop). */
  let savedDrive = null;
  const DRIVE_STATE_LS_KEY = 're2003.driveState.v1';
  const CAR_STATE_FIELDS = ['x', 'y', 'yaw', 'u', 'v', 'r', 'ax', 'ay', 'steer',
    'throttle', 'brake', 'gear', 'rpm', 'shiftTimer', 'reverseReq',
    'zPos', 'vz', 'airborne', 'restingOnBody', 'damage',
    'attPitch', 'attRoll', 'attPitchV', 'attRollV',
    'qw', 'qx', 'qy', 'qz', 'wbx', 'wby', 'wbz'];
  /* flight quaternion fields — added with the 3D airborne rigid body;
     old saves default to identity (physics self-heals from the Euler view) */
  const CAR_STATE_QUAT_DEFAULTS = { qw: 1, qx: 0, qy: 0, qz: 0, wbx: 0, wby: 0, wbz: 0 };
  /* NOTE: keep in sync with the live Physics.Car fields — a listed field that
     no longer exists throws mid-capture and kills the Save button (slipLag
     died with the slip-lag filter removal and did exactly that) */
  const CAR_STATE_ARRAYS = ['wheelOmega', 'up', 'lastFz', 'lastSlip', 'suspComp', 'suspVel', 'suspFz', 'suspFzVel'];

  function persistDriveState() {
    try {
      localStorage.setItem(DRIVE_STATE_LS_KEY, JSON.stringify(savedDrive));
    } catch (err) { console.error('drive state persist', err); }
  }

  /* stored JSON is external data by the time it comes back — shape-check it */
  function restoreDriveState() {
    try {
      const raw = localStorage.getItem(DRIVE_STATE_LS_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || typeof s !== 'object' || !s.car || !s.progress) return null;
      for (const f of CAR_STATE_FIELDS) {
        /* boolean fields — Number.isFinite(false) is false, so without this
           the whole restore silently failed once airborne/restingOnBody were
           added to the field list ("load state does nothing" after refresh) */
        if (f === 'reverseReq' || f === 'airborne' || f === 'restingOnBody') {
          s.car[f] = !!s.car[f];
          continue;
        }
        if (f === 'damage') {   /* added later — default old saves to 0 */
          s.car[f] = Number.isFinite(s.car[f]) ? s.car[f] : 0;
          continue;
        }
        if (f in CAR_STATE_QUAT_DEFAULTS) {   /* added later — default old saves */
          s.car[f] = Number.isFinite(s.car[f]) ? s.car[f] : CAR_STATE_QUAT_DEFAULTS[f];
          continue;
        }
        if (!Number.isFinite(s.car[f])) return null;
      }
      for (const f of CAR_STATE_ARRAYS) {
        if (!Array.isArray(s.car[f]) || !s.car[f].every(Number.isFinite)) return null;
      }
      if (!Number.isFinite(s.progress.seg) || !Number.isFinite(s.progress.u)) return null;
      if (s.ctx && typeof s.ctx !== 'object') s.ctx = null;
      return s;
    } catch (err) {
      console.error('drive state restore', err);
      return null;
    }
  }

  function saveState() {
    if (!active || !car) {
      log('Save state: nothing to save - load a track and start driving first.');
      return;
    }
    const state = {};
    try {
      for (const f of CAR_STATE_FIELDS) state[f] = car[f];
      for (const f of CAR_STATE_ARRAYS) state[f] = [...car[f]];
    } catch (err) {
      /* never let a physics-field rename silently kill the button again */
      log('Save state failed: ' + err.message);
      console.error('save state capture', err);
      return;
    }
    savedDrive = {
      car: state,
      progress: progress ? { ...progress } : { seg: 0, u: 0 },
      track: track ? track.folderName : null,
      ctx: captureSettings(),
    };
    persistDriveState();
    const snap = car.snapshot();
    log(`State saved - ${Math.round(snap.speedMph)} mph, gear ${snap.gear === 0 ? 'R' : snap.gear}.`);
  }

  async function loadState() {
    if (!savedDrive) savedDrive = restoreDriveState();
    if (!savedDrive) {
      log('Load state: nothing saved yet - hit "Save state" while driving.');
      return;
    }
    /* fresh page: rebuild the whole saved session first — game folder (from
       the persisted handle), series, track, then paint/camera/display */
    if ((!active || !car) && savedDrive.ctx &&
        typeof Library !== 'undefined' && Library.restoreContext) {
      log('Load state: restoring saved session…');
      let ok = false;
      try { ok = await Library.restoreContext(savedDrive.ctx); }
      catch (err) { console.error('restore context', err); }
      if (!ok) {
        log('Load state: couldn\'t reopen the game folder automatically - open it once with "Open Game Folder", then click Load state again.');
        return;
      }
      applySavedSettings(savedDrive.ctx);
    }
    if (!active || !car) start();
    if (!active || !car) {
      log('Load state: open a car and a track (with a decoded surface) first.');
      return;
    }
    if (savedDrive.track && track && savedDrive.track !== track.folderName) {
      log(`Note: state was saved on "${savedDrive.track}" - this track is "${track.folderName}", expect a rough landing.`);
    }
    for (const f of CAR_STATE_FIELDS) car[f] = savedDrive.car[f];
    for (const f of CAR_STATE_ARRAYS) car[f] = [...savedDrive.car[f]];
    car._zSurfPrev = null;   /* re-sync the surface tracker (no false launch) */
    car._vzSurfSm = null;    /* …and the persistent follow-velocity filter */
    progress = null;         /* global surface re-lock at the restored pose —
                                a saved seg from another track (or a stale one)
                                mis-locks the incremental search */
    resetSimInterp();        /* genuine teleport — null the interp so the frame
                                blender doesn't smear across the jump (the larger
                                INTERP_TELEPORT_M no longer catches it by distance) */
    /* snap the follow camera straight to the restored pose — no whip-pan */
    camInit = false;
    camSmoothInit = false;
    camPivotInit = false;
    camPullSm = camPullTarget(car.snapshot());
    log('State loaded.');
  }

  /* --- visual wheel spin + steer on the hero model ---
     Wheel parts are separate meshes (userData.isRoadWheel, path lf/rf/lr/rrwheel)
     with transforms baked into the vertices, so spinning them means rotating
     about each wheel's own bbox centre: matrix = T(c)·Rz(steer)·Ry(spin)·T(−c)
     (model frame: +X nose, +Y axle, +Z up — +Y spin rolls the wheel forward).
     Geometry stays untouched (it's shared with the instanced car field). */
  const WHEEL_INDEX = { lf: 0, rf: 1, lr: 2, rr: 3 };
  let wheelVis = [];
  const spinAngle = [0, 0, 0, 0];
  function collectWheels() {
    releaseWheels();
    if (!modelGroup) return;
    for (const child of modelGroup.children) {
      if (!child.isMesh || !child.userData.isRoadWheel) continue;
      const slot = wheelSlotFromPath(child.name || '');
      if (!slot) continue;
      const idx = WHEEL_INDEX[slot];
      child.geometry.computeBoundingBox();
      const bb = child.geometry.boundingBox;
      const c = bb.getCenter(new THREE.Vector3());
      child.matrixAutoUpdate = false;
      wheelVis.push({ mesh: child, c, idx, front: idx < 2 });
    }
    spinAngle[0] = spinAngle[1] = spinAngle[2] = spinAngle[3] = 0;
  }
  function releaseWheels() {
    for (const w of wheelVis) {
      w.mesh.matrixAutoUpdate = true;
      w.mesh.updateMatrix();
    }
    wheelVis = [];
  }
  const _wR = new THREE.Matrix4(), _wT = new THREE.Matrix4(), _wE = new THREE.Euler();
  function updateWheels(snap, dt) {
    /* unsprung wheels stay PLANTED. snap.heave (the sprung-body lift) is added
       to the whole modelGroup's world z, so the wheels — children of the body —
       bobbed with the chassis and the contact patch sank/lifted a few cm off
       the surface on every squat and dive. Counter it in body-local z (= body
       up) so the tyres track the ground while the sprung body moves over them:
       body drops (heave<0) ⇒ wheel rises in the body frame by the same amount,
       netting a fixed world height. Off the wheels there is no suspension frame,
       so no counter. (Sub-degree suspension pitch/roll articulation is left on
       the body — its per-corner lift is mm-scale and unwinding it per wheel is
       a separate, riskier change.)
       The counter fades by contactFade to MATCH placeCar: the body applies
       cf·heave near takeoff/landing, so the wheels must counter cf·heave too,
       or they'd sink (1−cf)·heave through the ground during the handoff. */
    const cf = effectiveContactFade(snap);
    const heave = cf * (snap.heave || 0);
    for (const w of wheelVis) {
      const omega = snap.wheelOmega[w.idx] || 0;
      spinAngle[w.idx] = (spinAngle[w.idx] + omega * dt) % (2 * Math.PI);
      _wE.set(0, spinAngle[w.idx], w.front ? snap.steer : 0, 'ZYX');
      _wR.makeRotationFromEuler(_wE);
      w.mesh.matrix.makeTranslation(w.c.x, w.c.y, w.c.z - heave)
        .multiply(_wR)
        .multiply(_wT.makeTranslation(-w.c.x, -w.c.y, -w.c.z));
    }
  }

  /* ARM the player car: physics + WASD go live as soon as a car is parked on
     a decoded track surface — no menu needed. "Drive (chase cam)" in the
     camera dropdown is only the behind-car VIEW; every other camera still
     works while driving. Called from openTrackFolder/buildModel after
     placeCarAtStall. */
  function start() {
    if (typeof WindTunnel !== 'undefined' && WindTunnel.active) WindTunnel.exit();
    if (!modelGroup || !trackGroup || typeof Physics === 'undefined') return;
    if (!track || !track.surface || !track.surface.segments ||
        !track.surface.segments.length) return;      /* need the loft to drive on */
    floorZ = (mod && typeof mod.floorZ === 'number') ? mod.floorZ : 0;
    if (active) { collectWheels(); cacheDriveMounts(); refreshCarShape(); respawn(); armField(); return; }
    startFresh();
    refreshCarShape();
    armField();   /* every pit-stall car becomes a live, crashable Physics.Car */
  }

  /* hot mesh rebuild (paint/wing/make swap) — rebind wheel meshes + camera
     mounts on the fresh model but leave the car exactly where it is: no
     respawn, no camera re-frame. Physics state lives on `car`, untouched. */
  function refresh() {
    if (!active) { start(); return; }
    floorZ = (mod && typeof mod.floorZ === 'number') ? mod.floorZ : 0;
    collectWheels();
    cacheDriveMounts();
    refreshCarShape();
    if (typeof DriveControls !== 'undefined' && DriveControls.get().aero) {
      car.setAeroTune(DriveControls.get().aero);
    }
    applyFlapEnable();
    flapAnim = 0;
    armField();   /* field rebuilt on the hot-swap — rebind to the fresh meshes */
  }

  /* one-line "what the garage gave us" summary for the log */
  function setupSummary(c) {
    const bits = [];
    if (c.p.steeringRatio) bits.push(`steering ${c.p.steeringRatio.toFixed(0)}:1 (${(c.p.maxSteer * 180 / Math.PI).toFixed(1)}° lock)`);
    bits.push(`final drive ${c.p.finalDrive.toFixed(2)}`);
    bits.push(`brake bias ${(c.p.brakeBiasFront * 100).toFixed(0)}% front`);
    if (c.p.powerScale && Math.abs(c.p.powerScale - 1) > 0.005) {
      bits.push(`power ${(c.p.powerScale * 100).toFixed(0)}% (air ${c.p.airDensity.toFixed(2)})`);
    }
    return bits.join(', ');
  }

  /* re-apply the currently selected garage setup to the live car (Garage
     panel selection change) — physics params swap immutably, state stays */
  function applyGarageSetup() {
    if (!car || !track || !track.setup) return;
    car.applySetup(track.setup);
    car.applyTrackEnv(track.env);   /* re-assert track env (default-gear logic re-checks the new setup) */
    refreshEnginePower();
    log(`Setup "${track.setup.name || track.setup.fileName}" - ${setupSummary(car)}.`);
  }

  function startFresh() {
    /* fresh car per track so the garage setup applies — Bristol's 6.24 rear
       gear vs Daytona's 3.41 is most of the accel feel, and the per-track
       steering ratio (slot 47) is most of the turn-in feel */
    car = new Physics.Car();
    if (track && track.setup) {
      car.applySetup(track.setup);
      log(`Garage setup "${track.setup.name || 'fast'}" - ${setupSummary(car)}.`);
    }
    /* track environment AFTER the setup: sets air density / power and, when no
       setup carried a final drive, gears the car to this track's size */
    if (track && track.env) car.applyTrackEnv(track.env);
    /* Driving aids + the aero drag slider from the Controls panel (persisted) */
    if (typeof DriveControls !== 'undefined' && DriveControls.get().aids) {
      car.setAids(DriveControls.get().aids);
    }
    if (typeof DriveControls !== 'undefined' && DriveControls.get().aero) {
      car.setAeroTune(DriveControls.get().aero);
    }
    /* visual flap pieces + physics must match on drive entry — retoggle was
       the only path that called applyFlapEnable before this. */
    applyFlapEnable();
    flapAnim = 0;
    flapClock = 0;
    /* reapply peak-HP mult AFTER all setup/env/aids/aero param copies */
    refreshEnginePower();
    bindAidsToggles();
    collectWheels();
    cacheDriveMounts();
    respawn();
    bindKeys();
    bindGamepad();
    if (navigator.getGamepads) navigator.getGamepads();
    calibratePad();
    active = true;
    log('Driving live - W/A/S/D or controller (pedals swap when backing up), R / Y = respawn. ' +
        'Drag to orbit the drive camera; scroll to zoom. Pad axes 2/3 orbit (Controls panel). ' +
        'Pick Chase / Far Chase / Nose cam in the camera menu (Esc leaves drive view).');
  }

  let aidsBound = false;
  function bindAidsToggles() {
    if (aidsBound) return;
    document.addEventListener('re2003-aids-change', (e) => {
      if (!car || !e.detail) return;
      car.setAids(e.detail);
      const a = e.detail;
      const on = (v) => (v ? 'on' : 'off');
      log(`Driving aids - TC ${on(a.tractionControl)}, ABS ${on(a.absBrakes)}, ` +
          `stability ${on(a.stabilityControl)}, low-speed steer boost ${on(a.lowSpeedSteerBoost)}.`);
    });
    /* aero sliders — live to the car; drag = speed/air feel, blowover = onset trigger */
    document.addEventListener('re2003-aero-change', (e) => {
      applyFlapEnable();   /* flap piece set follows the Roof flaps toggle, showroom too */
      if (!car || !e.detail) return;
      car.setAeroTune(e.detail);
      const d = e.detail.dragScale, b = e.detail.blowoverScale;
      const fitted = e.detail.roofFlaps !== false;
      const effective = e.detail.flapsEffective !== false;
      log(`Aero - drag ${d.toFixed(2)}× (${d < 1 ? 'faster/slippery' : d > 1 ? 'slower/draggy' : 'stock'}), ` +
        `blowover ${b.toFixed(2)}× (${b > 1 ? 'flips sooner' : b < 1 ? 'needs more speed' : 'real ~150 mph'}), ` +
        `roof flaps ${fitted ? (effective ? 'on (deploy + prevent blowover)' : 'deploy but NOT effective - car still blows over') : 'OFF (not fitted)'}.`);
    });
    aidsBound = true;
  }

  function bindGamepad() {
    if (padBound) return;
    window.addEventListener('gamepadconnected', (e) => {
      padIdx = e.gamepad.index;
      calibratePad();
      const _padName = (e.gamepad.id || 'controller').replace(/\b(raiju|xbox|x-?box)\b/gi, 'controller');
      log(`Controller connected: ${_padName}.`);
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (padIdx === e.gamepad.index) padIdx = null;
      log('Controller disconnected.');
    });
    const wake = () => { if (navigator.getGamepads) navigator.getGamepads(); };
    renderer.domElement.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake, { once: false });
    padBound = true;
  }

  function activePad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (padIdx != null && pads[padIdx] && pads[padIdx].connected) return pads[padIdx];
    for (let i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i].connected) { padIdx = i; return pads[i]; }
    }
    padIdx = null;
    return null;
  }

  function padDead() {
    return (typeof DriveControls !== 'undefined') ? DriveControls.get().pad.deadZone : 0.12;
  }

  function axis(pad, i) {
    const v = pad.axes[i] || 0;
    const dead = padDead();
    /* deadzone RESCALE, not hard cut: the old `|v|<dead ? 0 : v` stepped the
       command 0 -> dead at the boundary — a thumb holding a slight correction
       at speed strobed 0 <-> 0.12 (≈0.35° of front steer at 190 mph ≈ 1.7 g
       of lateral demand toggling) = "something steering the car left-right".
       Rescaled output is continuous through the boundary. */
    const a = Math.abs(v);
    if (a < dead) return 0;
    return Math.sign(v) * Math.min(1, (a - dead) / (1 - dead));
  }

  function btn(pad, i) { return !!(pad.buttons[i] && pad.buttons[i].pressed); }

  /* analog value of a GamepadButton (Xbox triggers report 0..1 here) —
     THE freeze bug: trigger()'s button fallback called a btnValue that only
     existed inside DriveControls' module scope, so the first hard press of
     a mapped gas/brake button threw a ReferenceError out of buildInput and
     KILLED the setAnimationLoop callback (THREE schedules the next frame
     AFTER the callback returns — one throw = sim frozen for good). */
  function btnValue(b) {
    if (!b) return 0;
    if (typeof b.value === 'number') return b.value;
    return b.pressed ? 1 : 0;
  }

  /* Normalize a trigger axis to 0..1 using its RESTING value: a −1..1
     trigger sits at −1 released (Firefox/macOS non-standard mappings), a
     0..1 trigger sits at 0. The old value-based guess had a hard
     discontinuity at −0.05 and mis-scaled the whole mid-range of −1..1
     triggers — "the triggers don't map". */
  function normTrigger(raw, rest) {
    if (raw == null || !Number.isFinite(raw)) return 0;
    if (Number.isFinite(rest) && rest < -0.5) {
      return Math.min(1, Math.max(0, (raw + 1) * 0.5));      /* −1..1 trigger */
    }
    return Math.min(1, Math.max(0, raw));                    /* 0..1 trigger */
  }

  /* RAW resting axis values (release the pedals when the drive starts).
     Firefox reports trigger axes as 0 until first touched and only then
     rests them at −1 — trigger() re-learns the rest live when it sees one. */
  function calibratePad() {
    const pad = activePad();
    if (!pad) { padAxisRest = null; return; }
    const pcfg = (typeof DriveControls !== 'undefined') ? DriveControls.get().pad : null;
    if (!pcfg) { padAxisRest = null; return; }
    padAxisRest = {
      throttle: Number.isFinite(pad.axes[pcfg.throttleAxis]) ? pad.axes[pcfg.throttleAxis] : 0,
      brake: Number.isFinite(pad.axes[pcfg.brakeAxis]) ? pad.axes[pcfg.brakeAxis] : 0,
    };
  }

  function trigger(pad, btnIdx, axisIdx, restKey, pcfg) {
    const dead = padDead();
    if (axisIdx != null && axisIdx >= 0 && pad.axes.length > axisIdx) {
      const raw = pad.axes[axisIdx];
      const rest = pcfg ? pcfg[restKey + 'AxisRest'] : null;
      const dir = pcfg ? pcfg[restKey + 'AxisDir'] : 0;
      let val;
      if (Number.isFinite(raw) && Number.isFinite(rest) && (dir === 1 || dir === -1)) {
        /* bind-time calibration: rest = axis value with the pedal released,
           dir = the way it moved during capture. Exact for every trigger
           flavour (0..1, −1..1, inverted) and for sticks used as pedals —
           the guessed-range path made a captured axis dead or half-on in
           game ("throttle with axis isn't working"). */
        const range = dir > 0 ? 1 - rest : rest + 1;
        val = range > 0.05
          ? Math.min(1, Math.max(0, ((raw - rest) * dir) / range))
          : 0;
      } else {
        /* stock (never-captured) bindings: rest-referenced guess with
           self-healing — any reading below −0.5 proves a −1..1 trigger
           (a released one sits at −1), even if calibration ran before
           Firefox initialised the axis */
        if (Number.isFinite(raw) && raw < -0.5 && restKey) {
          if (!padAxisRest) padAxisRest = {};
          if (!(padAxisRest[restKey] < -0.5)) padAxisRest[restKey] = -1;
        }
        val = normTrigger(raw, restKey && padAxisRest ? padAxisRest[restKey] : 0);
      }
      if (val > dead) return val;
    }
    /* standard-mapping Xbox pads expose the triggers as ANALOG BUTTONS
       (6/7) — read the full 0..1 value directly. The old `.pressed` gate +
       0.5 floor turned them into on/off switches at half throttle. */
    const bv = btnValue(pad.buttons[btnIdx]);
    if (bv > dead) return bv;
    return 0;
  }

  function normalizeFollowView(v) {
    if (!v) return null;
    if (v === 'drive') return 'chase';
    if (v === 'nose') return 'hood';
    return v;
  }

  function cacheFollowMount(view) {
    followMount = null;
    followFov = 78;
    if (!view || typeof CarCam === 'undefined') return;
    if (view === 'chase' || view === 'farChase' || view === 'rearChase') {
      const which = view === 'farChase' ? 'far' : view === 'rearChase' ? 'rear' : 'near';
      followMount = CarCam.chaseMount(which);
      if (followMount) followFov = followMount.fov;
      return;
    }
    if (MACC_FOLLOW_VIEWS.has(view)) {
      const key = view === 'hood' ? 'nose' : view;
      const rec = (mod && mod.carCam && mod.carCam.records) ? mod.carCam.records[key] : null;
      if (rec) {
        followMount = CarCam.mountVectors(rec);
        followFov = rec.fov;
      }
    }
  }

  function cacheDriveMounts() {
    if (carFollow) cacheFollowMount(carFollow);
  }

  function camPullTarget(snap) {
    const mph = snap ? (snap.speedMph || 0) : 0;
    const t = clamp(mph / CAM_PULL_FULL_MPH, 0, 1);
    return CAM_PULL_REST + (CAM_PULL_DRIVE - CAM_PULL_REST) * t;
  }

  /* keep the chase/orbit horizon upright: the raw up follows the car's own up
     (so it tilts with banking), but as the car rolls/pitches past level — a
     blowover or a hard spin — blend toward world-up so the view never inverts.
     Fully world-up once the car is on its side or roof. */
  function uprightUp(cu) {
    if (cu.y < UPRIGHT_BLEND_Z) {
      const t = clamp((UPRIGHT_BLEND_Z - cu.y) / (UPRIGHT_BLEND_Z + 1), 0, 1);
      cu.lerp(_worldUp, t);
      if (cu.lengthSq() < 1e-6) cu.copy(_worldUp);
      else cu.normalize();
    }
    return cu;
  }

  function updatePullScale(snap, dt) {
    const target = camPullTarget(snap);
    const h = Math.max(dt || 0.016, 0.001);
    camPullSm += (target - camPullSm) * Math.min(1, h * 3.5);
  }

  function pullCamCloser(worldPos, snap, dt, pivotObj) {
    updatePullScale(snap, dt);
    _camPivot.setFromMatrixPosition((pivotObj || modelGroup).matrixWorld);
    worldPos.sub(_camPivot).multiplyScalar(camPullSm).add(_camPivot);
    return worldPos;
  }

  /* Rigid glue to car position; only smooth aim/up for bump/banking jitter.
     Chase views: the smoothed camera state is carried along with the car's
     translation each frame, then eased toward the rigid mount — so lag comes
     only from the car rotating/bouncing (chase swing), never from raw
     speed. Constant velocity produces zero steady-state lag. */
  function applySmoothMount(rawPos, rawAim, rawUp, dt, chaseLerp, pivotObj) {
    const h = Math.max(dt || 0.016, 0.001);
    const upK = Math.min(h * 10, 0.28);
    const aimK = Math.min(h * 8, 0.2);
    if (!camSmoothInit) {
      camLook.copy(rawAim);
      camUp.copy(rawUp);
      camPos.copy(rawPos);
      camSmoothInit = true;
      camInit = true;
    }
    if (chaseLerp && followMount) {
      _chasePivot.setFromMatrixPosition((pivotObj || modelGroup).matrixWorld);
      if (!camPivotInit) {
        camPos.copy(rawPos);
        camLook.copy(rawAim);
        _chasePivotPrev.copy(_chasePivot);
        camPivotInit = true;
        camInit = true;
      }
      _pivotDelta.copy(_chasePivot).sub(_chasePivotPrev);
      _chasePivotPrev.copy(_chasePivot);
      camPos.add(_pivotDelta);
      camLook.add(_pivotDelta);
      const k = clamp(h * followMount.smooth * 6.5, 0, 0.38);
      camPos.lerp(rawPos, k);
      camera.position.copy(camPos);
      camLook.lerp(rawAim, aimK);
    } else {
      camera.position.copy(rawPos);
      camLook.copy(rawAim);
    }
    camUp.lerp(rawUp, upK);
    camera.up.copy(camUp);
    camera.lookAt(camLook);
    return true;
  }

  /* the Object3D the cameras frame: the player's modelGroup, or a lightweight
     proxy parked at the focused AI car (its trackGroup-local pose is f.mat).
     worldPose/chase math only reads matrixWorld, so a proxy retargets EVERY
     follow view to any car with no geometry needed. */
  function focusObj() {
    if (!focusCar || !focusCar.mat || !trackGroup) return modelGroup;
    if (!focusProxy) { focusProxy = new THREE.Object3D(); focusProxy.matrixAutoUpdate = false; }
    if (focusProxy.parent !== trackGroup) trackGroup.add(focusProxy);
    focusProxy.matrix.copy(focusCar.mat);
    focusProxy.updateWorldMatrix(true, false);   /* world = trackGroup · f.mat */
    return focusProxy;
  }
  /* the focused car's world position */
  const _focusPos = new THREE.Vector3();
  function focusWorldPos(out) {
    const o = focusObj();
    if (!o) return null;
    o.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(o.matrixWorld);
  }

  /* focus roster: the player plus every live AI racer, in car-number order */
  function driverList() {
    const list = [{ value: 'player', label: 'Your car', car: null }];
    for (const f of fieldCars) {
      if (f.ai) list.push({ value: 'ai:' + f.slot, label: 'Car #' + (f.slot + 1), car: f });
    }
    return list;
  }
  function focusValue() { return focusCar ? 'ai:' + focusCar.slot : 'player'; }
  function setFocus(f) {
    focusCar = f || null;
    if (!focusCar && focusProxy && focusProxy.parent) focusProxy.parent.remove(focusProxy);
    camInit = camSmoothInit = camPivotInit = false;   /* snap the cam to the new car, don't sweep across the track */
    syncDriverSelect();
    log(focusCar ? `Camera focus: Car #${focusCar.slot + 1}.` : 'Camera focus: your car.');
  }
  function focusPlayer() { if (focusCar) setFocus(null); }
  function cycleFocus(dir) {
    const ai = fieldCars.filter((f) => f.ai);
    if (!ai.length) return;
    const i = focusCar ? ai.indexOf(focusCar) : -1;
    const n = ai.length;
    /* order: player → first AI → … → last AI → player */
    if (i < 0) setFocus(dir > 0 ? ai[0] : ai[n - 1]);
    else {
      const j = i + dir;
      if (j < 0 || j >= n) setFocus(null);          /* stepped off the ends → back to the player */
      else setFocus(ai[j]);
    }
  }
  function syncDriverSelect() {
    const sel = $('vp-driver');
    if (sel) sel.value = focusValue();
  }

  function tickCarCamera(dt, snap) {
    if (!carFollow || !modelGroup) return false;
    const obj = focusObj();                 /* player or the focused AI proxy */
    if (!obj) return false;
    if (focusCar) snap = focusCar.snapCur || snap;   /* player keeps its interpolated snap */
    updateDriveOrbitPad(dt);
    if (carFollow === 'chase' || carFollow === 'farChase' || carFollow === 'rearChase') {
      if (!followMount) cacheFollowMount(carFollow);
      if (!followMount) return false;
      obj.updateWorldMatrix(true, false);
      _p0.copy(followMount.pos);
      _p1.copy(followMount.aim);
      applyDriveOrbitLocal(_p0, _p1);
      _p0.applyMatrix4(obj.matrixWorld);
      _p1.applyMatrix4(obj.matrixWorld);
      _cu.set(0, 0, 1).transformDirection(obj.matrixWorld);
      uprightUp(_cu);
      pullCamCloser(_p0, snap, dt, obj);
      return applySmoothMount(_p0, _p1, _cu, dt, true, obj);
    }
    if (MACC_FOLLOW_VIEWS.has(carFollow)) {
      if (!followMount) cacheFollowMount(carFollow);
      if (!followMount) return false;
      obj.updateWorldMatrix(true, false);
      _p0.copy(followMount.pos);
      _p1.copy(followMount.aim);
      applyDriveOrbitLocal(_p0, _p1);
      _p0.applyMatrix4(obj.matrixWorld);
      _p1.applyMatrix4(obj.matrixWorld);
      _cu.set(0, 0, 1).transformDirection(obj.matrixWorld);
      uprightUp(_cu);
      pullCamCloser(_p0, snap, dt, obj);
      return applySmoothMount(_p0, _p1, _cu, dt, false, obj);
    }
    if (typeof CarCam === 'undefined') return false;
    const cv = CarCam.showroomView(carFollow, obj, mod && mod.carCam);
    if (!cv) return false;
    _p0.copy(cv.pos);
    _p1.copy(cv.tgt);
    obj.updateWorldMatrix(true, false);
    obj.worldToLocal(_p0);
    obj.worldToLocal(_p1);
    applyDriveOrbitLocal(_p0, _p1);
    _p0.applyMatrix4(obj.matrixWorld);
    _p1.applyMatrix4(obj.matrixWorld);
    pullCamCloser(_p0, snap, dt, obj);
    return applySmoothMount(_p0, _p1, cv.up, dt, false, obj);
  }

  /* ---- track TV cameras: fixed broadcast spots that AIM at the FOCUSED car
     (NR-style), either a hand-picked camera or an auto director that hands off
     to the nearest camera as the car laps. */
  let trackCam = -1;              /* active TV camera index; -1 = none */
  let tvDirector = false;         /* NR-style auto hand-off director */
  const _tvPos = new THREE.Vector3(), _tvTmp = new THREE.Vector3();
  /* each real .cam camera's track distance (where its position projects onto the
     centreline) + the cumulative-distance table. Oval racing behaviour: a
     camera owns the stretch of track it overlooks, and the director shows
     whichever camera's stretch the focused car is on. Deriving the section from
     the camera's own position keeps it in the car's distance space on EVERY
     track (no reliance on the .cam's S/F origin). Built once per track. */
  let _tvCamDlong = null, _tvCum = null, _tvTotal = 0;
  /* TV framing: telephoto that ZOOMS with distance so the car stays a good size
     from any camera (a fixed FOV left far cameras "too zoomed out"). */
  const TV_FRAME_M = 16, TV_FOV_MIN = 8, TV_FOV_MAX = 42;
  const TV_HANDOFF_M = 22;        /* m into a new camera's section before cutting (hysteresis) */
  function trackCamActive() { return trackCam >= 0 || tvDirector; }
  function tvCamWorld(i, out) {
    const cam = track.cameras[i];
    return out.copy(trackGroup.localToWorld(_tvTmp.set(cam.x, cam.y, cam.height)));
  }
  /* project a Papyrus point onto the centreline → its track distance (cumDist) */
  function centrelineDist(px, py, seedK) {
    const segs = track.surface.segments, N = segs.length;
    let best = { d2: Infinity, k: 0, u: 0 };
    const testK = (k) => {
      const kk = ((k % N) + N) % N;
      const u = clamp(TrackSurface.projectSegU(segs[kk], px, py), 0, 1);
      const c = TrackSurface.sampleCenter(segs[kk], u);
      const dx = px - c.x, dy = py - c.y, d2 = dx * dx + dy * dy;
      if (d2 < best.d2) best = { d2, k: kk, u };
    };
    if (seedK == null) for (let k = 0; k < N; k++) testK(k);
    else for (let dk = -3; dk <= 3; dk++) testK(seedK + dk);
    return _tvCum[best.k] + best.u * segLen(segs[best.k]);
  }
  function ensureTvTrackPos() {
    if (_tvCamDlong) return;
    const segs = track.surface.segments;
    _tvCum = new Array(segs.length); let acc = 0;
    for (let k = 0; k < segs.length; k++) { _tvCum[k] = acc; acc += segLen(segs[k]); }
    _tvTotal = acc || 1;
    _tvCamDlong = track.cameras.map((cam) => centrelineDist(cam.x, cam.y, null));   /* the stretch each cam overlooks */
  }
  function cyclicDist(a, b) { const d = Math.abs(a - b) % _tvTotal; return Math.min(d, _tvTotal - d); }
  /* the focused car's track distance (same distance space as the camera sections) */
  function focusTrackDlong() {
    const segs = track.surface.segments;
    const pr = focusCar ? (focusCar.seed && focusCar.seed.progress) : progress;
    return (pr && pr.seg != null)
      ? _tvCum[pr.seg % segs.length] + (pr.u || 0) * segLen(segs[pr.seg % segs.length])
      : centrelineDist(focusCar ? focusCar.car.x : (car ? car.x : 0),
        focusCar ? focusCar.car.y : (car ? car.y : 0), pr ? pr.seg : null);
  }
  function nearestTvCamByDlong(carDlong) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < _tvCamDlong.length; i++) {
      const d = cyclicDist(_tvCamDlong[i], carDlong);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function setTrackCam(idx) {
    if (!track || !track.cameras || !track.cameras[idx]) return;
    if (carFollow) setCarFollow(null);
    trackCam = idx; tvDirector = false;
    controls.enabled = false;
    tickTrackCamera(0);
  }
  function setTvDirector() {
    if (!track || !track.cameras || !track.cameras.length) return;
    if (carFollow) setCarFollow(null);
    ensureTvTrackPos();
    tvDirector = true; trackCam = -1;
    controls.enabled = false;
    tickTrackCamera(0);
  }
  function clearTrackCam() {
    if (!trackCamActive()) return;
    trackCam = -1; tvDirector = false;
    controls.enabled = !carFollow;
  }
  /* returns true when it drove the camera (a TV cam is active) */
  function tickTrackCamera(dt) {
    if (!trackCamActive() || !track || !track.cameras || !track.cameras.length || !trackGroup) return false;
    focusWorldPos(_focusPos);
    if (tvDirector) {
      ensureTvTrackPos();
      const carDlong = focusTrackDlong();
      const nearest = nearestTvCamByDlong(carDlong);
      if (trackCam < 0) trackCam = nearest;
      else if (nearest !== trackCam) {
        /* hand off only once the car is clearly INTO the next camera's section,
           so the cut lands cleanly past the boundary instead of flickering */
        const dCur = cyclicDist(_tvCamDlong[trackCam], carDlong);
        const dNew = cyclicDist(_tvCamDlong[nearest], carDlong);
        if (dCur - dNew > TV_HANDOFF_M) trackCam = nearest;
      }
    }
    if (!track.cameras[trackCam]) return false;
    tvCamWorld(trackCam, _tvPos);
    camera.position.copy(_tvPos);
    camera.up.set(0, 1, 0);
    camera.lookAt(_focusPos);
    /* zoom to keep the car a good size from any distance */
    const dCar = _tvPos.distanceTo(_focusPos);
    const fov = clamp(2 * Math.atan((TV_FRAME_M * 0.5) / Math.max(2, dCar)) * 180 / Math.PI,
      TV_FOV_MIN, TV_FOV_MAX);
    if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = fov; camera.updateProjectionMatrix(); }
    return true;
  }

  /* Car-mounted camera on/off — driving itself stays armed either way */
  function setCarFollow(view) {
    clearTrackCam();   /* a car view supersedes any TV camera */
    const want = normalizeFollowView(view);
    const valid = want && CAR_FOLLOW_VIEWS.has(want) ? want : null;
    if (valid && DRIVE_ARM_VIEWS.has(valid) && !active) start();
    if (valid && DRIVE_ARM_VIEWS.has(valid) && !active) {
      log('Drive: open a car and a track (with a decoded surface) first.');
      const sel = $('vp-camera'); if (sel) sel.value = 'trackview';
      return;
    }
    if (carFollow === valid) return;
    carFollow = valid;
    controls.enabled = !carFollow;
    if (carFollow) {
      resetDriveOrbit();
      bindDriveOrbit();
      savedFov = camera.fov;
      cacheFollowMount(carFollow);
      if (MACC_FOLLOW_VIEWS.has(carFollow) && !followMount) {
        log('That view needs a .cam file next to the car (MACC format).');
        carFollow = null;
        controls.enabled = true;
        const sel = $('vp-camera');
        if (sel) sel.value = 'trackview';
        return;
      }
      camera.fov = followFov;
      camInit = false;
      camSmoothInit = false;
      camPivotInit = false;
      camPullSm = CAM_PULL_REST;
      tickCarCamera(0, null);

      renderer.domElement.focus();
      if (navigator.getGamepads) navigator.getGamepads();
    } else if (savedFov != null) {
      camera.fov = savedFov;
      savedFov = null;
    }
    if (!carFollow) {
      unbindDriveOrbit();
      resetDriveOrbit();
    }
    camera.updateProjectionMatrix();
  }

  function setDriveCam(mode) {
    setCarFollow((mode === 'chase' || mode === 'hood') ? mode : null);
  }

  function setChase(on) { setCarFollow(on ? 'chase' : null); }

  function leaveDriveCam(resetDropdown) {
    if (!carFollow) return;
    setCarFollow(null);
    if (resetDropdown) {
      const sel = $('vp-camera');
      if (sel && [...sel.options].some(o => o.value === 'trackview')) { sel.value = 'trackview'; frameTrackCar(); }
    }
  }

  /* FULL stop — track teardown/reload. Keys unbind, the car re-parks. */
  function exit(resetDropdown) {
    if (carFollow) setCarFollow(null);
    if (!active) return;
    active = false;
    race = null; setRaceHud('');   /* a race can't survive a track teardown */
    _tvCamDlong = null;            /* rebuild the TV camera sections for the next track */
    disarmField();       /* field cars settle back to their parked poses */
    unbindKeys();
    releaseWheels();
    flapAnim = 0;
    applyFlapState(0);   /* flaps sit closed once the drive ends */
    /* park the car back on the start/finish line so the scene looks tidy */
    if (track && track.stall && track.stall.world) placeCarAtStall(track.stall.world);
    if (resetDropdown) {
      const sel = $('vp-camera');
      if (sel && [...sel.options].some(o => o.value === 'trackview')) { sel.value = 'trackview'; frameTrackCar(); }
    }
  }

  /* Universal pedals — shared latched mapper (Physics.mapDrivePedals):
     W/S swap roles with motion direction, both-pedals = latched burnout */
  let burnoutLatch = false;
  /* keyboard pedals are binary — ramp them so a W/S tap isn't an instant
     750 hp / full-brake STEP slamming the weight transfer ("too much of a
     shift when I move / stop / go"). Analog triggers pass through raw —
     the driver's finger IS the ramp. Release is instant. */
  let kbGasSm = 0;
  let kbBrakeSm = 0;
  const KB_GAS_RISE_S = 0.18;
  const KB_BRAKE_RISE_S = 0.08;
  /* Speed-sensitive steering (Options → Controls, default ON for
     non-wheel controllers): the full stick/key still reaches ~88% of total
     lock at 170 mph (~16° — an instant 2 g slip step), so every correction
     at speed kicked the car sideways. Scale the COMMAND down with speed —
     full lock stays available below ~34 mph (pits, spins, saves). */
  const SS_START_MPS = 15;
  const SS_END_MPS = 65;
  const SS_MID_SCALE = 0.35;
  /* second taper leg for superspeedway pace: at 200 mph ~0.1° of front steer
     already demands ~0.5 g, so the old 0.35 floor still slammed every full
     digital deflection into grip saturation — the car darted left-right off
     taps ("something is steering the car at higher speeds"). 0.18 of the
     ~16° lock ≈ 2.9°, still 5x the steady-state need at Daytona. */
  const SS_END2_MPS = 95;
  const SS_MIN_SCALE = 0.18;
  function ssSteerScale() {
    const aids = (typeof DriveControls !== 'undefined') ? DriveControls.get().aids : null;
    if (aids && aids.speedSensitiveSteer === false) return 1;
    const spd = car ? car.speed : 0;
    const t1 = clamp((spd - SS_START_MPS) / (SS_END_MPS - SS_START_MPS), 0, 1);
    const t2 = clamp((spd - SS_END_MPS) / (SS_END2_MPS - SS_END_MPS), 0, 1);
    return 1 - (1 - SS_MID_SCALE) * t1 - (SS_MID_SCALE - SS_MIN_SCALE) * t2;
  }
  /* keyboard steer ramps on with a speed-scaled rise (instant release, like
     the pedals): a short tap at speed feeds a fraction of the command, so
     digital steering can make micro-corrections instead of bang-bang slams.
     Near-instant below pit speed — donuts/parking keep full agility. The
     pad stick stays raw: the driver's thumb is the ramp. */
  let kbSteerSm = 0;
  const KB_STEER_RISE_LO_S = 0.08;
  const KB_STEER_RISE_HI_S = 0.5;

  function driveInputAllowed() {
    /* driving input only while the 3D view is focused — Controls bind polls
       the pad on its own while mapping. */
    if (typeof DriveControls !== 'undefined' && DriveControls.listeningPad && DriveControls.listeningPad()) return false;
    return document.activeElement === renderer.domElement;
  }

  function neutralDriveInput() {
    KEY.throttle = KEY.brake = KEY.steerLeft = KEY.steerRight = KEY.lockUp = false;
    padRespawnHeld = false;
    kbGasSm = kbBrakeSm = kbSteerSm = 0;
    return { throttle: 0, brake: 0, steer: 0, reverse: false, lockUp: false };
  }

  function buildInput(dt) {
    if (!driveInputAllowed()) return neutralDriveInput();
    const h = dt || 0.016;
    let steer = (KEY.steerLeft ? 1 : 0) - (KEY.steerRight ? 1 : 0);
    let padSteerUsed = false;
    const dead = padDead();
    let gas = 0, brakePed = 0;

    const pad = activePad();
    if (pad) {
      const pcfg = (typeof DriveControls !== 'undefined') ? DriveControls.get().pad : null;
      const steerAxis = pcfg ? pcfg.steerAxis : 0;
      let padSteer = axis(pad, steerAxis);
      if (pcfg && pcfg.steerInvert) padSteer = -padSteer;
      if (padSteer) { steer = padSteer; padSteerUsed = true; }
      gas = pcfg
        ? trigger(pad, pcfg.throttleBtn, pcfg.throttleAxis, 'throttle', pcfg)
        : Math.max(trigger(pad, 7, 5, 'throttle'), trigger(pad, 5, 3, 'throttle'));
      brakePed = pcfg
        ? trigger(pad, pcfg.brakeBtn, pcfg.brakeAxis, 'brake', pcfg)
        : Math.max(trigger(pad, 6, 4, 'brake'), trigger(pad, 4, 2, 'brake'));
      if (gas <= dead) gas = 0;
      if (brakePed <= dead) brakePed = 0;
      const respawnIdx = pcfg ? pcfg.respawnBtn : 3;
      const respawnBtn = btn(pad, respawnIdx);
      if (respawnBtn && !padRespawnHeld) respawn();
      padRespawnHeld = respawnBtn;
    } else {
      padRespawnHeld = false;
    }

    /* keyboard pedals ramp on (instant off) — see kbGasSm note above */
    kbGasSm = KEY.throttle ? kbGasSm + (1 - kbGasSm) * Math.min(1, h / KB_GAS_RISE_S) : 0;
    kbBrakeSm = KEY.brake ? kbBrakeSm + (1 - kbBrakeSm) * Math.min(1, h / KB_BRAKE_RISE_S) : 0;
    if (KEY.throttle) gas = Math.max(gas, kbGasSm);
    if (KEY.brake) brakePed = Math.max(brakePed, kbBrakeSm);

    /* keyboard steer rise (see kbSteerSm note) — pad analog passes raw */
    if (!padSteerUsed) {
      if (steer === 0) kbSteerSm = 0;
      else {
        const spd = car ? car.speed : 0;
        const t = clamp((spd - SS_START_MPS) / (SS_END_MPS - SS_START_MPS), 0, 1);
        const rise = KB_STEER_RISE_LO_S + (KB_STEER_RISE_HI_S - KB_STEER_RISE_LO_S) * t;
        kbSteerSm += (steer - kbSteerSm) * Math.min(1, h / rise);
      }
      steer = kbSteerSm;
    } else {
      kbSteerSm = 0;
    }

    /* speed-sensitive steering — scales the COMMAND, not the available lock */
    steer *= ssSteerScale();
    steer *= steerSpeedScale(car ? car.speed : 0);   /* sensitivity, speed-scaled (full at low speed) */

    let lockUp = KEY.lockUp;
    if (pad) {
      const pcfg = (typeof DriveControls !== 'undefined') ? DriveControls.get().pad : null;
      const lockIdx = pcfg ? pcfg.lockUpBtn : 1;
      if (btn(pad, lockIdx)) lockUp = true;
    }
    if (lockUp) {
      burnoutLatch = false;
      return { throttle: 0, brake: 1, steer, reverse: false, lockUp: true };
    }

    const mapped = Physics.mapDrivePedals(car, gas, brakePed, burnoutLatch);
    burnoutLatch = mapped.burnout;
    return { throttle: mapped.throttle, brake: mapped.brake, steer, reverse: mapped.reverse, lockUp: false };
  }

  /* nearest-centreline projection of (x,y) onto the lofted track → surface
     height, up-normal (banking) and grip. Incremental: seeded from the last
     frame's segment so it's a cheap local search. */
  const SURF_RELOCK_D2 = 60 * 60;  /* local lock >60 m off the centreline is a
                                      mis-lock (wrong segment ⇒ wrong height +
                                      phantom walls) → re-search globally */
  function sampleSurface(x, y) {
    const segs = track && track.surface && track.surface.segments;
    if (!segs || !segs.length) return { height: 0, up: [0, 0, 1], grip: 1, seg: null };
    const N = segs.length;
    let best = { d2: Infinity, k: progress ? progress.seg : 0, u: 0, cx: 0, cy: 0, tx: 1, ty: 0 };
    /* CLOSED-FORM projection per candidate segment (TrackSurface.projectSegU)
       — the old 14-sample coarse + refine search quantised u to ~0.5% of a
       segment, so the height/banking under the car staircased through every
       turn (mid-corner jitter); analytic u is exact, smooth, and cheaper */
    const test = (k) => {
      const kk = ((k % N) + N) % N;
      const u = clamp(TrackSurface.projectSegU(segs[kk], x, y), 0, 1);
      const c = TrackSurface.sampleCenter(segs[kk], u);
      const dx = x - c.x, dy = y - c.y, d2 = dx * dx + dy * dy;
      if (d2 < best.d2) best = { d2, k: kk, u, cx: c.x, cy: c.y, tx: c.tx, ty: c.ty };
    };
    /* fresh lock (respawn / state load / track swap ⇒ progress=null) or a lost
       one falls back to a GLOBAL search — the incremental scan only sees
       ±2 segments and can lock onto the wrong part of the track forever
       (spawn far from segment 0, pit spur, teleport) */
    const globalSearch = () => { for (let k = 0; k < N; k++) test(k); };
    if (!progress) globalSearch();
    else for (let dk = -1; dk <= 2; dk++) test(progress.seg + dk);
    if (best.d2 > SURF_RELOCK_D2) {
      /* deep off the loft (tri-oval infield) EVERY segment is >60 m away, so
         this fired every frame and the "nearest" flipped between unrelated
         parts of the track (oval vs pit segments) as the car moved — each
         flip STEPPED the sampled ground under the car, a phantom curb that
         at slide speed launched it (the grass front-end pop). Keep the
         continuous local walk unless the global winner is DECISIVELY closer
         — a true mis-lock (wrong side of the track, pit spur, teleport). */
      const local = { ...best };
      globalSearch();
      if (best.k !== local.k && best.d2 > local.d2 * 0.25) best = local;
    }
    progress = { seg: best.k, u: clamp(best.u, 0, 1) };

    const seg = segs[best.k];
    const nx = -best.ty, ny = best.tx;          /* driver's-left normal (+dlat) */
    const dlat = (x - best.cx) * nx + (y - best.cy) * ny;
    const height = TrackSurface.heightAt(seg, dlat, dlat, best.u);

    /* surface normal from the height gradients (banking + grade) */
    const eps = 0.3;
    const dhdl = (TrackSurface.heightAt(seg, dlat + eps, dlat + eps, best.u) -
                  TrackSurface.heightAt(seg, dlat - eps, dlat - eps, best.u)) / (2 * eps);
    const segLen = seg.arc ? Math.abs(seg.arc.r * seg.arc.dth)
                           : Math.hypot(seg.block.x1 - seg.block.x0, seg.block.y1 - seg.block.y0);
    const du = 0.02, uA = Math.min(1, best.u + du), uB = Math.max(0, best.u - du);
    const ds = Math.max(0.5, segLen * (uA - uB));
    const dhds = (TrackSurface.heightAt(seg, dlat, dlat, uA) -
                  TrackSurface.heightAt(seg, dlat, dlat, uB)) / ds;
    let up = [best.ty * dhdl - best.tx * dhds, -best.ty * dhds - best.tx * dhdl, 1];
    const inv = 1 / Math.hypot(up[0], up[1], up[2]);
    up = [up[0] * inv, up[1] * inv, up[2] * inv];

    /* off-surface (into the grass) → drop grip, dig in, drag, lay dirt. Read the
       ACTUAL ground strip the car sits on (grass texture = off) — the geometric
       |dlat|>halfWidth test counted the grass bands the cross-section spans as
       "on surface", so grass never dropped grip or laid dirt. Geometric fallback
       when the strip material can't be resolved. */
    let offSurface = classifyGrassAt(seg, dlat, best.u);
    if (offSurface === null) {
      let halfWidth = 0;
      for (const xs of seg.xsecs) halfWidth = Math.max(halfWidth, Math.abs(xs.d0), Math.abs(xs.d1));
      offSurface = Math.abs(dlat) > halfWidth + 0.6;
    }
    /* on-track grip is THIS track's asphalt grip scale from the track .ini (
       track_asphalt_grip, ~0.95–1.15) — the racing surface no longer grips the
       same on every track. (The racing groove is asphalt on ~all tracks; the
       viewer can't yet classify concrete per-segment, so concrete_grip is
       carried on track.env but not applied per-strip.) */
    const paved = (track && track.env && Number.isFinite(track.env.asphaltGrip))
      ? track.env.asphaltGrip : 1;
    const grip = offSurface ? GRASS_GRIP : paved;
    const dig = offSurface ? GRASS_DIG : 1;          /* trip-and-flip grab */
    const rollDrag = offSurface ? GRASS_ROLL_DRAG : 1;  /* grass plows/slows */
    /* per-point grass test for the tyre FX: project any world point (each
       WHEEL) onto this segment's lateral axis and read its strip material, so
       marks + particles are styled by the surface under that wheel — not the
       car centre (which bled dirt onto track and skids onto grass). Pure: no
       `progress` mutation, unlike sampleSurface. */
    const cx = best.cx, cy = best.cy, uu = best.u;
    const grassAt = (wx, wy) => {
      const g = classifyGrassAt(seg, (wx - cx) * nx + (wy - cy) * ny, uu);
      return g === null ? offSurface : g;
    };
    return { height, up, grip, dig, rollDrag, offSurface, grassAt,
      seg, u: best.u, dlat, tx: best.tx, ty: best.ty };
  }
  const WALL_RESOLVE_ITERS = 8;
  const DMG_IMPULSE_FULL = 1587.6 * 40;  /* N·s for damage 1.0 — a ~40 m/s-normal
                                          full-mass hit wrecks the car (stand-in) */

  function segCarContext(seg, x, y) {
    /* closed-form projection — the old 20-sample arc search quantised the
       wall-face distance to 5% of a segment: grinding a wall through a turn
       saw the face jump around ("glitches when hitting a wall") */
    const u = clamp(TrackSurface.projectSegU(seg, x, y), 0, 1);
    const c = TrackSurface.sampleCenter(seg, u);
    const lx = -c.ty, ly = c.tx;
    const dlat = (x - c.x) * lx + (y - c.y) * ly;
    return { u, dlat, lx, ly, cx: c.x, cy: c.y };
  }

  /* pre-step car position — which SIDE of a thin interior wall the car came
     from this frame. Approach from the track keeps the full half-space depth
     (anti-tunnel); approach from behind (pit road) contacts the BACK face. */
  let preStepX = 0, preStepY = 0;

  /* height a wall-test point may sit below the local surface plane and still
     be tested — big banking means the wall's ground line differs from the
     surface plane under the car */
  const WALL_PT_BELOW_M = 0.5;

  function wallCollide(surf) {
    if (!car || !track || !track.surface || !track.surface.segments || !track.surface.segments.length) return false;
    const segs = track.surface.segments;
    const N = segs.length;
    /* test the NEIGHBOURING segments' walls too — at a segment join (the
       start/finish line is one) the car's corner overlaps the next
       segment's wall while progress still points at the previous one;
       single-segment testing let the car push straight through there */
    const segKs = [];
    const pushK = (k) => {
      const kk = ((k % N) + N) % N;
      if (!segKs.includes(kk)) segKs.push(kk);
    };
    let primaryK = -1;
    if (progress != null) {
      primaryK = ((progress.seg % N) + N) % N;
      pushK(progress.seg - 1); pushK(progress.seg); pushK(progress.seg + 1);
    } else if (surf && surf.seg) {
      const ki = segs.indexOf(surf.seg);
      if (ki >= 0) { primaryK = ki; pushK(ki - 1); pushK(ki); pushK(ki + 1); }
    } else return false;

    let best = null;
    /* mesh-accurate contacts: the car's REAL body support points at the
       CURRENT attitude (flight quat mid-tumble, surface+suspension pose
       grounded) — "what you see is what you hit". Each point carries its
       height above the surface, so a low wall is only hit by low bodywork
       and a flying car clears it with exactly the parts that visually clear
       it (the old whole-car airborne gate is per-point now). */
    const ptLift = (car.airborne || car.restingOnBody)
      ? Math.max(0, (car.zPos || 0) - ((surf && surf.height) || 0)) : 0;
    const wallPts = Physics.wallContactPoints(car, surf && surf.up, ptLift);
    for (const ki of segKs) {
      const seg = segs[ki];
      if (!seg || !seg.walls || !seg.walls.length) continue;
      const ctx = segCarContext(seg, car.x, car.y);
      const { u, dlat, lx, ly } = ctx;
      /* NEIGHBOUR segments only matter right at the shared join — if the
         car's projection onto the neighbour overshoots its end (clamped u
         with a longitudinal residual), its walls are elsewhere on the
         track; testing them made phantom mid-straight "wall hits" */
      if (ki !== primaryK) {
        const c = TrackSurface.sampleCenter(seg, u);
        const rx = car.x - c.x - dlat * lx;
        const ry = car.y - c.y - dlat * ly;
        if (rx * rx + ry * ry > 36) continue;
      }
      /* pre-step lateral position in this segment's frame (1-frame approx:
         same centreline point) — the approach-side memory for interior walls */
      const dlatPrev = (preStepX - ctx.cx) * lx + (preStepY - ctx.cy) * ly;
      for (const w of seg.walls) {
        if (!Physics.isWallCollidable(w, u, dlat)) continue;
        const wallTop = Math.max(w.h0 || 0, w.h1 || 0);
        const { side, trackFace } = Physics.wallTrackFaces(w, u);
        const slab = Physics.wallSlab(seg, w, u);
        const penPrev = side > 0 ? dlatPrev - trackFace : trackFace - dlatPrev;
        const fromBack = slab.interior && penPrev > slab.T * 0.5;
        let cp = null;
        for (const c of wallPts) {
          if (c.hz > wallTop || c.hz < -WALL_PT_BELOW_M) continue;
          const dlatC = dlat + c.ox * lx + c.oy * ly;
          let pen = side > 0 ? dlatC - trackFace : trackFace - dlatC;
          let back = false;
          if (pen <= 0) continue;
          if (fromBack) {
            /* car is on the pit side of an interior wall: clear of the slab
               = free (no phantom rail); into the slab = bit the BACK face */
            if (pen >= slab.T) continue;
            pen = slab.T - pen; back = true;
          }
          if (!cp || pen > cp.pen) cp = { ox: c.ox, oy: c.oy, pen, side, lx, ly, back };
        }
        if (!cp) continue;
        if (!best || cp.pen > best.cp.pen) best = { cp, w };
      }
    }
    if (!best) return false;
    const { ox, oy, pen, side, lx, ly, back } = best.cp;
    const faceSgn = back ? -1 : 1;
    const nx = -lx * side * faceSgn, ny = -ly * side * faceSgn;
    /* progressive de-penetration: the old full pen + clearance teleport
       snapped the car sideways 5+ cm on every contact frame — wall
       grinding read as jitter. Shallow contact separates gently over a
       couple of frames; deep merges still resolve fast via the iterations. */
    const push = Math.min(pen, 0.05) + 0.005;
    car.x += nx * push;
    car.y += ny * push;
    const tex = (best.w && best.w.texture) || '';
    const soft = /softwall|safer/i.test(tex);
    const jN = Physics.resolveWallImpulse(car, ox, oy, nx, ny, pen, soft);
    if (jN > 0) car.addDamage(jN / DMG_IMPULSE_FULL);
    car._zSurfExternalShift = true;
    if (!car.airborne && surf && surf.up) Physics.resyncGroundVz(car, surf.up);
    return true;
  }

  function resolveWalls(surf) {
    let s = surf;
    for (let i = 0; i < WALL_RESOLVE_ITERS; i++) {
      if (!wallCollide(s)) return s;
      s = sampleSurface(car.x, car.y);
    }
    return s;
  }

  /* place the physics result onto modelGroup (trackGroup-local coords):
     yaw + align the body's up to the surface normal for banking, plus
     suspension roll/pitch from per-corner spring compression.

     The loft height/up-normal can step at section joins, and gluing the body
     straight to them reads as the car snapping up and down — so the vertical
     position and attitude ease onto their targets at suspension speed instead,
     with the real spring travel (snap.heave) riding on top. x/y stay raw. */
  const POSE_SMOOTH_TAU_S = 0.02;   /* body settle time constant. Was 0.08 —
                                       sized when the surface sample really did
                                       step at seams. With the analytic
                                       projection, C1 loft, lateral fillets and
                                       the interpolated sample (f164) the input
                                       is smooth, and 80 ms of lag was VISIBLE:
                                       height trails speed·grade while moving
                                       and releases as you brake, so the car
                                       (tires included — they ride smoothZ too)
                                       eased down the last cm as it stopped:
                                       the "tires magnet to the track" effect. */
  /* Per-car render smoothing (player + every field car). Only reset via
     resetSimInterp() / armField — never auto-detect crash displacement as a
     teleport (that hard-snapped z/attitude every contact frame). */
  function makeRenderSmooth() {
    return {
      smoothZ: null, smoothX: null, smoothY: null, renderQuat: null,
      poseQuatHold: null, upSm: new THREE.Vector3(0, 0, 1),
    };
  }
  function resetRenderSmooth(st) {
    st.smoothZ = null; st.smoothX = st.smoothY = null; st.renderQuat = null;
    st.poseQuatHold = null; st.upSm.set(0, 0, 1);
  }
  const _playerRender = makeRenderSmooth();
  const _up = new THREE.Vector3();

  /* ===== SPAWN / VERTICAL DIAGNOSTIC (2026-07-09, debugged the on-load float
     — root cause fixed in physics f110). OFF by default now: it logs ~150
     heavy console lines after EVERY respawn, which with dev tools open froze
     the sim for seconds each time the respawn button was pressed. Re-arm
     with window.re2003Diag(true); window.re2003Diag('dump') prints one full
     state snapshot on demand. */
  const SpawnDiag = (() => {
    let on = false, n = 0, cap = 150, banner = false;
    const f3 = (v) => (v == null ? 'null' : (typeof v === 'number' ? v.toFixed(3) : String(v)));
    const vec = (a) => (a && a.map ? '[' + a.map((x) => (+x).toFixed(3)).join(',') + ']' : String(a));
    function begin(pose) {
      if (!on) return;
      n = 0; banner = false;
      const seg0 = track && track.surface && track.surface.segments && track.surface.segments[0];
      console.log('\n===== RE2003 SPAWN DIAG BEGIN =====');
      console.log('spawnPose', JSON.stringify(pose));
      console.log('floorZ(drive)=', f3(floorZ), 'mod.floorZ=', f3(mod && mod.floorZ),
        'mod.bodyFloorZ=', f3(mod && mod.bodyFloorZ), 'RIDE?');
      console.log('mod.carDims=', mod && mod.carDims ? JSON.stringify(mod.carDims) : 'none');
      console.log('track segs=', track && track.surface && track.surface.segments
        && track.surface.segments.length, 'seg0.xsecs=', seg0 && seg0.xsecs ? seg0.xsecs.length : 'none');
      if (car) {
        console.log('car spawn state: x=', f3(car.x), 'y=', f3(car.y), 'zPos=', f3(car.zPos),
          'yaw=', f3(car.yaw), 'up=', vec(car.up), 'airborne=', car.airborne,
          'bodyShapePts=', car.bodyPts && car.bodyPts.length,
          'cgHeight=', f3(car.p && car.p.cgHeight));
      }
    }
    /* called from placeCar with everything it computed */
    function frame(d) {
      if (!on || n >= cap) return;
      if (!banner) { console.log('--- per-frame (up to ' + cap + ' frames) ---'); banner = true; }
      const s = d.snap, su = d.surf, c = car;
      console.log(
        `f${n}`,
        'phys{',
        'zPos=' + f3(c && c.zPos), 'vz=' + f3(c && c.vz),
        'air=' + (c && c.airborne ? 1 : 0), 'onSurf=' + (c && c.onSurface ? 1 : 0),
        'rest=' + (c && c.restingOnBody ? 1 : 0),
        'zSurfPrev=' + f3(c && c._zSurfPrev), 'vzSurfSm=' + f3(c && c._vzSurfSm),
        'outlier=' + (c && c._zSurfOutlier ? 1 : 0), 'extShift=' + (c && c._zSurfExternalShift ? 1 : 0),
        'gndHold=' + f3(c && c._groundHold), 'bodyZ=' + f3(c && c.bodyZ),
        'bPitch=' + f3(c && c.bodyPitch), 'bRoll=' + f3(c && c.bodyRoll),
        '}',
        'surf{', 'h=' + f3(su && su.height), 'up=' + vec(su && su.up),
        'dlat=' + f3(su && su.dlat), 'seg=' + (progress && progress.seg),
        'grip=' + f3(su && su.grip), '}',
        'snap{', 'z=' + f3(s && s.z), 'onSurface=' + (s && s.onSurface ? 1 : 0),
        'pitch=' + f3(s && s.pitch), 'roll=' + f3(s && s.roll), 'heave=' + f3(s && s.heave),
        'quat=' + (s && s.quat ? 'Y' : 'N'), '}',
        'render{', 'zAnchor=' + f3(d.zAnchor), 'upBz=' + f3(d.upBz),
        'tiltLift=' + f3(d.tiltLift), 'zTarget=' + f3(d.zTarget), 'smoothZ=' + f3(d.smoothZ),
        'tele=' + (d.teleported ? 1 : 0), 'posZ=' + f3(d.posZ), 'floorZ=' + f3(floorZ), '}',
      );
      n++;
      if (n === cap) console.log('===== RE2003 SPAWN DIAG END (' + cap + ' frames) =====\n');
    }
    return {
      begin, frame,
      set(v) { on = (v === 'dump' ? on : !!v); if (v === 'dump' && car) begin({ note: 'on-demand dump' }); },
    };
  })();
  if (typeof window !== 'undefined') window.re2003Diag = (v) => SpawnDiag.set(v === undefined ? true : v);

  /* ===== WRECK-SETTLE DIAGNOSTIC — "the car settles above the ground". Arm
     with window.re2003Settle(true) (then reproduce, e.g. load a wrecked state);
     it auto-captures the moment the car goes off the wheels / rests and logs
     per frame until it has sat still ~2 s, then disarms. Re-arm for the next
     capture. window.re2003Settle(false) stops it early.

     The two CLEAR numbers are the point of this: `proxy` is the lowest PHYSICS
     bodyPt (what _restLift plants at BODY_GROUND_GAP over the road) rendered
     through the drawn attitude; `visible` is the lowest vertex of the actual
     sheet-metal meshes (world bbox). If proxy ≈ 2 cm but visible floats, the
     hitbox cloud sits below the mesh; if proxy itself floats, the rest height
     (zPos / _restLift) is wrong; if zPos ≈ zRest but smoothZ lags, it's the
     render ease. */
  const SettleDiag = (() => {
    const CAPTURE_MS = 8000;   /* log a flat 8 s of real time from first contact */
    const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let on = false, capturing = false, n = 0, startMs = 0;
    const f3 = (v) => (v == null ? 'null' : (typeof v === 'number' ? v.toFixed(3) : String(v)));
    const qrot = (q, v) => {   /* body→world, q = [w,x,y,z] */
      const w = q[0], x = q[1], y = q[2], z = q[3];
      const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
      return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
    };
    const _v3 = (typeof THREE !== 'undefined') ? new THREE.Vector3() : null;
    const _inv = (typeof THREE !== 'undefined') ? new THREE.Matrix4() : null;
    const _m4 = (typeof THREE !== 'undefined') ? new THREE.Matrix4() : null;
    const gapConst = (Physics && Physics.BODY_GROUND_GAP_M != null) ? Physics.BODY_GROUND_GAP_M : 0.02;
    function begin() {
      capturing = true; n = 0; startMs = nowMs();
      console.log('\n===== RE2003 SETTLE DIAG BEGIN =====');
      console.log('floorZ=', f3(floorZ), 'mod.floorZ=', f3(mod && mod.floorZ),
        'cgHeight=', f3(car && car.p && car.p.cgHeight),
        'bodyPts=', car && car.bodyPts && car.bodyPts.length,
        'BODY_GROUND_GAP=', f3(Physics.BODY_GROUND_GAP_M != null ? Physics.BODY_GROUND_GAP_M : 0.02));
      /* contact-cloud coverage vs the measured mesh dims: cloud maxZ should
         come out ≈ 0.07 + bodyH and maxAbsY ≈ halfW — a squashed or narrow
         cloud is visible here immediately, before any pose settles */
      if (car && car.bodyPts && car.bodyPts.length) {
        let cMaxY = 0, cMaxZ = -Infinity, cMinX = Infinity, cMaxX = -Infinity;
        for (const [px, py, pz] of car.bodyPts) {
          if (Math.abs(py) > cMaxY) cMaxY = Math.abs(py);
          if (pz > cMaxZ) cMaxZ = pz;
          if (px < cMinX) cMinX = px;
          if (px > cMaxX) cMaxX = px;
        }
        const dm = mod && mod.carDims;
        console.log('cloud{', 'meshHull=' + !!(carShape && carShape.isMeshHull),
          'maxAbsY=' + f3(cMaxY), 'maxZ=' + f3(cMaxZ),
          'x=[' + f3(cMinX) + ',' + f3(cMaxX) + ']', '}',
          'dims{', dm ? ('halfW=' + f3(dm.bodyHalfW) + ' bodyH=' + f3(dm.bodyMaxZ - dm.bodyMinZ)
            + ' x=[' + f3(dm.bodyMinX - dm.xMid) + ',' + f3(dm.bodyMaxX - dm.xMid) + ']') : 'none', '}');
      }
    }
    function frame(d) {
      if (!on) return;
      const snap = d.snap;
      if (!capturing && (snap.airborne || snap.restingOnBody)) begin();
      if (!capturing) return;
      const c = car, surf = d.surf;
      const q = snap.quat || d.quat || [1, 0, 0, 0];       /* physics/flight attitude */
      const zSurf = (surf && surf.height) || 0;
      const surfUp = (surf && surf.up) || [0, 0, 1];       /* slope-aware rest plane */
      const restLift = (c && c._restLift) ? c._restLift(q, surfUp) : NaN;
      const zRest = zSurf + restLift;
      const ac = c._airContacts || {};
      const upB = qrot(q, [0, 0, 1]);
      const su = (surf && surf.up) || [0, 0, 1];
      const align = upB[0] * su[0] + upB[1] * su[1] + upB[2] * su[2];
      const angMag = Math.hypot(c.wbx || 0, c.wby || 0, c.wbz || 0);
      /* which CONTACT point the physics is actually resting on (same set as
         _restLift: 4 wheel-corner points at the tyre plane + the body silhouette,
         all in the CG-relative body frame), and its clearance. maxDrop is the
         lowest point through the attitude; physLo = its height over the road
         (converges to BODY_GROUND_GAP). If the wheel corners win here but the
         sheet metal floats, the hitbox has phantom outriggers below the body. */
      const hCG = (c.p && c.p.cgHeight) || 0;
      const hWB = (c.p && c.p.wheelbase) ? c.p.wheelbase / 2 : 1.4;
      const hTW = (c.p && c.p.trackWidth) ? c.p.trackWidth / 2 : 0.85;
      const cpts = [
        { id: 'whlFL', p: [hWB, hTW, -hCG] }, { id: 'whlFR', p: [hWB, -hTW, -hCG] },
        { id: 'whlRL', p: [-hWB, hTW, -hCG] }, { id: 'whlRR', p: [-hWB, -hTW, -hCG] },
      ];
      if (c && c.bodyPts) c.bodyPts.forEach((pt, i) => cpts.push({ id: 'body' + i, p: [pt[0], pt[1], pt[2] - hCG] }));
      let low = cpts[0], maxDrop = -Infinity;
      for (const cp of cpts) { const drop = -qrot(q, cp.p)[2]; if (drop > maxDrop) { maxDrop = drop; low = cp; } }
      const physLo = (c.zPos || 0) - zRest + gapConst;   /* lowest contact pt over road */
      /* lowest bodyPt rendered as the hitbox children actually transform: the
         hitbox group sits at model x = xMid, so a bodyPt draws at model
         [xMid + x, y, floorZ + z] through the render quat + model-origin z */
      const xMidL = (carShape && carShape.xMid) || (mod && mod.carDims && mod.carDims.xMid) || 0;
      let bodyLoMin = Infinity;
      const rq = d.quat || q;
      if (c && c.bodyPts) for (const pt of c.bodyPts) {
        const wz = d.smoothZ + qrot(rq, [xMidL + pt[0], pt[1], pt[2] + floorZ])[2];
        if (wz < bodyLoMin) bodyLoMin = wz;
      }
      /* lowest visible sheet-metal vertex, EXACT in the PHYSICS (trackGroup-
         local) frame: trackGroup applies the Papyrus Z-up→Y-up turn, so three.js
         WORLD z is horizontal. Transform each mesh's OWN geometry box by
         (trackGroup⁻¹ · meshWorld) — a tight box in the physics frame — instead
         of a world AABB (which, rotated, wildly overshoots for a car on its side). */
      /* split by part class — the fix differs: a WHEEL below grade means the
         contact cloud is missing wheel volumes (hull excludes lf/rf/lr/rrwheel
         and the physics wheels are flat patches at the tyre plane); BODY below
         grade means the hull under-covers the real bodywork; DRIVER is not in
         the hull by design. `worst` names the actual offending mesh.
         PER-VERTEX min, not Box3.applyMatrix4: transforming the 8 AABB corners
         of a ROTATED mesh reports the lowest corner of the oriented box, which
         overshoots the real hull DOWNWARD by tens of cm at wreck attitudes —
         that artifact once read "mesh punches 42 cm through the road" on a car
         that was actually floating. Diag-only cost, armed captures only. */
      let visMin = Infinity, visBody = Infinity, visWheel = Infinity, visDrv = Infinity, worst = '';
      if (_v3 && modelGroup && trackGroup) {
        trackGroup.updateWorldMatrix(true, false);
        _inv.copy(trackGroup.matrixWorld).invert();
        modelGroup.updateWorldMatrix(true, true);
        modelGroup.traverse((o) => {
          if (o.isMesh && o.visible && o.userData && o.userData.meshIndex !== undefined && o.geometry) {
            const posA = o.geometry.getAttribute('position');
            if (!posA || !posA.count) return;
            _m4.multiplyMatrices(_inv, o.matrixWorld);
            let z = Infinity;
            for (let vi = 0; vi < posA.count; vi++) {
              _v3.fromBufferAttribute(posA, vi).applyMatrix4(_m4);
              if (_v3.z < z) z = _v3.z;
            }
            if (!Number.isFinite(z)) return;
            const isWheel = !!o.userData.isRoadWheel;
            const isDrv = !isWheel && /driver/i.test(o.name || '');
            if (z < visMin) {
              visMin = z;
              worst = (isWheel ? 'WHEEL:' : isDrv ? 'DRIVER:' : 'BODY:')
                + (o.name || ('#' + o.userData.meshIndex));
            }
            if (isWheel) { if (z < visWheel) visWheel = z; }
            else if (isDrv) { if (z < visDrv) visDrv = z; }
            else if (z < visBody) visBody = z;
          }
        });
      }
      console.log(`f${n}`,
        'phys{', 'zPos=' + f3(c.zPos), 'vz=' + f3(c.vz), 'air=' + (c.airborne ? 1 : 0),
        'rest=' + (c.restingOnBody ? 1 : 0), 'aAct=' + (c._airActive ? 1 : 0), 'spd=' + f3(c.speed),
        'u=' + f3(c.u), 'v=' + f3(c.v), 'r=' + f3(c.r), 'bodyZ=' + f3(c.bodyZ),
        'bPit=' + f3(c.bodyPitch), 'bRol=' + f3(c.bodyRoll), '}',
        'cont{', 'wh=' + (ac.wheels || 0), 'bd=' + (ac.body || 0), 'deep=' + f3(ac.deepestBody),
        'align=' + f3(align), 'angMag=' + f3(angMag), '}',
        'rest{', 'zSurf=' + f3(zSurf), 'restLift=' + f3(restLift), 'zRest=' + f3(zRest),
        'gap=' + f3((c.zPos || 0) - zSurf), 'dRest=' + f3((c.zPos || 0) - zRest), '}',
        'rend{', 'smoothZ=' + f3(d.smoothZ), 'floorZ=' + f3(floorZ), 'upBz=' + f3(upB[2]),
        'tele=' + (d.teleported ? 1 : 0), '}',
        'CLEAR{', 'physLo=' + f3(physLo), 'bodyLo=' + f3(bodyLoMin - zSurf),
        'visLo=' + f3(visMin - zSurf), 'visBody=' + f3(visBody - zSurf),
        'visWheel=' + f3(visWheel - zSurf), 'visDrv=' + f3(visDrv - zSurf),
        'worst=' + worst,
        'restingOn=' + low.id + '@[' + low.p.map((v) => v.toFixed(2)).join(',') + ']', '}');
      n++;
      if (nowMs() - startMs >= CAPTURE_MS) {
        const pen = visMin - zSurf;
        let call;
        if (pen - physLo > 0.05) call = 'MESH FLOATS ABOVE CONTACT SHAPE';
        else if (pen < -0.05) {
          call = worst.startsWith('WHEEL:')
            ? 'LOWEST=WHEEL - wheel volumes missing from the contact cloud'
            : worst.startsWith('DRIVER:')
              ? 'LOWEST=DRIVER - driver mesh not in the hull (by design)'
              : 'LOWEST=BODY - hull under-covers the real bodywork';
        } else call = 'mesh ~ on contact shape';
        console.log(`===== RE2003 SETTLE DIAG END (${n} frames / ${((nowMs() - startMs) / 1000).toFixed(1)}s · VERDICT physLo=${f3(physLo)}m visLo=${f3(pen)}m body=${f3(visBody - zSurf)} wheel=${f3(visWheel - zSurf)} drv=${f3(visDrv - zSurf)} worst=${worst} restingOn=${low.id} → ${call}) =====\n`);
        capturing = false; on = false;
      }
    }
    return { frame, set(v) { on = !!v; if (!v) capturing = false; } };
  })();
  if (typeof window !== 'undefined') window.re2003Settle = (v) => SettleDiag.set(v === undefined ? true : v);

  /* resting on roof/side must never blend toward grounded tyre-plane compose —
     contactFade > 0 floated the mesh above the track while physics sat on bodyPts */
  function effectiveContactFade(snap) {
    /* airborne + body-rest always use flight/body quat + zPos anchor — never
       blend contactFade toward surf.height (wheel-touch during a tumble sets
       cf≈0.35 while still airborne → cars hovered over the track). */
    if (snap.airborne || snap.restingOnBody) return 0;
    return snap.contactFade == null ? 1 : snap.contactFade;
  }

  function resolvePoseQuat(snap, groundedQuat, st) {
    const offWheels = snap.airborne || snap.restingOnBody;
    const cf = effectiveContactFade(snap);
    const live = snap.poseQuat || snap.quat;
    if (live) st.poseQuatHold = live;
    if (!snap.airborne && !snap.restingOnBody && cf >= 0.999) st.poseQuatHold = null;
    if (!snap.airborne && !snap.restingOnBody && st.poseQuatHold) {
      const h = st.poseQuatHold, g = groundedQuat;
      const qDot = h[0] * g[0] + h[1] * g[1] + h[2] * g[2] + h[3] * g[3];
      if (qDot < 0) {
        st.poseQuatHold = null;
        return groundedQuat;
      }
    }
    if (cf < 1 && st.poseQuatHold) return st.poseQuatHold;
    /* physics flagged airborne before poseQuat landed in the snapshot — keep
       the last drawn attitude instead of snapping to a fresh grounded compose */
    if (offWheels && !live && st.renderQuat) return st.renderQuat;
    return live || groundedQuat;
  }

  function quatSmoothAlpha(qJump, dt, teleported) {
    if (teleported) return 1;
    if (qJump < 0.015) return 1;
    const tau = qJump > 0.55 ? 0.075 : qJump > 0.28 ? 0.048 : qJump > 0.12 ? 0.03 : POSE_SMOOTH_TAU_S;
    return 1 - Math.exp(-(dt || 0.016) / tau);
  }

  /* Shared render compose for player + field cars — ONE path for every regime.
     contactFade crossfades grounded surface composition ↔ flight quaternion. */
  const POSE_Z_TAU_S = 0.014;   /* display-rate vertical follow — de-stairs 60 Hz heave
                                     without the 80 ms lag that read as tyres magneting down on stop */
  function computeSmoothCarPose(snap, surf, dt, st, { xMid, floorZ, bodyPts, directRender }) {
    const pitch = snap.pitch || 0, roll = snap.roll || 0;
    const cf = effectiveContactFade(snap);
    const teleported = st.smoothZ === null;
    const poseDirect = !!directRender;
    /* directRender: x/y/quat already interpolated at display rate — skip a second
       lag pass on those (it beat against 60 Hz physics at 120+ Hz). Z and banking-up
       still get a SHORT display filter so suspension heave doesn't stair-step. */
    const regimeTight = snap.airborne || snap.restingOnBody || cf < 0.90;
    const renderTightXY = poseDirect || regimeTight;
    const renderTightZ = regimeTight;
    const alpha = teleported ? 1 : 1 - Math.exp(-(dt || 0.016) / POSE_SMOOTH_TAU_S);
    const zTau = poseDirect ? POSE_Z_TAU_S : POSE_SMOOTH_TAU_S;
    const alphaZ = teleported ? 1 : 1 - Math.exp(-(dt || 0.016) / zTau);
    const upTau = poseDirect ? 0.016 : POSE_SMOOTH_TAU_S;
    const alphaUp = teleported ? 1 : 1 - Math.exp(-(dt || 0.016) / upTau);

    _up.set(surf.up[0], surf.up[1], surf.up[2]);
    if (teleported || regimeTight) st.upSm.copy(_up);
    else st.upSm.lerp(_up, alphaUp).normalize();

    const groundedQuat = Physics.composeRenderQuat([st.upSm.x, st.upSm.y, st.upSm.z], snap.yaw, pitch, roll);
    const poseQ = resolvePoseQuat(snap, groundedQuat, st);
    const quat = Physics.qSlerp(poseQ, groundedQuat, cf);

    /* Grounded: anchor to physics zPos (snap.z), NOT a fresh surf.height sample —
       those diverge by a frame and the render chases the road down on every stop
       (the magnetic tyre snap). Light-contact / air still blend toward surf. */
    const zAir = snap.z || 0;
    const zGround = snap.restingOnBody ? zAir
      : snap.onSurface ? zAir : Math.max(zAir, surf.height);
    const tiltLift = cf * Physics.bodyAttitudeExtraLift(pitch, roll, bodyPts);
    const aOffPose = Physics.renderAnchorOffset(poseQ, xMid, floorZ);
    const upBzBody = Physics.quatUpZ(poseQ);
    const zGroundTarget = Physics.renderOriginZ(zGround, floorZ, upBzBody)
      + cf * ((snap.heave || 0) + tiltLift);
    const zAirTarget = zAir - aOffPose[2];
    const zTarget = zAirTarget + (zGroundTarget - zAirTarget) * cf;

    st.smoothZ = (teleported || renderTightZ) ? zTarget : st.smoothZ + (zTarget - st.smoothZ) * alphaZ;

    const aOff = Physics.renderAnchorOffset(quat, xMid, floorZ);
    const rx = snap.x - aOff[0], ry = snap.y - aOff[1];
    if (teleported || renderTightXY || st.smoothX === null) {
      st.smoothX = rx; st.smoothY = ry; st.renderQuat = quat.slice();
    } else {
      const jxy = Math.hypot(rx - st.smoothX, ry - st.smoothY);
      const xyA = jxy > 0.05 ? 1 : alpha;
      st.smoothX += (rx - st.smoothX) * xyA;
      st.smoothY += (ry - st.smoothY) * xyA;
      const dot = Math.abs(quat[0] * st.renderQuat[0] + quat[1] * st.renderQuat[1]
        + quat[2] * st.renderQuat[2] + quat[3] * st.renderQuat[3]);
      const qJump = 2 * Math.acos(Math.min(1, dot));
      st.renderQuat = Physics.qSlerp(st.renderQuat, quat, quatSmoothAlpha(qJump, dt, false));
    }
    return {
      x: st.smoothX, y: st.smoothY, z: st.smoothZ, quat: st.renderQuat,
      zTarget, teleported, upBz: st.upSm.z, tiltLift, zAir, zGround, cf,
    };
  }

  function placeCar(snap, surf, dt) {
    updateHitboxOverlay();
    const xMid = carShape ? (carShape.xMid || 0) : 0;
    const pose = computeSmoothCarPose(snap, surf, dt, _playerRender,
      { xMid, floorZ, bodyPts: car && car.bodyPts, directRender: true });
    modelGroup.quaternion.set(pose.quat[1], pose.quat[2], pose.quat[3], pose.quat[0]);
    modelGroup.position.set(pose.x, pose.y, pose.z);
    SpawnDiag.frame({ snap, surf, zAnchor: pose.zAir + (pose.zGround - pose.zAir) * pose.cf,
      upBz: pose.upBz, tiltLift: pose.tiltLift, zTarget: pose.zTarget,
      smoothZ: pose.z, teleported: pose.teleported, posZ: pose.z });
    SettleDiag.frame({ snap, surf, smoothZ: pose.z, quat: pose.quat, teleported: pose.teleported });
  }

  /* ---- neon hitbox overlay: the PHYSICS contact shape on the player car.
     Child of modelGroup in body coords (x fwd, y left, z up; tyre plane at
     local z = floorZ) so it inherits position + full flight attitude.
     Shows: body contact silhouette (BODY_CONTACT_PTS), the 4 wheel contact
     points, and the 2-D wall OBB. Toggled from the Debug checkbox. */
  const HITBOX_LS_KEY = 're2003.showHitbox';
  let hitboxGroup = null;
  let showHitbox = false;
  try { showHitbox = localStorage.getItem(HITBOX_LS_KEY) === '1'; } catch (e) {}

  /* per-model physics body shape, measured from the loaded meshes
     (mod.carDims). The canonical Cup silhouette is scaled to THIS car's
     overhangs/width/roof and shifted to its mid-wheelbase — the physics
     contacts and the hitbox then sit exactly on the visible bodywork. */
  let carShape = null;
  function physBodyPtsFromDims(d) {
    const base = Physics.BODY_CONTACT_PTS;
    const sane = (v) => Number.isFinite(v) ? Math.min(1.6, Math.max(0.6, v)) : 1;
    const noseScale = sane((d.bodyMaxX - d.xMid) / 2.65);
    const tailScale = sane((d.xMid - d.bodyMinX) / 2.60);
    const yScale = sane(d.bodyHalfW / 0.92);
    /* stance puts the body floor at RIDE_SPLITTER_M over the tyre plane */
    const roofPhys = RIDE_SPLITTER_M + (d.bodyMaxZ - d.bodyMinZ);
    const zScale = sane((roofPhys - RIDE_SPLITTER_M) / (1.32 - 0.07));
    return base.map(([x, y, z]) => [
      x * (x >= 0 ? noseScale : tailScale),
      y * yScale,
      RIDE_SPLITTER_M + (z - 0.07) * zScale,
    ]);
  }
  function refreshCarShape() {
    carShape = null;
    const d = mod && mod.carDims;
    if (d) {
      /* prefer the mesh support cloud ("what you see is what you hit");
         the dims-scaled silhouette stays as the fallback for models whose
         hull extraction came up short */
      const hull = mod.carHullPts && mod.carHullPts.length >= 8 ? mod.carHullPts : null;
      carShape = {
        pts: hull || physBodyPtsFromDims(d),
        isMeshHull: !!hull,
        halfLenF: d.bodyMaxX - d.xMid,
        halfLenR: d.xMid - d.bodyMinX,
        halfWidth: d.bodyHalfW,
        xMid: d.xMid,
      };
    }
    if (car) car.setBodyShape(carShape ? carShape.pts : null);
    /* per-car aero: scale the calibrated Cup panel model to THIS body's
       measured length/width/height (a truck exposes more flank and roof) */
    if (car) {
      car.setAeroShape(d ? {
        sx: (d.bodyMaxX - d.bodyMinX) / (2.65 + 2.60),
        sy: d.bodyHalfW / 0.95,
        sz: (d.bodyMaxZ - d.bodyMinZ) / (1.32 - 0.07),
      } : null);
    }
    /* skid + dirt marks as wide as THIS mod's actual tyre (measured tread span);
       null falls TireFX back to its default half-width */
    if (typeof TireFX !== 'undefined') {
      TireFX.setTireWidth(mod && Number.isFinite(mod.tireWidthM) ? mod.tireWidthM : null);
    }
    if (hitboxGroup) {              /* rebuild the overlay with the new shape */
      if (hitboxGroup.parent) hitboxGroup.parent.remove(hitboxGroup);
      hitboxGroup = null;
    }
    updateHitboxOverlay();          /* re-attach in showroom too (no placeCar) */
  }
  function buildHitboxGroup() {
    const g = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({
      color: 0x39ff14, depthTest: false, transparent: true, opacity: 0.95,
    });
    const P = (carShape && carShape.pts) || Physics.BODY_CONTACT_PTS;
    /* the ACTUAL collision cloud — every point the physics can touch the
       road or a wall with, drawn as small 3-axis crosses hugging the real
       bodywork (mesh support points, or the 14-pt silhouette fallback) */
    const verts = [];
    const D = 0.07;
    for (const [px, py, pz] of P) {
      verts.push(px - D, py, pz, px + D, py, pz);
      verts.push(px, py - D, pz, px, py + D, pz);
      verts.push(px, py, pz - D, px, py, pz + D);
    }
    /* wheel contact points: crosses + a vertical tick on the tyre plane */
    const hwb = Physics.PARAMS.wheelbase / 2, htw = Physics.PARAMS.trackWidth / 2;
    const C = 0.15;
    for (const [fx, ly] of [[hwb, htw], [hwb, -htw], [-hwb, htw], [-hwb, -htw]]) {
      verts.push(fx - C, ly, 0, fx + C, ly, 0);
      verts.push(fx, ly - C, 0, fx, ly + C, 0);
      verts.push(fx, ly, 0, fx, ly, C * 1.6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    const lines = new THREE.LineSegments(geo, mat);
    lines.renderOrder = 999;
    g.add(lines);
    return g;
  }
  /* wall hitboxes: the collidable wall FACES near the car (what wallCollide
     actually tests — track-side face line, base to top), neon red so a wall
     the game considers non-collidable is visibly unlit. Rolling ±3-segment
     window, rebuilt when the car crosses into a new segment. Heights come
     from TrackSurface.heightAt (pure) — sampleSurface would re-lock the
     car's segment tracking onto the wall points. */
  let wallHbGroup = null;
  let wallHbSeg = -1;
  const WALL_HB_WINDOW = 3;
  function clearWallHitbox() {
    if (wallHbGroup) {
      if (wallHbGroup.parent) wallHbGroup.parent.remove(wallHbGroup);
      if (wallHbGroup.geometry) wallHbGroup.geometry.dispose();
      wallHbGroup = null;
    }
    wallHbSeg = -1;
  }
  function rebuildWallHitbox(segIdx) {
    clearWallHitbox();
    const segs = track && track.surface && track.surface.segments;
    if (!segs || !segs.length || !trackGroup) return;
    const N = segs.length;
    const verts = [];
    for (let dk = -WALL_HB_WINDOW; dk <= WALL_HB_WINDOW; dk++) {
      const k = (((segIdx + dk) % N) + N) % N;
      const seg = segs[k];
      if (!seg || !seg.walls || !seg.walls.length) continue;
      for (const w of seg.walls) {
        const top = Math.max(w.h0 || 0, w.h1 || 0);
        if (top <= 0.01) continue;
        const S = 4;
        let prev = null;
        for (let i = 0; i <= S; i++) {
          const u = i / S;
          const { trackFace } = Physics.wallTrackFaces(w, u);
          if (!Physics.isWallCollidable(w, u, trackFace)) { prev = null; continue; }
          const c = TrackSurface.sampleCenter(seg, u);
          const x = c.x + trackFace * -c.ty;
          const y = c.y + trackFace * c.tx;
          const z0 = TrackSurface.heightAt(seg, trackFace, trackFace, u);
          if (!Number.isFinite(x + y + z0)) { prev = null; continue; }
          verts.push(x, y, z0, x, y, z0 + top);          /* vertical tick */
          if (prev) {
            verts.push(prev[0], prev[1], prev[2], x, y, z0);
            verts.push(prev[0], prev[1], prev[2] + prev[3], x, y, z0 + top);
          }
          prev = [x, y, z0, top];
        }
      }
    }
    if (!verts.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xff2d55, depthTest: false, transparent: true, opacity: 0.9,
    });
    wallHbGroup = new THREE.LineSegments(geo, mat);
    wallHbGroup.renderOrder = 998;
    trackGroup.add(wallHbGroup);
    wallHbSeg = segIdx;
  }

  function updateHitboxOverlay() {
    if (!showHitbox) {
      if (hitboxGroup && hitboxGroup.parent) hitboxGroup.parent.remove(hitboxGroup);
      clearWallHitbox();
      return;
    }
    if (!modelGroup) return;
    if (!hitboxGroup) hitboxGroup = buildHitboxGroup();
    if (hitboxGroup.parent !== modelGroup) modelGroup.add(hitboxGroup);
    /* anchor: this model's mid-wheelbase + tyre plane. mod.floorZ directly —
       the drive-scoped floorZ copy is 0 until driving starts, which hung the
       showroom overlay at the model origin */
    const fz = (mod && typeof mod.floorZ === 'number') ? mod.floorZ : floorZ;
    hitboxGroup.position.set(carShape ? carShape.xMid : 0, 0, fz);
    /* nearby wall faces while on a track */
    if (track && track.surface && track.surface.segments
        && track.surface.segments.length && trackGroup && progress) {
      if (wallHbSeg !== progress.seg || !wallHbGroup) rebuildWallHitbox(progress.seg);
    } else {
      clearWallHitbox();
    }
  }
  {
    const hb = document.getElementById('vp-show-hitbox');
    if (hb) {
      hb.checked = showHitbox;
      hb.addEventListener('change', () => {
        showHitbox = hb.checked;
        try { localStorage.setItem(HITBOX_LS_KEY, showHitbox ? '1' : '0'); } catch (e) {}
        updateHitboxOverlay();
      });
    }
  }

  const _p0 = new THREE.Vector3(), _p1 = new THREE.Vector3(), _cu = new THREE.Vector3();

  function hud(snap) {
    const el = $('viewer-cam');
    if (!el) return;
    const gearLabel = snap.gear === 0 ? 'R' : String(snap.gear);
    const s = `${Math.round(snap.speedMph)} mph · gear ${gearLabel} · ${Math.round(snap.rpm)} rpm`
      + ((snap.damage || 0) > 0.005 ? ` · dmg ${Math.round(snap.damage * 100)}%` : '');
    if (s !== el.textContent) el.textContent = s;   /* only touch the DOM on change */
  }

  /* ---- fixed-timestep sim + render interpolation --------------------------
     The sim MUST advance in uniform 1/60 slices no matter how fast the display
     draws. Stepping by the raw frame dt fed a heavy view (far camera, more
     scenery ⇒ longer, jittery frames) straight into the physics, so a fast
     tumble rotated by uneven amounts per drawn frame and read as frame-skip
     ("renders different based on distance"). Instead: accumulate real elapsed
     time, step the sim in whole FIXED_DT slices, and render the pose
     INTERPOLATED between the two latest sim states — motion is then uniform at
     any framerate or refresh (60/120/144 Hz). car.step already substeps
     internally for integrator stability; this only fixes the DISPLAY cadence. */
  const FIXED_DT = 1 / 60;
  /* catch-up cap. Kept LOW because each substep re-runs the whole 40-car field
     physics — the [perf] data showed a heavy render frame pushing over budget,
     which schedules 2-3 catch-up steps that each re-run the field, compounding a
     mild spike into a 24 fps crater (the death-spiral). 2 bounds that burst (a
     brief slow-mo reads smoother than a freeze) while still absorbing a normal
     hitch; past it we shed the backlog. The real cure is cutting the render cost
     so frames stay under budget and this never triggers. */
  const MAX_SUBSTEPS = 2;
  let _simAccum = 0;
  let _simPrev = null, _simCur = null;   /* { snap, surf } — the two states we blend */

  function simStepOnce() {
    let surf = sampleSurface(car.x, car.y);
    preStepX = car.x; preStepY = car.y;
    car.step(FIXED_DT, buildInput(FIXED_DT), surf);
    surf = sampleSurface(car.x, car.y);        /* surface at the new position */
    surf = resolveWalls(surf);                 /* iterative — no body merge into walls */
    /* field cars advance + collide (incl. the player) in the SAME substep, so
       the player's snapshot below already carries any car↔car shove — no
       one-frame reaction lag. Module `car` is the player again on return. The
       player's post-step surf feeds the AI sense pass its lateral position. */
    stepFieldCars(surf);
    return { snap: car.snapshot(), surf };
  }
  /* forget the blend history so the next frame renders a fresh pose HARD — no
     interpolation across a respawn/teleport */
  function resetSimInterp() { _simAccum = 0; _simPrev = _simCur = null; resetRenderSmooth(_playerRender); }

  /* pose fed to placeCar/updateWheels: the sim state at fractional time t
     between the previous and current fixed step. Only blend WITHIN one motion
     regime — across an airborne/grounded/rest transition the fields change
     meaning, and a teleport-scale jump must not smear, so snap to current. */

  function interpContactFade(a, b, t) {
    const cfa = a.contactFade == null ? 1 : a.contactFade;
    const cfb = b.contactFade == null ? 1 : b.contactFade;
    if (a.airborne || b.airborne || a.restingOnBody || b.restingOnBody) return 0;
    return cfa + (cfb - cfa) * t;
  }

  function interpRenderState(prev, cur, t) {
    const a = prev.snap, b = cur.snap;
    /* Blend across EVERY regime — the ground↔air handoff must NOT hard-snap
       (that froze/lurched the car ~1 m the frame it crossed the line, the
       visible takeoff/landing "snap"). The body carries a CONTINUOUS world
       quaternion (poseQuat) grounded and airborne alike, so attitude slerps
       through; contactFade interpolates so placeCar's grounded↔air crossfade
       weight is smooth at display rate. Only a teleport-scale jump still snaps
       hard to current (respawn/state-load must not smear). pitch/roll change
       MEANING across the flip, but they only drive the composition at cf≈1
       (both-grounded) — during the handoff cf→0 weights them out, so their
       lerp is masked. */
    if (t >= 1 || prev === cur) {
      return b;
    }
    const lerp = (p, q) => p + (q - p) * t;
    return {
      ...b,
      x: lerp(a.x, b.x), y: lerp(a.y, b.y), z: lerp(a.z, b.z),
      yaw: Physics.lerpAngle(a.yaw, b.yaw, t),
      pitch: lerp(a.pitch, b.pitch), roll: lerp(a.roll, b.roll),
      heave: lerp(a.heave || 0, b.heave || 0),
      steer: lerp(a.steer || 0, b.steer || 0),
      contactFade: interpContactFade(a, b, t),
      flapDeploy: lerp(a.flapDeploy ?? (a.flapsDeployed ? 1 : 0), b.flapDeploy ?? (b.flapsDeployed ? 1 : 0)),
      airborne: a.airborne || b.airborne,
      restingOnBody: a.restingOnBody || b.restingOnBody,
      quat: (a.quat && b.quat) ? Physics.qSlerp(a.quat, b.quat, t) : b.quat,
      poseQuat: (a.poseQuat && b.poseQuat) ? Physics.qSlerp(a.poseQuat, b.poseQuat, t)
        : (b.poseQuat || a.poseQuat),
    };
  }

  /* roof-flap visual: track the physics deploy state (the same emergent
     reversed-flow law the exe uses). Pops open fast, buffets while open,
     settles shut — the buffet reads as the flutter real flaps have. */
  let flapAnim = 0, flapClock = 0;
  function tickFlaps(snap, dt) {
    flapClock += dt;
    const target = snap.flapDeploy != null ? snap.flapDeploy : (snap.flapsDeployed ? 1 : 0);
    const alpha = 1 - Math.exp(-(dt || 0.016) / 0.01);
    flapAnim += (target - flapAnim) * alpha;
    let s = flapAnim;
    if ((snap.speed || 0) > 12 && target > 0.5 && snap.flapsDeployed) {
      s *= 0.88 + 0.12 * Math.abs(Math.sin(flapClock * 23) * Math.sin(flapClock * 7.3));
    }
    applyFlapState(s);
  }

  function update(dt) {
    if (!active || !car || !modelGroup) return;
    if (!_simCur) _simPrev = _simCur = { snap: car.snapshot(), surf: sampleSurface(car.x, car.y) };
    _simAccum += Math.min(dt || 0, 0.25);      /* clamp a hitch: never spin the sim for seconds */
    let steps = 0;
    while (_simAccum >= FIXED_DT && steps < MAX_SUBSTEPS) {
      _simPrev = _simCur;
      _simCur = simStepOnce();
      _simAccum -= FIXED_DT;
      steps++;
    }
    /* past the cap: keep fractional remainder so display interp stays continuous
       (zeroing the backlog skipped sim time and strobed motion at high FPS) */
    if (_simAccum >= FIXED_DT) _simAccum %= FIXED_DT;
    if (PERF.on) { PERF.substeps += steps; let _c = 0; for (const f of fieldCars) if (f.awake) _c++; PERF.cars = _c; }
    /* THE gamepad-button freeze: a respawn fired from a pad button runs INSIDE
       this frame (buildInput → respawn → resetSimInterp) and nulls the interp
       history mid-substep. interpRenderState then dereferenced a null _simPrev
       and threw, killing the loop for good. Heal it: re-seed a missing current
       state, and snap _simPrev to it (no interp across the teleport anyway). */
    if (!_simCur) _simCur = { snap: car.snapshot(), surf: sampleSurface(car.x, car.y) };
    if (!_simPrev) _simPrev = _simCur;
    const tBlend = clamp(_simAccum / FIXED_DT, 0, 1);
    renderFieldCars(tBlend, dt || 0.016);       /* interpolated every frame → no 60 Hz blur */
    const snap = interpRenderState(_simPrev, _simCur, tBlend);
    /* render-side surface: blend height + banking normal between the two sim
       samples so the body's vertical anchor and tilt GLIDE with the
       interpolated pose. The raw current-step surf stepped in FIXED_DT
       quanta — on a 120 Hz display every other frame froze vertically while
       x/y glided (the choppy, jiggling render). */
    let surf = _simCur.surf;
    if (snap !== _simCur.snap && _simPrev && _simPrev.surf !== _simCur.surf) {
      const pa = _simPrev.surf, pb = _simCur.surf;
      const ux = pa.up[0] + (pb.up[0] - pa.up[0]) * tBlend;
      const uy = pa.up[1] + (pb.up[1] - pa.up[1]) * tBlend;
      const uz = pa.up[2] + (pb.up[2] - pa.up[2]) * tBlend;
      const n = Math.hypot(ux, uy, uz) || 1;
      surf = { ...pb, height: pa.height + (pb.height - pa.height) * tBlend,
        up: [ux / n, uy / n, uz / n] };
    }
    placeCar(snap, surf, dt || 0.016);
    updateWheels(snap, dt || 0.016);
    tickFlaps(_simCur.snap, dt || 0.016);   /* roof flaps deploy ON the mesh */
    /* tire marks + smoke: lazy (re)attach survives track rebuilds; slip/fz
       ride the interpolated snap (spread from the current sim state) */
    if (typeof TireFX !== 'undefined' && trackGroup) {
      if (TireFX.group !== trackGroup) TireFX.attach(trackGroup);
      TireFX.emit(snap, surf, dt || 0.016);
      if (active && TireFX.emitRubSim) TireFX.emitRubSim(snap, surf, dt || 0.016);
    }
    if (carFollow) tickCarCamera(dt || 0.016, snap);
    else if (tickTrackCamera(dt || 0.016)) { /* TV camera aimed at the focused car */ }
    else controls.update();                    /* normal cameras keep orbiting */
    /* spectating an AI → show THAT car's speed/gear/rpm, not the player's */
    hud((focusCar && focusCar.snapCur) ? focusCar.snapCur : _simCur.snap);
    if (race) updateRace();                     /* laps, running order, checker */
  }

  /* "Test blowover" button: fling the live car into a high-speed backwards spin
     so its reversed-flow aero lifts and flips it (drive first). */
  function triggerBlowover() {
    if (!active || !car) return false;
    car.triggerBlowover(85);
    log('Test blowover - car spun backwards at ~190 mph; watch the reversed-flow lift take it over ' +
        '(roof flaps or a low blowover-onset slider change the result).');
    return true;
  }

  function flipToRoof() {
    if (!active || !car) return false;
    const surf = sampleSurface(car.x, car.y);
    if (!surf || surf.offSurface) {
      log('Flip to roof — need track surface under the car (drive on the track first).');
      return false;
    }
    car.putOnRoof(surf);
    resetSimInterp();
    log('Flip to roof — car placed upside-down here. Roof flaps should be fully open.');
    return true;
  }

  /* ============================ FIELD CARS ============================
     Every pit-stall car is a full Physics.Car running the SAME solver the
     player does — same surface follower, same wall constraints, same rigid
     body. Each sleeps frozen at its parked pose until something touches it
     (the player, or another car already in motion), then it wakes, steps,
     grinds walls and tumbles exactly like the hero car, and settles back to
     sleep when it comes to rest. Car↔car contact is Physics.collideCars (SAT
     + a symmetric, momentum-conserving impulse pair). Cost stays low: only
     awake cars step, and a coarse distance gate keeps the pairwise test off
     the hot path. */
  const FIELD_INPUT = { throttle: 0, brake: 0, steer: 0, reverse: false, lockUp: false };
  const FIELD_SLEEP_SPD = 0.35;    /* m/s: below this (and level) it can nod off */
  const FIELD_SLEEP_ANG = 0.25;    /* rad/s yaw */
  const FIELD_SLEEP_TIME = 1.2;    /* s at rest before it freezes */
  const FIELD_WAKE_R2 = 9 * 9;     /* m² broad-phase gate before the SAT test */

  /* ---- AI racing (oval grooves, modern & lightweight) --------------------
     Each racer is a normal Physics.Car driven by a controller that chases a
     lookahead point on the track centreline offset to its LANE (→ multi-lane),
     with a corner-aware target speed. SAME solver as the player, so you race
     among them and can wreck them. Kept cheap: capped count, and the 8-iter
     wall solve is skipped for cars sitting safely mid-track. */
  const AI_RACE_CAP = 20;          /* max simultaneous racers (rest park in the pits) */
  /* Tunable params are `let` (not const) so the live sliders (AI_PARAMS registry
     below) can mutate them mid-race — the controller reads the bare names each
     tick, so a drag takes effect immediately. Clamp bounds + caps stay const. */
  let AI_LAT_G = 1.35;             /* BASE lateral grip (× g) at low speed — kept modest so
                                     slow corners are drivable (a flat constant here was the
                                     bug: raise it and they spin slow corners, lower it and
                                     they panic-brake fast ones). Real grip is speed-dependent
                                     via downforce, added below. */
  let AI_DOWNFORCE_G = 0.9;        /* extra grip (× g) DOWNFORCE gives at the reference speed —
                                     the car's aero really does this, so trusting it means the
                                     AI carry fast banked corners without spinning slow ones */
  let AI_DF_REF = 68;              /* m/s (~152 mph) at which downforce adds the full AI_DOWNFORCE_G */
  let AI_TOP_MPS = 94;             /* pace ceiling (~210 mph) */
  let AI_LOOKAHEAD_S = 1.12;       /* pure-pursuit lookahead time — longer = smoother arc */
  const AI_LOOKAHEAD_MIN = 18, AI_LOOKAHEAD_MAX = 54;   /* m clamp */
  let AI_SPEED_SCAN_S = 2.6;       /* corner-speed lookahead time */
  const AI_SPEED_SCAN_MIN = 24, AI_SPEED_SCAN_MAX = 150;  /* m clamp */
  let AI_LANE_SPACING = 3.3;       /* m between adjacent grooves */
  let AI_WALL_MARGIN = 2.6;        /* keep the racing line this far off the wall */
  const AI_SPAWN_MPS = 26;         /* rolling-start speed so a race is underway at once */
  let AI_LANE_RATE = 0.68;         /* m/s lateral ease — smooth lane changes, not rails */
  let AI_YAW_K1 = 0.48;            /* heading-error stiffness — lower = less weave/dart */
  let AI_YAW_K2 = 0.60;            /* yaw-rate damping = free counter-steer (0.2-0.6) */
  let AI_STEER_FF = 0.44;          /* curvature feed-forward scalar (0 disables) */
  let AI_BANK_HOLD = 0.06;         /* rad up-bank steer per (m/s²) of down-slope pull */
  let AI_BANK_HOLD_FADE_MPS = 30;  /* speed by which the hold fades out (worst at low speed) */
  /* LONGITUDINAL / PREDICTIVE BRAKE — higher A_DECEL = shorter planned braking
     zone = brakes LATER (8 was far too timid; planned ~240 m zones). */
  let A_DECEL = 16.5;              /* m/s² the AI plans its braking against */
  let BRAKE_MARGIN = 0.6;          /* m slack before it commits the brake */
  let AI_THR_GAIN = 0.18;
  let AI_BRAKE_SLEW = 1.8;         /* max brake pedal change per second */
  let AI_VTARGET_TAU = 0.28;       /* s EMA on target speed — no vTarget cliffs */
  let AI_CORNER_BRAKE_MAX = 0.28;  /* NR never stands on the brakes mid-pack */
  /* SLIDE RECOVERY */
  let AI_SLIP_LIFT = 0.28;         /* rad slip angle above which the AI lifts */
  let AI_SPIN_R = 1.6;             /* rad/s yaw rate above which the AI lifts */
  let RECOVER_SPD = 5;             /* m/s — only low-speed spin recovery, not pack slides */
  let REC_SETTLE_LAT = 11;         /* m/s — pack lateral motion is normal; only true spins settle */
  let REC_SETTLE_YAW = 0.8;        /* rad/s |c.r| below which the rotation has settled */
  let REC_ALIGN_OK = 0.55;         /* rad heading-err within which we may rejoin (~ClearToRejoin align) */
  let REC_REJOIN_OFF = 1.2;        /* rad heading-err above which we must reorient before rejoining */
  let REC_STUCK_SPD = 3;           /* m/s below which we accrue "no progress" stuck time */
  let REC_STUCK_MAX = 4.0;         /* s stuck with no progress → tow/reset (NR stuck-counter/timer) */
  let REC_TOW_CLEARB = 30;         /* m of clear track behind required before a tow/rejoin */
  let REC_WALL_KEEP = 2.2;         /* m to keep off a wall while maneuvering */
  let REC_LOCK_STOP_SPD = 2.5;     /* m/s — a spun car LOCKS its brakes down to this speed before it
                                      tries to turn around, so it scrubs to a halt fast instead of
                                      creeping (often backwards) and swerving while it reorients */
  let AI_LAT_BAND = 4.0;           /* m max |dLat| to consider a car "beside" */
  let AI_MIN_SIDE_CLEAR = 0.55;    /* m min EDGE gap between body sides when alongside (raised: cars were door-locked too tight) */
  let AI_SIDE_WARN = 0.62;         /* m edge — spotter eases before door-lock */
  let AI_SLOT_ARC = 22;            /* m along-track window for groove occupancy counts */
  let AI_ELITE_CLEAR = 3.9;        /* m gap required before a lane change (look-before-merge) */
  let AI_LOOK_CLEAR_S = 0.62;      /* s path must stay clear before committing a lane move */
  let AI_SIDE_LOCK_S = 0.22;       /* s before peel when edge-locked alongside */
  let AI_LOOK_AHEAD_ARC = 12;      /* m merge-conflict window only (not whole-lane block) */
  let AI_MICRO_GAP = 0.55;         /* m edge — door-rub band */
  const AI_CONTACT_HARD = 0.08;      /* m edge — bodies touching / rubbing */
  let AI_OVERLAP_HALF = 3.0;       /* m fore/aft half-length for "overlapping" */
  let AI_SEP_GAIN = 2.0;           /* push-apart on groove target when edge gap violated */
  let AI_SEP_MARGIN = 0.34;        /* m extra edge buffer beyond min side gap (raised with min-clear) */
  let AI_LAT_FORCE_K = 0.00015;
  let AI_EDGE_REP_SOFT = 0.034;    /* soft wall repulsion inside margin */
  let AI_EDGE_REP_HARD = 0.085;    /* hard push off the wall past margin */
  let AI_CAR_REP_K = 0.020;       /* per-metre EDGE deficit → steer off door contact */
  let AI_GROOVE_SMOOTH_TAU = 1.05; /* s EMA on groove lateral — momentum line */
  let AI_PASS_LATCH_S = 0.42;      /* s between passing FSM evaluations */
  const AI_CROSS_DEADBAND = 0.58;  /* m — no cross-track steer inside this band */
  let AI_LANE_JERK = 1.8;          /* m/s² lateral jerk cap — smooth elite merges, no snap */
  const AI_GROOVE_DEADBAND = 0.48; /* m soft hold zone — taper, never a hard rail lock */
  let AI_SPOT_AHEAD_S = 1.8;       /* s ahead scan horizon */
  let AI_SPOT_AHEAD_MIN = 50;      /* m ahead horizon floor */
  let AI_SPOT_BEHIND_M = 45;       /* m behind cutoff */
  let AI_LIFT_WINDOW = 7;         /* m gentle follow trim window (NR uses target-speed, not panic brake) — smaller = they hold throttle
                                     longer and only ease near a real overtake of the car
                                     ahead, instead of backing off the whole pack (avoid-too-much) */
  let AI_AVOID_DECEL = 16;         /* m/s² hard-avoid decel the lift plans against — higher =
                                     they trust they can slow late, so they lift less early */
  let AI_CAR_HALF_W = 1.0;         /* m half width for "directly ahead in my line" */
  /* DRAFT — behavioral only (physics aero untouched) */
  let DRAFT_RANGE = 55;            /* m along-track a follower reads a tow */
  let DRAFT_LATERAL = 1.6;         /* m |dLat| to count as directly behind in the wake */
  let DRAFT_TUCK_GAP = 10;         /* m nose-to-tail hold while building a run */
  let DRAFT_RUN_BOOST = 0.08;      /* synthesised pace fraction a clean tow grants (<=0.12) */
  let DIRTY_AIR_LATG = 0.90;       /* cornering-grip fraction trusted in turbulence */
  let DIRTY_AIR_RANGE = 28;        /* m gap within which corner grip is derated */
  let SIDE_DRAFT_LONG = 3.5;       /* m ± longitudinal overlap to count as alongside */
  let SIDE_DRAFT_LAT_MIN = 2.5;    /* m inner lateral window for a side-draft */
  let SIDE_DRAFT_LAT_MAX = 4.5;    /* m outer lateral window for a side-draft */
  let PULL_OUT_HOLD = 2.8;         /* s tucked before a disciplined pull-out is allowed */
  let PULL_OUT_CLOSING = 3.5;      /* m/s closing required before a pull-out lane change */
  /* REAL DRAFT AERO — applied as external velocity nudges on c.u each substep
     (exactly how the physics already takes impulses; physics.js untouched). These
     move BOTH the player and the AI, so drafting is a genuine speed effect. */
  let DRAFT_ACCEL = 3.2;           /* m/s² forward for a car tucked in the wake (× closeness) */
  let SIDE_DRAFT_ACCEL = 2.0;      /* m/s² forward for a car on a rival's rear quarter */
  let SIDE_DRAFT_LEADER = 0.9;     /* m/s² the side-drafted leader LOSES (I take their air) */
  let BUMP_DRAFT_DV = 0.55;        /* m/s one-shot shove a bump-draft gives the car ahead */
  let BUMP_DRAFT_GAP = 3.0;        /* m nose-to-tail within which an AI will bump-draft */
  let BUMP_DRAFT_INTERVAL = 1.1;   /* s between bumps (per car) */
  /* HARDCODED yellow-line floor — AI may NEVER race under the yellow onto the apron.
     The slider can raise this but never lower it below 4.5 m (the value that worked). */
  const AI_YELLOW_LINE_MIN = 3.0;
  let AI_INSIDE_MARGIN = 4.0;   /* m held off the inside (yellow line) */
  /* TANDEM DRAFT (toggle) — two AI lock bumpers and run as a pair, the fastest
     draft. Strictly ONE partner each and NO chains (a pushee can't also push). */
  let TANDEM_ACCEL = 5.5;          /* m/s² BOTH cars of a locked pair gain */
  let TANDEM_GAP = 1.7;            /* m nose-to-tail the pusher glues to the pushee */
  let TANDEM_FORM_GAP = 5.0;       /* m within which a pusher can lock on (straights) */
  let TANDEM_BREAK_GAP = 10;       /* m gap that breaks the lock */
  let TANDEM_MIN_SPD = 28;         /* m/s floor to form a tandem (no low-speed locking) */
  let AI_AGGR_MIN = 0.30, AI_AGGR_MAX = 0.85;   /* per-car boldness (applies on next arm) */
  let AI_SKILL_LO = 0.94, AI_SKILL_SPAN = 0.11; /* pace ceiling 0.94-1.05 (applies on next arm) */
  let AI_PASS_HOLD = 2.5;          /* s pass/block commitment */
  let AI_BLOCK_PROB = 0.10;        /* defend probability — rare lane moves to block */
  /* CAUTION (yellow flag) */
  const PACE_MPS = 20;             /* yellow-flag pace speed */
  /* ---------- live-tunable registry: every AI param as a Display-panel slider ---
     get/set close over the module `let`s above so the controller needs no change.
     {g:group, key, label, min, max, step}. Persisted to localStorage; changes to
     most params take effect instantly, AGGR/SKILL on the next field arm. */

  function applyBakedAiDefaults() {
    const b = BAKED && BAKED.aiParams;
    if (!b) return;
    if (Number.isFinite(b.aDecel)) A_DECEL = b.aDecel;
    if (Number.isFinite(b.brakeMargin)) BRAKE_MARGIN = b.brakeMargin;
    if (Number.isFinite(b.latG)) AI_LAT_G = b.latG;
    if (Number.isFinite(b.downforceG)) AI_DOWNFORCE_G = b.downforceG;
    if (Number.isFinite(b.dfRef)) AI_DF_REF = b.dfRef;
    if (Number.isFinite(b.topMps)) AI_TOP_MPS = b.topMps;
    if (Number.isFinite(b.lookaheadS)) AI_LOOKAHEAD_S = b.lookaheadS;
    if (Number.isFinite(b.scanS)) AI_SPEED_SCAN_S = b.scanS;
    if (Number.isFinite(b.yawK1)) AI_YAW_K1 = b.yawK1;
    if (Number.isFinite(b.yawK2)) AI_YAW_K2 = b.yawK2;
    if (Number.isFinite(b.steerFF)) AI_STEER_FF = b.steerFF;
    if (Number.isFinite(b.bankHold)) AI_BANK_HOLD = b.bankHold;
    if (Number.isFinite(b.slipLift)) AI_SLIP_LIFT = b.slipLift;
    if (Number.isFinite(b.spinR)) AI_SPIN_R = b.spinR;
    if (Number.isFinite(b.recSettleLat)) REC_SETTLE_LAT = b.recSettleLat;
    if (Number.isFinite(b.recSettleYaw)) REC_SETTLE_YAW = b.recSettleYaw;
    if (Number.isFinite(b.recAlign)) REC_ALIGN_OK = b.recAlign;
    if (Number.isFinite(b.recStuckMax)) REC_STUCK_MAX = b.recStuckMax;
    if (Number.isFinite(b.recWallKeep)) REC_WALL_KEEP = b.recWallKeep;
    if (Number.isFinite(b.recLockStop)) REC_LOCK_STOP_SPD = b.recLockStop;
    if (Number.isFinite(b.latBand)) AI_LAT_BAND = b.latBand;
    if (Number.isFinite(b.minSide)) AI_MIN_SIDE_CLEAR = b.minSide;
    if (Number.isFinite(b.overlapHalf)) AI_OVERLAP_HALF = b.overlapHalf;
    if (Number.isFinite(b.sepGain)) AI_SEP_GAIN = b.sepGain;
    if (Number.isFinite(b.sepMargin)) AI_SEP_MARGIN = b.sepMargin;
    if (Number.isFinite(b.laneJerk)) AI_LANE_JERK = b.laneJerk;
    if (Number.isFinite(b.spotAheadS)) AI_SPOT_AHEAD_S = b.spotAheadS;
    if (Number.isFinite(b.spotAheadMin)) AI_SPOT_AHEAD_MIN = b.spotAheadMin;
    if (Number.isFinite(b.spotBehind)) AI_SPOT_BEHIND_M = b.spotBehind;
    if (Number.isFinite(b.liftWindow)) AI_LIFT_WINDOW = b.liftWindow;
    if (Number.isFinite(b.avoidDecel)) AI_AVOID_DECEL = b.avoidDecel;
    if (Number.isFinite(b.carHalfW)) AI_CAR_HALF_W = b.carHalfW;
    if (Number.isFinite(b.draftRange)) DRAFT_RANGE = b.draftRange;
    if (Number.isFinite(b.draftLat)) DRAFT_LATERAL = b.draftLat;
    if (Number.isFinite(b.draftTuck)) DRAFT_TUCK_GAP = b.draftTuck;
    if (Number.isFinite(b.draftBoost)) DRAFT_RUN_BOOST = b.draftBoost;
    if (Number.isFinite(b.dirtyLatG)) DIRTY_AIR_LATG = b.dirtyLatG;
    if (Number.isFinite(b.dirtyRange)) DIRTY_AIR_RANGE = b.dirtyRange;
    if (Number.isFinite(b.sideLong)) SIDE_DRAFT_LONG = b.sideLong;
    if (Number.isFinite(b.sideLatMin)) SIDE_DRAFT_LAT_MIN = b.sideLatMin;
    if (Number.isFinite(b.sideLatMax)) SIDE_DRAFT_LAT_MAX = b.sideLatMax;
    if (Number.isFinite(b.pullClosing)) PULL_OUT_CLOSING = b.pullClosing;
    if (Number.isFinite(b.pullHold)) PULL_OUT_HOLD = b.pullHold;
    if (Number.isFinite(b.draftAccel)) DRAFT_ACCEL = b.draftAccel;
    if (Number.isFinite(b.sideDraftAccel)) SIDE_DRAFT_ACCEL = b.sideDraftAccel;
    if (Number.isFinite(b.sideDraftLeader)) SIDE_DRAFT_LEADER = b.sideDraftLeader;
    if (Number.isFinite(b.bumpDv)) BUMP_DRAFT_DV = b.bumpDv;
    if (Number.isFinite(b.bumpGap)) BUMP_DRAFT_GAP = b.bumpGap;
    if (Number.isFinite(b.tandemAccel)) TANDEM_ACCEL = b.tandemAccel;
    if (Number.isFinite(b.aggrMin)) AI_AGGR_MIN = b.aggrMin;
    if (Number.isFinite(b.aggrMax)) AI_AGGR_MAX = b.aggrMax;
    if (Number.isFinite(b.skillLo)) AI_SKILL_LO = b.skillLo;
    if (Number.isFinite(b.skillSpan)) AI_SKILL_SPAN = b.skillSpan;
    if (Number.isFinite(b.passHold)) AI_PASS_HOLD = b.passHold;
    if (Number.isFinite(b.blockProb)) AI_BLOCK_PROB = b.blockProb;
    if (Number.isFinite(b.laneSpacing)) AI_LANE_SPACING = b.laneSpacing;
    if (Number.isFinite(b.wallMargin)) AI_WALL_MARGIN = b.wallMargin;
    if (Number.isFinite(b.insideMargin)) AI_INSIDE_MARGIN = Math.max(AI_YELLOW_LINE_MIN, b.insideMargin);
    if (Number.isFinite(b.laneRate)) AI_LANE_RATE = b.laneRate;
    if (Number.isFinite(b.grooveSmooth)) AI_GROOVE_SMOOTH_TAU = b.grooveSmooth;
    if (Number.isFinite(b.latForceK)) AI_LAT_FORCE_K = b.latForceK;
    if (Number.isFinite(b.carRepK)) AI_CAR_REP_K = b.carRepK;
    if (Number.isFinite(b.vTargetTau)) AI_VTARGET_TAU = b.vTargetTau;
  }
  applyBakedAiDefaults();
  const AI_PARAMS = [
    { g: 'Racing line & grooves', key: 'grooveSmooth', label: 'Line momentum (s) — higher = smoother/inertial', min: 0.25, max: 2.0, step: 0.05, get: () => AI_GROOVE_SMOOTH_TAU, set: v => { AI_GROOVE_SMOOTH_TAU = v; } },
    { g: 'Racing line & grooves', key: 'latForceK', label: 'Cross-track steer gain', min: 0.00005, max: 0.001, step: 0.00001, get: () => AI_LAT_FORCE_K, set: v => { AI_LAT_FORCE_K = v; } },
    { g: 'Racing line & grooves', key: 'laneRate', label: 'Lane-move rate (m/s)', min: 0.5, max: 6, step: 0.1, get: () => AI_LANE_RATE, set: v => { AI_LANE_RATE = v; } },
    { g: 'Racing line & grooves', key: 'laneSpacing', label: 'Groove spacing (m)', min: 2, max: 6, step: 0.1, get: () => AI_LANE_SPACING, set: v => { AI_LANE_SPACING = v; } },
    { g: 'Racing line & grooves', key: 'wallMargin', label: 'Wall margin (m)', min: 1, max: 5, step: 0.1, get: () => AI_WALL_MARGIN, set: v => { AI_WALL_MARGIN = v; } },
    { g: 'Racing line & grooves', key: 'insideMargin', label: 'Yellow line margin (m) — lower = closer to line', min: AI_YELLOW_LINE_MIN, max: 12, step: 0.25, get: () => AI_INSIDE_MARGIN, set: v => { AI_INSIDE_MARGIN = Math.max(AI_YELLOW_LINE_MIN, v); } },
    { g: 'Racing line & grooves', key: 'laneJerk', label: 'Lane jerk cap (m/s²) — lower = smoother', min: 2, max: 30, step: 0.5, get: () => AI_LANE_JERK, set: v => { AI_LANE_JERK = v; } },
    { g: 'Steering', key: 'yawK1', label: 'Steer stiffness k1', min: 0.4, max: 3.0, step: 0.05, get: () => AI_YAW_K1, set: v => { AI_YAW_K1 = v; } },
    { g: 'Steering', key: 'yawK2', label: 'Yaw-rate damping k2', min: 0, max: 1.0, step: 0.05, get: () => AI_YAW_K2, set: v => { AI_YAW_K2 = v; } },
    { g: 'Steering', key: 'steerFF', label: 'Curvature feed-forward', min: 0, max: 2.0, step: 0.05, get: () => AI_STEER_FF, set: v => { AI_STEER_FF = v; } },
    { g: 'Steering', key: 'bankHold', label: 'Banking hold (up-bank steer, pace lap)', min: 0, max: 0.2, step: 0.005, get: () => AI_BANK_HOLD, set: v => { AI_BANK_HOLD = v; } },
    { g: 'Steering', key: 'lookaheadS', label: 'Steer lookahead (s)', min: 0.3, max: 2.0, step: 0.05, get: () => AI_LOOKAHEAD_S, set: v => { AI_LOOKAHEAD_S = v; } },
    { g: 'Speed & corners', key: 'topMps', label: 'Pace ceiling (m/s)', min: 40, max: 110, step: 1, get: () => AI_TOP_MPS, set: v => { AI_TOP_MPS = v; } },
    { g: 'Speed & corners', key: 'latG', label: 'Corner grip base (× g)', min: 0.8, max: 2.2, step: 0.05, get: () => AI_LAT_G, set: v => { AI_LAT_G = v; } },
    { g: 'Speed & corners', key: 'downforceG', label: 'Downforce grip (× g @ speed)', min: 0, max: 2, step: 0.05, get: () => AI_DOWNFORCE_G, set: v => { AI_DOWNFORCE_G = v; } },
    { g: 'Speed & corners', key: 'dfRef', label: 'Downforce ref speed (m/s)', min: 40, max: 90, step: 1, get: () => AI_DF_REF, set: v => { AI_DF_REF = v; } },
    { g: 'Speed & corners', key: 'scanS', label: 'Corner scan horizon (s)', min: 1.0, max: 5.0, step: 0.1, get: () => AI_SPEED_SCAN_S, set: v => { AI_SPEED_SCAN_S = v; } },
    { g: 'Speed & corners', key: 'vTargetTau', label: 'Speed smoothing (s)', min: 0.08, max: 1.2, step: 0.05, get: () => AI_VTARGET_TAU, set: v => { AI_VTARGET_TAU = v; } },
    { g: 'Braking & throttle', key: 'aDecel', label: 'Brake decel plan (m/s²) — higher brakes LATER', min: 5, max: 22, step: 0.5, get: () => A_DECEL, set: v => { A_DECEL = v; } },
    { g: 'Braking & throttle', key: 'brakeMargin', label: 'Brake margin (m)', min: 0, max: 15, step: 0.5, get: () => BRAKE_MARGIN, set: v => { BRAKE_MARGIN = v; } },
    { g: 'Braking & throttle', key: 'thrGain', label: 'Throttle gain (NR)', min: 0.1, max: 0.6, step: 0.02, get: () => AI_THR_GAIN, set: v => { AI_THR_GAIN = v; } },
    { g: 'Braking & throttle', key: 'brakeSlew', label: 'Brake slew (/s)', min: 0.5, max: 8, step: 0.1, get: () => AI_BRAKE_SLEW, set: v => { AI_BRAKE_SLEW = v; } },
    { g: 'Drafting & packs', key: 'draftRange', label: 'Draft range (m)', min: 20, max: 100, step: 1, get: () => DRAFT_RANGE, set: v => { DRAFT_RANGE = v; } },
    { g: 'Drafting & packs', key: 'draftLat', label: 'Draft lateral (m)', min: 0.8, max: 4, step: 0.1, get: () => DRAFT_LATERAL, set: v => { DRAFT_LATERAL = v; } },
    { g: 'Drafting & packs', key: 'draftTuck', label: 'Tuck gap (m)', min: 3, max: 25, step: 0.5, get: () => DRAFT_TUCK_GAP, set: v => { DRAFT_TUCK_GAP = v; } },
    { g: 'Drafting & packs', key: 'draftBoost', label: 'Draft run boost', min: 0, max: 0.2, step: 0.01, get: () => DRAFT_RUN_BOOST, set: v => { DRAFT_RUN_BOOST = v; } },
    { g: 'Drafting & packs', key: 'dirtyLatG', label: 'Dirty-air grip fraction', min: 0.7, max: 1.0, step: 0.01, get: () => DIRTY_AIR_LATG, set: v => { DIRTY_AIR_LATG = v; } },
    { g: 'Drafting & packs', key: 'dirtyRange', label: 'Dirty-air range (m)', min: 10, max: 50, step: 1, get: () => DIRTY_AIR_RANGE, set: v => { DIRTY_AIR_RANGE = v; } },
    { g: 'Drafting & packs', key: 'sideLong', label: 'Side-draft overlap (m)', min: 1.5, max: 8, step: 0.1, get: () => SIDE_DRAFT_LONG, set: v => { SIDE_DRAFT_LONG = v; } },
    { g: 'Drafting & packs', key: 'sideLatMin', label: 'Side-draft inner (m)', min: 1.5, max: 5, step: 0.1, get: () => SIDE_DRAFT_LAT_MIN, set: v => { SIDE_DRAFT_LAT_MIN = v; } },
    { g: 'Drafting & packs', key: 'sideLatMax', label: 'Side-draft outer (m)', min: 3, max: 8, step: 0.1, get: () => SIDE_DRAFT_LAT_MAX, set: v => { SIDE_DRAFT_LAT_MAX = v; } },
    { g: 'Drafting & packs', key: 'draftAccel', label: 'Draft boost (m/s²) — REAL', min: 0, max: 8, step: 0.1, get: () => DRAFT_ACCEL, set: v => { DRAFT_ACCEL = v; } },
    { g: 'Drafting & packs', key: 'sideDraftAccel', label: 'Side-draft boost (m/s²)', min: 0, max: 6, step: 0.1, get: () => SIDE_DRAFT_ACCEL, set: v => { SIDE_DRAFT_ACCEL = v; } },
    { g: 'Drafting & packs', key: 'sideDraftLeader', label: 'Side-draft leader drag (m/s²)', min: 0, max: 4, step: 0.1, get: () => SIDE_DRAFT_LEADER, set: v => { SIDE_DRAFT_LEADER = v; } },
    { g: 'Drafting & packs', key: 'bumpDv', label: 'Bump-draft shove (m/s)', min: 0, max: 2, step: 0.05, get: () => BUMP_DRAFT_DV, set: v => { BUMP_DRAFT_DV = v; } },
    { g: 'Drafting & packs', key: 'bumpGap', label: 'Bump-draft gap (m)', min: 1.5, max: 6, step: 0.1, get: () => BUMP_DRAFT_GAP, set: v => { BUMP_DRAFT_GAP = v; } },
    { g: 'Drafting & packs', key: 'tandemAccel', label: 'Tandem push (m/s²)', min: 0, max: 12, step: 0.1, get: () => TANDEM_ACCEL, set: v => { TANDEM_ACCEL = v; } },
    { g: 'Drafting & packs', key: 'pullClosing', label: 'Pull-out closing (m/s)', min: 0.3, max: 5, step: 0.1, get: () => PULL_OUT_CLOSING, set: v => { PULL_OUT_CLOSING = v; } },
    { g: 'Drafting & packs', key: 'pullHold', label: 'Pull-out hold (s)', min: 0.1, max: 2, step: 0.1, get: () => PULL_OUT_HOLD, set: v => { PULL_OUT_HOLD = v; } },
    { g: 'Traffic & spacing', key: 'minSide', label: 'Min body-side gap (m edge)', min: 0.08, max: 1.2, step: 0.02, get: () => AI_MIN_SIDE_CLEAR, set: v => { AI_MIN_SIDE_CLEAR = v; } },
    { g: 'Traffic & spacing', key: 'sideLock', label: 'Side-lock break (s)', min: 0.3, max: 2.5, step: 0.05, get: () => AI_SIDE_LOCK_S, set: v => { AI_SIDE_LOCK_S = v; } },
    { g: 'Traffic & spacing', key: 'overlapHalf', label: 'Overlap half-length (m)', min: 1.5, max: 6, step: 0.1, get: () => AI_OVERLAP_HALF, set: v => { AI_OVERLAP_HALF = v; } },
    { g: 'Traffic & spacing', key: 'sepGain', label: 'Side push-apart gain (/s)', min: 0, max: 4, step: 0.1, get: () => AI_SEP_GAIN, set: v => { AI_SEP_GAIN = v; } },
    { g: 'Traffic & spacing', key: 'sepMargin', label: 'Side push-apart margin (m)', min: 0, max: 2, step: 0.1, get: () => AI_SEP_MARGIN, set: v => { AI_SEP_MARGIN = v; } },
    { g: 'Traffic & spacing', key: 'latBand', label: 'Beside band (m)', min: 2, max: 8, step: 0.1, get: () => AI_LAT_BAND, set: v => { AI_LAT_BAND = v; } },
    { g: 'Traffic & spacing', key: 'spotAheadS', label: 'Ahead scan (s)', min: 0.5, max: 4, step: 0.1, get: () => AI_SPOT_AHEAD_S, set: v => { AI_SPOT_AHEAD_S = v; } },
    { g: 'Traffic & spacing', key: 'spotAheadMin', label: 'Ahead scan floor (m)', min: 20, max: 100, step: 1, get: () => AI_SPOT_AHEAD_MIN, set: v => { AI_SPOT_AHEAD_MIN = v; } },
    { g: 'Traffic & spacing', key: 'spotBehind', label: 'Behind scan (m)', min: 15, max: 90, step: 1, get: () => AI_SPOT_BEHIND_M, set: v => { AI_SPOT_BEHIND_M = v; } },
    { g: 'Traffic & spacing', key: 'liftWindow', label: 'Throttle-lift window (m)', min: 2, max: 20, step: 0.5, get: () => AI_LIFT_WINDOW, set: v => { AI_LIFT_WINDOW = v; } },
    { g: 'Traffic & spacing', key: 'avoidDecel', label: 'Avoid decel (m/s²)', min: 6, max: 25, step: 0.5, get: () => AI_AVOID_DECEL, set: v => { AI_AVOID_DECEL = v; } },
    { g: 'Traffic & spacing', key: 'carHalfW', label: 'In-line half width (m)', min: 0.5, max: 2, step: 0.1, get: () => AI_CAR_HALF_W, set: v => { AI_CAR_HALF_W = v; } },
    { g: 'Traffic & spacing', key: 'carRepK', label: 'Door-to-door repulsion gain', min: 0.002, max: 0.04, step: 0.001, get: () => AI_CAR_REP_K, set: v => { AI_CAR_REP_K = v; } },
    { g: 'Passing & drivers', key: 'aggrMin', label: 'Aggression min', min: 0, max: 1, step: 0.05, get: () => AI_AGGR_MIN, set: v => { AI_AGGR_MIN = v; } },
    { g: 'Passing & drivers', key: 'aggrMax', label: 'Aggression max', min: 0, max: 1, step: 0.05, get: () => AI_AGGR_MAX, set: v => { AI_AGGR_MAX = v; } },
    { g: 'Passing & drivers', key: 'skillLo', label: 'Skill floor', min: 0.8, max: 1.1, step: 0.01, get: () => AI_SKILL_LO, set: v => { AI_SKILL_LO = v; } },
    { g: 'Passing & drivers', key: 'skillSpan', label: 'Skill span', min: 0, max: 0.3, step: 0.01, get: () => AI_SKILL_SPAN, set: v => { AI_SKILL_SPAN = v; } },
    { g: 'Passing & drivers', key: 'passHold', label: 'Pass commitment (s)', min: 0.2, max: 3, step: 0.1, get: () => AI_PASS_HOLD, set: v => { AI_PASS_HOLD = v; } },
    { g: 'Passing & drivers', key: 'blockProb', label: 'Block probability', min: 0, max: 1, step: 0.05, get: () => AI_BLOCK_PROB, set: v => { AI_BLOCK_PROB = v; } },
    { g: 'Spin recovery', key: 'slipLift', label: 'Slip-angle lift (rad)', min: 0.05, max: 0.6, step: 0.01, get: () => AI_SLIP_LIFT, set: v => { AI_SLIP_LIFT = v; } },
    { g: 'Spin recovery', key: 'spinR', label: 'Spin-rate lift (rad/s)', min: 0.4, max: 3.0, step: 0.05, get: () => AI_SPIN_R, set: v => { AI_SPIN_R = v; } },
    { g: 'Spin recovery', key: 'recSettleLat', label: 'Settle lateral vel (m/s)', min: 2, max: 12, step: 0.5, get: () => REC_SETTLE_LAT, set: v => { REC_SETTLE_LAT = v; } },
    { g: 'Spin recovery', key: 'recSettleYaw', label: 'Settle yaw rate (rad/s)', min: 0.2, max: 2, step: 0.05, get: () => REC_SETTLE_YAW, set: v => { REC_SETTLE_YAW = v; } },
    { g: 'Spin recovery', key: 'recAlign', label: 'Rejoin align (rad)', min: 0.2, max: 1.2, step: 0.05, get: () => REC_ALIGN_OK, set: v => { REC_ALIGN_OK = v; } },
    { g: 'Spin recovery', key: 'recStuckMax', label: 'Stuck → tow (s)', min: 1.5, max: 10, step: 0.5, get: () => REC_STUCK_MAX, set: v => { REC_STUCK_MAX = v; } },
    { g: 'Spin recovery', key: 'recWallKeep', label: 'Wall keep-off (m)', min: 1, max: 5, step: 0.1, get: () => REC_WALL_KEEP, set: v => { REC_WALL_KEEP = v; } },
    { g: 'Spin recovery', key: 'recLockStop', label: 'Spin lock-up stop speed (m/s)', min: 0, max: 8, step: 0.5, get: () => REC_LOCK_STOP_SPD, set: v => { REC_LOCK_STOP_SPD = v; } },
  ];
  for (const p of AI_PARAMS) p.def = p.get();   /* snapshot factory defaults for reset */
  /* Bump when a factory default changes so a stale localStorage save ADOPTS the new
     value instead of pinning the old one (the "saved state beats new default" trap).
     Only the listed keys reset on upgrade — every other tuning the user set is kept. */
  const AI_PARAMS_VER = 33; /* v33 body-aware sense + paired-groove spotter */
  const AI_PARAMS_UPGRADE_RESET = ['passHold', 'insideMargin', 'laneRate', 'yawK1', 'yawK2', 'steerFF', 'laneJerk', 'sepGain', 'sepMargin', 'minSide', 'blockProb', 'sideLock', 'aDecel', 'brakeMargin', 'liftWindow', 'avoidDecel', 'thrGain', 'brakeSlew', 'slipLift', 'spinR', 'recSettleLat', 'lookaheadS', 'latForceK', 'carRepK', 'sideWarn', 'microGap', 'grooveSmooth'];   /* v14: side-lock */
  function loadAiParams() {
    try {
      const raw = localStorage.getItem('re2003.aiParams2');
      if (!raw) return;
      const o = JSON.parse(raw);
      const stale = !o || o._ver !== AI_PARAMS_VER;
      for (const p of AI_PARAMS) {
        if (stale && AI_PARAMS_UPGRADE_RESET.includes(p.key)) continue;   /* keep the new factory default */
        if (o && Number.isFinite(o[p.key])) p.set(clamp(o[p.key], p.min, p.max));
      }
      if (stale) saveAiParams();   /* re-stamp: adopt the upgraded defaults, keep the rest */
    } catch (e) {}
  }
  function saveAiParams() {
    const o = { _ver: AI_PARAMS_VER };
    for (const p of AI_PARAMS) o[p.key] = p.get();
    try { localStorage.setItem('re2003.aiParams2', JSON.stringify(o)); } catch (e) {}
  }
  function getAiParams() {   /* meta + current value, for the slider UI */
    return AI_PARAMS.map(p => ({ g: p.g, key: p.key, label: p.label, min: p.min, max: p.max, step: p.step, value: p.get() }));
  }
  function setAiParam(key, v) {
    const p = AI_PARAMS.find(e => e.key === key);
    if (!p || !Number.isFinite(v)) return;
    p.set(clamp(v, p.min, p.max));
    saveAiParams();
  }
  function resetAiParams() {
    for (const p of AI_PARAMS) p.set(p.def);
    saveAiParams();
  }
  loadAiParams();   /* apply any saved tuning over the defaults */
  /* live AI tuning (Display panel sliders). speed scales the pace; aggro scales
     how soon they pounce + how hard they commit to corners; laneFreq drives how
     often they wander between grooves + how fast the lane transitions. */
  let aiTune = BAKED?.aiTune ? { ...BAKED.aiTune } : { speed: 1.0, aggro: 0.5, laneFreq: 0 };   /* laneFreq 0 = no clean-air groove-wander: cars
       HOLD their line and only change lanes to pass/defend/separate (kills the random cross-track drift =
       the "swerve back and forth"). Matches Cameron's saved preference. Raise the slider for more roaming. */
  try {
    const raw = localStorage.getItem('re2003.aiTune');
    if (raw) { const s = JSON.parse(raw); if (s && typeof s === 'object') aiTune = { ...aiTune, ...s }; }
  } catch (e) {}
  let playerPeakHp = BAKED?.playerPeakHp ?? 750;
  let aiPeakHp = BAKED?.aiPeakHp ?? 750;
  try { const v = parseFloat(localStorage.getItem('re2003.playerPeakHp')); if (Number.isFinite(v)) playerPeakHp = clamp(v, 250, 900); } catch (e) {}
  try { const v = parseFloat(localStorage.getItem('re2003.aiPeakHp')); if (Number.isFinite(v)) aiPeakHp = clamp(v, 250, 900); } catch (e) {}
  /* PLAYER steering sensitivity — scales the steer COMMAND only (how far the front
     wheels turn for your input), NOT the grip/weight-transfer physics. Lower =
     calmer, less darty; the car itself is unchanged. Player car only (AI drive
     their own controller). */
  let steerSensitivity = BAKED?.steerSens ?? 0.6;
  try { const v = parseFloat(localStorage.getItem('re2003.steerSens')); if (Number.isFinite(v)) steerSensitivity = clamp(v, 0.3, 1.2); } catch (e) {}
  /* the sensitivity only bites at SPEED: full steer below LO (so you keep tight
     low-speed turn-in — pits, slow corners), easing to `steerSensitivity` by HI so
     the car isn't darty fast. Used for the player AND the AI (calms both, which is
     why the AI stop over-steering into the wall). */
  const STEER_SENS_LO_MPS = 12, STEER_SENS_HI_MPS = 40;
  function steerSpeedScale(spd) {
    const t = clamp((spd - STEER_SENS_LO_MPS) / (STEER_SENS_HI_MPS - STEER_SENS_LO_MPS), 0, 1);
    return 1 - (1 - steerSensitivity) * t;
  }
  let aiRaceMode = true;           /* racers on the track by default (toggle in Display) */
  try { aiRaceMode = localStorage.getItem('re2003.aiRace') !== '0'; } catch (e) {}
  /* AI spatial-awareness state (track-frame dlong/dlat model). aiCum caches
     the centreline arc table; a per-substep sense pass fills each car's f.sense so
     every car has a constant, consistent picture of its neighbors. */
  let aiCum = null;                /* { cum:[], total } — rebuilt in armField() */
  let aiCaution = false;           /* yellow flag: pace speed, single-file, no passing */
  let aiPlayerNode = null;         /* { car, arc, lat, spd } rebuilt each sense pass */
  let aiInsideSign = 1;            /* +1 = infield/apron is at +dlat (driver's-left), else -1;
                                      the side the AI must hold OFF (the yellow line). Per track. */
  let playerSense = null;          /* the player's own draft picture (for real draft forces) */
  /* net-curvature test: sum the signed tangent turn around the loop. Net-left
     (CCW oval) → infield on the driver's left (+dlat) → inside = +1. */
  function computeInsideSign() {
    const segs = track && track.surface && track.surface.segments;
    if (!segs || segs.length < 3) return 1;
    let net = 0, px = null, py = null;
    for (let k = 0; k < segs.length; k++) {
      const c = TrackSurface.sampleCenter(segs[k], 0.5);
      if (px !== null) net += px * c.ty - py * c.tx;   /* cross(prevTangent, curTangent) */
      px = c.tx; py = c.ty;
    }
    return net >= 0 ? 1 : -1;
  }
  let aiLanesGroup = null;         /* debug overlay: the AI grooves drawn as coloured lines */
  let aiLanesOn = false;
  try { aiLanesOn = localStorage.getItem('re2003.aiLanes') === '1'; } catch (e) {}
  let aiTandemOn = false;          /* allow AI to lock bumpers into tandem draft pairs */
  try { aiTandemOn = localStorage.getItem('re2003.aiTandem') === '1'; } catch (e) {}
  /* the AI racing lanes (grooves), as lateral dlat offsets in metres. Editable in
     Settings + shown by the overlay; the AI spawn on them and wander between them.
     REFERENCE grooves the AI targets (not a fixed spline). Clamped per-segment
     to the drivable band (aiLaneBand). */
  let aiLaneOffsets = [-6.6, -3.3, 0, 3.3, 6.6];
  try {
    const raw = localStorage.getItem('re2003.aiLaneOffsets');
    if (raw) { const a = JSON.parse(raw); if (Array.isArray(a) && a.length) aiLaneOffsets = a.map(Number).filter(Number.isFinite); }
  } catch (e) {}
  function saveAiLaneOffsets() { try { localStorage.setItem('re2003.aiLaneOffsets', JSON.stringify(aiLaneOffsets)); } catch (e) {} }
  /* find the field-car wrapper for a Physics.Car (tandem partner bookkeeping) */
  function fieldOf(physCar) {
    for (const f of fieldCars) if (f.car === physCar) return f;
    return null;
  }
  const SENSE_DEFAULT = Object.freeze({
    ahead: null, behind: null, alongside: null, left: 0, right: 0, threeWide: 0,
    leftGap: Infinity, rightGap: Infinity, leftEdge: Infinity, rightEdge: Infinity,
    sideCars: 0, carsLeft: 0, carsRight: 0,
    laneSlots: 1, mySlot: 0, openUp: 0, openDown: 0, slotCars: 1,
    liftAhead: 1, aheadSpd: Infinity, aheadGap: Infinity, dirtyAir: false,
    partnerLane: null,
  });
  /* Per-car sense object is allocated ONCE (here) and mutated in place every
     substep — the old pass built a fresh nodes array + 40 sense records + sub-
     objects each substep, and that churn was the GC-pause / frame-hitch source.
     The _ahead/_behind/_along sub-records are reused; s.ahead points at _ahead
     only when a car qualifies, so consumers still read `if (s.ahead)` unchanged. */
  function makeSense() {
    return { ahead: null, behind: null, alongside: null, left: 0, right: 0, threeWide: 0,
      leftGap: Infinity, rightGap: Infinity, leftEdge: Infinity, rightEdge: Infinity,
      sideCars: 0, carsLeft: 0, carsRight: 0,
      laneSlots: 1, mySlot: 0, openUp: 0, openDown: 0, slotCars: 1,
      liftAhead: 1, aheadSpd: Infinity, aheadGap: Infinity, dirtyAir: false,
      partnerLane: null,
      _slotOcc: [],
      _ahead: { car: null, dArc: 0, dLat: 0, closing: 0 },
      _behind: { car: null, dArc: 0, dLat: 0, closing: 0 },
      _colAhead: { car: null, dArc: 0, dLat: 0, closing: 0 },
      _colBehind: { car: null, dArc: 0, dLat: 0, closing: 0 },
      _along: { car: null, side: 0 },
      _partner: { car: null, dArc: 0, dLat: 0, closing: 0 } };
  }
  const _aiNodePool = [];          /* reusable neighbour-node records (grows to field size once) */
  const _aiNodes = [];             /* this pass's field-car nodes (drawn from the pool) */
  const _aiAll = [];               /* field nodes + the player node, as neighbour candidates */
  let _aiPlayerNodeObj = null;     /* reused player node record */

  /* a formal race (the "Start race" button): grid start, lap counting, checker */
  const RACE_FIELD = 40;           /* target field size (capped by the track's stalls) */
  const RACE_LAPS = 10;
  const RACE_GRID_ROW_GAP = 10;    /* m between grid rows */
  const RACE_GRID_COL = 3.0;       /* m lateral to each of the 2 grid columns */
  const RACE_GRID_START_BACK = 12; /* m the front row sits behind the S/F line */
  const RACE_ROLLING_MPS = 18;     /* gentle rolling start so turn 1 isn't a standing melee */
  let race = null;                 /* { laps, total, cum[], sfDist, over, finishers[], leaderLap, playerRace } */
  const _fieldMat = new THREE.Matrix4();
  const _fieldQ = new THREE.Quaternion();
  const _fieldP = new THREE.Vector3();
  const _fieldS = new THREE.Vector3(1, 1, 1);
  const _carMat = new THREE.Matrix4();      /* stable car pose while spinning its wheels */
  const _wheelLocal = new THREE.Matrix4(), _wheelWorld = new THREE.Matrix4();
  const _wheelR = new THREE.Matrix4(), _wheelT = new THREE.Matrix4();
  const _wheelE = new THREE.Euler();

  /* sample the track surface for a NON-player car: swap its projection seed in
     for the shared sampleSurface, then restore the player's. Keeps every field
     car's incremental lock independent without duplicating the sampler. */
  function sampleSurfaceFor(seed, x, y) {
    const saved = progress;
    progress = seed.progress;
    const surf = sampleSurface(x, y);   /* mutates module `progress` → the car's new seed */
    seed.progress = progress;
    progress = saved;
    return surf;
  }

  /* advance one field car through the EXACT player path (sampleSurface +
     car.step + resolveWalls/wallCollide) by temporarily making it the module
     `car`. Fully synchronous — nothing else reads `car` mid-swap — and every
     borrowed module global is restored before returning. */
  function stepOtherCar(f) {
    const c = f.car;
    const sCar = car, sProg = progress, sPx = preStepX, sPy = preStepY;
    car = c; progress = f.seed.progress;
    let surf = sampleSurface(c.x, c.y);        /* also sets module `progress.seg/u` */
    preStepX = c.x; preStepY = c.y;
    let input;
    if (f.ai) {
      const _pa = PERF.on ? performance.now() : 0;
      input = aiDriveInput(f, surf, progress ? progress.seg : 0);
      if (PERF.on) PERF.aiDec += performance.now() - _pa;
    } else input = FIELD_INPUT;
    c.step(FIXED_DT, input, surf);
    surf = sampleSurface(c.x, c.y);
    /* EVERY car hits walls exactly like the player — same resolveWalls path.
       It's cheap when there's no contact (wallCollide returns false on the
       first of its iterations), so there's nothing to gain by gating it, and
       an earlier "skip when mid-track" gate let knocked-wide AI cars tunnel
       straight through the barrier. */
    surf = resolveWalls(surf);   /* wallCollide reads module `car` = c */
    f.seed.progress = progress;
    f.surfPrev = f.surf;         /* keep the last step's surface so the render can
                                    interpolate height + banking between fixed steps */
    f.surf = surf;
    car = sCar; progress = sProg; preStepX = sPx; preStepY = sPy;
  }

  function fieldNear(A, B) {
    const dx = B.x - A.x, dy = B.y - A.y;
    return dx * dx + dy * dy < FIELD_WAKE_R2;
  }
  function wakeField(f) { if (!f.awake) { f.awake = true; f.restTimer = 0; } }

  /* car↔car for the whole field, run once per substep AFTER every car has
     stepped: player vs each stall car (sleepers are valid targets → they wake
     when hit), then each awake car vs every later car. collideCars applies the
     shove to both and de-penetrates them; a non-null return means contact. */
  const CARCAR_ITERS = 3;   /* de-penetration relaxation passes. collideCars only
     applies its velocity impulse while a pair is APPROACHING (relN<0) — after the
     first pass they separate, so later passes just push residual overlaps apart.
     One pass fully de-penetrates a lone pair, but in a 3-wide sandwich resolving
     B↔C shoves B back into A within the same substep; iterating settles the pack
     so cars stop visibly clipping THROUGH each other. Impulse/damage/wreck-launch
     therefore still fire exactly once per contact. */
  function resolveCarCar() {
    const player = car;
    for (let iter = 0; iter < CARCAR_ITERS; iter++) {
      for (let i = 0; i < fieldCars.length; i++) {
        const f = fieldCars[i];
        if (fieldNear(player, f.car) && Physics.collideCars(player, f.car)) wakeField(f);
      }
      for (let i = 0; i < fieldCars.length; i++) {
        const a = fieldCars[i];
        if (!a.awake) continue;
        for (let j = i + 1; j < fieldCars.length; j++) {
          const b = fieldCars[j];
          if (fieldNear(a.car, b.car) && Physics.collideCars(a.car, b.car)) { wakeField(a); wakeField(b); }
        }
      }
    }
  }

  function updateFieldSleep(f) {
    const c = f.car;
    const settled = c.speed < FIELD_SLEEP_SPD && Math.abs(c.r) < FIELD_SLEEP_ANG
      && !c.airborne && !c.restingOnBody;
    f.restTimer = settled ? f.restTimer + FIXED_DT : 0;
    if (f.restTimer > FIELD_SLEEP_TIME) {   /* freeze: zero it out and stop stepping */
      f.awake = false;
      c.u = 0; c.v = 0; c.r = 0; c.vz = 0;
      /* a slept pit car must not keep a sideways flight pose frozen in the renderer */
      const surf = f.surf || sampleSurfaceFor(f.seed, c.x, c.y);
      if (typeof Physics !== 'undefined' && Physics.settleCarToSurface) Physics.settleCarToSurface(c, surf);
      f.snapCur = c.snapshot();
      f.snapPrev = f.snapCur;
    }
  }

  /* CONSTANT SPATIAL AWARENESS (spotter model). Once per substep, in the
     track frame (dlong/dlat), build every car's neighbour picture: the car ahead
     in the wake, the faster chaser behind, anyone alongside, left/right side-by-
     side blocks, three-wide boxing, and a throttle-lift factor from braking-
     distance kinematics. Every downstream decision (steer gate, follow-cap,
     draft, pass, block) reads f.sense — so cars race each other, not the void.
     Runs BEFORE the step loop while module globals are still the player's, and
     reads only f.car.{x,y,speed}, f.seed.progress, f.lane + the player surf — no
     swapped global — so it is safe alongside stepOtherCar's global swap. */
  /* Real car body width from physics OBB — sense/repulsion use EDGE gaps, not centre distance. */
  function aiBodyHalfW() {
    return (typeof Physics !== 'undefined' && Physics.CAR_OBB && Physics.CAR_OBB.halfWidth)
      ? Physics.CAR_OBB.halfWidth : 0.95;
  }
  function aiBodyCentreMin() { return aiBodyHalfW() * 2; }
  function aiLatEdge(centerDist) { return Math.max(0, Math.abs(centerDist) - aiBodyCentreMin()); }
  function aiCentreClearTarget(edgeClear) { return aiBodyCentreMin() + Math.max(0, edgeClear || 0); }
  function aiBodyDlatReach(car, seg, u) {
    if (!car || !seg) return aiBodyHalfW();
    const c = TrackSurface.sampleCenter(seg, u);
    const nx = -c.ty, ny = c.tx;
    const obb = (typeof Physics !== 'undefined' && Physics.CAR_OBB) ? Physics.CAR_OBB : null;
    const hw = obb ? obb.halfWidth : aiBodyHalfW();
    const hf = obb ? obb.halfLenF : 2.65;
    const hr = obb ? obb.halfLenR : 2.60;
    const cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
    let maxProj = 0;
    for (const lx of [hf, -hr]) for (const ly of [hw, -hw]) {
      const px = cy * lx - sy * ly, py = sy * lx + cy * ly;
      maxProj = Math.max(maxProj, Math.abs(px * nx + py * ny));
    }
    return maxProj;
  }
  function aiGrooveOccupied(meArc, grooveDlat, selfCar, arcAhead, arcBehind) {
    if (!aiCum) return false;
    const total = aiCum.total;
    const half = aiGrooveSlotHalf() + aiBodyHalfW() * 0.25;
    for (const o of _aiAll) {
      if (o.car === selfCar) continue;
      if (Math.abs(o.lat - grooveDlat) >= half) continue;
      const dArc = arcGap(meArc, o.arc, total);
      if (dArc >= -arcBehind && dArc <= arcAhead) return true;
    }
    return false;
  }
  function aiSideSepOffset(s) {
    if (!s || s.sideCars < 1) return 0;
    const want = AI_MIN_SIDE_CLEAR + AI_SEP_MARGIN;
    const le = Number.isFinite(s.leftEdge) ? s.leftEdge : aiLatEdge(s.leftGap);
    const re = Number.isFinite(s.rightEdge) ? s.rightEdge : aiLatEdge(s.rightGap);
    const prox = Math.min(le, re);
    if (prox >= want + 0.12) return 0;
    let push = 0;
    if (le < want) push -= (want - le) * AI_SEP_GAIN * 0.18;
    if (re < want) push += (want - re) * AI_SEP_GAIN * 0.18;
    if (s.left === 2 && s.right === 2) push += (le >= re ? -1 : 1) * AI_SEP_GAIN * 0.22;
    return clamp(push, -0.95, 0.95);
  }

  /* same starting column / groove — column chase chain, not door-to-door row lock */
  function aiSameColumn(meF, oF, meLat, oLat) {
    const colW = AI_LANE_SPACING * 0.92;
    if (meF && oF && meF.gridCol != null && oF.gridCol != null) return meF.gridCol === oF.gridCol;
    return Math.abs(meLat - oLat) < colW;
  }

  function aiSenseField(playerSurf) {
    if (!aiCum) return;
    const total = aiCum.total;
    /* pass 1: build reusable nodes (arc, lat, spd). car/progress ARE the player's here. */
    aiPlayerNode = null;
    if (car && progress) {
      if (!_aiPlayerNodeObj) _aiPlayerNodeObj = { car: null, arc: 0, lat: 0, spd: 0 };
      _aiPlayerNodeObj.car = car;
      _aiPlayerNodeObj.arc = segDlong(progress.seg, clamp(progress.u, 0, 1));
      _aiPlayerNodeObj.lat = (playerSurf && Number.isFinite(playerSurf.dlat)) ? playerSurf.dlat : 0;
      _aiPlayerNodeObj.spd = car.speed;
      aiPlayerNode = _aiPlayerNodeObj;
    }
    _aiNodes.length = 0;
    let ni = 0;
    for (const f of fieldCars) {
      if (!f.awake) continue;
      const pr = f.seed.progress;
      if (!pr) continue;   /* no track seed (a parked car shoved awake) — reactive collision handles it */
      f.arc = segDlong(pr.seg, clamp(pr.u, 0, 1));
      let nd = _aiNodePool[ni];
      if (!nd) { nd = { f: null, arc: 0, lat: 0, spd: 0, car: null }; _aiNodePool[ni] = nd; }
      nd.f = f; nd.arc = f.arc; nd.lat = (f.surf && Number.isFinite(f.surf.dlat)) ? f.surf.dlat : f.lane; nd.spd = f.car.speed; nd.car = f.car;
      _aiNodes.push(nd); ni++;
    }
    _aiAll.length = 0;
    for (const nd of _aiNodes) _aiAll.push(nd);
    if (aiPlayerNode) _aiAll.push(aiPlayerNode);
    /* pass 2: one neighbour loop per AI car → mutate its persistent f.sense in place */
    for (const n of _aiNodes) {
      if (!n.f.ai) continue;
      const meLat = n.lat, meSpd = n.spd, meArc = n.arc;
      const s = n.f.sense;
      s.ahead = null; s.behind = null; s.colAhead = null; s.colBehind = null; s.alongside = null;
      s.left = 0; s.right = 0; s.threeWide = 0;
      s.leftGap = Infinity; s.rightGap = Infinity; s.leftEdge = Infinity; s.rightEdge = Infinity;
      s.sideCars = 0; s.carsLeft = 0; s.carsRight = 0;
      s.liftAhead = 1; s.aheadSpd = Infinity; s.aheadGap = Infinity; s.dirtyAir = false;
      s.partnerLane = null;
      for (const o of _aiAll) {
        if (o === n || o.car === n.car) continue;
        const dArc = arcGap(meArc, o.arc, total);   /* + = o ahead of me */
        const dLat = o.lat - meLat;                 /* + = o to my left */
        const aLat = Math.abs(dLat), aArc = Math.abs(dArc);
        if (aLat > AI_LAT_BAND && aArc > DRAFT_RANGE) continue;
        /* side-by-side clearance: a car overlapping fore/aft within my min gap.
           leftGap/rightGap keep the nearest REAL lateral gap so the separation
           servo can push apart proportionally instead of just freezing. */
        const segMe = track.surface.segments[n.f.seed.progress ? n.f.seed.progress.seg : 0];
        const uMe = n.f.seed.progress ? clamp(n.f.seed.progress.u, 0, 1) : 0.5;
        const reachMe = aiBodyDlatReach(n.car, segMe, uMe);
        const oF = o.f || fieldOf(o.car);
        const prO = oF && oF.seed && oF.seed.progress;
        const segO = track.surface.segments[prO ? prO.seg : (n.f.seed.progress ? n.f.seed.progress.seg : 0)];
        const uO = prO ? clamp(prO.u, 0, 1) : uMe;
        const reachO = aiBodyDlatReach(o.car, segO, uO);
        const bodySpan = reachMe + reachO;
        const edgeGap = aLat - bodySpan;
        if (aArc < AI_OVERLAP_HALF * 3.4 && aLat < bodySpan + AI_LANE_SPACING * 0.95) {
          s.sideCars++;
          if (dLat > reachMe * 0.35) s.carsLeft++;
          else if (dLat < -reachMe * 0.35) s.carsRight++;
          if (dLat > 0) {
            if (dLat < s.leftGap) s.leftGap = dLat;
            if (edgeGap < s.leftEdge) s.leftEdge = edgeGap;
            if (edgeGap < AI_CONTACT_HARD) s.left = 2;
            else if (edgeGap < AI_MIN_SIDE_CLEAR) s.left = 1;
          } else {
            if (-dLat < s.rightGap) s.rightGap = -dLat;
            if (edgeGap < s.rightEdge) s.rightEdge = edgeGap;
            if (edgeGap < AI_CONTACT_HARD) s.right = 2;
            else if (edgeGap < AI_MIN_SIDE_CLEAR) s.right = 1;
          }
          if (s.left === 2 && s.right === 2 && aArc < AI_OVERLAP_HALF) s.threeWide++;
        }
        /* follow trim only — gentle throttle ease, not stand-on-brakes */
        if (dArc > 0 && dArc < 18 && aLat < AI_CAR_HALF_W * 1.05 && o.spd < meSpd - 1.4) {
          const closing = Math.max(0, meSpd - o.spd);
          if (closing > 1.8 || dArc < 6) {
            const stopDist = (closing * closing) / (2 * AI_AVOID_DECEL);
            const raw = (dArc - AI_OVERLAP_HALF - stopDist) / Math.max(5, AI_LIFT_WINDOW);
            const lift = clamp(0.82 + raw * 0.18, 0.82, 1);
            if (lift < s.liftAhead) { s.liftAhead = lift; s.aheadSpd = o.spd; s.aheadGap = dArc; }
          }
        }
        /* draft: nearest car ahead in the wake band (reuse s._ahead, no alloc) */
        if (dArc > 0 && dArc < DRAFT_RANGE && aLat < DRAFT_LATERAL) {
          if (!s.ahead || dArc < s._ahead.dArc) {
            s._ahead.car = o.car; s._ahead.dArc = dArc; s._ahead.dLat = dLat; s._ahead.closing = meSpd - o.spd;
            s.ahead = s._ahead;
          }
        }
        /* defend: nearest FASTER chaser behind */
        if (dArc < 0 && -dArc < AI_SPOT_BEHIND_M && o.spd > meSpd + 0.5) {
          if (!s.behind || -dArc < -s._behind.dArc) {
            s._behind.car = o.car; s._behind.dArc = dArc; s._behind.dLat = dLat; s._behind.closing = o.spd - meSpd;
            s.behind = s._behind;
          }
        }
        /* column chain: chase the car ahead/behind in MY groove (dynamic gaps, not row-locked) */
        if (aiSameColumn(n.f, o.f, meLat, o.lat)) {
          if (dArc > 0.4 && dArc < DRAFT_RANGE * 1.15 && aLat < DRAFT_LATERAL * 1.35) {
            if (!s.colAhead || dArc < s._colAhead.dArc) {
              s._colAhead.car = o.car; s._colAhead.dArc = dArc; s._colAhead.dLat = dLat;
              s._colAhead.closing = meSpd - o.spd;
              s.colAhead = s._colAhead;
            }
          }
          if (dArc < -0.4 && -dArc < DRAFT_RANGE * 1.05 && aLat < DRAFT_LATERAL * 1.35) {
            if (!s.colBehind || -dArc < -s._colBehind.dArc) {
              s._colBehind.car = o.car; s._colBehind.dArc = dArc; s._colBehind.dLat = dLat;
              s._colBehind.closing = o.spd - meSpd;
              s.colBehind = s._colBehind;
            }
          }
        }
        /* side-draft: a car in my alongside window */
        if (aArc < SIDE_DRAFT_LONG && aLat > SIDE_DRAFT_LAT_MIN && aLat < SIDE_DRAFT_LAT_MAX) {
          s._along.car = o.car; s._along.side = dLat > 0 ? 1 : -1;
          s.alongside = s._along;
        }
      }

      /* groove occupancy: how many lanes exist here and which are taken (spotter) */
      const pr = n.f.seed.progress;
      const segIdx = pr ? pr.seg : 0;
      const uSpot = pr ? clamp(pr.u, 0, 1) : 0.5;
      const segSpot = track.surface.segments[segIdx];
      const grooves = aiGroovesInBand(segSpot, uSpot);
      const occ = s._slotOcc;
      occ.length = grooves.length;
      for (let gi = 0; gi < grooves.length; gi++) occ[gi] = 0;
      const half = aiGrooveSlotHalf();
      for (const o of _aiAll) {
        if (o === n || o.car === n.car) continue;
        if (Math.abs(arcGap(meArc, o.arc, total)) > AI_SLOT_ARC) continue;
        for (let gi = 0; gi < grooves.length; gi++) {
          if (Math.abs(o.lat - grooves[gi]) < half) occ[gi]++;
        }
      }
      s.laneSlots = grooves.length;
      s.mySlot = 0;
      let bestSlotD = Infinity;
      for (let gi = 0; gi < grooves.length; gi++) {
        const d = Math.abs(grooves[gi] - meLat);
        if (d < bestSlotD) { bestSlotD = d; s.mySlot = gi; }
      }
      s.openUp = 0; s.openDown = 0;
      for (let gi = s.mySlot + 1; gi < grooves.length; gi++) if (occ[gi] === 0) s.openUp++;
      for (let gi = s.mySlot - 1; gi >= 0; gi--) if (occ[gi] === 0) s.openDown++;
      s.slotCars = occ[s.mySlot] || 0;
      s.dirtyAir = !!(s.ahead && s._ahead.dArc < DIRTY_AIR_RANGE);
      /* paired-groove spotter: outside row must see inside-row body before diving in turns */
      if (n.f.gridCol != null && grooves.length >= 2) {
        const packG = aiPackGrooves(segSpot, uSpot);
        if (packG.length >= 2) {
          const partnerG = n.f.gridCol === 1 ? packG[packG.length - 1] : packG[0];
          const halfP = aiGrooveSlotHalf() + aiBodyHalfW() * 0.2;
          for (const o of _aiAll) {
            if (o === n || o.car === n.car) continue;
            if (Math.abs(o.lat - partnerG) >= halfP) continue;
            const dArc = arcGap(meArc, o.arc, total);
            if (dArc < -10 || dArc > 42) continue;
            if (!s.partnerLane || (dArc > -2 && dArc < s._partner.dArc)) {
              s._partner.car = o.car; s._partner.dArc = dArc; s._partner.dLat = o.lat - meLat;
              s._partner.closing = dArc > 0 ? meSpd - o.spd : o.spd - meSpd;
              s.partnerLane = s._partner;
            }
          }
        }
      }
    }
    /* the PLAYER's own draft picture (ahead in the wake + alongside on a quarter)
       so the real draft forces apply to the human car too — "if I'm behind /
       beside a car I should get a boost". */
    if (aiPlayerNode) {
      if (!playerSense) playerSense = makeSense();
      const s = playerSense;
      s.ahead = null; s.alongside = null;
      const meLat = aiPlayerNode.lat, meSpd = aiPlayerNode.spd, meArc = aiPlayerNode.arc;
      for (const o of _aiNodes) {
        if (o.car === car) continue;
        const dArc = arcGap(meArc, o.arc, total);
        const dLat = o.lat - meLat;
        const aLat = Math.abs(dLat), aArc = Math.abs(dArc);
        if (dArc > 0 && dArc < DRAFT_RANGE && aLat < DRAFT_LATERAL) {
          if (!s.ahead || dArc < s._ahead.dArc) {
            s._ahead.car = o.car; s._ahead.dArc = dArc; s._ahead.dLat = dLat; s._ahead.closing = meSpd - o.spd;
            s.ahead = s._ahead;
          }
        }
        if (aArc < SIDE_DRAFT_LONG && aLat > SIDE_DRAFT_LAT_MIN && aLat < SIDE_DRAFT_LAT_MAX) {
          s._along.car = o.car; s._along.side = dLat > 0 ? 1 : -1;
          s.alongside = s._along;
        }
      }
    } else {
      playerSense = null;
    }
  }

  /* REAL DRAFT AERO. Once per substep, translate the sense picture into external
     velocity nudges on c.u (the physics already takes impulses this way, line
     ~1797 — physics.js untouched). Behind draft = forward boost scaled by how
     tucked-in you are; side draft = boost the quarter-panel car AND bleed the
     leader (I take their air); AI bump-draft = a small shove to the car ahead on
     a straight only. Moves the player and the AI alike, so drafting is real. */
  function applyDraftToCar(c, s, dt, f) {
    if (!c) return;
    if (f && f.tandem) { c.u += TANDEM_ACCEL * dt; return; }   /* locked pair: strong tow, both cars */
    if (!s) return;
    const draftCar = (s.colAhead && s.colAhead.dArc > 0 && s.colAhead.dArc < DRAFT_RANGE)
      ? s.colAhead : (s.ahead && s.ahead.dArc > 0 && s.ahead.dArc < DRAFT_RANGE ? s.ahead : null);
    if (draftCar) {
      const closeness = 1 - draftCar.dArc / DRAFT_RANGE;
      c.u += DRAFT_ACCEL * closeness * dt;
      if (f && f.aggression > 0.92 && f.onStraight && draftCar.dArc < BUMP_DRAFT_GAP && draftCar.car && !aiCaution) {
        f.bumpClock -= dt;
        if (f.bumpClock <= 0) { draftCar.car.u += BUMP_DRAFT_DV; f.bumpClock = BUMP_DRAFT_INTERVAL; }
      }
    }
    if (s.alongside && s.alongside.car) {
      const sideEdge = Math.min(
        Number.isFinite(s.leftEdge) ? s.leftEdge : aiLatEdge(s.leftGap),
        Number.isFinite(s.rightEdge) ? s.rightEdge : aiLatEdge(s.rightGap));
      if (sideEdge >= AI_MIN_SIDE_CLEAR) {
        c.u += SIDE_DRAFT_ACCEL * dt;                 /* I get a side-draft tow */
        s.alongside.car.u -= SIDE_DRAFT_LEADER * dt;  /* …and I bleed the car I'm beside */
      }
    }
  }
  function applyDraftForces(dt) {
    if (!aiCum) return;
    for (const f of fieldCars) if (f.awake && f.ai && f.sense) applyDraftToCar(f.car, f.sense, dt, f);
    if (car && playerSense) applyDraftToCar(car, playerSense, dt, null);
  }

  /* one physics substep for the entire field — called from simStepOnce so the
     player's post-collision snapshot is taken in the same tick (no lag). */
  function stepFieldCars(playerSurf) {
    if (!fieldCars.length) return;
    let _pt = PERF.on ? performance.now() : 0;
    aiSenseField(playerSurf);   /* refresh every AI car's neighbour picture first */
    if (PERF.on) { const _n = performance.now(); PERF.sense += _n - _pt; _pt = _n; }
    for (const f of fieldCars) if (f.awake) stepOtherCar(f);
    if (PERF.on) { const _n = performance.now(); PERF.step += _n - _pt; _pt = _n; }
    resolveCarCar();
    applyDraftForces(FIXED_DT);   /* real draft/side-draft/bump velocity nudges (player + AI) */
    if (PERF.on) PERF.carcar += performance.now() - _pt;
    for (const f of fieldCars) {
      if (!f.awake) continue;
      const c = f.car;
      /* roll the wheels at the PHYSICS rate (decoupled from the display), and
         keep the two most-recent sim states so the render can interpolate
         between them every frame instead of snapping at 60 Hz (the blur). */
      for (let w = 0; w < 4; w++) f.spin[w] = (f.spin[w] + (c.wheelOmega[w] || 0) * FIXED_DT) % (2 * Math.PI);
      f.snapPrev = f.snapCur;
      f.snapCur = c.snapshot();
      if (!f.ai) updateFieldSleep(f);   /* racers never sleep */
    }
  }

  /* trackGroup-local render matrix for a field car — same smoothed compose path
     as placeCar (per-car render state on f.render). */
  function composeFieldMatrix(f, snap, surfArg, dt) {
    const surfBase = surfArg || f.surf || { height: 0, up: [0, 0, 1] };
    const surf = (snap.airborne || snap.restingOnBody)
      ? { ...surfBase, up: [0, 0, 1] }
      : surfBase;
    const xMid = carShape ? (carShape.xMid || 0) : 0;
    if (!f.render) f.render = makeRenderSmooth();
    const pose = computeSmoothCarPose(snap, surf, dt, f.render,
      { xMid, floorZ, bodyPts: f.car.bodyPts, directRender: true });
    _fieldP.set(pose.x, pose.y, pose.z);
    _fieldQ.set(pose.quat[1], pose.quat[2], pose.quat[3], pose.quat[0]);
    return _fieldMat.compose(_fieldP, _fieldQ, _fieldS);
  }

  /* write a matrix into every mesh that draws slot f.slot: its unique-paint
     body Mesh(es) plus index f.slot of each shared InstancedMesh part */
  function writeSlotMatrix(f, M) {
    for (const mesh of f.body) { mesh.matrix.copy(M); mesh.matrixWorldNeedsUpdate = true; }
    for (const inst of f.inst) inst.setMatrixAt(f.slot, M);
  }

  /* blend two field-car sim snapshots for smooth rendering between fixed steps
     — same rule as the player's interpRenderState: slerp the continuous poseQuat
     and lerp contactFade across EVERY regime (no hard-snap at the ground↔air
     flip — that lurched AI cars ~1 m at takeoff/landing); only a teleport-scale
     jump snaps hard to current. */
  /* Teleport guard for the field interpolator, SPEED-AWARE.
     THE AI "VIBRATION": the old gate was a flat 0.18 m, but that is SMALLER
     than the distance a racing car legitimately covers in one 1/60 s step
     (0.45 m at 60 mph, 1.34 m at 180). So every AI above ~24 mph failed the
     gate, got `return b`, and rendered with NO interpolation at all — snapping
     to the 60 Hz sim quantum on a 120 Hz display, i.e. shaking. The player
     never shook because interpRenderState has no such gate.
     The gate is not what protects against teleports anyway: spawn and sleep
     both sync snapPrev = snapCur (a === b → early out). So scale it off what
     the car's own velocity can actually produce in a step — real motion always
     interpolates at any speed (incl. the 5x AI-speed slider), and only a true
     teleport (respawn / grid place, orders of magnitude larger) still snaps. */
  function fieldStepGate(f) {
    const c = f.car;
    const spd = Math.hypot(c.u || 0, c.v || 0);      /* m/s the car is actually doing */
    return Math.max(0.5, spd * FIXED_DT * 3);        /* 3x headroom over one step's travel */
  }

  function interpFieldSnap(a, b, t, maxStep) {
    if (!a || t >= 1 || a === b) return b;
    const dx = b.x - a.x, dy = b.y - a.y;
    const gate = maxStep || 0.5;
    if (dx * dx + dy * dy > gate * gate) return b;
    const L = (p, q) => p + (q - p) * t;
    return { ...b,
      x: L(a.x, b.x), y: L(a.y, b.y), z: L(a.z, b.z),
      yaw: Physics.lerpAngle(a.yaw, b.yaw, t),
      pitch: L(a.pitch, b.pitch), roll: L(a.roll, b.roll),
      heave: L(a.heave || 0, b.heave || 0),
      contactFade: interpContactFade(a, b, t),
      airborne: a.airborne || b.airborne,
      restingOnBody: a.restingOnBody || b.restingOnBody,
      quat: (a.quat && b.quat) ? Physics.qSlerp(a.quat, b.quat, t) : b.quat,
      poseQuat: (a.poseQuat && b.poseQuat) ? Physics.qSlerp(a.poseQuat, b.poseQuat, t)
        : (b.poseQuat || a.poseQuat) };
  }

  /* re-pose the awake cars EVERY display frame, interpolating between the two
     latest sim states by tBlend (kills the 60 Hz strobe/blur on a fast car),
     and spin their wheels off the sim-rate angle. Sleepers keep their last
     matrix — a crashed car stays where it landed. */
  function renderFieldCars(tBlend, dt) {
    if (!fieldCars.length) return;
    const _pfr = PERF.on ? performance.now() : 0;
    const phys = carFieldGroup && carFieldGroup.userData && carFieldGroup.userData.phys;
    const wheels = (phys && phys.wheelParts) || [];
    const touched = new Set();
    for (const f of fieldCars) {
      if (!f.awake || !f.snapCur) continue;
      const snap = interpFieldSnap(f.snapPrev, f.snapCur, tBlend, fieldStepGate(f));
      /* interpolate the surface too (height + banking normal) between the two
         fixed steps — without this the body's vertical anchor and tilt strobe at
         60 Hz on a faster display while x/y glide: the AI-car "vibrate/stutter".
         Only when the pose itself interpolated (snap!==snapCur → no teleport). */
      let surf = f.surf;
      if (snap !== f.snapCur && f.surfPrev && f.surfPrev !== f.surf) {
        const pa = f.surfPrev, pb = f.surf;
        const ux = pa.up[0] + (pb.up[0] - pa.up[0]) * tBlend;
        const uy = pa.up[1] + (pb.up[1] - pa.up[1]) * tBlend;
        const uz = pa.up[2] + (pb.up[2] - pa.up[2]) * tBlend;
        const n = Math.hypot(ux, uy, uz) || 1;
        surf = { ...pb, height: pa.height + (pb.height - pa.height) * tBlend, up: [ux / n, uy / n, uz / n] };
      }
      _carMat.copy(composeFieldMatrix(f, snap, surf, dt));
      if (!f.mat) f.mat = new THREE.Matrix4();
      f.mat.copy(_carMat);                       /* trackGroup-local pose → camera focus proxy */
      writeSlotMatrix(f, _carMat);               /* body + every part at the car pose */
      for (const inst of f.inst) touched.add(inst);
      /* overwrite the wheel instances with a car-local axle spin under the car */
      const steer = f.snapCur.steer || 0;
      for (const wp of wheels) {
        _wheelE.set(0, f.spin[wp.idx], wp.front ? steer : 0, 'ZYX');
        _wheelR.makeRotationFromEuler(_wheelE);
        _wheelLocal.makeTranslation(wp.center.x, wp.center.y, wp.center.z)
          .multiply(_wheelR)
          .multiply(_wheelT.makeTranslation(-wp.center.x, -wp.center.y, -wp.center.z));
        wp.inst.setMatrixAt(f.slot, _wheelWorld.multiplyMatrices(_carMat, _wheelLocal));
      }
    }
    for (const inst of touched) inst.instanceMatrix.needsUpdate = true;
    if (PERF.on) PERF.fieldR += performance.now() - _pfr;
  }

  /* stop stepping the field and restore every slot to its authored parked pose */
  /* ---- AI racing geometry helpers (all operate on the lofted centreline) ---- */
  function segLen(seg) {
    return seg.arc ? Math.abs(seg.arc.r * seg.arc.dth)
      : Math.hypot(seg.block.x1 - seg.block.x0, seg.block.y1 - seg.block.y0);
  }
  /* dlong: scalar arc-length of a (seg,u) measured from spawn — the track-frame
     longitudinal axis every neighbor comparison runs on (standard dlong model). */
  function segDlong(segIdx, u) {
    if (!aiCum) return 0;
    return aiCum.cum[segIdx] + clamp(u, 0, 1) * segLen(track.surface.segments[segIdx]);
  }
  /* signed wrapped arc gap b−a, folded to (−total/2, total/2]; + = b is ahead of a */
  function arcGap(a, b, total) {
    let d = b - a;
    while (d > total / 2) d -= total;
    while (d <= -total / 2) d += total;
    return d;
  }
  function segHalfWidth(seg) {
    let hw = 0;
    for (const x of seg.xsecs) hw = Math.max(hw, Math.abs(x.d0), Math.abs(x.d1));
    return hw;
  }
  /* the WALL-bounded drivable band (dlat of the nearest collidable wall on each
     side). The cross-section width includes apron + grass BEYOND the walls, so
     clamping the racing line to segHalfWidth aimed AI cars past the barrier;
     this keeps them on the actual track. Infinity when a side is open. */
  function segWallLimits(seg, u) {
    let pos = Infinity, neg = -Infinity;
    for (const w of (seg.walls || [])) {
      const f = Physics.wallTrackFaces(w, u);
      if (!Physics.isWallCollidable(w, u, f.wd)) continue;   /* f.wd = at the wall, never skipped as "far" */
      if (f.side > 0) { if (f.trackFace < pos) pos = f.trackFace; }
      else if (f.trackFace > neg) neg = f.trackFace;
    }
    return { pos, neg };
  }
  /* walk `dist` m forward along the centreline from (k,u); returns the point +
     tangent there (wraps around the closed loop) */
  function aiAdvance(k, u, dist) {
    const segs = track.surface.segments, N = segs.length;
    let kk = ((k % N) + N) % N, uu = u, rem = dist;
    for (let g = 0; g < N + 2 && rem > 1e-6; g++) {
      const L = Math.max(1e-3, segLen(segs[kk]));
      const uRem = (1 - uu) * L;
      if (rem <= uRem) { uu += rem / L; rem = 0; }
      else { rem -= uRem; kk = (kk + 1) % N; uu = 0; }
    }
    const c = TrackSurface.sampleCenter(segs[kk], clamp(uu, 0, 1));
    return { k: kk, u: uu, x: c.x, y: c.y, tx: c.tx, ty: c.ty };
  }
  /* tightest turn radius within `dist` m ahead (Infinity on pure straights) */
  function aiMinRadius(k, u, dist) {
    const segs = track.surface.segments, N = segs.length;
    let kk = ((k % N) + N) % N, uu = u, rem = dist, minR = Infinity;
    for (let g = 0; g < N + 2 && rem > 1e-6; g++) {
      const seg = segs[kk];
      if (seg.arc && seg.arc.r < minR) minR = seg.arc.r;
      const L = Math.max(1e-3, segLen(seg));
      rem -= (1 - uu) * L; kk = (kk + 1) % N; uu = 0;
    }
    return minR;
  }
  /* richer sibling of aiMinRadius: the tightest radius within `dist` m ahead AND
     the centreline distance at which that corner BEGINS — the predictive-brake
     input (how far off is the limiting corner, so we brake at the right point). */
  function aiCornerAhead(k, u, dist) {
    const segs = track.surface.segments, N = segs.length;
    let kk = ((k % N) + N) % N, uu = u, rem = dist, minR = Infinity, distToMinR = Infinity, travelled = 0, bankSeg = null;
    for (let g = 0; g < N + 2 && rem > 1e-6; g++) {
      const seg = segs[kk];
      if (seg.arc && seg.arc.r < minR) { minR = seg.arc.r; distToMinR = travelled; bankSeg = seg; }
      const L = Math.max(1e-3, segLen(seg));
      const step = (1 - uu) * L;
      travelled += step; rem -= step; kk = (kk + 1) % N; uu = 0;
    }
    /* banking AT the limiting corner (lateral height gradient at its centre) — the
       corner-speed grip must be graded by the bank THERE, not by the flatter entry
       the car brakes from (a Charlotte 24° turn carries far more than its flat
       approach; grading by entry bank = phantom braking on corner entry). */
    let bankTan = 0;
    if (bankSeg) {
      const eps = 0.3;
      bankTan = Math.abs((TrackSurface.heightAt(bankSeg, eps, eps, 0.5)
        - TrackSurface.heightAt(bankSeg, -eps, -eps, 0.5)) / (2 * eps));
    }
    return { minR, distToMinR: Number.isFinite(distToMinR) ? distToMinR : Infinity, bankTan };
  }
  /* absolute centreline point at a distance measured from segment 0 (spawn) */
  function aiPointAtDistance(dist) {
    const segs = track.surface.segments, N = segs.length;
    let acc = 0;
    for (let k = 0; k < N; k++) {
      const L = segLen(segs[k]);
      if (acc + L >= dist) {
        const u = clamp((dist - acc) / L, 0, 1);
        const c = TrackSurface.sampleCenter(segs[k], u);
        return { k, u, x: c.x, y: c.y, tx: c.tx, ty: c.ty };
      }
      acc += L;
    }
    const c = TrackSurface.sampleCenter(segs[N - 1], 1);
    return { k: N - 1, u: 1, x: c.x, y: c.y, tx: c.tx, ty: c.ty };
  }
  /* reference grooves — aiLaneOffsets are the drawn ribbons; snap/pass targets here */
  function aiGroovesSorted() {
    const g = aiLaneOffsets.length ? aiLaneOffsets.slice() : [0];
    return g.sort((a, b) => a - b);
  }
  function nearestAiGroove(dlat, seg, u) {
    const band = seg && u != null ? aiLaneBand(seg, u) : { lo: -30, hi: 30 };
    const grooves = aiLaneOffsets.length ? aiLaneOffsets : [0];
    let best = clamp(dlat, band.lo, band.hi), dist = Infinity;
    for (const g of grooves) {
      const c = clamp(g, band.lo, band.hi);
      const d = Math.abs(c - dlat);
      if (d < dist) { dist = d; best = c; }
    }
    return best;
  }
  function adjacentAiGroove(dlat, dir, seg, u) {
    const band = aiLaneBand(seg, u);
    const uniq = [];
    for (const g of aiGroovesSorted()) {
      const c = clamp(g, band.lo, band.hi);
      if (!uniq.length || Math.abs(c - uniq[uniq.length - 1]) > 0.05) uniq.push(c);
    }
    if (!uniq.length) return clamp(dlat, band.lo, band.hi);
    let idx = 0, best = Infinity;
    for (let i = 0; i < uniq.length; i++) {
      const d = Math.abs(uniq[i] - dlat);
      if (d < best) { best = d; idx = i; }
    }
    return uniq[clamp(idx + dir, 0, uniq.length - 1)];
  }

  function aiGroovesInBand(seg, u) {
    const band = aiLaneBand(seg, u);
    const uniq = [];
    for (const g of aiGroovesSorted()) {
      const c = clamp(g, band.lo, band.hi);
      if (!uniq.length || Math.abs(c - uniq[uniq.length - 1]) > 0.05) uniq.push(c);
    }
    return uniq.length ? uniq : [0];
  }
  /* NASCAR pack law (traffic only): inside + second groove — no 3rd/4th lane fan-out
     in door-to-door racing. Clean air keeps full groove freedom for passes. */
  function aiPackGrooves(seg, u) {
    const grooves = aiGroovesInBand(seg, u);
    if (grooves.length <= 2) return grooves.slice();
    const insideFirst = grooves.slice().sort((a, b) => aiInsideSign >= 0 ? b - a : a - b);
    const inside = insideFirst[0];
    let second = insideFirst[Math.min(1, insideFirst.length - 1)];
    for (let i = 1; i < insideFirst.length; i++) {
      if (Math.abs(insideFirst[i] - inside) > 0.55) { second = insideFirst[i]; break; }
    }
    return [second, inside].sort((a, b) => a - b);
  }
  function aiInPackTraffic(f, s) {
    if (!s) return false;
    if (s.sideCars >= 1 || (s.threeWide || 0) >= 1) return true;
    if (aiInTraffic(f, s)) return true;
    if (f.race && f.race.wraps < 1) return true;
    return false;
  }
  function nearestPackGroove(dlat, seg, u) {
    const g = aiPackGrooves(seg, u);
    let best = g[0], dist = Infinity;
    for (const gv of g) {
      const d = Math.abs(gv - dlat);
      if (d < dist) { dist = d; best = gv; }
    }
    return best;
  }
  function clampAiPackTwoWide(dlat, f, s, seg, u) {
    if (!aiInPackTraffic(f, s)) return dlat;
    return nearestPackGroove(dlat, seg, u);
  }
  function adjacentPackGroove(dlat, dir, seg, u) {
    const g = aiPackGrooves(seg, u);
    if (g.length < 2) return g[0] || dlat;
    const idx = Math.abs(g[1] - dlat) < Math.abs(g[0] - dlat) ? 1 : 0;
    return g[clamp(idx + dir, 0, 1)];
  }
  function adjacentAiGrooveFor(f, s, dlat, dir, seg, u) {
    if (f && s && aiInPackTraffic(f, s)) return adjacentPackGroove(dlat, dir, seg, u);
    return adjacentAiGroove(dlat, dir, seg, u);
  }

  function aiGrooveSlotHalf() { return AI_LANE_SPACING * 0.42; }
  /* spotter: is a target groove empty along-track near me? */
  function aiGrooveSlotClear(meArc, targetDlat, selfNode) {
    if (!aiCum) return true;
    const half = aiGrooveSlotHalf();
    for (const o of _aiAll) {
      if (o === selfNode || o.car === selfNode.car) continue;
      if (Math.abs(o.lat - targetDlat) >= half) continue;
      if (Math.abs(arcGap(meArc, o.arc, aiCum.total)) < AI_SLOT_ARC) return false;
    }
    return true;
  }
  /* merge-window only — cars far ahead in that groove are fine (draft/pass behind them) */
  function aiMergeWindowClear(meArc, targetDlat, selfCar) {
    if (!aiCum) return true;
    const total = aiCum.total;
    const half = aiGrooveSlotHalf() + 0.18;
    const win = AI_OVERLAP_HALF * 2.4;
    for (const o of _aiAll) {
      if (o.car === selfCar) continue;
      if (Math.abs(o.lat - targetDlat) >= half) continue;
      if (Math.abs(arcGap(meArc, o.arc, total)) < win) return false;
    }
    return true;
  }
  function aiPathLaneClear(meArc, targetDlat, selfCar) {
    return aiMergeWindowClear(meArc, targetDlat, selfCar);
  }
  /* pack spread / pass: lighter than full elite merge — just need a bubble + merge window */
  function aiSpreadReady(f, dir, seg, u, lat, meArc, urgent) {
    const s = f.sense || SENSE_DEFAULT;
    const target = adjacentAiGrooveFor(f, s, lat, dir, seg, u);
    if (Math.abs(target - lat) < 0.15) return false;
    const gap = dir > 0 ? s.leftGap : s.rightGap;
    const lookT = dir > 0 ? (f.lookPos || 0) : (f.lookNeg || 0);
    const gapReq = urgent ? aiCentreClearTarget(AI_CONTACT_HARD) + 0.1 : aiCentreClearTarget(AI_MIN_SIDE_CLEAR);
    const lookReq = urgent ? 0.04 : AI_LOOK_CLEAR_S * 0.5;
    return gap >= gapReq
      && aiMergeWindowClear(meArc, target, f.car)
      && lookT >= lookReq;
  }
  /* elite defend-only: wider bubble */
  function aiLaneChangeReady(f, dir, seg, u, lat, meArc) {
    const s = f.sense || SENSE_DEFAULT;
    const target = adjacentAiGrooveFor(f, s, lat, dir, seg, u);
    if (Math.abs(target - lat) < 0.15) return true;
    const gap = dir > 0 ? s.leftGap : s.rightGap;
    const lookT = dir > 0 ? (f.lookPos || 0) : (f.lookNeg || 0);
    return gap >= aiCentreClearTarget(AI_MIN_SIDE_CLEAR + 0.45)
      && (dir > 0 ? (s.carsLeft || 0) : (s.carsRight || 0)) < 1
      && aiMergeWindowClear(meArc, target, f.car)
      && lookT >= AI_LOOK_CLEAR_S;
  }
  function aiPickSpreadSide(f, seg, u, lat, meArc, urgent) {
    const s = f.sense || SENSE_DEFAULT;
    const up = 1, down = -1;
    if (urgent) {
      const tgtUp = adjacentAiGrooveFor(f, s, lat, up, seg, u);
      const tgtDn = adjacentAiGrooveFor(f, s, lat, down, seg, u);
      const ctrRub = aiCentreClearTarget(AI_CONTACT_HARD);
      const upTry = Math.abs(tgtUp - lat) > 0.15 && s.leftGap >= ctrRub
        && aiMergeWindowClear(meArc, tgtUp, f.car);
      const dnTry = Math.abs(tgtDn - lat) > 0.15 && s.rightGap >= ctrRub
        && aiMergeWindowClear(meArc, tgtDn, f.car);
      if (upTry && !dnTry) return up;
      if (dnTry && !upTry) return down;
      if (upTry && dnTry) return s.leftGap >= s.rightGap ? up : down;
    }
    const upOk = (s.openUp || 0) > 0 && aiSpreadReady(f, up, seg, u, lat, meArc, urgent);
    const downOk = (s.openDown || 0) > 0 && aiSpreadReady(f, down, seg, u, lat, meArc, urgent);
    if (upOk && !downOk) return up;
    if (downOk && !upOk) return down;
    if (upOk && downOk) {
      const upGap = s.leftGap, downGap = s.rightGap;
      return upGap >= downGap ? up : down;
    }
    return 0;
  }
  /* pick pass direction: spread-ready + prefer open groove */
  function aiPickPassSide(f, seg, u, lat, meArc, highDir) {
    const s = f.sense || SENSE_DEFAULT;
    const up = highDir, down = -highDir;
    const upGap = s.leftGap, downGap = s.rightGap;
    const upOk = aiSpreadReady(f, up, seg, u, lat, meArc);
    const downOk = aiSpreadReady(f, down, seg, u, lat, meArc);
    if (upOk && !downOk) return up;
    if (downOk && !upOk) return down;
    if (upOk && downOk) {
      const upSideGap = up > 0 ? upGap : downGap;
      const downSideGap = down > 0 ? upGap : downGap;
      return upSideGap >= downSideGap ? up : down;
    }
    return 0;
  }
  function aiPassSurf(f) {
    const s = f.surf;
    const segs = track && track.surface && track.surface.segments;
    const seg = (s && s.seg) || (segs && segs[0]) || null;
    const u = s && Number.isFinite(s.u) ? s.u : 0.5;
    const lat = s && Number.isFinite(s.dlat) ? s.dlat : f.lane;
    return { seg, u, lat };
  }
  /* pick a reference groove for grid/spawn: inside column = apron-side groove */
  function aiGridGroove(col, row, seg, u) {
    const band = aiLaneBand(seg, u);
    const grooves = aiGroovesSorted().map((g) => clamp(g, band.lo, band.hi));
    if (!grooves.length) return 0;
    const uniq = [];
    for (const g of grooves) {
      if (!uniq.length || Math.abs(g - uniq[uniq.length - 1]) > 0.05) uniq.push(g);
    }
    const insideFirst = uniq.slice().sort((a, b) => aiInsideSign >= 0 ? b - a : a - b);
    if (col === 0) return insideFirst[0];
    return insideFirst[Math.min(insideFirst.length - 1, 1)];
  }

  /* rolling field spread evenly around the whole track, staggered across lanes */
  function aiSpawnPoses(count) {
    const segs = track.surface.segments;
    const total = segs.reduce((s, seg) => s + segLen(seg), 0);
    const gap = total / count;
    const out = [];
    for (let i = 0; i < count; i++) {
      const col = i % 2;
      const p = aiPointAtDistance((i * gap) % total);
      const groove = aiGridGroove(col, Math.floor(i / 2), segs[p.k], p.u);
      const nx = -p.ty, ny = p.tx;
      out.push({ x: p.x + nx * groove, y: p.y + ny * groove,
        heading: Math.atan2(p.ty, p.tx), lane: groove, col, seg: p.k, u: p.u });
    }
    return out;
  }

  /* strip bands at u — same edges classifyGrassAt uses (texture = grass/apron). */
  function aiStripBands(seg, u) {
    const strips = seg && seg.strips;
    if (!strips || !strips.length) return null;
    const edgeAt = (s) => s.d0 + (s.d1 - s.d0) * u;
    const out = [];
    for (let i = 0; i < strips.length; i++) {
      const lo = edgeAt(strips[i]);
      const hi = i + 1 < strips.length ? edgeAt(strips[i + 1]) : lo + 500;
      let s = strips[i];
      if (!s.texture) {
        s = strips.slice(i + 1).find((x) => x.texture)
          || [...strips.slice(0, i)].reverse().find((x) => x.texture) || s;
      }
      out.push({ lo, hi, grass: isGrassTexture(s.texture) });
    }
    return out;
  }
  /* lateral extent of the PAVED racing surface (asphalt/concrete, not apron/grass).
     The cross-section halfWidth includes apron beyond the yellow — clamping to walls
     alone let AI race on the apron between the line and the infield wall. */
  function aiPavedBounds(seg, u) {
    const bands = aiStripBands(seg, u);
    if (!bands || !bands.length) return null;
    let idx = bands.findIndex((b) => 0 >= b.lo && 0 < b.hi);
    if (idx < 0) {
      let best = -1, bestD = Infinity;
      for (let i = 0; i < bands.length; i++) {
        if (bands[i].grass) continue;
        const mid = (bands[i].lo + bands[i].hi) * 0.5;
        const d = Math.abs(mid);
        if (d < bestD) { bestD = d; best = i; }
      }
      idx = best;
    }
    if (idx < 0) return null;
    if (bands[idx].grass) {
      let lo = Infinity, hi = -Infinity, ok = false;
      for (const b of bands) {
        if (!b.grass) { lo = Math.min(lo, b.lo); hi = Math.max(hi, b.hi); ok = true; }
      }
      return ok && lo < hi ? { lo, hi } : null;
    }
    let lo = bands[idx].lo, hi = bands[idx].hi;
    for (let i = idx - 1; i >= 0 && !bands[i].grass; i--) lo = bands[i].lo;
    for (let i = idx + 1; i < bands.length && !bands[i].grass; i++) hi = bands[i].hi;
    return { lo, hi };
  }

  /* absolute dlat of the yellow line at (seg,u) — the inner edge AI must not cross. */
  function aiYellowLineDlat(seg, u) {
    const band = aiLaneBand(seg, u);
    return aiInsideSign >= 0 ? band.hi : band.lo;
  }

  /* the AI's usable lateral band at (seg,u): inside the collidable walls by
     AI_WALL_MARGIN, AND held off the apron on the inside (the yellow line) by
     AI_INSIDE_MARGIN so racers never drop under the line. One source of truth for
     the controller and the lane overlay. */
  function aiLaneBand(seg, u) {
    const half = segHalfWidth(seg);
    const lim = segWallLimits(seg, u);
    let hi = Number.isFinite(lim.pos) ? lim.pos : half;
    let lo = Number.isFinite(lim.neg) ? lim.neg : -half;
    const paved = aiPavedBounds(seg, u);
    if (paved) { hi = Math.min(hi, paved.hi); lo = Math.max(lo, paved.lo); }
    const insideMargin = Math.max(AI_INSIDE_MARGIN, AI_YELLOW_LINE_MIN);
    if (aiInsideSign >= 0) {
      hi -= insideMargin;   /* yellow/apron at +dlat — stay below this */
      lo += AI_WALL_MARGIN;
    } else {
      lo += insideMargin;
      hi -= AI_WALL_MARGIN;
    }
    if (hi < lo) { const m = (hi + lo) / 2; hi = m; lo = m; }
    return { lo, hi };
  }

  /* DEBUG OVERLAY: draw the AI grooves as coloured lines on the track so the lane
     structure is visible. Each lane is the centreline offset by a fixed dlat,
     CLAMPED per-segment to the same band the AI actually uses (aiLaneBand) — so
     the lines show exactly where the cars can run (inside=red → outside=purple). */
  const AI_LANE_COLORS = [0xff2d2d, 0xff8a2d, 0xffe22d, 0x39ff39, 0x2de0ff, 0x3a6bff, 0xc23dff];
  function disposeAiLaneOverlay() {
    if (!aiLanesGroup) return;
    aiLanesGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    if (aiLanesGroup.parent) aiLanesGroup.parent.remove(aiLanesGroup);
    aiLanesGroup = null;
  }
  const AI_LANE_RIBBON_W = 0.22;   /* m — ribbon width (thin painted-line look, still visible) */
  /* build ONE lane as a flat ribbon strip (WebGL line width is capped at 1px, so a
     real thick line has to be a quad strip). laneIdx tags it for drag/edit. */
  function buildLaneRibbon(want, color, laneIdx) {
    const segs = track.surface.segments;
    const SUB = 6, hw = AI_LANE_RIBBON_W / 2;
    const verts = [], idx = [];
    let n = 0, firstL = -1, firstR = -1;
    const push = (seg, u) => {
      const c = TrackSurface.sampleCenter(seg, u);
      const band = aiLaneBand(seg, u);
      const dlat = clamp(want, band.lo, band.hi);
      const nx = -c.ty, ny = c.tx;
      const h = TrackSurface.heightAt(seg, dlat, dlat, u) + 0.14;
      verts.push(c.x + nx * (dlat + hw), c.y + ny * (dlat + hw), h);   /* left edge */
      verts.push(c.x + nx * (dlat - hw), c.y + ny * (dlat - hw), h);   /* right edge */
      const L = n * 2, R = n * 2 + 1;
      if (firstL < 0) { firstL = L; firstR = R; }
      if (n > 0) { const pL = (n - 1) * 2, pR = (n - 1) * 2 + 1; idx.push(pL, pR, L, pR, R, L); }
      n++;
    };
    for (let k = 0; k < segs.length; k++) for (let s = 0; s < SUB; s++) push(segs[k], s / SUB);
    /* close the loop back to the first cross-section */
    const pL = (n - 1) * 2, pR = (n - 1) * 2 + 1;
    idx.push(pL, pR, firstL, pR, firstR, firstL);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
    mesh.renderOrder = 997; mesh.frustumCulled = false;
    mesh.userData.laneIdx = laneIdx;   /* which aiLaneOffsets entry this ribbon is */
    return mesh;
  }
  function buildAiLaneOverlay() {
    disposeAiLaneOverlay();
    if (!track || !track.surface || !track.surface.segments || !trackGroup) return;
    aiLanesGroup = new THREE.Group();
    aiLanesGroup.name = 'ai-lanes';
    for (let li = 0; li < aiLaneOffsets.length; li++) {
      aiLanesGroup.add(buildLaneRibbon(aiLaneOffsets[li], AI_LANE_COLORS[li % AI_LANE_COLORS.length], li));
    }
    trackGroup.add(aiLanesGroup);
    aiLanesGroup.visible = aiLanesOn;
  }
  function setAiLanes(on) {
    aiLanesOn = !!on;
    try { localStorage.setItem('re2003.aiLanes', aiLanesOn ? '1' : '0'); } catch (e) {}
    if (aiLanesOn) buildAiLaneOverlay();
    else disposeAiLaneOverlay();
  }
  function setAiTandem(on) {
    aiTandemOn = !!on;
    try { localStorage.setItem('re2003.aiTandem', aiTandemOn ? '1' : '0'); } catch (e) {}
    if (!aiTandemOn) for (const f of fieldCars) if (f.tandem) breakTandem(f);   /* dissolve any locks now */
  }
  /* ---- editable racing lanes ---- */
  function refreshLanesLive() { saveAiLaneOffsets(); if (aiLanesOn) buildAiLaneOverlay(); }
  function getAiLaneOffsets() { return aiLaneOffsets.slice(); }
  function setAiLaneOffset(i, v) {
    if (i < 0 || i >= aiLaneOffsets.length || !Number.isFinite(v)) return;
    aiLaneOffsets[i] = clamp(v, -30, 30);
    refreshLanesLive();
  }
  function addAiLane() {
    const hi = aiLaneOffsets.length ? Math.max.apply(null, aiLaneOffsets) : -1.65;
    aiLaneOffsets.push(clamp(hi + 1.65, -30, 30));
    refreshLanesLive();
    return aiLaneOffsets.length;
  }
  function removeAiLane(i) {
    if (aiLaneOffsets.length <= 1) return aiLaneOffsets.length;   /* keep at least one */
    if (Number.isInteger(i) && i >= 0 && i < aiLaneOffsets.length) aiLaneOffsets.splice(i, 1);
    else aiLaneOffsets.pop();
    refreshLanesLive();
    return aiLaneOffsets.length;
  }
  function collectSteer(c, herr) {
    const maxSteer = (c.p && c.p.maxSteer) || 0.4;
    return clamp((AI_YAW_K1 * herr - AI_YAW_K2 * c.r) / maxSteer, -1, 1);
  }

  /* settled-but-facing-wrong-way: a wall+car-aware K-turn. Measure ACTUAL room on
     each side (aiLaneBand = wall-bounded band) and check neighbouring cars (sense
     field) before committing to a FORWARD arc (nose side clear) or a REVERSE arc
     (tail side clear); if boxed both ways, slide along the wall toward more room
     and let the stuck timer escalate to a tow. Replaces the blind forward↔reverse
     rock that got cars pinned on the wall. */
  function reorient(f, surf, segIdx, herr) {
    const c = f.car, s = f.sense || SENSE_DEFAULT;
    const band = aiLaneBand(track.surface.segments[segIdx], clamp(surf.u, 0, 1));
    const roomLeft = band.hi - surf.dlat;     /* m of clear track to driver's-left  */
    const roomRight = surf.dlat - band.lo;    /* m of clear track to driver's-right */
    const dir = herr >= 0 ? 1 : -1;           /* + = rotate the nose toward track dir (swings left) */
    const noseRoom = dir > 0 ? roomLeft : roomRight;
    const tailRoom = dir > 0 ? roomRight : roomLeft;   /* reverse swings the tail the other way */
    const noseBlocked = dir > 0 ? (s.left === 2) : (s.right === 2);
    const tailBlocked = dir > 0 ? (s.right === 2) : (s.left === 2);
    if (noseRoom > REC_WALL_KEEP && !noseBlocked)
      return { throttle: 0.35, brake: 0, steer: dir, reverse: false, lockUp: false };   /* forward arc */
    if (tailRoom > REC_WALL_KEEP && !tailBlocked)
      return { throttle: 0.35, brake: 0, steer: -dir, reverse: true, lockUp: false };   /* reverse arc (K-turn leg) */
    /* pinned against the wall both ways: nudge along it toward the open side */
    const along = roomLeft > roomRight ? 1 : -1;
    return { throttle: 0.25, brake: 0, steer: along, reverse: false, lockUp: false };
  }

  /* Stuck-timeout escalation: a hopelessly stuck car is repositioned to the low
     groove facing down-track at a gentle rolling speed. Uses only the public
     Physics.Car API (c.reset + settable state), same as field spawn. */
  function towToLine(f, segIdx, u) {
    const c = f.car;
    const cc = TrackSurface.sampleCenter(track.surface.segments[segIdx], clamp(u, 0, 1));
    const heading = Math.atan2(cc.ty, cc.tx);   /* face down-track */
    c.reset({ x: cc.x, y: cc.y, heading });     /* low groove (dlat 0) is safest to rejoin at */
    const ns = sampleSurfaceFor(f.seed, c.x, c.y);
    c.zPos = ns.height; c.vz = 0; c.airborne = false; c.onSurface = true;
    c.u = 12; c.v = 0; c.r = 0;                 /* gentle rolling rejoin */
    f.surf = ns; f.recState = 'race'; f.recClock = 0; f.stuckT = 0; f.lastArc = null;
    f.lane = 0; f.laneTarget = 0;
  }

  /* the recovery dispatcher: SETTLE (collect) → REORIENT (if facing wrong way) or
     REJOIN (aligned + clear) → TOW (stuck timeout). Returns a driving input. */
  function aiRecover(f, surf, segIdx, herr) {
    const c = f.car, spd = c.speed, s = f.sense || SENSE_DEFAULT;
    f.recClock += FIXED_DT;

    /* TOW / RESET: stuck too long AND the track behind is clear → reposition (never
       drop a car into traffic; gate on the clear-behind distance) */
    if (f.stuckT > REC_STUCK_MAX) {
      const behindClear = !s.behind || (-s.behind.dArc) > REC_TOW_CLEARB;
      if (behindClear) { towToLine(f, segIdx, surf.u); return { throttle: 0.2, brake: 0, steer: 0, reverse: false, lockUp: false }; }
    }

    const sliding = Math.abs(c.v) > REC_SETTLE_LAT || Math.abs(c.r) > REC_SETTLE_YAW;

    /* 1) LOCK UP AND STOP: a spun car is out of control — the fastest way back is
       to STAND ON THE BRAKES until it stops, then turn around. Lock the wheels
       (full brake, no ABS, no traction control) with NO steer while it is still
       sliding/spinning OR still carrying speed while pointed the wrong way.
       This replaces the old feathered brake (0.2 above 25 m/s, NONE below) plus
       collectSteer, which let a spun car creep — usually BACKWARDS once it was
       turned around — braking weakly while the steering wagged it side to side
       (the "slow braking in reverse, swerving back and forth until it stops"
       the user reported). Locked wheels can't steer, so steer 0 keeps it tracking
       straight as it scrubs to a halt. */
    const misaligned = Math.abs(herr) > REC_ALIGN_OK;
    /* the speed-gated half only fires while still SETTLING from the spin (not
       once we've committed to a turn-around) so a reorienting car that eases
       past the stop speed isn't yanked back to a lock — that would stutter */
    if (sliding || (misaligned && spd > REC_LOCK_STOP_SPD && f.recState !== 'reorient')) {
      f.recState = 'settle';
      return { throttle: 0, brake: 1, steer: 0, reverse: false, lockUp: true };
    }

    /* settled: rejoin if pointed down-track & the merge path is clear, else reorient */
    if (Math.abs(herr) < REC_ALIGN_OK) {
      const laneClear = (herr >= 0 ? s.left : s.right) !== 2;   /* side I'd drift toward is clear */
      const aheadClear = !s.ahead || s.ahead.dArc > 12;
      if (laneClear && aheadClear) {
        /* 2) REJOIN: hand back to racing, resuming from where the car actually sits */
        f.recState = 'race'; f.stuckT = 0;
        const reBand = aiLaneBand(track.surface.segments[segIdx], clamp(surf.u, 0, 1));
        const reLane = clamp(surf.dlat, reBand.lo, reBand.hi);
        f.lane = reLane; f.laneTarget = reLane;
        return { throttle: 0.2, brake: 0, steer: collectSteer(c, herr), reverse: false, lockUp: false };
      }
      /* aligned but boxed: creep straight until the gap opens (pursuit keeps it straight) */
      f.recState = 'rejoin';
      return { throttle: 0.15, brake: 0, steer: collectSteer(c, herr), reverse: false, lockUp: false };
    }

    /* 3) REORIENT: settled but facing the wrong way → wall+car-aware maneuver */
    f.recState = 'reorient';
    return reorient(f, surf, segIdx, herr);
  }

  /* the controller: pure-pursuit steering to a lookahead point on the car's
     lane, plus a corner-aware target speed. `surf` is the fresh pre-step sample
     (carries seg index in module `progress`, u, dlat, tangent). */
  function aiDriveInput(f, surf, segIdx) {
    const c = f.car, spd = c.speed;
    const s = f.sense || SENSE_DEFAULT;                       /* this substep's neighbour picture */
    const aEff = clamp(f.aggression * (0.5 + aiTune.aggro), 0, 1);   /* personality × global slider */

    /* ---- RECOVERY (recovery state machine): heading error vs track direction + a
       stuck-progress measure drive the machine. The racing body below runs ONLY in
       the 'race' state; any other state hands off to aiRecover (collect the slide,
       reorient wall/car-aware, rejoin when clear, tow on a timeout). ---- */
    const cCtr = TrackSurface.sampleCenter(track.surface.segments[segIdx], clamp(surf.u, 0, 1));
    let herr = Math.atan2(cCtr.ty, cCtr.tx) - c.yaw;
    while (herr > Math.PI) herr -= 2 * Math.PI;
    while (herr < -Math.PI) herr += 2 * Math.PI;
    /* progress / stuck accrual for the tow timeout */
    const arcNow = segDlong(segIdx, surf.u);
    const moved = f.lastArc == null ? 1 : Math.abs(arcGap(f.lastArc, arcNow, aiCum ? aiCum.total : 1e9));
    f.lastArc = arcNow;
    /* LOOK-BEFORE-MERGE: accumulate clear-path time each side before aiUpdatePassing
       may commit a lane change — mimics an elite spotter checking the mirror/blind spot. */
    const segLook = track.surface.segments[segIdx];
    const latLook = Number.isFinite(surf.dlat) ? surf.dlat : f.lane;
    const tgtPos = adjacentAiGrooveFor(f, s, latLook, 1, segLook, surf.u);
    const tgtNeg = adjacentAiGrooveFor(f, s, latLook, -1, segLook, surf.u);
    const proxLookEdge = Math.min(
      Number.isFinite(s.leftEdge) ? s.leftEdge : aiLatEdge(s.leftGap),
      Number.isFinite(s.rightEdge) ? s.rightEdge : aiLatEdge(s.rightGap));
    const sideLocked = s.sideCars >= 1 && proxLookEdge < AI_MIN_SIDE_CLEAR;
    const gapNeed = aiCentreClearTarget(sideLocked ? AI_CONTACT_HARD : AI_MIN_SIDE_CLEAR);
    const posPath = Math.abs(tgtPos - latLook) > 0.15
      && s.leftGap >= gapNeed
      && aiMergeWindowClear(arcNow, tgtPos, c);
    const negPath = Math.abs(tgtNeg - latLook) > 0.15
      && s.rightGap >= gapNeed
      && aiMergeWindowClear(arcNow, tgtNeg, c);
    if (posPath) f.lookPos = (f.lookPos || 0) + FIXED_DT; else f.lookPos = 0;
    if (negPath) f.lookNeg = (f.lookNeg || 0) + FIXED_DT; else f.lookNeg = 0;
    const highDir = -aiInsideSign;
    /* abort a lane change mid-commit if the spotter loses clearance — don't blind-merge. */
    if ((f.passHold > 0 || f.passMode === 'passing' || f.passMode === 'blocking')
        && Math.abs(f.laneTarget - f.lane) > 0.35) {
      const moveDir = Math.sign(f.laneTarget - f.lane);
      const gapMove = moveDir > 0 ? s.leftGap : s.rightGap;
      if (gapMove < aiCentreClearTarget(AI_CONTACT_HARD) + 0.12
          || !aiMergeWindowClear(arcNow, f.laneTarget, c)) {
        f.laneTarget = aiInPackTraffic(f, s) ? nearestPackGroove(f.lane, segLook, surf.u) : nearestAiGroove(f.lane, segLook, surf.u);
        f.grooveLat = f.laneTarget;
        f.pursueLane = f.laneTarget;
        f.passMode = 'race';
        f.passHold = 0;
      }
    }
    if (spd < REC_STUCK_SPD && moved < 0.15) f.stuckT = (f.stuckT || 0) + FIXED_DT; else f.stuckT = 0;
    const spun = spd < 16 && Math.abs(herr) > REC_REJOIN_OFF;
    const badlySlid = spd < 7 && (Math.abs(herr) > REC_REJOIN_OFF * 0.92 || Math.abs(c.r) > 2.1);
    if (f.recState === 'race' && (spun || badlySlid || surf.offSurface)) { f.recState = 'settle'; f.recClock = 0; f.steerSm = 0; }
    if (f.recState !== 'race') return aiRecover(f, surf, segIdx, herr);

    /* re-evaluate lane / pass STRATEGY at 5 Hz; safety gating below is per-tick */
    f.passClock = (f.passClock || 0) + FIXED_DT;
    if (f.passClock >= AI_PASS_LATCH_S) { f.passClock = 0; aiUpdatePassing(f); }
    if (s.sideCars >= 1) {
      const lockEdge = Math.min(
        Number.isFinite(s.leftEdge) ? s.leftEdge : aiLatEdge(s.leftGap),
        Number.isFinite(s.rightEdge) ? s.rightEdge : aiLatEdge(s.rightGap));
      if (lockEdge < AI_MIN_SIDE_CLEAR * 0.85)
        aiResolveSideLock(f, s, track.surface.segments[segIdx], surf.u, latLook, arcNow, highDir);
    }
    const seg = track.surface.segments[segIdx];
    const band = aiLaneBand(seg, surf.u);
    const lo = band.lo, hi = band.hi;
    if (Number.isFinite(surf.dlat)) f.lane = surf.dlat;
    if (f.tandemRole === 'push' && f.tandem && f.tandem.awake) f.laneTarget = f.tandem.lane;
    if (f.passMode !== 'passing' && f.passMode !== 'blocking')
      f.laneTarget = aiLaneLineDlat(f, segIdx, surf.u, spd, seg);
    f.laneTarget = clamp(f.laneTarget, lo, hi);
    f.laneTarget = clampAiPackTwoWide(f.laneTarget, f, s, seg, surf.u);
    const laneChg = f.passMode === 'passing' || f.passMode === 'blocking' || (f.passHold || 0) > 0;
    const lineBlend = aiRacingLineBlend(segIdx, surf.u, spd);
    aiUpdateGrooveTarget(f, s, segIdx, surf.u, spd, seg, laneChg);
    if (!laneChg && s.sideCars >= 1) {
      const sep = aiSideSepOffset(s);
      if (Math.abs(sep) > 0.06) {
        f.sepSm = f.sepSm == null ? sep : f.sepSm + 0.10 * (sep - f.sepSm);
        const sepSm = f.sepSm;
        f.grooveLat = clamp((f.grooveLat != null ? f.grooveLat : f.lane) + sepSm, lo, hi);
        f.laneTarget = clamp(f.laneTarget + sepSm * 0.45, lo, hi);
        f.grooveLat = clampAiPackTwoWide(f.grooveLat, f, s, seg, surf.u);
        f.laneTarget = clampAiPackTwoWide(f.laneTarget, f, s, seg, surf.u);
      } else {
        f.sepSm = f.sepSm == null ? 0 : f.sepSm * 0.85;
      }
    } else {
      f.sepSm = f.sepSm == null ? 0 : f.sepSm * 0.85;
    }
    const proxEdge = Math.min(
      Number.isFinite(s.leftEdge) ? s.leftEdge : aiLatEdge(s.leftGap),
      Number.isFinite(s.rightEdge) ? s.rightEdge : aiLatEdge(s.rightGap));
    const proxMin = proxEdge;
    const sepTarget = AI_MIN_SIDE_CLEAR + AI_SEP_MARGIN;

    /* HARD yellow-line clamp: paved-band edge + margin is the ceiling/floor.
       Any apron/grass contact snaps the lane model back — no racing under the yellow. */
    const yellowDlat = aiInsideSign >= 0 ? hi : lo;
    let onApron = false;
    if (Number.isFinite(surf.dlat)) {
      const apronSlack = 0.2;
      const pastLine = aiInsideSign >= 0
        ? surf.dlat > yellowDlat + apronSlack
        : surf.dlat < yellowDlat - apronSlack;
      const onGrass = classifyGrassAt(seg, surf.dlat, surf.u) === true;
      const insideGrass = onGrass && (aiInsideSign >= 0
        ? surf.dlat > yellowDlat - 0.5
        : surf.dlat < yellowDlat + 0.5);
      onApron = pastLine || insideGrass || !!surf.offSurface;
      if (onApron) {
        const backGroove = nearestAiGroove(yellowDlat - aiInsideSign * 0.4, seg, surf.u);
        f.laneTarget = backGroove;
        f.grooveLat = backGroove;
      }
    }

    /* ---- CORNER: pure-pursuit lookahead + the limiting radius & its distance --- */
    const Ldist = clamp(spd * AI_LOOKAHEAD_S, AI_LOOKAHEAD_MIN, AI_LOOKAHEAD_MAX);
    const la = aiAdvance(segIdx, surf.u, Ldist);
    const nx = -la.ty, ny = la.tx;
    if (!Number.isFinite(f.pursueLane)) f.pursueLane = f.lane;
    const proxFade = clamp((proxMin - AI_CONTACT_HARD) / Math.max(0.06, AI_MICRO_GAP - AI_CONTACT_HARD), 0, 1);
    const pursueDlat = f.grooveLat;
    const gx = la.x + nx * pursueDlat, gy = la.y + ny * pursueDlat;
    /* BANKING adds grip (a 31° Daytona corner corners far faster than the flat
       cap); aggression + the slider commit harder; dirty air trusts less grip. */
    const up = surf.up || [0, 0, 1];
    const bankTan = Math.abs((up[0] * -surf.ty + up[1] * surf.tx) / Math.max(0.3, up[2]));
    /* BANKING HOLD: resolve the down-slope gravity pull into the car's body-left axis
       (the same resolution the physics uses) and steer to OPPOSE it, so a crawling /
       pace-lap car doesn't wash down the banking. gLeftPull > 0 = gravity pulls the
       car to its LEFT → steer right (−) to make an up-bank tyre force; strongest at
       low speed, where the wash is worst and a little steer = a lot of correction. */
    const gN = 9.81 * up[2];                                  /* g·cos(bank) */
    const gDownX = gN * up[0], gDownY = gN * up[1];           /* world horizontal down-slope pull */
    const _cy = Math.cos(c.yaw), _sy = Math.sin(c.yaw);
    const gLeftPull = -gDownX * _sy + gDownY * _cy;           /* body-left component (= physics gLeft) */
    const bankSpeedFade = clamp(1 - spd / AI_BANK_HOLD_FADE_MPS, 0, 1);
    const bankSteerFF = -Math.sign(gLeftPull) * Math.min(Math.abs(gLeftPull) * AI_BANK_HOLD, 0.15)
                        * (0.4 + 0.6 * bankSpeedFade);
    /* real grip = base + BANKING + DOWNFORCE (∝ speed²). The downforce term is why
       a stock car takes a fast banked corner near-flat but a slow one carefully —
       it fixes both the panic-braking (fast corners now carry) and the spinning
       (slow corners keep the modest base). */
    const dfG = AI_DOWNFORCE_G * Math.min(1.6, (spd / AI_DF_REF) * (spd / AI_DF_REF));
    const scan = clamp(spd * AI_SPEED_SCAN_S, AI_SPEED_SCAN_MIN, AI_SPEED_SCAN_MAX);
    const corner = aiCornerAhead(segIdx, surf.u, scan);
    const minR = corner.minR, distToMinR = corner.distToMinR;
    const gripBankTan = Math.min(1.6, Math.max(bankTan, corner.bankTan || 0));
    /* corner grip also honours per-car pace/skill so genuinely quicker drivers gap
       the slower ones in the corners (where a 1.5-miler makes its lap time) — this is
       what lets a packed field string out instead of running as one glued block */
    const skillNorm = AI_SKILL_SPAN > 0 ? clamp((f.skill - AI_SKILL_LO) / AI_SKILL_SPAN, 0, 1) : 0.5;
    let latCap = (AI_LAT_G + gripBankTan + dfG) * (0.92 + 0.16 * f.aggression) * (0.92 + 0.16 * aiTune.aggro) * (0.97 + 0.06 * skillNorm);
    if (s.dirtyAir) latCap *= DIRTY_AIR_LATG;
    const inTraffic = aiInTraffic(f, s);
    if (inTraffic && Number.isFinite(minR) && minR > 260) latCap *= 1.06 + 0.14 * aEff;
    let vLimit = Number.isFinite(minR) ? Math.sqrt(latCap * 9.81 * minR) : Infinity;
    if (Number.isFinite(minR) && minR > 520) vLimit = Math.max(vLimit, spd * 0.94);
    f.onStraight = !Number.isFinite(minR) || minR > 500;   /* no real corner soon → bump-draft ok */
    let vPace = AI_TOP_MPS * f.pace * f.skill * aiTune.speed;
    if (!aiInTraffic(f, s) && s.ahead && s.ahead.dArc > DRAFT_TUCK_GAP * 0.45 && s.ahead.dArc < DRAFT_RANGE) {
      const runMul = 1 + DRAFT_RUN_BOOST * (0.55 + 1.1 * aEff);
      vPace = Math.min(AI_TOP_MPS * f.pace * f.skill * runMul * aiTune.speed, vPace * runMul);
    }
    if (aiCaution) vPace = Math.min(vPace, PACE_MPS);
    const vCorner = Number.isFinite(vLimit) ? vLimit : vPace;
    let vWant = aiInTraffic(f, s)
      ? aiPackChaseSpeed(f, s, vPace, vCorner, aEff)
      : Math.min(vPace, vCorner);
    const grooveAhead = s.ahead && s.ahead.dArc < 14 && Math.abs(s.ahead.dLat) < 1.15;
    if (f.passState === 'back_off' && grooveAhead) vWant = Math.min(vWant, s.ahead.car.speed + 4);
    else if (f.passState === 'back_off') f.passState = 'race';
    const vTau = aiInTraffic(f, s) ? Math.min(AI_VTARGET_TAU, 0.14) : AI_VTARGET_TAU;
    const alpha = 1 - Math.exp(-FIXED_DT / Math.max(0.06, vTau));
    f.vTargetSm = f.vTargetSm == null ? vWant : f.vTargetSm + alpha * (vWant - f.vTargetSm);
    const vTarget = f.vTargetSm;
    const dBrake = Number.isFinite(vLimit) ? Math.max(0, (spd * spd - vLimit * vLimit) / (2 * A_DECEL)) : 0;
    const brkSlack = BRAKE_MARGIN + (inTraffic ? 4 : 2);
    const tightTurn = Number.isFinite(minR) && minR < 440;
    const needBrake = tightTurn && spd > vLimit + 2.8;
    const brakeEnter = Number.isFinite(vLimit) && needBrake && distToMinR <= dBrake + brkSlack * 0.45;
    const brakeExit = !Number.isFinite(vLimit) || !tightTurn || distToMinR > dBrake + brkSlack + 14 || spd < vLimit + 0.8;
    if (!f._brakeZone && brakeEnter) f._brakeZone = true;
    else if (f._brakeZone && brakeExit) f._brakeZone = false;
    const spdErr = vTarget - spd;
    const thrFloor = clamp(0.26 + spd * 0.02, 0.26, 0.58);
    const thrCeil = clamp(0.42 + spd * 0.028, 0.42, 1);
    let throttle = clamp(thrFloor + spdErr * AI_THR_GAIN, thrFloor, thrCeil);
    let wantBrake = 0;
    if (f._brakeZone && Number.isFinite(vLimit) && spd > vLimit + 1.2) {
      const over = spd - vLimit;
      const brkScale = clamp(spd / 26, 0.28, 0.85);
      const brkMax = inTraffic ? AI_CORNER_BRAKE_MAX * 0.72 : AI_CORNER_BRAKE_MAX;
      wantBrake = clamp((over * 0.018 + Math.max(0, (dBrake + brkSlack * 0.35 - distToMinR)) * 0.022) * brkScale, 0, brkMax);
      const crThrFloor = clamp(0.32 + spd * 0.02, 0.32, 0.62);
      throttle = clamp(crThrFloor + spdErr * AI_THR_GAIN * 0.78, crThrFloor, 0.82);
    }
    if (s.liftAhead < 0.97 && s.sideCars < 1) throttle *= 0.97 + 0.03 * s.liftAhead;
    else if (s.liftAhead < 0.97 && grooveAhead) throttle *= 0.985 + 0.015 * s.liftAhead;
    if (f.yieldSide && grooveAhead) throttle = Math.min(throttle, 0.86);
    else if (f.yieldSide) f.yieldSide = false;
    const colTuck = s.colAhead && s.colAhead.dArc < DRAFT_TUCK_GAP * 1.35;
    if (colTuck && spd > 10) {
      throttle = Math.max(throttle, clamp(0.34 + spd * 0.024, 0.34, 0.9));
      f.yieldSide = false;
    } else if (s.sideCars >= 1) {
      f.yieldSide = false;
    }
    if (surf.offSurface) throttle = Math.min(throttle, 0.35);
    const maxBrkStep = AI_BRAKE_SLEW * FIXED_DT;
    f._brakeOut = clamp((f._brakeOut || 0) + clamp(wantBrake - (f._brakeOut || 0), -maxBrkStep, maxBrkStep), 0, AI_CORNER_BRAKE_MAX);
    let brake = f._brakeOut;

    /* ---- STEER: pursuit error (k1) + curvature feed-forward − k2·yaw-rate ------
       The k2 damping term is free counter-steer (kills the old weave); the feed-
       forward leads the wheel into the corner by the path curvature. */
    let err = Math.atan2(gy - c.y, gx - c.x) - c.yaw;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    const maxSteer = (c.p && c.p.maxSteer) || 0.4;
    /* pure-pursuit path curvature to the lookahead point: SMOOTH and correctly
       signed (curves toward the target), passing through zero CONTINUOUSLY as the
       car settles on the line. The old sign(err)/minR flipped sign every tick the
       heading error crossed zero — which slammed the feed-forward and the yaw-rate
       target left↔right each frame and made the cars dart. This is the weave fix. */
    const Ld = Math.max(6, Math.hypot(gx - c.x, gy - c.y));
    const kappa = 2 * Math.sin(err) / Ld;
    const aiLoFade = clamp(spd / 22, 0.30, 1);
    const steerFF = AI_STEER_FF * (0.38 + 0.62 * aiLoFade) * Math.atan(((c.p && c.p.wheelbase) || 2.79) * kappa);
    const yawWant = spd * kappa;
    let steer = clamp((steerFF + AI_YAW_K1 * aiLoFade * err - AI_YAW_K2 * (c.r - yawWant)) / maxSteer + bankSteerFF * aiLoFade, -1, 1);
    let crossErr = pursueDlat - f.lane;
    if (Math.abs(crossErr) < AI_CROSS_DEADBAND) crossErr = 0;
    else crossErr -= Math.sign(crossErr) * AI_CROSS_DEADBAND;
    const latSteerMul = (0.22 + 0.38 * proxFade) * aiLoFade;
    const crossSteer = crossErr * spd * AI_LAT_FORCE_K;
    const edgeSteer = aiEdgeRepulsionSteer(seg, surf.u, f.lane);
    const carRepSteer = aiCarRepulsionSteer(s, sepTarget, proxMin, f, f.grooveLat);
    const partnerSteer = aiPartnerGrooveSteer(f, s, f.grooveLat, maxSteer);
    steer += clamp((crossSteer + edgeSteer + carRepSteer + partnerSteer) * latSteerMul / maxSteer,
      -0.17 * aiLoFade, 0.17 * aiLoFade);
    /* NR keeps power through lane moves — cross-track + repulsion handle spacing */
    if (onApron) {
      const back = aiInsideSign >= 0 ? -1 : 1;   /* steer away from apron / toward track */
      steer = clamp(steer + back * 0.28, -1, 1);
      throttle = Math.min(throttle, 0.45);
    }
    /* AI steer is NOT scaled by the player's sensitivity slider: with the corrected
       (downforce) corner speeds they enter at a pace they can hold, so they no
       longer over-rotate — and coupling to the player slider risked under-steering
       them into the wall when the player dialled their own steering down. */

    /* ---- LOW-SPEED PLANT: fade steer + cap power so they stay planted in slow
       corners / pace laps instead of snapping the tail with full k1 + throttle. */
    const turnLoad = clamp(Math.abs(steer) * 1.15 + Math.abs(err) * 0.3, 0, 1);
    if (spd < 24) {
      const pwrCap = clamp(0.3 + spd * 0.028 - turnLoad * 0.3, 0.22, 1);
      throttle = Math.min(throttle, pwrCap);
    }
    const smAlpha = clamp(spd / 34, 0.05, 0.26);
    const steerRaw = steer;
    f.steerSm = f.steerSm == null ? steerRaw : f.steerSm + smAlpha * (steerRaw - f.steerSm);
    steer = f.steerSm;
    /* ---- RECOVER: catch a slide — lift and walk the nose back before power. */
    const slip = Math.atan2(c.v, Math.max(1, c.u));
    const slipMag = Math.abs(slip);
    if (spd < 28 && (slipMag > 0.12 || Math.abs(c.r) > 0.75)) {
      if (slipMag > AI_SLIP_LIFT || Math.abs(c.r) > AI_SPIN_R) {
        throttle = Math.min(throttle, clamp(0.3 + spd * 0.022, 0.25, 0.52));
        brake = Math.min(brake, 0.1);
        steer *= clamp(1 - slipMag * 0.5, 0.42, 1);
      } else {
        throttle *= clamp(1 - slipMag * 1.6, 0.5, 1);
      }
    }
    if (spd < 14) {
      const tcCap = clamp(0.34 + (spd / 14) * 0.42, 0.34, 0.76);
      throttle = Math.min(throttle, tcCap);
    }
    /* tandem pusher: stay welded to the partner's bumper — floor it, don't lift for
       the car ahead (that IS my partner). Only ever set on a straight; the lock
       breaks entering a corner, so this never floors a car into a turn. */
    if (f.tandemRole === 'push' && f.tandem && f.tandem.awake && Math.abs(slip) < AI_SLIP_LIFT) {
      throttle = 1; brake = 0;
    }
    return { throttle, brake, steer, reverse: false, lockUp: false };
  }

  /* ---- TANDEM DRAFT: two AI lock bumpers and run as a pair (the fastest draft).
     STRICTLY one partner each and NO chains — a car already in a tandem (either
     role) can't form or join another, so a pushee can never also push a third. */
  function breakTandem(f) {
    const g = f.tandem;
    f.tandem = null; f.tandemRole = null;
    if (g && g.tandem === f) { g.tandem = null; g.tandemRole = null; }
  }
  function tandemGap(f, g) {   /* + = g (pushee) is ahead of f (pusher) */
    return aiCum ? arcGap(f.arc, g.arc, aiCum.total) : Infinity;
  }
  function updateTandem(f) {
    if (!aiTandemOn) { if (f.tandem) breakTandem(f); return; }
    if (f.tandem) {
      const g = f.tandem;
      /* partner gone / desynced / asleep → dissolve (both roles check this) */
      if (!g || g.tandem !== f || !g.awake || !f.awake) { breakTandem(f); return; }
      if (f.tandemRole !== 'push') return;   /* the pusher owns the corner/gap break */
      const gap = tandemGap(f, g);
      if (!f.onStraight || !(gap >= 0) || gap > TANDEM_BREAK_GAP) breakTandem(f);
      return;
    }
    /* FORM: enabled, on a straight, quick, tucked behind a partner-free AI */
    if (!f.onStraight || f.car.speed < TANDEM_MIN_SPD) return;
    const s = f.sense;
    if (!s || !s.ahead || s.ahead.dArc > TANDEM_FORM_GAP) return;
    const g = fieldOf(s.ahead.car);
    if (!g || !g.ai || !g.awake || g.tandem) return;   /* partner must be a FREE AI (no chains) */
    f.tandem = g; f.tandemRole = 'push';
    g.tandem = f; g.tandemRole = 'pull';
  }

  /* DEFEND / PASS / RELAX on the spotter picture (f.sense), tempered by per-driver
     aggression and a commitment lock so a car rides out a decided move instead of
     re-picking every 0.2 s. Runs at 5 Hz; per-tick safety lives in aiDriveInput.
     A lane target aimed into a wall or an occupied side self-corrects there (the
     band clamp + spotter gate), reproducing lane_has_wall corridor rule. */

  /* ---- RACING LINE (continuous dlat, full track width — no hard lane caps).
     Outside/high on straights, inside/low in corners; spotter + passing override. */
  function aiGrooveInside(seg, u) {
    const g = aiGroovesInBand(seg, u);
    if (!g.length) return 0;
    return g.slice().sort((a, b) => aiInsideSign >= 0 ? b - a : a - b)[0];
  }
  function aiGrooveOutside(seg, u) {
    const g = aiGroovesInBand(seg, u);
    if (!g.length) return 0;
    return g.slice().sort((a, b) => aiInsideSign >= 0 ? a - b : b - a)[0];
  }
  function aiSegmentStraight(seg) {
    const r = seg && seg.arc ? seg.arc.r : Infinity;
    return !Number.isFinite(r) || r > 680;
  }
  function aiRacingLineBlend(k, u, spd) {
    const scanNear = clamp(spd * 0.45, 28, 72);
    const scanFar = clamp(spd * 1.85, 55, 165);
    const near = aiCornerAhead(k, u, scanNear);
    const far = aiCornerAhead(k, u, scanFar);
    const segs = track.surface.segments, N = segs.length;
    const seg = segs[((k % N) + N) % N];
    const rNow = seg.arc ? seg.arc.r : Infinity;
    const onStraightNow = aiSegmentStraight(seg);
    let inside = 0;
    /* Straights: full outside (phase=0) until corner setup — not bleeding in 150m early. */
    if (onStraightNow) {
      if (!Number.isFinite(far.minR) || far.minR >= 430 || far.distToMinR > 50) return 0;
    } else if (rNow < 280) inside = 0.92;
    else if (rNow < 420) inside = 0.55 + 0.25 * clamp((420 - rNow) / 140, 0, 1);
    if (Number.isFinite(far.minR) && far.minR < 430) {
      const setup = clamp(spd * 1.1 + far.minR * 0.055, 34, 95);
      const d = far.distToMinR;
      if (d < setup) {
        const t = 1 - d / setup;
        const approach = t * t * t * (0.92 - 0.18 * clamp(far.minR / 580, 0, 1));
        inside = Math.max(inside, clamp(approach, 0, 1));
      }
      if (d < 8 || (near.minR < 340 && near.distToMinR < 18)) inside = Math.max(inside, 0.9);
    }
    if (onStraightNow && far.distToMinR > 50) inside = 0;
    if (rNow < 500 && Number.isFinite(far.minR) && far.minR > 540 && far.distToMinR > 40) {
      const exitEase = clamp((far.distToMinR - 38) / 120, 0, 1);
      inside *= 1 - exitEase * 0.72;
    }
    return clamp(inside, 0, 1);
  }
  /* ---- UNIFIED RACING LINE: shared phase (high straight / low turn), home-column slot.
     Every AI car uses the same lane-line law — pack or clean air. */
  function aiGroovesOutIn(seg, u) {
    return aiGroovesInBand(seg, u).slice()
      .sort((a, b) => aiInsideSign >= 0 ? a - b : b - a);
  }
  function aiLaneSlotInfo(f, seg, u, s) {
    let grooves = aiGroovesOutIn(seg, u);
    if (s && aiInPackTraffic(f, s)) grooves = aiPackGrooves(seg, u);
    if (!grooves.length) return { grooves, idx: 0, norm: 0 };
    let idx = 0, best = Infinity;
    const home = Number.isFinite(f.laneHome) ? f.laneHome : f.lane;
    for (let i = 0; i < grooves.length; i++) {
      const d = Math.abs(grooves[i] - home);
      if (d < best) { best = d; idx = i; }
    }
    if (f.gridCol != null && grooves.length >= 2) {
      idx = f.gridCol === 0 ? grooves.length - 1 : 0;   /* inside row dives in; outside row stays high */
    }
    const norm = grooves.length > 1 ? idx / (grooves.length - 1) : 0;
    return { grooves, idx, norm };
  }
  const AI_LANE_OUT_TUCK = 0.38;
  function aiLaneHighDlat(seg, u, slotIdx, grooves) {
    const band = aiLaneBand(seg, u);
    if (!grooves || !grooves.length) return 0;
    slotIdx = Math.min(slotIdx, 1);
    if (slotIdx <= 0) return clamp(grooves[0], band.lo, band.hi);
    return clamp(grooves[Math.min(1, grooves.length - 1)], band.lo, band.hi);
  }
  function aiLaneLineDlat(f, segIdx, u, spd, seg) {
    const band = aiLaneBand(seg, u);
    const s = f.sense || SENSE_DEFAULT;
    const { grooves, idx, norm } = aiLaneSlotInfo(f, seg, u, s);
    if (!grooves.length) return 0;
    const out = grooves[0], inn = grooves[grooves.length - 1];
    const meArc = f.arc != null ? f.arc : segDlong(seg, u);
    if (f.gridCol === 1) {
      const partnerNear = s.partnerLane && s.partnerLane.dArc > -8 && s.partnerLane.dArc < 40;
      const insideTaken = aiGrooveOccupied(meArc, inn, f.car, 40, 10);
      if (partnerNear || insideTaken || s.sideCars >= 1) return clamp(out, band.lo, band.hi);
    }
    const phase = aiRacingLineBlend(segIdx, u, spd);
    if (phase < 0.1) return aiLaneHighDlat(seg, u, idx, grooves);
    const insideRow = f.gridCol === 0 || (f.gridCol == null && norm >= 0.5);
    if (insideRow && norm >= 0.5) return clamp(out + (inn - out) * phase, band.lo, band.hi);
    if (f.gridCol === 1) return clamp(out, band.lo, band.hi);
    const tuckK = AI_LANE_OUT_TUCK * (1 - norm * 0.55);
    const tuck = phase * phase * tuckK;
    return clamp(out + (inn - out) * tuck, band.lo, band.hi);
  }
  function aiInTraffic(f, s) {
    if (f.race && f.race.wraps < 2) return true;
    if (s.ahead && s.ahead.dArc < DRAFT_RANGE) return true;
    if (s.behind && s.behind.dArc > -DRAFT_RANGE * 0.85) return true;
    if (s.sideCars >= 1) return true;
    return false;
  }
  function aiPackChaseSpeed(f, s, vPace, vLimit, aEff) {
    const colAhead = s.colAhead || null;
    const colBehind = s.colBehind || null;
    let v = Math.min(vPace, vLimit);
    const roomAhead = !colAhead || colAhead.dArc > DRAFT_TUCK_GAP * 0.75;
    if (colBehind && colBehind.dArc > -26 && colBehind.dArc < -2.5 && colBehind.closing > 0.3 && roomAhead) {
      const push = 0.7 + aEff * 1.4 + clamp(colBehind.closing / 3.2, 0, 1) * 1.6;
      v = Math.min(vLimit, v + push);
    }
    if (colAhead && colAhead.dArc > 0.5 && colAhead.dArc < DRAFT_RANGE * 1.1) {
      const aheadSpd = colAhead.car ? colAhead.car.speed : v;
      const gap = colAhead.dArc;
      if (gap < DRAFT_TUCK_GAP * 1.25) {
        /* hold station a car-length or two back instead of ramming to the bumper:
           gentler closing + a stronger gap backoff so the field strings out */
        const chase = 0.55 + aEff * 1.3 + clamp((DRAFT_TUCK_GAP - gap) / DRAFT_TUCK_GAP, 0, 1) * 0.9;
        v = Math.min(vLimit, Math.max(v, aheadSpd + chase - gap * 0.09));
      } else {
        v = Math.min(vLimit, Math.max(v, aheadSpd + 0.25 + aEff * 0.7));
      }
    } else if (roomAhead) {
      const row = f.packRow != null ? f.packRow : 0;
      const stagger = ((row * 0.6180339887) % 1) * 0.55 * (0.55 + 0.45 * aEff);
      v = Math.min(vLimit, vPace + stagger);
    }
    return v;
  }

  function aiRacingLineDlat(k, u, spd) {
    const blend = aiRacingLineBlend(k, u, spd);
    const segs = track.surface.segments, N = segs.length;
    const seg = segs[((k % N) + N) % N];
    const band = aiLaneBand(seg, u);
    const out = aiGrooveOutside(seg, u), inn = aiGrooveInside(seg, u);
    return clamp(out + (inn - out) * blend, band.lo, band.hi);
  }
  /* NR groove target: continuous lateral sample (path+0x0c), not laneTarget snaps.
     Passing FSM commits laneTarget at 5 Hz; steer tracks grooveLat every tick. */
  function aiGrooveTargetRaw(f, s, segIdx, u, spd, seg, laneChg) {
    const band = aiLaneBand(seg, u);
    if (f.tandemRole === 'push' && f.tandem && f.tandem.awake)
      return clamp(f.tandem.lane, band.lo, band.hi);
    if (laneChg) return clamp(f.laneTarget, band.lo, band.hi);
    if (aiSegmentStraight(seg)) return aiLaneLineDlat(f, segIdx, u, spd, seg);
    const laDist = clamp(spd * AI_LOOKAHEAD_S * 0.42, 14, 32);
    const adv = aiAdvance(segIdx, u, laDist);
    const advSeg = track.surface.segments[adv.k];
    return aiLaneLineDlat(f, adv.k, adv.u, spd, advSeg);
  }
  function aiUpdateGrooveTarget(f, s, segIdx, u, spd, seg, laneChg) {
    const raw = aiGrooveTargetRaw(f, s, segIdx, u, spd, seg, laneChg);
    if (f.grooveLat == null || !Number.isFinite(f.grooveLat)) f.grooveLat = f.lane;
    const tau = laneChg ? 1.05 : clamp(AI_GROOVE_SMOOTH_TAU + spd * 0.004, 0.62, 1.15);
    const gAlpha = 1 - Math.exp(-FIXED_DT / tau);
    f.grooveLat += gAlpha * (raw - f.grooveLat);
  }
  function aiEdgeRepulsionSteer(seg, u, dlat) {
    const band = aiLaneBand(seg, u);
    const margin = AI_WALL_MARGIN * 0.42;
    const softHi = band.hi - margin, softLo = band.lo + margin;
    let rep = 0;
    const overHi = dlat - softHi;
    const overLo = softLo - dlat;
    if (overHi > 0) rep -= (overHi > margin ? AI_EDGE_REP_HARD : AI_EDGE_REP_SOFT) * overHi;
    if (overLo > 0) rep += (overLo > margin ? AI_EDGE_REP_HARD : AI_EDGE_REP_SOFT) * overLo;
    return rep;
  }
  function aiPartnerGrooveSteer(f, s, grooveTgt, maxSteer) {
    if (!f || f.gridCol !== 1 || !s || !s.partnerLane) return 0;
    const p = s.partnerLane;
    if (p.dArc < -6 || p.dArc > 38) return 0;
    const inn = grooveTgt;
    const push = (inn - f.lane) * 0.14;
    if (Math.abs(push) < 0.04) return 0;
    return clamp(-Math.sign(push) * Math.min(Math.abs(push), 0.18) / maxSteer, -0.14, 0.14);
  }
  function aiCarRepulsionSteer(s, sepTarget, proxEdge, f, grooveTgt) {
    if (s.sideCars < 1 || proxEdge >= sepTarget - 0.02) return 0;
    if (s.ahead && s.ahead.dArc > 0.6 && s.ahead.dArc < DRAFT_TUCK_GAP * 1.25
        && Math.abs(s.ahead.dLat) < aiBodyHalfW() * 1.1 && !s.partnerLane) return 0;
    const le = Number.isFinite(s.leftEdge) ? s.leftEdge : aiLatEdge(s.leftGap);
    const re = Number.isFinite(s.rightEdge) ? s.rightEdge : aiLatEdge(s.rightGap);
    const warn = sepTarget + AI_SIDE_WARN;
    const squeezed = proxEdge < sepTarget + 0.08;
    let rep = 0;
    const k = squeezed ? AI_CAR_REP_K * 1.15 : AI_CAR_REP_K * 0.85;
    if (le < warn) rep -= k * (warn - le);
    if (re < warn) rep += k * (warn - re);
    if (le < warn && re < warn) rep += (le >= re ? 1 : -1) * k * 1.35;
    return clamp(rep, -0.22, 0.22);
  }

  /* door-to-door stalemate: look-timers never accrue while locked, so force a
     peel to an open groove or a disciplined lift after AI_SIDE_LOCK_S. */
  function aiResolveSideLock(f, s, seg, u, lat, meArc, highDir) {
    const prox = Math.min(
      Number.isFinite(s.leftEdge) ? s.leftEdge : aiLatEdge(s.leftGap),
      Number.isFinite(s.rightEdge) ? s.rightEdge : aiLatEdge(s.rightGap));
    if (s.sideCars < 1 || prox >= AI_MIN_SIDE_CLEAR) {
      f.sideLockT = 0;
      if (prox >= AI_MIN_SIDE_CLEAR + 0.18) f.yieldSide = false;
      return false;
    }
    f.sideLockT = (f.sideLockT || 0) + 0.25;
    if (f.sideLockT < AI_SIDE_LOCK_S) return false;
    f.sideLockT = 0;
    f.yieldSide = false;
    const spread = aiPickSpreadSide(f, seg, u, lat, meArc, true);
    if (spread !== 0) {
      f.laneTarget = adjacentAiGrooveFor(f, s, lat, spread, seg, u);
      f.passMode = 'passing'; f.passState = 'passing';
      f.passHold = AI_PASS_HOLD * 0.32;
      f.wanderClock = 0;
      return true;
    }
    const band = aiLaneBand(seg, u);
    if (s.alongside && s.alongside.car) {
      const away = s.alongside.side > 0 ? -highDir : highDir;
      const tgt = adjacentAiGrooveFor(f, s, lat, away, seg, u);
      if (Math.abs(tgt - lat) > 0.12) {
        f.laneTarget = clamp(tgt, band.lo, band.hi);
        f.passMode = 'passing'; f.passState = 'passing';
        f.passHold = AI_PASS_HOLD * 0.28;
        return true;
      }
    }
    const nudgeDir = s.leftGap >= s.rightGap ? -1 : 1;
    f.laneTarget = clampAiPackTwoWide(clamp(lat + nudgeDir * AI_LANE_SPACING * 0.42, band.lo, band.hi), f, s, seg, u);
    f.passMode = 'passing'; f.passState = 'passing';
    f.passHold = AI_PASS_HOLD * 0.22;
    return true;
  }

  function aiUpdatePassing(f) {
    updateTandem(f);
    if (f.tandem) return;
    const s = f.sense || SENSE_DEFAULT;
    const aEff = clamp(f.aggression * (0.5 + aiTune.aggro), 0, 1);
    const { seg, u, lat } = aiPassSurf(f);
    const meArc = f.arc != null ? f.arc : segDlong(seg, u);
    f.passHold = Math.max(0, (f.passHold || 0) - AI_PASS_LATCH_S);
    if (f.passHold > 0) return;

    if (aiCaution) {
      f.passMode = 'race'; f.passState = 'race';
      f.laneTarget = aiGrooveInside(seg, u);
      return;
    }

    const segIdx = seg ? track.surface.segments.indexOf(seg) : 0;
    const spdPass = f.car ? f.car.speed : 30;
    f.laneTarget = aiLaneLineDlat(f, segIdx, u, spdPass, seg);
    f.laneTarget = clampAiPackTwoWide(f.laneTarget, f, s, seg, u);

    /* Traffic: unified lane-line only — no lateral pass moves. */
    if (aiInTraffic(f, s)) {
      f.passMode = 'race';
      f.passState = (s.colAhead && s.colAhead.dArc < DRAFT_TUCK_GAP) ? 'follow' : 'race';
      f.blockedT = 0;
      f.runHold = 0;
      f.sideRaceT = 0;
      return;
    }

    /* Clean air: rare pass only after a long stall behind a slower car. */
    if (s.ahead && s.ahead.dArc < 12 && s.ahead.closing > 0.9) {
      f.blockedT = (f.blockedT || 0) + AI_PASS_LATCH_S;
      const holdTime = 5.5 + 2.5 * (1 - aEff);
      if (f.blockedT >= holdTime) {
        const highDir = -aiInsideSign;
        const side = aiPickPassSide(f, seg, u, lat, meArc, highDir);
        if (side !== 0) {
          const tgt = adjacentAiGroove(lat, side, seg, u);
          if (Math.abs(tgt - lat) > 0.5 && aiMergeWindowClear(meArc, tgt, f.car)
              && aiLaneChangeReady(f, side, seg, u, lat, meArc)) {
            f.laneTarget = tgt;
            f.passMode = 'passing'; f.passState = 'passing';
            f.passHold = AI_PASS_HOLD; f.blockedT = 0;
            return;
          }
        }
        f.blockedT = holdTime * 0.7;
      }
    } else {
      f.blockedT = 0;
    }

    f.passMode = 'race';
    f.passState = (s.ahead && s.ahead.dArc < DRAFT_TUCK_GAP && s.sideCars < 1) ? 'follow' : 'race';
  }

  /* ---- formal race (grid start → 10 laps → checker) ------------------------
     Lap counting rides a MONOTONIC race distance D per car: D = wraps·total +
     (distance past the start/finish line). It only ever increases, wrapping
     cleanly at the line, so it needs no exact "seg 0" and works on any track. */
  function trackCumDist() {
    const segs = track.surface.segments;
    const cum = new Array(segs.length);
    let acc = 0;
    for (let k = 0; k < segs.length; k++) { cum[k] = acc; acc += segLen(segs[k]); }
    return { cum, total: acc };
  }
  /* centreline distance of the start/finish line (the parked-car pose projected
     onto the loft) — the datum every car's laps are measured from */
  function sfLineDist(cum) {
    const segs = track.surface.segments;
    const w = track.stall && track.stall.world;
    if (!w) return 0;
    let best = { d2: Infinity, k: 0, u: 0 };
    for (let k = 0; k < segs.length; k++) {
      const u = clamp(TrackSurface.projectSegU(segs[k], w.x, w.y), 0, 1);
      const c = TrackSurface.sampleCenter(segs[k], u);
      const dx = w.x - c.x, dy = w.y - c.y, d2 = dx * dx + dy * dy;
      if (d2 < best.d2) best = { d2, k, u };
    }
    return cum[best.k] + best.u * segLen(segs[best.k]);
  }
  /* 2-wide starting grid stacked back from the S/F line */
  function raceGridPoses(count) {
    const total = race.total, out = [];
    const segs = track.surface.segments;
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / 2), col = i % 2;
      const back = RACE_GRID_START_BACK + row * RACE_GRID_ROW_GAP;
      const d = ((race.sfDist - back) % total + total) % total;
      const p = aiPointAtDistance(d);
      const groove = aiGridGroove(col, row, segs[p.k], p.u);
      const nx = -p.ty, ny = p.tx;
      /* spawn ON the assigned reference groove — the old ±3 m columns fought the
         lane target by up to 5+ m and hard-steered into the wall/apron on green */
      out.push({ x: p.x + nx * groove, y: p.y + ny * groove,
        heading: Math.atan2(p.ty, p.tx), lane: groove, col, seg: p.k, u: p.u });
    }
    return out;
  }
  /* one car's signed distance past the S/F line, 0..total (needs its seg/u) */
  function raceShifted(pr) {
    if (!pr) return null;
    const rawP = race.cum[pr.seg] + clamp(pr.u, 0, 1) * segLen(track.surface.segments[pr.seg]);
    return ((rawP - race.sfDist) % race.total + race.total) % race.total;
  }
  /* advance one race-distance tracker (car or player) and return its D. On the
     FIRST sample the wrap count is chosen from the signed distance to the line,
     so a grid car sitting just BEHIND it (shifted≈total) reads D≈−small while
     the player sitting ON it (shifted≈0) reads D≈0 — neither a lap adrift. */
  function raceAdvance(tr, pr) {
    const shifted = raceShifted(pr);
    if (shifted == null) return tr.D;
    if (tr.shiftedPrev == null) tr.wraps = shifted > race.total * 0.5 ? -1 : 0;
    else if (tr.shiftedPrev - shifted > race.total * 0.5) tr.wraps++;
    tr.shiftedPrev = shifted;
    tr.D = tr.wraps * race.total + shifted;
    return tr.D;
  }

  function setRaceHud(text) {
    const el = $('viewer-race');
    if (el) el.textContent = text || '';
  }

  function startRace() {
    if (!track || !track.surface || !track.surface.segments || !track.surface.segments.length) {
      log('Load a track first, then start a race.'); return false;
    }
    /* set the race up FIRST so whichever arm path runs spawns straight onto the
       grid (no wasted casual spawn) */
    aiRaceMode = true;                    /* armField's race branch needs racers enabled */
    const { cum, total } = trackCumDist();
    race = { laps: RACE_LAPS, total, cum, sfDist: sfLineDist(cum), over: false,
      finishers: [], leaderLap: 1, playerRace: { wraps: 0, shiftedPrev: null, D: 0 } };
    if (!active) start();                 /* physics + WASD live; start() arms the grid */
    else armField();                      /* already driving → arm the grid now */
    const n = fieldCars.filter((f) => f.ai).length;
    log(`GREEN FLAG — ${n}-car field, ${RACE_LAPS} laps. Drive into the pack (you're scored too).`);
    return n > 0;
  }
  function endRace() {
    race = null;
    setRaceHud('');
    if (active) armField();               /* back to the casual spread / pit park */
  }

  /* per-frame race bookkeeping: leader lap, finishing order, the player's spot */
  function updateRace() {
    if (!race) return;
    const total = race.total;
    let leaderD = -Infinity;
    const order = [];                     /* {D, isPlayer, slot, done} for live positions */
    for (const f of fieldCars) {
      if (!f.ai || !f.race) continue;
      const D = raceAdvance(f.race, f.seed.progress);
      if (!f.race.done && D >= race.laps * total) {
        f.race.done = true;
        race.finishers.push(f);
        f.race.pos = race.finishers.length;
      }
      if (D > leaderD) leaderD = D;
      order.push({ D, isPlayer: false, slot: f.slot, done: f.race.done });
    }
    /* the player is scored too (progress lives in the module `progress` seed) */
    const pD = raceAdvance(race.playerRace, progress);
    order.push({ D: pD, isPlayer: true, slot: -1, done: pD >= race.laps * total });
    if (pD > leaderD) leaderD = pD;

    race.leaderLap = clamp(Math.floor(leaderD / total) + 1, 1, race.laps);
    order.sort((a, b) => b.D - a.D);
    const pPos = order.findIndex((o) => o.isPlayer) + 1;
    /* spectating an AI → report ITS running position, not the player's */
    const viewPos = focusCar
      ? ((order.findIndex((o) => !o.isPlayer && o.slot === focusCar.slot) + 1) || pPos)
      : pPos;

    if (!race.over && leaderD >= race.laps * total) {
      race.over = true;
      const top = order.slice(0, 5).map((o, i) => `P${i + 1} ${o.isPlayer ? 'YOU' : '#' + (o.slot + 1)}`);
      log(`CHECKERED FLAG — ${race.laps} laps done. ${top.join('  ')}`);
    }
    setRaceHud(race.over
      ? `FINISHED  ·  P${pPos}/${order.length}`
      : `LAP ${race.leaderLap}/${race.laps}  ·  P${viewPos}/${order.length}`);
  }

  function disarmField() {
    const phys = carFieldGroup && carFieldGroup.userData && carFieldGroup.userData.phys;
    if (phys) {
      const touched = new Set();
      for (const f of fieldCars) {
        writeSlotMatrix(f, phys.authored[f.slot]);
        for (const inst of f.inst) touched.add(inst);
      }
      for (const inst of touched) inst.instanceMatrix.needsUpdate = true;
    }
    fieldCars = [];
    aiCum = null;
    if (focusCar) { focusCar = null; if (focusProxy && focusProxy.parent) focusProxy.parent.remove(focusProxy); }
    populateDriverSelect();   /* the roster changed (usually emptied) */
  }

  /* build one live Physics.Car per stall, seeded settled on the surface at its
     parked pose and asleep. Shares the player's setup / track env / aids / body
     shape so "we all drive the same car". */
  function armField() {
    disarmField();
    const phys = carFieldGroup && carFieldGroup.userData && carFieldGroup.userData.phys;
    if (!phys || !phys.N || !track || !track.surface || typeof Physics === 'undefined') return;
    const dc = (typeof DriveControls !== 'undefined') ? DriveControls.get() : null;
    const dressCar = (c) => {
      if (track.setup) c.applySetup(track.setup);
      if (track.env) c.applyTrackEnv(track.env);
      if (dc && dc.aids) c.setAids(dc.aids);
      if (dc && dc.aero) c.setAeroTune(dc.aero);
      if (carShape) c.setBodyShape(carShape.pts);
    };
    /* how many slots go racing (rest stay parked & crashable). A formal `race`
       fields up to RACE_FIELD on a grid; the casual toggle spreads AI_RACE_CAP. */
    const haveLoft = track.surface.segments && track.surface.segments.length;
    aiCum = haveLoft ? trackCumDist() : null;   /* arc table the sense pass needs */
    aiInsideSign = haveLoft ? computeInsideSign() : 1;   /* which side is the apron/yellow line */
    const raceN = haveLoft
      ? (race ? Math.min(phys.N, RACE_FIELD, KIOSK_FIELD || RACE_FIELD) : (aiRaceMode ? Math.min(phys.N, AI_RACE_CAP, KIOSK_FIELD || AI_RACE_CAP) : 0))
      : 0;
    const racePoses = raceN ? (race ? raceGridPoses(raceN) : aiSpawnPoses(raceN)) : [];

    for (let i = 0; i < phys.N; i++) {
      const racing = i < raceN;
      const p = racing ? racePoses[i] : phys.poses[i];
      if (!p) continue;
      const c = new Physics.Car();
      c.reset({ x: p.x, y: p.y, heading: p.heading });
      dressCar(c);
      c.p.enginePowerMul = Physics.hpTargetToMul(aiPeakHp, c.p);
      const seed = { progress: racing ? { seg: p.seg, u: p.u } : null };
      const surf = sampleSurfaceFor(seed, c.x, c.y);
      c.zPos = surf.height; c.vz = 0; c.airborne = false; c.onSurface = true;
      const snap0 = c.snapshot();
      const f = {
        car: c, seed, slot: i, awake: racing, restTimer: 0, surf,
        snapCur: snap0, snapPrev: snap0, surfPrev: surf,
        body: phys.slotBodyMeshes[i], inst: phys.instParts,
        spin: [0, 0, 0, 0],   /* per-wheel roll angle (rad), integrated while awake */
        render: makeRenderSmooth(),
      };
      if (racing) {
        /* rolling start on the groove; per-car pace + lane variety so the field
           spreads and passes. A formal race rolls off gentler (packed grid). */
        c.u = race ? RACE_ROLLING_MPS : AI_SPAWN_MPS;
        const jitter = (i * 0.6180339887) % 1;   /* deterministic golden-angle spread */
        const jitter2 = (i * 0.7548776662) % 1;   /* decorrelated stream: aggression ≠ pace */
        f.ai = true;
        f.pace = 0.9 + 0.14 * jitter;            /* 0.90–1.04 of the pace ceiling */
        f.gridCol = p.col != null ? p.col : (i % 2);
        f.packRow = Math.floor(i / 2);
        f.laneHome = p.lane;
        f.lane = p.lane;
        f.laneTarget = p.lane;
        f.pursueLane = p.lane;
        f.laneVel = 0;
        f.passClock = jitter * 0.2;              /* de-sync the passing checks */
        /* per-driver personality + spatial-awareness bookkeeping (see aiSenseField) */
        f.aggression = AI_AGGR_MIN + jitter2 * (AI_AGGR_MAX - AI_AGGR_MIN);  /* boldness 0..1 */
        f.skill = AI_SKILL_LO + jitter * AI_SKILL_SPAN;                       /* pace/consistency ceiling */
        f.arc = 0;            /* cached track arc-length, refreshed each substep */
        f.sense = makeSense();   /* persistent neighbour picture (mutated each substep) */
        f.runHold = 0;        /* s tucked-with-a-run before pulling out (draft) */
        f.blockedT = 0;       /* s a slower car has blocked me (pass patience) */
        f.passMode = 'race';  /* 'race' | 'passing' | 'blocking' */
        f.passState = 'race'; /* NR FSM: race|follow|pull_out|passing|back_off */
        f.passHold = 0;       /* s commitment lock after a lane decision */
        f.vTargetSm = null; f._brakeOut = 0; f._brakeZone = false; f.steerSm = 0;
        f.lookPos = 0; f.lookNeg = 0;  /* look-before-merge timers (each side) */
        f.sideLockT = 0; f.yieldSide = false; f.sideRaceT = 0; f.sepSm = 0; f.grooveLat = p.lane;
        f.onStraight = false; /* set each tick in aiDriveInput (gates bump-drafting) */
        f.bumpClock = 0;      /* s until this car may bump-draft again */
        f.tandem = null;      /* partner field-car when locked in a tandem (else null) */
        f.tandemRole = null;  /* 'push' (behind) | 'pull' (ahead) */
        f.recState = 'race';  /* 'race'|'settle'|'reorient'|'rejoin' — NR recovery FSM */
        f.recClock = 0;       /* s in the current recovery state */
        f.stuckT = 0;         /* s of no useful progress (drives the tow timeout) */
        f.lastArc = null;     /* previous arc-length, for progress detection */
        if (race) f.race = { wraps: -1, shiftedPrev: null, D: -race.total, done: false, pos: 0 };
      }
      fieldCars.push(f);
    }
    const racers = fieldCars.filter((f) => f.ai).length;
    const parked = fieldCars.length - racers;
    populateDriverSelect();   /* refresh the spectate roster */
    if (aiLanesOn) buildAiLaneOverlay();   /* rebuild the debug lane overlay on the fresh trackGroup */
    if (fieldCars.length && !race) {
      log(racers
        ? `AI race: ${racers} cars running laps` + (parked ? `, ${parked} parked in the pits (crashable)` : '') + '.'
        : `Field physics: ${parked} pit cars are live — drive into them.`);
    }
  }

  /* toggle racing at runtime (Display panel) — re-arm the field in the new mode */
  function setAiRace(on) {
    aiRaceMode = !!on;
    try { localStorage.setItem('re2003.aiRace', aiRaceMode ? '1' : '0'); } catch (e) {}
    if (active) armField();
  }

  /* live AI tuning — takes effect immediately (the controller reads aiTune each
     step), no re-arm needed. Persisted so it survives a reload. */
  function setAiTune(partial) {
    if (partial && Number.isFinite(partial.speed)) aiTune.speed = clamp(partial.speed, 0.6, 5);
    if (partial && Number.isFinite(partial.aggro)) aiTune.aggro = clamp(partial.aggro, 0, 1);
    if (partial && Number.isFinite(partial.laneFreq)) aiTune.laneFreq = clamp(partial.laneFreq, 0, 1);
    try { localStorage.setItem('re2003.aiTune', JSON.stringify(aiTune)); } catch (e) {}
  }

  /* yellow flag: the AI drops to pace speed, forms a single-file line, and stops
     passing/blocking (all gated on aiCaution inside the controller). Live. */
  function setCaution(on) { aiCaution = !!on; }

  /* "Car mass" slider → scale EVERY live car (player + field/AI) and set the
     global so any car armed later is born at the same weight. */
  function setMassScale(s) {
    const cars = [];
    if (car) cars.push(car);
    for (const f of fieldCars) if (f && f.car) cars.push(f.car);
    return Physics.setMassScale(s, cars);
  }

  function hpSampleParams() {
    const c = new Physics.Car();
    if (track && track.setup) c.applySetup(track.setup);
    if (track && track.env) c.applyTrackEnv(track.env);
    return c.p;
  }
  function refreshEnginePower() {
    const p = hpSampleParams();
    const playerMul = Physics.hpTargetToMul(playerPeakHp, p);
    const aiMul = Physics.hpTargetToMul(aiPeakHp, p);
    if (car && car.p) car.p.enginePowerMul = playerMul;
    for (const f of fieldCars) if (f.car && f.car.p) f.car.p.enginePowerMul = aiMul;
    return { playerMul, aiMul };
  }
  function setPlayerPeakHp(hp) {
    playerPeakHp = clamp(Number.isFinite(hp) ? hp : 750, 250, 900);
    refreshEnginePower();
    try { localStorage.setItem('re2003.playerPeakHp', String(playerPeakHp)); } catch (e) {}
    return playerPeakHp;
  }
  function getPlayerPeakHp() { return playerPeakHp; }
  function setAiPeakHp(hp) {
    aiPeakHp = clamp(Number.isFinite(hp) ? hp : 750, 250, 900);
    refreshEnginePower();
    try { localStorage.setItem('re2003.aiPeakHp', String(aiPeakHp)); } catch (e) {}
    return aiPeakHp;
  }
  function getAiPeakHp() { return aiPeakHp; }
  function setSteerSensitivity(s) {
    steerSensitivity = clamp(Number.isFinite(s) ? s : 0.8, 0.3, 1.2);
    try { localStorage.setItem('re2003.steerSens', String(steerSensitivity)); } catch (e) {}
    return steerSensitivity;
  }
  function loadCollisionTune() {
    try {
      const raw = localStorage.getItem('re2003.collisionTune');
      if (!raw || typeof Physics === 'undefined' || !Physics.setCollisionTune) return;
      Physics.setCollisionTune(JSON.parse(raw));
    } catch (e) {}
  }
  function saveCollisionTune() {
    if (typeof Physics === 'undefined' || !Physics.getCollisionTune) return;
    try { localStorage.setItem('re2003.collisionTune', JSON.stringify(Physics.getCollisionTune())); } catch (e) {}
  }
  function setCollisionTune(t) {
    if (typeof Physics === 'undefined' || !Physics.setCollisionTune) return null;
    Physics.setCollisionTune(t);
    saveCollisionTune();
    return Physics.getCollisionTune();
  }
  function getCollisionTune() {
    return (typeof Physics !== 'undefined' && Physics.getCollisionTune) ? Physics.getCollisionTune() : {};
  }
  loadCollisionTune();
  refreshEnginePower();

  function getSteerSensitivity() { return steerSensitivity; }

  return {
    get active() { return active; },
    get chase() { return carFollow === 'chase'; },
    get carFollow() { return carFollow; },
    get driveCam() { return carFollow; },
    /* body-frame planar velocity (m/s) for the drive-time flow smoke */
    get flowState() { return (active && car) ? { u: car.u, v: car.v } : null; },
    get aiRace() { return aiRaceMode; },
    get aiTune() { return { ...aiTune }; },
    setAiTune,
    get caution() { return aiCaution; },
    setCaution,
    getAiParams, setAiParam, resetAiParams, saveAiParams,
    get aiLanes() { return aiLanesOn; },
    setAiLanes,
    get aiTandem() { return aiTandemOn; },
    setAiTandem,
    getAiLaneOffsets, setAiLaneOffset, addAiLane, removeAiLane,
    perf: (on) => {
      PERF.on = on !== false; PERF.t0 = 0; PERF.n = 0;
      if (PERF.on) console.log('[perf] on — load the save state; a [perf] breakdown prints each second. Driving.perf(false) to stop.');
    },
    get racing() { return !!race; },
    get focusValue() { return focusValue(); },
    focusWorldPos,   /* the camera subject's world position (for the shadow box) */
    driverList,
    setFocusByValue(v) {
      if (v === 'player' || !v) return focusPlayer();
      const slot = +String(v).slice(3);
      const f = fieldCars.find((c) => c.ai && c.slot === slot);
      if (f) setFocus(f);
    },
    focusNext() { cycleFocus(1); }, focusPrev() { cycleFocus(-1); }, focusPlayer,
    setTrackCam, setTvDirector, clearTrackCam, tickTrackCamera,
    start, refresh, setChase, setCarFollow, setDriveCam, exit, update, respawn,
    saveState, loadState, applyGarageSetup, triggerBlowover, flipToRoof, setAiRace,
    setMassScale, setPlayerPeakHp, getPlayerPeakHp, setAiPeakHp, getAiPeakHp, refreshEnginePower,
    setSteerSensitivity, getSteerSensitivity,
    setCollisionTune, getCollisionTune,
    startRace, endRace,
    tickCarCamera, recacheMounts: cacheDriveMounts, refreshCarShape,
  };
})();
/* expose for the DevTools console (top-level `const` isn't a window property, so
   a bare `Driving` isn't resolvable there — e.g. Driving.perf(true)). */
if (typeof window !== 'undefined') window.Driving = Driving;

/* ==================================================================
   WIND TUNNEL — its own room, separate from the showroom: the car
   moves onto a test-section floor in a mock tunnel (nozzle upstream,
   dark collector mouth downstream) while smoke-wand traces and a
   particle stream advect through a flow field built around the body.
   The forces are the SAME panel model the sim drives
   (Physics.aeroProbe) — every panel draws its own force arrow, so
   the aero you SEE is the aero the car feels: floor suction, deck
   downforce, crossflow lift, the backwards scoop. The emergent
   roof-flap blowover, made visible.
   ================================================================== */
const WindTunnel = (() => {
  const FORCE_PER_M = 5200;     /* N per metre of net-force arrow */
  const PANEL_N_PER_M = 3600;   /* N per metre of per-panel arrow */
  const MAX_ARROW_M = 6;
  const FIELD_LEN = 10;         /* along-flow half-length of the stream (m) */
  const SMOKE_N = 720;          /* live smoke puffs (ring buffer) */
  const SMOKE_SUB_LEN = 0.12;   /* max advection substep near the car (m) */
  const SMOKE_SUB_MAX = 12;     /* substep cap (lag frame at top speed) */
  const SMOKE_RATE = 300;       /* puffs emitted per second at the wand tip */
  const WAND_AHEAD = 2.2;       /* wand plane distance ahead of the nose (m) */
  const WAND_GRAB_PX = 26;      /* screen radius to grab the wand dot */
  /* ---- global wind / airflow shape ----
     OWNED BY DriveControls (Aerodynamics > Wind & airflow shape) so it persists
     and bakes with every other setting. flowVel runs per-puff per-substep
     (thousands of calls a frame), so the field reads this cached ref rather
     than the config object graph; refreshFlowTune() re-resolves it ONCE a frame.
     DriveControls REPLACES cfg.flow on every slider edit (immutable update), so
     the ref must be re-read each frame — caching it once would freeze the
     sliders after the first drag. FLOW_FALLBACK only covers the window before
     DriveControls has loaded. */
  const FLOW_FALLBACK = {
    roofLift: 1.20, liftCut: 0.31, bodyPush: 0.60,
    downStr: 0.55, downStart: 0.22, downFade: 8.5,
    wakeDef: 0.44, wakeClose: 0.09, underRam: 0.40,
  };
  let FLOW = FLOW_FALLBACK;
  function refreshFlowTune() {
    const c = (typeof DriveControls !== 'undefined' && DriveControls.get) ? DriveControls.get() : null;
    FLOW = (c && c.flow) ? c.flow : FLOW_FALLBACK;
  }
  const ROOM = { halfL: 16, halfW: 8.4, wallH: 7.8 };   /* x = flow axis (m) */
  const DYNO_PASS_S = 11;
  const DYNO_GEAR = 4;
  const DYNO_REAR_LIFT = 6 * 0.0254;   /* rear tyre contact 6 in above floor */
  const DYNO_ROLLER_R = 0.22;          /* drum radius — top meets lifted tyre */
  const NM_TO_LBFT = 0.737562;
  const MPH = 2.2369362921;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);   /* Driving's clamp is closure-private */

  let active = false;
  let room = null;              /* the tunnel THREE.Scene — built once, reused */
  let group = null;             /* per-session gizmos inside the room */
  let saved = null;             /* car parent/transform + camera, restored on exit */
  let smk = null;               /* smoke-wand puff system (instanced quads) */
  let wandTip = null;           /* smoke emitter position, world */
  let wandMark = null;          /* the visible emitter dot (grab handle) */
  let wandBound = false;        /* pointer handlers hooked once */
  let wandDrag = false;         /* true while the dot is being dragged */
  let emitAcc = 0;              /* fractional puff emission carry */
  let panelArrows = null;       /* one ArrowHelper per aero panel */
  let arrowV = null, arrowH = null, arrowWind = null;
  /* car frame + obstacle, refreshed each frame */
  let base = null;              /* { quat, pos, origin, ax, ay, az } at yaw 0 */
  const nose = new THREE.Vector3(), side = new THREE.Vector3(), up = new THREE.Vector3();
  const flow = new THREE.Vector3();     /* fixed world flow direction (air travel) */
  const streamS = new THREE.Vector3();  /* fixed inlet-plane cross axis (world) */
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
  const _vp = new THREE.Vector3();      /* wand screen-projection scratch */
  const _q = new THREE.Quaternion(), _qy = new THREE.Quaternion();
  const _ray = new THREE.Raycaster();
  const _plane = new THREE.Plane();
  const AXN = new THREE.Vector3(1, 0, 0), AXS = new THREE.Vector3(0, 1, 0), AXU = new THREE.Vector3(0, 0, 1);
  const _axis = new THREE.Vector3();   /* stable yaw axis from the fixed base pose (see refreshBasis) */
  /* the tunnel-mount rotation (stand upright, face upstream): carries the
     model axes to the sim frame nose=(-1,0,0), up=(0,1,0), side=(0,0,1).
     The drive-time smoke runs its whole sim in that frame and maps it onto
     the live car through this quaternion. */
  const QS = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
  const QS_INV = QS.clone().invert();
  /* drive-time flow smoke (the Controls-panel "Smoke stream while driving") */
  let dsGroup = null;         /* car-following anchor in the MAIN scene */
  let dsLocalCenter = null;   /* car OBB centre, model-local (a car-fixed point) */
  let dsModel = null;         /* the modelGroup the profile was built for */
  let dsActive = false;
  let tvScreen = null;          /* wall-mounted dyno chart */
  let dyno = null;              /* active pass state */
  let roomFans = [];              /* spinning fan rotors in the rear bank */
  const WT_WHEEL_IDX = { lf: 0, rf: 1, lr: 2, rr: 3 };
  let wtWheels = [];
  const wtSpin = [0, 0, 0, 0];
  const _wtWR = new THREE.Matrix4(), _wtWT = new THREE.Matrix4(), _wtWE = new THREE.Euler();

  function releaseWtWheels() {
    for (const w of wtWheels) {
      w.mesh.matrixAutoUpdate = true;
      w.mesh.updateMatrix();
    }
    wtWheels = [];
    wtSpin[0] = wtSpin[1] = wtSpin[2] = wtSpin[3] = 0;
  }

  function collectWtWheels() {
    releaseWtWheels();
    if (!modelGroup) return;
    for (const child of modelGroup.children) {
      if (!child.isMesh || !child.userData.isRoadWheel) continue;
      const slot = wheelSlotFromPath(child.name || '');
      if (!slot) continue;
      const idx = WT_WHEEL_IDX[slot];
      child.geometry.computeBoundingBox();
      const bb = child.geometry.boundingBox;
      const c = bb.getCenter(new THREE.Vector3());
      child.matrixAutoUpdate = false;
      wtWheels.push({ mesh: child, c, idx, front: idx < 2 });
    }
  }

  function updateWtWheelSpin(omega, dt) {
    if (!wtWheels.length) return;
    for (const w of wtWheels) {
      if (w.front) continue; /* dyno drives the rear axle only */
      wtSpin[w.idx] = (wtSpin[w.idx] + omega * dt) % (2 * Math.PI);
      _wtWE.set(0, wtSpin[w.idx], 0, 'ZYX');
      _wtWR.makeRotationFromEuler(_wtWE);
      w.mesh.matrix.makeTranslation(w.c.x, w.c.y, w.c.z)
        .multiply(_wtWR)
        .multiply(_wtWT.makeTranslation(-w.c.x, -w.c.y, -w.c.z));
    }
    for (const r of dynoRollers) {
      r.spinAngle = (r.spinAngle + omega * dt) % (2 * Math.PI);
      r.spin.rotation.y = r.spinAngle;
    }
  }

  let dynoRollerGroup = null;
  let dynoRollers = [];
  const _dynoQ = new THREE.Quaternion(), _dynoQ2 = new THREE.Quaternion();

  function dynoWheelOmega(rpm, p) {
    const gear = DYNO_GEAR;
    const total = p.gearRatios[gear] * p.finalDrive;
    return (rpm * 2 * Math.PI / 60) / total;
  }

  function dynoRoadMph(rpm, p) {
    if (!p || !rpm) return 0;
    const total = p.gearRatios[DYNO_GEAR] * p.finalDrive;
    const r = p.wheelRadius + (p.rearStaggerM || 0) * 0.25;
    return (rpm / total) * (2 * Math.PI / 60) * r * MPH;
  }

  function wtArrowsOn() {
    const el = $wt('wt-show-arrows');
    return !!(el && el.checked);
  }

  function prepWtArrow(ar) {
    if (!ar) return;
    ar.frustumCulled = false;
    ar.renderOrder = 20;
    if (ar.line) {
      ar.line.material.depthTest = false;
      ar.line.material.fog = false;
      ar.line.renderOrder = 20;
    }
    if (ar.cone) {
      ar.cone.material.depthTest = false;
      ar.cone.material.fog = false;
      ar.cone.renderOrder = 20;
    }
  }

  function hideWtArrows() {
    if (arrowV) arrowV.visible = false;
    if (arrowH) arrowH.visible = false;
    if (arrowWind) arrowWind.visible = false;
    if (panelArrows) for (const ar of panelArrows) ar.visible = false;
  }

  function wtWheelContactY(w) {
    return new THREE.Box3().setFromObject(w.mesh).min.y;
  }

  function applyDynoStance() {
    if (!wtWheels.length) collectWtWheels();
    if (wtWheels.length < 4) return;
    modelGroup.updateMatrixWorld(true);
    const fronts = wtWheels.filter((w) => w.front);
    const rears = wtWheels.filter((w) => !w.front);
    _v.set(0, 0, 0);
    for (const w of fronts) { w.mesh.localToWorld(_v2.copy(w.c)); _v.add(_v2); }
    _v.multiplyScalar(1 / fronts.length);
    const pivot = _v.clone();
    const rearContact = Math.min(...rears.map(wtWheelContactY));
    const delta = DYNO_REAR_LIFT - rearContact;
    if (delta <= 0.004) return;
    _v2.set(0, 0, 0);
    for (const w of rears) { w.mesh.localToWorld(_v3.copy(w.c)); _v2.add(_v3); }
    _v2.multiplyScalar(1 / rears.length);
    const wb = Math.max(pivot.distanceTo(_v2), 0.6);
    const angle = Math.asin(clamp(delta / wb, 0, 0.14));
    _dynoQ.setFromAxisAngle(side, angle);
    modelGroup.position.sub(pivot).applyQuaternion(_dynoQ).add(pivot);
    modelGroup.quaternion.premultiply(_dynoQ);
    modelGroup.updateMatrixWorld(true);
  }

  function removeDynoRollers() {
    if (!dynoRollerGroup) { dynoRollers = []; return; }
    if (room) room.remove(dynoRollerGroup);
    dynoRollerGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    dynoRollerGroup = null;
    dynoRollers = [];
  }

  function buildDynoRollers() {
    removeDynoRollers();
    const rears = wtWheels.filter((w) => !w.front);
    if (!rears.length || !room) return;
    dynoRollerGroup = new THREE.Group();
    room.add(dynoRollerGroup);
    const drumMat = new THREE.MeshLambertMaterial({ color: 0x4a4a50 });
    const capMat = new THREE.MeshLambertMaterial({ color: 0x888890 });
    const axle = side.clone().normalize();
    const rollerY = DYNO_REAR_LIFT - DYNO_ROLLER_R;
    modelGroup.updateMatrixWorld(true);
    for (const w of rears) {
      w.mesh.localToWorld(_v.copy(w.c));
      const box = new THREE.Box3().setFromObject(w.mesh);
      const sz = box.getSize(_v2);
      const tread = Math.max(0.26, Math.max(sz.x, sz.y, sz.z) * 0.72);
      const mount = new THREE.Group();
      mount.position.set(_v.x, rollerY, _v.z);
      const spin = new THREE.Group();
      spin.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axle);
      const drum = new THREE.Mesh(
        new THREE.CylinderGeometry(DYNO_ROLLER_R, DYNO_ROLLER_R, tread, 32, 6),
        drumMat
      );
      spin.add(drum);
      const capGeo = new THREE.CircleGeometry(DYNO_ROLLER_R, 28);
      for (const sign of [-1, 1]) {
        const cap = new THREE.Mesh(capGeo, capMat);
        cap.position.y = sign * tread * 0.5;
        cap.rotation.x = sign > 0 ? Math.PI / 2 : -Math.PI / 2;
        spin.add(cap);
      }
      mount.add(spin);
      const tray = new THREE.Mesh(
        new THREE.BoxGeometry(0.95, 0.08, tread + 0.42),
        new THREE.MeshLambertMaterial({ color: 0xe8e6e0 })
      );
      tray.position.y = -rollerY + 0.04;
      mount.add(tray);
      dynoRollerGroup.add(mount);
      dynoRollers.push({ spin, spinAngle: 0 });
    }
  }

  const $wt = (id) => document.getElementById(id);
  const panel = () => $wt('wind-tunnel-panel');

  /* ---- smoke wand: a mouse-driven emitter whose fog rides the flow ----
     The fog IS the tire-smoke system (TireFX.createSmokeSystem): the same
     instanced billboards, gaussian noise-eroded puffs, per-puff shade
     variation and near-camera fade as the burnout smoke. The tunnel only
     drives emission and advection through its flow field. */
  function buildSmoke() {
    if (typeof TireFX === 'undefined' || !TireFX.createSmokeSystem) { smk = null; return; }
    smk = TireFX.createSmokeSystem(SMOKE_N);
    smk.cursor = 0;
    smk.age.fill(1);
    smk.life.fill(0);                     /* everything starts dead */
    group.add(smk.points);
    /* the emitter dot the mouse drags around */
    wandMark = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0x2e2e30 }));
    group.add(wandMark);
  }

  /* pixel distance from a pointer to the wand dot's screen position
     (Infinity if the dot is behind the camera) */
  function wandScreenDist(ev) {
    const el = renderer.domElement;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return Infinity;
    _vp.copy(wandTip).project(camera);
    if (_vp.z > 1) return Infinity;
    const sx = rect.left + (_vp.x * 0.5 + 0.5) * rect.width;
    const sy = rect.top + (-_vp.y * 0.5 + 0.5) * rect.height;
    return Math.hypot(ev.clientX - sx, ev.clientY - sy);
  }

  /* pointer → wand: project the pointer onto the emission plane
     (perpendicular to the flow, WAND_AHEAD in front of the nose) */
  function moveWandTo(ev) {
    const el = renderer.domElement;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    _v2.set(((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1, 0);
    _ray.setFromCamera(_v2, camera);
    _v3.copy(base.pos).addScaledVector(flow, -(base.ax + WAND_AHEAD));
    _plane.setFromNormalAndCoplanarPoint(flow, _v3);
    if (!_ray.ray.intersectPlane(_plane, _v)) return;
    const lat = clamp((_v.x - _v3.x) * streamS.x + (_v.y - _v3.y) * streamS.y
      + (_v.z - _v3.z) * streamS.z, -3.5, 3.5);
    wandTip.copy(_v3).addScaledVector(streamS, lat);
    wandTip.y = clamp(_v.y, 0.08, 3.6);
  }

  /* DRAG-AND-DROP: grab the dot (capture phase so orbit never starts on it),
     drag to aim, release to drop. Elsewhere the pointer just orbits. */
  function onWandDown(ev) {
    if (!active || !base || !wandTip) return;
    if (wandScreenDist(ev) > WAND_GRAB_PX) return;   /* not on the dot -> orbit */
    wandDrag = true;
    if (controls) controls.enabled = false;          /* freeze orbit while dragging */
    /* capture keeps the drag alive even if the pointer leaves the canvas */
    try { renderer.domElement.setPointerCapture(ev.pointerId); } catch (e) { /* unsupported */ }
    moveWandTo(ev);
    renderer.domElement.style.cursor = 'grabbing';
    ev.stopPropagation();
    ev.preventDefault();
  }

  function onWandMove(ev) {
    if (!active || !base || !wandTip) return;
    if (wandDrag) { moveWandTo(ev); return; }
    /* hover feedback: show a grab cursor over the dot */
    renderer.domElement.style.cursor =
      wandScreenDist(ev) <= WAND_GRAB_PX ? 'grab' : '';
  }

  function onWandUp(ev) {
    if (!wandDrag) return;
    wandDrag = false;
    if (controls) controls.enabled = true;
    try { if (ev) renderer.domElement.releasePointerCapture(ev.pointerId); } catch (e) { /* noop */ }
    renderer.domElement.style.cursor = '';
  }

  function bindWand() {
    if (wandBound || !renderer || !renderer.domElement) return;
    wandBound = true;
    renderer.domElement.addEventListener('pointerdown', onWandDown, true);
    renderer.domElement.addEventListener('pointermove', onWandMove);
    window.addEventListener('pointerup', onWandUp);
  }

  function emitSmoke(dt, U) {
    emitAcc += SMOKE_RATE * dt;
    let n = Math.floor(emitAcc);
    emitAcc -= n;
    while (n-- > 0) {
      const i = smk.cursor;
      smk.cursor = (smk.cursor + 1) % SMOKE_N;
      smk.pos[i * 3] = wandTip.x + (Math.random() - 0.5) * 0.05;
      smk.pos[i * 3 + 1] = wandTip.y + (Math.random() - 0.5) * 0.05;
      smk.pos[i * 3 + 2] = wandTip.z + (Math.random() - 0.5) * 0.05;
      smk.age[i] = 0;
      /* longer life at low wind so the filament still reaches the car */
      smk.life[i] = clamp(16 / Math.max(U, 2), 1.6, 5.5) * (0.85 + Math.random() * 0.3);
      smk.seedA[i] = Math.random();
    }
  }

  function tickSmoke(dt, U) {
    const p = smk.pos;
    for (let i = 0; i < SMOKE_N; i++) {
      if (smk.age[i] >= smk.life[i]) { smk.alpha[i] = 0; smk.size[i] = 0; continue; }
      smk.age[i] += dt;
      const t = smk.age[i] / smk.life[i];
      const dif = 0.05 + t * 0.22;      /* diffusion churn, growing with age */
      /* SUBSTEP near the car: one Euler step at speed can be over a metre,
         wide enough to jump clean through the shell or a tyre BETWEEN the
         penetration checks (read as smoke passing through the body). Split
         the advance so no substep can cross more than SMOKE_SUB_LEN. */
      let nSub = 1;
      {
        const cdx = p[i * 3] - base.pos.x, cdy = p[i * 3 + 1] - base.pos.y, cdz = p[i * 3 + 2] - base.pos.z;
        const nearR = base.ax + 1.0;
        if (cdx * cdx + cdy * cdy + cdz * cdz < nearR * nearR) {
          /* 1.8x covers the wrap/underbody speed-up over the freestream U */
          nSub = Math.min(SMOKE_SUB_MAX, Math.max(1, Math.ceil(1.8 * U * dt / SMOKE_SUB_LEN)));
        }
      }
      const sdt = dt / nSub;
      for (let s = 0; s < nSub; s++) {
        flowVel(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], U, _v);
        p[i * 3]     += (_v.x + (Math.random() - 0.5) * dif) * sdt;
        p[i * 3 + 1] += (_v.y + (Math.random() - 0.5) * dif) * sdt;
        p[i * 3 + 2] += (_v.z + (Math.random() - 0.5) * dif) * sdt;
        if (p[i * 3 + 1] < 0.03) p[i * 3 + 1] = 0.03;
        /* HARD no-penetration: if a puff ends up inside the body OR a tyre,
           project it out to that surface. The wind never merges into any part. */
        if (base.prof || base.tires) {
          const ex = p[i * 3] - base.pos.x, ey = p[i * 3 + 1] - base.pos.y, ez = p[i * 3 + 2] - base.pos.z;
          let eln = ex * nose.x + ey * nose.y + ez * nose.z;
          let els = ex * side.x + ey * side.y + ez * side.z;
          let elu = ex * up.x + ey * up.y + ez * up.z;
          let moved = false;
          const pr = profAt(eln);                   /* body shell */
          if (pr.ok) {
            const cyc = (pr.top + pr.bot) * 0.5;
            const ch = Math.max((pr.top - pr.bot) * 0.5, 0.12);
            const hw = Math.max(pr.w, 0.12);
            const rho = Math.hypot(els / hw, (elu - cyc) / ch);
            if (rho < 1.0) {
              if (rho > 1e-3) { const k = 1.02 / rho; els *= k; elu = cyc + (elu - cyc) * k; }
              else elu = pr.top + 0.03;             /* dead-centre puff: straight up, out the roof */
              moved = true;
            }
          }
          if (base.tires) {                         /* each tyre cylinder */
            for (let ti = 0; ti < base.tires.length; ti++) {
              const T = base.tires[ti];
              const dln = eln - T.cx, dlu = elu - T.cz, dls = els - T.cy;
              const dr = Math.hypot(dln, dlu);
              if (dr < T.r && Math.abs(dls) < T.hw) {
                if (T.r - dr <= T.hw - Math.abs(dls)) {   /* nearest exit is the tread */
                  const k = (T.r + 0.02) / Math.max(dr, 1e-3);
                  eln = T.cx + dln * k; elu = T.cz + dlu * k;
                } else {                                  /* nearest exit is the sidewall */
                  els = T.cy + (dls >= 0 ? 1 : -1) * (T.hw + 0.02);
                }
                moved = true;
                break;
              }
            }
          }
          if (moved) {
            p[i * 3]     = base.pos.x + nose.x * eln + side.x * els + up.x * elu;
            p[i * 3 + 1] = base.pos.y + nose.y * eln + side.y * els + up.y * elu;
            p[i * 3 + 2] = base.pos.z + nose.z * eln + side.z * els + up.z * elu;
            if (p[i * 3 + 1] < 0.03) p[i * 3 + 1] = 0.03;
          }
        }
      }
      const along = (p[i * 3] - base.pos.x) * flow.x + (p[i * 3 + 1] - base.pos.y) * flow.y
        + (p[i * 3 + 2] - base.pos.z) * flow.z;
      if (along > FIELD_LEN) { smk.age[i] = smk.life[i]; smk.alpha[i] = 0; smk.size[i] = 0; continue; }
      /* quick fade-in, slow fade-out; the puff swells as it ages (the
         TireFX fragment erodes alpha with its noise, so this runs a touch
         higher than it reads) */
      smk.alpha[i] = 0.45 * (1 - t) * Math.min(1, smk.age[i] * 9);
      smk.size[i] = 0.06 + t * 0.6;
    }
    const at = smk.points.geometry.attributes;
    at.aOffset.needsUpdate = true;
    at.aSize.needsUpdate = true;
    at.aAlpha.needsUpdate = true;
    at.aSeed.needsUpdate = true;
    if (wandMark) wandMark.position.copy(wandTip);
  }

  function refreshBasis(yaw) {
    /* car spins about its OWN up axis by the wind angle, relative to the pose
       it holds in the showroom (Y-up) or on track (Z-up) — never moved.
       The yaw axis is derived FRESH from the fixed base pose each call, NOT from
       the live `up` we overwrite below: feeding the mutated `up` back in
       amplified its floating-point drift ×2 per frame at 180° (×1 at 60°), so
       the axis tilted and the car tumbled — the "freak out" at 180°, identical
       at any wind speed because the driver was orientation feedback, not
       dynamic pressure. base.quat is fixed for the session, so this axis is
       constant and the pose stays clean at every yaw. */
    _axis.copy(AXU).applyQuaternion(base.quat);
    _qy.setFromAxisAngle(_axis, yaw);
    modelGroup.quaternion.copy(base.quat).premultiply(_qy);
    modelGroup.getWorldQuaternion(_q);
    nose.copy(AXN).applyQuaternion(_q);
    side.copy(AXS).applyQuaternion(_q);
    up.copy(AXU).applyQuaternion(_q);
  }


  function makeFanRotor(fanR, bladeMat) {
    const rotor = new THREE.Group();
    const blen = fanR * 0.97;
    for (let i = 0; i < 5; i++) {
      const arm = new THREE.Group();
      arm.rotation.z = (i / 5) * Math.PI * 2;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.084, blen, 0.0264), bladeMat);
      blade.position.y = blen * 0.5;
      arm.add(blade);
      rotor.add(arm);
    }
    rotor.position.z = -0.012;
    return rotor;
  }

  function buildRearWall(L, W, H, wallM, inset, bankBot, bankTop, bankL, bankR, thick) {
    const x = L - inset;
    const put = (hy, hz, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(thick, hy, hz), wallM);
      m.position.set(x, y, z);
      room.add(m);
    };
    const hAbove = H - bankTop;
    if (hAbove > 0.05) put(hAbove, 2 * W, bankTop + hAbove * 0.5, 0);
    if (bankBot > 0.05) put(bankBot, 2 * W, bankBot * 0.5, 0);
    const bankH = bankTop - bankBot;
    const leftW = bankL - (-W);
    if (leftW > 0.05) put(bankH, leftW, bankBot + bankH * 0.5, (-W + bankL) * 0.5);
    const rightW = W - bankR;
    if (rightW > 0.05) put(bankH, rightW, bankBot + bankH * 0.5, (bankR + W) * 0.5);
  }

  function buildFanWall(L, W, H, lam, wallM, inset) {
    roomFans = [];
    const redMat = lam(0xc43a2f);
    redMat.side = THREE.DoubleSide;
    const put = (geo, mat, x, y, z, rx, ry) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      if (rx) m.rotation.x = rx;
      if (ry) m.rotation.y = ry;
      room.add(m);
      return m;
    };

    const cy = 2.58;
    const fanR = 0.45;
    const pitchY = 1.64;
    const pitchZ = 1.72;
    const rows = 3;
    const cols = 4;
    const y0 = cy - ((rows - 1) * pitchY) / 2;
    const z0 = -((cols - 1) * pitchZ) / 2;
    const frameX = L - 0.62;
    const framePad = 0.08;
    const frameBar = 0.26;
    const frameDep = 0.52;
    const fanX = frameX;                          /* blades centered in housing depth */
    const zMin = z0 - fanR - framePad;
    const zMax = z0 + (cols - 1) * pitchZ + fanR + framePad;
    const yMin = y0 - fanR - framePad;
    const yMax = y0 + (rows - 1) * pitchY + fanR + framePad;
    const bankBot = Math.max(0.02, yMin);
    const bankTop = yMax;
    const bankL = zMin;
    const bankR = zMax;
    const rearThick = 0.08;
    const frameW = zMax - zMin;
    const frameH = yMax - yMin;
    const zC = (zMin + zMax) * 0.5;
    const yC = (yMin + yMax) * 0.5;
    const spanZ = frameW + frameBar * 2;

    /* rear wall panels — solid around the fan grid; bays stay open (no per-fan discs) */
    buildRearWall(L, W, H, wallM, inset, bankBot, bankTop, bankL, bankR, rearThick);

    /* red housing — one slab with circular cutouts sized to the blade disc */
    const halfZ = spanZ * 0.5;
    const halfY = (frameH + frameBar * 2) * 0.5;
    const holeR = fanR * 1.0;
    const shape = new THREE.Shape();
    shape.moveTo(-halfZ, -halfY);
    shape.lineTo(halfZ, -halfY);
    shape.lineTo(halfZ, halfY);
    shape.lineTo(-halfZ, halfY);
    shape.closePath();
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const fy = y0 + row * pitchY;
        const fz = z0 + col * pitchZ;
        const hole = new THREE.Path();
        hole.absarc(fz - zC, fy - yC, holeR, 0, Math.PI * 2, true);
        shape.holes.push(hole);
      }
    }
    const housingGeo = new THREE.ExtrudeGeometry(shape, {
      depth: frameDep, bevelEnabled: false, curveSegments: 40,
    });
    housingGeo.rotateY(Math.PI / 2);
    housingGeo.translate(frameX, yC, zC);
    put(housingGeo, redMat, 0, 0, 0);

    const bladeMat = lam(0xf4f4f6);

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const fy = y0 + row * pitchY;
        const fz = z0 + col * pitchZ;

        const g = new THREE.Group();
        g.position.set(fanX, fy, fz);
        g.rotation.y = Math.PI / 2;
        g.add(makeFanRotor(fanR, bladeMat));
        room.add(g);
        roomFans.push({ rotor: g.children[0], sign: 1 });
      }
    }
  }

  function tickFans(dt, windMs) {
    if (!roomFans.length) return;
    const spd = Math.max(0, windMs || 0);
    const omega = 1.2 + spd * 0.22;
    for (const f of roomFans) {
      f.rotor.rotation.z += omega * dt * f.sign;
    }
  }

  function disposeRoom() {
    if (!room) return;
    room.traverse((o) => {
      if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    });
    removeDynoRollers();
    room = null;
    tvScreen = null;
    roomFans = [];
  }

  /* ---- NASCAR closed-section tunnel (Y-up; air travels +X, fans at rear) ---- */
  function buildRoom() {
    room = new THREE.Scene();
    room.background = new THREE.Color(0x585858);
    room.fog = new THREE.Fog(0x5e5e5e, 32, 78);
    const amb = new THREE.AmbientLight(0xffffff, 0.48);
    const key = new THREE.DirectionalLight(0xfff6ee, 0.68);
    key.position.set(2, 14, 8);
    const fill = new THREE.DirectionalLight(0xd8e4ff, 0.3);
    fill.position.set(-8, 10, -6);
    room.add(amb, key, fill);

    const lam = (c) => new THREE.MeshLambertMaterial({ color: c });
    const add = (geo, mat, x, y, z, rx, ry) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      if (rx) m.rotation.x = rx;
      if (ry) m.rotation.y = ry;
      room.add(m);
      return m;
    };
    const L = ROOM.halfL, W = ROOM.halfW, H = ROOM.wallH;

    /* concrete test-section floor (flush, no floating slats) */
    add(new THREE.BoxGeometry(2 * L, 0.12, 2 * W), lam(0x6a6a6a), 0, -0.06, 0);
    for (let x = -L + 3; x < L - 2; x += 5) {
      add(new THREE.BoxGeometry(0.035, 0.003, 2 * W - 1.2), lam(0x555555), x, 0.001, 0);
    }
    for (const z of [-1.72, 1.72]) {
      add(new THREE.BoxGeometry(2 * L, 0.004, 0.2), lam(0x484848), 0, 0.002, z);
    }

    /* one plane per wall, offset into the room — no coplanar wainscot (z-fight) */
    const wallM = lam(0x626262);
    const inset = 0.04;
    add(new THREE.PlaneGeometry(2 * L, H), wallM, 0, H / 2, -W + inset);
    add(new THREE.PlaneGeometry(2 * L, H), wallM, 0, H / 2, W - inset, 0, Math.PI);
    add(new THREE.PlaneGeometry(2 * W, H), wallM, -L + inset, H / 2, 0, 0, Math.PI / 2);
    /* rear wall panels around fan cutouts — built in buildFanWall */
    add(new THREE.PlaneGeometry(2 * L, 2 * W), lam(0x565656), 0, H - 0.02, 0, Math.PI / 2);
    for (let x = -L + 3; x < L - 1; x += 4.2) {
      for (let z = -W + 2; z < W - 1; z += 3.6) {
        add(new THREE.PlaneGeometry(0.95, 0.95),
          new THREE.MeshBasicMaterial({ color: 0xffffff }), x, H - 0.22, z, Math.PI / 2);
      }
    }

    /* front intake — recessed box only (no overlapping planes / lip z-fight) */
    add(new THREE.BoxGeometry(0.32, 3.5, 5.8), lam(0x222226), -L + 0.2, 1.85, 0);
    add(new THREE.BoxGeometry(0.1, 3.6, 5.9), lam(0x707070), -L + inset, 1.85, 0);

    buildFanWall(L, W, H, lam, wallM, inset);

    buildTvScreen();
  }

  /* ---- wall TV + dyno readout ---- */
  function buildTvScreen() {
    if (tvScreen) return;
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4.05, 2.03), mat);
    const W = ROOM.halfW;
    mesh.position.set(-3.0, 3.55, -W + 0.18);
    mesh.rotation.y = 0;
    room.add(mesh);
    /* thin bezel */
    const bez = new THREE.Mesh(new THREE.BoxGeometry(4.19, 2.14, 0.06),
      new THREE.MeshLambertMaterial({ color: 0x1a1a1e }));
    bez.position.copy(mesh.position);
    bez.position.z -= 0.04;
    room.add(bez);
    tvScreen = { canvas, ctx, tex, mesh, points: [], prevPoints: [], status: 'idle', peakHp: 0, peakTq: 0, peakRpm: 0 };
    drawTvIdle();
  }

  function tvDynoSubtitle() {
    if (typeof mod !== 'undefined' && mod) {
      const f = mod.folderName || '';
      const m = mod.modelName || '';
      if (f && m) return f + ' / ' + m;
      return f || m || '';
    }
    return '';
  }

  function dynoChartPeaks(points) {
    let maxHp = 0, maxHpRpm = 0, maxTq = 0, maxTqRpm = 0;
    if (!points || !points.length) return { maxHp, maxHpRpm, maxTq, maxTqRpm };
    for (const pt of points) {
      if (pt.hp > maxHp) { maxHp = pt.hp; maxHpRpm = pt.rpm; }
      if (pt.tqLb > maxTq) { maxTq = pt.tqLb; maxTqRpm = pt.rpm; }
    }
    return { maxHp, maxHpRpm, maxTq, maxTqRpm };
  }

  function dynoChartYMax(points, prevPoints) {
    let m = 0;
    const scan = (pts) => {
      if (!pts) return;
      for (const pt of pts) {
        if (pt.hp > m) m = pt.hp;
        if (pt.tqLb > m) m = pt.tqLb;
      }
    };
    scan(points);
    scan(prevPoints);
    m = Math.ceil(m / 50) * 50;
    return Math.max(400, m);
  }

  function drawTvBase(ctx, W, H) {
    ctx.fillStyle = '#f8f8f8';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.font = 'bold 20px Arial, sans-serif';
    ctx.fillText('RE2003', W * 0.5, 26);
    const sub = tvDynoSubtitle();
    if (sub) {
      ctx.font = '13px Arial, sans-serif';
      ctx.fillText(sub, W * 0.5, 44);
    }
    ctx.textAlign = 'right';
    ctx.font = '11px Arial, sans-serif';
    ctx.fillText('CF: SAE    Smoothing: 3', W - 16, 18);
    ctx.textAlign = 'left';
  }

  function drawDynojetLegend(ctx, rect, peaks, prevPeaks, runLabel) {
    if (!peaks || peaks.maxHp <= 0) return;
    const hpLine = 'Max Power = ' + Math.round(peaks.maxHp)
      + ' at Engine RPM = ' + Math.round(peaks.maxHpRpm);
    const tqLine = 'Max Torque = ' + Math.round(peaks.maxTq)
      + ' at Engine RPM = ' + Math.round(peaks.maxTqRpm);
    const hasPrev = prevPeaks && prevPeaks.maxHp > 0;
    let prevHpLine = '';
    let prevTqLine = '';
    if (hasPrev) {
      prevHpLine = 'Max Power = ' + Math.round(prevPeaks.maxHp)
        + ' at Engine RPM = ' + Math.round(prevPeaks.maxHpRpm);
      prevTqLine = 'Max Torque = ' + Math.round(prevPeaks.maxTq)
        + ' at Engine RPM = ' + Math.round(prevPeaks.maxTqRpm);
    }
    const sq = 10;
    const gap = 6;
    ctx.font = '11px Arial, sans-serif';
    const hpW = ctx.measureText(hpLine).width;
    const tqW = ctx.measureText(tqLine).width;
    let innerW = sq + gap + hpW + 18 + sq + gap + tqW;
    let prevHpW = 0;
    let prevTqW = 0;
    if (hasPrev) {
      prevHpW = ctx.measureText(prevHpLine).width;
      prevTqW = ctx.measureText(prevTqLine).width;
      const prevInnerW = sq + gap + prevHpW + 18 + sq + gap + prevTqW;
      if (prevInnerW > innerW) innerW = prevInnerW;
    }
    const boxH = hasPrev ? 42 : 22;
    const boxW = innerW + 16;
    const boxX = rect.x + (rect.w - boxW) * 0.5;
    const boxY = rect.y + rect.h - boxH - 10;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(boxX + 2, boxY + 2, boxW, boxH);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);

    function drawLegendRow(rowBoxY, textY, lineHp, lineTq, wHp, wTq, colHp, colTq) {
      let tx = boxX + 8;
      ctx.fillStyle = colHp;
      ctx.fillRect(tx, rowBoxY + 6, sq, sq);
      tx += sq + gap;
      ctx.fillStyle = colHp;
      ctx.fillText(lineHp, tx, textY);
      tx += wHp + 18;
      ctx.fillStyle = colTq;
      ctx.fillRect(tx, rowBoxY + 6, sq, sq);
      tx += sq + gap;
      ctx.fillStyle = colTq;
      ctx.fillText(lineTq, tx, textY);
    }

    drawLegendRow(boxY, boxY + 15, hpLine, tqLine, hpW, tqW, '#ff0000', '#0000ff');
    if (hasPrev) {
      const row2BoxY = boxY + 20;
      drawLegendRow(row2BoxY, row2BoxY + 15, prevHpLine, prevTqLine, prevHpW, prevTqW, 'rgba(255,0,0,0.2)', 'rgba(0,0,255,0.2)');
    }
    ctx.restore();
  }

  function drawTvGraph(ctx, rect, live) {
    if (!tvScreen) return;
    const points = tvScreen.points || [];
    const prevPoints = tvScreen.prevPoints || [];
    const p = tvScreen._dynoP || (typeof Physics !== 'undefined' ? Physics.PARAMS : null);
    const rpmMin = p ? p.idleRpm : 800;
    const rpmMax = p ? p.redlineRpm : 9000;
    const yMax = dynoChartYMax(points, prevPoints);
    const { x, y, w, h } = rect;
    const pad = { l: 48, r: 52, t: 22, b: 38 };
    const gw = w - pad.l - pad.r;
    const gh = h - pad.t - pad.b;
    const plotX = x + pad.l;
    const plotY = y + pad.t;
    const plotW = gw;
    const plotH = gh;

    const grad = ctx.createLinearGradient(0, plotY, 0, plotY + plotH);
    grad.addColorStop(0, '#ededed');
    grad.addColorStop(1, '#b5b5b5');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);

    const xOf = (rpm) => plotX + ((rpm - rpmMin) / (rpmMax - rpmMin)) * plotW;
    const yOfVal = (val) => plotY + plotH - (val / yMax) * plotH;

    ctx.strokeStyle = '#d0d0d0';
    ctx.lineWidth = 1;
    for (let v = 0; v <= yMax; v += 50) {
      const gy = yOfVal(v);
      ctx.beginPath();
      ctx.moveTo(plotX, gy);
      ctx.lineTo(plotX + plotW, gy);
      ctx.stroke();
    }
    const rpmStep = 500;
    let rpm0 = Math.ceil(rpmMin / rpmStep) * rpmStep;
    for (let rpm = rpm0; rpm <= rpmMax; rpm += rpmStep) {
      const gx = xOf(rpm);
      ctx.beginPath();
      ctx.moveTo(gx, plotY);
      ctx.lineTo(gx, plotY + plotH);
      ctx.stroke();
    }

    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.beginPath();
    ctx.moveTo(plotX, plotY);
    ctx.lineTo(plotX, plotY + plotH);
    ctx.lineTo(plotX + plotW, plotY + plotH);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(plotX + plotW, plotY);
    ctx.lineTo(plotX + plotW, plotY + plotH);
    ctx.stroke();

    ctx.fillStyle = '#000000';
    ctx.font = '10px Arial, sans-serif';
    ctx.textAlign = 'center';
    for (let rpm = rpm0; rpm <= rpmMax; rpm += rpmStep) {
      const gx = xOf(rpm);
      ctx.fillText((rpm / 1000).toFixed(1), gx, plotY + plotH + 14);
    }
    ctx.fillText('Engine RPM (rpmx1000)', plotX + plotW * 0.5, y + h - 6);

    ctx.textAlign = 'right';
    for (let v = 0; v <= yMax; v += 50) {
      ctx.fillText(String(v), plotX - 6, yOfVal(v) + 3);
    }
    ctx.save();
    ctx.translate(x + 14, plotY + plotH * 0.5);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('Power (hp)', 0, 0);
    ctx.restore();

    ctx.textAlign = 'left';
    for (let v = 0; v <= yMax; v += 50) {
      ctx.fillText(String(v), plotX + plotW + 6, yOfVal(v) + 3);
    }
    ctx.save();
    ctx.translate(x + w - 14, plotY + plotH * 0.5);
    ctx.rotate(Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('Torque (ft-lbs)', 0, 0);
    ctx.restore();
    ctx.textAlign = 'left';

    function strokeSeries(pts, color, field, alpha) {
      if (!pts.length) return;
      ctx.save();
      ctx.globalAlpha = alpha != null ? alpha : 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      pts.forEach((pt, i) => {
        const px = xOf(pt.rpm);
        const py = yOfVal(field === 'hp' ? pt.hp : pt.tqLb);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.restore();
    }

    if (prevPoints.length) {
      strokeSeries(prevPoints, '#ff0000', 'hp', 0.2);
      strokeSeries(prevPoints, '#0000ff', 'tq', 0.2);
    }
    if (points.length) {
      strokeSeries(points, '#ff0000', 'hp', 1);
      strokeSeries(points, '#0000ff', 'tq', 1);
    }

    if (points.length) {
      const peaks = dynoChartPeaks(points);
      drawDynojetLegend(ctx, { x: plotX, y: plotY, w: plotW, h: plotH }, peaks, dynoChartPeaks(prevPoints), null);
    }
  }

  function drawTvDyno(live) {
    if (!tvScreen) return;
    const { canvas, ctx } = tvScreen;
    const W = canvas.width, H = canvas.height;
    drawTvBase(ctx, W, H);
    drawTvGraph(ctx, { x: 20, y: 50, w: W - 40, h: H - 62 }, live);
    tvScreen.tex.needsUpdate = true;
  }

  function drawTvIdle() {
    if (!tvScreen) return;
    const { canvas, ctx } = tvScreen;
    const W = canvas.width, H = canvas.height;
    drawTvBase(ctx, W, H);
    drawTvGraph(ctx, { x: 20, y: 50, w: W - 40, h: H - 62 }, false);
    tvScreen.tex.needsUpdate = true;
  }

  function drawTvRunning() {
    drawTvDyno(true);
  }

  function drawTvResults(peakHp, peakTq, peakRpm) {
    if (!tvScreen) return;
    tvScreen.peakHp = peakHp;
    tvScreen.peakTq = peakTq;
    tvScreen.peakRpm = peakRpm;
    drawTvDyno(false);
  }

  function getDynoParams() {
    const car = new Physics.Car();
    if (typeof track !== 'undefined' && track && track.setup) car.applySetup(track.setup);
    if (typeof track !== 'undefined' && track && track.env) car.applyTrackEnv(track.env);
    const peakHp = (typeof Driving !== 'undefined' && Driving.getPlayerPeakHp)
      ? Driving.getPlayerPeakHp() : 750;
    car.p.enginePowerMul = Physics.hpTargetToMul(peakHp, car.p);
    return car.p;
  }

  function dynoSample(rpm, p, throttle) {
    const mul = p.enginePowerMul ?? 1;
    const tqEngine = Physics.wotNetTorqueNm(rpm, p, mul);
    const hp = Physics.hpFromTorqueNm(tqEngine, rpm);
    return { tqEngine, hp, tqLb: tqEngine * NM_TO_LBFT };
  }

  function startDynoPass() {
    if (!active || (dyno && dyno.running)) return;
    const p = getDynoParams();
    if (!wtWheels.length) collectWtWheels();
    wtSpin[0] = wtSpin[1] = wtSpin[2] = wtSpin[3] = 0;
    for (const r of dynoRollers) r.spinAngle = 0;
    dyno = {
      running: true, t: 0, rpm: p.idleRpm, throttle: 0, points: [], lastSampleT: -1,
      peakHold: 0,
      p, peakHp: 0, peakTq: 0, peakRpm: p.idleRpm,
    };
    if (tvScreen) {
      if (tvScreen.points && tvScreen.points.length) tvScreen.prevPoints = tvScreen.points.slice();
      tvScreen.points = [];
      tvScreen.peakHp = tvScreen.peakTq = 0;
      tvScreen.peakRpm = p.idleRpm;
      tvScreen._dynoP = p;
      tvScreen.status = 'running';
      drawTvRunning();
    }
    const el = $wt('wt-dyno-readout');
    if (el) el.innerHTML = '<div class="wt-row"><span>Status</span><b>Running…</b></div>';
    const btn = $wt('wt-dyno-run');
    if (btn) btn.disabled = true;
    if (typeof log === 'function') {
      log('Dyno — full-throttle pull in 4th gear. Watch the wall TV — RUNNING during the pull, results when done.');
    }
  }

  function finishDynoPass() {
    if (!dyno || !dyno.running) return;
    dyno.running = false;
    if (tvScreen) {
      tvScreen.status = 'done';
      drawTvResults(dyno.peakHp, dyno.peakTq, dyno.peakRpm);
    }
    const el = $wt('wt-dyno-readout');
    if (el) {
      el.innerHTML = `<div class="wt-row"><span>Peak HP</span><b>${Math.round(dyno.peakHp)} @ ${Math.round(dyno.peakRpm)} rpm</b></div>` +
        `<div class="wt-row"><span>Peak Tq</span><b class="wt-down">${Math.round(dyno.peakTq)} lb·ft</b></div>`;
    }
    const btn = $wt('wt-dyno-run');
    if (btn) btn.disabled = false;
    if (typeof log === 'function') {
      log(`Dyno pass complete — peak ${Math.round(dyno.peakHp)} HP @ ${Math.round(dyno.peakRpm)} rpm, ${Math.round(dyno.peakTq)} lb·ft.`);
    }
  }

  const DYNO_THROTTLE_RAMP = 3.2;  /* seconds to wide-open throttle */
  const DYNO_RPM_SLEW = 720;         /* rpm/s — ~12 s sweep idle→redline */
  const DYNO_PEAK_HOLD = 1.1;        /* hold at redline before showing results */
  const DYNO_MAX_T = 40;

  function tickDyno(dt) {
    if (!dyno || !dyno.running) return;
    dt = Math.min(dt, 0.04);
    dyno.t += dt;
    const p = dyno.p;
    dyno.throttle = clamp(dyno.throttle + dt / DYNO_THROTTLE_RAMP, 0, 1);

    let rpmCmd = p.idleRpm;
    if (dyno.throttle > 0.04) {
      rpmCmd = p.idleRpm + dyno.throttle * (p.redlineRpm - p.idleRpm);
    }
    const rpmSlew = dyno.throttle > 0.04 ? DYNO_RPM_SLEW : DYNO_RPM_SLEW * 2;
    dyno.rpm += clamp(rpmCmd - dyno.rpm, -rpmSlew * 2 * dt, rpmSlew * dt);
    dyno.rpm = clamp(dyno.rpm, p.idleRpm, p.redlineRpm);

    const sample = dynoSample(dyno.rpm, p, dyno.throttle);
    updateWtWheelSpin(dynoWheelOmega(dyno.rpm, p), dt);

    if (dyno.t - dyno.lastSampleT >= 0.06) {
      dyno.lastSampleT = dyno.t;
      dyno.points.push({ rpm: dyno.rpm, tq: sample.tqEngine, tqLb: sample.tqLb, hp: sample.hp });
      if (sample.hp > dyno.peakHp) { dyno.peakHp = sample.hp; dyno.peakRpm = dyno.rpm; }
      if (sample.tqLb > dyno.peakTq) dyno.peakTq = sample.tqLb;
    }

    if (tvScreen) {
      tvScreen.points = dyno.points;
      tvScreen.peakHp = dyno.peakHp;
      tvScreen.peakTq = dyno.peakTq;
      tvScreen.peakRpm = dyno.peakRpm;
      tvScreen._liveRpm = dyno.rpm;
      tvScreen._liveMph = dynoRoadMph(dyno.rpm, p);
      tvScreen._liveHp = sample.hp;
      tvScreen._liveTq = sample.tqLb;
      drawTvDyno(true);
    }

    if (dyno.rpm >= p.redlineRpm - 120 && dyno.throttle > 0.95) dyno.peakHold += dt;
    else dyno.peakHold = 0;
    if (dyno.peakHold > DYNO_PEAK_HOLD || dyno.t > DYNO_MAX_T) finishDynoPass();
  }

    /* ---- body silhouette, sampled from the ACTUAL car mesh ----
     One ellipsoid can't know the roofline, greenhouse, or notch, so the old
     flow let smoke pass through the body. Instead we loft the real shape: bin
     every body vertex by station along the nose axis and record, per station,
     the half-width, roof height and floor height. The flow deflects around
     THIS profile and smoke is hard-ejected if it ever lands inside it. Built
     in the car's own frame (yaw-invariant), rebuilt on every car swap. */
  const PROF_N = 44;
  const _prof = { w: 0, top: 0, bot: 0, ok: false };

  function buildBodyProfile() {
    const N = PROF_N;
    const w = new Float32Array(N), top = new Float32Array(N), bot = new Float32Array(N);
    const cnt = new Uint32Array(N);
    for (let i = 0; i < N; i++) { top[i] = -1e9; bot[i] = 1e9; }
    const tmp = new THREE.Vector3();
    const px = base.pos.x, py = base.pos.y, pz = base.pos.z;
    const scan = (cb) => {
      modelGroup.updateMatrixWorld(true);
      modelGroup.traverse((o) => {
        if (!o.isMesh || o.userData.isRoadWheel) return;   /* body only, not tyres */
        const pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
        if (!pos) return;
        const m = o.matrixWorld;
        for (let k = 0; k < pos.count; k++) {
          tmp.set(pos.getX(k), pos.getY(k), pos.getZ(k)).applyMatrix4(m);
          const rx = tmp.x - px, ry = tmp.y - py, rz = tmp.z - pz;
          cb(rx * nose.x + ry * nose.y + rz * nose.z,
            rx * side.x + ry * side.y + rz * side.z,
            rx * up.x + ry * up.y + rz * up.z);
        }
      });
    };
    let lnMin = 1e9, lnMax = -1e9;
    scan((ln) => { if (ln < lnMin) lnMin = ln; if (ln > lnMax) lnMax = ln; });
    if (!(lnMax > lnMin)) { base.prof = null; return; }
    const dLn = (lnMax - lnMin) / N;
    scan((ln, ls, lu) => {
      let idx = Math.floor((ln - lnMin) / dLn);
      if (idx < 0) idx = 0; else if (idx >= N) idx = N - 1;
      const aw = Math.abs(ls);
      if (aw > w[idx]) w[idx] = aw;
      if (lu > top[idx]) top[idx] = lu;
      if (lu < bot[idx]) bot[idx] = lu;
      cnt[idx]++;
    });
    /* fill empty stations from their nearest filled neighbour (both ways) */
    const filled = new Uint8Array(N);
    for (let i = 0; i < N; i++) filled[i] = cnt[i] ? 1 : 0;
    for (let i = 1; i < N; i++) if (!filled[i] && filled[i - 1]) { w[i] = w[i - 1]; top[i] = top[i - 1]; bot[i] = bot[i - 1]; filled[i] = 1; }
    for (let i = N - 2; i >= 0; i--) if (!filled[i] && filled[i + 1]) { w[i] = w[i + 1]; top[i] = top[i + 1]; bot[i] = bot[i + 1]; filled[i] = 1; }
    /* smooth (kills antenna/mirror single-station spikes) + a small margin so
       smoke rides just off the paint rather than clipping it */
    const smooth = (arr) => {
      const c = arr.slice();
      for (let i = 0; i < N; i++) {
        arr[i] = c[i > 0 ? i - 1 : 0] * 0.25 + c[i] * 0.5 + c[i < N - 1 ? i + 1 : N - 1] * 0.25;
      }
    };
    smooth(w); smooth(w); smooth(top); smooth(top); smooth(bot); smooth(bot);
    for (let i = 0; i < N; i++) { w[i] += 0.07; top[i] += 0.05; bot[i] -= 0.03; }
    base.prof = { lnMin, lnMax, dLn, n: N, w, top, bot };
  }

  /* the four tyres are their OWN blockers (a single body ellipse can't carry a
     bulge at each corner), so the air goes AROUND the wheels and smoke can't
     pass through them. Each becomes a cylinder in the car frame: axis along
     the axle (side), radius in the nose/up plane, half-tread along side.
     Rims + tyre of one corner merge by wheel prefix (lf/rf/lr/rr). */
  function buildTires() {
    const g = {};
    const tmp = new THREE.Vector3();
    const px = base.pos.x, py = base.pos.y, pz = base.pos.z;
    modelGroup.updateMatrixWorld(true);
    modelGroup.traverse((o) => {
      if (!o.isMesh || !o.userData.isRoadWheel) return;
      const pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
      if (!pos) return;
      const m = (o.name || '').match(/([lr][fr])wheel/i);
      const key = m ? m[1].toLowerCase() : (o.name || 'w');
      let e = g[key];
      if (!e) e = g[key] = { ln: [], lu: [], lsMin: 1e9, lsMax: -1e9 };
      const mm = o.matrixWorld;
      for (let k = 0; k < pos.count; k++) {
        tmp.set(pos.getX(k), pos.getY(k), pos.getZ(k)).applyMatrix4(mm);
        const rx = tmp.x - px, ry = tmp.y - py, rz = tmp.z - pz;
        e.ln.push(rx * nose.x + ry * nose.y + rz * nose.z);
        e.lu.push(rx * up.x + ry * up.y + rz * up.z);
        const ls = rx * side.x + ry * side.y + rz * side.z;
        if (ls < e.lsMin) e.lsMin = ls; if (ls > e.lsMax) e.lsMax = ls;
      }
    });
    const tires = [];
    for (const key in g) {
      const e = g[key];
      if (e.ln.length < 8) continue;
      let lnMin = 1e9, lnMax = -1e9, luMin = 1e9, luMax = -1e9;
      for (let j = 0; j < e.ln.length; j++) {
        const a = e.ln[j], b = e.lu[j];
        if (a < lnMin) lnMin = a; if (a > lnMax) lnMax = a;
        if (b < luMin) luMin = b; if (b > luMax) luMax = b;
      }
      const cx = (lnMin + lnMax) * 0.5, cz = (luMin + luMax) * 0.5, cy = (e.lsMin + e.lsMax) * 0.5;
      let r = 0;
      for (let j = 0; j < e.ln.length; j++) {
        const dr = Math.hypot(e.ln[j] - cx, e.lu[j] - cz);
        if (dr > r) r = dr;
      }
      tires.push({ cx, cy, cz, r, hw: (e.lsMax - e.lsMin) * 0.5 });
    }
    base.tires = tires.length ? tires : null;
  }

  /* interpolate the profile at station ln (car frame); fills _prof.ok=false
     when ln is off either end of the body */
  function profAt(ln) {
    const P = base && base.prof;
    if (!P || ln < P.lnMin - 0.15 || ln > P.lnMax + 0.15) { _prof.ok = false; return _prof; }
    let f = (ln - P.lnMin) / P.dLn;
    let i = Math.floor(f);
    if (i < 0) i = 0; else if (i > P.n - 2) i = P.n - 2;
    const a = clamp(f - i, 0, 1);
    _prof.w = P.w[i] * (1 - a) + P.w[i + 1] * a;
    _prof.top = P.top[i] * (1 - a) + P.top[i + 1] * a;
    _prof.bot = P.bot[i] * (1 - a) + P.bot[i + 1] * a;
    _prof.ok = true;
    return _prof;
  }

  /* ---- flow field: freestream + body deflection + underbody ram + wake.
     Advects every smoke puff; the deflection follows the lofted body profile
     so the air goes over the roof, around the greenhouse and into the notch
     exactly where the real shape is. */
  function flowVel(px, py, pz, U, out) {
    out.set(flow.x * U, flow.y * U, flow.z * U);
    const rx = px - base.pos.x, ry = py - base.pos.y, rz = pz - base.pos.z;
    const ln = rx * nose.x + ry * nose.y + rz * nose.z;   /* car-frame coords */
    const ls = rx * side.x + ry * side.y + rz * side.z;
    const lu = rx * up.x + ry * up.y + rz * up.z;
    /* along-flow station + wake extents. Hoisted above the body block because
       the deflection below needs to know when the stream is PAST the roof
       crest — the shell must stop lifting there. */
    const aF = rx * flow.x + ry * flow.y + rz * flow.z;
    const cosA = Math.abs(flow.dot(nose));
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const aFl = base.ax * cosA + base.ay * sinA + 0.3;   /* half-length along flow */
    const bL = base.ay * cosA + base.ax * sinA + 0.25;   /* lateral half-extent */
    const bV = base.az + 0.15;                           /* vertical half-extent */
    /* AFT fade: 1 ahead of the roof crest, 0 by the backlight. Past the crest
       the shell has no business still shoving the stream skyward — that
       lingering lift fighting the downwash is what humped the flow before it
       fell away. Only the UPWARD push is faded; the sides keep wrapping. */
    const aft = clamp(1 - aF / Math.max(aFl * FLOW.liftCut, 1e-3), 0, 1);
    /* real body cross-section at this station */
    const prof = profAt(ln);
    if (prof.ok) {
      const cyc = (prof.top + prof.bot) * 0.5;             /* section centre height */
      const ch = Math.max((prof.top - prof.bot) * 0.5, 0.12);
      const hw = Math.max(prof.w, 0.12);
      if (lu < prof.bot && Math.abs(ls) < hw + 0.15) {
        /* UNDERBODY: below the floor line the air rams the splitter gap —
           squeezed low and sped up (the venturi the ge panels feel) */
        const inGap = clamp(1 - Math.abs(ls) / (hw + 0.15), 0, 1);
        out.multiplyScalar(1 + FLOW.underRam * inGap);
        out.addScaledVector(up, -U * 0.08 * inGap);        /* stay low, don't rise */
      } else {
        /* elliptical body section (car frame): rho<1 is inside the shell */
        const ny = ls / hw, nz = (lu - cyc) / ch;
        const rho = Math.hypot(ny, nz);
        if (rho < 2.4) {
          /* outward surface normal, car frame -> world */
          _v2.copy(side).multiplyScalar(ny / hw).addScaledVector(up, nz / ch);
          if (_v2.lengthSq() < 1e-9) _v2.copy(up);
          _v2.normalize();
          /* flow lifts over the roof — but only UP TO the crest (`aft`), so the
             stream is free to fall away off the back of the greenhouse */
          if (nz > 0) _v2.addScaledVector(up, FLOW.roofLift * aft).normalize();
          /* PART the stream: from ~2.4 body-radii out the into-body component
             is progressively removed (fully by rho 1.12) and the pace is kept
             by sliding along the surface, so the wind wraps the car instead of
             stalling at the paint. Leeward flow (vin>=0) is untouched. */
          const vin = out.dot(_v2);
          if (vin < 0) {
            let blk = clamp((2.4 - rho) / 1.28, 0, 1);
            blk = blk * blk * (3 - 2 * blk);
            const sp = out.length();
            out.addScaledVector(_v2, -vin * blk);
            const sp2 = out.length();
            /* keep-cap 3x: at the stagnation line the tangential remainder is
               tiny, and restoring full pace there would fling puffs sideways */
            if (sp2 > 1e-6) out.multiplyScalar(Math.min(1 + blk * (sp / sp2 - 1), 3));
          }
          /* push the stream around the body, strongest at the skin. Aft of the
             crest the vertical part of that push is faded out (pushScale) while
             the lateral wrap is untouched — the sides still part the air, the
             roof just stops holding the stream up. */
          const pushScale = 1 - (1 - aft) * clamp(nz, 0, 1);
          out.addScaledVector(_v2, U * FLOW.bodyPush * clamp(1.25 - rho, 0, 1) * pushScale);
        }
      }
    }
    /* TYRES: each corner is a cylinder (axle along `side`). Air rounds the
       tread radially and spills off the ends axially — never straight through. */
    if (base.tires) {
      for (let ti = 0; ti < base.tires.length; ti++) {
        const T = base.tires[ti];
        const dln = ln - T.cx, dlu = lu - T.cz, dls = ls - T.cy;
        const dr = Math.hypot(dln, dlu);
        if (dr > (T.r + 0.05) * 1.6 || Math.abs(dls) > T.hw + 0.2) continue;
        if (Math.abs(dls) < T.hw + 0.05) {
          /* within the tread slab: part the stream radially out of the disc,
             keeping its pace along the tread (same wrap as the body shell) */
          const rr = dr / (T.r + 0.05);
          if (rr < 1.6) {
            if (dr > 1e-4) _v2.copy(nose).multiplyScalar(dln / dr).addScaledVector(up, dlu / dr);
            else _v2.copy(up);
            _v2.normalize();
            const vin = out.dot(_v2);
            if (vin < 0) {
              let blk = clamp((1.6 - rr) / 0.52, 0, 1);
              blk = blk * blk * (3 - 2 * blk);
              const sp = out.length();
              out.addScaledVector(_v2, -vin * blk);
              const sp2 = out.length();
              if (sp2 > 1e-6) out.multiplyScalar(Math.min(1 + blk * (sp / sp2 - 1), 3));
            }
            out.addScaledVector(_v2, U * 0.45 * clamp(1.15 - rr, 0, 1));
          }
        } else if (dr < T.r + 0.05) {
          /* just off the sidewall end: nudge the flow axially past the wheel */
          _v2.copy(side).multiplyScalar(dls >= 0 ? 1 : -1);
          const vin = out.dot(_v2);
          if (vin < 0) out.addScaledVector(_v2, -vin * 0.6);
        }
      }
    }
    /* wake extent (aF / aFl / bL / bV are hoisted to the top of the function) */
    /* WAKE: past the body the stream detaches into a low-momentum region —
       the smoke slows and the shear layers draw it back toward the wake axis
       (reattachment). NO coherent time oscillation: a real wake breaks up
       into fine turbulence, which the per-puff diffusion in tickSmoke already
       supplies — a clean sinusoidal sway read as a fake wave (it isn't how
       the real car's wake behaves). */
    if (aF > aFl * 0.6 && aF < aFl + 7) {
      const cx = rx - flow.x * aF, cy = ry - flow.y * aF, cz = rz - flow.z * aF;
      const wakeR = Math.max(bL, bV) + 0.3;
      const cd2 = cx * cx + cy * cy + cz * cz;
      if (cd2 < wakeR * wakeR) {
        const fade = 1 - clamp((aF - aFl) / 7, 0, 1);
        out.multiplyScalar(1 - FLOW.wakeDef * fade);  /* momentum deficit */
        const cd = Math.sqrt(cd2);
        if (cd > 1e-3) {                              /* steady closure inward */
          const inw = U * FLOW.wakeClose * fade / cd;
          out.x -= cx * inw; out.y -= cy * inw; out.z -= cz * inw;
        }
      }
    }
    /* REAR DOWNWASH: the stream that rode up over the roof must come back down
       behind the car instead of coasting off level. The wake closure above only
       reaches within ~1 m of the axis, so a stream riding high over the roof
       never gets touched. This is a separate, taller field: over the rear third
       of the roof and on into the near-wake, any air ABOVE the body centreline
       is pulled down (−up), harder the higher it sits, so it descends and
       trails the decklid/spoiler down. It self-eases as the stream drops (lower
       air, weaker pull) and fades out well downstream. */
    const aStart = aFl * FLOW.downStart;              /* where the downwash bites */
    if (aF > aStart && aF < aFl + FLOW.downFade && lu > 0) {
      const latHalf = bL + 0.8;
      if (Math.abs(ls) < latHalf) {
        /* bite at the crest (starting late let the stream sail on and hump
           before it fell), hold full over the deck, then ease off downstream
           so it trails instead of ploughing into the floor */
        const aFull = aFl * 0.5;                      /* fully in by mid-backlight */
        let ramp;
        if (aF < aFull) ramp = clamp((aF - aStart) / Math.max(aFull - aStart, 1e-3), 0, 1);
        else if (aF <= aFl) ramp = 1;
        else ramp = 1 - clamp((aF - aFl) / Math.max(FLOW.downFade, 1e-3), 0, 1);
        ramp = ramp * ramp * (3 - 2 * ramp);
        const latFade = clamp(1 - Math.abs(ls) / latHalf, 0, 1);
        const downV = U * FLOW.downStr * Math.min(lu, 2.4) * ramp * latFade;
        out.addScaledVector(up, -downV);
      }
    }
  }

  /* ---- one arrow per aero panel: the ACTUAL model the sim integrates ---- */
  function buildPanelArrows() {
    panelArrows = (Physics.AERO_PANELS || []).map(() => {
      const ar = new THREE.ArrowHelper(AXU, _v.set(0, 0, 0), 0.4, 0xffffff, 0.14, 0.08);
      ar.visible = false;
      prepWtArrow(ar);
      room.add(ar);
      return ar;
    });
  }

  function updatePanelArrows(det) {
    if (!panelArrows) return;
    if (!wtArrowsOn()) { for (const ar of panelArrows) ar.visible = false; return; }
    const byNm = {};
    if (det) for (const d of det) byNm[d.nm] = d;
    const src = Physics.AERO_PANELS;
    for (let i = 0; i < panelArrows.length; i++) {
      const ar = panelArrows[i], d = byNm[src[i].nm];
      if (!d) { ar.visible = false; continue; }
      _v.set(d.f[0], d.f[1], d.f[2]).applyQuaternion(_q);   /* body → world */
      const mag = _v.length();
      const len = clamp(mag / PANEL_N_PER_M, 0, 2.0);
      if (len < 0.07) { ar.visible = false; continue; }
      /* panel sits in body frame off the tyre-plane centre */
      _v2.copy(base.origin)
        .addScaledVector(nose, d.pos[0])
        .addScaledVector(side, d.pos[1])
        .addScaledVector(up, d.pos[2]);
      ar.position.copy(_v2);
      ar.setDirection(_v3.copy(_v).multiplyScalar(1 / mag));
      ar.setLength(len, Math.min(0.3, len * 0.34), Math.min(0.16, len * 0.2));
      const w = _v.dot(up);
      ar.setColor(w < -0.35 * mag ? 0x5b8fd6 : w > 0.35 * mag ? 0xe0a83c : 0xc4473d);
      ar.visible = true;
    }
  }

  /* park the current modelGroup in the tunnel, upstream-facing, wheels on
     the section floor, and (re)derive the car frame + flow axes + wand home.
     Shared by enter() and remountCar() (car hot-swap while active). */
  function mountCarInRoom() {
    /* the car moves into the tunnel: Z-up model stood upright (same -π/2 X
       as the showroom), faced UPSTREAM (nose toward the nozzle at -X) */
    room.add(modelGroup);
    _qy.setFromAxisAngle(AXS, Math.PI);       /* AXS doubles as world +Y */
    _q.setFromAxisAngle(AXN, -Math.PI / 2);   /* AXN doubles as world +X */
    modelGroup.quaternion.copy(_qy).multiply(_q);
    modelGroup.position.set(0, 0, 0);
    /* wheels on the section floor, centred between the floor tracks */
    let box = new THREE.Box3().setFromObject(modelGroup);
    const c = box.getCenter(new THREE.Vector3());
    modelGroup.position.set(-c.x, -box.min.y, -c.z);
    box = new THREE.Box3().setFromObject(modelGroup);
    const size = box.getSize(new THREE.Vector3());
    const q = modelGroup.getWorldQuaternion(new THREE.Quaternion());
    up.copy(AXU).applyQuaternion(q);            /* car up (world) */
    nose.copy(AXN).applyQuaternion(q);          /* car nose (world) */
    side.copy(AXS).applyQuaternion(q);
    collectWtWheels();
    applyDynoStance();
    box = new THREE.Box3().setFromObject(modelGroup);
    size.copy(box.getSize(new THREE.Vector3()));
    /* AABB half-extents projected onto the car's own axes (exact at the
       axis-aligned yaw-0 pose) — sizes the deflector ellipsoid */
    const halfAlong = (u) =>
      (Math.abs(u.x) * size.x + Math.abs(u.y) * size.y + Math.abs(u.z) * size.z) * 0.5;
    base = {
      quat: modelGroup.quaternion.clone(),
      pos: box.getCenter(new THREE.Vector3()),
      origin: null,
      ax: Math.max(1.2, halfAlong(nose)),
      ay: Math.max(0.7, halfAlong(side)),
      az: Math.max(0.5, halfAlong(up)),
    };
    base.origin = new THREE.Vector3(base.pos.x, 0, base.pos.z);   /* tyre plane */
    /* wind travels so it hits the nose at yaw 0 (nose faces upstream) */
    flow.copy(nose).addScaledVector(up, -nose.dot(up)).normalize().multiplyScalar(-1);
    /* inlet axes fixed in the WORLD — the stream never turns with the car */
    streamS.crossVectors(up, flow).normalize();
    /* loft the true body silhouette + the four tyre cylinders from the mesh
       (flow deflection + hard no-penetration for every part) */
    buildBodyProfile();
    buildTires();
    /* wand home: centreline, mid-hood height, ahead of the nose */
    wandTip = wandTip || new THREE.Vector3();
    wandTip.copy(base.pos).addScaledVector(flow, -(base.ax + WAND_AHEAD));
    wandTip.y = 0.85;
    buildDynoRollers();
  }

  /* car hot-swap (series / paint change) while the tunnel is open: buildModel
     has already made a fresh modelGroup, so re-park it and re-home the fixed
     wind arrow. Gizmos (panel arrows, smoke) persist and re-read `base`. */
  function remountCar() {
    if (!active || !room || !modelGroup) return;
    mountCarInRoom();
    if (arrowWind) {
      arrowWind.position.copy(base.pos).addScaledVector(flow, -FIELD_LEN * 0.85);
      arrowWind.setDirection(flow);
    }
  }

  /* ============ drive-time flow smoke ("Smoke stream while driving") ======
     The SAME flow field, profile, tyre cylinders, wrap, substepping and hard
     no-penetration as the tunnel, run in the tunnel's own sim frame with the
     apparent wind taken from the live car's body-frame velocity, then mapped
     onto the driven car each frame. A slide shows the crosswind wrap live.
     Never runs while the tunnel is open (the two share the closure state). */
  function dsTeardown() {
    if (!dsActive) return;
    dsActive = false;
    dsModel = null;
    dsLocalCenter = null;
    if (dsGroup) {
      dsGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      scene.remove(dsGroup);
      dsGroup = null;
    }
    if (!active) {              /* tunnel closed: the shared refs were ours */
      smk = null;
      wandMark = null;
      base = null;
    }
  }

  function dsBuild() {
    if (!modelGroup || !scene) return false;
    if (typeof TireFX === 'undefined' || !TireFX.createSmokeSystem) return false;
    /* live world basis of the driven car */
    modelGroup.getWorldQuaternion(_q);
    nose.copy(AXN).applyQuaternion(_q);
    side.copy(AXS).applyQuaternion(_q);
    up.copy(AXU).applyQuaternion(_q);
    const mgp = modelGroup.getWorldPosition(new THREE.Vector3());
    /* car-frame OBB over every mesh (wheels included: they set the floor) */
    let lnMin = 1e9, lnMax = -1e9, lsMin = 1e9, lsMax = -1e9, luMin = 1e9, luMax = -1e9;
    const tmp = new THREE.Vector3();
    modelGroup.updateMatrixWorld(true);
    modelGroup.traverse((o) => {
      if (!o.isMesh) return;
      const pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
      if (!pos) return;
      const m = o.matrixWorld;
      for (let k = 0; k < pos.count; k++) {
        tmp.set(pos.getX(k), pos.getY(k), pos.getZ(k)).applyMatrix4(m);
        const rx = tmp.x - mgp.x, ry = tmp.y - mgp.y, rz = tmp.z - mgp.z;
        const ln = rx * nose.x + ry * nose.y + rz * nose.z;
        const ls = rx * side.x + ry * side.y + rz * side.z;
        const lu = rx * up.x + ry * up.y + rz * up.z;
        if (ln < lnMin) lnMin = ln; if (ln > lnMax) lnMax = ln;
        if (ls < lsMin) lsMin = ls; if (ls > lsMax) lsMax = ls;
        if (lu < luMin) luMin = lu; if (lu > luMax) luMax = lu;
      }
    });
    if (!(lnMax > lnMin)) return false;
    const cLn = (lnMin + lnMax) / 2, cLs = (lsMin + lsMax) / 2, cLu = (luMin + luMax) / 2;
    base = {
      quat: null,
      pos: new THREE.Vector3().copy(mgp)
        .addScaledVector(nose, cLn).addScaledVector(side, cLs).addScaledVector(up, cLu),
      origin: null,
      ax: Math.max(1.2, (lnMax - lnMin) / 2),
      ay: Math.max(0.7, (lsMax - lsMin) / 2),
      az: Math.max(0.5, (luMax - luMin) / 2),
    };
    /* loft the silhouette + tyres in the LIVE pose (the data is car-frame) */
    buildBodyProfile();
    buildTires();
    /* remember the OBB centre as a car-fixed point, then re-express the frame
       in the tunnel's sim space: nose -X, up +Y, side +Z, tyre plane y=0 */
    dsLocalCenter = modelGroup.worldToLocal(base.pos.clone());
    base.pos = new THREE.Vector3(0, cLu - luMin, 0);
    base.origin = new THREE.Vector3(0, 0, 0);
    nose.set(-1, 0, 0);
    side.set(0, 0, 1);
    up.set(0, 1, 0);
    flow.set(1, 0, 0);
    streamS.crossVectors(up, flow).normalize();
    /* car-following anchor + its own smoke system in the MAIN scene */
    dsGroup = new THREE.Group();
    scene.add(dsGroup);
    smk = TireFX.createSmokeSystem(SMOKE_N);
    smk.cursor = 0;
    smk.age.fill(1);
    smk.life.fill(0);
    dsGroup.add(smk.points);
    wandMark = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0x2e2e30 }));
    dsGroup.add(wandMark);
    wandTip = wandTip || new THREE.Vector3();
    emitAcc = 0;
    dsModel = modelGroup;
    dsActive = true;
    return true;
  }

  function tickDriveSmoke(dt) {
    if (active) return;                    /* the tunnel owns the shared state */
    const sc = (typeof DriveControls !== 'undefined' && DriveControls.get().smoke) || null;
    const wantOn = !!(sc && sc.on && typeof Driving !== 'undefined' && Driving.active && modelGroup);
    if (!wantOn) { dsTeardown(); return; }
    if (!dsActive || dsModel !== modelGroup) {
      dsTeardown();
      if (!dsBuild()) return;
    }
    if (!smk) return;
    refreshFlowTune();                     /* on track the tunnel tick never runs */
    dt = Math.min(dt || 0.016, 0.05);      /* tab-back frames must not fling smoke */
    /* apparent wind in the car frame: air travels opposite the car's motion,
       so a slide or spin shows the crossflow wrapping the body in real time */
    const fs = Driving.flowState;
    const spd = fs ? Math.hypot(fs.u, fs.v) : 0;
    if (fs && spd > 0.8) {
      _v.copy(nose).multiplyScalar(-fs.u / spd).addScaledVector(side, -fs.v / spd);
      if (_v.lengthSq() > 1e-6) flow.copy(_v).normalize();
    } else {
      flow.set(1, 0, 0);                   /* at rest: gentle nose-on stream */
    }
    streamS.crossVectors(up, flow).normalize();
    const U = Math.max(4, spd * MPH) * 0.11;   /* same visual pace as the tunnel */
    /* emitter locked upstream of the car, placed by the Controls sliders */
    wandTip.copy(base.pos).addScaledVector(flow, -(base.ax + WAND_AHEAD))
      .addScaledVector(streamS, clamp(Number(sc.side) || 0, -3.5, 3.5));
    wandTip.y = clamp(Number(sc.height) || 0.85, 0.05, 3.5);
    emitSmoke(dt, U);
    tickSmoke(dt, U);
    /* map the sim space onto the live car: the rotation carries the tunnel
       mount axes to the car's world axes, the position pins the OBB centres */
    modelGroup.getWorldQuaternion(_q);
    dsGroup.quaternion.copy(_q).multiply(QS_INV);
    _v.copy(dsLocalCenter);
    modelGroup.localToWorld(_v);
    _v2.copy(base.pos).applyQuaternion(dsGroup.quaternion);
    dsGroup.position.copy(_v).sub(_v2);
  }

  function enter() {
    if (active || !scene || !modelGroup || typeof Physics === 'undefined') return;
    if (Driving.active) Driving.exit(false);
    dsTeardown();               /* the tunnel takes over the shared flow state */
    disposeRoom();
    buildRoom();
    saved = {
      parent: modelGroup.parent,
      position: modelGroup.position.clone(),
      quaternion: modelGroup.quaternion.clone(),
      scale: modelGroup.scale.clone(),
      camPos: camera.position.clone(),
      camTarget: controls.target.clone(),
    };
    mountCarInRoom();

    group = new THREE.Group();
    room.add(group);
    arrowWind = new THREE.ArrowHelper(flow, _v.copy(base.pos).addScaledVector(flow, -FIELD_LEN * 0.85), 2.4, 0x8fb0d8, 0.6, 0.34);
    arrowV = new THREE.ArrowHelper(up, base.pos, 1, 0xe0a83c, 0.5, 0.3);
    arrowH = new THREE.ArrowHelper(nose, base.pos, 1, 0xc4473d, 0.5, 0.3);
    prepWtArrow(arrowWind);
    prepWtArrow(arrowV);
    prepWtArrow(arrowH);
    room.add(arrowWind, arrowV, arrowH);
    hideWtArrows();
    buildSmoke();
    buildPanelArrows();
    bindWand();
    emitAcc = 0;

    /* three-quarter view: nose toward the fan wall, TV on the left wall */
    camera.position.set(2.4, 2.05, 9.6);
    controls.target.set(0, 1.05, 0);
    controls.update();

    if (panel()) panel().hidden = false;
    active = true;
    if (typeof log === 'function') {
      log('R&D — drag the smoke wand to trace airflow; sweep wind angle for aero. ' +
          'Hit Run dyno pass for a full pull; the wall TV records torque & HP. ' +
          'Showroom (top bar) or ✕ to return.');
    }
  }

  function exit() {
    if (!active) return;
    active = false;
    /* drop any in-progress wand drag and clear the grab cursor */
    wandDrag = false;
    if (renderer && renderer.domElement) renderer.domElement.style.cursor = '';
    if (group) {
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      room.remove(group);
      group = null;
    }
    for (const ar of [arrowWind, arrowV, arrowH]) {
      if (!ar) continue;
      if (ar.line) { ar.line.geometry.dispose(); ar.line.material.dispose(); }
      if (ar.cone) { ar.cone.geometry.dispose(); ar.cone.material.dispose(); }
      if (room) room.remove(ar);
    }
    if (panelArrows) {
      for (const ar of panelArrows) {
        if (ar.line) { ar.line.geometry.dispose(); ar.line.material.dispose(); }
        if (ar.cone) { ar.cone.geometry.dispose(); ar.cone.material.dispose(); }
        if (room) room.remove(ar);
      }
    }
    smk = null;
    wandMark = null;
    panelArrows = null;
    arrowV = arrowH = arrowWind = null;
    if (saved) {
      (saved.parent || scene).add(modelGroup);
      modelGroup.position.copy(saved.position);
      modelGroup.quaternion.copy(saved.quaternion);
      modelGroup.scale.copy(saved.scale);
      camera.position.copy(saved.camPos);
      controls.target.copy(saved.camTarget);
      controls.update();
      saved = null;
      if (typeof Driving !== 'undefined') Driving.refreshCarShape();
    } else if (modelGroup) {
      if (track && trackGroup) {
        if (modelGroup.parent !== trackGroup) {
          if (modelGroup.parent) modelGroup.parent.remove(modelGroup);
          trackGroup.add(modelGroup);
        }
      } else if (modelGroup.parent !== scene) {
        if (modelGroup.parent) modelGroup.parent.remove(modelGroup);
        scene.add(modelGroup);
      }
    }
    releaseWtWheels();
    if (modelGroup) modelGroup.visible = true;
    removeDynoRollers();
    base = null;
    dyno = null;
    if (panel()) panel().hidden = true;
    const dr = $wt('wt-dyno-readout');
    if (dr) dr.innerHTML = '';
  }

  function toggle() { if (active) exit(); else enter(); }

  function aeroOpts() {
    const aero = (typeof DriveControls !== 'undefined') ? DriveControls.get().aero : null;
    const env = (typeof track !== 'undefined') && track && track.env;
    return {
      rho: env && Number.isFinite(env.airDensity) ? env.airDensity : undefined,
      dragScale: aero ? aero.dragScale : 1,
      blowoverScale: aero ? aero.blowoverScale : 1,
      flaps: false,
    };
  }

  const _adir = new THREE.Vector3();
  function setArrow(arrow, vec, magN, color) {
    const len = clamp(magN / FORCE_PER_M, 0, MAX_ARROW_M);
    if (len < 0.08 || vec.lengthSq() < 1e-9) { arrow.visible = false; return; }
    arrow.visible = true;
    arrow.position.copy(base.pos);
    arrow.setDirection(_adir.copy(vec).normalize());
    arrow.setLength(len, Math.min(0.55, len * 0.3), Math.min(0.32, len * 0.17));
    arrow.setColor(color);
  }

  function tick(dt) {
    if (!active) return;
    dt = Math.min(dt || 0.016, 0.05);   /* tab-back frames must not fling smoke */
    refreshFlowTune();       /* ONCE a frame — flowVel must never walk the config */
    const speed = $wt('wt-speed') ? parseFloat($wt('wt-speed').value) : 60;
    const yawDeg = $wt('wt-yaw') ? parseFloat($wt('wt-yaw').value) : 0;
    const yaw = yawDeg * Math.PI / 180;
    /* probe yaw ψ = wind angle off the nose; with the flow fixed in the world
       the CAR turns by −ψ to present that angle (nose swings right, wind
       appears from the left — matches the probe's body-frame v sign) */
    refreshBasis(-yaw);

    const U = Math.max(4, speed) * 0.11;   /* visual stream speed */
    tickFans(dt, speed);
    if (smk) { emitSmoke(dt, U); tickSmoke(dt, U); }

    const a = Physics.aeroProbe(speed, yaw, Object.assign(aeroOpts(), { detail: true }));
    if (wtArrowsOn()) {
      updatePanelArrows(a.panels);
      /* body force → world through the car's LIVE orientation */
      _v.set(a.fx, a.fy, a.fz).applyQuaternion(_q);
      const upMag = _v.dot(up);
      _adir.copy(up).multiplyScalar(upMag);                 /* vertical part */
      setArrow(arrowV, _adir, Math.abs(upMag), upMag >= 0 ? 0xe0a83c : 0x5b8fd6);
      _v.addScaledVector(up, -upMag);                       /* horizontal remainder */
      setArrow(arrowH, _v, _v.length(), 0xc4473d);
      if (arrowWind) {
        arrowWind.visible = true;
        arrowWind.position.copy(base.pos).addScaledVector(flow, -FIELD_LEN * 0.85);
        arrowWind.setDirection(flow);
        arrowWind.setLength(clamp(speed / 16, 0.6, 5), 0.6, 0.34);
      }
    } else hideWtArrows();

    const el = $wt('wt-readout');
    if (el) {
      const blows = a.lift > a.blowThreshN && speed >= 40;
      const vLabel = a.fz >= 0 ? 'Lift' : 'Downforce';
      const vClass = a.fz >= 0 ? 'wt-lift' : 'wt-down';
      el.innerHTML =
        `<div class="wt-row"><span>Wind</span><b>${(speed * MPH).toFixed(0)} mph · ${speed.toFixed(0)} m/s</b></div>` +
        `<div class="wt-row"><span>Drag</span><b>${Math.round(Math.abs(a.drag))} N</b></div>` +
        `<div class="wt-row"><span>Side</span><b>${Math.round(Math.abs(a.side))} N</b></div>` +
        `<div class="wt-row"><span>${vLabel}</span><b class="${vClass}">${Math.round(Math.abs(a.fz))} N</b></div>` +
        `<div class="wt-flag ${blows ? 'on' : ''}">${blows
          ? `⚠ BLOWS OVER - lift beats the ${Math.round(a.blowThreshN)} N pivot`
          : `stable - pivot at ${Math.round(a.blowThreshN)} N lift`}</div>`;
    }
    const sv = $wt('wt-speed-val'); if (sv) sv.textContent = `${(speed * MPH).toFixed(0)} mph`;
    const yv = $wt('wt-yaw-val'); if (yv) yv.textContent = `${yawDeg.toFixed(0)}°`;
    tickDyno(dt);
  }

  return { toggle, enter, exit, tick, remountCar, tickDriveSmoke, startDynoPass,
    get active() { return active; },
    get scene() { return room; } };
})();

/* ---------- garage panel (track setups → drive physics) ---------- */
function populateGarageUI() {
  const sec = $('vp-garage-sec'), sel = $('vp-setup-select');
  if (!sec || !sel || typeof SimSetup === 'undefined') return;
  const setups = (track && track.setups) || [];
  if (!setups.length) { sec.hidden = true; return; }
  sec.hidden = false;
  sel.innerHTML = '';
  setups.forEach((s, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    const nice = s.name && s.name.toLowerCase() !== s.fileName.toLowerCase() ? ` - ${s.name}` : '';
    opt.textContent = SimSetup.label(s) + nice;
    sel.appendChild(opt);
  });
  const cur = Math.max(0, setups.indexOf(track.setup));
  sel.value = String(cur);
  sel.onchange = () => {
    const s = setups[parseInt(sel.value, 10)] || null;
    track.setup = s;
    renderSetupInfo(s);
    if (s && typeof Driving !== 'undefined' && Driving.active) Driving.applyGarageSetup();
  };
  renderSetupInfo(setups[cur] || null);
}

function renderSetupInfo(s) {
  const el = $('vp-setup-info');
  if (!el) return;
  if (!s) { el.innerHTML = ''; return; }
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const row = (k, v) => (v == null ? '' : `<div class="vp-setup-row"><span>${k}</span><b>${esc(v)}</b></div>`);
  const head = (t) => `<div class="vp-setup-head">${t}</div>`;
  const four = (arr, f) => (arr && arr.length === 4 && arr.every((v) => v != null) ? arr.map(f).join(' / ') : null);
  const toIn = (m) => (m * 39.3701).toFixed(2) + '"';
  const toDeg = (r) => (r * SimSetup.RAD_TO_DEG).toFixed(1) + '°';
  const toLb = (kg) => Math.round(kg * SimSetup.KG_TO_LB) + ' lb';

  let html = '';
  html += head('Chassis');
  html += row('Steering ratio', s.steeringRatio != null ? s.steeringRatio.toFixed(0) + ':1' : null);
  html += row('Final drive', s.finalDrive != null ? s.finalDrive.toFixed(2) + ':1' : null);
  html += row('Gears 1-4', s.transRatios ? s.transRatios.map((v) => v.toFixed(2)).join(' / ') : null);
  html += row('Brake bias', s.brakeBiasFront != null ? (s.brakeBiasFront * 100).toFixed(0) + '% front' : null);
  html += row('Spoiler', s.spoilerDeg != null ? s.spoilerDeg.toFixed(0) + '°' : null);
  html += row('Grille tape', s.grilleTapePct != null ? s.grilleTapePct.toFixed(0) + '%' : null);
  html += row('Left ballast', s.leftBallastKg ? toLb(s.leftBallastKg) : null);
  html += row('Wedge', s.wedgeKg ? (s.wedgeKg > 0 ? '+' : '−') + toLb(Math.abs(s.wedgeKg)) : null);
  html += head('Tires · LF / RF / LR / RR');
  html += row('Pressure psi', four(s.tirePressuresPsi, (v) => v.toFixed(0) + ''));
  html += row('Camber', four(s.camberRad, (v) => toDeg(v)));
  html += head('Suspension');
  html += row('Springs lb/in', four(s.springRatesNpm, (v) => String(Math.round(v * SimSetup.NPM_TO_LBIN))));
  const rh = s.rideHeightM;
  html += row('Ride LF/RF/R', rh && rh.lf != null && rh.rf != null && rh.rear != null
    ? [rh.lf, rh.rf, rh.rear].map(toIn).join(' / ') : null);
  html += row('Track bar L/R', s.trackBarM && s.trackBarM[0] != null && s.trackBarM[1] != null
    ? s.trackBarM.map(toIn).join(' / ') : null);
  html += row('Stagger F/R', (s.staggerFrontM != null && s.staggerRearM != null)
    ? `${(s.staggerFrontM * 39.3701).toFixed(2)} / ${(s.staggerRearM * 39.3701).toFixed(2)}"` : null);
  if (typeof Physics !== 'undefined') {
    const d = SimSetup.derive(s, Physics.PARAMS);
    html += head('Scales (derived)');
    html += row('Corner wt lb', d.cornerLb.map((v) => Math.round(v)).join(' / '));
    html += row('Cross / Left', `${d.crossPct.toFixed(1)}% / ${d.leftPct.toFixed(1)}%`);
  }
  if (s.notes) html += `<div class="vp-setup-notes">${esc(s.notes)}</div>`;
  el.innerHTML = html;
}

/* ---------- texture lookup / decode ---------- */
const baseName = (n) => (n || '').replace(/\\/g, '/').split('/').pop().toLowerCase();

/* Path of a picked/dropped file relative to the opened folder, as parts.
   Directory-picker files carry webkitRelativePath; dropped-folder files get
   _relPath attached by walkEntry; single-file inputs fall back to the bare
   name (counts as root). */
function relPathParts(f) {
  const rel = f.webkitRelativePath || f._relPath || f.name || '';
  return rel.replace(/\\/g, '/').split('/').filter(Boolean);
}

/* The game reads loose overrides from the track/mod folder ROOT (plus the
   trackmat\ surface-sheet dir) — nested extras like BBMC's optional
   "SD Pack/" of low-res sheets are INERT until the user copies them up.
   Treat only root(-ish) files as loose so those packs stay inert here too. */
function isRootLoose(f) {
  const parts = relPathParts(f);
  if (parts.length <= 2) return true;      /* "<folder>/file" or a bare name */
  return parts.length === 3 && parts[1].toLowerCase() === 'trackmat';
}
function mergePool(datItems, looseFiles) {
  const byName = new Map();
  for (const it of (looseFiles || [])) {
    if (it.root === false) byName.set(baseName(it.name), it);   /* nested: gap-filler only */
  }
  for (const it of (datItems || [])) byName.set(baseName(it.name), it);
  for (const it of (looseFiles || [])) {
    if (it.root !== false) byName.set(baseName(it.name), it);   /* root loose wins */
  }
  return [...byName.values()];
}

/* Loads `<car>.cam` (MACC) per car — mode 10 is the hood/nose view. */
function resolveCarCam(pool, modelName) {
  if (typeof CarCam === 'undefined') return null;
  const items = [...pool.values()];
  const base = baseName(modelName).toLowerCase();
  const pick = (pred) => items.find(it => pred(baseName(it.name).toLowerCase()));
  const item = pick(n => n === base + '.cam' || n === base)
    || pick(n => n.startsWith('make_a') && n.endsWith('.cam'))
    || pick(n => n.endsWith('.cam'));
  if (!item) return null;
  const parsed = CarCam.parse(item.data);
  if (!parsed || !parsed.mode10) return null;
  return parsed;
}


function findFileBytes(name, prefer) {
  const want = baseName(name);
  /* The game's search order per source: folder root over the .dat. Nested
     loose files (SD Pack/, template extras) only ever fill gaps.
     prefer='track' searches the TRACK's pools first: the game resolves each
     3do's textures against its OWN archive's search path, so a track object
     never reads the car mod's same-named sheet. Without this, cws2015's 4 KB
     roll-cage foam.mip (solid black) shadowed Bristol's 350 KB fence-truss
     foam.mip (77% cutout) and the catch-fence braces drew as solid black
     sawtooth blades. Car parts keep mod-first (paints, card templates). */
  const isRoot = (it) => it.root !== false;    /* dat entries carry no flag */
  const isNested = (it) => it.root === false;
  const modLayers = [
    [mod?.looseFiles, isRoot], [mod?.datItems, null], [mod?.looseFiles, isNested],
  ];
  const trackLayers = [
    [track?.looseFiles, isRoot], [track?.datItems, null], [track?.looseFiles, isNested],
  ];
  const layers = prefer === 'track'
    ? [...trackLayers, ...modLayers]
    : [...modLayers, ...trackLayers];
  for (const [pool, filt] of layers) {
    if (!pool) continue;
    const hit = pool.find(it => (!filt || filt(it)) && baseName(it.name) === want);
    if (hit) return hit.data;
  }
  return null;
}

/* Default-paint fallback: cars without a .car paint use the per-make
   card_<manufacturer>.mip (classic cup slot order). On mods whose card.mip is
   a legacy placeholder (FCRD NCS22 ships the 2003 Monte Carlo sheet), that
   per-make sheet IS the real template paint — and it follows the .car paint
   uv layout, not the legacy template layout. */
const CARD_MAKE_SLOTS = ['chevrolet', 'dodge', 'ford', 'pontiac'];

function templateCardName(makeIdx) {
  const slot = CARD_MAKE_SLOTS[makeIdx] || CARD_MAKE_SLOTS[0];
  const name = `card_${slot}.mip`;
  return findFileBytes(name) ? name : null;
}

/* texture bytes, honoring per-mod overrides (template body sheet swap).
   prefer='track' = track-source lookup: no mod overrides, track pools first. */
function bytesForTexture(name, prefer) {
  const key = baseName(name);
  const override = prefer !== 'track' && mod && mod.textureOverrides
    ? mod.textureOverrides.get(key) : null;
  return findFileBytes(override || name, prefer);
}


/* ---- infield aerial artifact repair ----
   Some track infield aerial sheets (e.g. Daytona infield_sat.mip) bake a solid
   dark rectangle into the art — a masked / no-data patch that drapes onto the
   visible tri-oval grass as a black square (the real track shows grass there).
   We repair it at load: on grass-dominant textures only, flood-fill a large,
   COMPACT, grass-surrounded, DESATURATED-dark blob and paint it the local grass
   colour. Every gate (grass-dominant sheet, desaturated dark, compact shape,
   grass border) is there so this can never touch legitimately dark things:
   black haulers (not grass sheets), tinted glass, blue water (not desaturated),
   or thin roads (not compact). */
const REPAIR_DARK_LUM = 52;      /* mean-luma below this counts as "dark" */
const REPAIR_MAX_SAT = 16;       /* max−min channel below this = desaturated (excludes water) */
const REPAIR_MIN_BLOB = 1200;    /* only fill blobs at least this many px */
const REPAIR_COMPACT = 0.5;      /* blob must fill ≥ half its bbox (excludes roads) */
const pxLum = (d, i) => (d[i] + d[i + 1] + d[i + 2]) / 3;
const isGrassPx = (d, i) => { const r = d[i], g = d[i + 1], b = d[i + 2]; return g > 52 && g >= r && g >= b && g - Math.min(r, b) > 8; };
const isDarkArtifactPx = (d, i) => {
  if (d[i + 3] <= 128 || pxLum(d, i) >= REPAIR_DARK_LUM) return false;
  const r = d[i], g = d[i + 1], b = d[i + 2];
  return Math.max(r, g, b) - Math.min(r, g, b) < REPAIR_MAX_SAT;   /* desaturated only */
};

/* classify a ground texture as GRASS by its actual pixels (green-dominant),
   cached per track-texture basename. Used to tell the racing surface from the
   infield/verge for grip + tyre FX: a track's cross-section WIDTH includes the
   grass/apron bands, so a geometric |dlat|>halfWidth test counts grass as
   "on surface". Reading the real texture is robust across tracks. Grey asphalt
   never trips isGrassPx (needs g dominant AND g−min>8). Unknown → false (paved). */
const grassByTexture = new Map();
function isGrassTexture(textureName) {
  if (!textureName) return false;
  const key = baseName(textureName);
  const cached = grassByTexture.get(key);
  if (cached !== undefined) return cached;
  let grassy = false;
  const img = alphaDataFor(textureName, 'track');
  if (img && img.data) {
    const d = img.data;
    let grass = 0, samp = 0;
    for (let i = 0; i < d.length; i += 64) { samp++; if (isGrassPx(d, i)) grass++; }
    grassy = samp > 0 && grass / samp > 0.5;
  }
  grassByTexture.set(key, grassy);
  return grassy;
}

/* which ground F-strip band covers lateral offset dlat at along-segment
   parameter u, and is that band grass? → true (grass/off-surface) | false
   (paved/on) | null (indeterminate → caller falls back to the geometric test).
   Strip left edges drift d0→d1 down the segment; band i spans edge_i→edge_{i+1}
   (the same convention the render painter uses). */
function classifyGrassAt(seg, dlat, u) {
  const strips = seg && seg.strips;
  if (!strips || !strips.length) return null;
  const edgeAt = (s) => s.d0 + (s.d1 - s.d0) * u;
  let idx = -1;
  for (let i = 0; i < strips.length; i++) {
    const lo = edgeAt(strips[i]);
    const hi = i + 1 < strips.length ? edgeAt(strips[i + 1]) : Infinity;
    if (dlat >= lo && dlat < hi) { idx = i; break; }
  }
  if (idx < 0) {
    if (dlat < edgeAt(strips[0])) idx = 0;   /* left of the first edge → band 0 */
    else return null;
  }
  let s = strips[idx];
  if (!s.texture) {                          /* filler band: inherit a neighbour */
    s = strips.slice(idx + 1).find((t) => t.texture)
      || [...strips.slice(0, idx)].reverse().find((t) => t.texture) || s;
  }
  return isGrassTexture(s.texture);
}

function repairGroundArtifacts(imageData) {
  const { width: W, height: H, data: d } = imageData;
  const N = W * H;
  /* cheap gate: grass-dominant sheet with an isolated dark fraction */
  let grass = 0, dark = 0, samp = 0;
  for (let i = 0; i < d.length; i += 64) { samp++; if (isGrassPx(d, i)) grass++; if (isDarkArtifactPx(d, i)) dark++; }
  const gf = grass / samp, df = dark / samp;
  if (gf < 0.30 || df < 0.003 || df > 0.30) return 0;
  /* local grass reference colour */
  let gr = 0, gg = 0, gb = 0, gn = 0;
  for (let i = 0; i < d.length; i += 32) if (isGrassPx(d, i)) { gr += d[i]; gg += d[i + 1]; gb += d[i + 2]; gn++; }
  if (!gn) return 0;
  gr = (gr / gn) | 0; gg = (gg / gn) | 0; gb = (gb / gn) | 0;
  /* flood-fill dark-artifact components; fill the ones that look like the patch */
  const seen = new Uint8Array(N);
  let filled = 0;
  for (let p0 = 0; p0 < N; p0++) {
    if (seen[p0] || !isDarkArtifactPx(d, p0 * 4)) continue;
    const stack = [p0]; seen[p0] = 1; const comp = [];
    let x0 = W, x1 = 0, y0 = H, y1 = 0, grassB = 0, otherB = 0;
    while (stack.length) {
      const p = stack.pop(); comp.push(p);
      const x = p % W, y = (p / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (const [nx, ny] of nb) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const np = ny * W + nx;
        if (isDarkArtifactPx(d, np * 4)) { if (!seen[np]) { seen[np] = 1; stack.push(np); } }
        else if (isGrassPx(d, np * 4)) grassB++; else otherB++;
      }
    }
    const bboxArea = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (comp.length >= REPAIR_MIN_BLOB && comp.length / bboxArea >= REPAIR_COMPACT &&
        grassB > otherB * 1.5) {
      for (const p of comp) { const i = p * 4; d[i] = gr; d[i + 1] = gg; d[i + 2] = gb; }
      filled += comp.length;
    }
  }
  return filled;
}

/* Oversized SD-pack sheets (4096×4096) blow out browser canvas/GPU memory when a
   track ships dozens of them — the backing stores get downscaled and colour-
   corrupted (grey asphalt turns into blue slabs; whole surfaces vanish on weaker
   GPUs). The game never rendered textures this large. Cap decode to 2048; the .mip's
   own mip chain supplies that level, so there's no resampling loss. */
const MAX_TEXTURE_DIM = 2048;
function canvasFromMip(bytes, opts) {
  const decoded = Mip.decode(bytes, MAX_TEXTURE_DIM);
  const { imageData } = decoded;
  repairGroundArtifacts(imageData);
  const c = document.createElement('canvas');
  c.width = imageData.width; c.height = imageData.height;
  c.getContext('2d').putImageData(imageData, 0, 0);
  /* classify the alpha so the material can pick the right blend mode:
     - hardAlpha (binary mask: has BOTH solid and see-through pixels — chainlink
       fences, grandstand railings, hard decals) → alpha-TEST cutout: draws in the
       opaque pass, writes depth, needs no sorting, so geometry behind it never
       pops/vanishes as the camera moves.
     - soft alpha with NO solid pixels (a faint overlay like the trioval grass
       "500", or glass) → alpha BLEND. */
  /* "opaque" admits ≥224: fence/wall sheets authored from 4-bit-alpha sources
     (ARGB8888 files whose alpha is nibble<<4, max 240) and mid-range DXT blocks
     never reach 244, which mis-routed chainlink fences into the blend pass —
     see-through walls with no depth write (fence_sm, fence_aa1). */
  const OPAQUE_ALPHA_MIN = 224;
  let hasAlpha = false, opaque = 0, clear = 0, total = 0;
  const a = imageData.data;
  for (let i = 3; i < a.length; i += 4) {
    const v = a[i];
    if (v < 250) hasAlpha = true;
    if (v >= OPAQUE_ALPHA_MIN) opaque++; else if (v <= 12) clear++;
    total++;
  }
  const hardAlpha = hasAlpha && total > 0 &&
    opaque / total > 0.02 && clear / total > 0.02;
  const mipChain = opts && opts.withMipChain ? mipChainFromLevels(decoded, c) : null;
  return { canvas: c, hasAlpha, hardAlpha, mipChain };
}

/* The .mip ships every level of the game's own pre-built mip chain, and DXT1
   punch-through alpha stays BINARY at every level. GPU auto-mipmaps instead
   AVERAGE the alpha, so an alphaTest-0.5 cutout erodes to scattered scratches
   at distance (sponsor mats rendered as thin white streaks). Feeding the
   authored chain keeps every level cleanly cuttable, exactly like the game.
   Returns [level0Canvas, ImageData…] down to 1×1, or null (→ caller falls back
   to auto mipmaps) when the file's chain is incomplete or mis-sized. */
function mipChainFromLevels(decoded, level0Canvas) {
  const bySize = decoded.levels.slice().sort((a, b) => b.w * b.h - a.w * a.h);
  const chain = [level0Canvas];
  for (let i = 1; ; i++) {
    const w = Math.max(1, level0Canvas.width >> i);
    const h = Math.max(1, level0Canvas.height >> i);
    const level = bySize.find(l => l.w === w && l.h === h);
    if (!level) return null;
    try { chain.push(Mip.decodeLevel(level)); }
    catch (err) { console.error('mip chain level ' + w + 'x' + h, err); return null; }
    if (w === 1 && h === 1) return chain;
  }
}

/* Glass detection by data, not just name: a mesh is glass-like when most of
   its UV footprint lands on semi-transparent texels (true alpha blending, as
   opposed to the 0/255 cutout alpha used by decals). Catches clear lexan
   spoilers and oddly-named glass parts in any mod. */
/* cws2015 ships rear panes as `glas_0` (not "glass"); catch common names */
const GLASS_PART_RE = /glas|glass|window|windshield|windscreen|backlite/i;

const SEMI_ALPHA_LO = 16;
const SEMI_ALPHA_HI = 240;
const SEMI_FRACTION = 0.5;

function alphaDataFor(textureName, prefer) {
  /* cache split per source — the mod and the track can ship different art
     under the same basename (foam.mip: truck padding vs fence truss) */
  const key = (prefer === 'track' ? 't:' : 'm:') + baseName(textureName);
  if (alphaDataByTexture.has(key)) return alphaDataByTexture.get(key);
  let img = null;
  const bytes = bytesForTexture(textureName, prefer);
  if (bytes) {
    try { img = Mip.decode(bytes).imageData; } catch (err) { console.error('alpha ' + textureName, err); }
  }
  alphaDataByTexture.set(key, img);
  return img;
}

function isSemiTransparentMesh(m, prefer) {
  if (!m.texture || !m.uv || !m.tris.length) return false;
  const img = alphaDataFor(m.texture, prefer);
  if (!img) return false;
  const { width, height, data } = img;
  /* sample each triangle's centroid — the visible interior, not the edges,
     which often sit on opaque seam texels */
  let semi = 0;
  for (let t = 0; t < m.tris.length; t += 3) {
    const [a, b, c] = [m.tris[t], m.tris[t + 1], m.tris[t + 2]];
    const u = (m.uv.u[a] + m.uv.u[b] + m.uv.u[c]) / 3;
    const v = (m.uv.v[a] + m.uv.v[b] + m.uv.v[c]) / 3;
    const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
    const y = Math.min(height - 1, Math.max(0, Math.floor(v * height)));
    const alpha = data[(y * width + x) * 4 + 3];
    if (alpha >= SEMI_ALPHA_LO && alpha <= SEMI_ALPHA_HI) semi++;
  }
  return semi / (m.tris.length / 3) > SEMI_FRACTION;
}

/* A texture with meaningful see-through pixels marks a CUTOUT BILLBOARD (crowd,
   fences, railings, trees, signs) — a thin single-layer shell, not a closed
   solid. Those must render DOUBLE-SIDED or they vanish when viewed from the
   back (e.g. the grandstand crowd, whose panels face the track, going
   see-through when the camera is on the far/outer side). Fully-opaque scenery
   (concrete, base, haulers, buildings) stays back-face culled so interiors
   don't show. Cached per texture. */
const cutoutTexByName = new Map();
function textureIsCutoutBillboard(textureName, prefer) {
  if (!textureName) return false;
  const key = (prefer === 'track' ? 't:' : 'm:') + baseName(textureName);
  if (cutoutTexByName.has(key)) return cutoutTexByName.get(key);
  let cutout = false;
  const img = alphaDataFor(textureName, prefer);
  if (img) {
    let clear = 0, total = 0;
    for (let i = 3; i < img.data.length; i += 4) { if (img.data[i] <= 12) clear++; total++; }
    cutout = total > 0 && clear / total > 0.02;
  }
  cutoutTexByName.set(key, cutout);
  return cutout;
}

/* Track sheets are cached by bare filename (wall.mip, grandstand.mip, asphalt.mip,
   the tsd_ decals…), and those names REPEAT across tracks with different artwork —
   so loading a second track without dropping the cache paints it with the FIRST
   track's grandstands, apron, walls and decals. Drop only the track-sourced ('t:')
   entries: the CAR's ('m:') entries must survive with their KEYS intact, not just
   their live material objects — materialsForTexture is a map lookup, so clearing
   the whole map silently breaks .car paint swaps once a track is loaded. */
function resetTrackTextureCache() {
  for (const [key, m] of materialByTexture) {
    if (key.startsWith('m:')) continue;
    if (m.map) m.map.dispose();
    m.dispose();
    materialByTexture.delete(key);
  }
  for (const key of alphaDataByTexture.keys()) {
    if (!key.startsWith('m:')) alphaDataByTexture.delete(key);
  }
  for (const key of cutoutTexByName.keys()) {
    if (!key.startsWith('m:')) cutoutTexByName.delete(key);
  }
  /* Surface decals (tsd_ mats) are cached by bare filename too, and those names
     REPEAT across tracks (tsd_startfinish, tsd_logo…) — without dropping this
     cache the previous track's decal artwork paints the new track (Bristol's
     start/finish decals showing up on Charlotte). Free + clear them as well. */
  for (const m of decalMatByTexture.values()) {
    if (!m) continue;
    if (m.map) m.map.dispose();
    m.dispose();
  }
  decalMatByTexture.clear();
}


function makeTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.encoding = THREE.sRGBEncoding;
  tex.flipY = false;           /* Papyrus UVs are top-left origin */
  tex.anisotropy = 8;
  return tex;
}

/* NOTE (2026-07-05): the old groundShadowSubstitute() lived here — it swapped
   near-solid-black trackmat\ ground sheets (grass_02, asphalt_05) for a bright
   family sibling, on the theory they were undrawn-decal placeholders. That was
   WRONG: those sheets are the track's real baked shadow / dark-paint art (the
   dark patches on the infield grass and apron concrete), and the game draws them
   as-is. Removed so they render 1:1. Missing sponsor/logo graphics are a separate
   decal-layer concern handled by buildTrackDecals, not by faking the base. */

function materialFor(textureName, isGlass, cullBack, tiled, wrap, lit, prefer) {
  /* Papyrus samples every texture wrapped — track props tile their sheets
     (camper groups run u 0..7); three.js defaults to clamp, which smears the
     edge pixels into giant streaks. tiled implies wrap and adds the depth
     bias for the generated surface. prefer='track' resolves + caches the
     texture from the track's pools (see findFileBytes). */
  const wrapTex = tiled || wrap;
  const key = (prefer === 'track' ? 't:' : 'm:') +
    (textureName ? baseName(textureName) : '__untextured__') +
    (isGlass ? '|glass' : '') + (cullBack ? '|cull' : '') + (tiled ? '|tiled' : '') +
    (wrapTex ? '|wrap' : '') + (lit ? '|lit' : '');
  if (materialByTexture.has(key)) {
    const cached = materialByTexture.get(key);
    if (isGlass) {
      cached.polygonOffset = true;
      cached.polygonOffsetFactor = -1;
      cached.polygonOffsetUnits = -1;
    }
    return cached;
  }
  /* Cars + the generated track surface render fullbright (MeshBasic): the game
     bakes/omits lighting there and unlit sidesteps the mixed face-normal winding
     in strip-built geometry. Track SCENERY (lit=true) instead uses MeshLambert so
     the game's D3D sun+ambient is reproduced — dark-albedo objects (black haulers,
     tar roofs) gain form rather than reading as flat black voids (see the lighting
     constants block). White material color keeps final = texture × light.
     Glass parts come as stacked semi-transparent layers (outer + interior panes)
     — they must not write depth or the layers z-reject into gray patches, and stay
     fullbright (self-lit tinted glass look).
     cullBack (FrontSide) mirrors the game's global backface culling — it's what
     hides interior linings and inner wheel-well lips from outside; applied
     whenever the mesh's winding can be trusted. */
  const Mat = lit ? THREE.MeshLambertMaterial : THREE.MeshBasicMaterial;
  const side = cullBack ? THREE.FrontSide : THREE.DoubleSide;
  let material;
  const bytes = textureName ? bytesForTexture(textureName, prefer) : null;
  if (bytes) {
    try {
      const { canvas, hasAlpha, hardAlpha } = canvasFromMip(bytes);
      /* soft translucency (glass, faint overlays) blends and must not write depth;
         hard alpha masks (fences, railings) alpha-test in the opaque pass so they
         depth-sort correctly and never make geometry behind them disappear */
      const blend = isGlass || (hasAlpha && !hardAlpha);
      const cutout = hasAlpha && hardAlpha && !isGlass;
      material = new Mat({
        map: makeTexture(canvas),
        /* ANY blended (see-through) surface is a thin shell — force DoubleSide so
           its back face isn't culled and the pane vanishes from certain angles */
        side: blend ? THREE.DoubleSide : side,
        transparent: blend,
        alphaTest: cutout ? 0.5 : 0,
        depthWrite: !blend,
      });
    } catch (err) {
      console.error('texture ' + textureName, err);
    }
  }
  if (!material) {
    material = new Mat({
      color: 0x6b7684, side: isGlass ? THREE.DoubleSide : side,
      transparent: !!isGlass, opacity: isGlass ? 0.4 : 1, depthWrite: !isGlass,
    });
  }
  if (wrapTex && material.map) {
    material.map.wrapS = THREE.RepeatWrapping;
    material.map.wrapT = THREE.RepeatWrapping;
    material.map.needsUpdate = true;
  }
  if (tiled) {
    /* generated track surfaces: TSO decals sit flush on the ground — bias
       the surface back so painted lines and aprons win the depth fight */
    material.polygonOffset = true;
    material.polygonOffsetFactor = 1;
    material.polygonOffsetUnits = 1;
  } else if (isGlass) {
    /* thin panes sit flush on the body shell — nudge forward so they don't
       depth-fight the paint beneath (cws2015 rear quarter glass) */
    material.polygonOffset = true;
    material.polygonOffsetFactor = -1;
    material.polygonOffsetUnits = -1;
  }
  materialByTexture.set(key, material);
  return material;
}

/* Roof/hood flaps must always render as opaque painted bodywork. The card sheet
   carries a transparent roof-hole cutout; sampling it with alphaTest punches
   holes that read black through the opening. Fork an opaque material variant
   that still shares the body paint texture cache family. */
function flapPaintMaterialFor(textureName, cullBack) {
  const key = 'm:' + (textureName ? baseName(textureName) : '__untextured__') +
    (cullBack ? '|cull' : '') + '|flap';
  if (materialByTexture.has(key)) return materialByTexture.get(key);
  const base = materialFor(textureName, false, cullBack);
  const mat = base.clone();
  mat.side = THREE.FrontSide;
  mat.transparent = false;
  mat.opacity = 1;
  mat.alphaTest = 0;
  mat.depthWrite = true;
  mat.needsUpdate = true;
  materialByTexture.set(key, mat);
  return mat;
}

/* Backface culling: cull back faces on EVERYTHING —
   that's what hides interior linings (bodyshell) and inner wheel-well lips
   mapped to dark sheet regions. Papyrus winding agrees with the stored
   vertex normals ~100% of the time, so when a mesh has normals we flip the
   rare disagreeing triangle and render FrontSide. Returns the (possibly
   flipped) index array, or null when normals are absent/untrustworthy —
   then the caller keeps DoubleSide like before. */
const WINDING_TRUST_RATIO = 0.9;
function orientTrisToNormals(m) {
  if (!m.normals || !m.tris.length) return null;
  const flipped = [];
  let agree = 0, total = 0;
  for (let t = 0; t < m.tris.length; t += 3) {
    const [a, b, c] = [m.tris[t], m.tris[t + 1], m.tris[t + 2]];
    const ax = m.verts[a * 3], ay = m.verts[a * 3 + 1], az = m.verts[a * 3 + 2];
    const ux = m.verts[b * 3] - ax, uy = m.verts[b * 3 + 1] - ay, uz = m.verts[b * 3 + 2] - az;
    const vx = m.verts[c * 3] - ax, vy = m.verts[c * 3 + 1] - ay, vz = m.verts[c * 3 + 2] - az;
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const dot = fx * (m.normals.x[a] + m.normals.x[b] + m.normals.x[c]) +
      fy * (m.normals.y[a] + m.normals.y[b] + m.normals.y[c]) +
      fz * (m.normals.z[a] + m.normals.z[b] + m.normals.z[c]);
    if (Math.abs(dot) > 1e-12) { total++; if (dot > 0) agree++; }
    if (dot < 0) flipped.push(a, c, b); else flipped.push(a, b, c);
  }
  return total > 0 && agree / total > WINDING_TRUST_RATIO ? flipped : null;
}

/* ---------- model build ---------- */
/* Papyrus models repeat some faces verbatim — the body re-draws part of the
   interior shell, the chassis doubles panels — and coincident depth-written
   triangles z-fight (flicker). Keep the first copy of each opaque triangle,
   drop later ones. Glass skips this: it never writes depth, so coincident
   layers blend instead of fighting. The key includes winding parity so an
   outward face is never dropped for a coincident INWARD one (backface
   culling must keep the outward copy). Returns a filtered copy of tris. */
function dedupeOpaqueTris(m, tris, seenTris) {
  const vk = (i) => `${m.verts[i * 3].toFixed(3)},${m.verts[i * 3 + 1].toFixed(3)},${m.verts[i * 3 + 2].toFixed(3)}`;
  const kept = [];
  for (let t = 0; t < tris.length; t += 3) {
    const ks = [vk(tris[t]), vk(tris[t + 1]), vk(tris[t + 2])];
    /* winding parity = inversion count of the 3 keys mod 2: a coincident
       triangle wound the other way gets the other parity and is kept */
    let inv = 0;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) if (ks[i] > ks[j]) inv++;
    const key = [...ks].sort().join('|') + '#' + (inv % 2);
    if (seenTris.has(key)) continue;
    seenTris.add(key);
    kept.push(tris[t], tris[t + 1], tris[t + 2]);
  }
  return kept;
}

/* Stacked glass shells (outer + inner pane at the same spot) have no depth
   write, so duplicate tris sort-fight and flicker. Drop position-identical
   copies regardless of winding — unlike opaque dedup, which must keep the
   outward-facing copy for backface culling. */
function dedupeGlassTris(m, tris, seenTris) {
  const vk = (i) => `${m.verts[i * 3].toFixed(3)},${m.verts[i * 3 + 1].toFixed(3)},${m.verts[i * 3 + 2].toFixed(3)}`;
  const kept = [];
  for (let t = 0; t < tris.length; t += 3) {
    const key = [vk(tris[t]), vk(tris[t + 1]), vk(tris[t + 2])].sort().join('|');
    if (seenTris.has(key)) continue;
    seenTris.add(key);
    kept.push(tris[t], tris[t + 1], tris[t + 2]);
  }
  return kept;
}

/* Rear-aero control. Cup/COT/Next-Gen mods bake the rear wing or spoiler in as a
   separate named body part (e.g. FCRD NCS22 ships `L1_Wing` on the COT variant,
   `L1_STSpoiler` / `L1_SWSpoiler` on the spoiler variants; generic mods just name
   it `wing`/`spoiler`). It's real model geometry, so the "Rear aero" dropdown lets
   you swap between the whole-body variants a mod ships (each is an alternate
   make_a*.3do — usually tucked in an "Extras" subfolder) or hide the part entirely.
   Matching-name meshes only, so a car with no wing part is left untouched. */
let showWings = true;
const WING_PART_RE = /wing|spoiler/i;
const WING_HIDE_VALUE = '__hidden__';
function isWingMesh(mesh) {
  return mesh.isMesh && WING_PART_RE.test(mesh.name || '');
}
function applyWingVisibility() {
  const groups = [modelGroup, carFieldGroup];   /* also the grid/pit-stall clones */
  for (const g of groups) {
    if (!g) continue;
    g.traverse(o => { if (isWingMesh(o)) o.visible = showWings; });
  }
}

/* ---------- roof flaps, deployed ON the mesh ----------
   The flap channel drives deploy through the roof_flap_state channel: the car .3do
   binds it to RegionMorph vertex regions (per-vertex deltas at full deploy,
   decoded in threedo.js). applyFlapState(s) blends the affected verts
   position = base + s*delta (normals too), s = 0 closed .. 1 fully open. */
/* flap-piece visibility, split by what the piece IS (FCRD probe, f162):
   MORPH-DRIVEN pieces (45RF/90RF, LHF/RHF hood flaps) extract at their
   CLOSED pose — flush painted body panels — so they are always visible
   while flaps are fitted; the roof_flap_state morph animates them open.
   MORPHLESS pieces in the flap tier (RF_Ground recess floor / backing /
   vent art) are deploy dressing: hidden until the flaps actually lift.
   (The old f143/f157 rule hid EVERYTHING at rest — that removed the
   painted flush hood/roof flaps entirely; the "deployed in the showroom"
   regression it guarded against was the state-switch fallback, fixed in
   threedo.js showroomStateValue.) */
const FLAP_SHOW_MIN = 0.02;
/* deploy-only DRESSING (recess floor / backing / vent art) — hidden until a flap
   lifts. Real flush PANELS (the hood/roof flaps themselves) never match this and
   are shown at rest whether or not their deploy morph bound. Name-based, so a mod
   that ships a flush flap WITHOUT a morph can't be mistaken for dressing and
   hidden (the old "morphless ⇒ hide" rule was the recurring "flaps missing"). */
const FLAP_DRESSING_RE = /ground|recess|backing|vent|floor|well|cavity|inner|under/i;
/* a closed flush flap is painted from the same region as the hood, and the body
   renders unlit (MeshBasic) — so at rest it has NO edge definition and reads as
   "not there". Draw a thin seam outline around each panel while it's closed (the
   real panel gap); once it lifts past FLAP_SEAM_CLOSED_MAX the flap is obvious so
   the seam hides. Tunable: colour/opacity in flapSeamMaterial, thickness is a GL
   hairline. */
const FLAP_SEAM_ANGLE = 32;        /* EdgesGeometry crease angle → panel perimeter */
const FLAP_SEAM_CLOSED_MAX = 0.12; /* show the seam only below this deploy fraction */
const FLAP_SEAM_LIFT_M = 0.004;    /* float the line 4 mm off the skin (anti z-fight) */
let _flapSeamMat = null;
function flapSeamMaterial() {
  if (!_flapSeamMat) {
    _flapSeamMat = new THREE.LineBasicMaterial({
      color: 0x141414, transparent: true, opacity: 0.5, depthWrite: false,
    });
  }
  return _flapSeamMat;
}
function refreshFlapVisibility(enabledOpt) {
  const on = enabledOpt != null ? enabledOpt
    : (typeof DriveControls !== 'undefined' ? DriveControls.get().aero.roofFlaps !== false : true);
  for (const g of [modelGroup, carFieldGroup]) {
    if (!g) continue;
    const state = g.userData.flapState || 0;
    const show = on && state > FLAP_SHOW_MIN;
    g.traverse((o) => {
      if (o.userData.isFlapSeam) {         /* closed-panel outline */
        o.visible = on && state < FLAP_SEAM_CLOSED_MAX;
        return;
      }
      if ((o.isMesh || o.isInstancedMesh) && o.userData.isFlapPart) {
        /* real panels always show when fitted; only positively-identified
           deploy dressing waits for the flap to actually lift */
        o.visible = o.userData.isFlapDressing ? show : on;
      }
    });
  }
}

function applyFlapState(s) {
  if (!modelGroup || modelGroup.userData.flapState === s) return;
  modelGroup.userData.flapState = s;
  refreshFlapVisibility();
  modelGroup.traverse((o) => {
    const fm = o.isMesh && o.userData.flapMorph;
    if (!fm) return;
    const pos = o.geometry.getAttribute('position');
    const nrm = o.geometry.getAttribute('normal');
    const idx = fm.idx, c = idx.length;
    for (let i = 0; i < c; i++) {
      const vi = idx[i];
      pos.setXYZ(vi,
        fm.basePos[i * 3] + s * fm.dx[i],
        fm.basePos[i * 3 + 1] + s * fm.dy[i],
        fm.basePos[i * 3 + 2] + s * fm.dz[i]);
      if (nrm && fm.dn && fm.baseNrm) {
        nrm.setXYZ(vi,
          fm.baseNrm[i * 3] + s * fm.dn.x[i],
          fm.baseNrm[i * 3 + 1] + s * fm.dn.y[i],
          fm.baseNrm[i * 3 + 2] + s * fm.dn.z[i]);
      }
    }
    pos.needsUpdate = true;
    if (nrm && fm.dn && fm.baseNrm) nrm.needsUpdate = true;
  });
}

/* the Controls-panel "Roof flaps" toggle: off = the car runs without the flap
   piece set entirely (roofFlapsEnable < 1.9 in game terms) */
function applyFlapEnable() {
  const on = typeof DriveControls !== 'undefined'
    ? DriveControls.get().aero.roofFlaps !== false : true;
  if (!on) applyFlapState(0);
  else if (modelGroup && (modelGroup.userData.flapState || 0) > 0.001) {
    applyFlapState(modelGroup.userData.flapState);   /* re-apply morph after rebuild */
  }
  refreshFlapVisibility(on);
}

/* Every .3do that shares the loaded model's filename is an alternate body — the
   only thing that differs between them is the rear aero — so we list them all as
   swap targets. Enumerated from the raw dat/loose lists (not the merged pool,
   which collapses same-named files), deduped by full path. */
function aeroVariants() {
  if (!mod || !mod.modelName) return [];
  const want = baseName(mod.modelName).toLowerCase();
  const seen = new Set();
  const out = [];
  for (const it of [...(mod.datItems || []), ...(mod.looseFiles || [])]) {
    if (!it || !/\.3do$/i.test(it.name)) continue;
    if (baseName(it.name).toLowerCase() !== want) continue;
    if (seen.has(it.name)) continue;
    seen.add(it.name);
    out.push(it);
  }
  return out;
}

/* Friendly label for a variant: the parent folder the modder filed it under
   (that's where they name the aero — "COT W A N G", "Standard Spoiler", …),
   tidied of "3do(s)" tokens and punctuation. Top-level files fall back to
   "Standard". */
function variantLabel(item) {
  const parts = (item.name || '').split('/');
  if (parts.length >= 2) {
    const folder = parts[parts.length - 2]
      .replace(/\b3dos?\b/ig, '')
      .replace(/[_@$#]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (folder) return folder;
  }
  return 'Standard';
}

/* Fill the Rear-aero dropdown from the loaded car. Shown only when there's a
   real aero part to hide or more than one body variant to pick from — otherwise
   it would just be dead UI. Setting .value here fires no change event. */
function populateWingDropdown() {
  const sel = $('vp-wing');
  const row = $('vp-wing-row');
  if (!sel || !row) return;
  const variants = mod && mod.meshes ? aeroVariants() : [];
  const hasAero = !!(mod && mod.meshes && mod.meshes.some(m => WING_PART_RE.test(m.path)));
  if (variants.length < 2 && !hasAero) { row.hidden = true; sel.innerHTML = ''; return; }
  row.hidden = false;
  const seenLabel = new Map();
  const opts = variants.map(it => {
    let label = variantLabel(it);
    const n = seenLabel.get(label) || 0;   /* disambiguate rare label collisions */
    seenLabel.set(label, n + 1);
    if (n) label += ' (' + (n + 1) + ')';
    const value = it.name.replace(/"/g, '&quot;');
    return `<option value="${value}">${label}</option>`;
  });
  opts.push(`<option value="${WING_HIDE_VALUE}">Hidden (no wing)</option>`);
  sel.innerHTML = opts.join('');
  const current = mod.modelItem ? mod.modelItem.name : null;
  sel.value = showWings ? (current || (variants[0] && variants[0].name) || WING_HIDE_VALUE) : WING_HIDE_VALUE;
}

function buildModel(meshes, opts = {}) {
  if (modelGroup) {
    clearCarField();   /* field clones share this geometry — drop them before dispose */
    if (modelGroup.parent) modelGroup.parent.remove(modelGroup);
    modelGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  }
  /* keep track scenery materials when rebuilding the car on a loaded track */
  if (!track) {
    for (const m of materialByTexture.values()) {
      if (m.map) m.map.dispose();
      m.dispose();
    }
    materialByTexture.clear();
    alphaDataByTexture.clear();
    grassByTexture.clear();
  }

  modelGroup = new THREE.Group();
  modelGroup.rotation.x = -Math.PI / 2;   /* Papyrus Z-up -> three.js Y-up */

  const seenTris = new Set();
  const seenGlassTris = new Set();
  for (let mi = 0; mi < meshes.length; mi++) {
    const m = meshes[mi];
    /* flap shells are painted bodywork, never glass — their UV footprint sits
       over the template's see-through roof-hole art, so the semi-alpha sampler
       misreads them (FCRD 45RF: 46/52 semi centroids). Glass-classing a flap
       puts it on a no-depth-write material that the dark interior panes then
       blend over through the open roof hole = "black flap". */
    const isFlap = !!(m.flapMorph || m.isFlapPart);
    const isGlass = !isFlap && (GLASS_PART_RE.test(m.path) || isSemiTransparentMesh(m));
    const oriented = orientTrisToNormals(m);
    /* flaps take the normal culled path like the rest of the body (the game
       runs global backface culling). The deployed underside shows livery via
       the backing-UV remap in threedo — no DoubleSide special case, which
       would fork the flap onto its own material cache key. */
    const cullBack = oriented !== null;
    const baseTris = oriented || m.tris;
    /* flaps skip the opaque dedup: a flush closed flap is legitimately coincident
       with the hood/roof panel beneath it, so deduping against the body would
       drop the whole flap (0 tris ⇒ mesh skipped ⇒ "flaps missing"). Keep every
       flap triangle — its deploy morph lifts it clear on use. */
    const tris = isFlap ? baseTris
      : isGlass ? dedupeGlassTris(m, baseTris, seenGlassTris)
      : dedupeOpaqueTris(m, baseTris, seenTris);
    if (!tris.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.verts), 3));
    if (m.uv) {
      const uv = new Float32Array(m.count * 2);
      for (let i = 0; i < m.count; i++) { uv[i * 2] = m.uv.u[i]; uv[i * 2 + 1] = m.uv.v[i]; }
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    geo.setIndex(tris);
    if (m.normals) {
      const nr = new Float32Array(m.count * 3);
      for (let i = 0; i < m.count; i++) {
        nr[i * 3] = m.normals.x[i]; nr[i * 3 + 1] = m.normals.y[i]; nr[i * 3 + 2] = m.normals.z[i];
      }
      geo.setAttribute('normal', new THREE.BufferAttribute(nr, 3));
    } else {
      geo.computeVertexNormals();
    }
    /* glass is a THIN single-layer transparent shell — it MUST be double-sided
       or its back face is culled and the pane vanishes from certain angles
       (same reason cutout billboards render two-sided). */
    const flapTex = isFlap && mod && mod.meshesPaintedBody && mod.bodyTexture ? mod.bodyTexture : m.texture;
    const mesh = new THREE.Mesh(geo, isFlap
      ? flapPaintMaterialFor(flapTex, cullBack)
      : materialFor(m.texture, isGlass, isGlass ? false : cullBack));
    mesh.userData.isGlass = isGlass;
    /* Transparent draw-order layering (the same rule the track + field-car paths
       already follow — "opaque low; glass always last"): opaque = 0, blended
       NON-glass parts = 1, glass = 2. A soft-alpha interior piece (e.g. a
       lexan-ish roll cage / net) is transparent too, so if it shared glass's
       render bucket the two would sort only by object-centre distance — and a
       cage bar whose centre sits nearer the camera than the quarter-window pane
       then paints IN FRONT of that glass. Parking glass one layer above every
       other blended part makes it the outermost pane, so the roll bar always
       reads THROUGH the quarter glass instead of over it. */
    mesh.renderOrder = isGlass ? 2 : (mesh.material.depthWrite ? 0 : 1);
    mesh.name = m.path;
    mesh.userData.meshIndex = mi;
    mesh.userData.pristineMaterial = mesh.material;
    mesh.userData.baseMaterial = mesh.material;
    mesh.userData.isRoadWheel = mod.groundWheelPaths && mod.groundWheelPaths.has(m.path);
    mesh.userData.isWing = isWingMesh(mesh);
    mesh.userData.isFlapPart = !!m.isFlapPart;
    mesh.userData.hasFlapMorph = !!m.flapMorph;
    mesh.userData.isFlapDressing = !!m.isFlapPart && !m.flapMorph && FLAP_DRESSING_RE.test(m.path || '');
    /* seam outline: a closed flush PANEL (not dressing) reads as "not there" on
       the unlit body — trace its perimeter with a thin dark line, shown only
       while closed (refreshFlapVisibility), floated 4 mm off the skin so it does
       not z-fight. Child of the flap ⇒ inherits its place + fitted visibility. */
    if (m.isFlapPart && !mesh.userData.isFlapDressing && typeof THREE.EdgesGeometry === 'function') {
      const seam = new THREE.LineSegments(new THREE.EdgesGeometry(geo, FLAP_SEAM_ANGLE), flapSeamMaterial());
      seam.userData.isFlapSeam = true;
      seam.position.z = FLAP_SEAM_LIFT_M;   /* body coords: +z = outward from the skin */
      seam.renderOrder = 3;
      seam.frustumCulled = false;
      mesh.add(seam);
    }
    /* roof-flap deploy morph (decoded RegionMorph on roof_flap_state):
       capture the closed-pose base of just the region verts so
       applyFlapState can blend base + s*delta straight into the buffers */
    if (m.flapMorph) {
      const c = m.flapMorph.idx.length;
      const posAttr = geo.getAttribute('position');
      const nrmAttr = geo.getAttribute('normal');
      const basePos = new Float32Array(c * 3);
      const baseNrm = (nrmAttr && m.flapMorph.dn) ? new Float32Array(c * 3) : null;
      for (let i = 0; i < c; i++) {
        const vi = m.flapMorph.idx[i];
        basePos[i * 3] = posAttr.getX(vi);
        basePos[i * 3 + 1] = posAttr.getY(vi);
        basePos[i * 3 + 2] = posAttr.getZ(vi);
        if (baseNrm) {
          baseNrm[i * 3] = nrmAttr.getX(vi);
          baseNrm[i * 3 + 1] = nrmAttr.getY(vi);
          baseNrm[i * 3 + 2] = nrmAttr.getZ(vi);
        }
      }
      mesh.userData.flapMorph = { ...m.flapMorph, basePos, baseNrm };
    }
    modelGroup.add(mesh);
  }
  modelGroup.userData.flapState = 0;
  applyWingVisibility();   /* respect the toggle on the fresh model before cloning */
  applyFlapEnable();       /* roof-flaps toggle hides the whole flap piece set */
  if (track && track.stall) {
    placeCarAtStall(track.stall.world);   /* also re-parents the fresh group; driving overwrites the pose next frame */
    hoverIndex = null;
    applyPartHighlights();
    applyDefaultRideHeight();
    bakeCarEnvMap();         /* fresh make on track — re-bake so new paints reflect */
    buildCarField();
    applyWingVisibility();   /* field clones are built here — hide their wings too */
    applyFlapEnable();       /* ...and their flap pieces follow the toggle */
    if (opts.keepPose) {
      Driving.refresh();     /* live rebuild (paint/wing swap) — stay put, no re-frame */
    } else {
      frameTrackCar();
      if (paintPreviewing) restoreCommittedPaint();
      Driving.start();       /* car hot-swapped onto the track — WASD stays live */
    }
  } else if (typeof WindTunnel !== 'undefined' && WindTunnel.active) {
    /* car hot-swap while the wind tunnel is open: park the fresh model in the
       tunnel room instead of the showroom scene (the tunnel renders `room`) */
    hoverIndex = null;
    applyPartHighlights();
    applyDefaultRideHeight();
    WindTunnel.remountCar();
    bakeCarEnvMap();         /* fresh make reflects the tunnel room (f203) */
  } else {
    scene.add(modelGroup);
    hoverIndex = null;
    applyPartHighlights();   /* keep the selected part glowing across rebuilds */
    applyDefaultRideHeight();
    Driving.refreshCarShape();   /* showroom hitbox overlay tracks the new model */
    frameModel();
    bakeCarEnvMap();         /* showroom reflections too, not just on-track (f203) */
  }
}

/* ---------- ride height ----------
   Wheel transforms in the files are identity — the sim positions wheels at
   runtime from physics, so the authored body-to-wheel stance is arbitrary
   (cws2015 sits near-slammed, FCRD at a natural rest). Like the original game at
   runtime, the BODY is placed over the wheels at the physics ride height:
   splitter at RIDE_SPLITTER_M above the tyre plane — exactly where the
   physics body-contact shape (and the hitbox overlay) put it. The slider
   still adjusts to taste. View only — exports and write-back use the
   untouched mesh data. */
const RIDE_SPLITTER_M = 0.07;   /* body floor height over the tyre plane —
                                   matches the physics BODY_CONTACT_PTS floor */
const DEFAULT_RIDE_LIFT_M = 0.025;   /* 2.5 cm — factory stance over the tyre plane */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const ROAD_WHEEL_PATH_RE = /(^|\/)(lf|rf|lr|rr)wheel(?:\/|$)/i;
function isRoadWheelPath(path) { return ROAD_WHEEL_PATH_RE.test(path || ''); }
function wheelSlotFromPath(path) {
  const m = (path || '').match(ROAD_WHEEL_PATH_RE);
  return m ? m[2].toLowerCase() : null;
}
/* NCS22 (Next Gen Cup): the make_a.3do body whose parts map to the L1_NCS_*.mip
   sheets. Detected by texture prefix (reliable across paints) or model name. */
function isNCS22() {
  if (!mod) return false;
  if (/ncs/i.test(mod.modelName || '')) return true;
  const ms = mod.meshes || [];
  return ms.some(m => m.texture && /(^|_)ncs\d*/i.test(baseName(m.texture)));
}
function isHighRiderMod() {
  if (!mod) return false;
  const n = (mod.modelName || '').toLowerCase();
  if (/ncs|lmp|gns|cot/i.test(n)) return true;
  if (/^make_a/i.test(n)) return true;
  if (isNCS22()) return true;
  const ms = mod.meshes || [];
  return ms.some(m => m.texture && /(^|_)ncs\d*|lmp/i.test(baseName(m.texture)));
}

function setRideHeight(lift) {
  if (!modelGroup) return;
  for (const child of modelGroup.children) {
    if (child.isMesh && !child.userData.isRoadWheel) child.position.z = lift;
  }
  const box = new THREE.Box3().setFromObject(modelGroup);
  scene.getObjectByName('grid').position.y = box.min.y;
  const label = $('vp-ride-val');
  if (label) label.textContent = `+${(lift * 100).toFixed(1)} cm`;
}

const BODY_GROUND_GAP_M = 0.02;   /* daylight under a body authored below the tyres */

function applyDefaultRideHeight() {
  const slider = $('vp-ride');
  if (isHighRiderMod()) {
    const lift = DEFAULT_RIDE_LIFT_M;
    if (slider) slider.value = lift;
    setRideHeight(lift);
    return;
  }
  let lift = DEFAULT_RIDE_LIFT_M;
  if (mod && typeof mod.bodyFloorZ === 'number' && typeof mod.floorZ === 'number') {
    const computed = (mod.floorZ + RIDE_SPLITTER_M) - mod.bodyFloorZ;
    if (Number.isFinite(computed)) lift = computed;
  }
  lift = clamp(lift, -0.10, 0.12);
  if (slider) slider.value = lift;
  setRideHeight(lift);
}

/* hovered part glows red, selected part amber; both draw through the body */
function isHighlightMaterial(mat) {
  return mat === hoverMaterial || mat === selectMaterial;
}

/* restore target for hover/select — never the transient glow mats themselves */
function heroMeshBaseMaterial(child) {
  let m = child.userData.baseMaterial;
  if (!isHighlightMaterial(m)) return m;
  const heal = child.userData.pristineMaterial;
  if (heal && !isHighlightMaterial(heal)) {
    child.userData.baseMaterial = heal;
    return heal;
  }
  if (!isHighlightMaterial(child.material)) {
    child.userData.baseMaterial = child.material;
    child.userData.pristineMaterial = child.material;
    return child.material;
  }
  return m;
}

function clearPartHover() {
  hoverIndex = null;
  hoverTex = null;
  applyPartHighlights();
}

function ensureHighlightMaterials() {
  if (hoverMaterial) return;
  const make = (color) => new THREE.MeshBasicMaterial({
    color, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false,
  });
  hoverMaterial = make(0xff4d4d);
  selectMaterial = make(0xffb340);
}

/* a mesh is "hovered" when its row is hovered, or a hovered texture row shares
   this mesh's texture (one texture can skin several parts) */
function isMeshHovered(i) {
  if (i === hoverIndex) return true;
  if (!hoverTex || !mod || !mod.meshes[i] || !mod.meshes[i].texture) return false;
  return baseName(mod.meshes[i].texture) === hoverTex;
}

function applyPartHighlights() {
  if (!modelGroup) return;
  ensureHighlightMaterials();
  for (const child of modelGroup.children) {
    if (!child.isMesh) continue;
    const i = child.userData.meshIndex;
    const base = heroMeshBaseMaterial(child);
    let mat = base;
    if (isMeshHovered(i)) mat = hoverMaterial;
    else if (i === selectedIndex) mat = selectMaterial;
    child.material = mat;
    if (mat !== base) child.renderOrder = 3;   /* hover/select highlight sits above glass */
    else child.renderOrder = base.depthWrite
      ? 0                                        /* opaque bodywork */
      : (child.userData.isGlass ? 2 : 1);        /* glass (2) always outside other blended parts (1) */
  }
}

function setHoverPart(meshIndex) {
  if (meshIndex === hoverIndex && hoverTex === null) return;
  hoverIndex = meshIndex;
  hoverTex = null;                 /* part hover and texture hover are exclusive */
  applyPartHighlights();
}

/* highlight every mesh skinned by texName (null clears) — mirrors setHoverPart */
function setHoverTexture(texName) {
  if (texName === hoverTex && hoverIndex === null) return;
  hoverTex = texName;
  hoverIndex = null;
  applyPartHighlights();
}

function setSelectedPart(meshIndex) {
  selectedIndex = meshIndex === selectedIndex ? null : meshIndex; /* click again to deselect */
  applyPartHighlights();
  document.querySelectorAll('#vp-parts .vp-tex-row').forEach(row => {
    const isSel = Number(row.dataset.part) === selectedIndex;
    row.classList.toggle('selected', isSel);
    if (isSel) row.scrollIntoView({ block: 'nearest' });
  });
}

function frameModel() {
  if (!modelGroup) return;
  configureShowroomControls();
  const box = new THREE.Box3().setFromObject(modelGroup);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length() || 1;
  scene.getObjectByName('grid').position.y = box.min.y;
  /* orbit pivot = car centre, so the car stays put as you spin around it */
  controls.target.copy(center);
  /* land on the saved default pose (reference shot) = the "Camera 1" view */
  camera.position.set(...DEFAULT_SHOWROOM_CAM);
  camera.fov = SHOWROOM_FOV;
  camera.near = size / 100;
  camera.far = size * 40;
  camera.updateProjectionMatrix();
  const camSel = $('vp-camera');
  if (camSel) camSel.classList.remove('hidden');
  controls.update();
}

/* "Camera 1" with nothing loaded: snap the empty grid back to its home pose so
   the picker still does something before a car is opened. Flush any leftover
   orbit inertia first (damping off → update() zeroes the pending deltas) so the
   snap is exact instead of drifting by the tail of the last drag. */
function frameHome() {
  configureShowroomControls();
  controls.enableDamping = false;
  controls.update();
  controls.enableDamping = true;
  camera.position.set(...HOME_CAM);
  controls.target.set(...HOME_TARGET);
  camera.fov = DEFAULT_FOV;
  camera.near = 0.05;
  camera.far = 500;
  camera.updateProjectionMatrix();
  const camSel = $('vp-camera');
  if (camSel) camSel.value = 'camera1';
  controls.update();
}
const DEFAULT_FOV = 50;
const DEFAULT_SHOWROOM_CAM = [4.94, 0.80, 3.23];
const SHOWROOM_FOV = 35;
const HOME_CAM = DEFAULT_SHOWROOM_CAM;
const HOME_TARGET = [0, 0, 0];

const SHOWROOM_CAM_LABELS = {
  camera1: 'Camera 1', chase: 'Chase', farChase: 'Far Chase', rearChase: 'Rear chase',
  hood: 'Nose cam', nose: 'Nose cam',
  gearbox: 'Gearbox', onCar: 'On Car', rollBar: 'Roll Bar', fSusp: 'F Susp', rSusp: 'R Susp',
  swingman: 'Swingman', blimp: 'Zeppelin', free: 'Free camera',
};

function populateCarCameraMenu() {
  const sel = $('vp-camera');
  if (!sel || track) return;
  const hasMacc = !!(mod && mod.carCam && mod.carCam.records);
  let html = '<option value="camera1" selected>Camera 1</option>';
  html += '<option value="chase">Chase</option>';
  html += '<option value="farChase">Far Chase</option>';
  html += '<option value="rearChase">Rear chase</option>';
  if (hasMacc) {
    html += '<option value="hood">Nose cam</option>';
    html += '<option value="gearbox">Gearbox</option>';
    html += '<option value="onCar">On Car</option>';
    html += '<option value="rollBar">Roll Bar</option>';
    html += '<option value="fSusp">F Susp</option>';
    html += '<option value="rSusp">R Susp</option>';
  }
  html += '<option value="blimp">Zeppelin</option>';
  html += '<option value="free">Free camera</option>';
  sel.innerHTML = html;
  sel.classList.remove('hidden');
  carCamOptionsHtml = html;
}

function applyCameraView(name) {
  if (name === 'free' || !modelGroup) return;
  if (name === 'camera1') { frameModel(); return; }
  if (typeof CarCam === 'undefined') return;
  const v = CarCam.showroomView(name, modelGroup, mod && mod.carCam);
  if (!v) {
    const needsMacc = ['hood', 'nose', 'gearbox', 'onCar', 'rollBar', 'fSusp', 'rSusp'].includes(name);
    if (needsMacc) log('That view needs a .cam file next to the car (MACC format).');
    return;
  }
  configureShowroomControls();
  camera.position.copy(v.pos);
  controls.target.copy(v.tgt);
  if (v.up) camera.up.copy(v.up);
  camera.fov = v.fov || DEFAULT_FOV;
  camera.updateProjectionMatrix();
  controls.update();
}

/* ---------- track TV cameras (from the track's .cam file) ---------- */
const TRACK_CAM_FOV = 34;        /* TV cameras are telephoto */
let carCamOptionsHtml = null;    /* showroom car-camera <option> set, saved once */

/* Locate a track distance (m, dlong) on the lofted centreline: which segment and
   the 0..1 param within it. dlong shares the ini/.cam origin (segment 0 start =
   start/finish) and units (metres) — the same mapping the TV cameras aim with. */
function locateDlong(surface, dlong) {
  if (!surface || !surface.segments || !surface.segments.length) return null;
  const segs = surface.segments;
  const cum = []; let total = 0;
  for (const s of segs) {
    cum.push(total);
    total += Math.hypot(s.block.x1 - s.block.x0, s.block.y1 - s.block.y0);
  }
  if (total < 1e-6) return null;
  const d = ((dlong % total) + total) % total;
  let k = 0;
  for (let i = 0; i < segs.length; i++) { if (cum[i] <= d) k = i; else break; }
  const segLen = (k + 1 < segs.length ? cum[k + 1] : total) - cum[k];
  const u = segLen > 1e-6 ? (d - cum[k]) / segLen : 0;
  return { seg: segs[k], u };
}

/* Papyrus centreline point at a track distance (m) — used to aim a fixed camera
   at the stretch of track it watches (which reproduces the game's shot without
   decoding the camera's stored orientation). */
function centerlineAtDlong(surface, dlong) {
  const loc = locateDlong(surface, dlong);
  if (!loc) return null;
  const c = TrackSurface.sampleCenter(loc.seg, loc.u);
  return { x: c.x, y: c.y, z: c.z };
}

/* Pit-stall world pose from track.ini (dlong, dlat, heading), placed on the REAL
   lofted centreline — not the pit-light-prop spine the old heuristic used, which
   dropped stalls in the infield grass. dlong runs the centreline; dlat is the
   lateral metres from it (positive = driver's left = the infield/pit side on the
   ovals raced here); heading is added to the track tangent. Surface height at the
   stall's lateral offset sits the car on pit road, with a centreline-z fallback if
   the loft doesn't reach that far out. Returns null so callers fall back to the
   Track.stallWorld heuristic when there's no lofted surface. */
function pitStallWorld(surface, stall) {
  const loc = locateDlong(surface, stall.dlong);
  if (!loc) return null;
  const c = TrackSurface.sampleCenter(loc.seg, loc.u);
  const nx = -c.ty, ny = c.tx;                    /* driver's-left normal */
  const dlat = stall.dlat || 0;
  const x = c.x + nx * dlat;
  const y = c.y + ny * dlat;
  let z = TrackSurface.heightAt(loc.seg, dlat, dlat, loc.u);
  if (!Number.isFinite(z)) z = c.z;
  const heading = Math.atan2(c.ty, c.tx) + (stall.heading || 0);
  return { x, y, z, heading };
}

/* Start/finish placement: the centre of the track at dlong 0, aimed down the
   racing direction, at the centreline's surface height (z-up, trackGroup-local).
   The car floor offset is added later in placeCarAtStall so the tyres rest on
   the surface. */
function startFinishPlacement(surface) {
  if (!surface || !surface.segments || !surface.segments.length) return null;
  const seg = surface.segments[0];
  const c = TrackSurface.sampleCenter(seg, 0);
  const z = TrackSurface.profileHeight(seg.xsecs, 0, false);
  return { x: c.x, y: c.y, z, heading: Math.atan2(c.ty, c.tx) };
}

/* Swap the camera dropdown to the loaded track's TV cameras. */
function populateTrackCameras(cameras) {
  const sel = $('vp-camera');
  if (!sel) return;
  if (Driving.active) Driving.exit(false);   /* stop driving before a track (re)load rebuilds the scene */
  ensureCarCamOptionsSaved();
  let html = '<option value="trackview" selected>Track view</option>';
  html += '<option value="drive">Drive (Chase)</option>';
  html += '<option value="farChase">Far Chase</option>';
  html += '<option value="rearChase">Rear chase</option>';
  if (mod && mod.carCam && mod.carCam.records) html += '<option value="hood">Nose cam</option>';
  html += '<option value="free">Free camera</option>';
  /* TV cameras (auto director + the track's own .cam positions) removed by
     request — the `cameras` arg is still accepted so callers/track load are
     untouched, it just no longer builds menu entries. */
  sel.innerHTML = html;
  sel.classList.remove('hidden');
  sel.title = 'Drag to orbit, right-drag or arrow keys to pan, scroll to zoom';
}

function restoreCarCameras() {
  const sel = $('vp-camera');
  if (sel && carCamOptionsHtml !== null) sel.innerHTML = carCamOptionsHtml;
  if (sel) sel.classList.remove('hidden');
}

/* fill the driver-focus dropdown from the live field (Your car + each AI racer).
   Hidden while there's no field to spectate. Called when the field (dis)arms. */
function populateDriverSelect() {
  const sel = $('vp-driver');
  if (!sel || typeof Driving === 'undefined') return;
  const list = Driving.driverList();
  sel.innerHTML = list.map((d) => `<option value="${d.value}">${d.label}</option>`).join('');
  sel.value = Driving.focusValue;
  sel.classList.toggle('hidden', list.length <= 1);   /* nothing to spectate → hide */
}

/* TV cameras are placed + aimed live by Driving.tickTrackCamera (they track the
   focused car), so there's no static single-shot placement here anymore. */

/* ---------- mod folder loading ---------- */
const isJunk = (name) => baseName(name).startsWith('.') || baseName(name) === 'thumbs.db';
const isHelperModel = (name) =>
  /shadow|_ui\.|pieces|light|wheel|pace/.test(baseName(name));

function pickMainModel(items) {
  let best = null, bestSize = -1, bestHelper = true;
  for (const it of items) {
    if (!/\.3do$/i.test(it.name)) continue;
    const helper = isHelperModel(it.name);
    if ((bestHelper && !helper) || (helper === bestHelper && it.data.length > bestSize)) {
      best = it; bestSize = it.data.length; bestHelper = helper;
    }
  }
  return best;
}

/* ---------- track loading ---------- */
function clearTrackScenery() {
  if (!trackGroup) return;
  clearCarField();   /* detach shared-geometry car copies before the dispose sweep */
  scene.remove(trackGroup);
  trackGroup.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.isInstancedMesh) o.dispose();   /* free the per-instance matrix buffer (matches the car field) */
    /* horizon meshes carry a per-load material clone (2-sided) that the texture
       cache doesn't own; free it here (its shared .map stays cache-managed) */
    if (o.userData && o.userData.isHorizon && o.material) o.material.dispose();
  });
  trackGroup = null;
  _envProbeSmall = [];   /* don't retain the disposed track's meshes */
  updateSceneBackground();
}

function setTrackViewMode(on) {
  const grid = scene.getObjectByName('grid');
  if (grid) grid.visible = !on;
  updateSceneBackground();
}

function meshFromTrackPart(m) {
  const isGlass = GLASS_PART_RE.test(m.path) || isSemiTransparentMesh(m, 'track');
  const oriented = orientTrisToNormals(m);
  /* cutout billboards (crowd/fence/railing shells) render double-sided so they
     stay visible from behind; only opaque solids keep back-face culling */
  const cullBack = oriented !== null && !textureIsCutoutBillboard(m.texture, 'track');
  const tris = oriented || m.tris;
  if (!tris.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.verts), 3));
  if (m.uv) {
    const uv = new Float32Array(m.count * 2);
    for (let i = 0; i < m.count; i++) { uv[i * 2] = m.uv.u[i]; uv[i * 2 + 1] = m.uv.v[i]; }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  geo.setIndex(tris);
  if (m.normals) {
    const nr = new Float32Array(m.count * 3);
    for (let i = 0; i < m.count; i++) {
      nr[i * 3] = m.normals.x[i]; nr[i * 3 + 1] = m.normals.y[i]; nr[i * 3 + 2] = m.normals.z[i];
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(nr, 3));
  } else {
    geo.computeVertexNormals();
  }
  /* scenery is lit (Lambert) so the game's sun+ambient gives dark objects form;
     glass stays fullbright (self-lit tinted panes) and DOUBLE-SIDED (thin shell —
     single-sided culls its back face and the pane vanishes from certain angles) */
  const mesh = new THREE.Mesh(geo, materialFor(m.texture, isGlass, isGlass ? false : cullBack, false, true, !isGlass, 'track'));
  mesh.userData.isGlass = isGlass;   /* draw-order is assigned in the template loop */
  mesh.name = m.path;
  return mesh;
}

/* Cache per-3do template groups (Papyrus space). Instances clone the template
   and apply the TSO world pose. */
/* Car centre-of-gravity spawn proxies: the .ptf places one at every grid/comparison
   slot as a dynamic-car reference. The game never draws the proxy — it spawns a real
   car there — so we skip it in buildTrackScenery and instead drop a copy of the
   loaded car at each of these poses in buildCarField. */
const CAR_SPAWN_MARKERS = new Set(['car_cog.3do', 'cmpr_cog.3do']);

/* Vertical nudge (Papyrus metres) applied to grid cars placed straight on a
   car_cog pose, whose z is the centre-of-gravity height. 0 = sit exactly where
   the proxy did; tune once from a screenshot if the field floats or sinks. */
const GRID_CAR_LIFT_M = 0;

/* Per-car colour variety without breaking the one-draw-call field: an InstancedMesh
   can carry a per-instance colour the shader multiplies into the body paint. True
   different .car paints would need a separate texture (hence mesh) per car, which
   defeats the instancing — so instead each slot gets a stable light tint (golden-
   angle hue spread, high lightness so it shades the paint rather than muddying it).
   Deterministic in i, so a given grid slot always wears the same shade. */
const _fieldTint = new THREE.Color();
function carFieldTint(i) {
  const hue = (i * 0.6180339887) % 1;      /* golden-angle spread → well separated */
  return _fieldTint.setHSL(hue, 0.45, 0.8);
}

/* ---- car reflections: ONE shared low-res cubemap env, baked from the loaded
   scene (sky dome + track + scenery) and worn by every car's paint. Same
   philosophy as the tire smoke — visually rich but ~free per frame: a single
   128² cube probe rendered ONCE per track load (six quick face renders), zero
   cost while driving, no per-car reflection pass. Applied as a MixOperation env
   on the Lambert body so it reads as clearcoat sheen without washing the livery
   out; glass gets a stronger, mirror-ish blend. */
/* reflection quality (gfx.reflectHigh), chosen in Settings:
   - Low  = amortised: one cube face every CAR_ENV_FACE_EVERY frames, 128² cube.
            Cheap, but the reflection updates ~5×/s so it lags/steps a little.
   - High = ONE 256² face EVERY frame, round-robin — the reflection animates at
            the game's own frame rate and is sharper, at one extra scene pass
            per frame (a full cube refresh every 6 frames). It must never render
            all six faces in one frame: that costs 6 scene passes per frame and
            was the f194→f197 FPS collapse (persisted via the saved pref). */
const CAR_ENV_FACE_EVERY = 1;         /* live reflection cadence: render ONE cube face every N frames,
                                         round-robin over the 6 faces, instead of all six on one frame.
                                         Full cube refreshes every 6·N frames, but every frame's cost is flat
                                         and tiny — no periodic six-render hitch (the "stutter every so
                                         often") and lower AVERAGE cost than the old every-10-frames bake. */
const CAR_ENV_EXPOSURE = 0.5;         /* the cube is captured at HALF the scene exposure so its bright sky
                                         doesn't blow the paint white — turns the reflection down to a moody
                                         sheen (track, cars, blue sky) instead of a white wash. */
const CAR_ENV_REFLECT_BODY = 0.32;    /* painted panels: a MIX reflection of the (now darker) LIVE cube. At
                                         0.14 the body reflection was imperceptible next to the glass, so the
                                         car read as "only the windows reflect". With the cube dimmed by
                                         CAR_ENV_EXPOSURE this reads as a glossy clearcoat sheen, not a wash. */
const CAR_ENV_REFLECT_GLASS = 0.40;   /* glass/windows: a stronger Mix mirror, reflective not pure white */
/* f199: the f197 "hero boost" (player body 0.5 / glass 0.55 / intensity 0.65,
   compensating the self-centred probe) read WAY too aggressive on the paint —
   reverted to the f192 look: the player car wears the SAME strengths as the
   field, and glass reflects again at its f192 level. */
/* 'glas' (no double-s) catches cws2015's `glas_0` pane — '_' is a word char so
   \bglas\b would miss it, and 'glass' alone never matched it at all */
const CAR_ENV_GLASS_RE = /glas|window|windshield|windscreen|\bscreen\b/i;
/* rubber never reflects — the 4 road wheels (tyre + rim) and any explicit tyre
   piece. Matches the hero paths (lfwheel/…) and the field's `field:lfwheel/…`. */
const CAR_ENV_TIRE_RE = /(?:^|:)(?:lf|rf|lr|rr)wheel\b|tire|tyre|rubber/i;
function isTireLike(o) {
  return !!o.userData.isRoadWheel || CAR_ENV_TIRE_RE.test(o.name || '');
}
/* interior pieces never reflect either — the reflection belongs on the BODY,
   not the roll cage (cws2015 `chas_0`), cockpit dressing or the driver figure */
const CAR_ENV_INTERIOR_RE = /(?:^|[:\/])(chas|cage|cockpit|interior|dash|driver)/i;
function isNoReflectMesh(o) {
  return isTireLike(o) || CAR_ENV_INTERIOR_RE.test(o.name || '');
}
/* matte stand-ins for banned meshes that SHARE a material with body panels.
   cws2015 paints body + hood + antenna + DRIVER + all four RIMS + cowls from
   ONE card sheet → one shared material, so banning it via the rims killed the
   whole PLAYER body's reflection ("reflects on the cage, not the body"). The
   field never hit this because buildCarField clones materials per part. Keyed
   by source material so repeat applies reuse one clone per paint. */
const _envBanClone = new WeakMap();

/* probe scenery cull: a 128²/256² cube face can't resolve small props, but
   submitting them still costs the FULL scene's draw calls per face render —
   on Charlotte BBMC 1334 of 1620 track meshes are <20 m and hiding them cut
   the probe's scene render ~20× (18.7 ms → 0.8 ms measured). The reflection
   keeps everything that actually reads at cube-map scale: the loft surface
   ('surface:'), walls, grandstands, buildings, the sky. Rebuilt on every bake
   (bakeCarEnvMap runs once per track load, so the list tracks the live group). */
const ENV_PROBE_MIN_RADIUS_M = 20;
let _envProbeSmall = [];
function buildEnvProbeCull() {
  _envProbeSmall = [];
  if (!trackGroup) return;
  trackGroup.traverse((o) => {
    if (!o.isMesh || (o.name || '').startsWith('surface:')) return;
    const g = o.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    if (!g.boundingSphere) return;
    const r = g.boundingSphere.radius * Math.max(o.scale.x, o.scale.y, o.scale.z);
    if (r < ENV_PROBE_MIN_RADIUS_M) _envProbeSmall.push(o);
  });
}

function bakeCarEnvMap() {
  clearPartHover();
  if (!renderer || !scene) return;
  buildEnvProbeCull();
  if (!gfx.reflections) {          /* reflections off: don't build/probe the cube, just clear + roles */
    applyCarEnvMap(modelGroup);
    applyCarEnvMap(carFieldGroup);
    applyShadowFlags(scene);
    return;
  }
  try {
    if (!carEnvRT) {
      /* linear (no mipmaps): we now render ONE face at a time, and cube-RT
         mipmaps don't regenerate on a partial-face write — a mip chain would go
         stale/black and pit the reflection. Linear needs none and looks fine. */
      carEnvRT = new THREE.WebGLCubeRenderTarget(gfx.reflectHigh ? 256 : 128, {
        generateMipmaps: false, minFilter: THREE.LinearFilter,
      });
      carEnvCam = new THREE.CubeCamera(0.5, 9000, carEnvRT);
    }
    carEnvMap = carEnvRT.texture;
    const fillScene = (typeof WindTunnel !== 'undefined' && WindTunnel.active) ? WindTunnel.scene : scene;
    for (let i = 0; i < 6; i++) renderCarEnvProbe(fillScene);   /* first fill: all six faces at once */
    syncRendererViewport();
  } catch (err) {
    console.error('car env bake', err);
    carEnvMap = null;
    syncRendererViewport();
  }
  applyCarEnvMap(modelGroup);
  applyCarEnvMap(carFieldGroup);
  applyShadowFlags(scene);   /* track + car now present — set cast/receive roles */
}

/* Settings toggle: turn car reflections on/off live. On → build the cube if it
   was never baked, else just re-wear the existing env. Off → strip the env from
   every car material (and the loop stops probing), for max FPS. */
function setCarReflections(on) {
  gfx.reflections = !!on;
  saveGfxPrefs();
  if (on && !carEnvMap && (modelGroup || trackGroup)) { bakeCarEnvMap(); return; }
  applyCarEnvMap(modelGroup);
  applyCarEnvMap(carFieldGroup);
}

/* Settings: reflection quality. High walks one sharper 256² face per frame (see
   the loop); Low is amortised at 128², one face every couple of frames. The cube
   is sized at creation, so a change disposes the cube + probe and rebuilds. */
function setReflectQuality(high) {
  gfx.reflectHigh = !!high;
  saveGfxPrefs();
  if (carEnvRT) { carEnvRT.dispose(); carEnvRT = null; }
  carEnvCam = null; carEnvMap = null; _envFace = 0;
  if (gfx.reflections && (modelGroup || trackGroup)) bakeCarEnvMap();   /* recreate at the new resolution + re-wear */
  else { applyCarEnvMap(modelGroup); applyCarEnvMap(carFieldGroup); }
}

/* Re-render ONE face of the shared reflection cube from the spectated car's
   CURRENT position, cycling a face each call so the six-render cost is spread
   flat across frames (no periodic hitch). The probe is only re-anchored on
   face 0, so all six faces of a cycle share one position (no seam from a moving
   probe). Only the spectated car (self) is hidden from the cube capture.
   Captured at CAR_ENV_EXPOSURE so the bright sky doesn't wash the paint white. */
let _envFace = 0;
function renderCarEnvProbe(captureScene) {
  /* capture whatever scene the frame is showing (f203): the track when one is
     loaded, the bare showroom otherwise, the tunnel room while it's active —
     the car's paint mirrors the world it is actually standing in */
  const target = captureScene || scene;
  if (!renderer || !target || !carEnvCam || !carEnvRT) return;
  const cam = carEnvCam.children && carEnvCam.children[_envFace];
  if (!cam) { _envFace = 0; return; }          /* CubeCamera child ↔ cube face (three pairs them 1:1) */
  /* re-anchor every frame so the reflection tracks the car at display rate (High
     renders one face/frame — leaving the probe fixed for 5/6 frames lagged ~50 ms
     at 120 Hz and the paint shimmered). Cubemap parallax across faces is minor
     vs a stale probe on a fast car. */
  if (!(typeof Driving !== 'undefined' && Driving.focusWorldPos && Driving.focusWorldPos(_envProbePos))) {
    if (modelGroup) modelGroup.getWorldPosition(_envProbePos); else _envProbePos.set(0, 0, 0);
  }
  _envProbePos.y += 1.2;
  carEnvCam.position.copy(_envProbePos);
  carEnvCam.updateMatrixWorld(true);
  const mv = modelGroup ? modelGroup.visible : false;
  const fv = carFieldGroup ? carFieldGroup.visible : false;
  const smallShown = [];
  try {
    if (modelGroup) modelGroup.visible = false;   /* self must not fill its own reflection */
    /* skip the ~40-car field in the cube capture — rendering the whole grid up to
       6× per frame (High) was most of the reflection cost. Cars reflect the track +
       surroundings, not each other (barely noticeable, big FPS win). */
    if (carFieldGroup) carFieldGroup.visible = false;
    /* small track props don't read at cube-map scale — hiding them makes the
       face render near-free on prop-heavy tracks (see buildEnvProbeCull) */
    for (const m of _envProbeSmall) if (m.visible) { m.visible = false; smallShown.push(m); }
    const horizonHidden = [];
    target.traverse((o) => {
      if ((o.isMesh || o.isInstancedMesh) && o.userData && o.userData.isHorizon && o.visible) {
        o.visible = false;
        horizonHidden.push(o);
      }
    });
    /* freeze the shadow map (reuse the main frame's) and dim the capture so the
       reflection reads as a sheen, not a white sky wash. Both restored after. */
    const prevAuto = renderer.shadowMap.autoUpdate;
    const prevExp = renderer.toneMappingExposure;
    renderer.shadowMap.autoUpdate = false;
    renderer.toneMappingExposure = prevExp * CAR_ENV_EXPOSURE;
    try {
      renderer.setRenderTarget(carEnvRT, _envFace);
      renderer.render(target, cam);
    } catch (err) { console.error('env probe face ' + _envFace, err); }
    renderer.setRenderTarget(null);
    renderer.toneMappingExposure = prevExp;
    renderer.shadowMap.autoUpdate = prevAuto;
  } finally {
    if (modelGroup) modelGroup.visible = mv;
    if (carFieldGroup) carFieldGroup.visible = fv;
    for (const m of smallShown) m.visible = true;
    for (const m of horizonHidden) m.visible = true;
    syncRendererViewport();
  }
  _envFace = (_envFace + 1) % 6;
}

/* Wear the shared env on every car material under `root` (idempotent). No-op
   until a bake exists; a null env clears any prior reflection cleanly. */
function applyCarEnvMap(root) {
  if (!root) return;
  /* pass 1: sort every material into banned (worn by a tyre/cage/driver mesh)
     vs body-worn. A material worn ONLY by banned meshes is banned outright; a
     material worn by BOTH (cws2015's one-sheet paint) must NOT be banned — the
     banned meshes are swapped onto a matte clone instead, so the body panels
     keep their reflection and rubber/cage/driver stay matte. */
  const noReflect = new Set();
  const bodyWorn = new Set();
  const bannedMeshes = [];
  root.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (isNoReflectMesh(o)) {
      bannedMeshes.push(o);
      for (const m of mats) if (m) noReflect.add(m);
    } else {
      for (const m of mats) if (m) bodyWorn.add(m);
    }
  });
  for (const o of bannedMeshes) {
    const matteClone = (m) => {
      if (!m || !bodyWorn.has(m)) return m;   /* not shared: the plain ban is fine */
      let c = _envBanClone.get(m);
      if (!c) {
        c = m.clone();
        c.envMap = null;
        if ('reflectivity' in c) c.reflectivity = 0;
        _envBanClone.set(m, c);
      }
      noReflect.add(c);
      noReflect.delete(m);   /* the shared source stays reflective for the body */
      return c;
    };
    if (Array.isArray(o.material)) o.material = o.material.map(matteClone);
    else o.material = matteClone(o.material);
    /* keep the part inspector's restore target in step (player meshes only) —
       otherwise a hover would flip the mesh back onto the shared painted mat */
    if (o.userData && o.userData.baseMaterial && !Array.isArray(o.material)
        && !isHighlightMaterial(o.material)) {
      o.userData.baseMaterial = o.material;
      o.userData.pristineMaterial = o.material;
    }
  }
  /* pass 2: apply (or explicitly clear) the shared env per material. When the
     reflections toggle is off, env is null so every car material is cleared. */
  const env = gfx.reflections ? carEnvMap : null;
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || seen.has(m) || !('envMap' in m)) continue;
      seen.add(m);
      if (noReflect.has(m) || !env) {          /* tyres/rubber, or reflections off: matte, clear any prior */
        if (m.envMap) { m.envMap = null; if ('reflectivity' in m) m.reflectivity = 0; m.needsUpdate = true; }
        continue;
      }
      const glass = CAR_ENV_GLASS_RE.test(m.name || '') || CAR_ENV_GLASS_RE.test(o.name || '');
      /* f199: back to the f192 look — glass reflects again (Mix 0.40, the f197
         "glass does not reflect" removal was an FPS-hunt casualty; the real cost
         was the 6-face High loop, fixed in f198), and the hero car wears the
         same strengths as the field (the f197 player boost read too strong).
         f202: everything scaled by the user's Reflection strength slider
         (gfx.reflStrength, 1 = the f192 look) so the body sheen can be dialed
         back without killing the live probe. */
      const strength = gfx.reflStrength;
      m.envMap = env;
      if ('reflectivity' in m) m.reflectivity = (glass ? CAR_ENV_REFLECT_GLASS : CAR_ENV_REFLECT_BODY) * strength;
      /* MixOperation, NOT Add: Add layered the sky onto every panel and whitened
         the whole car. Mix reflects the surroundings without the white haze. */
      if ('combine' in m) m.combine = THREE.MixOperation;
      if ('envMapIntensity' in m) m.envMapIntensity = (glass ? 0.8 : 0.4) * strength;   /* Standard mats */
      m.needsUpdate = true;
    }
  });
}

/* Detach the grid/pit field. Each part is an InstancedMesh whose geometry +
   material are SHARED with the hero car; dispose() frees only the per-instance
   matrix buffer, never the shared geometry/material. */
function clearCarField() {
  if (!carFieldGroup) return;
  if (carFieldGroup.parent) carFieldGroup.parent.remove(carFieldGroup);
  carFieldGroup.traverse(o => { if (o.isInstancedMesh) o.dispose(); });
  /* the field owns its per-paint textures + cloned materials (the shared hero
     geometry/material are left alone) — free them so track reloads don't leak */
  (carFieldGroup.userData.disposables || []).forEach(d => { if (d && d.dispose) d.dispose(); });
  carFieldGroup = null;
}

/* One Papyrus-space transform per pit stall, in the PRIMARY pit lane only, capped at
   the track's max_starters. One pit lane per config per config; the old code
   placed a car at every .ptf grid marker AND every pit_lane_N stall, so the field
   was ~2× the real size with cars stacked where lanes/grid overlapped ("merged").
   Now it's one clean row of stalls — exactly what the track holds. trackGroup-local,
   matching how the hero car is parented. */
function carFieldMatrices() {
  const mats = [];
  const poses = [];   /* raw Papyrus spawn per stall — seeds each field car's physics */
  const _e = new THREE.Euler(), _q = new THREE.Quaternion();
  const _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
  const push = (x, y, z, rz, ry, rx) => {
    _e.set(rx, ry, rz, 'ZYX');            /* Papyrus R = Rz·Ry·Rx, like scenery */
    _q.setFromEuler(_e); _p.set(x, y, z);
    mats.push(new THREE.Matrix4().compose(_p, _q, _s));
    poses.push({ x, y, z, heading: rz });   /* rz = surface heading (ry/rx are 0 on the flat) */
  };
  /* field clones get no body lift, so rest them on their lowest point —
     the pre-tyre-contact behaviour — to keep slammed bodies out of the track */
  const floor = (typeof mod.bodyFloorZ === 'number') ? mod.bodyFloorZ
              : (typeof mod.floorZ === 'number') ? mod.floorZ : 0;
  const surface = track.surface;
  const maxStarters = (track.meta && track.meta.maxStarters) || 43;
  const lane = (track.meta.lanes || [])[0];   /* primary lane = the racing field */
  if (lane) {
    const spine = surface ? null : Track.pitSpine(track.refs, lane);   /* heuristic only w/o loft */
    for (const stall of lane.stalls) {
      if (mats.length >= maxStarters) break;
      const w = pitStallWorld(surface, stall) || Track.stallWorld(stall, spine, track.meta.length);
      push(w.x, w.y, w.z - floor, w.heading, 0, 0);
    }
  }
  /* lane-less synthetic tracks (the endless road) have no pit stalls — spread the
     field evenly along the centreline so buildCarField still gets its mesh slots
     (the race grid repositions them the instant a race arms). */
  if (!mats.length && surface && surface.segments && surface.segments.length) {
    const segs = surface.segments;
    const segL = (s) => s.arc ? Math.abs(s.arc.r * s.arc.dth)
      : Math.hypot(s.block.x1 - s.block.x0, s.block.y1 - s.block.y0);
    let total = 0; for (const s of segs) total += segL(s);
    const gap = total / maxStarters;
    for (let i = 0; i < maxStarters; i++) {
      let dist = i * gap, k = 0, acc = 0;
      while (k < segs.length - 1 && acc + segL(segs[k]) < dist) { acc += segL(segs[k]); k++; }
      const seg = segs[k];
      const u = Math.max(0, Math.min(1, (dist - acc) / Math.max(1e-3, segL(seg))));
      const c = TrackSurface.sampleCenter(seg, u);
      push(c.x, c.y, TrackSurface.heightAt(seg, 0, 0, u) - floor, Math.atan2(c.ty, c.tx), 0, 0);
    }
  }
  return { mats, poses };
}

/* Distinct paints for the field, pulled from the loaded carset's real .car files —
   NOT the hero's single sheet, and with the player's own active paint excluded so
   the grid/pit field never mirrors the car parked at start/finish. Each .car's XETC
   chunk is the body sheet (same decode as applyCarPaint), turned into a CanvasTexture
   the field wears. Only valid when the body sits on the paint-layout uv channel
   (mod.meshesPaintedBody) — the legacy template channel would land a .car sheet
   misaligned, so there we fall back to the hue tint. Capped so a full 43-car set
   doesn't decode 43 mips and spawn a wall of draw calls on every track load. */
const MAX_FIELD_PAINTS = 43;   /* NASCAR max field; the track's max_starters caps it further */
function bodyTextureFromCar(car) {
  try {
    const { chunks } = Frac.parse(car.data);
    const xetc = chunks.find(c => c.tag === 'XETC');
    if (!xetc) return null;
    return makeTexture(canvasFromMip(xetc.data).canvas);
  } catch (err) { console.error('field paint ' + car.name, err); return null; }
}
/* The stall→scheme assignment AND the decoded textures are FROZEN per
   car-mod+track (fieldPaintPlan): the player excluded at first build only.
   Re-deriving it on every rebuild made the whole field swap schemes whenever
   the player changed paint — and re-DECODING ~43 body sheets made every
   cross-make scheme change take seconds. Now a hero rebuild reuses the same
   GPU textures; only a new series or track pays the decode cost again. */
let fieldPaintPlan = null;   /* { key, textures } — plan owns the textures */
function disposeFieldPaintPlan() {
  if (!fieldPaintPlan) return;
  for (const t of fieldPaintPlan.textures) t.dispose();
  fieldPaintPlan = null;
}
function fieldPaintTextures(cap) {
  if (!mod.meshesPaintedBody) return [];
  const limit = Math.max(0, Math.min(MAX_FIELD_PAINTS, cap != null ? cap : MAX_FIELD_PAINTS));
  const key = (mod.folderName || '') + '|' + (track ? track.folderName : '') + '|' + limit;
  if (!fieldPaintPlan || fieldPaintPlan.key !== key) {
    disposeFieldPaintPlan();
    const pool = (mod.carFiles || []).filter(c => c.name !== mod.activePaintCar);
    const textures = [];
    for (const car of pool) {
      if (textures.length >= limit) break;
      const tex = bodyTextureFromCar(car);
      if (tex) textures.push(tex);
    }
    fieldPaintPlan = { key, textures };
  }
  return fieldPaintPlan.textures;
}

/* Interior / running-gear card.mip parts: painted by the .car sheet too, but not
   the identifying livery — so the field shares ONE instanced copy of them (the hero's)
   instead of a unique draw per car, keeping the count sane. Only the EXTERIOR body
   panels (everything not matched here) get a unique paint per car. */
const FIELD_SHARED_BODY_RE = /driver|interior|seat|roll.?cage|chassis|\bnet\b|wheel|tire|tyre|rim|engine|radiator|underside|cockpit|foam|dash|leg|hand|arm|helmet|shoe|pant|glass|window/i;

/* Fill the pit stalls with the field: one UNIQUE car per stall. The exterior body
   panels are drawn per-car with that car's own .car paint (so every scheme is real
   and distinct — no repeats, none the player's); interior/running-gear/other parts
   are single shared InstancedMeshes across the whole field. Bodies share the hero
   geometry (only the paint texture differs), so it's ~exteriorParts×N + a handful of
   instanced parts — not one mesh per whole car (90 full clones froze the tab).
   No-op without both a car and a track. */
function buildCarField() {
  clearPartHover();
  clearCarField();
  if (!mod || !mod.meshes || !modelGroup || !trackGroup || !track) return;

  const { mats, poses } = carFieldMatrices();
  if (!mats.length) return;

  carFieldGroup = new THREE.Group();
  carFieldGroup.name = 'car-field';
  carFieldGroup.userData.disposables = [];   /* field-owned paint textures + materials */
  let parts = 0;

  const bodyMats = new Set(materialsForTexture(mod.bodyTexture));
  const maxStarters = Math.min((track.meta && track.meta.maxStarters) || 43, KIOSK_FIELD || 99);
  /* real carset schemes, player excluded — textures live on fieldPaintPlan
     (NOT in disposables) so hero rebuilds don't re-decode the whole set */
  const paints = fieldPaintTextures(maxStarters);

  /* field size = every stall filled with a distinct paint, capped at what the track
     holds; with no usable carset, fall back to the hero body + a per-slot hue tint */
  const N = paints.length
    ? Math.min(mats.length, paints.length, maxStarters)
    : Math.min(mats.length, maxStarters);
  const slots = mats.slice(0, N);
  /* Roof/hood flap pieces ARE exterior bodywork and now wear EACH car's own paint
     (like the rest of the body) — borrowing the shared hero material made every
     AI car's flaps show the player's livery (or a flat grey when the region reads
     as the sheet's unpainted corner), which is the "AI flaps are grey" bug. Their
     livery lives in the body sheet, so per-car paint stamps the right colours; a
     mod that genuinely leaves the flap UV region blank just shows its own blank
     there (same as its hero car would). */
  const isExteriorBody = (child) => {
    if (FIELD_SHARED_BODY_RE.test(child.name || '')) return false;
    return bodyMats.has(heroMeshBaseMaterial(child)) || child.userData.isFlapPart || child.userData.hasFlapMorph;
  };

  /* physics registry — one drivable/crashable Physics.Car per stall shares the
     player's solver (Driving.armField reads this). Each slot's world transform
     lives in its per-car body Mesh(es) AND at index `slot` of every shared
     InstancedMesh part, so re-posing a crashed car writes both. */
  const phys = {
    N,
    poses: poses.slice(0, N),
    authored: slots,                                      /* parked-pose matrix per slot (disarm restore) */
    slotBodyMeshes: Array.from({ length: N }, () => []),  /* per-car unique-paint body meshes */
    instParts: [],                                        /* shared parts; instance i = slot i */
    wheelParts: [],                                       /* {inst, idx, center, front} — spun per awake car */
  };
  const FIELD_WHEEL_IDX = { lf: 0, rf: 1, lr: 2, rr: 3 };

  const matCache = new Map();   /* `${baseMat.uuid}#${car}` -> body material wearing car's paint */
  const paintedMat = (baseMat, car) => {
    const key = baseMat.uuid + '#' + car;
    let m = matCache.get(key);
    if (!m) {
      m = baseMat.clone();
      m.map = paints[car];
      if (m.color) m.color.set(0xffffff);
      m.needsUpdate = true;
      matCache.set(key, m);
      carFieldGroup.userData.disposables.push(m);
    }
    return m;
  };

  /* flap-morph meshes get ONE cloned geometry for the whole field — the hero's
     buffers are live-morphed while driving, and shared geometry would deploy
     every parked car's flaps in sync with the player */
  const flapGeoCache = new Map();
  const fieldGeo = (child) => {
    if (!child.userData.flapMorph) return child.geometry;
    let g = flapGeoCache.get(child.geometry);
    if (!g) {
      g = child.geometry.clone();
      flapGeoCache.set(child.geometry, g);
      carFieldGroup.userData.disposables.push(g);
    }
    return g;
  };

  for (const child of modelGroup.children) {
    if (!child.isMesh || !child.geometry) continue;
    const baseMat = heroMeshBaseMaterial(child);
    if (paints.length && isExteriorBody(child)) {
      /* one mesh per car, each wearing its own paint (shared hero geometry) */
      for (let car = 0; car < N; car++) {
        const mesh = new THREE.Mesh(fieldGeo(child), paintedMat(baseMat, car));
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(slots[car]);
        mesh.matrixWorldNeedsUpdate = true;
        mesh.renderOrder = child.renderOrder;
        mesh.frustumCulled = false;
        mesh.name = 'field:' + (child.name || 'body') + '#' + car;
        mesh.userData.isFlapPart = !!child.userData.isFlapPart;
        mesh.userData.hasFlapMorph = !!child.userData.hasFlapMorph;
        mesh.userData.isFlapDressing = !!child.userData.isFlapDressing;
        carFieldGroup.add(mesh);
        phys.slotBodyMeshes[car].push(mesh);
        parts++;
      }
    } else {
      const inst = new THREE.InstancedMesh(fieldGeo(child), baseMat, N);
      for (let i = 0; i < N; i++) inst.setMatrixAt(i, slots[i]);
      inst.instanceMatrix.needsUpdate = true;
      /* no carset to draw from: keep the old body hue tint so the field still
         isn't a wall of identical cars (older three builds no-op setColorAt) */
      if (!paints.length && bodyMats.has(baseMat) && typeof inst.setColorAt === 'function') {
        for (let i = 0; i < N; i++) inst.setColorAt(i, carFieldTint(i));
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      }
      inst.renderOrder = child.renderOrder;
      inst.frustumCulled = false;
      inst.name = 'field:' + (child.name || 'part');
      inst.userData.isFlapPart = !!child.userData.isFlapPart;
      inst.userData.hasFlapMorph = !!child.userData.hasFlapMorph;
      inst.userData.isFlapDressing = !!child.userData.isFlapDressing;
      carFieldGroup.add(inst);
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);   /* re-posed when a slot crashes */
      phys.instParts.push(inst);
      /* road wheels: record the spin axle so a shoved car's tyres actually turn */
      const slot = wheelSlotFromPath(child.name || '');
      if (child.userData.isRoadWheel && slot) {
        child.geometry.computeBoundingBox();
        const center = child.geometry.boundingBox.getCenter(new THREE.Vector3());
        const idx = FIELD_WHEEL_IDX[slot];
        phys.wheelParts.push({ inst, idx, center, front: idx < 2 });
      }
      parts++;
    }
  }
  carFieldGroup.userData.phys = phys;
  applyCarEnvMap(carFieldGroup);   /* shared reflection env onto the field's paints */
  applyShadowFlags(carFieldGroup); /* field cars cast + receive the sun shadow */
  trackGroup.add(carFieldGroup);
  log(`Car field: ${N} cars in pit stalls` +
    (paints.length ? `, ${paints.length} unique paints` : ' (hue-tinted)') + `.`);
}

function buildTrackScenery(refs, datItems, isNight) {
  clearTrackScenery();
  trackGroup = new THREE.Group();
  trackGroup.name = 'track';
  trackGroup.rotation.x = -Math.PI / 2;

  const byName = new Map();
  for (const it of datItems) {
    if (/\.3do$/i.test(it.name)) byName.set(baseName(it.name), it);
  }
  const templates = new Map(); /* lower-case 3do name -> THREE.Group | null (bad) */
  const placedKeys = new Set(); /* 3do names actually placed via a TSO ref */
  let placed = 0, skipped = 0, failed = 0;
  const placedLights = [];     /* world-posed (trackGroup-local) tower-light points */
  const _m = new THREE.Matrix4(), _e = new THREE.Euler(), _v = new THREE.Vector3();

  /* build (or fetch) a 3do template group. Its child meshes carry geometry,
     material, and the authored-order renderOrder — the group is never added to
     the scene, it is only the SOURCE we instance from.
     Preserve the model's AUTHORED part order as draw order: The game traverses the
     scene in order with a LEQUAL depth test, so a face authored coplanar-and-after
     another (a jumbotron SCREEN over its backing panel) overwrites it. renderOrder
     = authored index restores that order (opaque low; glass always last). */
  const buildTemplate = (key) => {
    let tmpl = templates.get(key);
    if (tmpl !== undefined) return tmpl;
    const item = byName.get(key);
    if (!item) { templates.set(key, null); return null; }
    try {
      const parsed = ThreeDO.parse(item.data);
      const meshes = ThreeDO.extractMeshes(parsed, { trackProp: true, dayNight: isNight ? 2 : 1 });
      tmpl = new THREE.Group();
      tmpl.name = key;
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshFromTrackPart(meshes[i]);
        if (!mesh) continue;
        mesh.renderOrder = (mesh.userData.isGlass ? 100000 : 0) + i;
        tmpl.add(mesh);
      }
      tmpl.userData.lights = meshes.lights || [];   /* PointLights in this model */
      if (!tmpl.children.length && !tmpl.userData.lights.length) { templates.set(key, null); return null; }
      templates.set(key, tmpl);
      return tmpl;
    } catch (err) {
      console.error('track 3do ' + key, err);
      failed++;
      templates.set(key, null);
      return null;
    }
  };

  /* PASS 1: group every placement by 3do key, and drop tower-light points per
     instance. pose slots [3,4,5] are (rz,ry,rx); Papyrus R = Rz·Ry·Rx → Euler
     order MUST be 'ZYX' (see threedo.js) — 'XYZ' flings the upright-tipped tree
     billboards skyward. */
  const posesByKey = new Map();
  for (const ref of refs) {
    const key = baseName(ref.name);
    /* car_cog / cmpr_cog are car-spawn markers the .ptf drops at every grid slot;
       The game never draws them, so skip (the loaded car is placed at start/finish) */
    if (CAR_SPAWN_MARKERS.has(key)) { skipped++; continue; }
    /* skyboxes removed: skip any sky/skybox/skydome TSO so no atmospheric dome renders */
    if (/(^|[_\s])(n?sky|skybox|skydome)([_.\d]|$)/i.test(key)) { skipped++; continue; }
    const tmpl = buildTemplate(key);
    if (!tmpl) { skipped++; continue; }
    const pose = ref.pose;
    if (isNight && tmpl.userData.lights && tmpl.userData.lights.length) {
      _e.set(pose[5], pose[4], pose[3], 'ZYX');
      _m.makeRotationFromEuler(_e).setPosition(pose[0], pose[1], pose[2]);
      for (const L of tmpl.userData.lights) {
        _v.set(L.pos[0], L.pos[1], L.pos[2]).applyMatrix4(_m);
        placedLights.push([_v.x, _v.y, _v.z]);
      }
    }
    if (tmpl.children.length) {
      let list = posesByKey.get(key);
      if (!list) { list = []; posesByKey.set(key, list); }
      list.push(pose);
      placedKeys.add(key);
      placed++;
    }
  }

  /* PASS 2: ONE InstancedMesh per template-mesh across all its placements. THE
     draw-call cut — N clones × M meshes (N×M draws, the fps sink at draws ~1400)
     collapse to M draws per unique 3do. Scenery geometry is baked in Papyrus space
     with an identity local transform, so each instance matrix is exactly the TSO
     pose (translate × ZYX-rotate) — same result the per-clone position/rotation
     gave. frustumCulled off: it's one draw and instances are spread track-wide, so
     per-object culling can't help and would risk the whole set popping out. */
  const _ie = new THREE.Euler();
  for (const [key, poses] of posesByKey) {
    const tmpl = templates.get(key);
    if (!tmpl) continue;
    const mats = poses.map((p) => {
      _ie.set(p[5], p[4], p[3], 'ZYX');
      return new THREE.Matrix4().makeRotationFromEuler(_ie).setPosition(p[0], p[1], p[2]);
    });
    for (const child of tmpl.children) {
      const im = new THREE.InstancedMesh(child.geometry, child.material, mats.length);
      im.name = child.name;
      im.renderOrder = child.renderOrder;
      im.userData.isGlass = child.userData.isGlass;
      im.frustumCulled = false;
      for (let i = 0; i < mats.length; i++) im.setMatrixAt(i, mats[i]);
      im.instanceMatrix.needsUpdate = true;
      trackGroup.add(im);
    }
  }

  /* Light-blue scene clear (TRACK_BG) — no sky dome. Horizon ring still loads. */
  const sky = placeTrackSky(byName, isNight, placedKeys);
  const horizon = placeTrackHorizon(byName, isNight, placedKeys);
  const towerLights = isNight ? addTowerLights(placedLights) : 0;
  scene.add(trackGroup);
  return { placed, skipped, failed, sky, horizon, towerLights, unique: [...templates.values()].filter(Boolean).length };
}
function placeTrackSky(byName, isNight, placedKeys) {
  return 0;   /* scene.background = TRACK_BG */
}

/* The horizon/sky backdrop. The original game loads a conventional horizon model by name
   (`horiz.3do`) and draws it centred on the track origin — it is authored as a
   world-scale ring (Daytona: ~4.5 km radius, a horizon band of ground + treeline
   + buildings under the sky colour) and is NOT a TSO reference, so the scenery
   loop above never sees it and stock tracks rendered with an empty sky. Modern
   mods instead place a full sky DOME as a normal TSO object (Martinsville's
   `24hr_sky.3do`), which already renders. Draw the conventional horizon here so
   every track that ships one gets its sky. Placed at the origin with identity
   pose (its authored centre); rendered DOUBLE-SIDED because the ring is viewed
   from inside (the winding-based backface cull would otherwise hide it), and
   first (renderOrder −1) so nearer scenery overwrites it. */
const HORIZON_MODELS = ['horiz.3do'];
function placeTrackHorizon(byName, isNight, placedKeys) {
  let parts = 0;
  for (const name of HORIZON_MODELS) {
    const key = baseName(name);
    if (placedKeys.has(key)) continue;      /* a mod referenced it explicitly */
    const item = byName.get(key);
    if (!item) continue;
    try {
      const parsed = ThreeDO.parse(item.data);
      const meshes = ThreeDO.extractMeshes(parsed, { trackProp: true, dayNight: isNight ? 2 : 1 });
      for (const part of meshes) {
        const mesh = meshFromTrackPart(part);
        if (!mesh) continue;
        mesh.material = mesh.material.clone();   /* don't flip the shared cache to 2-sided */
        mesh.material.side = THREE.DoubleSide;
        /* Pure BACKDROP: draw first and DON'T write depth, so the generated
           track surface (drawn after) always wins where the aerial terrain
           plane and the track pad are coplanar — otherwise the terrain
           z-fights / clips up through the racing surface. The whole horizon
           model sits at the far perimeter beyond every other object, so not
           writing depth can't let anything wrongly show through it. */
        mesh.material.depthWrite = false;
        mesh.userData.isHorizon = true;          /* clone isn't cache-managed → dispose on clear */
        mesh.renderOrder = -1;                    /* before the track surface */
        mesh.frustumCulled = false;              /* huge + centred; never cull it out */
        trackGroup.add(mesh);
        parts++;
      }
    } catch (err) {
      console.error('horizon ' + key, err);
    }
  }
  return parts;
}

/* Cluster co-located tower bulbs (a rack of 12/6 shares one tower) into a small
   set of THREE.PointLights so night scenes get light pools without paying for
   hundreds of forward-rendered lights. Points are in trackGroup-local (Papyrus
   Z-up) space; trackGroup's -90°X rotation carries them into scene Y-up. */
function addTowerLights(points) {
  if (!points.length) return 0;
  const cell = TOWER_LIGHT_CELL_M;
  const clusters = new Map();
  for (const p of points) {
    const k = Math.round(p[0] / cell) + '/' + Math.round(p[1] / cell) + '/' + Math.round(p[2] / cell);
    let c = clusters.get(k);
    if (!c) { c = { x: 0, y: 0, z: 0, n: 0 }; clusters.set(k, c); }
    c.x += p[0]; c.y += p[1]; c.z += p[2]; c.n++;
  }
  let list = [...clusters.values()].map(c => ({ x: c.x / c.n, y: c.y / c.n, z: c.z / c.n, n: c.n }));
  list.sort((a, b) => b.n - a.n);           /* biggest racks = the main towers */
  if (list.length > MAX_TOWER_LIGHTS) list = list.slice(0, MAX_TOWER_LIGHTS);
  for (const c of list) {
    const light = new THREE.PointLight(TOWER_LIGHT_COLOR, TOWER_LIGHT_INTENSITY, TOWER_LIGHT_DISTANCE, TOWER_LIGHT_DECAY);
    light.position.set(c.x, c.y, c.z);
    trackGroup.add(light);
  }
  return list.length;
}

/* ---------- generated track surface (ground strips + walls from the .ptf) ----------
   The game lofts the drivable track at load time from segment centerline
   blocks and lateral cross-sections — none of it exists as .3do models.
   TrackSurface.extract recovers that data; here it becomes one merged mesh
   per texture inside trackGroup (Papyrus Z-up coords, like the TSOs). */
const SURFACE_FALLBACK_TILE_M = 8;   /* uv repeat when a strip has no TC quad */

function buildTrackSurface(surface) {
  const segs = surface.segments;
  const n = segs.length;
  if (!n || !trackGroup) return { strips: 0, walls: 0 };

  const buckets = new Map();
  const bucketFor = (texture) => {
    const key = texture ? baseName(texture) : '__untextured__';
    let b = buckets.get(key);
    if (!b) { b = { texture, pos: [], uv: [], idx: [] }; buckets.set(key, b); }
    return b;
  };
  /* quad corners: a = start edge A, b = end edge A, c = end edge B,
     d = start edge B — matches the TC uv corner order */
  const emitQuad = (bucket, pa, pb, pc, pd, uvq) => {
    const base = bucket.pos.length / 3;
    bucket.pos.push(...pa, ...pb, ...pc, ...pd);
    bucket.uv.push(uvq.u[0], uvq.v[0], uvq.u[1], uvq.v[1],
      uvq.u[2], uvq.v[2], uvq.u[3], uvq.v[3]);
    bucket.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  /* bilinear point on a TC quad: t = along-section fraction, s = lateral
     fraction from the section's left edge (q0→q1) to its right edge (q3→q2) */
  const uvOnQuad = (uvq, t, s) => {
    const ul = uvq.u[0] + (uvq.u[1] - uvq.u[0]) * t, vl = uvq.v[0] + (uvq.v[1] - uvq.v[0]) * t;
    const ur = uvq.u[3] + (uvq.u[2] - uvq.u[3]) * t, vr = uvq.v[3] + (uvq.v[2] - uvq.v[3]) * t;
    return [ul + (ur - ul) * s, vl + (vr - vl) * s];
  };
  /* uv corners for the sub-quad [t0,t1] whose left cut sits at lateral fraction
     sL0→sL1 (start→end of the sub-quad) and right cut at sR0→sR1. Per-t lateral
     fractions kill the shear that a start-side-only fraction paints onto bands
     that drift laterally down the track. */
  const quadUv = (uvq, t0, t1, sL0, sL1, sR0, sR1) => {
    if (!uvq) return null;
    const a = uvOnQuad(uvq, t0, sL0), b = uvOnQuad(uvq, t1, sL1);
    const c = uvOnQuad(uvq, t1, sR1), d = uvOnQuad(uvq, t0, sR0);
    return { u: [a[0], b[0], c[0], d[0]], v: [a[1], b[1], c[1], d[1]] };
  };

  /* A section is a straight or a circular arc (Type in the .ptf block). All
     vertices come from loftEdge curves; the rings are just the t-ladder the
     section tessellates along — enough sub-steps to keep each face under the
     game's ArcResolution (~5°). segLen feeds the fallback uv tiling. */
  const ringsFor = (k) => {
    const seg = segs[k];
    const nsub = TrackSurface.subRingCount(seg);
    const rings = [];
    let segLen = 0, px = 0, py = 0;
    for (let i = 0; i <= nsub; i++) {
      const t = i / nsub;
      const c = TrackSurface.sampleCenter(seg, t);
      if (i > 0) segLen += Math.hypot(c.x - px, c.y - py);
      px = c.x; py = c.y;
      rings.push({ t });
    }
    return { rings, segLen };
  };

  let stripQuads = 0, wallQuads = 0;
  for (let k = 0; k < n; k++) {
    const seg = segs[k];
    const { xsecs, strips, walls } = seg;
    const { rings, segLen } = ringsFor(k);
    /* X_Section heights are ABSOLUTE world elevations (verified: camper TSO
       pose z matches h directly) — the block z is a reference line elevation
       that must NOT be added, or the whole infield lifts by metres. */
    const hAtT = (d0, d1, t) => TrackSurface.heightAt(seg, d0, d1, t);
    const vCut = (r, loft, ed0, ed1) => {
      const [x, y] = TrackSurface.sampleEdge(loft, r.t);
      return [x, y, hAtT(ed0, ed1, r.t)];
    };
    const fallbackUv = (t0, t1, sL0, sL1, sR0, sR1) => ({
      u: [t0 * segLen / SURFACE_FALLBACK_TILE_M, t1 * segLen / SURFACE_FALLBACK_TILE_M,
          t1 * segLen / SURFACE_FALLBACK_TILE_M, t0 * segLen / SURFACE_FALLBACK_TILE_M],
      v: [sL0, sL1, sR1, sR0],
    });

    /* Ground surface — lofted per TRACTION BAND, the way the exe does it: each
       F_Section's band runs from its own left edge to the next F's left edge,
       and BOTH edges loft with the game's edge primitive (loftEdge, honoring
       each strip's Straighten byte), so band boundaries follow their true
       drifting curves. The previous X-column architecture could only paint a
       texture change along an X_Section column edge; any F edge that drifted
       across a column (pit-road blends, apron/grass transitions) had its
       boundary snapped to a different column edge on every segment — the
       pit-road sawtooth. (That architecture dated from when the arc branch of
       loftEdge was mis-evaluated and F-band lofting looked like a staircase.)
       Height still comes from the X_Section contour profile: bands subdivide
       laterally at every X node inside them, so profile kinks (banking breaks,
       berms) survive exactly. Adjacent bands share edge lofts bit-for-bit
       (same dlats, same flag), so the surface stays welded; across seams the
       quartic edges are continuous by construction. */
    if (strips.length && xsecs.length >= 2) {
      /* far-infield sentinel band (dlat ≈ ±1000) would loft a kilometre-wide
         plane — cap laterally; the cap is constant so it welds seam-to-seam */
      const TERRAIN_CAP_M = 300;
      const clampD = (d) => Math.max(-TERRAIN_CAP_M, Math.min(TERRAIN_CAP_M, d));
      const mixT = (a, b, t) => a + (b - a) * t;
      const firstX = xsecs[0], lastX = xsecs[xsecs.length - 1];
      for (let fi = 0; fi < strips.length; fi++) {
        const f = strips[fi], fN = strips[fi + 1];
        /* band lateral span: this F edge → next F edge. The last band runs out
           to the surface's outer contour edge; the first additionally covers
           any surface left of the first F edge. */
        let L0 = f.d0, L1 = f.d1;
        if (fi === 0) { L0 = Math.min(L0, firstX.d0); L1 = Math.min(L1, firstX.d1); }
        const R0 = fN ? fN.d0 : Math.max(lastX.d0, L0);
        const R1 = fN ? fN.d1 : Math.max(lastX.d1, L1);
        const cL0 = clampD(L0), cL1 = clampD(L1);
        const cR0 = clampD(R0), cR1 = clampD(R1);
        if (cR0 - cL0 < 0.02 && cR1 - cL1 < 0.02) continue;
        /* untextured strips are sentinel/filler bands — paint them with the
           nearest textured neighbour, tiled (they carry no TC quad of their own) */
        const painted = f.texture ? f
          : strips.slice(fi + 1).find((s) => s.texture)
          || [...strips.slice(0, fi)].reverse().find((s) => s.texture) || f;
        const bucket = bucketFor(painted.texture);
        const uvQuad = painted === f ? f.uv : null;
        const flag = f.straighten ? 1 : 0;
        /* lateral splits: band edges + every X profile node strictly inside */
        const edges = [{ d0: cL0, d1: cL1, flag }];
        for (const x of xsecs) {
          const xd0 = clampD(x.d0), xd1 = clampD(x.d1);
          if (xd0 > cL0 + 0.02 && xd0 < cR0 - 0.02 &&
              xd1 > cL1 + 0.02 && xd1 < cR1 - 0.02) edges.push({ d0: xd0, d1: xd1, flag });
        }
        edges.push({ d0: cR0, d1: cR1, flag: fN ? (fN.straighten ? 1 : 0) : flag });
        edges.sort((p, q) => p.d0 - q.d0);
        /* uv lateral fraction within the band, per end so drift stays square */
        const w0 = cR0 - cL0, w1 = cR1 - cL1;
        const sOf = (d, atEnd) => {
          const w = atEnd ? w1 : w0;
          return w > 1e-3 ? (d - (atEnd ? cL1 : cL0)) / w : 0;
        };
        for (let e = 0; e + 1 < edges.length; e++) {
          const eL = edges[e], eR = edges[e + 1];
          if (eR.d0 - eL.d0 < 0.02 && eR.d1 - eL.d1 < 0.02) continue;
          const loftL = TrackSurface.loftEdge(seg, eL.d0, eL.d1, eL.flag);
          const loftR = TrackSurface.loftEdge(seg, eR.d0, eR.d1, eR.flag);
          const sLs = sOf(eL.d0, false), sLe = sOf(eL.d1, true);
          const sRs = sOf(eR.d0, false), sRe = sOf(eR.d1, true);
          for (let r = 0; r + 1 < rings.length; r++) {
            const rA = rings[r], rB = rings[r + 1];
            const uvq = quadUv(uvQuad, rA.t, rB.t,
              mixT(sLs, sLe, rA.t), mixT(sLs, sLe, rB.t),
              mixT(sRs, sRe, rA.t), mixT(sRs, sRe, rB.t))
              || fallbackUv(rA.t, rB.t,
                mixT(sLs, sLe, rA.t), mixT(sLs, sLe, rB.t),
                mixT(sRs, sRe, rA.t), mixT(sRs, sRe, rB.t));
            emitQuad(bucket,
              vCut(rA, loftL, eL.d0, eL.d1), vCut(rB, loftL, eL.d0, eL.d1),
              vCut(rB, loftR, eR.d0, eR.d1), vCut(rA, loftR, eR.d0, eR.d1), uvq);
            stripQuads++;
          }
        }
      }
    }
    const SLOPE_PROBE_M = 0.5;
    for (const w of walls) {
      const bt0 = w.bt0 || 0, bt1 = w.bt1 || 0;
      const flag = w.straighten ? 1 : 0;
      /* banking slope at the wall line at the two segment ENDS (the game
         reads its bracketing profile stations; the probe pair yields the
         same slope) → per-end lean/rise applied to whole top edges */
      const slopeAt = (t) => Math.atan2(
        hAtT(w.d0 + SLOPE_PROBE_M, w.d1 + SLOPE_PROBE_M, t) -
        hAtT(w.d0 - SLOPE_PROBE_M, w.d1 - SLOPE_PROBE_M, t), 2 * SLOPE_PROBE_M);
      const thA = slopeAt(0), thB = slopeAt(1);
      const leanA = -Math.sin(thA) * w.h0, leanB = -Math.sin(thB) * w.h1;
      const riseA = Math.cos(thA) * w.h0, riseB = Math.cos(thB) * w.h1;
      /* Cross-section edges keyed by name. b=base(ground) t=top(leaned);
         −/+ = minus/plus lateral (d∓bt); o = a hair further out, for the
         overlay/backing slots 3/4 so their coincident faces don't z-fight
         the base sides. */
      const OVR = 0.02;
      const EDGES = {
        'b-':  { dA: w.d0 - bt0,       dB: w.d1 - bt1,       top: false },
        't-':  { dA: w.d0 - bt0,       dB: w.d1 - bt1,       top: true },
        'b+':  { dA: w.d0 + bt0,       dB: w.d1 + bt1,       top: false },
        't+':  { dA: w.d0 + bt0,       dB: w.d1 + bt1,       top: true },
        'b-o': { dA: w.d0 - bt0 - OVR, dB: w.d1 - bt1 - OVR, top: false },
        't-o': { dA: w.d0 - bt0 - OVR, dB: w.d1 - bt1 - OVR, top: true },
        'b+o': { dA: w.d0 + bt0 + OVR, dB: w.d1 + bt1 + OVR, top: false },
        't+o': { dA: w.d0 + bt0 + OVR, dB: w.d1 + bt1 + OVR, top: true },
      };
      const edgeCache = new Map();
      const edgeFor = (key) => {
        let e = edgeCache.get(key);
        if (!e) {
          const d = EDGES[key];
          const dA = d.dA + (d.top ? leanA : 0), dB = d.dB + (d.top ? leanB : 0);
          e = { loft: TrackSurface.loftEdge(seg, dA, dB, flag), dA, dB, top: d.top };
          edgeCache.set(key, e);
        }
        return e;
      };
      /* Face geometry is FIXED per stored slot index — proven by which
         textures the game authors into each slot fleet-wide (WALL-UV-DECOMP.md):
           slot 0 = front (minus) side      slot 2 = back (plus) side
           slot 1 = TOP cap, OR — on a fence — the back side (no cap): the
                    stored texture disambiguates (a *_top sheet is a cap; a
                    fence/plain sheet is the far side, which also restores the
                    back the old chain model dropped → fences were 1-sided)
           slots 3/4 = branded backing/overlay on the front/back side
         Each spec is [edgeP, edgeQ]; the quad (P@tA,P@tB,Q@tB,Q@tA) then has
         an OUTWARD (or up, for the cap) normal automatically. This replaces
         the present-slot chain, whose face shapes drifted with the slot set
         (softwall_side landing flat on top, branding on {0,2} going diagonal). */
      const faceSpec = (slot, texName) => {
        switch (slot) {
          case 0: return ['b-', 't-'];                                   /* front side */
          case 1: return /top/i.test(texName) ? ['t-', 't+']             /* TOP cap */
                                              : ['t+', 'b+'];            /* fence back */
          case 2: return ['t+', 'b+'];                                   /* back side */
          case 3: return ['b-o', 't-o'];                                 /* front overlay */
          case 4: return ['t+o', 'b+o'];                                 /* back overlay */
          default: return null;
        }
      };
      /* top-edge elevation rides the leaned lateral (game: one Hermite curve
         between the two leaned endpoints; rise blends with zero end slopes) */
      const edgePoint = (e, t) => {
        const [x, y] = TrackSurface.sampleEdge(e.loft, t);
        let z = hAtT(e.dA, e.dB, t);
        if (e.top) z += riseA + (riseB - riseA) * t * t * (3 - 2 * t);
        return [x, y, z];
      };
      /* span records: faces keyed by TRUE slot index within their span
         (tracksurface walks the 5-slot stream; legacy fallback keeps the
         old dense stream-order assumption) */
      const faces = w.faces && w.faces.length ? w.faces
        : [{ texture: w.texture, uv: w.uv, uv2: null, slot: 0, span: 0 }];
      const bySpan = [];
      for (const f of faces) {
        const s = f.slot | 0, g = f.span | 0;
        if (s >= 0 && s <= 4) (bySpan[g] || (bySpan[g] = []))[s] = f;
      }
      const nSpans = Math.max(bySpan.length, 1);
      /* split the t-ladder at this wall's span boundaries so no quad
         straddles a span seam (stored bounds rarely land on ring steps) */
      let wallRings = rings;
      if (nSpans > 1 && w.spanTs) {
        const ts = rings.map((r) => r.t);
        for (const t of w.spanTs) {
          if (t > 0 && t < 1 && !ts.some((x) => Math.abs(x - t) < 1e-6)) ts.push(t);
        }
        ts.sort((a, b) => a - b);
        wallRings = ts.map((t) => ({ t }));
      }
      for (let r = 0; r + 1 < wallRings.length; r++) {
        const rA = wallRings[r], rB = wallRings[r + 1];
        const mid = (rA.t + rB.t) / 2;
        let g, s0, sw;
        if (nSpans > 1 && w.spanTs) {
          g = 0;
          while (g + 1 < nSpans && mid >= w.spanTs[g + 1]) g++;
          s0 = w.spanTs[g];
          sw = ((g + 1 < nSpans ? w.spanTs[g + 1] : 1) - s0) || 1;
        } else {
          g = Math.min(nSpans - 1, Math.floor(mid * nSpans));
          s0 = g / nSpans;
          sw = 1 / nSpans;
        }
        const tA = (rA.t - s0) / sw, tB = (rB.t - s0) / sw;   /* uv t local to span */
        /* Fixed-slot faces (see faceSpec). Each present, textured slot emits
           ONE quad (P@tA,P@tB,Q@tB,Q@tA) → outward/up normal automatically;
           under the surface's backface culling a fence's opposite-facing
           front (slot 0) and back (slot 1) each show from their own side.
           UV: base texture samples set B when present (the emitter's stage-0
           channel reads TC arrays #17/#18), else set A; the stored quad
           carries its own orientation, so there are NO per-face flips. */
        const spanFaces = bySpan[g] || [];
        for (let slot = 0; slot <= 4; slot++) {
          const face = spanFaces[slot];
          if (!face || !face.texture) continue;
          const spec = faceSpec(slot, face.texture);
          if (!spec) continue;
          const P = edgeFor(spec[0]), Q = edgeFor(spec[1]);
          const set = face.uv2 || face.uv;
          const uvq = (set && quadUv(set, tA, tB, 0, 0, 1, 1)) ||
                      fallbackUv(tA, tB, 0, 0, 1, 1);
          emitQuad(bucketFor(face.texture),
            edgePoint(P, rA.t), edgePoint(P, rB.t),
            edgePoint(Q, rB.t), edgePoint(Q, rA.t), uvq);
          wallQuads++;
        }
      }
    }
  }

  for (const b of buckets.values()) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.pos), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(b.uv), 2));
    geo.setIndex(b.idx);
    /* cullBack: the game runs global backface culling on the generated
       surface. Ground bands wind up, wall ribbons wind outward via the
       chain rule, and fence front/back are coincident opposite-facing
       quads that REQUIRE culling to show each side's own quad without
       z-fighting. */
    const mesh = new THREE.Mesh(geo, materialFor(b.texture, false, true, true, false, false, 'track'));
    mesh.name = 'surface:' + (b.texture ? baseName(b.texture) : 'untextured');
    trackGroup.add(mesh);
  }
  return { strips: stripQuads, walls: wallQuads, materials: buckets.size };
}

/* ============================ OPEN FLAT WORLD ============================
   A wide-open, dead-flat, wall-less plane that reads as infinite. The AI field
   laps a big INVISIBLE loop (EndlessRoad.build with 0° bank + a huge drivable
   width, so the whole plane is level asphalt), while you roam it freely. Only a
   tarmac ground, a motion-reference grid and the sky are drawn — no ribbon,
   rails or banking. Everything else (physics, AI, field, cameras) is unchanged. */
function buildOpenWorldMesh() {
  clearTrackScenery();
  trackGroup = new THREE.Group();
  trackGroup.name = 'track';
  trackGroup.rotation.x = -Math.PI / 2;
  scene.add(trackGroup);
  setTrackViewMode(true);

  /* flat tarmac to the horizon (surface:* → receives the sun shadow, casts none) */
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(11000, 11000),
    new THREE.MeshLambertMaterial({ color: 0x3d3f44 }));
  ground.position.z = -0.02; ground.name = 'surface:openworld';
  trackGroup.add(ground);

  /* a faint grid so motion reads on the otherwise featureless plane (the 'grid'
     in the name keeps it out of the shadow pass) */
  const EXT = 5000, CELL = 50, gp = [];
  for (let v = -EXT; v <= EXT; v += CELL) { gp.push(v, -EXT, 0.01, v, EXT, 0.01, -EXT, v, 0.01, EXT, v, 0.01); }
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(gp), 3));
  const grid = new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0x4b4e54 }));
  grid.name = 'grid:openworld';
  trackGroup.add(grid);

}

/* Load the wide-open flat world: a level, wall-less loop the field roams, drawn
   as an open plane. You drive/roam anywhere on flat asphalt. Needs a car open. */
async function loadOpenWorld() {
  if (!mod || !mod.meshes || !modelGroup) { log('Open a car first, then load the open world.'); return; }
  if (typeof EndlessRoad === 'undefined') { log('World module missing.'); return; }
  if (Driving.active) Driving.exit(false);
  /* 0° bank, no walls, huge width → the whole plane is flat asphalt */
  const built = EndlessRoad.build({ radius: 700, lobe: 0.15, halfWidth: 1200,
    maxBankDeg: 0, noWalls: true, segments: 300, field: 40, cameras: 12 });
  track = {
    folderName: 'Open World', meta: built.meta, surface: built.surface,
    cameras: built.cameras, env: null, setup: null, refs: [], datItems: [], stall: null,
  };
  buildOpenWorldMesh();
  setSceneLighting(false);
  const sf = startFinishPlacement(built.surface);
  track.stall = sf ? { world: sf } : null;
  if (sf) placeCarAtStall(sf);
  bakeCarEnvMap();
  buildCarField();
  populateTrackCameras(built.cameras);
  $('viewer-model-name').textContent = 'Open flat world';
  $('viewer-empty').classList.add('hidden');
  $('viewer-panel').classList.remove('hidden');
  if (paintPreviewing) restoreCommittedPaint();
  Driving.start();
  Driving.setTvDirector();
  const camSel = $('vp-camera'); if (camSel) camSel.value = 'tv';
  log('Wide-open flat world — the AI field roams a big invisible loop. V spectates a driver, Ctrl+V returns to you; WASD drives you anywhere.');
}

/* Track surface decals (sponsor mats, the "500", start/finish art, seams…).
   Each decal is a tsd_ texture stamped in TRACK space (dlong along the centreline,
   dlat lateral); we map that to world on the banked surface and draw a quad lifted
   just above the ground, alpha-blended so the logo shows over the surface. */
const decalMatByTexture = new Map();
function decalMaterialFor(texture) {
  const key = texture ? baseName(texture) : '__none__';
  if (decalMatByTexture.has(key)) return decalMatByTexture.get(key);
  let material = null;
  const bytes = texture ? bytesForTexture(texture, 'track') : null;
  if (bytes) {
    try {
      const { canvas, hasAlpha, hardAlpha, mipChain } = canvasFromMip(bytes, { withMipChain: true });
      /* Same three-way alpha discipline as the surface/prop path (materialFor):
         - fully opaque (paint, pitstall, start/finish, drain — no alpha at all)
           → solid, writes depth;
         - binary mask (sponsor logos, seams — solid logo on clear ground)
           → alpha-TEST cutout, writes depth;
         both stay in the opaque pass so 467 overlapping mats depth-sort
         correctly and read crisp instead of blending into faint, popping,
         stacked-looking sprites. Only genuinely soft decals (grass-edge
         gradients) alpha-BLEND and skip depth writes. polygonOffset keeps
         every decal biased just above the banked surface. */
      const blend = hasAlpha && !hardAlpha;
      const map = makeTexture(canvas);
      map.wrapS = THREE.RepeatWrapping;   /* u/v maxima >1 tile repeating strips */
      map.wrapT = THREE.RepeatWrapping;
      if (mipChain) {           /* game-authored mips: binary alpha at every level */
        map.mipmaps = mipChain;
        map.generateMipmaps = false;
      }
      material = new THREE.MeshBasicMaterial({
        map,
        transparent: blend,
        alphaTest: hardAlpha ? 0.5 : 0,
        depthWrite: !blend,
        side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      });
    } catch (err) { console.error('decal texture ' + texture, err); }
  }
  decalMatByTexture.set(key, material);
  return material;
}

const DECAL_LIFT_M = 0.05;   /* raise decals just clear of the surface */
function buildTrackDecals(surface, decals) {
  if (!trackGroup || !decals || !decals.length) return { decals: 0 };
  const segs = surface.segments;
  const n = segs.length;
  if (!n) return { decals: 0 };
  /* per-segment centreline arc length + cumulative — dlong is measured along the
     block centreline from segment 0 (sampleCenter is uniform in u per segment, so
     arc length is linear in u, making dlong→u exact within a segment) */
  const segLen = new Array(n), cum = new Array(n + 1);
  cum[0] = 0;
  const STEPS = 16;
  for (let k = 0; k < n; k++) {
    let len = 0, px = 0, py = 0;
    for (let i = 0; i <= STEPS; i++) {
      const c = TrackSurface.sampleCenter(segs[k], i / STEPS);
      if (i > 0) len += Math.hypot(c.x - px, c.y - py);
      px = c.x; py = c.y;
    }
    segLen[k] = len; cum[k + 1] = cum[k] + len;
  }
  const total = cum[n];
  if (total <= 0) return { decals: 0 };

  /* map a TRACK-space point (dlong along the centreline, dlat lateral) to its
     world position ON the banked surface: the corner's own dlat drives both the
     horizontal offset AND the profile height, so a mat DRAPES onto the bank
     instead of floating as one flat card (that flat-card projection is what made
     wide mats on Daytona's 31° banking read as squished/foreshortened). */
  const worldAt = (dlong, dlat) => {
    let dl = dlong % total; if (dl < 0) dl += total;
    let k = 0; while (k < n - 1 && cum[k + 1] <= dl) k++;
    const u = segLen[k] > 1e-6 ? (dl - cum[k]) / segLen[k] : 0;
    const c = TrackSurface.sampleCenter(segs[k], u);
    const tl = Math.hypot(c.tx, c.ty) || 1;
    const nx = -c.ty / tl, ny = c.tx / tl;   /* left normal */
    const z = TrackSurface.heightAt(segs[k], dlat, dlat, u) + DECAL_LIFT_M;
    return [c.x + dlat * nx, c.y + dlat * ny, z];
  };
  const byTex = new Map();
  let placed = 0;
  for (const d of decals) {
    const hl = d.len / 2, hw = d.wid / 2;
    const [cx, cy] = worldAt(d.dlong, d.dlat);
    const cr = Math.cos(d.rot), sr = Math.sin(d.rot);
    /* local track frame at the center, used only to look up each corner's
       surface height (the game samples height at the corner's world x,y) */
    const { k: ck, u: cu } = (() => {
      let dl = d.dlong % total; if (dl < 0) dl += total;
      let k = 0; while (k < n - 1 && cum[k + 1] <= dl) k++;
      return { k, u: segLen[k] > 1e-6 ? (dl - cum[k]) / segLen[k] : 0 };
    })();
    const ct = TrackSurface.sampleCenter(segs[ck], cu);
    const tl = Math.hypot(ct.tx, ct.ty) || 1;
    const tx = ct.tx / tl, ty = ct.ty / tl;          /* tangent */
    const nx = -ty, ny = tx;                          /* left (+dlat) normal */
    const corner = (sx, sy) => {
      const px = sx * hl, py = sy * hw;   /* local X = length, local Y = width */
      const wx = cx + px * cr - py * sr;
      const wy = cy + px * sr + py * cr;
      /* project the world offset back onto the local track frame to sample
         the banked surface height at (approximately) this corner */
      const ox = wx - cx, oy = wy - cy;
      const dLat = d.dlat + ox * nx + oy * ny;
      const dLong = d.dlong + ox * tx + oy * ty;
      let dl = dLong % total; if (dl < 0) dl += total;
      let k = 0; while (k < n - 1 && cum[k + 1] <= dl) k++;
      const u = segLen[k] > 1e-6 ? (dl - cum[k]) / segLen[k] : 0;
      const z = TrackSurface.heightAt(segs[k], dLat, dLat, u) + DECAL_LIFT_M;
      return [wx, wy, z];
    };
    const p0 = corner(-1, -1), p1 = corner(1, -1), p2 = corner(1, 1), p3 = corner(-1, 1);
    let b = byTex.get(baseName(d.texture));
    if (!b) { b = { texture: d.texture, pos: [], uv: [], idx: [] }; byTex.set(baseName(d.texture), b); }
    const base = b.pos.length / 3;
    b.pos.push(...p0, ...p1, ...p2, ...p3);
    const uq = d.uq || [0, 1, 1, 0], vq = d.vq || [1, 1, 0, 0];
    b.uv.push(uq[0], vq[0], uq[1], vq[1], uq[2], vq[2], uq[3], vq[3]);
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    placed++;
  }
  for (const b of byTex.values()) {
    const mat = decalMaterialFor(b.texture);
    if (!mat) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.pos), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(b.uv), 2));
    geo.setIndex(b.idx);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'decal:' + baseName(b.texture);
    mesh.renderOrder = 3;
    trackGroup.add(mesh);
  }
  return { decals: placed };
}

function placeCarAtStall(world) {
  if (!modelGroup || !world || !trackGroup) return;
  /* trackGroup owns the Z-up→Y-up turn; car instances use Papyrus coords like
     every other TSO, so clear the showroom Rx(-90°) while parented here. */
  if (modelGroup.parent !== trackGroup) {
    if (modelGroup.parent) modelGroup.parent.remove(modelGroup);
    trackGroup.add(modelGroup);
  }
  modelGroup.visible = true;
  modelGroup.traverse((o) => {
    if (o.isMesh && o.userData.isRoadWheel) {
      o.matrixAutoUpdate = true;
      o.updateMatrix();
    }
  });
  /* Project the tyre-plane anchor EXACTLY as placeCar does — the model
     origin belongs at anchor − R·[xMid,0,floorZ] (Physics.renderAnchorOffset),
     not pinned to the raw anchor. Pure yaw here, so R only swings the xMid
     arm into the heading (z is unchanged: off[2] === floorZ). Pinning x/y
     left the origin xMid (~12 cm) forward of the physics anchor, so the car
     POPPED sideways the instant driving armed and the first placeCar frame
     re-projected it. */
  const floor = (mod && typeof mod.floorZ === 'number') ? mod.floorZ : 0;
  const xMid = (mod && mod.carDims && Number.isFinite(mod.carDims.xMid)) ? mod.carDims.xMid : 0;
  const h = world.heading || 0;
  const off = Physics.renderAnchorOffset([Math.cos(h / 2), 0, 0, Math.sin(h / 2)], xMid, floor);
  modelGroup.position.set(world.x - off[0], world.y - off[1], world.z - off[2]);
  modelGroup.rotation.set(0, 0, h, 'XYZ');
}

function restoreShowroomCar() {
  if (!modelGroup) return;
  if (modelGroup.parent && modelGroup.parent !== scene) modelGroup.parent.remove(modelGroup);
  modelGroup.position.set(0, 0, 0);
  modelGroup.rotation.set(-Math.PI / 2, 0, 0);
  scene.add(modelGroup);
}

/* "Showroom" in the track dropdown: unload the track and put the car back on
   the grid. No-op without a track; with no car it leaves the empty scene. */
function closeTrack() {
  if (!track) return;
  if (Driving.active) Driving.exit(false);   /* stop driving before the track is torn down */
  clearTrackScenery();
  disposeFieldPaintPlan();   /* cached field paint textures die with the track */
  track = null;
  populateGarageUI();        /* hides the Garage panel with the track gone */
  setTrackViewMode(false);
  restoreCarCameras();
  if (mod && mod.meshes && modelGroup) {
    restoreShowroomCar();
    setRideHeight(parseFloat($('vp-ride').value) || 0);   /* re-anchor the grid */
    let ntris = 0;
    for (const m of mod.meshes) ntris += m.tris.length / 3;
    $('viewer-model-name').textContent = `${mod.modelName} - ${mod.meshes.length} parts, ${ntris} tris`;
    if ($('vp-info')) {
      $('vp-info').textContent = mod.datName
        ? `${mod.folderName} - ${mod.datName}, ${mod.carFiles.length} car paint(s)`
        : `${mod.folderName} - loose files`;
    }
    frameModel();
  } else {
    $('viewer-model-name').textContent = '';
    if ($('vp-info')) $('vp-info').textContent = '';
    $('viewer-empty').classList.remove('hidden');
    const camSel = $('vp-camera');
    if (camSel) camSel.classList.add('hidden');
  }
  log('Track closed - showroom.');
}

function frameTrackCar() {
  if (!trackGroup && !modelGroup) return;

  /* Whole-circuit bounds from the drivable surface (not the scenery bbox — stray
     prop clusters parked hundreds of metres out blow up the bounds). Used for the
     far plane so the full track still renders once the user zooms out. */
  let trackBox = null;
  if (trackGroup) {
    for (const child of trackGroup.children) {
      if (!child.name || !child.name.startsWith('surface:')) continue;
      const b = new THREE.Box3().setFromObject(child);
      trackBox = trackBox ? trackBox.union(b) : b;
    }
  }
  if (!trackBox || trackBox.isEmpty()) trackBox = new THREE.Box3().setFromObject(trackGroup || modelGroup);
  const trackSize = trackBox.getSize(new THREE.Vector3());
  const trackSpan = Math.max(trackSize.x, trackSize.y, trackSize.z, 8);
  configureTrackControls(trackSpan);
  const camSel = $('vp-camera');
  if (camSel) {
    camSel.classList.remove('hidden');
    if ([...camSel.options].some(o => o.value === 'trackview')) camSel.value = 'trackview';
    camSel.title = 'Drag to orbit, right-drag or arrow keys to pan, scroll to zoom';
  }


  /* Land next to the car on the start/finish line, not way out over the whole
     oval — a circuit-wide aerial drops you hundreds of metres away, which isn't
     usable. Pick the subject to look at, best first:
       1. the car actually parked on THIS track (parented to the live trackGroup),
       2. the start/finish line itself — always on the visible surface, exactly
          where the car sits, so it's right even with no car loaded (or a stale
          one that never got re-parented, which just showed empty sky),
       3. the whole-track centre as a last-ditch aerial. */
  let center = null, dist = trackSpan * 1.15;
  const carOnTrack = mod && mod.meshes && modelGroup && modelGroup.parent === trackGroup;
  if (carOnTrack) {
    modelGroup.updateWorldMatrix(true, true);
    const carBox = new THREE.Box3().setFromObject(modelGroup);
    center = carBox.getCenter(new THREE.Vector3());
    dist = (carBox.getSize(new THREE.Vector3()).length() || 5) * 3.5;   /* clears the pit wall */
  } else if (trackGroup && track && track.stall && track.stall.world) {
    trackGroup.updateWorldMatrix(true, true);
    const w = track.stall.world;
    center = trackGroup.localToWorld(new THREE.Vector3(w.x, w.y, w.z));
    dist = 22;   /* a car-length-scale view of the start/finish line */
  } else {
    center = trackBox.getCenter(new THREE.Vector3());
  }

  controls.target.copy(center);
  camera.position.set(center.x + dist * 0.6, center.y + dist * 0.5, center.z + dist * 0.6);
  camera.fov = 50;
  camera.near = 0.5;
  camera.far = Math.max(8000, trackSpan * 8);
  camera.updateProjectionMatrix();
  controls.update();
}

async function openTrackFolder(files, folderName) {
  $('vp-log').textContent = '';
  try {
      const usable = files.filter(f => !isJunk(f.name));
    if (!Track.isTrackFolder(usable)) {
      throw new Error('That folder does not look like a valid track package (need track.ini plus a .ptf, .dat or .lp).');
    }
    if (typeof WindTunnel !== 'undefined' && WindTunnel.active) WindTunnel.exit();

    const iniFile = usable.find(f => baseName(f.name) === 'track.ini');
    const iniText = await iniFile.text();
    const meta = Track.parseStalls(iniText);
    /* physics environment (grip scales, air density, default gearing) — the
       car is shaped by THIS track's .ini, not one global tune */
    const env = Track.parseEnv(iniText);
    if (env && env.windMph > 0.5) {
      log(`Track weather: wind ${env.windMph.toFixed(0)} mph from ${Math.round(env.windFromDeg)}° ` +
          `- the aero runs on air-relative speed, so you'll feel it head-on, tail-on and broadside.`);
    }

    /* Loose 3do/mip/ptf files in the track ROOT override the same-named
       entries inside the .dat, and let a track load with no .dat at all —
       how the game reads a track. Nested extras (SD Pack/) are collected but
       flagged non-root, so they only ever fill gaps, never override. */
    const looseFiles = [];
    for (const f of usable) {
      if (/\.(3do|mip|ptf)$/i.test(f.name)) {
        looseFiles.push({
          name: f.webkitRelativePath || f._relPath || f.name,
          data: new Uint8Array(await f.arrayBuffer()),
          root: isRootLoose(f),
        });
      }
    }

    let datName = null, datEntries = [];
    const dats = usable.filter(f => /\.dat$/i.test(f.name));
    if (dats.length) {
      const datFile = dats.reduce((a, b) => (b.size > a.size ? b : a));
      datName = datFile.name;
      log(`Reading ${datFile.name}…`);
      datEntries = Dat.parse(new Uint8Array(await datFile.arrayBuffer())).entries;
    }

    const pool = mergePool(datEntries, looseFiles);
    if (!pool.length) throw new Error('That track folder has no .dat archive and no loose .3do/.mip/.ptf files.');

    const ptfItem = pool.find(e => /\.ptf$/i.test(e.name));
    if (!ptfItem) throw new Error('No .ptf track layout found' +
      (datName ? ` inside ${datName} or loose in the folder.` : ' in that folder.'));
    log(`Parsing track layout (${(ptfItem.data.length / 1024 / 1024).toFixed(1)} MB)…`);
    const refs = Track.parseTsoRefs(ptfItem.data);
    if (!refs.length) throw new Error('No placed objects found in the track .ptf.');

    /* the track's TV cameras live in a sibling <track>.cam (not in the .dat) */
    let cameras = [];
    const camFile = usable.find(f => /\.cam$/i.test(f.name));
    if (camFile) {
      try { cameras = TrackCam.parse(new Uint8Array(await camFile.arrayBuffer())).cameras; }
      catch (err) { console.error('track cam', err); }
    }

    /* the track's garage setups (.sim, loose next to the .dat) — every one is
       parsed for the Garage panel; the game's "fast" baseline is the spawn
       default (track-correct steering ratio / gearing / brake bias / aero) */
    let setup = null;
    let setups = [];
    if (typeof SimSetup !== 'undefined') {
      for (const sf of usable.filter(f => /\.sim$/i.test(f.name))) {
        try {
          const s = SimSetup.parse(new Uint8Array(await sf.arrayBuffer()));
          if (s) {
            s.fileName = baseName(sf.name);
            s.name = s.name || s.fileName;
            setups.push(s);
          }
        } catch (err) { console.error('setup ' + sf.name, err); }
      }
      setups = SimSetup.sortSetups(setups);
      const simPick = SimSetup.pickName(setups.map(s => s.fileName));
      setup = setups.find(s => s.fileName === simPick) || setups[0] || null;
      if (setups.length) log(`Garage: ${setups.length} setup${setups.length === 1 ? '' : 's'} in the track folder.`);
    }

    /* Mods encode time-of-day in the track name (BBMC "Night"/"Day"); no
       track.ini field carries it. Night → night texture variants + tower lights. */
    const isNight = /night/i.test(folderName) || /night/i.test(meta.name || '');

    track = {
      folderName, name: meta.name, datItems: datEntries, looseFiles,
      refs, meta, stall: null, cameras, surface: null, isNight, setup, setups, env,
    };
    if (env) {
      log(`Track env: grip ${env.asphaltGrip.toFixed(2)} · air ${env.airDensity.toFixed(3)} kg/m³` +
        (env.altitudeFt ? ` (${env.altitudeFt.toFixed(0)} ft)` : '') +
        ` · ${env.baseTempF.toFixed(0)}°F` +
        (env.defaultFinalDrive ? ` · default gear ${env.defaultFinalDrive.toFixed(2)}` : ''));
    }
    populateGarageUI();

    resetTrackTextureCache();   /* drop the previous track's sheets so this one builds fresh */
    setTrackViewMode(true);
    log(`Placing ${refs.length} track objects… (${isNight ? 'night' : 'day'})`);
    const stats = buildTrackScenery(refs, pool, isNight);
    setSceneLighting(isNight);
    log(`Track scenery: ${stats.placed} instances (${stats.unique} models)` +
      (stats.sky ? `, sky ${stats.sky} part${stats.sky === 1 ? '' : 's'}` : '') +
      (stats.horizon ? `, horizon ${stats.horizon} parts` : '') +
      (stats.towerLights ? `, ${stats.towerLights} tower lights` : '') +
      (stats.skipped || stats.failed ? `, ${stats.skipped} skipped, ${stats.failed} failed` : '') + '.');

    /* the drivable surface, terrain and walls are generated from the .ptf
       segment data — the game builds them at load time, they are not 3dos */
    try {
      log('Building track surface…');
      const surface = TrackSurface.extract(ptfItem.data);
      track.surface = surface;
      if (surface.segments.length) {
        const sstats = buildTrackSurface(surface);
        log(`Track surface: ${surface.segments.length} segments, ` +
          `${sstats.strips} ground quads, ${sstats.walls} wall quads` +
          (surface.skippedSegments ? `, ${surface.skippedSegments} segments skipped` : '') + '.');
        try {
          const decals = Track.parseDecals(ptfItem.data);
          const dstats = buildTrackDecals(surface, decals);
          if (dstats.decals) log(`Track decals: ${dstats.decals} surface graphics placed.`);
        } catch (err) {
          console.error('track decals', err);
          log('Track decals failed (' + err.message + ') - surface graphics skipped.');
        }
      } else {
        log('Track surface: no usable segment geometry found - showing scenery objects only.');
      }
    } catch (err) {
      console.error('track surface', err);
      log('Track surface failed (' + err.message + ') - showing scenery objects only.');
    }

    /* wire the track's own TV cameras into the camera dropdown (needs the surface
       for aiming). Falls back silently to Free camera when the track has no .cam. */
    if (track.cameras && track.cameras.length) {
      populateTrackCameras(track.cameras);
      log(`Track cameras: ${track.cameras.length} TV cameras loaded from ${camFile.name}.`);
    } else {
      populateTrackCameras([]);
      log(camFile ? 'Track cameras: none found in the .cam file.'
                  : 'Track cameras: no .cam file next to the .dat.');
    }

    /* Load the car on the start/finish line (dlong 0 on the racing surface).
       Fall back to a pit stall only if the surface didn't decode. */
    const sf = startFinishPlacement(track.surface);
    let pick, placeLabel;
    if (sf) {
      pick = { world: sf }; placeLabel = 'start/finish line';
    } else {
      const rs = Track.randomStall(meta, refs);
      if (rs) { pick = rs; placeLabel = `${rs.lane} stall ${rs.stall.index}`; }
    }
    track.stall = pick;
    if (mod && mod.meshes && modelGroup) {
      if (pick) {
        placeCarAtStall(pick.world);
        log(`Parked car on the ${placeLabel}.`);
      } else {
        log('No track surface or pit stalls - car left at origin.');
      }
      bakeCarEnvMap();         /* one shared reflection probe for this track */
      buildCarField();
      applyWingVisibility();   /* field rebuilt — keep the wing toggle honored */
      if (paintPreviewing) restoreCommittedPaint();
      Driving.start();         /* physics + WASD live from the start/finish spawn */
    } else {
      log('No car mod open - open a car first to place it on the track.');
    }

    $('viewer-model-name').textContent = meta.name;   /* track name only (dropped the "- start/finish line" tag) */
    $('viewer-empty').classList.add('hidden');
    $('viewer-panel').classList.remove('hidden');
    if ($('vp-info')) {
      $('vp-info').textContent = `${folderName} - ${meta.name}, ${refs.length} objects` +
        (mod ? `, car from ${mod.folderName}` : '');
    }
    frameTrackCar();
  } catch (err) {
    console.error(err);
    log('ERROR: ' + err.message);
    alert(err.message);
  }
}

async function openFolder(files, folderName, opts = {}) {
  $('vp-log').textContent = '';
  try {
    const usable = files.filter(f => !isJunk(f.name));
    if (Track.isTrackFolder(usable)) {
      await openTrackFolder(usable, folderName);
      return;
    }

    if (track && opts.keepTrack) {
      /* hot-swap the car on the loaded track: drop texture-cache entries so
         the new mod's same-named sheets (card.mip, glass.mip, …) don't reuse
         the old car's materials. Track meshes keep their own material refs —
         nothing is disposed, buildModel re-parks the car at the stall. */
      materialByTexture.clear();
      alphaDataByTexture.clear();
    } else if (track) {
      /* leaving track view for a showroom mod */
      clearTrackScenery();
      track = null;
      populateGarageUI();
      setTrackViewMode(false);
      restoreCarCameras();
      restoreShowroomCar();
    }

    const dats = usable.filter(f => /\.dat$/i.test(f.name));
    const cars = usable.filter(f => /\.car$/i.test(f.name));

    mod = {
      folderName, datName: null, datHeader: null, datItems: null,
      looseFiles: [], carFiles: [], modelName: null, modelItem: null,
      carMakeIdx: 0, activePaintCar: null, meshes: null,
      bodyTexture: null, dirty: false,
    };
    for (const f of usable) {
      if (/\.(3do|mip|stp|cam)$/i.test(f.name)) {
        mod.looseFiles.push({
          name: f.webkitRelativePath || f._relPath || f.name,
          data: new Uint8Array(await f.arrayBuffer()),
          root: isRootLoose(f),   /* subfolder files (aero-variant 3dos) fill gaps only */
        });
      }
    }
    for (const f of cars) {
      mod.carFiles.push({ name: baseName(f.name), data: new Uint8Array(await f.arrayBuffer()) });
    }
    if (dats.length) {
      const datFile = dats.reduce((a, b) => (b.size > a.size ? b : a));
      mod.datName = datFile.name;
      const parsed = Dat.parse(new Uint8Array(await datFile.arrayBuffer()));
      mod.datHeader = parsed.header;
      mod.datItems = parsed.entries;
      log(`Opened ${datFile.name}: ${parsed.entries.length} files.`);
    }
    const pool = mergePool(mod.datItems, mod.looseFiles);
    const main = pickMainModel(pool);
    if (!main) throw new Error('No .3do model found in that folder.');
    loadModelItem(main);
    populatePanel();
  } catch (err) {
    console.error(err);
    log('ERROR: ' + err.message);
    alert(err.message);
  }
}

function loadModelItem(item, opts = {}) {
  const parsed = ThreeDO.parse(item.data);
  const makeIdx = opts.carMakeIdx != null ? opts.carMakeIdx : (mod?.carMakeIdx ?? 0);
  /* body uv channel: .car paints and per-make card_*.mip default paints use
     the primary (paint-layout) channel; only a legacy card.mip template uses
     the alternate template channel. Driver suit parts differ between the two. */
  const keepingPaint = (opts.clearPaint === false || opts.reapplyPaint === true) && !!mod.activePaintCar;
  const templateCard = templateCardName(makeIdx);
  const paintedBody = opts.paintedBody != null ? opts.paintedBody : (keepingPaint || !!templateCard);
  mod.textureOverrides = new Map();
  if (templateCard) mod.textureOverrides.set('card.mip', templateCard);
  let meshes = ThreeDO.extractMeshes(parsed, { carMakeIdx: makeIdx, paintedBody, flapParts: true });
  if (!meshes.length) throw new Error(baseName(item.name) + ' has no renderable geometry.');
  mod.modelName = baseName(item.name);

  /* Some mods (FCRD NextGen) ship the driver rig un-posed — the sim seats it
     at runtime via animation we can't replay. Hide driver parts that end up
     hanging below the car's floor. */
  const zMin = (m) => {
    let lo = Infinity;
    for (let i = 0; i < m.count; i++) if (m.verts[i * 3 + 2] < lo) lo = m.verts[i * 3 + 2];
    return lo;
  };
  const floor = Math.min(...meshes.filter(m => !m.isDriver).map(zMin));
  const wheelCandidates = meshes.filter(m => isRoadWheelPath(m.path));
  const isGroundWheel = (m) => zMin(m) <= floor + 0.18;
  const wheelMeshes = wheelCandidates.filter(isGroundWheel);
  if (mod) {
    mod.groundWheelPaths = new Set(wheelMeshes.map(m => m.path));
    mod.floorZ = wheelMeshes.length ? Math.min(...wheelMeshes.map(zMin)) : floor;
    mod.bodyFloorZ = floor;      /* lowest body-only point (splitter/valance) */
    /* real tyre tread width, per mod: model +Y is the axle, so a road-wheel's
       Y-extent IS its tread width (units ≈ metres here). Median of the 4 wheels
       shrugs off a stray hub/rotor mesh. Feeds TireFX so skid + dirt marks are
       laid exactly as wide as the tyre that made them, whatever the mod. */
    const treadSpans = [];
    for (const m of wheelMeshes) {
      let loY = Infinity, hiY = -Infinity;
      for (let i = 0; i < m.count; i++) {
        const y = m.verts[i * 3 + 1];
        if (y < loY) loY = y;
        if (y > hiY) hiY = y;
      }
      if (hiY > loY) treadSpans.push(hiY - loY);
    }
    if (treadSpans.length) {
      treadSpans.sort((a, b) => a - b);
      mod.tireWidthM = treadSpans[treadSpans.length >> 1];   /* median span */
    } else {
      mod.tireWidthM = null;
    }
    /* measured car dimensions — drive the per-model physics body shape, the
       NR-style runtime stance and the hitbox overlay (model origins/sizes
       vary by mod; nothing may assume the idealised Cup box) */
    mod.carDims = null;
    mod.carHullPts = null;
    const groundWheelSet = new Set(wheelMeshes);
    const bodyMeshes = meshes.filter(m => !m.isDriver && !groundWheelSet.has(m));
    if (wheelMeshes.length >= 4 && bodyMeshes.length) {
      let minX = Infinity, maxX = -Infinity, maxAbsY = 0, minZ = Infinity, maxZ = -Infinity;
      for (const m of bodyMeshes) {
        for (let i = 0; i < m.count; i++) {
          const x = m.verts[i * 3], y = m.verts[i * 3 + 1], z = m.verts[i * 3 + 2];
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          const ay = Math.abs(y);
          if (ay > maxAbsY) maxAbsY = ay;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
      }
      const ctrX = (m) => {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < m.count; i++) {
          const x = m.verts[i * 3];
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
        return (lo + hi) / 2;
      };
      const fx = wheelMeshes.filter(m => /^[lr]f/i.test(m.path)).map(ctrX);
      const rx = wheelMeshes.filter(m => /^[lr]r/i.test(m.path)).map(ctrX);
      if (fx.length && rx.length) {
        const axleFX = fx.reduce((a, b) => a + b, 0) / fx.length;
        const axleRX = rx.reduce((a, b) => a + b, 0) / rx.length;
        if ([minX, maxX, maxAbsY, minZ, maxZ, axleFX, axleRX].every(Number.isFinite)
            && axleFX - axleRX > 1.5) {
          mod.carDims = {
            bodyMinX: minX, bodyMaxX: maxX, bodyHalfW: maxAbsY,
            bodyMinZ: minZ, bodyMaxZ: maxZ,
            axleFX, axleRX, xMid: (axleFX + axleRX) / 2,
          };
          /* mesh-accurate hitbox cloud (Physics.meshSupportPoints: fibonacci
             global extremes + per-height profile slices) — z reference is
             bodyFloorZ, the SAME reference applyDefaultRideHeight lifts the
             rendered body with, so cloud == rendered sheet metal */
          mod.carHullPts = Physics.meshSupportPoints(bodyMeshes, {
            bodyFloorZ: floor, xMid: mod.carDims.xMid, floorM: RIDE_SPLITTER_M,
          });
        }
      }
    }
  }
  const DANGLE_TOLERANCE = 0.05;
  meshes = meshes.filter(m => !(m.isDriver && zMin(m) < floor - DANGLE_TOLERANCE));
  /* backfire quads are exhaust-flame animation frames the sim flickers while
     racing — a parked showroom car shouldn't show them */
  meshes = meshes.filter(m => !(m.texture && baseName(m.texture) === 'backfire.mip'));

  if (mod) {
    const pool = mergePool(mod.datItems, mod.looseFiles);
    mod.carCam = resolveCarCam(pool, mod.modelName);
    if (mod.carCam) {
      const n = mod.carCam.mode10;
      log(`Car camera: MACC Nose offset (${n.pos.map(x => x.toFixed(2)).join(', ')}), FOV ${n.fov.toFixed(0)}°.`);
    } else {
      log('Car camera: no .cam file - Nose cam unavailable for this car.');
    }
    Driving.recacheMounts();
    Driving.refreshCarShape();
    populateCarCameraMenu();
  }
  mod.modelItem = item;
  mod.carMakeIdx = makeIdx;
  mod.meshesPaintedBody = paintedBody;
  if (opts.clearPaint !== false && opts.reapplyPaint !== true && opts.preview !== true) mod.activePaintCar = null;
  mod.meshes = meshes;
  /* body texture: the paintable sheet is card.mip by Papyrus convention;
     fall back to the biggest textured part. .car paints target it. */
  let bestTris = -1;
  for (const m of meshes) {
    if (m.texture && m.tris.length > bestTris) { bestTris = m.tris.length; mod.bodyTexture = m.texture; }
  }
  const card = meshes.find(m => m.texture && baseName(m.texture) === 'card.mip');
  if (card) mod.bodyTexture = card.texture;
  buildModel(meshes, opts);
  let ntris = 0;
  for (const m of meshes) ntris += m.tris.length / 3;
  $('viewer-model-name').textContent = `${mod.modelName} - ${meshes.length} parts, ${ntris} tris`;
  $('viewer-empty').classList.add('hidden');
  $('viewer-panel').classList.remove('hidden');
  log(`Loaded ${mod.modelName}: ${meshes.length} parts, ${ntris} tris.` +
    (makeIdx ? ` (make ${makeIdx})` : ''));
  refreshAssetLists();   /* make switches swap the part set — keep the panel honest */
  populateWingDropdown();   /* refresh the aero variant list for this body */
  if (opts.reapplyPaint && mod.activePaintCar) applyCarPaint(mod.activePaintCar, { skipMake: true });
  applyFlapEnable();
}

/* ---------- edit actions ---------- */
/* cache keys are `<source>:<texture>` plus optional `|glass`/`|cull` suffixes —
   one texture can back several material variants, so edits must hit them all.
   Paint edits only ever target CAR materials, which carry the 'm:' prefix. */
function materialsForTexture(texName) {
  const base = 'm:' + baseName(texName || '');
  const out = [];
  for (const [key, mat] of materialByTexture) {
    if (key === base || key.startsWith(base + '|')) out.push(mat);
  }
  return out;
}

function setBodyCanvas(canvas, label) {
  const tex = makeTexture(canvas);
  const painted = new Set();
  const paintMat = (mat) => {
    if (!mat || painted.has(mat)) return;
    painted.add(mat);
    if (mat.map) mat.map.dispose();
    mat.map = tex;
    mat.color.set(0xffffff);
    mat.needsUpdate = true;
  };
  for (const mat of materialsForTexture(mod.bodyTexture)) paintMat(mat);
  /* roof/hood flaps use the opaque |flap material fork on the body sheet */
  if (mod.meshes) {
    for (const m of mod.meshes) {
      if (!(m.isFlapPart || m.flapMorph) || !m.texture) continue;
      for (const mat of materialsForTexture(m.texture)) paintMat(mat);
    }
  }
  if (!painted.size) { log('No body texture material to paint.'); return; }
  log('Skinned body with ' + label + ' (view only - use texture Replace to bake into the .dat).');
}

function restoreCommittedPaint() {
  if (!mod) return;
  paintPreviewing = false;
  const committed = paintCommitted;
  if (committed) {
    applyCarPaint(committed, { commit: true, skipMake: true });
    return;
  }
  mod.activePaintCar = null;
  const item = mod.modelItem || (mod.datItems || mod.looseFiles ? pickMainModel(mergePool(mod.datItems, mod.looseFiles)) : null);
  if (item) loadModelItem(item, { carMakeIdx: 0, keepPose: true, clearPaint: true, preview: true });
  syncPaintListSelection();
}

function previewCarPaint(carName) {
  paintPreviewing = true;
  applyCarPaint(carName, { preview: true });
}

function previewTemplatePaint() {
  paintPreviewing = true;
  if (!mod) return;
  const item = mod.modelItem || pickMainModel(mergePool(mod.datItems, mod.looseFiles));
  if (!item) return;
  loadModelItem(item, { carMakeIdx: 0, keepPose: true, clearPaint: true, preview: true });
}

function syncPaintListSelection() {
  const root = $('vp-car-paints');
  if (!root) return;
  const committed = paintCommitted || '';
  root.querySelectorAll('.vp-paint-row').forEach((row) => {
    row.classList.toggle('selected', (row.dataset.car || '') === committed);
  });
  const sel = $('vp-car-select');
  if (sel) sel.value = committed;
}

function applyCarPaint(carName, opts = {}) {
  const commit = opts.preview !== true;
  const car = mod.carFiles.find(c => c.name === carName);
  if (!car) return;
  try {
    const makeIdx = opts.skipMake ? mod.carMakeIdx : Frac.carMake(car.data);
    const needsRebuild = makeIdx !== mod.carMakeIdx || mod.meshesPaintedBody !== true;
    if (!opts.skipMake && needsRebuild && mod.modelItem) {
      mod.carMakeIdx = makeIdx;
      loadModelItem(mod.modelItem, { carMakeIdx: makeIdx, clearPaint: false, reapplyPaint: false, paintedBody: true, keepPose: true, preview: !commit });
    }
    const { chunks } = Frac.parse(car.data);
    const xetc = chunks.find(c => c.tag === 'XETC');
    if (!xetc) throw new Error('no paint (XETC) section in ' + carName);
    setBodyCanvas(canvasFromMip(xetc.data).canvas, carName);
    if (commit) {
      mod.activePaintCar = carName;
      paintCommitted = carName;
      syncPaintListSelection();
    }
    if (commit && !opts.skipMake && makeIdx !== 0) log(`Using make ${makeIdx} body panels for ${carName}.`);
  } catch (err) {
    console.error(err);
    log('ERROR: ' + err.message);
  }
}

async function replaceTexture(texName, file) {
  try {
    const idx = mod.datItems ? mod.datItems.findIndex(it => baseName(it.name) === baseName(texName)) : -1;
    const img = await createImageBitmap(file);
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    if (idx >= 0) {
      mod.datItems[idx] = { ...mod.datItems[idx], data: Mip.encodeLike(mod.datItems[idx].data, c) };
      mod.dirty = true;
    }
    for (const mat of materialsForTexture(texName)) {
      if (mat.map) mat.map.dispose();
      mat.map = makeTexture(c);
      mat.needsUpdate = true;
    }
    log(`Replaced ${baseName(texName)} from ${file.name}` +
      (idx >= 0 ? ' - baked into the .dat (use Download rebuilt .dat).' : ' (view only, no archive open).'));
  } catch (err) {
    console.error(err);
    log('ERROR replacing texture: ' + err.message);
  }
}

async function replacePart(meshIndex, file) {
  try {
    const mesh = mod.meshes[meshIndex];
    if (!mesh) throw new Error('part not found - reload the model.');
    const pool = mod.datItems || mod.looseFiles;
    const idx = pool.findIndex(it => baseName(it.name) === mod.modelName);
    if (idx < 0) throw new Error('model file ' + mod.modelName + ' not found in the open mod.');
    const stlBytes = new Uint8Array(await file.arrayBuffer());
    const { bytes, stats } = ThreeDOEdit.replaceMeshGeometry(pool[idx].data, mesh, stlBytes);
    pool[idx] = { ...pool[idx], data: bytes };
    if (mod.datItems) mod.dirty = true;
    const partName = mesh.path;
    loadModelItem(pool[idx], { reapplyPaint: true });
    populatePanel();
    log(`Replaced part ${partName} with ${file.name}: ${stats.verts} verts, ${stats.tris} tris, ` +
      `scaled ×${stats.scale.toFixed(3)} to fit the old part's space` +
      (mod.datItems ? ' - baked into the .dat (use Download rebuilt .dat).' : ' (loose file - use Export to save).'));
    if (stats.heavy) log(`WARNING: ${stats.tris} tris is heavy for one track part — consider decimating in Blender.`);
    log('Note: the new part reuses the old part\'s texture region; if it looks misaligned in-game, check winding/orientation in Blender (Z-up, like the exported STL).');
  } catch (err) {
    console.error(err);
    log('ERROR replacing part: ' + err.message);
  }
}

function exportModel(format) {
  if (!mod || !mod.meshes) return;
  const base = mod.modelName.replace(/\.[^.]+$/, '');
  if (format === 'obj') {
    Zip.download(new Blob([ThreeDO.toOBJ(mod.meshes)], { type: 'text/plain' }), base + '.obj');
  } else {
    Zip.download(new Blob([ThreeDO.toSTL(mod.meshes)]), base + '.stl');
  }
  log('Exported ' + base + '.' + format + '.');
}

function downloadDat() {
  if (!mod || !mod.datItems) { alert('No .dat archive open.'); return; }
  const bytes = Dat.build(mod.datHeader, mod.datItems);
  Zip.download(new Blob([bytes]), mod.datName);
  log(`Rebuilt ${mod.datName} (${(bytes.length / 1024 / 1024).toFixed(1)} MB).`);
}

/* ---------- saved-session settings (Save/Load state) ----------
   captureSettings grabs everything user-facing at save time; applySavedSettings
   re-applies it after Library.restoreContext has reloaded the car + track. */
function captureSettings() {
  const val = (id) => { const el = $(id); return el ? el.value : ''; };
  return {
    series: val('lib-car'),
    track: val('lib-track'),
    paint: (mod && mod.activePaintCar) || '',
    wing: val('vp-wing'),
    ride: val('vp-ride'),
    wireframe: !!($('vp-wireframe') && $('vp-wireframe').checked),
    camera: val('vp-camera'),
  };
}

function applySavedSettings(ctx) {
  if (!ctx) return;
  /* set a select only when the saved value still exists in its options */
  const pick = (id, value) => {
    const sel = $(id);
    if (!sel || value == null || value === '') return null;
    if (![...sel.options].some(o => o.value === value)) return null;
    sel.value = value;
    return sel;
  };
  if (ctx.paint && mod && mod.carFiles && mod.carFiles.some(c => c.name === ctx.paint)) {
    const sel = $('vp-car-select');
    if (sel) sel.value = ctx.paint;
    applyCarPaint(ctx.paint, { commit: true });
  }
  const wing = pick('vp-wing', ctx.wing);
  if (wing) wing.dispatchEvent(new Event('change'));
  if (ctx.ride != null && ctx.ride !== '' && $('vp-ride') && !isHighRiderMod()) {
    $('vp-ride').value = ctx.ride;
    setRideHeight(parseFloat(ctx.ride) || 0);
  }
  if (ctx.wireframe && $('vp-wireframe')) {
    $('vp-wireframe').checked = true;
    for (const m of materialByTexture.values()) m.wireframe = true;
  }
  const cam = pick('vp-camera', ctx.camera);
  if (cam) cam.dispatchEvent(new Event('change'));
}

/* ---------- panel ---------- */
function populatePanel() {
  paintCommitted = mod.activePaintCar || null;
  const sel = $('vp-car-select');
  if (sel) {
    sel.innerHTML = '<option value="">Original (template paint)</option>' +
      mod.carFiles.map(c => `<option>${c.name}</option>`).join('');
    sel.value = paintCommitted || '';
    /* legacy select: commit only — never preview on keyboard highlight */
    sel.onchange = () => {
      if (!sel.value) {
        paintCommitted = null;
        mod.carMakeIdx = 0;
        mod.activePaintCar = null;
        loadModelItem(mod.modelItem || pickMainModel(mergePool(mod.datItems, mod.looseFiles)), { carMakeIdx: 0, keepPose: true });
        syncPaintListSelection();
      } else applyCarPaint(sel.value, { commit: true });
    };
  }
  const paints = $('vp-car-paints');
  if (paints) {
    paints.innerHTML =
      '<div class="vp-paint-row" data-car="">Original (template paint)</div>' +
      mod.carFiles.map(c => `<div class="vp-paint-row" data-car="${c.name.replace(/"/g, '&quot;')}">${c.name}</div>`).join('');
    syncPaintListSelection();
    paints.onmouseover = (e) => {
      const row = e.target.closest('.vp-paint-row');
      if (!row || !paints.contains(row)) return;
      const car = row.dataset.car || '';
      if (car) previewCarPaint(car);
      else previewTemplatePaint();
    };
    paints.onmouseleave = () => restoreCommittedPaint();
    paints.onclick = (e) => {
      const row = e.target.closest('.vp-paint-row');
      if (!row) return;
      const car = row.dataset.car || '';
      if (car) applyCarPaint(car, { commit: true });
      else {
        paintCommitted = null;
        mod.carMakeIdx = 0;
        mod.activePaintCar = null;
        loadModelItem(mod.modelItem || pickMainModel(mergePool(mod.datItems, mod.looseFiles)), { carMakeIdx: 0, keepPose: true });
        syncPaintListSelection();
      }
      if (sel) sel.value = paintCommitted || '';
    };
  }
  $('vp-info').textContent = mod.datName
    ? `${mod.folderName} - ${mod.datName}, ${mod.carFiles.length} car paint(s)`
    : `${mod.folderName} - loose files`;
  refreshAssetLists();
}

/* textures + parts lists reflect the CURRENT mesh set (they change per make) */
function refreshAssetLists() {
  if (!mod || !mod.meshes || !$('vp-textures')) return;
  const texNames = [...new Set(mod.meshes.filter(m => m.texture).map(m => baseName(m.texture)))];
  $('vp-textures').innerHTML = texNames.map(t => `
    <div class="vp-tex-row" data-tex="${t}">
      <span>${t}</span>
      <label class="file-btn">Replace<input type="file" accept=".png,.jpg,.jpeg" class="vp-tex-replace"></label>
    </div>`).join('');
  $('vp-textures').querySelectorAll('.vp-tex-replace').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const tex = e.target.closest('.vp-tex-row').dataset.tex;
      if (e.target.files[0]) replaceTexture(tex, e.target.files[0]);
      e.target.value = '';
    });
  });
  $('vp-textures').querySelectorAll('.vp-tex-row').forEach(row => {
    row.addEventListener('mouseenter', () => setHoverTexture(row.dataset.tex));
    row.addEventListener('mouseleave', () => setHoverTexture(null));
  });

  $('vp-parts').innerHTML = mod.meshes.map((m, i) => `
    <div class="vp-tex-row" data-part="${i}">
      <span title="${m.path}">${m.path}</span>
      <label class="file-btn">Replace<input type="file" accept=".stl" class="vp-part-replace"></label>
    </div>`).join('');
  $('vp-parts').querySelectorAll('.vp-part-replace').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const idx = Number(e.target.closest('.vp-tex-row').dataset.part);
      if (e.target.files[0]) replacePart(idx, e.target.files[0]);
      e.target.value = '';
    });
  });
  $('vp-parts').querySelectorAll('.vp-tex-row').forEach(row => {
    row.classList.toggle('selected', Number(row.dataset.part) === selectedIndex);
    row.addEventListener('mouseenter', () => setHoverPart(Number(row.dataset.part)));
    row.addEventListener('mouseleave', () => setHoverPart(null));
    row.addEventListener('click', (e) => {
      if (e.target.closest('.file-btn')) return;   /* Replace button keeps its job */
      setSelectedPart(Number(row.dataset.part));
    });
  });
}

/* ---------- viewport picking: hover label + click-to-select ---------- */
const CLICK_MAX_MOVE_PX = 5;
const CLICK_MAX_MS = 400;

function bindPicking() {
  const panel = $('viewer-panel');
  if (panel) panel.addEventListener('mouseleave', () => {
    if (paintPreviewing) restoreCommittedPaint();
  });
  if (panel) panel.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.vp-ctrl-bind')) return;   /* binding flow keeps focus on the button */
  }, true);
  const wrap = $('viewer-wrap');
  const label = document.createElement('div');
  label.id = 'vp-hover-label';
  wrap.appendChild(label);

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  /* Return ALL hits along the ray, nearest first — so a hovered spot can reveal
     a whole stack of overlapping surfaces (e.g. a black shadow strip sitting on
     top of the real bright surface underneath), not just the topmost one. */
  const pickHits = (ev) => {
    if (!modelGroup && !trackGroup) return [];
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = [];
    if (modelGroup) hits.push(...raycaster.intersectObjects(modelGroup.children, false));
    if (trackGroup) hits.push(...raycaster.intersectObjects(trackGroup.children, true));
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  };
  const pickPart = (ev) => { const h = pickHits(ev); return h.length ? h[0].object : null; };
  const prettyName = (n) => n && n.startsWith('surface:') ? n.slice('surface:'.length) : (n || '(unnamed)');
  const hideHover = () => {
    label.style.display = 'none';
    renderer.domElement.style.cursor = '';
    setHoverPart(null);
  };

  renderer.domElement.addEventListener('pointermove', (ev) => {
    if (ev.buttons !== 0) { hideHover(); return; }   /* orbiting/panning */
    const hits = pickHits(ev);
    if (!hits.length) { hideHover(); return; }
    const obj = hits[0].object;
    /* only car parts carry a meshIndex; track meshes just show a label */
    setHoverPart(typeof obj.userData.meshIndex === 'number' ? obj.userData.meshIndex : null);
    renderer.domElement.style.cursor = 'pointer';
    const wrapRect = wrap.getBoundingClientRect();
    /* dedupe the stack by name, keep nearest occurrence + its depth, cap 6 */
    const seen = new Map();
    for (const h of hits) {
      const nm = prettyName(h.object.name);
      if (!seen.has(nm)) seen.set(nm, h.distance);
    }
    const top = hits[0].distance;
    const lines = [...seen.entries()].slice(0, 6).map(([nm, d], i) => {
      const coplanar = i > 0 && (d - top) < 1;   /* within 1m of top = overlapping */
      return `${i === 0 ? '▸ ' : '  '}${nm}${coplanar ? '  (overlaps top)' : ''}`;
    });
    label.innerHTML = lines.map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('<br>');
    label.style.whiteSpace = 'pre';
    label.style.display = 'block';
    label.style.left = Math.min(ev.clientX - wrapRect.left + 14, wrap.clientWidth - label.offsetWidth - 8) + 'px';
    label.style.top = (ev.clientY - wrapRect.top + 16) + 'px';
  });
  renderer.domElement.addEventListener('pointerleave', hideHover);

  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    downAt = { x: ev.clientX, y: ev.clientY, t: Date.now() };
  });
  renderer.domElement.addEventListener('pointerup', (ev) => {
    if (!downAt) return;
    const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
    const held = Date.now() - downAt.t;
    downAt = null;
    if (moved > CLICK_MAX_MOVE_PX || held > CLICK_MAX_MS) return;  /* was a drag */
    const obj = pickPart(ev);
    setSelectedPart(obj && typeof obj.userData.meshIndex === 'number' ? obj.userData.meshIndex : null);
  });
}

/* ---------- init / events ---------- */
function bindFolderInput(id, handler) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('change', (e) => {
    const files = [...e.target.files];
    if (files.length) {
      const folderName = (files[0].webkitRelativePath || '').split('/')[0] || 'folder';
      handler(files, folderName);
    }
    e.target.value = '';
  });
}

window.__re2003Log = log;

function bindUI() {
  if (typeof DriveControls !== 'undefined') DriveControls.bindUI();
  ensureCarCamOptionsSaved();
  bindFolderInput('viewer-folder', openFolder);        /* header "Open Car" */
  bindFolderInput('viewer-track-folder', openTrackFolder);  /* header "Open Track" */
  const fileInput = $('viewer-file');                  /* optional single .dat/.3do input */
  if (fileInput) fileInput.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) openFolder([f], f.name);
    e.target.value = '';
  });

  const panel = $('viewer-panel');
  if (panel) panel.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.vp-ctrl-bind')) return;   /* binding flow keeps focus on the button */
  }, true);
  const wrap = $('viewer-wrap');
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target === renderer.domElement || renderer.domElement.contains(e.target)) renderer.domElement.focus();
  });
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('drag'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drag'));
  wrap.addEventListener('drop', async (e) => {
    e.preventDefault(); wrap.classList.remove('drag');
    const entry = e.dataTransfer.items[0] && e.dataTransfer.items[0].webkitGetAsEntry
      ? e.dataTransfer.items[0].webkitGetAsEntry() : null;
    if (entry && entry.isDirectory) {
      const files = [];
      try { await walkEntry(entry, files); } catch (err) { log('ERROR reading folder: ' + err.message); return; }
      openFolder(files, entry.name);
    } else if (e.dataTransfer.files[0]) {
      openFolder([e.dataTransfer.files[0]], e.dataTransfer.files[0].name);
    }
  });

  const bindClick = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  bindClick('vp-export-obj', () => exportModel('obj'));   /* Export section removed from UI */
  bindClick('vp-export-stl', () => exportModel('stl'));   /* handlers kept for drag-drop / future use */
  bindClick('vp-download-dat', downloadDat);
  $('vp-wireframe').addEventListener('change', (e) => {
    for (const m of materialByTexture.values()) m.wireframe = e.target.checked;
  });
  const wingSelect = $('vp-wing');
  if (wingSelect) wingSelect.addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === WING_HIDE_VALUE) { showWings = false; applyWingVisibility(); return; }
    showWings = true;
    const item = aeroVariants().find(it => it.name === v);
    if (item && item !== mod.modelItem) loadModelItem(item, { reapplyPaint: true, keepPose: true });
    else applyWingVisibility();   /* same body already loaded — just re-show the wing */
  });
  $('vp-ride').addEventListener('input', (e) => setRideHeight(parseFloat(e.target.value) || 0));
  $('vp-camera').addEventListener('change', (e) => {
    const v = e.target.value;
    const followViews = ['drive', 'chase', 'farChase', 'rearChase', 'hood',
      'gearbox', 'onCar', 'rollBar', 'fSusp', 'rSusp'];
    if (followViews.includes(v)) {
      Driving.setCarFollow(v === 'drive' ? 'chase' : v);
      return;
    }
    Driving.setCarFollow(null);
    if (v === 'trackview') frameTrackCar();
    else if (v === 'camera1') modelGroup ? frameModel() : frameHome();
    else if (v === 'blimp' || v === 'swingman') applyCameraView(v);
    else if (v === 'free') { /* orbit stays enabled */ }
    else applyCameraView(v);
  });
  /* C cycles the camera (Shift+C steps back). Bound on `window` rather than in
     Driving's key handler so it works in the showroom too — Driving only binds
     keys while you're actually driving. Dispatching `change` reuses the select's
     own handler above, so there is exactly ONE place that applies a view. */
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'c' && e.key !== 'C') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;      /* leave Ctrl/Cmd+C (copy) alone */
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
      || t.tagName === 'SELECT' || t.isContentEditable)) return;   /* not while typing */
    const sel = $('vp-camera');
    if (!sel || sel.classList.contains('hidden') || !sel.options.length) return;
    const n = sel.options.length;
    const cur = sel.selectedIndex < 0 ? 0 : sel.selectedIndex;
    sel.selectedIndex = (cur + (e.shiftKey ? n - 1 : 1)) % n;
    sel.dispatchEvent(new Event('change'));
    if (renderer && renderer.domElement) renderer.domElement.focus();   /* keys stay on the sim */
    e.preventDefault();
  });

  const driverSel = $('vp-driver');
  if (driverSel) driverSel.addEventListener('change', (e) => {
    Driving.setFocusByValue(e.target.value);
    renderer.domElement.focus();   /* keep keys (V, WASD) on the sim */
  });
  const stateSave = $('vp-state-save');
  if (stateSave) stateSave.addEventListener('click', () => {
    Driving.saveState();
    renderer.domElement.focus();   /* keep keys on the sim, not the button */
  });
  const stateLoad = $('vp-state-load');
  if (stateLoad) stateLoad.addEventListener('click', () => {
    Driving.loadState();
    renderer.domElement.focus();
  });

  /* Load the wide-open flat world */

  /* Start / end a full race (40-car field, 10 laps) — button doubles as End */
  const raceBtn = $('vp-race');
  if (raceBtn) raceBtn.addEventListener('click', () => {
    if (Driving.racing) {
      Driving.endRace();
      raceBtn.textContent = 'Start race';
    } else if (Driving.startRace()) {
      raceBtn.textContent = 'End race';
    }
    renderer.domElement.focus();
  });

  /* wind tunnel (top-bar button by the camera menu) + close button */
  bindClick('vp-wind-tunnel', () => { if (typeof WindTunnel !== 'undefined') WindTunnel.toggle(); });
  bindClick('wt-close', () => { if (typeof WindTunnel !== 'undefined') WindTunnel.exit(); });
  bindClick('wt-min', () => {
    const p = $('wind-tunnel-panel'), b = $('wt-min');
    if (!p) return;
    const collapsed = p.classList.toggle('wt-collapsed');
    if (b) {
      b.innerHTML = collapsed ? '&#9656;' : '&#9662;';   /* ▸ collapsed, ▾ open */
      b.title = collapsed ? 'Expand controls' : 'Minimize controls';
    }
  });
  bindClick('wt-dyno-run', () => {
    if (typeof WindTunnel !== 'undefined') WindTunnel.startDynoPass();
  });
  const wtArrowsEl = $('wt-show-arrows');
  if (wtArrowsEl) wtArrowsEl.addEventListener('change', () => {
    if (typeof WindTunnel !== 'undefined' && WindTunnel.active) WindTunnel.tick(0);
  });
  bindClick('vp-showroom', () => {
    if (typeof WindTunnel !== 'undefined') WindTunnel.exit();
    /* Actually GO to the showroom: closeTrack tears the track scenery down
       (and with it the sky), stops driving, reparents the car back onto the
       grid and restores the showroom camera menu. Without this the button only
       reframed the camera, so the car snapped to its showroom pose while the
       track + sky stayed rendered around it — the "it doesn't go back" bug.
       No-op when no track is loaded, so the plain reframe below still covers
       the showroom-only case. */
    closeTrack();
    if (modelGroup) frameModel();
    updateSceneBackground();
  });

  /* tire-rub simulator (menu) */
  const rubOn = $('vp-rub-sim');
  const rubTire = $('vp-rub-tire');
  const syncRubSim = () => {
    if (typeof TireFX === 'undefined' || !TireFX.setRubSim) return;
    TireFX.setRubSim(!!(rubOn && rubOn.checked), parseInt((rubTire && rubTire.value) || '0', 10) || 0);
  };
  if (rubOn) rubOn.addEventListener('change', syncRubSim);
  if (rubTire) rubTire.addEventListener('change', syncRubSim);

  /* test blowover (Aerodynamics panel) — fling the driven car backwards */
  bindClick('vp-test-blowover', () => {
    if (!Driving.active) { log('Drive first (open a track and spawn), then hit Test blowover.'); return; }
    Driving.triggerBlowover();
    renderer.domElement.focus();
  });

  bindClick('vp-flip-roof', () => {
    if (!Driving.active) { log('Drive first (open a track and spawn), then hit Flip to roof.'); return; }
    Driving.flipToRoof();
    renderer.domElement.focus();
  });
}

/* Recursively collect File objects from a dropped directory entry. Records
   each file's folder-relative path (_relPath) — dropped Files carry no
   webkitRelativePath, and without it root-vs-nested loose detection
   (isRootLoose) can't tell a track-root override from an inert SD Pack. */
function walkEntry(entry, out) {
  return new Promise((resolve, reject) => {
    if (entry.isFile) {
      entry.file(f => {
        try { f._relPath = (entry.fullPath || '').replace(/^\//, '') || f.name; }
        catch (e) { /* File may be sealed — path stays unknown, treated as root */ }
        out.push(f);
        resolve();
      }, reject);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => reader.readEntries(async (ents) => {
        if (!ents.length) return resolve();
        try {
          for (const e of ents) await walkEntry(e, out);
          readBatch();
        } catch (err) { reject(err); }
      }, reject);
      readBatch();
    } else resolve();
  });
}

initScene();
bindPicking();
bindUI();

/* debug/testing handle */
window.__viewer = () => ({ scene, camera, controls, renderer, mod, track, materialByTexture });

return { openFolder, openTrackFolder, closeTrack };
})();

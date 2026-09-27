/* TireFX — dynamic tire marks and smoke for the viewer.

   MARKS: dark rubber ribbons laid on the track wherever a loaded tire's tread
   slides over the surface (lockups, wheelspin, hard cornering). A fixed ring
   of quads (one draw call) — the oldest ~0.5 m chunk recycles when the ring
   wraps, so marks persist for kilometres like the sim's.
   SMOKE: a soft-sprite particle system fed by the same tread slide speed —
   puffs inherit a share of the wheel's motion, drift up, expand and fade.

   Both live in trackGroup (physics frame: x/y as car.x/y, z up), so all the
   math here is straight physics coordinates. Emission is driven per frame by
   Driving.update (snap.slideSpd/fz from the physics wheel loop); particle
   ageing runs from the main render loop so smoke keeps drifting after the
   drive session ends. Everything is generated — no textures, file:// safe. */
const TireFX = (() => {
  'use strict';

  /* ---- marks tuning ---- */
  const MARK_SEGS = 4096;        /* ring quads (~1.7 km of continuous mark) */
  const MARK_HALF_W = 0.15;      /* m — FALLBACK half tread width, used only until
                                    the viewer measures this mod's real tyre and
                                    calls setTireWidth() (see markHalfW below) */
  /* live half-width for BOTH skid rubber and dirt gouges — set to the ACTUAL
     tread width of the loaded car, measured per mod from the wheel mesh, so a
     mark is exactly as wide as the tyre that laid it (dirt vs rubber differ only
     in colour now, never in width). */
  let markHalfW = MARK_HALF_W;
  function setTireWidth(fullWidthM) {
    markHalfW = (typeof fullWidthM === 'number' && isFinite(fullWidthM) && fullWidthM > 0)
      ? Math.min(0.5, Math.max(0.05, fullWidthM / 2))   /* half-width, sane-clamped */
      : MARK_HALF_W;
  }
  const MARK_LIFT = 0.02;        /* m over the road (z-fight guard) */
  const MARK_MIN_STEP = 0.18;    /* m of travel per quad */
  const MARK_MAX_STEP = 3.0;     /* longer = teleport/respawn → restart strip */
  const MARK_STILL_S = 0.35;     /* stationary wheelspin: grind a patch in
                                    place this often (it darkens by stacking —
                                    a brake-stand burnout blackens its spot
                                    like the sim instead of waiting for travel) */
  /* ONE shared trigger — marks and smoke appear TOGETHER, always. It sits
     ABOVE the whole cornering envelope: a Cup car's tread slides 3–5 m/s on
     the racing line and peaks ~8 m/s in an aggressive sustained corner
     (measured) — the FX are for lockups (~30 m/s slide), burnouts (~29) and
     power-slides (10–20), never the racing line */
  const SLIDE_ON = 9.0;          /* m/s tread slide that fires marks + smoke */
  const SLIDE_FULL = 20.0;       /* m/s slide = full intensity */
  const MARK_ALPHA_MAX = 0.5;
  const MARK_FZ_MIN = 400;       /* N — unloaded wheels leave nothing */

  /* ---- smoke tuning ----
     VOLUMETRIC look = no individual puff may ever read as a shape: gaussian
     sprites with NO visible rim, low per-puff alpha, spawned densely enough
     to overlap 2-3× (per-METRE spawn term keeps the trail continuous at
     speed — a pure per-second rate beads at 30 m/s), living long enough to
     merge into a hanging cloud that grows huge and thins as it expands. */
  /* PERF: overdraw scales with ALIVE PUFF COUNT × quad area — screen-filling
     9 m billboards get expensive fast. So the cloud is built from FEW, DENSE
     puffs (each ~2× the alpha, ~⅓ the count of the first cut): the gaussian
     rimless sprites still merge into the same solid volume, at ~3× less
     fill-rate. If smoke ever chugs again, RATE_* down / ALPHA0 up is the
     trade that preserves the look. */
  const SMOKE_N = 4096;          /* particle pool (one instanced draw call) */
  const SMOKE_RATE_MAX = 7;      /* particles/s per wheel at max (stationary).
                                    Throttled by a proportional governor
                                    (below) so a sit-still burnout settles to
                                    a STEADY spawn = death rate — consistent
                                    flow, no pulsing. Kept low so the throttle
                                    runs at low gain (less breathing). */
  const SMOKE_PER_M = 1.3;       /* + particles per metre of wheel travel —
                                    NOT throttled, so a moving trail stays a
                                    continuous sheet even when the cloud is
                                    full (those puffs spread over distance and
                                    don't stack into overdraw anyway) */
  const SMOKE_RATE_CAP = 60;     /* per-wheel ceiling so a flat-out slide
                                    can't drain the pool in a few seconds */
  const SMOKE_LIFE_MIN = 5.0;    /* s — still lingers after the slide, but
                                    shorter than before so a puff dissipates
                                    before buoyancy carries it high, and the
                                    steady-state alive count stays low. The
                                    WIDE min→max spread is deliberate: it
                                    desynchronizes puff deaths so the cloud
                                    density holds steady instead of breathing
                                    (cohorts of same-age puffs dying together) */
  const SMOKE_LIFE_MAX = 11.0;
  const SMOKE_SIZE0 = 0.70;      /* m initial puff diameter (+ variance) */
  const SMOKE_SIZE_VAR = 0.60;
  const SMOKE_GROW_M = 4.5;      /* TOTAL growth over a puff's life (m),
                                    front-loaded then easing — every cloud
                                    balloons to ~5 m whatever its lifespan.
                                    Overdraw scales with area = size², so
                                    per-puff size is the biggest fill-rate
                                    lever. The cloud still reads BIG because
                                    apparent size comes from how far puffs
                                    SPREAD (wind + count), not per-puff size —
                                    so shrinking each puff + a hard count cap
                                    (below) cuts fill without shrinking the
                                    plume; higher ALPHA0 keeps it solid */
  const SMOKE_DRAG = 1.1;        /* 1/s velocity decay — old puffs hang */
  const SMOKE_RISE = 0.10;       /* m/s² buoyancy. With drag, terminal climb ≈
                                    RISE/DRAG ≈ 0.09 m/s, so puffs stay LOW
                                    and roll along the ground instead of
                                    ballooning up over the car (was 0.40 →
                                    ~4 m climb over a puff's life) */
  const SMOKE_WIND_X = 0.85;     /* m/s ambient drift — a stationary burnout
                                    plume rolls away and SPREADS instead of
                                    stacking its whole history over the car
                                    (overdraw) — and it reads like real wind */
  const SMOKE_WIND_Y = 0.35;
  const SMOKE_BUDGET = 90;       /* alive-puff ceiling for the proportional
                                    spawn throttle. Overdraw (screen-fulls of
                                    blended smoke) = count × per-puff area and
                                    that fill-rate is THE cost, so the base
                                    spawn rate eases toward zero as the live
                                    count approaches this — the population
                                    parks at a steady density (~70) with spawn
                                    matching death, giving CONSISTENT flow
                                    instead of the old hard cap's on/off pulse.
                                    Only regulates a sit-still burnout; a
                                    moving trail rides the un-throttled
                                    per-metre term. */
  const SMOKE_PRESSURE_AGE = 4.0;/* backstop only — extra ageing if the count
                                    ever overshoots the throttle (old die
                                    first); the throttle does the real work */
  const SMOKE_INHERIT = 0.35;    /* share of wheel velocity a puff keeps */
  const SMOKE_ALPHA0 = 0.66;     /* dense per-puff body — fewer, smaller puffs
                                    (hard cap + reduced size) must still merge
                                    into a solid cloud, so each carries more
                                    opacity. Alpha is a per-fragment blend, not
                                    extra fill, so this buys density for free */

  const GRIP_MIN = 0.6;          /* COLOR split, not a gate: grip ≥ 0.6 =
                                    asphalt/concrete → black rubber + grey
                                    smoke; below (grass/dirt, grip 0.35) →
                                    brown gouges + brown dust */

  let group = null;              /* parent: the current trackGroup */
  let marks = null;              /* { mesh, pos, alpha, cursor, written, dirty } */
  let smoke = null;              /* { points, pos, size, alpha, vel, age, life, n } */
  /* per-wheel emitter state: gx/gy = last frame's contact point (ground
     velocity), px/py = the mark strip's anchor (last laid quad's front edge),
     lx..rz = the strip's trailing ribbon edge */
  const wheels = [0, 1, 2, 3].map(() => ({
    active: false, px: 0, py: 0, pz: 0,
    gx: 0, gy: 0, hasPrev: false,
    lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0,
    vx: 0, vy: 0, credit: 0,
  }));

  /* ---- perf probe (temporary — logs once/second so a burnout can be
     profiled from the console). The headline number is OVERDRAW: the sum,
     over every alive puff, of the screen area its billboard covers — i.e.
     how many times over we repaint the whole screen in blended smoke each
     frame. That is the fill-rate cost that pins the GPU when you sit still.
     Toggle with TireFX.probe(false). */
  const PROBE = {
    on: false,
    win: 1.0,          /* log window seconds */
    t: 0, frames: 0,
    frameMs: 0, worstMs: 0,
    tickMs: 0,
    spawns: 0,         /* incremented in spawnPuff */
    camV: null,        /* lazy THREE.Vector3 for world→local camera */
  };

  function makeMarks() {
    const pos = new Float32Array(MARK_SEGS * 4 * 3);
    const alpha = new Float32Array(MARK_SEGS * 4);
    const dirt = new Float32Array(MARK_SEGS * 4);
    const idx = new Uint32Array(MARK_SEGS * 6);
    for (let q = 0; q < MARK_SEGS; q++) {
      const v = q * 4, o = q * 6;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v + 2; idx[o + 4] = v + 1; idx[o + 5] = v + 3;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aDirt', new THREE.BufferAttribute(dirt, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      /* the track DECAL layer (groove, painted lines) pulls −4 — marks must
         pull HARDER or every decal quad hides the rubber laid over it */
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
      vertexShader: [
        'attribute float aAlpha;',
        'attribute float aDirt;',
        'varying float vA;',
        'varying float vD;',
        'void main() {',
        '  vA = aAlpha;',
        '  vD = aDirt;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'].join('\n'),
      fragmentShader: [
        'varying float vA;',
        'varying float vD;',
        'void main() {',
        /* laid rubber on pavement; churned brown gouge on grass/dirt — the
           dirt tone is a lighter, warmer earthy brown so it reads as torn turf,
           not a black skid line */
        '  vec3 col = mix(vec3(0.045, 0.045, 0.05), vec3(0.40, 0.29, 0.17), vD);',
        '  gl_FragColor = vec4(col, vA);',
        '}'].join('\n'),
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'tire-marks';
    mesh.frustumCulled = false;    /* the ring spans the whole track */
    mesh.renderOrder = 1;          /* over the road + decals, under glass/smoke */
    return { mesh, pos, alpha, dirt, cursor: 0, written: 0, dirty: false };
  }

  /* n: optional puff count — the tire smoke uses SMOKE_N; the wind tunnel
     borrows this whole system (createSmokeSystem export) so its wand fog is
     THE SAME smoke as the tires, just advected by the tunnel's flow field */
  function makeSmoke(n) {
    const N = n || SMOKE_N;
    const pos = new Float32Array(N * 3);
    const size = new Float32Array(N);
    const alpha = new Float32Array(N);
    const seedA = new Float32Array(N);
    const dirtA = new Float32Array(N);
    /* INSTANCED camera-facing quads, NOT gl_PointSize sprites — the GPU
       clamps point sprites at its max point size (a few hundred px), which
       squashed every nearby cloud into a small DOT while distant smoke
       looked right. A billboard quad has no size cap: a 9 m cloud fills
       the screen when you drive up into it. One draw call either way. */
    const geo = new THREE.InstancedBufferGeometry();
    geo.instanceCount = N;
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1, 0, 0, 1, 1, 1]), 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 2, 1, 3]), 1));
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seedA, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aDirt', new THREE.InstancedBufferAttribute(dirtA, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: [
        'attribute vec3 aOffset;',
        'attribute float aSize;',
        'attribute float aAlpha;',
        'attribute float aSeed;',
        'attribute float aDirt;',
        'varying float vA;',
        'varying float vSeed;',
        'varying float vShade;',
        'varying float vD;',
        'varying vec2 vUv;',
        'void main() {',
        '  vSeed = aSeed;',
        '  vD = aDirt;',
        '  vUv = uv;',
        /* per-puff grey variation — light/dark neighbours read as depth */
        '  vShade = 0.76 + 0.14 * fract(aSeed * 7.31);',
        /* billboard: expand the unit quad in VIEW space around the puff */
        '  vec4 mv = modelViewMatrix * vec4(aOffset, 1.0);',
        /* near-camera fade: a puff hugging the camera covers the WHOLE
           screen for metres of depth — the most expensive pixels in the
           game. Fade approaching the camera and COLLAPSE the quad once
           invisible (zero area = zero fragments); also kills the flat-
           card-across-the-lens artifact when driving through the cloud. */
        '  float nf = smoothstep(1.2, 6.5, -mv.z);',
        '  vA = aAlpha * nf;',
        '  mv.xy += position.xy * aSize * step(0.001, nf);',
        '  gl_Position = projectionMatrix * mv;',
        '}'].join('\n'),
      fragmentShader: [
        'varying float vA;',
        'varying float vSeed;',
        'varying float vShade;',
        'varying vec2 vUv;',
        /* procedural value noise (no texture assets on file://) — the puff
           body is a noise-eroded disc, so edges are ragged wisps instead of
           a uniform bubble; overlapping puffs accumulate into a cloud */
        'float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
        'float vnoise(vec2 p) {',
        '  vec2 i = floor(p), f = fract(p);',
        '  f = f * f * (3.0 - 2.0 * f);',
        '  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),',
        '             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);',
        '}',
        'varying float vD;',
        'void main() {',
        '  vec2 pc = vUv;',
        /* gaussian core — NO visible rim, so a puff can never read as a
           discrete bubble; overlapping gaussians sum into one continuous
           medium. LOW-frequency noise only modulates interior density
           (lumpy cloud body), it never cuts a silhouette.
           PERF: discard the quad corners and the invisible gaussian tail
           BEFORE any noise math — with screen-filling billboards the noise
           is the per-pixel cost, and ~30% of the quad never shows. One
           noise octave: at cloud scale the fine octave read as grain. */
        '  float r = length(pc - vec2(0.5)) * 2.0;',
        '  if (r > 1.05) discard;',
        '  float core = exp(-r * r * 4.0);',
        '  float g = core * vA;',
        '  if (g < 0.004) discard;',
        '  float n = vnoise(pc * 3.1 + vSeed * 37.0);',
        '  float a = g * (0.5 + 0.5 * n);',
        /* grey rubber smoke on pavement; kicked-up DIRT off it — the dust is
           tuned to the dirt-mark brown (0.40,0.29,0.17), a hair lighter since
           it is an airborne lit particle, so grass throws dirt that matches its
           tracks instead of grey smoke. Both keep the per-puff light/dark var. */
        '  vec3 grey = vec3(vShade);',
        '  vec3 dust = vec3(0.44, 0.32, 0.19) * (vShade / 0.83);',
        '  gl_FragColor = vec4(mix(grey, dust, vD), a);',
        '}'].join('\n'),
    });
    const points = new THREE.Mesh(geo, mat);
    points.name = 'tire-smoke';
    points.frustumCulled = false;
    points.renderOrder = 3;        /* over the car glass (renderOrder 2) */
    return {
      points, pos, size, alpha, seedA, dirtA, n: N,
      vel: new Float32Array(N * 3),
      age: new Float32Array(N),
      life: new Float32Array(N),   /* 0 = dead slot */
      str: new Float32Array(N),    /* per-puff strength (slip intensity) */
      rub: new Uint8Array(N),      /* 1 = tire-rub sim puff (stays at wheel) */
      seed: 0,
    };
  }

  /* (re)parent the FX under a track group — a fresh track discards the old
     group wholesale, so attach rebuilds clean buffers */
  function attach(trackGroup) {
    if (!trackGroup || typeof THREE === 'undefined') return;
    if (group === trackGroup && marks) return;
    group = trackGroup;
    marks = makeMarks();
    smoke = makeSmoke();
    group.add(marks.mesh);
    group.add(smoke.points);
    for (const w of wheels) { w.active = false; w.hasPrev = false; w.credit = 0; }
  }

  function detach() {
    group = null; marks = null; smoke = null;
  }

  /* ground height at a small offset from the car's sample: extrapolate along
     the sampled surface PLANE (exact locally; never re-sample — the viewer's
     sampleSurface mutates the car's segment lock) */
  function groundZ(surf, cx, cy, wx, wy) {
    const up = (surf && surf.up) || [0, 0, 1];
    const uz = Math.max(up[2], 0.2);
    return ((surf && surf.height) || 0) - ((wx - cx) * up[0] + (wy - cy) * up[1]) / uz;
  }

  function layQuad(w, x, y, z, dirx, diry, a, dirt) {
    const perpx = -diry, perpy = dirx;
    const hw = markHalfW;          /* tyre-width for both rubber + dirt (dirt flag = colour only) */
    const lx = x + perpx * hw, ly = y + perpy * hw;
    const rx = x - perpx * hw, ry = y - perpy * hw;
    const m = marks, q = m.cursor, o = q * 12, oa = q * 4;
    /* rear edge = the strip's trailing edge (seamless ribbon), front = new */
    m.pos[o] = w.lx; m.pos[o + 1] = w.ly; m.pos[o + 2] = w.lz;
    m.pos[o + 3] = w.rx; m.pos[o + 4] = w.ry; m.pos[o + 5] = w.rz;
    m.pos[o + 6] = lx; m.pos[o + 7] = ly; m.pos[o + 8] = z;
    m.pos[o + 9] = rx; m.pos[o + 10] = ry; m.pos[o + 11] = z;
    m.alpha[oa] = m.alpha[oa + 1] = m.alpha[oa + 2] = m.alpha[oa + 3] = a;
    m.dirt[oa] = m.dirt[oa + 1] = m.dirt[oa + 2] = m.dirt[oa + 3] = dirt;
    m.cursor = (m.cursor + 1) % MARK_SEGS;
    m.written = Math.min(m.written + 1, MARK_SEGS);
    m.dirty = true;
    w.lx = lx; w.ly = ly; w.lz = z;
    w.rx = rx; w.ry = ry; w.rz = z;
  }

  function spawnPuff(x, y, z, vx, vy, intensity, dirt) {
    const s = smoke;
    PROBE.spawns++;
    /* find a dead slot round-robin */
    let i = -1;
    for (let tries = 0; tries < SMOKE_N; tries++) {
      const j = s.seed = (s.seed + 1) % SMOKE_N;
      if (s.life[j] > 0 && s.age[j] < s.life[j]) continue;
      i = j; break;
    }
    /* pool saturated: STEAL the next round-robin slot — spawn order tracks
       seed order, so that's (close to) the oldest cloud still alive; fresh
       smoke at the tire always beats a faded straggler */
    if (i < 0) i = s.seed = (s.seed + 1) % SMOKE_N;
    const o = i * 3;
    s.pos[o] = x + (Math.random() - 0.5) * 0.3;
    s.pos[o + 1] = y + (Math.random() - 0.5) * 0.3;
    s.pos[o + 2] = z + 0.12 + Math.random() * 0.12;
    s.vel[o] = vx * SMOKE_INHERIT + (Math.random() - 0.5) * 1.4;
    s.vel[o + 1] = vy * SMOKE_INHERIT + (Math.random() - 0.5) * 1.4;
    s.vel[o + 2] = 0.15 + Math.random() * 0.30;   /* gentle initial rise —
                                                     stays close to the ground */
    s.age[i] = 0;
    s.life[i] = SMOKE_LIFE_MIN + Math.random() * (SMOKE_LIFE_MAX - SMOKE_LIFE_MIN);
    s.str[i] = SMOKE_ALPHA0 * intensity + 0.20;
    s.alpha[i] = 0;                 /* tick() ramps the envelope in */
    s.size[i] = SMOKE_SIZE0 + Math.random() * SMOKE_SIZE_VAR;
    s.seedA[i] = Math.random();     /* noise offset + shade for this puff */
    s.dirtA[i] = dirt || 0;         /* grey rubber smoke vs brown dust */
  }

  function spawnRubPuff(x, y, z) {
    const sm = smoke;
    if (!sm) return;
    let i = -1;
    for (let tries = 0; tries < SMOKE_N; tries++) {
      const j = sm.seed = (sm.seed + 1) % SMOKE_N;
      if (sm.life[j] > 0 && sm.age[j] < sm.life[j]) continue;
      i = j; break;
    }
    if (i < 0) i = sm.seed = (sm.seed + 1) % SMOKE_N;
    const o = i * 3;
    sm.pos[o] = x + (Math.random() - 0.5) * 0.12;
    sm.pos[o + 1] = y + (Math.random() - 0.5) * 0.12;
    sm.pos[o + 2] = z + 0.04 + Math.random() * 0.08;
    sm.vel[o] = (Math.random() - 0.5) * 0.35;
    sm.vel[o + 1] = (Math.random() - 0.5) * 0.35;
    sm.vel[o + 2] = 0.08 + Math.random() * 0.12;
    sm.age[i] = 0;
    sm.life[i] = 1.4 + Math.random() * 1.6;
    sm.str[i] = 0.62 + Math.random() * 0.18;
    sm.alpha[i] = 0;
    sm.size[i] = 0.52 + Math.random() * 0.38;
    sm.seedA[i] = Math.random();
    sm.dirtA[i] = 0;
    if (sm.rub) sm.rub[i] = 1;
  }

  /* emission — call per drive frame with the render snap + the car's surface
     sample. All gates live here: grounded, loaded wheel, sliding tread,
     rubber-worthy surface. */
  /* ---- tire-rub simulator (menu debug) — continuous smoke ring on one
     wheel while the player drives; does not affect physics or leave marks. */
  const RUB_RATE = 130;          /* puffs/s — overlapping sheet at the tire */
  const RUB_SEGS = 20;           /* ring samples hugging the contact patch */
  const RUB_MIN_SPD = 4;         /* m/s — only while actually driving */
  let rubSim = { on: false, wheel: 0, credit: 0, phase: 0 };

  function setRubSim(on, wheelIdx) {
    rubSim.on = !!on;
    rubSim.wheel = (wheelIdx >= 0 && wheelIdx < 4) ? wheelIdx | 0 : 0;
    if (!rubSim.on) { rubSim.credit = 0; rubSim.phase = 0; }
  }
  function getRubSim() { return { on: rubSim.on, wheel: rubSim.wheel }; }

  function wheelContact(snap, surf, i) {
    const P = (typeof Physics !== 'undefined' && Physics.PARAMS) || null;
    const halfWB = (P ? P.wheelbase : 2.79) / 2;
    const halfTW = (P ? P.trackWidth : 1.65) / 2;
    const cy = Math.cos(snap.yaw || 0), sy = Math.sin(snap.yaw || 0);
    const lxB = (i < 2 ? 1 : -1) * halfWB;
    const lyB = (i % 2 === 0 ? 1 : -1) * halfTW;
    const wx = snap.x + lxB * cy - lyB * sy;
    const wy = snap.y + lxB * sy + lyB * cy;
    const wz = groundZ(surf, snap.x, snap.y, wx, wy) + MARK_LIFT;
    return { wx, wy, wz, cy, sy };
  }

  function emitRubSim(snap, surf, dt) {
    if (!rubSim.on || !smoke || !snap || !surf || !(dt > 0)) return;
    if ((snap.speed || 0) < RUB_MIN_SPD) return;
    const i = rubSim.wheel;
    const { wx, wy, wz, cy, sy } = wheelContact(snap, surf, i);
    const latx = -sy, laty = cy;
    const fwdx = cy, fwdy = sy;
    const treadR = Math.max(0.12, markHalfW * 0.95);
    rubSim.credit += RUB_RATE * dt;
    while (rubSim.credit >= 1) {
      rubSim.credit -= 1;
      const seg = Math.floor(rubSim.phase) % RUB_SEGS;
      rubSim.phase = (rubSim.phase + 1.6180339887) % RUB_SEGS;
      const ang = (seg / RUB_SEGS) * Math.PI * 2;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const px = wx + latx * ca * treadR + fwdx * sa * treadR * 0.28;
      const py = wy + laty * ca * treadR + fwdy * sa * treadR * 0.28;
      const pz = wz + 0.06 + Math.max(0, sa) * 0.14 + Math.abs(ca) * 0.05;
      spawnRubPuff(px, py, pz);
      smoke.aliveCount = (smoke.aliveCount || 0) + 1;
    }
  }

  function emit(snap, surf, dt) {
    if (!marks || !snap || !surf || !(dt > 0)) return;
    const slide = snap.slideSpd;
    if (!slide) return;
    const P = (typeof Physics !== 'undefined' && Physics.PARAMS) || null;
    const halfWB = (P ? P.wheelbase : 2.79) / 2;
    const halfTW = (P ? P.trackWidth : 1.65) / 2;
    const cy = Math.cos(snap.yaw || 0), sy = Math.sin(snap.yaw || 0);
    const offWheels = snap.airborne || snap.restingOnBody;
    /* surface palette fallback (car-centre) when no per-point classifier */
    const dirtCenter = (typeof surf.grip === 'number' && surf.grip < GRIP_MIN) ? 1 : 0;
    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      const lxB = (i < 2 ? 1 : -1) * halfWB;
      const lyB = (i % 2 === 0 ? 1 : -1) * halfTW;
      const wx = snap.x + lxB * cy - lyB * sy;
      const wy = snap.y + lxB * sy + lyB * cy;
      const wz = groundZ(surf, snap.x, snap.y, wx, wy) + MARK_LIFT;
      /* PER-WHEEL surface: this tyre's own contact point decides dirt vs rubber,
         so a car straddling the line lays brown dirt only on the grass side and
         black skid only on the pavement side (no bleed across the edge). */
      const wDirt = surf.grassAt ? (surf.grassAt(wx, wy) ? 1 : 0) : dirtCenter;
      const wMarkHW = markHalfW;   /* tyre-width mark; wDirt now only tints colour */
      /* wheel ground velocity from frame-to-frame motion (smoke drift/pour
         direction) — gx/gy update EVERY frame, unlike the strip anchor */
      const frameStep = w.hasPrev ? Math.hypot(wx - w.gx, wy - w.gy) : 0;
      if (w.hasPrev && frameStep < MARK_MAX_STEP) {
        w.vx = (wx - w.gx) / dt; w.vy = (wy - w.gy) / dt;
      } else { w.vx = 0; w.vy = 0; }
      w.gx = wx; w.gy = wy;
      w.hasPrev = true;
      const teleported = frameStep > MARK_MAX_STEP;

      const sl = slide[i] || 0;
      const fzOk = ((snap.fz && snap.fz[i]) || 0) > MARK_FZ_MIN;
      /* ONE gate + ONE intensity for both effects — marks and smoke always
         appear together (and stop together) */
      const k = sl >= SLIDE_ON
        ? Math.min(1, (sl - SLIDE_ON) / (SLIDE_FULL - SLIDE_ON) + 0.15) : 0;
      const firing = !offWheels && fzOk && k > 0 && !teleported;
      const marking = firing;

      if (marking && w.active) {
        const stepLen = Math.hypot(wx - w.px, wy - w.py);
        if (stepLen > MARK_MAX_STEP) {
          w.active = false;            /* stale anchor — restart next frame */
        } else if (stepLen >= MARK_MIN_STEP) {
          layQuad(w, wx, wy, wz, (wx - w.px) / stepLen, (wy - w.py) / stepLen,
            MARK_ALPHA_MAX * k, wDirt);
          w.px = wx; w.py = wy; w.pz = wz;
          w.stillT = 0;
        } else {
          /* barely moving but the tread is grinding (brake-stand burnout):
             lay a tread-length patch under the wheel along the car's heading
             every MARK_STILL_S — repeats stack alpha, so the spot blackens
             the longer the tire spins, and smoke is never left mark-less */
          w.stillT = (w.stillT || 0) + dt;
          if (w.stillT >= MARK_STILL_S) {
            w.stillT = 0;
            const rx0 = wx - cy * 0.13, ry0 = wy - sy * 0.13;
            w.lx = rx0 - sy * wMarkHW; w.ly = ry0 + cy * wMarkHW; w.lz = wz;
            w.rx = rx0 + sy * wMarkHW; w.ry = ry0 - cy * wMarkHW; w.rz = wz;
            layQuad(w, wx + cy * 0.13, wy + sy * 0.13, wz, cy, sy,
              MARK_ALPHA_MAX * k * 0.8, wDirt);
            /* anchor stays at the wheel — rolling out stitches from the patch */
            w.px = wx; w.py = wy; w.pz = wz;
          }
        }
      } else if (marking) {
        /* strip start: seed the trailing ribbon edge across the tread, a hair
           behind the contact so the first quad has non-zero length */
        const spd0 = Math.hypot(w.vx, w.vy);
        const dirx = spd0 > 0.3 ? w.vx / spd0 : cy;
        const diry = spd0 > 0.3 ? w.vy / spd0 : sy;
        w.lx = wx - dirx * 0.01 + diry * wMarkHW;
        w.ly = wy - diry * 0.01 - dirx * wMarkHW;
        w.lz = wz;
        w.rx = wx - dirx * 0.01 - diry * wMarkHW;
        w.ry = wy - diry * 0.01 + dirx * wMarkHW;
        w.rz = wz;
        w.px = wx; w.py = wy; w.pz = wz;
        w.active = true;
        w.stillT = 0;
      } else {
        w.active = false;
        w.stillT = 0;
      }

      /* smoke: SAME firing gate and intensity as the marks; fractional spawn
         credit. Rate = a stationary base + a per-METRE term, so the trail
         stays a continuous sheet at speed instead of beading, and a parked
         burnout still billows. */
      if (firing && smoke) {
        const spd = Math.hypot(w.vx, w.vy);
        /* proportional throttle on the STATIONARY base rate: eases spawning
           smoothly toward zero as the live count nears the budget, so the
           population parks at a steady density (spawn = death) and the flow
           stays CONSISTENT — no on/off pulsing. The per-metre term is NOT
           throttled, so a moving trail stays continuous even when full. */
        const throttle = Math.max(0, 1 - (smoke.aliveCount || 0) / SMOKE_BUDGET);
        w.credit += Math.min(SMOKE_RATE_CAP,
          (SMOKE_RATE_MAX * throttle + SMOKE_PER_M * spd) * k) * dt;
        const inv = spd || 1;
        const bx = -w.vx / inv, by = -w.vy / inv;   /* pour off the patch's rear */
        while (w.credit >= 1) {
          w.credit -= 1;
          spawnPuff(wx + bx * 0.25, wy + by * 0.25, wz, w.vx, w.vy, k, wDirt);
          /* count each spawn immediately so the throttle stays responsive
             across all four wheels within this frame (tick() then recomputes
             aliveCount authoritatively) */
          smoke.aliveCount = (smoke.aliveCount || 0) + 1;
        }
      } else {
        w.credit = 0;
      }
    }
    if (marks.dirty) {
      marks.mesh.geometry.attributes.position.needsUpdate = true;
      marks.mesh.geometry.attributes.aAlpha.needsUpdate = true;
      marks.mesh.geometry.attributes.aDirt.needsUpdate = true;
      marks.mesh.geometry.setDrawRange(0, marks.written * 6);
      marks.dirty = false;
    }
  }

  /* particle ageing + upload — from the MAIN render loop (smoke must keep
     drifting after the drive session ends). pxPerM is accepted for call
     compatibility but unused: billboard quads are world-sized, no px
     conversion needed. */
  function tick(dt, pxPerM, camera, wPx, hPx) {
    const s = smoke;
    if (!s || !(dt > 0)) return;
    const t0 = (PROBE.on && typeof performance !== 'undefined') ? performance.now() : 0;
    let any = false;
    const drag = Math.max(0, 1 - SMOKE_DRAG * dt);
    /* overdraw governor: sitting in one spot (brake-stand burnout) piles the
       whole spawn history into one screen-filling stack. Past the budget,
       age the puffs faster — weighted by age, so the oldest die first and
       fresh smoke at the tire is untouched. Once firing stops the count
       falls back under budget and the remaining cloud lingers in full. */
    const pressure = Math.max(0, (s.aliveCount || 0) / SMOKE_BUDGET - 1);
    let alive = 0;
    for (let i = 0; i < SMOKE_N; i++) {
      if (!(s.life[i] > 0)) continue;
      const t0 = s.age[i] / s.life[i];
      /* dead: zero the SIZE too — a zero-area quad rasterizes nothing */
      if (t0 >= 1) { s.life[i] = 0; s.alpha[i] = 0; s.size[i] = 0; if (s.rub) s.rub[i] = 0; any = true; continue; }
      any = true;
      alive++;
      const isRub = s.rub && s.rub[i];
      s.age[i] += dt * (isRub ? 1 : (1 + pressure * SMOKE_PRESSURE_AGE * t0));
      const o = i * 3;
      const t = Math.min(1, s.age[i] / s.life[i]);
      if (isRub) {
        const rubDrag = Math.max(0, 1 - 2.2 * dt);
        s.vel[o] = (s.vel[o] - SMOKE_WIND_X) * rubDrag + SMOKE_WIND_X;
        s.vel[o + 1] = (s.vel[o + 1] - SMOKE_WIND_Y) * rubDrag + SMOKE_WIND_Y;
        s.vel[o + 2] = s.vel[o + 2] * rubDrag + 0.22 * dt;
        s.pos[o] += s.vel[o] * dt;
        s.pos[o + 1] += s.vel[o + 1] * dt;
        s.pos[o + 2] += s.vel[o + 2] * dt;
        s.size[i] += 1.6 * (dt / Math.max(0.35, s.life[i])) * (1.15 - 0.35 * t);
        const env = t < 0.12 ? t / 0.12 : Math.pow(1 - (t - 0.12) / 0.88, 0.72);
        const spread = Math.pow(0.55 / Math.max(0.55, s.size[i]), 0.55);
        s.alpha[i] = Math.max(0, s.str[i] * env * (0.5 + 0.5 * spread));
      } else {
        /* drag decays velocity toward the ambient WIND, not toward zero */
        s.vel[o] = SMOKE_WIND_X + (s.vel[o] - SMOKE_WIND_X) * drag;
        s.vel[o + 1] = SMOKE_WIND_Y + (s.vel[o + 1] - SMOKE_WIND_Y) * drag;
        s.vel[o + 2] = s.vel[o + 2] * drag + SMOKE_RISE * dt;
        s.pos[o] += s.vel[o] * dt;
        s.pos[o + 1] += s.vel[o + 1] * dt;
        s.pos[o + 2] += s.vel[o + 2] * dt;
        s.size[i] += SMOKE_GROW_M * (dt / s.life[i]) * (1.6 - 1.2 * t);
        const env = t < 0.06 ? t / 0.06 : Math.pow(1 - (t - 0.06) / 0.94, 0.85);
        const spread = Math.pow(SMOKE_SIZE0 / Math.max(SMOKE_SIZE0, s.size[i]), 0.9);
        s.alpha[i] = Math.max(0, s.str[i] * env * (0.55 + 0.45 * spread));
      }
    }
    s.aliveCount = alive;
    if (any) {
      s.points.geometry.attributes.aOffset.needsUpdate = true;
      s.points.geometry.attributes.aSize.needsUpdate = true;
      s.points.geometry.attributes.aAlpha.needsUpdate = true;
      s.points.geometry.attributes.aSeed.needsUpdate = true;
      s.points.geometry.attributes.aDirt.needsUpdate = true;
    }
    if (t0) { PROBE.tickMs += performance.now() - t0; probeLog(dt, pxPerM, camera, wPx, hPx); }
  }

  /* accumulate one frame; once per PROBE.win seconds, compute + log the
     smoke's real cost. OVERDRAW is the money number — screen-fulls of
     blended smoke painted per frame. maxCover flags a single giant quad
     hugging the lens; alive/spawn/tick separate GPU cost from CPU cost. */
  function probeLog(dt, pxPerM, camera, wPx, hPx) {
    PROBE.frames++;
    const ms = dt * 1000;
    PROBE.frameMs += ms;
    if (ms > PROBE.worstMs) PROBE.worstMs = ms;
    PROBE.t += dt;
    if (PROBE.t < PROBE.win) return;

    const s = smoke;
    /* overdraw: project every alive puff to screen area and sum. Camera is
       in world space; puffs live in the track group's local (physics) frame
       — convert the camera into that frame so distances line up. */
    let overdraw = 0, maxCover = 0, counted = 0;
    let zMin = Infinity, zMax = -Infinity;   /* plume vertical extent (height) */
    const screenPx = (wPx && hPx) ? wPx * hPx : 0;
    if (camera && group && screenPx && typeof THREE !== 'undefined') {
      if (!PROBE.camV) PROBE.camV = new THREE.Vector3();
      const cam = PROBE.camV.copy(camera.position);
      group.worldToLocal(cam);
      for (let i = 0; i < SMOKE_N; i++) {
        if (!(s.life[i] > 0) || !(s.alpha[i] > 0.01)) continue;
        const o = i * 3;
        const z = s.pos[o + 2];
        if (z < zMin) zMin = z;
        if (z > zMax) zMax = z;
        const dx = s.pos[o] - cam.x, dy = s.pos[o + 1] - cam.y, dz = z - cam.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 0.05) { maxCover = Math.max(maxCover, 1); overdraw += 1; counted++; continue; }
        const rPx = pxPerM * (s.size[i] * 0.5) / d;       /* projected radius */
        const cover = Math.min(1, (Math.PI * rPx * rPx) / screenPx);
        overdraw += cover;
        if (cover > maxCover) maxCover = cover;
        counted++;
      }
    }
    const plume = (counted && zMax >= zMin) ? zMax - zMin : 0;
    const fps = PROBE.frames / PROBE.t;
    const avgMs = PROBE.frameMs / PROBE.frames;
    const tickMs = PROBE.tickMs / PROBE.frames;
    const spawnRate = PROBE.spawns / PROBE.t;
    const written = marks ? marks.written : 0;
    /* one compact line — easy to eyeball or paste back */
    console.log(
      `[smoke] fps ${fps.toFixed(0)} | frame ${avgMs.toFixed(1)}ms (worst ${PROBE.worstMs.toFixed(1)})`
      + ` | tick ${tickMs.toFixed(2)}ms | puffs ${s.aliveCount || 0}/${counted}`
      + ` | spawn ${spawnRate.toFixed(0)}/s | overdraw ${overdraw.toFixed(1)}x`
      + ` (max puff ${maxCover.toFixed(2)}) | plume ${plume.toFixed(1)}m | marks ${written}`);
    PROBE.t = 0; PROBE.frames = 0; PROBE.frameMs = 0; PROBE.worstMs = 0;
    PROBE.tickMs = 0; PROBE.spawns = 0;
  }

  function reset() {
    if (marks) { marks.cursor = 0; marks.written = 0; marks.mesh.geometry.setDrawRange(0, 0); }
    if (smoke) {
      smoke.life.fill(0);
      smoke.alpha.fill(0);
      smoke.size.fill(0);
      if (smoke.rub) smoke.rub.fill(0);
      smoke.points.geometry.attributes.aAlpha.needsUpdate = true;
      smoke.points.geometry.attributes.aSize.needsUpdate = true;
    }
    for (const w of wheels) { w.active = false; w.hasPrev = false; w.credit = 0; }
  }

  /* TireFX.probe(false) to silence the per-second console log */
  function probe(on) { PROBE.on = on !== false; return PROBE.on; }
  return { attach, detach, emit, emitRubSim, tick, reset, probe, setTireWidth, setRubSim, getRubSim,
    createSmokeSystem: makeSmoke, get group() { return group; } };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = TireFX;

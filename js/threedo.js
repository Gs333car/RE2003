
const ThreeDO = (() => {
  const PRIM_CLASSES = ['TriStripDescriptor', 'TriFanDescriptor', 'TriListDescriptor'];

  /* ---------- reader ---------- */
  function makeReader(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { dv, bytes, p: 0, len: bytes.length };
  }
  const u8 = (r) => r.bytes[r.p++];
  const u32 = (r) => { const v = r.dv.getUint32(r.p, true); r.p += 4; return v; };
  const peek = (r, off = 0) => r.p + off + 4 <= r.len ? r.dv.getUint32(r.p + off, true) : 0xFFFFFFFF;
  const f64s = (r, n) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) { out[i] = r.dv.getFloat64(r.p, true); r.p += 8; }
    return out;
  };
  function str(r) {
    const n = u32(r);
    if (n > 256) throw parseErr(r, 'string length ' + n);
    const s = n ? new TextDecoder('latin1').decode(r.bytes.subarray(r.p, r.p + n - 1)) : '';
    r.p += n;
    return s;
  }
  function parseErr(r, msg) {
    return new Error(`3do parse: ${msg} @0x${r.p.toString(16)}`);
  }
  function expect(r, val, what) {
    const got = u32(r);
    if (got !== val) throw parseErr(r, `${what}: expected ${val}, got ${got}`);
  }

  /* ---------- parser ---------- */
  function parse(bytes) {
    const ctx = {
      r: makeReader(bytes),
      classes: new Map(),      /* classId -> name */
      nextId: 1,
      objects: new Map(),      /* objId -> record */
      stack: [],
    };
    const rootId = parseObject(ctx);
    /* tolerate trailing top-level objects, refs, and zero padding */
    const r = ctx.r;
    while (r.len - r.p >= 4) {
      const v = peek(r);
      if (v === ctx.nextId && r.len - r.p >= 8) parseObject(ctx);
      else if (v < ctx.nextId) r.p += 4;
      else break;
    }
    return { objects: ctx.objects, rootId, classes: ctx.classes };
  }

  function parseObject(ctx) {
    const r = ctx.r;
    const start = r.p;
    const objId = u32(r);
    const classId = u32(r);
    if (!ctx.classes.has(classId)) {
      if (classId !== objId + 1) throw parseErr(r, `unknown class ${classId} for obj ${objId}`);
      if (objId !== ctx.nextId) throw parseErr(r, `registration id ${objId}, expected ${ctx.nextId}`);
      ctx.classes.set(classId, str(r));
      ctx.nextId += 2;
    } else {
      if (objId !== ctx.nextId) throw parseErr(r, `object id ${objId}, expected ${ctx.nextId}`);
      ctx.nextId += 1;
    }
    const cls = ctx.classes.get(classId);
    expect(r, 1, 'nameFlag');
    const name = str(r);
    const obj = { id: objId, cls, name, start, childIds: [] };
    obj.parentId = ctx.stack.length ? ctx.stack[ctx.stack.length - 1].id : null;
    ctx.objects.set(objId, obj);
    ctx.stack.push(obj);
    const payload = PAYLOADS[cls];
    if (!payload) throw parseErr(r, 'unsupported descriptor ' + cls);
    obj.payloadStart = r.p;
    payload(ctx, obj);
    obj.end = r.p;
    ctx.stack.pop();
    return objId;
  }

  function slot(ctx) {
    const r = ctx.r;
    const v = peek(r);
    let id = null;
    if (v === 0) { r.p += 4; }
    else if (v === ctx.nextId) { id = parseObject(ctx); }
    else if (v < ctx.nextId) { r.p += 4; id = v; }
    else throw parseErr(r, `slot id ${v} (next ${ctx.nextId})`);
    ctx.stack[ctx.stack.length - 1].childIds.push(id);
    return id;
  }

  function childList(ctx, n, what) {
    const blen = u32(ctx.r);
    if (blen !== n * 4) throw parseErr(ctx.r, `${what}: slot bytes ${blen} != 4*${n}`);
    for (let i = 0; i < n; i++) slot(ctx);
  }

  function f64Array(ctx, n, what) {
    const blen = u32(ctx.r);
    if (blen === 0) return null;
    if (blen !== n * 8) throw parseErr(ctx.r, `${what}: array bytes ${blen} != 8*${n}`);
    return f64s(ctx.r, n);
  }

  /* uv channels come in 8-slot blocks that are sparsely populated — the pair
     can sit at any even offset (set 0 at [0,1], night set at [4,5], morph
     lists park theirs in the second block group). First present pair wins. */
  function firstUvPair(blocks) {
    for (let s = 0; s + 1 < blocks.length; s += 2) {
      if (blocks[s] && blocks[s + 1]) return [blocks[s], blocks[s + 1]];
    }
    return null;
  }

  function uvPairBounds(pair) {
    const [u, v] = pair;
    return [Math.min(...u), Math.max(...u), Math.min(...v), Math.max(...v)];
  }

  /* Multi-set lists (sets >= 3) often carry two card.mip layouts: block 0
     slot 0+1 matches a .car paint (XETC), last-block slot 4+5 matches the
     mod template card.mip (driver suit, etc.). Body panels usually match on
     both channels; driver add-ons differ — pick by paintedBody. */
  function selectUvPair(blocks, setCount, paintedBody) {
    if (!blocks || !blocks.length) return null;
    const primary = blocks[0] && blocks[1] ? [blocks[0], blocks[1]] : null;
    let alt = null;
    if (setCount >= 3) {
      const base = (setCount - 1) * 8 + 4;
      if (blocks[base] && blocks[base + 1]) alt = [blocks[base], blocks[base + 1]];
    }
    if (primary && alt) {
      const a = uvPairBounds(primary), b = uvPairBounds(alt);
      const differs = a.some((v, i) => Math.abs(v - b[i]) > 1e-4);
      if (differs) return paintedBody ? primary : alt;
    }
    return primary || alt || firstUvPair(blocks);
  }

  function resolveUv(pvl, paintedBody) {
    let pair = pvl.uvBlocks ? selectUvPair(pvl.uvBlocks, pvl.uvSetCount, paintedBody) : null;
    if (!pair && pvl.morphUvBlocks) pair = selectUvPair(pvl.morphUvBlocks, pvl.morphK2, paintedBody);
    if (!pair && pvl.uv) pair = pvl.uv;
    return pair && pair[0] ? { u: pair[0], v: pair[1] } : null;
  }

  function looksLikeString(r, pos) {
    if (pos + 4 > r.len) return false;
    const n = r.dv.getUint32(pos, true);
    if (n < 2 || n > 64 || pos + 4 + n > r.len) return false;
    if (r.bytes[pos + 4 + n - 1] !== 0) return false;
    for (let i = 0; i < n - 1; i++) {
      const c = r.bytes[pos + 4 + i];
      if (c < 0x20 || c >= 0x7f) return false;
    }
    return true;
  }

  /* ---------- class payloads ---------- */
  function pNode(ctx, obj) {      /* shared [1][1][bbox] prefix */
    expect(ctx.r, 1, 'node.a');
    expect(ctx.r, 1, 'node.b');
    const bbox = f64s(ctx.r, 6);
    if (obj) obj.bbox = Array.from(bbox);   /* parent-space AABB, ground truth for transforms */
    return bbox;
  }

  function pGroup(ctx, obj) {
    pNode(ctx, obj);
    expect(ctx.r, 1, 'group.c');
    const n = u32(ctx.r);
    childList(ctx, n, 'group');
  }

  function pStateSwitch(ctx, obj) {
    const r = ctx.r;
    pNode(ctx, obj);
    /* strTag 2 (cars): leading u8 before the child count.
       strTag 1 (track scenery): count is 4-byte aligned, no u8. */
    const strTag = u32(r);
    if (strTag !== 1 && strTag !== 2) throw parseErr(r, `ss.strTag: expected 1 or 2, got ${strTag}`);
    obj.variable = str(r);
    if (strTag === 2) u8(r);
    const n = u32(r);
    for (let i = 0; i < 5; i++) u32(r);
    /* per-child display thresholds: child i shows when variable >= values[i],
       and NO child shows while the variable sits below values[0] */
    obj.stateValues = Array.from(f64s(r, n));
    childList(ctx, n, 'stateswitch');
  }

  function pLodSwitch(ctx, obj) {
    const r = ctx.r;
    pNode(ctx, obj);
    expect(r, 2, 'lod.c');
    const n = u32(r);
    for (let i = 0; i < 9; i++) u32(r);
    u8(r);
    obj.lodDists = n > 1 ? Array.from(f64s(r, n - 1)) : [];
    childList(ctx, n, 'lodswitch');
  }

  function pTransform(ctx, obj) {
    const r = ctx.r;
    pNode(ctx, obj);
    const n = u32(r);
    for (let i = 0; i < n; i++) {
      const frame = f64s(r, 6);
      if (i === 0) obj.pose = Array.from(frame);
      if (n > 1) (obj.frames = obj.frames || []).push(Array.from(frame));
    }
    slot(ctx);
    /* trailing named animation tracks: [1][str name][count][byteLen][data].
       The name binds a published state channel (roof_flap_state, ...) to the
       node's pose frames — frame index = channel value. Recorded so the
       viewer can articulate them (deployed roof flaps); payload untouched. */
    while (peek(r) === 1 && looksLikeString(r, r.p + 4)) {
      u32(r);
      const trackName = str(r);
      const trackCount = u32(r);
      const blen = u32(r);
      if (blen > r.len - r.p) throw parseErr(r, 'anim track bytes ' + blen);
      r.p += blen;
      (obj.tracks = obj.tracks || []).push({ name: trackName, count: trackCount });
    }
  }

  function pShape(ctx) {
    expect(ctx.r, 1, 'shape.a');
    expect(ctx.r, 1, 'shape.b');
    slot(ctx);                    /* appearance */
    slot(ctx);                    /* geometry */
  }

  function pAppearance(ctx) {
    expect(ctx.r, 2, 'app.tag');
    for (let i = 0; i < 6; i++) slot(ctx);   /* texture slots */
    expect(ctx.r, 0, 'app.z1');
    f64s(ctx.r, 12);                          /* material colors */
    u32(ctx.r);
  }

  function pTexture(ctx, obj) {
    /* strTag 2 (cars): trailing u8 after the filename.
       strTag 1 (track scenery): no trailing byte. */
    const strTag = u32(ctx.r);
    if (strTag !== 1 && strTag !== 2) throw parseErr(ctx.r, `tex.strTag: expected 1 or 2, got ${strTag}`);
    obj.file = str(ctx.r);
    if (strTag === 2) u8(ctx.r);
  }

  function pGeometry(ctx) {
    const r = ctx.r;
    expect(r, 1, 'geo.a');
    slot(ctx);                    /* vertex list */
    for (;;) {
      const v = peek(r);
      if (v !== ctx.nextId) break;
      const c = peek(r, 4);
      let isPrim = false;
      if (ctx.classes.has(c)) {
        isPrim = PRIM_CLASSES.includes(ctx.classes.get(c));
      } else if (c === v + 1 && looksLikeString(r, r.p + 8)) {
        const n = r.dv.getUint32(r.p + 8, true);
        const nm = new TextDecoder('latin1').decode(r.bytes.subarray(r.p + 12, r.p + 12 + n - 1));
        isPrim = PRIM_CLASSES.includes(nm);
      }
      if (!isPrim) break;
      const id = parseObject(ctx);
      ctx.stack[ctx.stack.length - 1].childIds.push(id);
    }
  }

  function pVertexList(ctx, obj) {
    const r = ctx.r;
    expect(r, 1, 'pvl.a');
    expect(r, 1, 'pvl.b');
    const n = u32(r);
    const arrays = [];
    for (let i = 0; i < 7; i++) arrays.push(f64Array(ctx, n, 'pvl.arr' + i));
    const sets = u32(r);
    if (sets > 8) throw parseErr(r, 'uv set count ' + sets);
    for (let s = 0; s < sets; s++) {
      for (let k = 0; k < 8; k++) arrays.push(f64Array(ctx, n, 'pvl.uv'));
    }
    obj.verts = n;
    obj.xyz = arrays.slice(0, 3);
    obj.normals = arrays.slice(4, 7);
    obj.uvBlocks = arrays.slice(7);
    obj.uvSetCount = sets;
    obj.uv = selectUvPair(obj.uvBlocks, sets, false);
    /* for write-back: which arrays are present, and how many uv sets */
    obj.arrayPattern = arrays.map(a => a !== null);
    obj.setsCount = sets;
    return n;
  }

  function pRegionMorph(ctx, obj) {
    const r = ctx.r;
    const n = pVertexList(ctx, obj);
    const k2 = u32(r);
    if (k2 > 8) throw parseErr(r, 'morph set count ' + k2);
    const extra = [];
    for (let i = 0; i < k2 * 8; i++) extra.push(f64Array(ctx, n, 'morph.extra'));
    obj.morphUvBlocks = extra;
    obj.morphK2 = k2;
    if (!obj.uv) obj.uv = selectUvPair(extra, k2, false);   /* morph lists keep uv here */
    const nreg = u32(r);
    if (nreg > 64) throw parseErr(r, 'morph region count ' + nreg);
    /* morph regions: [name = state channel][a arrays][?:u32][c verts]
       [a × f64Array(c)][c × u32 vertex indices]. The channel value morphs the
       indexed vertices through the arrays (roof_flap_state = deploying flaps,
       hood_damage = crumples). Recorded so the viewer can articulate them. */
    for (let i = 0; i < nreg; i++) {
      const regName = str(r);
      const a = u32(r);
      const m = u32(r);
      const c = u32(r);
      const arrays = [];
      for (let k = 0; k < a; k++) arrays.push(f64Array(ctx, c, 'morph.region'));
      const iblen = u32(r);
      if (iblen !== 4 * c) throw parseErr(r, `morph indices ${iblen} != 4*${c}`);
      const idx = new Uint32Array(c);
      for (let k = 0; k < c; k++) idx[k] = r.dv.getUint32(r.p + k * 4, true);
      r.p += iblen;
      (obj.morphRegions = obj.morphRegions || []).push({ name: regName, a, m, c, arrays, idx });
    }
  }

  function pSelfLighting(ctx, obj) {
    const r = ctx.r;
    pNode(ctx, obj);
    u32(r);
    r.p += 2;
    f64s(r, 9);
    u8(r);
    slot(ctx);
  }

  function pPortal(ctx) {
    const r = ctx.r;
    expect(r, 1, 'portal.a');
    expect(r, 1, 'portal.b');
    slot(ctx);
    const cnt = u32(r);
    const blen = u32(r);
    if (blen !== cnt * 4) throw parseErr(r, `portal indices ${blen} != 4*${cnt}`);
    r.p += blen;
  }

  function pPrim(ctx, obj) {
    const r = ctx.r;
    if (peek(r) !== 1) throw parseErr(r, 'prim lead ' + peek(r));
    if (peek(r, 4) === 0) {       /* index records: [1][0]([1][cnt][4*cnt][idx])* */
      u32(r); u32(r);
      obj.runsStart = r.p;        /* for write-back: records splice from here to obj.end */
      obj.runs = [];
      while (r.p + 12 <= r.len && peek(r) === 1 && peek(r, 8) === peek(r, 4) * 4) {
        u32(r);
        const cnt = u32(r);
        u32(r);
        const run = new Uint32Array(cnt);
        for (let i = 0; i < cnt; i++) run[i] = u32(r);
        obj.runs.push(run);
      }
      return;
    }
    const nxt = peek(r, 4);
    const cls = peek(r, 8);
    if (nxt === ctx.nextId && (ctx.classes.has(cls) || cls === nxt + 1)) {
      u32(r);                     /* container: [1][child prim] */
      slot(ctx);
      return;
    }
    throw parseErr(r, 'cannot classify prim payload');
  }

  /* Billboards (stock Cup/GNS/PTA/CTS models use them; brake-glow / flare cards
     that always face the camera). Node prefix, then a u32 flag, six f64 params
     (billboard axis vec3 + a trailing zero vec3), then a single child slot — the
     geometry that gets billboarded. We render the child as ordinary geometry; the
     camera-facing behaviour is a runtime effect the viewer doesn't need. */
  function pBillboard(ctx, obj) {
    pNode(ctx, obj);
    expect(ctx.r, 1, 'bb.flag');
    f64s(ctx.r, 6);
    slot(ctx);
  }

  const pEmpty = () => {};
  function pAppNode(ctx, obj) {
    const r = ctx.r;
    pNode(ctx, obj);
    expect(r, 1, 'appnode.ver');
    obj.appType = u32(r);
    const blen = u32(r);
    if (blen > r.len - r.p) throw parseErr(r, 'appnode data bytes ' + blen);
    obj.appData = new TextDecoder('latin1').decode(r.bytes.subarray(r.p, r.p + blen));
    r.p += blen;
    slot(ctx);
  }
  function pPointLight(ctx, obj) {
    const r = ctx.r;
    expect(r, 1, 'light.a');
    const ver = u32(r);
    if (ver !== 3) throw parseErr(r, `pointlight version ${ver}`);
    obj.falloff = r.dv.getFloat64(r.p, true); r.p += 8;
    const f32 = () => { const v = r.dv.getFloat32(r.p, true); r.p += 4; return v; };
    obj.diffuse = [f32(), f32(), f32()];
    obj.ambient = [f32(), f32(), f32()];
    obj.lightPos = Array.from(f64s(r, 3));
  }

  const PAYLOADS = {
    GroupDescriptor: pGroup,
    AppNodeDescriptor: pAppNode,
    StateSwitchDescriptor: pStateSwitch,
    LodSwitchDescriptor: pLodSwitch,
    TransformDescriptor: pTransform,
    AnimatedTransformDescriptor: pTransform,
    ShapeDescriptor: pShape,
    AppearanceDescriptor: pAppearance,
    TextureDescriptor: pTexture,
    GeometryDescriptor: pGeometry,
    PlainVertexListDescriptor: pVertexList,
    RegionMorphVertexListDescriptor: pRegionMorph,
    SelfLightingDescriptor: pSelfLighting,
    PortalDescriptor: pPortal,
    EmptyDescriptor: pEmpty,
    PointLightDescriptor: pPointLight,
    BillboardDescriptor: pBillboard,
    TriStripDescriptor: pPrim,
    TriFanDescriptor: pPrim,
    TriListDescriptor: pPrim,
  };

  /* ---------- mesh extraction ---------- */
  function rotXYZ(x, y, z, rx, ry, rz) {
    let c, s, t;
    if (rx) { c = Math.cos(rx); s = Math.sin(rx); t = y * c - z * s; z = y * s + z * c; y = t; }
    if (ry) { c = Math.cos(ry); s = Math.sin(ry); t = x * c + z * s; z = -x * s + z * c; x = t; }
    if (rz) { c = Math.cos(rz); s = Math.sin(rz); t = x * c - y * s; y = x * s + y * c; x = t; }
    return [x, y, z];
  }

  /* 3x3 rotation matrix equal to rotXYZ's x-then-y-then-z application (row
     major, applied as R·v). Euler angles cannot be summed down nested
     transform chains — driver rigs nest rotated limbs three deep — so poses
     compose as matrices.
     Pose euler slots are stored (rz, ry, rx) — Z angle first, X angle last.
     Solved against the FCRD NCS22 driver rig: only that slot order seats the
     limbs (hands on the wheel rim, legs to the pedals) and keeps the
     steering-wheel disc facing the driver — its stored "first" angle is the
     steering twist about the disc normal (+X), not a model-Z turn. */
  function rotMat(rx, ry, rz) {
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    return [
      cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
      sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
      -sy, cy * sx, cy * cx,
    ];
  }
  const MAT_IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const isIdentity = (m) => m === MAT_IDENTITY ||
    (m[0] === 1 && m[4] === 1 && m[8] === 1 && !m[1] && !m[2] && !m[3] && !m[5] && !m[6] && !m[7]);
  function matMul(a, b) {
    const out = new Array(9);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
      }
    }
    return out;
  }
  const matVec = (m, x, y, z) => [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ];

  function uvBox(uv) {
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < uv.u.length; i++) {
      if (uv.u[i] < uMin) uMin = uv.u[i]; if (uv.u[i] > uMax) uMax = uv.u[i];
      if (uv.v[i] < vMin) vMin = uv.v[i]; if (uv.v[i] > vMax) vMax = uv.v[i];
    }
    return { uMin, uMax, vMin, vMax };
  }

  /* card.mip add-on sub-meshes (splitters, trim) sometimes ship with no uv
     arrays — without coords WebGL samples (0,0). Planar-fit into a sibling
     part's uv box (same path, e.g. the main nose + nose trim). */
  function planarUvFallback(mesh, ref) {
    const box = uvBox(ref.uv);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const ext = [0, 0, 0];
    for (let i = 0; i < mesh.count; i++) {
      for (let a = 0; a < 3; a++) {
        const val = mesh.verts[i * 3 + a];
        if (val < min[a]) min[a] = val; if (val > max[a]) max[a] = val;
      }
    }
    for (let a = 0; a < 3; a++) ext[a] = max[a] - min[a];
    const order = [0, 1, 2].sort((a, b) => ext[b] - ext[a]);
    const [au, av] = [order[0], order[1]];
    const u = new Float64Array(mesh.count), v = new Float64Array(mesh.count);
    for (let i = 0; i < mesh.count; i++) {
      const fu = ext[au] > 1e-9 ? (mesh.verts[i * 3 + au] - min[au]) / ext[au] : 0.5;
      const fv = ext[av] > 1e-9 ? (mesh.verts[i * 3 + av] - min[av]) / ext[av] : 0.5;
      u[i] = box.uMin + fu * (box.uMax - box.uMin);
      v[i] = box.vMin + fv * (box.vMax - box.vMin);
    }
    return { u, v };
  }

  /* Showroom state for a StateSwitch: crash flags (hood_removed, lf_removed,
     rend_removed, ...) sit at 0, everything else (cockpitView, damaged,
     wheel_speed, roofFlapsEnable, day_night, ...) at its resting value 1.
     Track scenery uses Population / Weekend / Day_Night / etc. with higher
     thresholds (e.g. Population >= 2.9) — those default high so the full
     prop set is visible in the viewer.
     A child displays once the variable reaches its stored threshold, so
     switches guarding deployed roof/hood flaps (threshold 2, or 0.9 on a
     crash flag) render nothing in the showroom — matching the game.
     Returns the child index to draw, or -1 for none. */
  const SHOWROOM_STATE_EPS = 0.15;   /* 0.9 thresholds must pass a value of 1 */
  const TRACK_STATE_DEFAULTS = {
    population: 3,
    weekend: 3,
    day_night: 1,
    skyweather: 1,
    skysession: 1,
    randomsky: 1,
    caution_light: 2,
  };
  function showroomStateValue(variable, values, isTrackProp, dayNight, overrides) {
    const key = (variable || '').toLowerCase();
    /* caller-forced states (the sky loader probes SkySession/RandomSky/
       SkyWeather variants until one's textures actually resolve) */
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
    if (/_removed$/i.test(key)) return 0;
    /* night tracks pass dayNight=2 so day_night StateSwitches pick the night
       texture variant (the n*-prefixed sheets); day tracks stay at 1 */
    if (key === 'day_night' && dayNight != null) return dayNight;
    if (Object.prototype.hasOwnProperty.call(TRACK_STATE_DEFAULTS, key)) {
      return TRACK_STATE_DEFAULTS[key];
    }
    /* Unknown variables MUST rest at 1 on cars. roofFlapsEnable guards the
       crash-deployed pieces behind thresholds of 2 (45RF/90RF/RF_Ground,
       LHF/RHF, roof_flap/cowls) — a "first visible tier" values[0] fallback
       here sets that switch to 2 and deploys the flaps in the showroom.
       That regression shipped twice; a regression test pins it.
       Track props keep the values[0] fallback so unknown tiered scenery
       switches still show their first tier instead of vanishing. */
    if (isTrackProp && values && values.length) return values[0];
    return 1;
  }
  function showroomStateChild(o, isTrackProp, dayNight, overrides) {
    const values = o.stateValues;
    if (!values || values.length !== o.childIds.length) return 0;
    const value = showroomStateValue(o.variable, values, isTrackProp, dayNight, overrides);
    let pick = -1;
    for (let i = 0; i < values.length; i++) {
      if (value + SHOWROOM_STATE_EPS >= values[i]) pick = i;
    }
    return pick;
  }

  /* Walk the scene graph, picking the first state and highest-detail LOD,
     and bake transform poses into world-space triangle meshes. */
  function extractMeshes(parsed, opts = {}) {
    const lodAll = opts.allLods === true;
    const makeIdx = opts.carMakeIdx != null ? opts.carMakeIdx : 0;
    const paintedBody = opts.paintedBody === true;
    const isTrackProp = opts.trackProp === true;
    const dayNight = opts.dayNight;   /* 1=day, 2=night; picks day_night variants */
    let stateOverrides = opts.stateOverrides || null;   /* { lowercase var: value } */
    /* flapParts: extract the roof-flap subsystem (gated behind
       roofFlapsEnable >= 1.9, i.e. the game running with flaps on) and carry
       each vertex list's roof_flap_state morph region out on the meshes so
       the viewer can deploy the flaps live. Pieces come out at their CLOSED
       pose (morph value 0) — nothing deploys in the showroom. */
    const flapParts = opts.flapParts === true;
    if (flapParts) stateOverrides = { roofflapsenable: 2, ...(stateOverrides || {}) };
    const meshes = [];
    const lights = [];   /* PointLightDescriptors, world-posed (stadium towers) */
    /* frame: R (3x3 world rotation), T (world translation), plus the legacy
       euler-sum pos/rot kept only for the write-back handle (exact for the
       flat chains part replacement targets) */
    const visit = (id, frame, path) => {
      if (id === null || id === undefined) return;
      const o = parsed.objects.get(id);
      if (!o) return;
      const label = o.name || '';
      switch (o.cls) {
        case 'GroupDescriptor':
        case 'SelfLightingDescriptor':
        case 'AppNodeDescriptor':      /* environment params wrap the sky dome shape */
          o.childIds.forEach(k => visit(k, frame, label ? path.concat(label) : path));
          break;
        case 'StateSwitchDescriptor':
          if (o.childIds.length) {
            if (o.variable === 'carMakeIdx') {
              const idx = Math.max(0, Math.min(makeIdx, o.childIds.length - 1));
              visit(o.childIds[idx], frame, label ? path.concat(label) : path);
            } else {
              let f = frame;
              if (o.variable === 'animate_driver') f = { ...frame, driver: true };
              else if (flapParts && /^roofflapsenable$/i.test(o.variable || '')) f = { ...frame, flapPart: true };
              const idx = showroomStateChild(o, isTrackProp, dayNight, stateOverrides);
              if (idx >= 0) visit(o.childIds[idx], f, label ? path.concat(label) : path);
            }
          }
          break;
        case 'LodSwitchDescriptor': {
          const picks = lodAll ? o.childIds : o.childIds.slice(0, 1);
          picks.forEach(k => visit(k, frame, path));
          break;
        }
        case 'TransformDescriptor':
        case 'AnimatedTransformDescriptor': {
          const pose = o.pose || [0, 0, 0, 0, 0, 0];
          let Rn = rotMat(pose[5], pose[4], pose[3]);   /* slots are (rz,ry,rx) */
          /* Wheels are authored mirrored per side — rim detail faces local +X
             on left wheels and -X on right wheels — so one +90° turn about the
             vertical axis points both rims outboard (the sim orients them at
             runtime by node name; this emulates its rest pose). */
          if (/^[lr][fr]wheel$/i.test(label)) {
            Rn = matMul(Rn, rotMat(0, 0, Math.PI / 2));
          }
          const { R, T, pos, rot } = frame;
          const t = matVec(R, pose[0], pose[1], pose[2]);
          const p = rotXYZ(pose[0], pose[1], pose[2], rot[0], rot[1], rot[2]);
          const next = {
            R: matMul(R, Rn),
            T: [T[0] + t[0], T[1] + t[1], T[2] + t[2]],
            pos: [pos[0] + p[0], pos[1] + p[1], pos[2] + p[2]],
            rot: [rot[0] + pose[5], rot[1] + pose[4], rot[2] + pose[3]],
          };
          o.childIds.forEach(k => visit(k, next, label ? path.concat(label) : path));
          break;
        }
        case 'ShapeDescriptor': {
          let geo = null;
          let texture = null;
          for (const k of o.childIds) {
            const ko = k !== null && parsed.objects.get(k);
            if (!ko) continue;
            if (ko.cls === 'GeometryDescriptor') geo = ko;
            if (ko.cls === 'AppearanceDescriptor') {
              for (const t of ko.childIds) {
                const to = t !== null && parsed.objects.get(t);
                if (to && to.file && !texture) texture = to.file;
              }
            }
          }
          if (geo) emit(geo, frame, path.concat(label || 'shape'), texture);
          break;
        }
        case 'PointLightDescriptor':
          /* stadium/pole lights (night tracks). Transform the local light
             position into world space; colour/falloff kept for the renderer. */
          if (o.lightPos) {
            const lp = matVec(frame.R, o.lightPos[0], o.lightPos[1], o.lightPos[2]);
            lights.push({
              pos: [lp[0] + frame.T[0], lp[1] + frame.T[1], lp[2] + frame.T[2]],
              diffuse: o.diffuse, ambient: o.ambient, falloff: o.falloff,
            });
          }
          break;
        default:
          break;
      }
    };

    /* Primitives form a chain of containers (e.g. TriStrip > TriStrip > ... >
       TriList) whose terminal node stores one index record per chain node.
       Record 0 is the terminal's own primitive, then ancestors bottom-up, so
       record i takes the class of chain node (length-1-i). */
    const collectRuns = (o, out, chains) => {
      const chain = [];
      let node = o, runs = null, term = null;
      while (node) {
        chain.push(node.cls);
        if (node.runs) { runs = node.runs; term = node; break; }
        let next = null;
        for (const k of node.childIds) {
          const ko = k !== null && parsed.objects.get(k);
          if (ko && PRIM_CLASSES.includes(ko.cls)) { next = ko; break; }
        }
        node = next;
      }
      if (!runs) return;
      if (chains) chains.push({ termId: term.id, chain });
      runs.forEach((run, i) => {
        const cls = i < chain.length ? chain[chain.length - 1 - i] : chain[0];
        out.push({ cls, runs: [run] });
      });
    };

    const emit = (geo, frame, path, texture) => {
      let pvl = null;
      const primSets = [];
      const primChains = [];
      for (const k of geo.childIds) {
        const ko = k !== null && parsed.objects.get(k);
        if (!ko) continue;
        if (ko.cls.includes('VertexList')) pvl = ko;
        else if (PRIM_CLASSES.includes(ko.cls)) collectRuns(ko, primSets, primChains);
      }
      if (!pvl || !pvl.xyz || !pvl.xyz[0]) return;
      const { R, T, pos, rot } = frame;
      const n = pvl.verts;
      const verts = new Float64Array(n * 3);
      const [xs, ys, zs] = pvl.xyz;
      for (let i = 0; i < n; i++) {
        const p = matVec(R, xs[i], ys[i], zs[i]);
        verts[i * 3] = p[0] + T[0];
        verts[i * 3 + 1] = p[1] + T[1];
        verts[i * 3 + 2] = p[2] + T[2];
      }
      const tris = [];
      for (const { cls, runs } of primSets) {
        for (const run of runs) {
          if (cls === 'TriListDescriptor') {
            for (let i = 0; i + 2 < run.length; i += 3) tris.push(run[i], run[i + 1], run[i + 2]);
          } else if (cls === 'TriFanDescriptor') {
            for (let i = 1; i + 1 < run.length; i++) tris.push(run[0], run[i], run[i + 1]);
          } else {
            for (let i = 0; i + 2 < run.length; i++) {
              const a = run[i], b = run[i + 1], c = run[i + 2];
              if (a === b || b === c || a === c) continue;
              if (i % 2 === 0) tris.push(a, b, c); else tris.push(b, a, c);
            }
          }
        }
      }
      if (!tris.length) return;
      let normals = pvl.normals && pvl.normals[0]
        ? { x: pvl.normals[0], y: pvl.normals[1], z: pvl.normals[2] } : null;
      if (normals && !isIdentity(R)) {
        const nx = new Float64Array(n), ny = new Float64Array(n), nz = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          const v = matVec(R, normals.x[i], normals.y[i], normals.z[i]);
          nx[i] = v[0]; ny[i] = v[1]; nz[i] = v[2];
        }
        normals = { x: nx, y: ny, z: nz };
      }
      const uv = resolveUv(pvl, paintedBody);
      /* roof-flap deploy morph: region arrays are per-vertex DELTAS at full
         deploy (slots 0-2 position, 4-6 normal, matching the vertex-list
         layout); deployed = base + state * delta, state 0..1. Deltas are
         vectors, so they bake through R only (no translation). */
      let flapMorph = null;
      if (flapParts && pvl.morphRegions) {
        const rg = pvl.morphRegions.find((g) => /^roof_flap_state$/i.test(g.name || ''));
        if (rg && rg.arrays[0] && rg.arrays[1] && rg.arrays[2]) {
          const c = rg.c;
          const dx = new Float64Array(c), dy = new Float64Array(c), dz = new Float64Array(c);
          for (let i = 0; i < c; i++) {
            const d = matVec(R, rg.arrays[0][i], rg.arrays[1][i], rg.arrays[2][i]);
            dx[i] = d[0]; dy[i] = d[1]; dz[i] = d[2];
          }
          let dn = null;
          if (rg.arrays[4] && rg.arrays[5] && rg.arrays[6]) {
            dn = { x: new Float64Array(c), y: new Float64Array(c), z: new Float64Array(c) };
            for (let i = 0; i < c; i++) {
              const d = matVec(R, rg.arrays[4][i], rg.arrays[5][i], rg.arrays[6][i]);
              dn.x[i] = d[0]; dn.y[i] = d[1]; dn.z[i] = d[2];
            }
          }
          flapMorph = { idx: rg.idx, dx, dy, dz, dn };
        }
      }
      /* Flap-underside de-black runs GLOBALLY once every part is emitted
         (deblackFlapUnderside, just before this builder returns) so morphless
         dressing and pure-backing split nodes can borrow livery from a flap top
         elsewhere on the car — the per-part remap here could not reach them. */
      meshes.push({
        path: path.join('/'), texture, verts, count: n, tris, normals, uv,
        isDriver: !!frame.driver || /^DRIVERBODY$/i.test(path[0] || ''),
        isFlapPart: !!frame.flapPart,
        flapMorph,
        /* write-back handle: source objects + the transform baked into verts */
        src: { pvlId: pvl.id, pvlCls: pvl.cls, prims: primChains, pos: [...pos], rot: [...rot] },
      });
    };

    visit(parsed.rootId, { R: MAT_IDENTITY, T: [0, 0, 0], pos: [0, 0, 0], rot: [0, 0, 0] }, []);

    const cardRefByPath = new Map();
    for (const m of meshes) {
      if (m.uv && m.texture && /card\.mip/i.test(m.texture)) cardRefByPath.set(m.path, m);
    }
    for (const m of meshes) {
      const ref = cardRefByPath.get(m.path);
      if (!ref) continue;
      if (!m.texture) m.texture = ref.texture;
      if (!m.uv) m.uv = planarUvFallback(m, ref);
    }
    /* --- flap paint inherit (global pass) ---------------------------------
       Roof/hood flap panels ship with authored UVs on a dedicated grey template
       patch and often sit over the roof-hole alpha cutout on the .car paint
       sheet. Either reads grey or black in-game. Fix: steer every panel vert at
       the nearest up-facing BODY VERT on the shared card sheet in XY plan view
       (the painted skin beside the hole) so the flap always inherits livery.
       Dressing keeps authored UVs — its art lives on its own sheet. */
    (function inheritFlapPaintUvs() {
      const DRESSING = /ground|recess|backing|vent|floor|well|cavity|inner|under/i;
      const panels = meshes.filter((m) => (m.isFlapPart || m.flapMorph)
        && !(!m.flapMorph && DRESSING.test(m.path || ''))
        && m.uv && m.uv.u && m.tris && m.tris.length >= 3);
      if (!panels.length) return;
      const texKey = (t) => (t || '').toLowerCase();
      const isCard = (t) => /^card(?:_\d+)?\.mip$/i.test(texKey(t));
      const poolByTex = new Map();
      const pushVert = (key, x, y, z, u, v, nz) => {
        let pool = poolByTex.get(key);
        if (!pool) poolByTex.set(key, pool = []);
        pool.push(x, y, z, u, v, nz);
      };
      for (const m of meshes) {
        if (m.isFlapPart || m.flapMorph || m.isDriver) continue;
        if (!m.uv || !m.uv.u) continue;
        const key = texKey(m.texture);
        if (!key) continue;
        const nzArr = m.normals ? m.normals.z : null;
        for (let i = 0; i < m.count; i++) {
          const nz = nzArr ? nzArr[i] : 1;
          const x = m.verts[i * 3], y = m.verts[i * 3 + 1], z = m.verts[i * 3 + 2];
          const u = m.uv.u[i], v = m.uv.v[i];
          pushVert(key, x, y, z, u, v, nz);
          if (isCard(key)) pushVert('card.mip', x, y, z, u, v, nz);
        }
      }
      const cardTex = meshes.find((bm) => bm.texture && isCard(bm.texture))?.texture || null;
      for (const m of panels) {
        let pool = poolByTex.get(texKey(m.texture));
        let poolKey = texKey(m.texture);
        if ((!pool || !pool.length) && isCard(m.texture)) { pool = poolByTex.get('card.mip'); poolKey = 'card.mip'; }
        if ((!pool || !pool.length) && cardTex) { pool = poolByTex.get(texKey(cardTex)); poolKey = texKey(cardTex); }
        if (!pool || !pool.length) continue;
        const roofish = /roof|45rf|90rf|lhf|rhf|hood/i.test(m.path || '');
        const u2 = Float32Array.from(m.uv.u), v2 = Float32Array.from(m.uv.v);
        let borrowed = false;
        for (let d = 0; d < m.count; d++) {
          const px = m.verts[d * 3], py = m.verts[d * 3 + 1], pz = m.verts[d * 3 + 2];
          let bu = u2[d], bv = v2[d], bd = Infinity;
          for (let k = 0; k < pool.length; k += 6) {
            if (roofish && pool[k + 5] < 0.25) continue;
            const ddx = px - pool[k], ddy = py - pool[k + 1];
            const ddz = pz - pool[k + 2];
            /* roof/hood panels: match in 3D, not just XY — the old XY-only
               search grabbed door/fender UVs and painted the flap wrong. */
            if (roofish && Math.abs(ddz) > 0.35) continue;
            const dd = ddx * ddx + ddy * ddy + ddz * ddz * (roofish ? 6 : 1);
            if (dd < bd) { bd = dd; bu = pool[k + 3]; bv = pool[k + 4]; }
          }
          if (bd < Infinity) { u2[d] = bu; v2[d] = bv; borrowed = true; }
        }
        m.uv = { u: u2, v: v2 };
        /* UVs now index the body paint sheet — bind the same card texture the
           body uses, not the flap's grey template mip (wrong car / black hole). */
        if (borrowed && cardTex) m.texture = cardTex;
      }
    })();
    meshes.lights = lights;   /* side-channel: point lights found in this model */
    return meshes;
  }

  /* ---------- writers ---------- */
  function toOBJ(meshes) {
    const out = ['# RE2003 3do export'];
    let vb = 1;
    for (const m of meshes) {
      out.push('g ' + (m.path.replace(/\s+/g, '_') || 'mesh'));
      if (m.texture) out.push('usemtl ' + m.texture.replace(/\.[^.]+$/, ''));
      for (let i = 0; i < m.count; i++) {
        out.push(`v ${m.verts[i * 3].toFixed(6)} ${m.verts[i * 3 + 1].toFixed(6)} ${m.verts[i * 3 + 2].toFixed(6)}`);
      }
      if (m.uv) for (let i = 0; i < m.count; i++) {
        out.push(`vt ${m.uv.u[i].toFixed(6)} ${(1 - m.uv.v[i]).toFixed(6)}`);
      }
      if (m.normals) for (let i = 0; i < m.count; i++) {
        out.push(`vn ${m.normals.x[i].toFixed(6)} ${m.normals.y[i].toFixed(6)} ${m.normals.z[i].toFixed(6)}`);
      }
      for (let t = 0; t < m.tris.length; t += 3) {
        const f = [m.tris[t], m.tris[t + 1], m.tris[t + 2]].map(i => {
          const v = vb + i;
          if (m.uv && m.normals) return `${v}/${v}/${v}`;
          if (m.normals) return `${v}//${v}`;
          return String(v);
        });
        out.push('f ' + f.join(' '));
      }
      vb += m.count;
    }
    return out.join('\n') + '\n';
  }

  function toSTL(meshes) {
    let ntris = 0;
    for (const m of meshes) ntris += m.tris.length / 3;
    const buf = new ArrayBuffer(84 + ntris * 50);
    const dv = new DataView(buf);
    new Uint8Array(buf).set(new TextEncoder().encode('RE2003 3do export'), 0);
    dv.setUint32(80, ntris, true);
    let off = 84;
    for (const m of meshes) {
      for (let t = 0; t < m.tris.length; t += 3) {
        const [a, b, c] = [m.tris[t], m.tris[t + 1], m.tris[t + 2]];
        const ax = m.verts[a * 3], ay = m.verts[a * 3 + 1], az = m.verts[a * 3 + 2];
        const bx = m.verts[b * 3], by = m.verts[b * 3 + 1], bz = m.verts[b * 3 + 2];
        const cx = m.verts[c * 3], cy = m.verts[c * 3 + 1], cz = m.verts[c * 3 + 2];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        const vals = [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz];
        vals.forEach((v, i) => dv.setFloat32(off + i * 4, v, true));
        dv.setUint16(off + 48, 0, true);
        off += 50;
      }
    }
    return new Uint8Array(buf);
  }

  /* ---------- wireframe preview (side / top / front) ---------- */
  function drawViews(canvas, meshes) {
    const views = [['side', 0, 2], ['top', 0, 1], ['front', 1, 2]];
    const W = 300, H = 300;
    canvas.width = W * views.length;
    canvas.height = H;
    const g = canvas.getContext('2d');
    g.fillStyle = '#10141a';
    g.fillRect(0, 0, canvas.width, canvas.height);
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const m of meshes) {
      for (let i = 0; i < m.count; i++) {
        for (let a = 0; a < 3; a++) {
          const v = m.verts[i * 3 + a];
          if (v < min[a]) min[a] = v;
          if (v > max[a]) max[a] = v;
        }
      }
    }
    if (min[0] === Infinity) return;
    views.forEach(([label, ax, ay], vi) => {
      const cx = (min[ax] + max[ax]) / 2, cy = (min[ay] + max[ay]) / 2;
      const span = Math.max(max[ax] - min[ax], max[ay] - min[ay]) * 1.15 || 1;
      const sc = W / span;
      const ox = vi * W;
      g.strokeStyle = 'rgba(90,200,255,0.55)';
      g.lineWidth = 1;
      g.beginPath();
      for (const m of meshes) {
        for (let t = 0; t < m.tris.length; t += 3) {
          for (let e = 0; e < 3; e++) {
            const i = m.tris[t + e], j = m.tris[t + (e + 1) % 3];
            g.moveTo(ox + (m.verts[i * 3 + ax] - cx) * sc + W / 2, H / 2 - (m.verts[i * 3 + ay] - cy) * sc);
            g.lineTo(ox + (m.verts[j * 3 + ax] - cx) * sc + W / 2, H / 2 - (m.verts[j * 3 + ay] - cy) * sc);
          }
        }
      }
      g.stroke();
      g.fillStyle = '#9fb2c8';
      g.font = '12px system-ui';
      g.fillText(label, ox + 10, 18);
    });
  }

  return { parse, extractMeshes, toOBJ, toSTL, drawViews, rotXYZ };
})();

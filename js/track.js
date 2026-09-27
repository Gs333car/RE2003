/* Track folder loader: track.ini pit stalls, .ptf TSO placements, and
   dlong/dlat → world placement for parking the car in a pit stall. */
const Track = (() => {

  const baseName = (n) => n.replace(/\\/g, '/').split('/').pop().toLowerCase();

  function isTrackFolder(files) {
    const names = files.map(f => baseName(f.name || f.webkitRelativePath || ''));
    const hasIni = names.some(n => n === 'track.ini');
    const hasDat = names.some(n => n.endsWith('.dat'));
    const hasLp = names.some(n => n.endsWith('.lp'));
    const hasPtf = names.some(n => n.endsWith('.ptf'));   /* loose layout, no .dat needed */
    return hasIni && (hasDat || hasLp || hasPtf);
  }

  /* ---------- track.ini ---------- */
  function parseIni(text) {
    const sections = {};
    let cur = sections[''] = {};
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/;.*$/, '').trim();
      if (!line) continue;
      const sec = line.match(/^\[([^\]]+)\]$/);
      if (sec) {
        cur = sections[sec[1].trim().toLowerCase()] = {};
        continue;
      }
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim().toLowerCase();
      const val = line.slice(eq + 1).trim();
      cur[key] = val;
    }
    return sections;
  }

  /* physics environment from the track.ini — the [track] surface grip scales,
     air density (altitude + [weather] base temp), and a length-derived DEFAULT
     final drive. Everything here feeds Physics so the car is shaped by the
     track the way NR2003 shapes it, not a single global tune. */
  function parseEnv(iniText) {
    const sections = parseIni(iniText);
    const t = sections.track || {};
    const w = sections.weather || {};
    const num = (v, d) => {
      if (v == null) return d;
      const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
      return Number.isFinite(n) ? n : d;
    };
    const lengthMi = num(t.track_length, 0);
    const trackTypeRaw = parseInt(t.track_type, 10);

    /* air density: ISA altitude falloff (scale height ≈8500 m; NR track_altitude
       is in feet) × absolute-temperature ratio off the weather base temp — hot,
       high air is thinner. Scales BOTH downforce and drag (panelAero rho) and
       engine power (naturally-aspirated ∝ ρ), clamped to a sane racing band. */
    const altM = Math.max(0, num(t.track_altitude, 0)) * 0.3048;
    const baseTempF = num(w.track_base_temp, 77);
    const tempK = (baseTempF - 32) * 5 / 9 + 273.15;
    let airDensity = 1.225 * Math.exp(-altM / 8500) * (288.15 / Math.max(200, tempK));
    airDensity = Math.min(1.35, Math.max(0.85, airDensity));

    /* default final drive from track LENGTH — calibrated to real NASCAR gears
       (Martinsville 0.5mi≈7.1, Dover 1mi≈5.1, Charlotte 1.5mi≈4.3, Daytona
       2.5mi≈3.6): FD ≈ 5.4·len^-0.41. Used ONLY when a track ships no garage
       setup, so a setup-less short track no longer inherits Daytona's tall
       plate gear and pin 4th at 190 — it now revs its box out to size. */
    let defaultFinalDrive = null;
    if (lengthMi >= 0.2 && lengthMi <= 5) {
      let fd = 5.4 * Math.pow(lengthMi, -0.41);
      /* plate/draft superspeedways (≥2.4 mi: Daytona, Talladega) gear TALLER —
         low drag lets them top out below redline, so real gears run ~3.4–3.5 */
      if (lengthMi >= 2.4) fd *= 0.95;
      defaultFinalDrive = Math.min(7.3, Math.max(3.2, fd));
    }

    /* [weather] ambient wind → a world-frame velocity vector (m/s) for the
       aero. track_wind_direction = compass heading the wind blows FROM
       (degrees off true north); track_north_angle = where true north points
       in the track's XY frame. East is taken 90° clockwise from north — a
       documented sign assumption (being wrong only mirrors the wind). The
       AVERAGE speed is used; the exe randomizes per-session off the range. */
    const windMph = num(w.track_wind_speed, 0);
    const windFromDeg = num(w.track_wind_direction, 0);
    const northRad = num(t.track_north_angle, 0) * Math.PI / 180;
    const fromRad = windFromDeg * Math.PI / 180;
    const windMps = Math.min(15, Math.max(0, windMph)) * 0.44704;
    const fromX = Math.cos(northRad) * Math.cos(fromRad) + Math.sin(northRad) * Math.sin(fromRad);
    const fromY = Math.sin(northRad) * Math.cos(fromRad) - Math.cos(northRad) * Math.sin(fromRad);

    return {
      asphaltGrip: num(t.track_asphalt_grip, 1),
      concreteGrip: num(t.track_concrete_grip, 1),
      paintGrip: num(t.track_paint_grip, 1),
      tireWear: num(t.track_tire_wear, 1),
      tireHeat: num(t.track_tire_heat, 1),
      tireWearLoss: num(t.track_tire_wear_loss, 0.2),
      tireWearExp: num(t.track_tire_wear_exp, 1),
      pitSpeedMph: num((sections.pit_lane_0 || {}).speed_limit_mph, null),
      altitudeFt: num(t.track_altitude, 0),
      baseTempF,
      airDensity,
      windX: -fromX * windMps,        /* world-frame wind VELOCITY (m/s) */
      windY: -fromY * windMps,
      windMph,
      windFromDeg,
      trackType: Number.isFinite(trackTypeRaw) ? trackTypeRaw : null,
      lengthMi,
      defaultFinalDrive,
    };
  }

  function parseStalls(iniText) {
    const sections = parseIni(iniText);
    const lanes = [];
    for (const [name, sec] of Object.entries(sections)) {
      if (!/^pit_lane_\d+$/.test(name)) continue;
      const stalls = [];
      for (const [key, val] of Object.entries(sec)) {
        const m = key.match(/^stall_(\d+)$/);
        if (!m) continue;
        const nums = val.split(/[\s,]+/).map(Number).filter(n => !Number.isNaN(n));
        if (nums.length < 2) continue;
        stalls.push({
          index: Number(m[1]),
          dlong: nums[0],
          dlat: nums[1],
          heading: nums[2] || 0,
        });
      }
      stalls.sort((a, b) => a.index - b.index);
      if (stalls.length) {
        lanes.push({
          name,
          startDlong: parseFloat(sec.pit_lane_start_dlong) || 0,
          endDlong: parseFloat(sec.pit_lane_end_dlong) || 0,
          stalls,
        });
      }
    }
    const track = sections.track || {};
    return {
      name: (track.track_name_short || track.track_name || 'Track').replace(/\uFFFD/g, '').trim(),
      length: parseFloat(String(track.track_length || '0').replace(/[^\d.]/g, '')) || 0,
      /* max_starters caps the field NR2003 will run at this track (43 for Cup ovals).
         The viewer fills exactly this many pit stalls, no more. */
      maxStarters: parseInt(track.max_starters, 10) || 43,
      lanes,
    };
  }

  /* ---------- .ptf TSO references ---------- */
  function looksLikeString(dv, bytes, p) {
    if (p + 4 > bytes.length) return false;
    const n = dv.getUint32(p, true);
    if (n === 0) return true;
    if (n > 64 || p + 4 + n > bytes.length) return false;
    if (bytes[p + 4 + n - 1] !== 0) return false;
    for (let i = 0; i < n - 1; i++) {
      const c = bytes[p + 4 + i];
      if (c < 0x20 || c > 0x7e) return false;
    }
    return true;
  }

  function readStr(dv, bytes, p) {
    const n = dv.getUint32(p, true);
    const s = n ? new TextDecoder('latin1').decode(bytes.subarray(p + 4, p + 4 + n - 1)) : '';
    return { s, end: p + 4 + n };
  }

  /* Flat object scan (same grammar as .3do): recover every object's byte span
     without knowing class payloads, then read TSO / TSOReference heads. */
  function parsePtfObjects(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const classes = new Map();
    let nextId = 1;
    const objects = [];

    function objHeaderAt(p) {
      if (p + 8 > bytes.length) return null;
      const id = dv.getUint32(p, true), cls = dv.getUint32(p + 4, true);
      if (id !== nextId) return null;
      if (classes.has(cls)) {
        if (dv.getUint32(p + 8, true) !== 1) return null;
        if (!looksLikeString(dv, bytes, p + 12)) return null;
        return { id, cls, reg: false };
      }
      if (cls === id + 1 && looksLikeString(dv, bytes, p + 8)) {
        const n = dv.getUint32(p + 8, true);
        const q = p + 12 + n;
        if (dv.getUint32(q, true) === 1 && looksLikeString(dv, bytes, q + 4)) {
          return { id, cls, reg: true };
        }
      }
      return null;
    }

    let p = 0;
    while (p + 8 <= bytes.length) {
      const h = objHeaderAt(p);
      if (!h) break;
      let q = p + 8;
      let clsName;
      if (h.reg) {
        const r = readStr(dv, bytes, q);
        classes.set(h.cls, r.s);
        clsName = r.s;
        q = r.end;
        nextId += 2;
      } else {
        clsName = classes.get(h.cls);
        nextId += 1;
      }
      q += 4; /* nameFlag */
      const nm = readStr(dv, bytes, q);
      q = nm.end;
      const obj = { id: h.id, cls: clsName, name: nm.s, start: p, ps: q };
      objects.push(obj);
      let s = q;
      for (;;) {
        if (s + 8 > bytes.length) { obj.pe = bytes.length; p = bytes.length; break; }
        if (objHeaderAt(s)) { obj.pe = s; p = s; break; }
        s += 1;
      }
    }
    return { objects, dv, bytes };
  }

  function tsoName(dv, bytes, o) {
    /* TSODescriptor payload: [3][str name][str comment]... */
    if (o.pe - o.ps < 8) return null;
    if (dv.getUint32(o.ps, true) !== 3) return null;
    const n = dv.getUint32(o.ps + 4, true);
    if (n < 2 || n > 128 || o.ps + 8 + n > o.pe) return null;
    return new TextDecoder('latin1').decode(bytes.subarray(o.ps + 8, o.ps + 8 + n - 1));
  }

  function parseTsoRefs(ptfBytes) {
    const { objects, dv, bytes } = parsePtfObjects(ptfBytes);
    const tsoById = new Map();
    for (const o of objects) {
      if (o.cls !== 'TSODescriptor') continue;
      const name = tsoName(dv, bytes, o);
      if (name) tsoById.set(o.id, name);
    }
    const idx = new Map(objects.map((o, i) => [o.id, i]));
    const refs = [];
    for (const o of objects) {
      if (o.cls !== 'TSOReferenceDescriptor') continue;
      if (o.pe - o.ps < 52) continue;
      const pose = [];
      for (let k = 0; k < 6; k++) pose.push(dv.getFloat64(o.ps + 4 + 8 * k, true));
      let name = null;
      const nxt = objects[idx.get(o.id) + 1];
      if (nxt && nxt.cls === 'TSODescriptor' && nxt.ps < o.pe + 64) {
        name = tsoName(dv, bytes, nxt);
      } else {
        for (let p = o.ps + 52; p + 4 <= o.pe; p++) {
          const v = dv.getUint32(p, true);
          if (tsoById.has(v)) { name = tsoById.get(v); break; }
        }
      }
      if (name) refs.push({ name, pose });
    }
    return refs;
  }

  /* ---------- pit stall → world ----------
     Pit-lane TSO props (pit lights, flagger) form a spine in world space.
     Stall dlong is mapped along that spine; dlat offsets toward the garages. */
  function pitSpine(refs, lane) {
    const lights = refs.filter(r => /pitlight|flagger_pit/i.test(r.name));
    if (lights.length < 2) {
      const alt = refs.filter(r => /garage|pitbarrel|pit_road/i.test(r.name));
      if (alt.length < 2) return null;
      return buildSpine(alt.map(r => r.pose), lane);
    }
    return buildSpine(lights.map(r => r.pose), lane);
  }

  function buildSpine(poses, lane) {
    let cx = 0, cy = 0;
    for (const p of poses) { cx += p[0]; cy += p[1]; }
    cx /= poses.length; cy /= poses.length;
    const pts = poses.map(p => ({
      x: p[0], y: p[1], z: p[2] || 0,
      ang: Math.atan2(p[1] - cy, p[0] - cx),
    }));
    pts.sort((a, b) => a.ang - b.ang);
    const seg = [0];
    for (let i = 1; i < pts.length; i++) {
      seg.push(seg[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    }
    const total = seg[seg.length - 1] || 1;
    const lap = estimateLap(lane);
    return { pts, seg, total, lap, lane };
  }

  function estimateLap(lane) {
    if (!lane) return 4000;
    const a = lane.startDlong, b = lane.endDlong;
    if (a > b) return a + (a - b) * 0.05;
    return Math.max(a, b, 4000);
  }

  function pitParam(dlong, lane, lap) {
    const start = lane.startDlong;
    const end = lane.endDlong;
    let d = dlong - start;
    if (start > end) {
      if (d < 0) d += lap;
      const pitLen = (lap - start) + end;
      return Math.max(0, Math.min(1, d / Math.max(pitLen, 1)));
    }
    const pitLen = Math.abs(end - start) || 1;
    return Math.max(0, Math.min(1, (dlong - Math.min(start, end)) / pitLen));
  }

  function sampleSpine(spine, t) {
    const { pts, seg, total } = spine;
    const dist = t * total;
    let i = 0;
    while (i + 1 < seg.length && seg[i + 1] < dist) i++;
    const i1 = Math.min(i + 1, pts.length - 1);
    const span = (seg[i1] - seg[i]) || 1;
    const u = (dist - seg[i]) / span;
    const a = pts[i], b = pts[i1];
    const x = a.x + (b.x - a.x) * u;
    const y = a.y + (b.y - a.y) * u;
    const z = a.z + (b.z - a.z) * u;
    const tx = b.x - a.x, ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    return { x, y, z, tx: tx / len, ty: ty / len };
  }

  function stallWorld(stall, spine, trackLengthM) {
    if (!spine) {
      return { x: stall.dlong * 0.1, y: stall.dlat, z: 0, heading: stall.heading };
    }
    const lap = trackLengthM > 0 ? trackLengthM * 1609.344 : spine.lap;
    if (trackLengthM > 0) spine.lap = lap;
    const t = pitParam(stall.dlong, spine.lane, spine.lap);
    const s = sampleSpine(spine, t);
    const nx = -s.ty, ny = s.tx;
    const offset = Math.max(4, Math.min(18, Math.abs(stall.dlat) * 0.25));
    const towardOrigin = (s.x * nx + s.y * ny) > 0 ? -1 : 1;
    const x = s.x + nx * offset * towardOrigin;
    const y = s.y + ny * offset * towardOrigin;
    const heading = Math.atan2(s.ty, s.tx) + stall.heading;
    return { x, y, z: s.z, heading };
  }

  function randomStall(meta, refs) {
    const lane = meta.lanes[0];
    if (!lane || !lane.stalls.length) return null;
    const stall = lane.stalls[Math.floor(Math.random() * lane.stalls.length)];
    const spine = pitSpine(refs, lane);
    const world = stallWorld(stall, spine, meta.length);
    return { stall, lane: lane.name, world };
  }

  /* ---------- track surface decals (TrackDetailDescriptor) ----------
     NR2003 stamps graphics on the surface via TrackDetailDescriptor records:
     ~30 MATERIAL records (each holds a TextureDescriptor → a tsd_*.mip) and one
     GEOMETRY record per placed decal (a 244-byte AppearanceDescriptor, no texture
     child). A geometry record references its material by TEXTURE-OBJECT id at
     appearance +4, and stores its placement in TRACK space, packed as 4-aligned
     (not 8-aligned) f64: +132 dlong (centreline distance, m), +140 dlat (lateral
     offset, m), +148 width, +156 length, +164 rotation (rad, optional). Decoded
     from daytona.ptf — see DECODE-LOG F17. */
  function readTexName(dv, bytes, o) {
    const n = dv.getUint32(o.ps + 4, true);
    if (n < 2 || n > 128 || o.ps + 8 + n > o.pe) return null;
    return new TextDecoder('latin1').decode(bytes.subarray(o.ps + 8, o.ps + 8 + n - 1));
  }
  const DETAIL_OWNERS = new Set([
    'TrackDescriptor', 'TrackDetailDescriptor', 'TSODescriptor', 'SegmentDescriptor',
  ]);
  function parseDecals(ptfBytes) {
    const { objects, dv, bytes } = parsePtfObjects(ptfBytes);
    const texById = new Map();
    for (const o of objects) {
      if (o.cls !== 'TextureDescriptor') continue;
      const t = readTexName(dv, bytes, o);
      if (t) texById.set(o.id, t);
    }
    const decals = [];
    for (let i = 0; i < objects.length; i++) {
      if (objects[i].cls !== 'TrackDetailDescriptor') continue;
      let app = null, tex = null, last = null;
      for (let j = i + 1; j < objects.length; j++) {
        const c = objects[j];
        if (DETAIL_OWNERS.has(c.cls)) break;
        if (c.cls === 'AppearanceDescriptor' && !app) app = c;
        if (c.cls === 'TextureDescriptor' && !tex) tex = c;
        last = c;
      }
      if (!app || !last) continue;
      const texture = tex ? readTexName(dv, bytes, tex)
        : texById.get(dv.getUint32(app.ps + 4, true));
      if (!texture) continue;
      /* the payload terminates the record: find the marker pair closest to
         the window end (m1 = m0+36, quads end within a few slop bytes) */
      const W = last.ps, size = last.pe - last.ps;
      let m0 = -1;
      for (let off = size - 72; off >= 40; off--) {
        if (dv.getUint32(W + off, true) === 0x20 &&
            dv.getUint32(W + off + 36, true) === 0x20) { m0 = off; break; }
      }
      if (m0 < 0) continue;                    /* material-only record */
      const f8 = (o) => dv.getFloat64(W + o, true);
      const dlong = f8(m0 - 40), dlat = f8(m0 - 32);
      const len = f8(m0 - 24), wid = f8(m0 - 16), rot = f8(m0 - 8);
      const uq = [0, 1, 2, 3].map(k => f8(m0 + 4 + 8 * k));
      const vq = [0, 1, 2, 3].map(k => f8(m0 + 40 + 8 * k));
      if (![dlong, dlat, len, wid, rot].every(Number.isFinite)) continue;
      if (Math.abs(len) > 2000 || Math.abs(wid) > 2000 || len <= 0 || wid <= 0) continue;
      const quadOk = [...uq, ...vq].every(x => Number.isFinite(x) && Math.abs(x) < 1e5);
      decals.push({
        texture, dlong, dlat, len, wid, rot,
        uq: quadOk ? uq : null,
        vq: quadOk ? vq : null,
      });
    }
    return decals;
  }

  return {
    isTrackFolder,
    parseStalls,
    parseEnv,
    parseTsoRefs,
    parseDecals,
    parsePtfObjects,
    randomStall,
    stallWorld,
    pitSpine,
    baseName,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Track;

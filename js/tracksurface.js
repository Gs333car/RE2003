
const TrackSurface = (() => {

  const MAX_COORD = 50000;         /* plausibility bound for world x/y, m */
  const MAX_ELEV = 2000;           /* plausibility bound for elevations, m */
  const MAX_SEG_LEN = 3000;        /* one segment's chord length bound, m */
  const BLOCK_SCAN_MIN = 10;       /* modern tail: 10 bytes after the f64s */
  const BLOCK_SCAN_MAX = 360;      /* classic tail: groove arrays + records */
  const CHAIN_EPS = 1e-6;
  const SECTION_CLASSES = new Set([
    'SegmentDescriptor', 'X_SectionDescriptor', 'F_SectionDescriptor', 'W_SectionDescriptor',
  ]);

  function sixF64(dv, p) {
    if (p < 0) return null;
    const v = [];
    let trivial = 0;
    for (let i = 0; i < 6; i++) {
      const n = dv.getFloat64(p + 8 * i, true);
      if (!Number.isFinite(n)) return null;
      const a = Math.abs(n);
      if (a !== 0 && a < 1e-20) return null;    /* denormals = misaligned read */
      if (n === 0 || a === 1) trivial++;        /* uv arrays / list headers */
      v.push(n);
    }
    if (trivial > 2) return null;
    if (Math.abs(v[0]) > MAX_COORD || Math.abs(v[1]) > MAX_COORD ||
        Math.abs(v[3]) > MAX_COORD || Math.abs(v[4]) > MAX_COORD ||
        Math.abs(v[2]) > MAX_ELEV || Math.abs(v[5]) > MAX_ELEV) return null;
    const len = Math.hypot(v[3] - v[0], v[4] - v[1]);
    if (!(len > 0.001 && len < MAX_SEG_LEN)) return null;
    if (Math.abs(v[5] - v[2]) > Math.max(0.6 * len, 0.01)) return null; /* grade */
    return { x0: v[0], y0: v[1], z0: v[2], x1: v[3], y1: v[4], z1: v[5] };
  }

  /* The parent payload carries a raw geometry block just before each
     SegmentDescriptor: [x0 y0 z0 x1 y1 z1] as f64, wrapped in a prelude/tail
     that varies by Sandbox vintage (modern: [flag][f64s][10 zero bytes];
     classic: optional heading f64 up front, then record lists and a groove
     f32 array behind, all variable-length). Rather than hardcoding each
     vintage, enumerate every plausible f64×6 window in front of the header
     and let the exact chain constraint (segment end == next segment start,
     bit-identical doubles) pick the true alignment. */
  function blockCandidates(dv, start, lo) {
    const out = [];
    const max = Math.min(BLOCK_SCAN_MAX, start - lo);
    for (let off = BLOCK_SCAN_MIN; off <= max; off++) {
      const b = sixF64(dv, start - off - 48);
      if (b) {
        /* modern block is [Type:u32][x0..z1:f64×6]: 0 = straight, 1 = corner
           (arc). Kept per candidate so the winning block carries its type. */
        const flagPos = start - off - 52;
        b.type = flagPos >= 0 ? dv.getUint32(flagPos, true) : -1;
        out.push(b);
      }
    }
    return out;
  }

  const chains = (a, b) =>
    Math.abs(a.x1 - b.x0) < CHAIN_EPS &&
    Math.abs(a.y1 - b.y0) < CHAIN_EPS &&
    Math.abs(a.z1 - b.z0) < CHAIN_EPS;

  /* Pick one candidate per segment by longest-chain membership. Junk windows
     (zero-heavy constants shared between segments) also chain bit-exactly,
     but only in runs of 2-3 — the real geometry forms chains spanning the
     whole lap, so require a minimum run and take the longest through each
     segment. Two wrap-around passes let chains cross the lap seam. */
  const MIN_CHAIN_RUN = 4;
  function resolveBlocks(dv, objects, segIdx) {
    const cands = segIdx.map((i, k) => {
      const prevEnd = k > 0 ? objects[segIdx[k - 1]].start : 0;
      return blockCandidates(dv, objects[i].start, prevEnd);
    });
    const n = cands.length;
    const back = cands.map(list => list.map(() => 1));
    const fwd = cands.map(list => list.map(() => 1));
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < n; k++) {
        const pk = (k + n - 1) % n;
        cands[k].forEach((c, i) => {
          cands[pk].forEach((p, j) => {
            if (chains(p, c)) back[k][i] = Math.max(back[k][i], back[pk][j] + 1);
          });
        });
      }
      for (let k = n - 1; k >= 0; k--) {
        const nk = (k + 1) % n;
        cands[k].forEach((c, i) => {
          cands[nk].forEach((x, j) => {
            if (chains(c, x)) fwd[k][i] = Math.max(fwd[k][i], fwd[nk][j] + 1);
          });
        });
      }
    }
    return cands.map((list, k) => {
      let best = null, bestRun = 0;
      list.forEach((c, i) => {
        const run = back[k][i] + fwd[k][i] - 1;
        if (run > bestRun) { best = c; bestRun = run; }
      });
      return bestRun >= MIN_CHAIN_RUN ? best : null;
    });
  }

  function readTextureName(dv, u8, o) {
    /* [strTag][len][chars NUL] */
    const n = dv.getUint32(o.ps + 4, true);
    if (n < 2 || n > 128 || o.ps + 8 + n > o.pe) return null;
    return new TextDecoder('latin1').decode(u8.subarray(o.ps + 8, o.ps + 8 + n - 1));
  }

  function readUvQuad(dv, o) {
    const size = o.pe - o.ps;
    if (size < 84) return null;
    if (dv.getUint32(o.ps, true) !== 1) return null;
    const count = dv.getUint32(o.ps + 4, true);
    if (count !== 4) return null;
    const innerVer = dv.getUint32(o.ps + 8, true);
    const arrays = [];
    let p = o.ps + 12;
    for (let k = 0; k < 24 && p + 4 <= o.pe; k++) {
      if (innerVer < 3 && k === 4) { arrays.push(null, null, null, null); k += 3; continue; }
      const blen = dv.getUint32(p, true);
      p += 4;
      if (blen === 0) { arrays.push(null); continue; }
      if (blen !== count * 8 || p + blen > o.pe) return null;
      const q = [];
      for (let i = 0; i < count; i++) q.push(dv.getFloat64(p + 8 * i, true));
      p += blen;
      arrays.push(q.every(n => Number.isFinite(n) && Math.abs(n) < 1e5) ? q : null);
    }
    const u = arrays[0], v = arrays[1];       /* set A — arrays #1/#2  */
    const u2 = arrays[16], v2 = arrays[17];   /* set B — arrays #17/#18 */
    if (!u || !v) return null;
    return u2 && v2 ? { u, v, u2, v2 } : { u, v };
  }
  function wallFaceTexture(o, byId, dv, u8) {
    if (o.pe - o.ps < 8) return null;
    const ref = byId.get(dv.getUint32(o.ps + 4, true));
    return ref && ref.cls === 'TextureDescriptor' ? readTextureName(dv, u8, ref) : null;
  }
  function wallFacesSlotted(objects, dv, byId, u8, idx, count, recordEnd) {
    const objAt = new Map();
    for (let j = idx + 1; j < objects.length; j++) {
      const o = objects[j];
      if (SECTION_CLASSES.has(o.cls)) break;
      objAt.set(o.start, o);
    }
    /* object array index by start, for scanning a BY-REF appearance's
       inline children at its ORIGINAL location (possibly another wall) */
    const idxByStart = new Map(objects.map((o, j) => [o.start, j]));
    /* set A/B uv pair from a TC object */
    const uvOf = (tc) => {
      const q = readUvQuad(dv, tc);
      return q ? { uv: { u: q.u, v: q.v }, uv2: (q.u2 && q.v2) ? { u: q.u2, v: q.v2 } : null }
               : { uv: null, uv2: null };
    };
    /* texture (+ fallback uv) of an appearance wherever it lives: id ref at
       ps+4, else its inline TextureDescriptor children in stream order */
    const appearanceInfo = (app) => {
      const info = { texture: wallFaceTexture(app, byId, dv, u8), uv: null, uv2: null };
      let j = idxByStart.get(app.start);
      if (j == null) return info;
      for (j++; j < objects.length; j++) {
        const c = objects[j];
        if (c.start !== (objects[j - 1].pe ?? c.start) && c.cls !== 'TextureDescriptor' &&
            c.cls !== 'TextureCoordsDescriptor') break;
        if (c.cls === 'TextureDescriptor') {
          if (!info.texture) {
            const t = readTextureName(dv, u8, c);
            if (t && !/(^|[\\/])lm_/i.test(t)) info.texture = t;   /* skip lightmap refs */
          }
        } else if (c.cls === 'TextureCoordsDescriptor') {
          Object.assign(info, uvOf(c));
          break;
        } else break;
      }
      return info;
    };
    const startOfAnyObject = new Map(objects.map(o => [o.start, o]));
    const faces = [], spanTs = [];
    let p = recordEnd, ended = false;
    /* TC entry after a textured appearance: inline, by-ref, or null */
    const readTcEntry = (face) => {
      if (p + 4 > dv.byteLength) return;
      const c = objAt.get(p);
      if (c && c.cls === 'TextureCoordsDescriptor') {
        Object.assign(face, uvOf(c));
        p = c.pe;
        return;
      }
      const tcId = dv.getUint32(p, true);
      if (tcId === 0) { p += 4; return; }              /* TC read null */
      const tcRef = byId.get(tcId);
      if (tcRef && tcRef.cls === 'TextureCoordsDescriptor' && tcRef.start < p) {
        Object.assign(face, uvOf(tcRef));
        p += 4;
      }
      /* anything else: not a TC entry — leave p for the next slot/span */
    };
    /* Span t0 doubles are consumed into the PRECEDING object's indexed
       extent (the indexer frames objects up to the next header, and the
       t0 sits between a span's last TC and the next span's first
       appearance). Measured on the whole Daytona corpus: at every
       within-span TC→Appearance transition f64@(start−8) is exactly 0.0,
       while at real span boundaries it is the t0 fraction — perfect
       separation, so the lookback decides "next slot" vs "next span". */
    let pendingT0 = null;
    for (let g = 0; g < count && !ended; g++) {
      let t0;
      if (g === 0) {
        if (p + 8 > dv.byteLength) return null;
        t0 = dv.getFloat64(p, true);
        if (t0 !== 0) return null;               /* span 0 starts at exactly 0 */
        p += 8;
      } else if (pendingT0 !== null) {
        t0 = pendingT0;                           /* swallowed form (lookback) */
        pendingT0 = null;
        if (!(t0 > spanTs[g - 1] && t0 < 1)) return null;
      } else {
        /* raw form: t0 bytes not attached to any object (e.g. after a
           by-ref slot or a mid-list null) */
        if (p + 8 > dv.byteLength || startOfAnyObject.has(p)) { ended = true; break; }
        t0 = dv.getFloat64(p, true);
        if (!Number.isFinite(t0) || t0 <= spanTs[g - 1] || t0 >= 1) return null;
        p += 8;
      }
      spanTs.push(t0);
      for (let slot = 0; slot < 5 && !ended; slot++) {
        if (p + 4 > dv.byteLength) { ended = true; break; }
        const app = objAt.get(p);
        if (app && app.cls === 'AppearanceDescriptor') {
          /* span boundary? the swallowed t0 sits in the 8 bytes before
             this appearance; within a span those bytes are exactly 0.0 */
          if (g + 1 < count && slot > 0 && p >= 8) {
            const tCand = dv.getFloat64(p - 8, true);
            if (Number.isFinite(tCand) && tCand > spanTs[g] && tCand < 1) {
              pendingT0 = tCand;
              break;                       /* appearance = next span's slot 0 */
            }
          }
          const face = { slot, span: g, texture: wallFaceTexture(app, byId, dv, u8), uv: null, uv2: null };
          let textured = !!face.texture;
          p = app.pe;
          for (let guard = 0; guard < 8; guard++) {
            const c = objAt.get(p);
            if (c && c.cls === 'TextureDescriptor') {
              textured = true;
              if (!face.texture) {
                const t = readTextureName(dv, u8, c);
                if (t && !/(^|[\\/])lm_/i.test(t)) face.texture = t;   /* skip lightmaps */
              }
              p = c.pe;
              continue;
            }
            if (textured) readTcEntry(face);
            break;
          }
          faces.push(face);
          continue;
        }
        if (startOfAnyObject.has(p)) { ended = true; break; }  /* next section */
        const id = dv.getUint32(p, true);
        if (id === 0) { p += 4; continue; }      /* absent slot mid-list */
        const ref = byId.get(id);
        if (ref && ref.cls === 'AppearanceDescriptor' && ref.start < p) {
          /* by-ref appearance: texture/uv defaults from its original site */
          const info = appearanceInfo(ref);
          const face = { slot, span: g, texture: info.texture, uv: null, uv2: null };
          p += 4;
          if (info.texture) readTcEntry(face);
          if (!face.uv && info.uv) { face.uv = info.uv; face.uv2 = info.uv2; }
          faces.push(face);
          continue;
        }
        break;             /* not an object id: this span's slot list ended */
      }
    }
    /* every declared span must have parsed, or the slot/span attribution
       is untrustworthy — fall back to the legacy collector */
    if (spanTs.length !== count) return null;
    return faces.length ? { faces, spanTs } : null;
  }
  /* legacy fallback (pre-walker behavior): faces in stream order, slots
     assumed dense from 0 within equal-count spans, span ts from the 8 bytes
     before each span's first appearance header */
  function wallFacesLegacy(objects, byId, dv, u8, idx, count) {
    const faces = [];
    for (let j = idx + 1; j < objects.length; j++) {
      const o = objects[j];
      if (SECTION_CLASSES.has(o.cls)) break;
      if (o.cls === 'AppearanceDescriptor') {
        faces.push({ texture: wallFaceTexture(o, byId, dv, u8), uv: null, uv2: null, hdr: o.start });
      } else if (o.cls === 'TextureDescriptor') {
        const f = faces[faces.length - 1];
        if (f && !f.texture) {
          const t = readTextureName(dv, u8, o);
          if (t && !/(^|[\\/])lm_/i.test(t)) f.texture = t;
        }
      } else if (o.cls === 'TextureCoordsDescriptor') {
        const f = faces[faces.length - 1];
        if (f && !f.uv) {
          const q = readUvQuad(dv, o);
          if (q) {
            f.uv = { u: q.u, v: q.v };
            f.uv2 = (q.u2 && q.v2) ? { u: q.u2, v: q.v2 } : null;
          }
        }
      }
    }
    let spanTs = null;
    const per = count > 1 && faces.length % count === 0 ? faces.length / count : faces.length;
    if (count > 1 && faces.length % count === 0) {
      const ts = [];
      for (let s = 0; s < count; s++) {
        const hdr = faces[s * per].hdr;
        ts.push(hdr >= 8 ? dv.getFloat64(hdr - 8, true) : NaN);
      }
      const monotonic = ts.every((t, k) => Number.isFinite(t) && t >= 0 &&
        t < 1 && (k === 0 ? t === 0 : t > ts[k - 1]));
      if (monotonic) spanTs = ts;
    }
    faces.forEach((f, k) => { f.span = Math.floor(k / per); f.slot = k % per; });
    return { faces, spanTs };
  }

  /* texture + uv for one F/W section: scan its child window (everything up to
     the next section object). Appearances reference a shared texture by id or
     hold it inline as the next object. */
  function sectionMaterial(objects, byId, dv, u8, idx) {
    let texture = null, uv = null;
    for (let j = idx + 1; j < objects.length; j++) {
      const o = objects[j];
      if (SECTION_CLASSES.has(o.cls)) break;
      if (o.cls === 'TextureDescriptor' && !texture) {
        texture = readTextureName(dv, u8, o);
      } else if (o.cls === 'AppearanceDescriptor' && !texture && o.pe - o.ps >= 8) {
        const ref = byId.get(dv.getUint32(o.ps + 4, true));
        if (ref && ref.cls === 'TextureDescriptor') texture = readTextureName(dv, u8, ref);
      } else if (o.cls === 'TextureCoordsDescriptor' && !uv) {
        uv = readUvQuad(dv, o);
      }
      if (texture && uv) break;
    }
    return { texture, uv };
  }

  function parseSections(objects, byId, dv, u8, from, to) {
    const xsecs = [], strips = [], walls = [];
    for (let i = from; i < to; i++) {
      const o = objects[i];
      if (o.cls === 'X_SectionDescriptor') {
        if (o.pe - o.ps < 36) continue;
        xsecs.push({
          d0: dv.getFloat32(o.ps + 4, true), h0: dv.getFloat64(o.ps + 8, true),
          d1: dv.getFloat32(o.ps + 20, true), h1: dv.getFloat64(o.ps + 24, true),
          s0: dv.getFloat32(o.ps + 16, true), s1: dv.getFloat32(o.ps + 32, true),
        });
      } else if (o.cls === 'F_SectionDescriptor') {
        if (o.pe - o.ps < 12) continue;
        strips.push({
          d0: dv.getFloat32(o.ps + 4, true), d1: dv.getFloat32(o.ps + 8, true),
          straighten: (o.pe - o.ps) > 12 ? dv.getUint8(o.ps + 12) : 0,
          ...sectionMaterial(objects, byId, dv, u8, i),
        });
      } else if (o.cls === 'W_SectionDescriptor') {
        if (o.pe - o.ps < 33) continue;
        const h0 = dv.getFloat64(o.ps + 17, true);
        const h1 = dv.getFloat64(o.ps + 25, true);
        if (!Number.isFinite(h0) || !Number.isFinite(h1) || h0 < 0 || h0 > 60) continue;
        const size = o.pe - o.ps;
        const rd = (off, dflt) => {
          if (size < off + 8) return dflt;
          const v = dv.getFloat64(o.ps + off, true);
          return Number.isFinite(v) && v >= 0 && v < 10 ? v : dflt;
        };
        const bt0 = rd(33, 0), bt1 = rd(41, bt0);      /* render pair */
        const ct0 = rd(49, 0), ct1 = rd(57, ct0);      /* collision pair */
        let count = 1, recordEnd = o.pe;
        if (size >= 81) {
          let p = o.ps + 69;
          const flag = dv.getUint32(p, true);
          p += 4 + (flag === 1 ? 40 : 0);
          p += 4;                                     /* skip id */
          if (p + 4 <= o.pe) {
            const c = dv.getUint32(p, true);
            if (c >= 1 && c <= 64) count = c;
            recordEnd = p + 4;                        /* span records follow */
          }
        }
        /* slot-exact walk of the span stream (absent slots are 4-byte null
           tags; span t0 f64 precedes each span's slots — Daytona s/f wall:
           0 / 0.325 / 0.475). Falls back to the stream-order collector on
           any desync (older format versions). */
        const wf = wallFacesSlotted(objects, dv, byId, u8, i, count, recordEnd)
          || wallFacesLegacy(objects, byId, dv, u8, i, count);
        const faces = wf.faces;
        /* a wall with no textured faces is collision-only — the game renders
           nothing there (these were the phantom gray walls) */
        const firstTextured = faces.find((f) => f.texture);
        if (!firstTextured) continue;
        walls.push({
          d0: dv.getFloat32(o.ps + 4, true), d1: dv.getFloat32(o.ps + 8, true),
          h0, h1,
          straighten: u8[o.ps + 12],
          type: dv.getUint32(o.ps + 13, true),
          bt0, bt1, ct0, ct1, count, faces, spanTs: wf.spanTs,
          /* first face keeps the legacy single-texture consumers working */
          texture: firstTextured.texture, uv: firstTextured.uv,
        });
      }
    }
    const valid = (s) => Number.isFinite(s.d0) && Number.isFinite(s.d1) &&
      Math.abs(s.d0) < 20000 && Math.abs(s.d1) < 20000;
    xsecs.sort((a, b) => a.d0 - b.d0);
    strips.sort((a, b) => a.d0 - b.d0);
    return {
      xsecs: xsecs.filter(x => valid({ d0: x.d0, d1: x.d1 }) &&
        Math.abs(x.h0) < 1000 && Math.abs(x.h1) < 1000),
      strips: strips.filter(valid),
      walls: walls.filter(valid),
    };
  }

  /* → { segments: [{x0,y0,z0,x1,y1,z1,xsecs,strips,walls}], skippedSegments }
     Segments are in lap order; missing geometry blocks (typically only the
     first segment, whose block sits inside a longer lap-header prelude) are
     synthesized from the neighbours' chain ends. */
  function extract(ptfBytes) {
    const { objects, dv, bytes } = Track.parsePtfObjects(ptfBytes);
    const byId = new Map(objects.map(o => [o.id, o]));
    const segIdx = [];
    objects.forEach((o, i) => { if (o.cls === 'SegmentDescriptor') segIdx.push(i); });
    if (segIdx.length < 3) return { segments: [], skippedSegments: segIdx.length };

    const blocks = resolveBlocks(dv, objects, segIdx);
    const segments = [];
    for (let k = 0; k < segIdx.length; k++) {
      const i = segIdx[k];
      const sections = parseSections(objects, byId, dv, bytes,
        i + 1, segIdx[k + 1] ?? objects.length);
      /* The six-f64 geometry window that sits just BEFORE header k is the tail
         of segment k-1's payload — so section group k pairs with the block
         found before header k+1. Verified empirically on all 35 extractable
         tracks: drifting band rails (pit roads, aprons) drawn with block[k]
         zigzag 10-28 deg per seam; with block[k+1] they straighten to the
         authored smooth lines (e.g. BBMC Daytona pit wall becomes a constant
         -0.31..-0.40 m/m convergence instead of alternating -0.98/-0.05/-1.8).
         Stock ovals hid this because their bands barely drift. */
      segments.push({ block: null, ...sections });
    }
    for (let k = 0; k < segments.length; k++) {
      segments[k].block = blocks[(k + 1) % blocks.length];
    }

    /* fill missing blocks from the chain: end of previous == start of next */
    let skipped = 0;
    for (let k = 0; k < segments.length; k++) {
      if (segments[k].block) continue;
      const prev = segments[(k + segments.length - 1) % segments.length].block;
      const next = segments[(k + 1) % segments.length].block;
      const gap = prev && next &&
        Math.hypot(next.x0 - prev.x1, next.y0 - prev.y1);
      if (prev && next && gap < 400) {
        segments[k].block = {
          x0: prev.x1, y0: prev.y1, z0: prev.z1,
          x1: next.x0, y1: next.y0, z1: next.z0,
        };
      } else {
        skipped++;   /* isolated or spanning a chain break — drop it */
      }
    }
    const kept = segments.filter(s => s.block && s.xsecs.length >= 2);
    computeArcs(kept);
    return { segments: kept, skippedSegments: skipped };
  }
  const LOFT_PI = Math.PI, LOFT_2PI = 2 * Math.PI;
  const LOFT_HALF = 0.5, LOFT_ONE = 1.0, LOFT_3D = 3.0, LOFT_C3 = 3.0, LOFT_C6 = 6.0;
  function loftEdge(seg, latStart, latEnd, straighten) {
    const b = seg.block;
    const th0 = b.z0, th1 = b.z1;                 /* exact start/end tangents */
    const cos0 = Math.cos(th0), sin0 = Math.sin(th0);
    const cos1 = Math.cos(th1), sin1 = Math.sin(th1);
    let f11 = latStart;
    const f19 = b.x0 + (-sin0 * f11), f12 = b.y0 + cos0 * f11;   /* P0 = start frame @ latStart */
    let f14 = latEnd;
    const f13 = b.x0 + (-sin0 * f14), f15 = cos0 * f14 + b.y0;
    let f6 = b.x1 + (-sin1 * f11), f9 = b.y1 + cos1 * f11;
    f11 = b.x1 + (-sin1 * f14);                                   /* P1.x = end frame @ latEnd */
    f14 = cos1 * f14 + b.y1;                                       /* P1.y */
    const cx = [0, 0, 0, 0, 0], cy = [0, 0, 0, 0, 0];
    if (seg.type !== 0 && !straighten) {
      let f18 = Math.abs(th1 - th0);
      if (LOFT_PI < f18) f18 = LOFT_2PI - f18;
      let f20 = Math.sin(f18 * LOFT_HALF);
      f18 = Math.cos(f18 * LOFT_HALF);
      f20 = Math.abs(f20) * Math.abs(f20) * LOFT_3D;
      let f21 = Math.sqrt((f6 - f19) * (f6 - f19) + (f9 - f12) * (f9 - f12)) * (LOFT_ONE - Math.abs(f18));
      f21 = (f21 + f21) / f20;
      let f5 = f19 + cos0 * f21, f22 = sin0 * f21 + f12;
      const f23 = f5 * LOFT_C3;
      let f24 = (f6 - cos1 * f21) * LOFT_C3;
      f6 = ((f23 - f19) - f24) + f6;
      f5 = ((f19 * LOFT_C3) - f5 * LOFT_C6) + f24;
      const f7 = f23 - (f19 * LOFT_C3);
      let f8 = f22 * LOFT_C3;
      f21 = (f9 - sin1 * f21) * LOFT_C3;
      f9 = ((f8 - f12) - f21) + f9;
      const f10 = ((f12 * LOFT_C3) - f22 * LOFT_C6) + f21;
      f8 = f8 - f12 * LOFT_C3;
      let f18b = Math.sqrt((f11 - f13) * (f11 - f13) + (f14 - f15) * (f14 - f15)) * (LOFT_ONE - Math.abs(f18));
      f20 = (f18b + f18b) / f20;
      let f1 = f13 + cos0 * f20;
      f21 = sin0 * f20 + f15;
      const f16 = f1 * LOFT_C3;
      const f3 = (f11 - cos1 * f20) * LOFT_C3;
      const f17 = f13 * LOFT_C3;
      f1 = f1 * LOFT_C6;
      const f2 = f21 * LOFT_C3;
      f20 = (f14 - sin1 * f20) * LOFT_C3;
      const f4 = f15 * LOFT_C3;
      cx[0] = (((f16 - f13) - f3) + f11) - f6;
      cx[1] = ((f17 - f1) + f3 + f6) - f5;
      cx[2] = ((f16 - f17) + f5) - f7;
      cx[3] = (f13 + f7) - f19;
      cx[4] = f19;
      cy[0] = (((f2 - f15) - f20) + f14) - f9;
      cy[1] = ((f4 - f21 * LOFT_C6) + f20 + f9) - f10;
      cy[2] = ((f2 - f4) + f10) - f8;
      cy[3] = (f15 + f8) - f12;
      cy[4] = f12;
    } else {
      cx[4] = f19; cx[3] = f11 - f19;
      cy[4] = f12; cy[3] = f14 - f12;
    }
    /* cx/cy hold [t⁴, t³, t², t¹, t⁰] coefficients (the linear branch is the
       degenerate quartic c⁰=P0, c¹=P1−P0). Keep them for Horner evaluation. */
    return { linear: !(seg.type !== 0 && !straighten), cx, cy };
  }

  /* world XY of an edge (from loftEdge) at fraction t in [0,1]: Horner-evaluate
     the quartic. Exact for the linear branch too (degenerate coefficients). */
  function sampleEdge(edge, t) {
    const { cx, cy } = edge;
    return [
      (((cx[0] * t + cx[1]) * t + cx[2]) * t + cx[3]) * t + cx[4],
      (((cy[0] * t + cy[1]) * t + cy[2]) * t + cy[3]) * t + cy[4],
    ];
  }
  function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a <= -Math.PI) a += 2 * Math.PI; return a; }
  const ARC_MIN_TURN = 1e-4;                 /* heading change below this = straight */
  function computeArcs(segments) {
    for (const s of segments) {
      const b = s.block;
      const th0 = b.z0, dth = wrapPi(b.z1 - b.z0);
      const chord = Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
      s.th0 = th0;
      s.type = (Math.abs(dth) < ARC_MIN_TURN) ? 0 : 1;
      if (s.type === 0 || chord < 1e-9) { s.arc = null; continue; }
      /* circular arc: chord subtends |dth| at the centre, centre sits on the
         left normal of the start heading (right normal for a right-hand turn) */
      const R = chord / (2 * Math.sin(Math.abs(dth) / 2));
      const sgn = dth > 0 ? 1 : -1;
      const cx = b.x0 - sgn * R * Math.sin(th0);
      const cy = b.y0 + sgn * R * Math.cos(th0);
      s.arc = { cx, cy, r: R, phi0: Math.atan2(b.y0 - cy, b.x0 - cx), dth };
    }
    for (const s of segments) hermiteHeights(s);
  }
  function hermiteHeights(seg) {
    const b = seg.block;
    const chord = Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
    for (const x of seg.xsecs) {
      let L0 = chord, L1 = chord;
      if (seg.arc) {
        const sgn = seg.arc.dth > 0 ? 1 : -1;
        const adth = Math.abs(seg.arc.dth);
        L0 = adth * Math.max(1, seg.arc.r - sgn * x.d0);
        L1 = adth * Math.max(1, seg.arc.r - sgn * x.d1);
      }
      const m0 = Math.tan(x.s0 || 0) * L0;
      const m1 = Math.tan(x.s1 || 0) * L1;
      x.hc = [
        2 * (x.h0 - x.h1) + m0 + m1,        /* a3 */
        3 * (x.h1 - x.h0) - 2 * m0 - m1,    /* a2 */
        m0,                                  /* a1 */
        x.h0,                                /* a0 */
      ];
    }
  }

  const nodeH = (x, t) => x.hc
    ? ((x.hc[0] * t + x.hc[1]) * t + x.hc[2]) * t + x.hc[3]
    : x.h0 + (x.h1 - x.h0) * t;
  const nodeD = (x, t) => x.d0 + (x.d1 - x.d0) * t;

  /* height at fraction t along the segment, for a point whose lateral offset
     drifts dStart → dEnd: per-node cubic Hermite longitudinally, linear
     between the two bracketing profile nodes laterally (the game's model —
     physics record holds exactly {node cubic, delta-to-next cubic}).

     The lateral profile is C¹-ROUNDED at every node line with a small
     parabolic fillet (FILLET_HW, clamped to half the narrower adjacent
     strip). Raw piecewise-linear strips meet at slope CREASES — up to ~30°
     at banking/apron joints — and the point-sample car model turns a crease
     crossed at speed into an instant vertical-rate step: the whole car slams
     like it hit a curb ("invisible bumps", the spin-into-grass nose hit).
     Real wheels cross a joint one at a time and real joints have fillets;
     the parabola stays between the two planes (max deviation Δslope·W/4,
     ≈ cm-scale) and keeps height + slope continuous. */
  const FILLET_HW = 1.0;              /* m — fillet half-width per node side */
  const _haD = [];                    /* scratch: node lateral offsets */
  function heightAt(seg, dStart, dEnd, t) {
    const xs = seg.xsecs;
    if (!xs.length) return 0;
    const n = xs.length;
    const dq = dStart + (dEnd - dStart) * t;
    /* fast path: nodes laterally ascending (all real tracks) */
    let asc = true;
    for (let k = 0; k < n; k++) {
      const d = nodeD(xs[k], t);
      if (k && d < _haD[k - 1]) { asc = false; break; }
      _haD[k] = d;
    }
    if (asc) {
      if (dq <= _haD[0]) return nodeH(xs[0], t);
      if (dq >= _haD[n - 1]) return nodeH(xs[n - 1], t);
      let i = 0;
      while (_haD[i + 1] < dq) i++;
      const d0 = _haD[i], d1 = _haD[i + 1];
      const h0 = nodeH(xs[i], t), h1 = nodeH(xs[i + 1], t);
      const gap = d1 - d0;
      const base = gap < 1e-6 ? h0 : h0 + (h1 - h0) * ((dq - d0) / gap);
      /* fillet around the nearest INTERIOR node */
      const j = dq - d0 <= d1 - dq ? i : i + 1;
      if (j <= 0 || j >= n - 1) return base;
      const dj = _haD[j];
      const gapL = dj - _haD[j - 1], gapR = _haD[j + 1] - dj;
      const W = Math.min(FILLET_HW, 0.5 * Math.min(gapL, gapR));
      const x = dq - dj;
      if (W < 1e-4 || x <= -W || x >= W) return base;
      const hj = nodeH(xs[j], t);
      const sL = (hj - nodeH(xs[j - 1], t)) / gapL;
      const sR = (nodeH(xs[j + 1], t) - hj) / gapR;
      return hj + sL * x + (sR - sL) * (x + W) * (x + W) / (4 * W);
    }
    /* legacy bracket scan (unsorted profile — never seen on real tracks) */
    let lo = null, hi = null, loD = 0, hiD = 0;
    for (const x of xs) {
      const d = nodeD(x, t);
      if (d <= dq && (!lo || d > loD)) { lo = x; loD = d; }
      if (d >= dq && (!hi || d < hiD)) { hi = x; hiD = d; }
    }
    if (!lo && !hi) return 0;
    if (!lo) return nodeH(hi, t);
    if (!hi || lo === hi || hiD - loD < 1e-6) return nodeH(lo, t);
    const f = (dq - loD) / (hiD - loD);
    return nodeH(lo, t) + (nodeH(hi, t) - nodeH(lo, t)) * f;
  }

  /* nearest-point parameter u of (x, y) on a section's centreline — CLOSED
     FORM. Straights: linear projection. Arcs: the nearest point lies on the
     ray from the arc centre, so u comes straight from the angle. The old
     sampled searches quantised u (0.5–5% of a segment) and the height and
     banking normal under the car STAIRCASED through every turn — the
     mid-corner jitter (straights projected exactly, which is why it only
     showed in turns). Returns unclamped u; callers clamp to [0,1]. */
  function projectSegU(seg, x, y) {
    const b = seg.block;
    if (!b) return 0.5;
    if (!seg.arc) {
      const dx = b.x1 - b.x0, dy = b.y1 - b.y0;
      const l2 = dx * dx + dy * dy;
      return l2 > 1e-9 ? ((x - b.x0) * dx + (y - b.y0) * dy) / l2 : 0.5;
    }
    const a = seg.arc;
    const TWO_PI = Math.PI * 2;
    let d = Math.atan2(y - a.cy, x - a.cx) - a.phi0;
    d -= TWO_PI * Math.round(d / TWO_PI);          /* wrap to (−π, π] */
    /* pick the 2π wrap whose u lands nearest [0, 1] */
    const err = (v) => (v < 0 ? -v : v > 1 ? v - 1 : 0);
    let u = d / a.dth;
    for (const alt of [(d + TWO_PI) / a.dth, (d - TWO_PI) / a.dth]) {
      if (err(alt) < err(u)) u = alt;
    }
    return u;
  }

  /* centreline position + unit tangent at fraction u∈[0,1] along a section.
     Heading varies linearly with u along a circular arc, so the tangent is
     exactly (cos, sin) of the interpolated heading. */
  function sampleCenter(seg, u) {
    const b = seg.block;
    if (!seg.arc) {
      const th = seg.th0;
      return { x: b.x0 + (b.x1 - b.x0) * u, y: b.y0 + (b.y1 - b.y0) * u, z: 0,
        tx: Math.cos(th), ty: Math.sin(th) };
    }
    const a = seg.arc, phi = a.phi0 + a.dth * u, th = seg.th0 + a.dth * u;
    return { x: a.cx + a.r * Math.cos(phi), y: a.cy + a.r * Math.sin(phi), z: 0,
      tx: Math.cos(th), ty: Math.sin(th) };
  }

  /* how many sub-rings to loft a section into: 1 for straights, else enough to
     keep each face under ARC_FACE_DEG of arc (the game's ArcResolution) */
  const ARC_FACE_DEG = 5;
  const ARC_MAX_SUB = 24;
  const HEIGHT_SAG_TOL = 0.02;       /* m of allowed Hermite flattening error */
  function subRingCount(seg) {
    let n = 1;
    if (seg.arc) {
      const deg = Math.abs(seg.arc.dth) * 180 / Math.PI;
      n = Math.max(1, Math.min(ARC_MAX_SUB, Math.ceil(deg / ARC_FACE_DEG)));
    }
    /* grade/banking changes curve the height cubic even on straights — keep
       each face's flattening error under HEIGHT_SAG_TOL (error ~ sag/k²) */
    let sag = 0;
    for (const x of seg.xsecs) {
      const dev = Math.abs(nodeH(x, 0.5) - (x.h0 + x.h1) / 2);
      if (dev > sag) sag = dev;
    }
    if (sag > HEIGHT_SAG_TOL) {
      n = Math.max(n, Math.min(ARC_MAX_SUB, Math.ceil(Math.sqrt(sag / HEIGHT_SAG_TOL))));
    }
    return n;
  }

  /* height at dlat, linear between profile nodes (end = true → p1 profile) */
  function profileHeight(xsecs, dlat, end) {
    let lo = null, hi = null;
    for (const x of xsecs) {
      const d = end ? x.d1 : x.d0;
      if (d <= dlat && (!lo || d > (end ? lo.d1 : lo.d0))) lo = x;
      if (d >= dlat && (!hi || d < (end ? hi.d1 : hi.d0))) hi = x;
    }
    if (!lo && !hi) return 0;
    if (!lo) return end ? hi.h1 : hi.h0;
    if (!hi || lo === hi) return end ? lo.h1 : lo.h0;
    const [dl, hl] = end ? [lo.d1, lo.h1] : [lo.d0, lo.h0];
    const [dh, hh] = end ? [hi.d1, hi.h1] : [hi.d0, hi.h0];
    if (dh - dl < 1e-9) return hl;
    return hl + (hh - hl) * (dlat - dl) / (dh - dl);
  }

  return { extract, profileHeight, heightAt, sampleCenter, projectSegU, subRingCount, loftEdge, sampleEdge };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = TrackSurface;

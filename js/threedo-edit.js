/* .3do part replacement: import an STL, fit it into an existing part's
   bounding box, and splice the new geometry into the model's binary.

   The 3do object graph has sequential ids, so objects can never be added or
   removed — but payload arrays are length-prefixed, so a vertex list and a
   primitive's index records can be resized in place. We rewrite exactly two
   regions per part: the PlainVertexList payload (new vertex/normal/uv arrays,
   same array-presence pattern as the original) and the terminal primitive's
   index records (real indices go into the record whose chain class we can
   encode — TriList directly, TriStrip via degenerate stitching — the other
   records become empty). */
const ThreeDOEdit = (() => {

const MAX_REPLACE_TRIS = 60000;
const WARN_REPLACE_TRIS = 10000;
const WELD_DECIMALS = 5;

/* ---------- STL import ---------- */
function parseSTL(bytes) {
  const isAscii = (() => {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 5)).toLowerCase();
    if (head !== 'solid') return false;
    /* binary files may also start with "solid" — trust the size check */
    if (bytes.length >= 84) {
      const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true);
      if (84 + n * 50 === bytes.length) return false;
    }
    return true;
  })();
  const raw = isAscii ? parseAsciiSTL(bytes) : parseBinarySTL(bytes);
  return weld(raw);
}

function parseBinarySTL(bytes) {
  if (bytes.length < 84) throw new Error('not a valid STL file (too short)');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(80, true);
  if (84 + n * 50 > bytes.length) throw new Error('not a valid binary STL (truncated)');
  const tris = new Float64Array(n * 9);
  for (let i = 0; i < n; i++) {
    const off = 84 + i * 50 + 12;           /* skip facet normal */
    for (let k = 0; k < 9; k++) tris[i * 9 + k] = dv.getFloat32(off + k * 4, true);
  }
  return tris;
}

function parseAsciiSTL(bytes) {
  const text = new TextDecoder('latin1').decode(bytes);
  const nums = [];
  const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) nums.push(+m[1], +m[2], +m[3]);
  if (!nums.length || nums.length % 9 !== 0) throw new Error('not a valid ASCII STL');
  return Float64Array.from(nums);
}

/* STL repeats vertices per facet — weld by position for shared vertices
   (smaller output + smooth normals). */
function weld(triVerts) {
  const map = new Map();
  const verts = [];
  const tris = [];
  for (let i = 0; i < triVerts.length; i += 3) {
    const key = `${triVerts[i].toFixed(WELD_DECIMALS)},${triVerts[i + 1].toFixed(WELD_DECIMALS)},${triVerts[i + 2].toFixed(WELD_DECIMALS)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = verts.length / 3;
      verts.push(triVerts[i], triVerts[i + 1], triVerts[i + 2]);
      map.set(key, idx);
    }
    tris.push(idx);
  }
  /* drop degenerate triangles produced by welding */
  const clean = [];
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    if (a !== b && b !== c && a !== c) clean.push(a, b, c);
  }
  if (!clean.length) throw new Error('STL has no usable triangles');
  return { verts: Float64Array.from(verts), tris: clean, count: verts.length / 3 };
}

/* ---------- geometry helpers ---------- */
function bounds(verts, count) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = verts[i * 3 + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

function smoothNormals(verts, tris, count) {
  const nx = new Float64Array(count), ny = new Float64Array(count), nz = new Float64Array(count);
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    const ux = verts[b * 3] - verts[a * 3], uy = verts[b * 3 + 1] - verts[a * 3 + 1], uz = verts[b * 3 + 2] - verts[a * 3 + 2];
    const vx = verts[c * 3] - verts[a * 3], vy = verts[c * 3 + 1] - verts[a * 3 + 1], vz = verts[c * 3 + 2] - verts[a * 3 + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { nx[i] += fx; ny[i] += fy; nz[i] += fz; }
  }
  for (let i = 0; i < count; i++) {
    const l = Math.hypot(nx[i], ny[i], nz[i]) || 1;
    nx[i] /= l; ny[i] /= l; nz[i] /= l;
  }
  return { x: nx, y: ny, z: nz };
}

/* inverse of ThreeDO.rotXYZ (which applies x, then y, then z) */
function invRotXYZ(x, y, z, rx, ry, rz) {
  let c, s, t;
  if (rz) { c = Math.cos(-rz); s = Math.sin(-rz); t = x * c - y * s; y = x * s + y * c; x = t; }
  if (ry) { c = Math.cos(-ry); s = Math.sin(-ry); t = x * c + z * s; z = -x * s + z * c; x = t; }
  if (rx) { c = Math.cos(-rx); s = Math.sin(-rx); t = y * c - z * s; z = y * s + z * c; y = t; }
  return [x, y, z];
}

/* triangle list -> single tri strip, stitched with degenerate triangles */
function stripEncode(tris) {
  const out = [];
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    if (out.length) {
      out.push(out[out.length - 1], a);            /* degenerate bridge */
      if (out.length % 2 !== 0) out.push(a);       /* fix parity: tri starts on even index */
    }
    out.push(a, b, c);
  }
  return out;
}

/* ---------- binary building blocks ---------- */
function u32Bytes(values) {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => dv.setUint32(i * 4, v, true));
  return out;
}

function f64ArrayBytes(arr) {           /* [byteLen][f64...] ; null -> [0] */
  if (!arr) return u32Bytes([0]);
  const out = new Uint8Array(4 + arr.length * 8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, arr.length * 8, true);
  for (let i = 0; i < arr.length; i++) dv.setFloat64(4 + i * 8, arr[i], true);
  return out;
}

function recordBytes(indices) {         /* [1][cnt][4*cnt][idx...] */
  return u32Bytes([1, indices.length, indices.length * 4, ...indices]);
}

function concatBytes(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/* ---------- part replacement ---------- */
/* mesh: an entry from ThreeDO.extractMeshes (carries .src back-references).
   Returns { bytes, stats } where bytes is the whole rebuilt .3do. */
function replaceMeshGeometry(modelBytes, mesh, stlBytes) {
  const geom = parseSTL(stlBytes);
  if (geom.tris.length / 3 > MAX_REPLACE_TRIS) {
    throw new Error(`STL has ${geom.tris.length / 3} triangles — too heavy for a car part (max ${MAX_REPLACE_TRIS}). Decimate it in Blender first.`);
  }
  const parsed = ThreeDO.parse(modelBytes);
  const pvl = parsed.objects.get(mesh.src.pvlId);
  if (!pvl || pvl.cls !== 'PlainVertexListDescriptor') {
    throw new Error('this part uses a morphing vertex list — not replaceable (pick a body/panel part).');
  }

  /* fit the STL into the old part's world-space box: uniform scale, centered */
  const oldB = bounds(mesh.verts, mesh.count);
  const newB = bounds(geom.verts, geom.count);
  const oldExt = oldB.max.map((v, a) => v - oldB.min[a]);
  const newExt = newB.max.map((v, a) => v - newB.min[a]);
  let scale = Infinity;
  for (let a = 0; a < 3; a++) {
    if (newExt[a] > 1e-9) scale = Math.min(scale, (oldExt[a] || 1e-9) / newExt[a]);
  }
  if (!isFinite(scale)) throw new Error('STL geometry is degenerate (zero size).');
  const oldCen = oldB.min.map((v, a) => (v + oldB.max[a]) / 2);
  const newCen = newB.min.map((v, a) => (v + newB.max[a]) / 2);

  /* world -> part-local: undo the transform extractMeshes baked into verts */
  const { pos, rot } = mesh.src;
  const n = geom.count;
  const lx = new Float64Array(n), ly = new Float64Array(n), lz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const wx = (geom.verts[i * 3] - newCen[0]) * scale + oldCen[0];
    const wy = (geom.verts[i * 3 + 1] - newCen[1]) * scale + oldCen[1];
    const wz = (geom.verts[i * 3 + 2] - newCen[2]) * scale + oldCen[2];
    const [x, y, z] = invRotXYZ(wx - pos[0], wy - pos[1], wz - pos[2], rot[0], rot[1], rot[2]);
    lx[i] = x; ly[i] = y; lz[i] = z;
  }
  const wn = smoothNormals(geom.verts, geom.tris, n);
  const lnx = new Float64Array(n), lny = new Float64Array(n), lnz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = invRotXYZ(wn.x[i], wn.y[i], wn.z[i], rot[0], rot[1], rot[2]);
    lnx[i] = x; lny[i] = y; lnz[i] = z;
  }

  /* uvs: planar-project onto the two largest extents, mapped into the OLD
     part's uv box so the new part reuses the same texture region */
  let uArr = null, vArr = null;
  if (mesh.uv) {
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < mesh.count; i++) {
      const u = mesh.uv.u[i], v = mesh.uv.v[i];
      if (u < uMin) uMin = u; if (u > uMax) uMax = u;
      if (v < vMin) vMin = v; if (v > vMax) vMax = v;
    }
    const order = [0, 1, 2].sort((a, b) => newExt[b] - newExt[a]);
    const [au, av] = [order[0], order[1]];
    uArr = new Float64Array(n); vArr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const fu = newExt[au] > 1e-9 ? (geom.verts[i * 3 + au] - newB.min[au]) / newExt[au] : 0.5;
      const fv = newExt[av] > 1e-9 ? (geom.verts[i * 3 + av] - newB.min[av]) / newExt[av] : 0.5;
      uArr[i] = uMin + fu * (uMax - uMin);
      vArr[i] = vMin + fv * (vMax - vMin);
    }
  }

  /* new vertex-list payload, following the original array-presence pattern */
  const zeros = new Float64Array(n);
  const baseArrays = [lx, ly, lz, zeros, lnx, lny, lnz];
  const parts = [u32Bytes([1, 1, n])];
  for (let i = 0; i < 7; i++) parts.push(f64ArrayBytes(pvl.arrayPattern[i] ? baseArrays[i] : null));
  parts.push(u32Bytes([pvl.setsCount]));
  for (let s = 0; s < pvl.setsCount; s++) {
    for (let k = 0; k < 8; k++) {
      const pi = 7 + s * 8 + k;
      if (!pvl.arrayPattern[pi]) { parts.push(f64ArrayBytes(null)); continue; }
      if (s === 0 && k === 0) parts.push(f64ArrayBytes(uArr || zeros));
      else if (s === 0 && k === 1) parts.push(f64ArrayBytes(vArr || zeros));
      else parts.push(f64ArrayBytes(zeros));
    }
  }
  const newPvlPayload = concatBytes(parts);

  /* new index records per prim chain: real indices go into the first chain's
     best-encodable record, everything else becomes an empty record */
  const splices = [{ start: pvl.payloadStart, end: pvl.end, bytes: newPvlPayload }];
  let carried = false;
  for (const { termId, chain } of mesh.src.prims) {
    const term = parsed.objects.get(termId);
    const recs = [];
    for (let i = 0; i < chain.length; i++) {
      const cls = chain[chain.length - 1 - i];       /* record i's class */
      if (!carried && cls === 'TriListDescriptor') {
        recs.push(recordBytes(geom.tris));
        carried = true;
      } else if (!carried && cls === 'TriStripDescriptor' && !chain.includes('TriListDescriptor')) {
        recs.push(recordBytes(stripEncode(geom.tris)));
        carried = true;
      } else {
        recs.push(recordBytes([]));
      }
    }
    splices.push({ start: term.runsStart, end: term.end, bytes: concatBytes(recs) });
  }
  if (!carried) throw new Error('part has no TriList/TriStrip primitive to carry the new geometry.');

  /* splice all regions (sorted, non-overlapping) into a new byte stream */
  splices.sort((a, b) => a.start - b.start);
  const out = [];
  let cursor = 0;
  for (const s of splices) {
    if (s.start < cursor) throw new Error('internal: overlapping splice regions');
    out.push(modelBytes.subarray(cursor, s.start), s.bytes);
    cursor = s.end;
  }
  out.push(modelBytes.subarray(cursor));
  const bytes = concatBytes(out);

  /* self-check: the rebuilt model must re-parse cleanly before we commit */
  ThreeDO.parse(bytes);

  return {
    bytes,
    stats: {
      tris: geom.tris.length / 3,
      verts: n,
      scale,
      heavy: geom.tris.length / 3 > WARN_REPLACE_TRIS,
    },
  };
}

return { parseSTL, replaceMeshGeometry };
})();

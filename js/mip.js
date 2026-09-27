/* Papyrus .mip texture codec (NR2003-era, versions 2, 3 and 4 — same layout,
   v3 appears on legacy effect maps like slowspec.mip).
   Layout: 0x20 header, then one BMAP chunk per mipmap level, smallest first.
   Chunks are IFF-style with little-endian (reversed) tags, 4-byte aligned:
     PAMB [zero:4][size:4] { DHMB [zero:4][14] {type,w:4,h:4,rowBytes:2,?,?,dcl}
                             ATAD [zero:4][size:4] {payload} }
   Pixel types (verified against real mods):
     0x03 = RGB565      0x04 = ARGB1555    0x05 = ARGB4444
     0x06 = RGB888 (stored BGR, rows padded to 4-byte alignment)
     0x07 = ARGB8888 (stored BGRA little-endian)
     0x0a = DXT1 (8 B / 4x4 block)         0x0b = DXT3 (16 B / block)
   A level's dcl flag means its payload is PKWARE-DCL compressed (read via
   DCL.explode); we always write uncompressed, like WinMip2. */
const Mip = (() => {
  const HEADER_BYTES = 0x20;
  const TYPE_RGB565 = 0x03, TYPE_ARGB1555 = 0x04, TYPE_ARGB4444 = 0x05;
  const TYPE_RGB888 = 0x06, TYPE_ARGB8888 = 0x07;
  const TYPE_DXT1 = 0x0a, TYPE_DXT3 = 0x0b;

  const align4 = (n) => (n + 3) & ~3;
  const isDXT = (type) => type === TYPE_DXT1 || type === TYPE_DXT3;
  const blockBytes = (type) => type === TYPE_DXT1 ? 8 : 16;
  const rawBpp = (type) => type === TYPE_ARGB8888 ? 4 : 2;
  const rowStride = (type, w) => type === TYPE_RGB888 ? align4(w * 3) : w * rawBpp(type);
  const levelBytes = (type, w, h) => isDXT(type)
    ? Math.ceil(w / 4) * Math.ceil(h / 4) * blockBytes(type)
    : rowStride(type, w) * h;

  /* ---------- parse ---------- */
  function parse(bytes) {
    const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = d.getUint16(0, true);
    /* v2 (classic-era tracks) shares the exact 0x20 header + PAMB chunk layout */
    if (version !== 2 && version !== 3 && version !== 4) throw new Error('Unsupported .mip version ' + version);
    const levels = [];
    let pos = HEADER_BYTES;
    while (pos + 12 <= bytes.length) {
      if (new TextDecoder().decode(bytes.subarray(pos, pos + 4)) !== 'PAMB') break;
      const bmapSize = d.getUint32(pos + 8, true);
      const inner = pos + 12;
      const hSize = d.getUint32(inner + 8, true);       /* BMHD size (14) */
      const hd = inner + 12;
      const type = bytes[hd];
      const w = d.getUint32(hd + 1, true);
      const h = d.getUint32(hd + 5, true);
      const dclFlag = bytes[hd + hSize - 1];
      const dataChunk = inner + 12 + align4(hSize);
      const dataSize = d.getUint32(dataChunk + 8, true);
      const payload = bytes.subarray(dataChunk + 12, dataChunk + 12 + dataSize);
      levels.push({ type, w, h, dcl: dclFlag === 1, payload });
      pos += 12 + bmapSize;
      pos = align4(pos);
    }
    if (!levels.length) throw new Error('No BMAP levels found in .mip');
    return { header: bytes.slice(0, HEADER_BYTES), levels };
  }

  /* ---------- DXT decode ---------- */
  function rgb565(v) {
    return [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31];
  }

  function decodeRawLevel(level, raw) {
    const { w, h, type } = level;
    const img = new Uint8ClampedArray(w * h * 4);
    const d = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (type === TYPE_RGB888) {               /* BGR on disk, 4-aligned rows */
      const stride = rowStride(type, w);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const s = y * stride + x * 3, o = (y * w + x) * 4;
          img[o] = raw[s + 2]; img[o + 1] = raw[s + 1];
          img[o + 2] = raw[s]; img[o + 3] = 255;
        }
      }
      return new ImageData(img, w, h);
    }
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      if (type === TYPE_ARGB8888) {           /* BGRA on disk */
        img[o] = raw[i * 4 + 2]; img[o + 1] = raw[i * 4 + 1];
        img[o + 2] = raw[i * 4]; img[o + 3] = raw[i * 4 + 3];
        continue;
      }
      const v = d.getUint16(i * 2, true);
      if (type === TYPE_RGB565) {
        img[o] = ((v >> 11) & 31) * 255 / 31;
        img[o + 1] = ((v >> 5) & 63) * 255 / 63;
        img[o + 2] = (v & 31) * 255 / 31;
        img[o + 3] = 255;
      } else if (type === TYPE_ARGB1555) {
        img[o] = ((v >> 10) & 31) * 255 / 31;
        img[o + 1] = ((v >> 5) & 31) * 255 / 31;
        img[o + 2] = (v & 31) * 255 / 31;
        img[o + 3] = (v >> 15) * 255;
      } else {                                /* ARGB4444 */
        img[o] = ((v >> 8) & 15) * 17;
        img[o + 1] = ((v >> 4) & 15) * 17;
        img[o + 2] = (v & 15) * 17;
        img[o + 3] = ((v >> 12) & 15) * 17;
      }
    }
    return new ImageData(img, w, h);
  }

  function decodeLevel(level) {
    const raw = level.dcl ? DCL.explode(level.payload) : level.payload;
    const expected = levelBytes(level.type, level.w, level.h);
    if (raw.length < expected) throw new Error('MIP level truncated');
    if (!isDXT(level.type)) {
      if (level.type === TYPE_RGB565 || level.type === TYPE_ARGB1555 ||
          level.type === TYPE_ARGB4444 || level.type === TYPE_RGB888 ||
          level.type === TYPE_ARGB8888) {
        return decodeRawLevel(level, raw);
      }
      throw new Error('Unsupported .mip pixel type 0x' + level.type.toString(16));
    }
    const { w, h, type } = level;
    const img = new Uint8ClampedArray(w * h * 4);
    const d = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const bb = blockBytes(type);
    const bw = Math.ceil(w / 4);
    for (let by = 0; by < Math.ceil(h / 4); by++) {
      for (let bx = 0; bx < bw; bx++) {
        const off = (by * bw + bx) * bb;
        const colorOff = type === TYPE_DXT1 ? off : off + 8;
        const c0 = d.getUint16(colorOff, true), c1 = d.getUint16(colorOff + 2, true);
        const p0 = rgb565(c0), p1 = rgb565(c1);
        const pal = [p0, p1];
        if (type === TYPE_DXT1 && c0 <= c1) {
          pal.push(p0.map((v, i) => (v + p1[i]) / 2), [0, 0, 0]);
        } else {
          pal.push(p0.map((v, i) => (2 * v + p1[i]) / 3), p0.map((v, i) => (v + 2 * p1[i]) / 3));
        }
        const idxBits = d.getUint32(colorOff + 4, true);
        for (let py = 0; py < 4; py++) {
          for (let px = 0; px < 4; px++) {
            const x = bx * 4 + px, y = by * 4 + py;
            if (x >= w || y >= h) continue;
            const sel = (idxBits >> ((py * 4 + px) * 2)) & 3;
            const o = (y * w + x) * 4;
            const c = pal[sel];
            img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2];
            let alpha = 255;
            if (type === TYPE_DXT1 && c0 <= c1 && sel === 3) alpha = 0;
            if (type === TYPE_DXT3) {
              const nib = (d.getUint16(off + py * 2, true) >> (px * 4)) & 15;
              alpha = nib * 17;
            }
            img[o + 3] = alpha;
          }
        }
      }
    }
    return new ImageData(img, w, h);
  }

  /* Decode the largest level to ImageData. When maxDim is given, cap the chosen
     level to that dimension: these SD-pack tracks ship 4096×4096 surface sheets,
     and a track with dozens of them exhausts the browser's canvas/GPU memory —
     the backing stores get silently downscaled and colour-corrupted (grey asphalt
     renders as blue slabs). The game itself never rendered these at 4096; the .mip
     carries the whole mip chain, so we just pick the biggest level within the cap.
     `levels` is returned intact so mipChainFromLevels still sees the full chain. */
  function decode(bytes, maxDim) {
    const { levels } = parse(bytes);
    let pool = levels;
    if (maxDim) {
      const capped = levels.filter((l) => l.w <= maxDim && l.h <= maxDim);
      if (capped.length) pool = capped;
    }
    const biggest = pool.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
    return { imageData: decodeLevel(biggest), levels, biggest };
  }

  /* ---------- DXT encode (min/max endpoint picker) ---------- */
  function encodeBlockDXT(px, type, out, off) {
    /* px: 16 RGBA tuples. pick endpoints by luminance extremes */
    let lo = 0, hi = 0, loL = Infinity, hiL = -Infinity;
    for (let i = 0; i < 16; i++) {
      const l = px[i][0] * 0.299 + px[i][1] * 0.587 + px[i][2] * 0.114;
      if (l < loL) { loL = l; lo = i; }
      if (l > hiL) { hiL = l; hi = i; }
    }
    const to565 = (c) => ((c[0] >> 3) << 11) | ((c[1] >> 2) << 5) | (c[2] >> 3);
    let c0 = to565(px[hi]), c1 = to565(px[lo]);
    if (c0 < c1) { const t = c0; c0 = c1; c1 = t; }        /* 4-color mode */
    if (c0 === c1 && c0 > 0) c1 = c0 - 1;                  /* avoid 3-color mode */
    const p0 = rgb565(c0), p1 = rgb565(c1);
    const pal = [p0, p1,
      p0.map((v, i) => (2 * v + p1[i]) / 3),
      p0.map((v, i) => (v + 2 * p1[i]) / 3)];
    let idx = 0;
    for (let i = 0; i < 16; i++) {
      let best = 0, bestD = Infinity;
      for (let k = 0; k < 4; k++) {
        const dr = px[i][0] - pal[k][0], dg = px[i][1] - pal[k][1], db = px[i][2] - pal[k][2];
        const dd = dr * dr + dg * dg + db * db;
        if (dd < bestD) { bestD = dd; best = k; }
      }
      idx |= best << (i * 2);
    }
    const d = new DataView(out.buffer, out.byteOffset);
    const colorOff = type === TYPE_DXT1 ? off : off + 8;
    if (type === TYPE_DXT3) {
      for (let row = 0; row < 4; row++) {
        let nibbles = 0;
        for (let col = 0; col < 4; col++) {
          nibbles |= (px[row * 4 + col][3] >> 4) << (col * 4);
        }
        d.setUint16(off + row * 2, nibbles, true);
      }
    }
    d.setUint16(colorOff, c0, true);
    d.setUint16(colorOff + 2, c1, true);
    d.setUint32(colorOff + 4, idx >>> 0, true);
  }

  function encodeRawLevel(imageData, type) {
    const { width: w, height: h, data } = imageData;
    const out = new Uint8Array(levelBytes(type, w, h));
    const d = new DataView(out.buffer);
    if (type === TYPE_RGB888) {               /* BGR on disk, 4-aligned rows */
      const stride = rowStride(type, w);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4, s = y * stride + x * 3;
          out[s] = data[o + 2]; out[s + 1] = data[o + 1]; out[s + 2] = data[o];
        }
      }
      return out;
    }
    for (let i = 0; i < w * h; i++) {
      const [r, g, b, a] = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]];
      if (type === TYPE_ARGB8888) {
        out[i * 4] = b; out[i * 4 + 1] = g; out[i * 4 + 2] = r; out[i * 4 + 3] = a;
      } else if (type === TYPE_RGB565) {
        d.setUint16(i * 2, ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3), true);
      } else if (type === TYPE_ARGB1555) {
        d.setUint16(i * 2, (a >= 128 ? 0x8000 : 0) | ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3), true);
      } else {                                /* ARGB4444 */
        d.setUint16(i * 2, ((a >> 4) << 12) | ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4), true);
      }
    }
    return out;
  }

  function encodeLevel(imageData, type) {
    if (!isDXT(type)) return encodeRawLevel(imageData, type);
    const { width: w, height: h, data } = imageData;
    const bb = blockBytes(type);
    const out = new Uint8Array(levelBytes(type, w, h));
    const bw = Math.ceil(w / 4);
    const px = new Array(16);
    for (let by = 0; by < Math.ceil(h / 4); by++) {
      for (let bx = 0; bx < bw; bx++) {
        for (let py = 0; py < 4; py++) {
          for (let pxi = 0; pxi < 4; pxi++) {
            const x = Math.min(bx * 4 + pxi, w - 1), y = Math.min(by * 4 + py, h - 1);
            const o = (y * w + x) * 4;
            px[py * 4 + pxi] = [data[o], data[o + 1], data[o + 2], data[o + 3]];
          }
        }
        encodeBlockDXT(px, type, out, (by * bw + bx) * bb);
      }
    }
    return out;
  }

  /* ---------- write ---------- */
  function writeChunk(parts, tag, payload) {
    const hdr = new Uint8Array(12);
    new TextEncoder().encodeInto(tag, hdr);
    new DataView(hdr.buffer).setUint32(8, payload.length, true);
    parts.push(hdr, payload);
    const pad = align4(payload.length) - payload.length;
    if (pad) parts.push(new Uint8Array(pad).fill(0x20));  /* Papyrus pads with spaces */
    return 12 + align4(payload.length);
  }

  /* Rebuild a .mip from a donor (header + level structure preserved) and a
     source canvas of the same dimensions as the donor's largest level. */
  function encodeLike(donorBytes, canvas) {
    const donor = parse(donorBytes);
    const biggest = donor.levels.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
    if (canvas.width !== biggest.w || canvas.height !== biggest.h) {
      throw new Error(`Image must be ${biggest.w}×${biggest.h} to replace this texture`);
    }
    /* progressively downscale for each level */
    const scaled = new Map();
    const levelCanvas = (w, h) => {
      const key = w + 'x' + h;
      if (scaled.has(key)) return scaled.get(key);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(canvas, 0, 0, w, h);
      scaled.set(key, c);
      return c;
    };

    const parts = [donorBytes.slice(0, HEADER_BYTES)];
    for (const lvl of donor.levels) {
      const src = levelCanvas(lvl.w, lvl.h);
      const imageData = src.getContext('2d').getImageData(0, 0, lvl.w, lvl.h);
      const payload = encodeLevel(imageData, lvl.type);

      const bmhd = new Uint8Array(14);
      const hv = new DataView(bmhd.buffer);
      bmhd[0] = lvl.type;
      hv.setUint32(1, lvl.w, true);
      hv.setUint32(5, lvl.h, true);
      hv.setUint16(9, isDXT(lvl.type)
        ? Math.ceil(lvl.w / 4) * blockBytes(lvl.type) / 4
        : rowStride(lvl.type, lvl.w), true);
      /* bytes 11..13 flags: zero = uncompressed */

      const innerParts = [];
      let innerSize = 0;
      innerSize += writeChunk(innerParts, 'DHMB', bmhd);
      innerSize += writeChunk(innerParts, 'ATAD', payload);

      const bmapHdr = new Uint8Array(12);
      new TextEncoder().encodeInto('PAMB', bmapHdr);
      new DataView(bmapHdr.buffer).setUint32(8, innerSize, true);
      parts.push(bmapHdr, ...innerParts);
    }
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  return { parse, decode, decodeLevel, encodeLike, TYPE_DXT1, TYPE_DXT3 };
})();

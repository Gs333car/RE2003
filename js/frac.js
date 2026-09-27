/* Papyrus .car container ("FRAC" chunk format, verified against real carsets).
   FRAC [zero:4][size:4] wraps 4-byte-aligned chunks:
     PYTC — car type flags        INIC — INI text (driver / AI settings)
     XETC — paint texture (.mip)  WERC — crew texture (.mip)
   Tags read reversed: CTYP, CINI, CTEX, CREW. */
const Frac = (() => {
  const align4 = (n) => (n + 3) & ~3;
  const TAG_LABELS = {
    PYTC: 'Car type flags', INIC: 'Driver & AI settings (INI)',
    XETC: 'Paint texture (.mip)', WERC: 'Crew texture (.mip)',
  };

  function parse(bytes) {
    const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dec = new TextDecoder('latin1');
    if (dec.decode(bytes.subarray(0, 4)) !== 'FRAC') throw new Error('Not a .car (FRAC) file');
    const end = 12 + d.getUint32(8, true);
    const chunks = [];
    let pos = 12;
    while (pos + 12 <= Math.min(end, bytes.length)) {
      const tag = dec.decode(bytes.subarray(pos, pos + 4));
      const size = d.getUint32(pos + 8, true);
      chunks.push({ tag, label: TAG_LABELS[tag] || tag, data: bytes.subarray(pos + 12, pos + 12 + size) });
      pos = align4(pos + 12 + size);
    }
    if (!chunks.length) throw new Error('Empty .car file');
    return { chunks };
  }

  function build(chunks) {
    const enc = new TextEncoder();
    /* chunks are 4-byte aligned between each other; no padding after the last */
    let inner = 0;
    chunks.forEach((c, i) => {
      const raw = 12 + c.data.length;
      inner += i < chunks.length - 1 ? align4(raw) : raw;
    });
    const out = new Uint8Array(12 + inner).fill(0x20);  /* Papyrus pads with spaces */
    const d = new DataView(out.buffer);
    out.fill(0, 0, 12);
    enc.encodeInto('FRAC', out);
    d.setUint32(8, inner, true);
    let pos = 12;
    for (const c of chunks) {
      out.fill(0, pos, pos + 12);
      enc.encodeInto(c.tag, out.subarray(pos, pos + 4));
      d.setUint32(pos + 8, c.data.length, true);
      out.set(c.data, pos + 12);
      pos = align4(pos + 12 + c.data.length);
    }
    return out;
  }

  /* car_make in the INIC chunk selects which carMakeIdx branch a .car paint targets. */
  function carMake(bytes) {
    const { chunks } = parse(bytes);
    const ini = chunks.find(c => c.tag === 'INIC');
    if (!ini) return 0;
    const m = new TextDecoder('latin1').decode(ini.data).match(/car_make\s*=\s*(\d+)/i);
    return m ? parseInt(m[1], 10) : 0;
  }

  return { parse, build, carMake };
})();

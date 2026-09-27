/* Minimal ZIP writer/reader — no dependencies.
   Write: deflate via CompressionStream when available, else STORE.
   Read: STORE + deflate via DecompressionStream. */
const Zip = (() => {
  const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_EOCD = 0x06054b50;
  const METHOD_STORE = 0, METHOD_DEFLATE = 8;

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(data) {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function pipeThrough(data, stream) {
    const out = new Response(new Blob([data]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
  }

  const deflate = (data) => pipeThrough(data, new CompressionStream('deflate-raw'));
  const inflate = (data) => pipeThrough(data, new DecompressionStream('deflate-raw'));
  const canDeflate = typeof CompressionStream !== 'undefined';

  function dosDateTime(date) {
    const d = date || new Date();
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  /* entries: [{ name: 'path/in/zip.ext', data: Uint8Array|string }] -> Blob */
  async function build(entries) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const { time, date } = dosDateTime();

    for (const entry of entries) {
      const raw = typeof entry.data === 'string' ? enc.encode(entry.data) : entry.data;
      const nameBytes = enc.encode(entry.name);
      const crc = crc32(raw);
      let stored = raw, method = METHOD_STORE;
      if (canDeflate && raw.length > 64) {
        const packed = await deflate(raw);
        if (packed.length < raw.length) { stored = packed; method = METHOD_DEFLATE; }
      }

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, SIG_LOCAL, true);
      local.setUint16(4, 20, true);
      local.setUint16(8, method, true);
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, stored.length, true);
      local.setUint32(22, raw.length, true);
      local.setUint16(26, nameBytes.length, true);
      parts.push(new Uint8Array(local.buffer), nameBytes, stored);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, SIG_CENTRAL, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(10, method, true);
      cd.setUint16(12, time, true);
      cd.setUint16(14, date, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, stored.length, true);
      cd.setUint32(24, raw.length, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), nameBytes);
      offset += 30 + nameBytes.length + stored.length;
    }

    let centralSize = 0;
    for (const c of central) centralSize += c.length;
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, SIG_EOCD, true);
    eocd.setUint16(8, entries.length, true);
    eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)],
      { type: 'application/zip' });
  }

  /* ArrayBuffer -> [{ name, data: Uint8Array, isDir }] */
  async function read(buffer) {
    const d = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const dec = new TextDecoder();

    let eocd = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 66000); i--) {
      if (d.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid zip file');
    const count = d.getUint16(eocd + 10, true);
    let p = d.getUint32(eocd + 16, true);

    const entries = [];
    for (let n = 0; n < count; n++) {
      if (d.getUint32(p, true) !== SIG_CENTRAL) break;
      const method = d.getUint16(p + 10, true);
      const compSize = d.getUint32(p + 20, true);
      const nameLen = d.getUint16(p + 28, true);
      const extraLen = d.getUint16(p + 30, true);
      const commentLen = d.getUint16(p + 32, true);
      const localOffset = d.getUint32(p + 42, true);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));

      const lNameLen = d.getUint16(localOffset + 26, true);
      const lExtraLen = d.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const comp = bytes.slice(dataStart, dataStart + compSize);

      let data;
      if (name.endsWith('/')) data = new Uint8Array(0);
      else if (method === METHOD_STORE) data = comp;
      else if (method === METHOD_DEFLATE) data = await inflate(comp);
      else throw new Error('Unsupported zip compression method ' + method + ' in ' + name);

      entries.push({ name, data, isDir: name.endsWith('/') });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  return { build, read, download, crc32 };
})();

/* Papyrus .dat archive (NR2003-era variant, verified against real mod files).
   Layout: [header:10 bytes — uint32 id/checksum + 6 zero bytes, preserved
   verbatim on rebuild], then directory entries until the first file offset:
     [type:u16] [uncompSize:u32] [storedSize:u32] [offset:u32]
     [nameLen:u8] [name] [NUL]
   type 5 = stored (both sizes equal); type 517 (5 | 0x200) = PKWARE-DCL
   compressed (seen in CWS2015 / FCRD NCS22 model entries — decode with
   DCL.explode, same codec as compressed .mip levels).
   File payloads are stored back-to-back after the directory.
   Rebuild always writes stored entries — the game reads both. */
const Dat = (() => {
  const HEADER_BYTES = 10;
  const TYPE_STORED = 5;
  const TYPE_DCL = 5 | 0x200;

  function parse(bytes) {
    const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dec = new TextDecoder('latin1');
    const entries = [];
    const skipped = [];
    let pos = HEADER_BYTES;
    let firstOffset = null;
    while (firstOffset === null || pos < firstOffset) {
      if (pos + 15 > bytes.length) throw new Error('Corrupt .dat directory');
      const type = d.getUint16(pos, true);
      const uncompSize = d.getUint32(pos + 2, true);
      const storedSize = d.getUint32(pos + 6, true);
      const offset = d.getUint32(pos + 10, true);
      const nameLen = bytes[pos + 14];
      const name = dec.decode(bytes.subarray(pos + 15, pos + 15 + nameLen));
      pos += 16 + nameLen;
      if (type !== TYPE_STORED && type !== TYPE_DCL) {
        throw new Error(`Unsupported .dat entry "${name}" (type ${type})`);
      }
      if (firstOffset === null) firstOffset = offset;
      if (offset + storedSize > bytes.length) {
        /* truncated archive (seen: martinsville.dat, 83/195 entries beyond EOF).
           The payload bytes simply aren't there — skip the entry, keep the rest. */
        skipped.push(name);
        continue;
      }
      let data = bytes.subarray(offset, offset + storedSize);
      if (type === TYPE_DCL) {
        try {
          data = DCL.explode(data);
        } catch (err) {
          throw new Error(`Failed to decompress .dat entry "${name}": ${err.message}`);
        }
        if (data.length !== uncompSize) {
          throw new Error(`Decompressed size mismatch for "${name}": got ${data.length}, expected ${uncompSize}`);
        }
      }
      entries.push({ name, data });
    }
    if (skipped.length) {
      console.warn(`.dat: ${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} truncated/unreadable (archive shorter than its directory): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''}`);
    }
    return { header: bytes.slice(0, HEADER_BYTES), entries, skipped };
  }

  /* entries: [{ name, data: Uint8Array }] — rebuilds directory + payload. */
  function build(header, entries) {
    const enc = new TextEncoder();
    const names = entries.map(e => enc.encode(e.name));
    let dirSize = HEADER_BYTES;
    for (const n of names) dirSize += 16 + n.length;

    let total = dirSize;
    for (const e of entries) total += e.data.length;
    const out = new Uint8Array(total);
    const d = new DataView(out.buffer);
    out.set(header, 0);

    let pos = HEADER_BYTES;
    let offset = dirSize;
    entries.forEach((e, i) => {
      d.setUint16(pos, TYPE_STORED, true);
      d.setUint32(pos + 2, e.data.length, true);
      d.setUint32(pos + 6, e.data.length, true);
      d.setUint32(pos + 10, offset, true);
      out[pos + 14] = names[i].length;
      out.set(names[i], pos + 15);
      out[pos + 15 + names[i].length] = 0;
      pos += 16 + names[i].length;
      out.set(e.data, offset);
      offset += e.data.length;
    });
    return out;
  }

  return { parse, build };
})();

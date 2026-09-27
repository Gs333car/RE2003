/* PKWARE DCL "explode" decompressor — port of Mark Adler's blast.c (zlib licence).
   Some Papyrus .mip levels store their DXT payload DCL-compressed; WinMip2-style
   tools always write uncompressed, and so do we — decode only. */
const DCL = (() => {
  const MAXBITS = 13, MAXWIN = 4096;

  const LITLEN = [11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8,
    9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5,
    7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12,
    8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27,
    44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45, 44, 173];
  const LENLEN = [2, 35, 36, 53, 38, 23];
  const DISTLEN = [2, 20, 53, 230, 247, 151, 248];
  const LEN_BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
  const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];

  function construct(rep) {
    const length = [];
    for (const byte of rep) {
      const n = (byte >> 4) + 1, len = byte & 15;
      for (let i = 0; i < n; i++) length.push(len);
    }
    const count = new Int16Array(MAXBITS + 1);
    for (const len of length) count[len]++;
    const offs = new Int16Array(MAXBITS + 1);
    for (let len = 1; len < MAXBITS; len++) offs[len + 1] = offs[len] + count[len];
    const symbol = new Int16Array(length.length);
    for (let s = 0; s < length.length; s++) {
      if (length[s] !== 0) symbol[offs[length[s]]++] = s;
    }
    return { count, symbol };
  }

  const LITCODE = construct(LITLEN);
  const LENCODE = construct(LENLEN);
  const DISTCODE = construct(DISTLEN);

  /* input: Uint8Array of DCL stream. returns Uint8Array of decompressed bytes. */
  function explode(input) {
    let pos = 0, bitbuf = 0, bitcnt = 0;
    const out = [];

    const bits = (need) => {
      let val = bitbuf;
      while (bitcnt < need) {
        if (pos >= input.length) throw new Error('DCL: out of input');
        val |= input[pos++] << bitcnt;
        bitcnt += 8;
      }
      bitbuf = val >> need;
      bitcnt -= need;
      return val & ((1 << need) - 1);
    };

    const decode = (h) => {
      let code = 0, first = 0, index = 0, len = 1;
      let buf = bitbuf, left = bitcnt, nextIdx = 1;
      while (true) {
        while (left--) {
          code |= (buf & 1) ^ 1;
          buf >>= 1;
          const count = h.count[nextIdx++];
          if (code < first + count) {
            bitbuf = buf;
            bitcnt = (bitcnt - len) & 7;
            return h.symbol[index + (code - first)];
          }
          index += count;
          first = (first + count) << 1;
          code <<= 1;
          len++;
        }
        left = (MAXBITS + 1) - len;
        if (left === 0) break;
        if (pos >= input.length) throw new Error('DCL: out of input');
        buf = input[pos++];
        if (left > 8) left = 8;
      }
      throw new Error('DCL: invalid code');
    };

    const lit = bits(8);
    if (lit > 1) throw new Error('DCL: bad literal flag ' + lit);
    const dict = bits(8);
    if (dict < 4 || dict > 6) throw new Error('DCL: bad dictionary size ' + dict);

    while (true) {
      if (bits(1)) {
        const lenSym = decode(LENCODE);
        const len = LEN_BASE[lenSym] + bits(LEN_EXTRA[lenSym]);
        if (len === 519) break;   /* end code */
        const distExtra = len === 2 ? 2 : dict;
        let dist = (decode(DISTCODE) << distExtra) + bits(distExtra) + 1;
        if (dist > out.length) throw new Error('DCL: distance too far back');
        for (let i = 0; i < len; i++) out.push(out[out.length - dist]);
      } else {
        out.push(lit ? decode(LITCODE) : bits(8));
      }
      if (out.length > 64 * 1024 * 1024) throw new Error('DCL: output too large');
    }
    return new Uint8Array(out);
  }

  return { explode };
})();

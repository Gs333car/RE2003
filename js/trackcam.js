/* NR2003 track camera (.cam) reader.

   Each track ships a `<track>.cam` file next to its .dat holding the TV camera
   set the game cuts between during a race. Format (reverse-engineered from the
   stock + BBMC tracks, 2026-07-05):

     header: [magic "MACT"][u32 version=2][u32 payloadSize][u32 cameraCount]
     then `cameraCount` camera records, ~232 bytes each. Two kinds share the
     layout: FIXED trackside cameras carry a real world position; DYNAMIC ones
     (director / roaming / in-car) leave the position ~0 and the game places
     them at runtime, so they have no fixed view to reference.

   Every record begins with the same block:
     +0x00 f32 dlong    — track distance (m) the camera is associated with
     +0x04 f32 x        — Papyrus world X of the camera
     +0x08 f32 height   — camera height above ground (m)
     +0x0c f32 y        — Papyrus world Y of the camera
     +0x10 u32 = 0      — marker/flags (0 on every record seen)
   (the bytes past this encode orientation/zoom in a form we don't need — we aim
   each camera at the track centreline at its dlong, which reproduces the shot.)

   We keep only the FIXED cameras: a real position (|x|>4 or |y|>15), a sane
   height (0.2..90 m) and a plausible dlong. That yields the 3-9 trackside TV
   cameras per track (ovals ~3-4, road courses more). */
const TrackCam = (() => {
  const HEADER_BYTES = 16;
  const MARKER_OFFSET = 0x10;
  const RECORD_MIN = 0x14;          /* bytes needed to read one position block */
  const SKIP_AFTER_HIT = 0x20;      /* clear the matched block before scanning on */

  const DLONG_MIN = -400, DLONG_MAX = 4400;
  const HEIGHT_MIN = 0.2, HEIGHT_MAX = 90;
  const COORD_MAX = 3000;
  const MIN_X = 4, MIN_Y = 15;      /* below this on both axes = dynamic camera */

  function parse(bytes) {
    if (!bytes || bytes.length < HEADER_BYTES) return { magic: null, count: 0, cameras: [] };
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== 'MACT') return { magic, count: 0, cameras: [] };

    const f = (o) => dv.getFloat32(o, true);
    const u = (o) => dv.getUint32(o, true);
    const count = u(12);
    const cameras = [];
    const N = bytes.length;
    let o = HEADER_BYTES;
    while (o < N - RECORD_MIN) {
      const dlong = f(o), x = f(o + 4), height = f(o + 8), y = f(o + 0xc);
      const isFixed = u(o + MARKER_OFFSET) === 0 &&
        dlong >= DLONG_MIN && dlong <= DLONG_MAX &&
        height >= HEIGHT_MIN && height <= HEIGHT_MAX &&
        Math.abs(x) < COORD_MAX && Math.abs(y) < COORD_MAX &&
        (Math.abs(x) > MIN_X || Math.abs(y) > MIN_Y);
      if (isFixed) {
        cameras.push({ index: cameras.length, dlong, x, y, height, offset: o });
        o += SKIP_AFTER_HIT;
      } else {
        o += 4;
      }
    }
    return { magic, count, cameras };
  }

  return { parse };
})();

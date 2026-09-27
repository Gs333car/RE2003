
const SimSetup = (() => {
  'use strict';

  const G = 9.80665;
  const NPM_TO_LBIN = 1 / 175.126835;    /* N/m → lb/in */
  const KG_TO_LB = 2.20462262;
  const RAD_TO_DEG = 180 / Math.PI;

  const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  const orNull = (v, lo, hi) => (inRange(v, lo, hi) ? v : null);

  function parse(bytes) {
    if (!bytes || bytes.length < 24) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag4 = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    if (tag4(0) !== 'PGTS') return null;              /* STGP reversed */
    let o = 12;
    let dgts = null, name = null, notes = null;
    while (o + 12 <= bytes.length) {
      const t = tag4(o);
      if (!/^[A-Z]{4}$/.test(t)) break;
      const size = dv.getUint32(o + 8, true);
      if (t === 'DGTS') dgts = { off: o + 12, size };
      if (t === 'HGTS' && size >= 258) {
        let end = o + 14;
        while (end < o + 14 + 256 && bytes[end]) end++;
        name = String.fromCharCode(...bytes.subarray(o + 14, end));
      }
      if (t === 'TGTS' && size > 0) {
        let end = o + 12;
        const stop = Math.min(o + 12 + size, bytes.length);
        while (end < stop && bytes[end]) end++;
        notes = String.fromCharCode(...bytes.subarray(o + 12, end)).trim() || null;
      }
      o = (o + 12 + size + 3) & ~3;                   /* 4-byte aligned chunks */
    }
    if (!dgts || dgts.size < 200) return null;
    const nSlots = Math.floor(dgts.size / 4);
    const slots = new Float32Array(nSlots);
    for (let i = 0; i < nSlots; i++) slots[i] = dv.getFloat32(dgts.off + i * 4, true);
    const f = (i) => (i < nSlots ? slots[i] : NaN);

    const u32 = (i) => (i < nSlots ? dv.getUint32(dgts.off + i * 4, true) : 0);
    const gearCap = f(48) / 10;
    const trans = [52, 53, 54, 55].map((s) => {
      const i = u32(s);
      return i > 0 && i < 90 ? 1 / (0.35 + 0.01 * i) : null;
    });
    let finalDrive = null;
    const fIdx = u32(56);
    if (fIdx >= 100 && fIdx <= 148) {
      finalDrive = 0.094667 * fIdx - 6.3457;
      /* snap to the rule cap when the table lands on it (Bristol-style) */
      if (inRange(gearCap, 2.5, 7.8) && Math.abs(finalDrive - gearCap) < 0.15) {
        finalDrive = gearCap;
      }
    } else if (inRange(gearCap, 2.5, 7.8)) {
      finalDrive = gearCap;                  /* older writers: cap = chosen */
    }

    const setup = {
      name: name || null,
      notes,
      fileName: null,                                  /* filled by the caller */
      slots,                                           /* full raw slot array */

      tirePressuresPsi: [f(0), f(1), f(2), f(3)].map((v) => orNull(v, 5, 80)),
      springRatesNpm: [20, 21, 22, 23].map((s) => orNull(Math.abs(f(s)), 5000, 400000)),
      bumpGapM: [28, 29, 30, 31].map((s) => orNull(f(s), 0, 0.2)),
      camberRad: [32, 33, 34, 35].map((s) => orNull(f(s), -0.2, 0.2)),
      rideHeightM: {
        lf: orNull(f(36), 0.03, 0.4),
        rf: orNull(f(37), 0.03, 0.4),
        rear: orNull(f(38), 0.03, 0.4),
      },
      brakeBiasFront: orNull(f(39), 0.4, 0.85),
      toeFront: orNull(f(40), -0.05, 0.05),
      toeRear: orNull(f(41), -0.05, 0.05),
      trackBarM: [orNull(f(44), 0.05, 0.6), orNull(f(45), 0.05, 0.6)],
      steeringRatio: orNull(f(47), 6, 40),
      finalDrive: orNull(finalDrive, 2.0, 7.8),
      gearRuleMax: orNull(gearCap, 2.0, 7.8),
      transRatios: trans.every((v) => v != null) ? trans : null,  /* 1st..4th */
      shockCompClicks: [4, 5, 6, 7].map(u32),      /* {1-9} LF RF LR RR */
      shockRebClicks: [12, 13, 14, 15].map(u32),
      grilleTapePct: orNull(f(58) * 100, 0, 100),
      spoilerDeg: orNull(45 + f(60), 45, 70),      /* stored as offset from 45° */
      staggerFrontM: orNull(f(64), 0, 0.03),   /* slots 64/65: per-axle stagger */
      staggerRearM: orNull(f(65), 0, 0.03),    /* (radius diff; ovals>0, road=0) */
      leftBallastKg: orNull(f(61), 0, 200),
      wedgeKg: orNull(f(62), -120, 120),
      rearBallastKg: orNull(f(63), -120, 120),
    };
    /* a real garage file always carries gearing or a steering ratio */
    return setup.finalDrive || setup.steeringRatio || setup.brakeBiasFront ? setup : null;
  }
  const BALLAST_ARM_M = 0.6;             /* left ballast lever off centerline */
  const REAR_BALLAST_ARM_M = 1.0;        /* fore/aft ballast lever */

  function derive(setup, chassis) {
    const c = chassis || {};
    const mass = c.mass || 1587.6;
    const wheelbase = c.wheelbase || 2.79;
    const trackWidth = c.trackWidth || 1.65;
    const distF = c.weightDistFront || 0.52;
    const W = mass * G;

    /* fore/aft ballast shifts the axle split */
    const rearKg = setup.rearBallastKg || 0;
    const dFront = -(rearKg * G * REAR_BALLAST_ARM_M) / wheelbase;
    const front = W * distF + dFront;
    const rear = W - front;

    /* left ballast: moment across the track width */
    const leftKg = setup.leftBallastKg || 0;
    const dLeft = (leftKg * G * BALLAST_ARM_M) / trackWidth;   /* +left −right, total */

    /* wedge: diagonal (RF+LR vs LF+RR) load shift */
    const wedgeN = (setup.wedgeKg || 0) * G * 0.25;

    /* corner order FL FR RL RR (physics CORNERS order) */
    const corner = [
      front / 2 + dLeft / 2 - wedgeN,
      front / 2 - dLeft / 2 + wedgeN,
      rear / 2 + dLeft / 2 + wedgeN,
      rear / 2 - dLeft / 2 - wedgeN,
    ];
    const total = corner[0] + corner[1] + corner[2] + corner[3];
    return {
      cornerN: corner,
      cornerLb: corner.map((n) => n / G * KG_TO_LB),
      frontPct: (corner[0] + corner[1]) / total * 100,
      leftPct: (corner[0] + corner[2]) / total * 100,
      crossPct: (corner[1] + corner[2]) / total * 100,   /* RF + LR */
    };
  }

  /* the static per-corner load OFFSETS (N) the setup adds vs a symmetric car —
     what Physics.Car.applySetup feeds into the per-corner normal loads */
  function cornerOffsets(setup, chassis) {
    const c = chassis || {};
    const trackWidth = c.trackWidth || 1.65;
    const dLeft = ((setup.leftBallastKg || 0) * G * BALLAST_ARM_M) / trackWidth / 2;
    const wedgeN = (setup.wedgeKg || 0) * G * 0.25;
    return [dLeft - wedgeN, -dLeft + wedgeN, dLeft + wedgeN, -dLeft - wedgeN];
  }

  /* ---- setup file listing / selection ---------------------------------- */
  const SERIES = [
    { re: /\.cup\.sim$/i, label: 'Cup' },
    { re: /\.gns\.sim$/i, label: 'GNS' },
    { re: /\.cts\.sim$/i, label: 'CTS' },
    { re: /\.pta\.sim$/i, label: 'PTA' },
  ];
  const TYPE_ORDER = ['fast', 'race', 'qualify', 'qual', 'base', 'ai'];

  function describeName(fileName) {
    const base = (fileName || '').toLowerCase();
    const series = SERIES.find((s) => s.re.test(base));
    const type = base.replace(/\.(cup|gns|cts|pta)?\.?sim$/i, '');
    return { series: series ? series.label : null, type: type || base };
  }

  function sortKey(fileName) {
    const d = describeName(fileName);
    const t = TYPE_ORDER.indexOf(d.type);
    const s = SERIES.findIndex((x) => x.label === d.series);
    return [(t < 0 ? TYPE_ORDER.length : t), (s < 0 ? SERIES.length : s), fileName];
  }

  function sortSetups(setups) {
    return setups.slice().sort((a, b) => {
      const ka = sortKey(a.fileName || ''), kb = sortKey(b.fileName || '');
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return 0;
    });
  }

  function label(setup) {
    const d = describeName(setup.fileName || '');
    const bits = [d.type];
    if (d.series) bits.push(`(${d.series})`);
    return bits.join(' ');
  }

  /* pick the best setup file from a track folder's file names: the game's
     "Fast" garage baseline, preferring the series the viewer mostly shows */
  const PREF = [/^fast\.cup\.sim$/i, /^fast\.cts\.sim$/i, /^fast\.gns\.sim$/i,
    /^fast\..*\.sim$/i, /\.cup\.sim$/i, /\.sim$/i];
  function pickName(names) {
    for (const re of PREF) {
      const hit = names.find((n) => re.test(n));
      if (hit) return hit;
    }
    return null;
  }

  return {
    parse, pickName, derive, cornerOffsets, sortSetups, label, describeName,
    NPM_TO_LBIN, KG_TO_LB, RAD_TO_DEG,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SimSetup;

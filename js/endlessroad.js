/* Procedural ENDLESS banked road — a big closed "dogbone" loop you can lap
   forever, so the AI field runs continuously to watch. It emits a track.surface
   in the SAME shape TrackSurface.extract yields (block chain → arcs, banked
   X-section nodes, boundary walls), so the physics, AI, cameras and car field
   all work with zero special-casing. Purely geometric + Node-testable. */
const EndlessRoad = (() => {
  'use strict';
  const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a <= -Math.PI) a += 2 * Math.PI; return a; };
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /* == replicas of TrackSurface's internal post-processing (not exported) == */
  const ARC_MIN_TURN = 1e-4;
  function computeArcs(segments) {
    for (const s of segments) {
      const b = s.block;
      const th0 = b.z0, dth = wrapPi(b.z1 - b.z0);
      const chord = Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
      s.th0 = th0;
      s.type = (Math.abs(dth) < ARC_MIN_TURN) ? 0 : 1;
      if (s.type === 0 || chord < 1e-9) { s.arc = null; continue; }
      const R = chord / (2 * Math.sin(Math.abs(dth) / 2));
      const sgn = dth > 0 ? 1 : -1;
      const cx = b.x0 - sgn * R * Math.sin(th0);
      const cy = b.y0 + sgn * R * Math.cos(th0);
      s.arc = { cx, cy, r: R, phi0: Math.atan2(b.y0 - cy, b.x0 - cx), dth };
    }
    for (const s of segments) hermiteHeights(s);
  }
  /* s0=s1=0 → each node's height is flat ALONG the segment (banking is lateral) */
  function hermiteHeights(seg) {
    for (const x of seg.xsecs) {
      x.hc = [2 * (x.h0 - x.h1), 3 * (x.h1 - x.h0), 0, x.h0];
    }
  }

  function segLen(s) {
    return s.arc ? Math.abs(s.arc.r * s.arc.dth)
      : Math.hypot(s.block.x1 - s.block.x0, s.block.y1 - s.block.y0);
  }

  /* opts: radius (m), lobe (0..0.6 dogbone waist depth), halfWidth (m),
     maxBankDeg, segments (count), field (max starters), cameras (TV count) */
  function build(opts) {
    opts = opts || {};
    const R0 = opts.radius || 640;
    const amp = opts.lobe != null ? opts.lobe : 0.34;
    const halfW = opts.halfWidth || 9;
    const maxBank = (opts.maxBankDeg != null ? opts.maxBankDeg : 16) * Math.PI / 180;   /* 0 is valid (flat world) */
    const BANK_K = 9;                       /* curvature (rad/seg) → bank angle */
    const N = Math.max(80, opts.segments || 280);

    /* sample the closed dogbone centreline r(θ) = R0(1 + amp·cos2θ) */
    const R = (t) => R0 * (1 + amp * Math.cos(2 * t));
    const pts = [];
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2, r = R(t);
      pts.push({ x: r * Math.cos(t), y: r * Math.sin(t) });
    }
    /* central-difference tangents → per-node heading (wraps the loop) */
    const head = [];
    for (let i = 0; i < N; i++) {
      const a = pts[(i - 1 + N) % N], b = pts[(i + 1) % N];
      head.push(Math.atan2(b.y - a.y, b.x - a.x));
    }
    /* per-segment bank from |dθ| (curvature), banked INTO the turn */
    const segBank = [];
    for (let i = 0; i < N; i++) {
      const dth = wrapPi(head[(i + 1) % N] - head[i]);
      const mag = Math.min(maxBank, Math.abs(dth) * BANK_K);
      segBank.push(-Math.sign(dth) * mag);   /* left turn → outside (right) higher */
    }
    for (let pass = 0; pass < 4; pass++) {
      const sm = segBank.slice();
      for (let i = 0; i < N; i++) sm[i] = 0.25 * segBank[(i - 1 + N) % N] + 0.5 * segBank[i] + 0.25 * segBank[(i + 1) % N];
      for (let i = 0; i < N; i++) segBank[i] = sm[i];
    }
    /* bank at each NODE = mean of the two segments meeting there. A segment then
       ramps its cross-section from its start node's bank to its end node's — so
       both sides of every seam share the same bank and the surface is C¹. */
    const nodeBank = [];
    for (let i = 0; i < N; i++) nodeBank.push(0.5 * (segBank[(i - 1 + N) % N] + segBank[i]));

    const nodeD = [-halfW, -halfW * 0.5, 0, halfW * 0.5, halfW];
    const mkWall = (d) => ({
      d0: d, d1: d, h0: 1.0, h1: 1.0, bt0: 0.3, bt1: 0.3, ct0: 0.3, ct1: 0.3,
      type: 0, straighten: 0, texture: 'wall', faces: [], count: 1, spanTs: null,
    });
    const segments = [];
    for (let i = 0; i < N; i++) {
      const a = pts[i], b = pts[(i + 1) % N];
      const z0 = head[i], z1 = head[(i + 1) % N];
      const tb0 = Math.tan(nodeBank[i]), tb1 = Math.tan(nodeBank[(i + 1) % N]);
      const xsecs = nodeD.map((d) => {
        /* banked plane, ramped start→end so seams match (h0 at start, h1 at end) */
        return { d0: d, d1: d, h0: tb0 * d, h1: tb1 * d, s0: 0, s1: 0 };
      });
      segments.push({
        block: { x0: a.x, y0: a.y, z0, x1: b.x, y1: b.y, z1 },
        xsecs,
        strips: [{ d0: -halfW, d1: halfW, straighten: 0, texture: 'asphalt',
          uv: { u: [0, 0, 1, 1], v: [0, 1, 1, 0] } }],
        /* the flat open world drops the rails entirely — nothing to hit, roam free */
        walls: opts.noWalls ? [] : [mkWall(halfW + 0.6), mkWall(-(halfW + 0.6))],
      });
    }
    computeArcs(segments);

    /* cumulative track distance per node (for length + camera dlong assignment) */
    const cum = []; let length = 0;
    for (const s of segments) { cum.push(length); length += segLen(s); }

    /* broadcast cameras: ringed OUTSIDE the loop, elevated, each tagged with the
       track distance (dlong) of the stretch it overlooks — so the NR-style
       director hands off between them as the car laps. */
    const camCount = opts.cameras || 12;
    const cameras = [];
    const camR = R0 * (1 + amp) + 90;
    for (let i = 0; i < camCount; i++) {
      const t = (i / camCount) * Math.PI * 2;
      const node = Math.round((i / camCount) * N) % N;     /* centreline node it faces */
      cameras.push({ x: camR * Math.cos(t), y: camR * Math.sin(t), height: 22, dlong: cum[node] });
    }

    const surface = { segments, skippedSegments: 0 };
    const meta = { name: 'Endless Banked Road', length,
      maxStarters: opts.field || 40, lanes: [], halfWidth: halfW };
    return { surface, meta, cameras };
  }

  return { build, segLen };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = EndlessRoad;

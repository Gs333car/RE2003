/* RE2003 vehicle physics — original browser simulation (SI units).
   Combined-slip tires, spring–damper suspension, torque engine, panel aero,
   impulse collisions. See PHYSICS-METHODOLOGY.txt. */
const Physics = (() => {
  'use strict';

  const G = 9.81;                 /* gravity — _DAT_006f6920 (NR2003.exe .rdata),
                                     the constant the exe's own free-flight
                                     integrators use (FUN_00585700/FUN_005859a0) */
  const RPM_TO_RADS = Math.PI / 30;
  const MPS_TO_MPH = 2.2369362921;

  /* ---- surface grip tables (17 classes) ---- */
  const ASPHALT_CLASS=2; const SURFACE_GRIP=[1,1,1,1,1,0.581852,0.417981,0.75791,0.658319,0.75791,0.834961,0.167627,0.417981,0.079973,0.167627,0.167627,0.834961]; const SURF_LIN_SCALE=[1,1,1,1,1,0.581852,0.417981,0.75791,0.658319,0.75791,0.834961,0.167627,0.417981,0.079973,0.167627,0.167627,0.834961]; const SURF_SLIP_SCALE=[1,1,1,1,1,0.333333,0.5,0.15,0.233364,0.026688,1,0.066655,0.066655,0.049958,0.026688,0.026688,0.766665]; const SURF_DRAG_MUL=[0.42,0.95,1.1,0.6,1,0.65,1.2,0.6,1,0.65,1.2,0.6,0.0025,0.02,0.1,0.01,0.000001]; const LIN_FZ_K=0.299475; const LIN_SLIP_K=13.125; const LIN_LOW_K=1.8e-5; const LIN_GRIP_A=[-11979,-11979,-11979,-11979,-11979,-6970,-5007,-9079,-7886,-9079,-10002,-2008,-5007,-958,-2008,-2008,-10002]; const LIN_GRIP_B=[-525000,-525000,-525000,-525000,-525000,-175000,-262500,-78750,-122516,-14011,-525000,-34994,-34994,-26228,-14011,-14011,-402499]; const LIN_GRIP_K=1; const LIN_BRANCH_SCALE=2.5e-5; function surfaceGrip(cls){if(!Number.isInteger(cls)||cls<0||cls>=SURFACE_GRIP.length)return 1;return SURFACE_GRIP[cls]/SURFACE_GRIP[ASPHALT_CLASS];}
  /* ---- car parameters (SI-TUNED, NASCAR Cup; refine vs live dump) ----- */
  const PARAMS = {
    mass: 1543,                   /* kg (~3400 lb incl. driver, Cup minimum) */
    yawInertia: 3400,             /* kg·m² — Cup stock; raised from 2600 so spins
                                     take more to start (decomp part-tree Iz) */
    wheelbase: 2.79,              /* m (110 in) */
    trackWidth: 1.65,             /* m (front/rear ~equal) */
    cgHeight: 0.47,               /* m — drives load transfer magnitude */
    weightDistFront: 0.52,        /* static front fraction */

    wheelRadius: 0.34,            /* m (~26.5" dia racing slick) */
    wheelInertia: 1.6,            /* kg·m² per wheel (spin) */

    /* tire — FUN_0054cab0 (TIRE-SPEC): dumped curveB / combinedSlip / forceMag
       LUTs, slip-angle LUT (PTR_DAT_0074e080), load saturation, long falloff.
       curveA + direction LUT samples not recoverable — unity placeholders.
       muBase calibrates the F0 pipeline to SI corner speeds. */
    muBase: 1.36,
    loadSensPerN: 0.00025,        /* _DAT_006f58e0 */
    loadSensNominalN: 4000,
    slipSpeedFalloff: 0.025,      /* _DAT_006ee390 */
    frontLatGain: 1.0,            /* setup camber trim (applySetup) */

    /* aero — multi-surface panel model (AERO_PANELS/panelAero): per-panel
       relative wind → AoA → cn·sinα·|sinα| applied AT the panel. The legacy
       whole-car coefficients below are the CALIBRATION TARGETS the panels
       reproduce at level trim (drag+df ∝ v², FUN_00584730 base), kept for
       reference and the calibration harness. */
    dragCxA: 1.45,
    downforceCzA: 3.60,
    airDensity: 1.225,           /* sea-level ISA; overridden per track (altitude+temp) */
    windX: 0,                    /* ambient wind VELOCITY, world frame m/s — */
    windY: 0,                    /* from the track.ini [weather] average     */
    powerScale: 1.0,             /* engine combustion output ∝ air density (set per track) */
    playerPowerMul: 1.0,         /* debug "my car speed" slider — extra engine-torque mult, player car only */
    enginePowerMul: 1.0,         /* peak-HP slider per car */
    dragScale: 1.0,              /* user drag slider — 1 = stock; </>1 = slipperier/draggier */
    blowoverScale: 1.0,          /* blowover-onset slider — >1 flips sooner, <1 needs more speed */
    aeroBalanceFront: 0.42,
    spoilerDeg: 70,               /* rear blade angle from horizontal (45-70) */
    flapsPresent: true,           /* flaps fitted: deploy on the mesh in reversed flow (visual) */
    employRoofFlaps: true,        /* "are roof flaps effective?" — deployed flaps kill the
                                     reversed-flow lift (cfg 00410150). Independent of flapsPresent:
                                     present+ineffective = flaps visibly pop but the car still blows over */

    /* drivetrain — locked rear axle (spool): both rears share one ω; with
       stagger (RR rolling radius > LR) the RR drives the car forward harder,
       the built-in LEFT turn of an oval stock car */
    /* EVENLY SPACED box: a constant 1.433 step between gears (geometric
       progression 2.94 / 1.433^n), so every upshift drops the same revs —
       9000 -> ~6280 in all three shifts. 1st and 4th are unchanged, so launch
       and top speed are exactly as before; only 2nd/3rd move (was 1.90/1.33,
       whose steps ran an uneven 1.547 / 1.428 / 1.330). */
    gearRatios: [-2.90, 2.94, 2.05, 1.43, 1.00],  /* [R, 1, 2, 3, 4] */
    finalDrive: 3.90,
    rearLocked: true,
    rearStaggerM: 0,              /* rolling-RADIUS diff RR−LR (m); setup slot 65 */
    driveEff: 0.90,
    engineInertia: 0.22,          /* kg·m² — engine crank (DYNAMICS-SPEC +0x61) */
    clutchSlipUpRpmS: 9500,       /* engine rev rate at full throttle (rpm/s) */
    idleRpm: 1000,                /* _DAT_006f0e78 (NR2003.exe .rdata) */
    redlineRpm: 9500,             /* mechanical redline; power peak / operating band 9000–9200 */
    shiftUpRpm: 9000,
    shiftDownRpm: 5200,

    /* brakes — full pedal MUST be able to lock any wheel (NR2003 locks and
       flat-spots at will; the old 4200 was below tire torque at static load,
       so wheels could never lock — an invented limitation, not the game) */
    brakeTorqueMax: 12000,        /* N·m total at full pedal */
    brakeBiasFront: 0.56,

    /* steering — the garage model (setup slot 47): road-wheel lock =
       steering-wheel lock ÷ steering ratio. Martinsville's fast setup runs
       12:1 (22.5° lock), Bristol 18:1 (15°), Daytona 32:1 (8.4°) — the
       per-track ratio IS how NR2003 sets steering authority; there is no
       big speed-based lock reduction in the sim, only a mild input assist
       for non-wheel controllers. */
    steerWheelLockDeg: 270,       /* steering-wheel travel each way */
    steeringRatio: 20,            /* :1 — overridden by the track setup */
    maxSteer: 0.32,               /* rad — recomputed from the ratio on applySetup */
    steerSpeedFalloff: 0.005,     /* keyboard/pad assist: mild input taper with speed */
    steerAssistFromMps: 12,       /* assist only starts above pit speed */
    steerAssistFloor: 0.88,       /* NR2003 keeps near-full ratio lock at speed */
    steerSweepS: 0.26,            /* seconds for a full centre→lock sweep — the
                                     keyboard/pad ramp; the old fixed 3.2 rad/s
                                     hit full lock in ~80 ms = the "on rails"
                                     twitchiness */
    steerReturnMul: 1.9,          /* unwinding is quicker than winding on */
    throttleRate: 3.5,            /* pedal slew per second */
    brakeRate: 5.0,

    /* chassis / suspension — TRAVEL-SPACE (DYNAMICS-SPEC: weight transfer is
       EMERGENT). The sprung body carries real heave/roll/pitch states; each
       corner's load is its FUN_0055e490 spring (+cubic bump stop) and
       FUN_0055e510 shape damper evaluated at actual suspension travel.
       Lateral/longitudinal transfer emerges from the body taking its set
       through the springs — no target formula, no hardcoded split. */
    unsprungMass: 42,             /* kg per corner (wheel/hub/brake) */
    rollInertia: 550,             /* kg·m² sprung Ixx — SI-calibrated (part-tree TODO) */
    pitchInertia: 2400,           /* kg·m² sprung Iyy — SI-calibrated (part-tree TODO) */
    rollCenterFM: 0.06,           /* m — front SLA roll center (geometric path) */
    rollCenterRM: 0.18,           /* m — rear truck-arm roll center (higher: the
                                     rear takes its lateral transfer INSTANTLY
                                     through the links; the front rolls in on
                                     springs — stock-car entry character) */
    antiDiveFrac: 0.55,           /* share of the BRAKE pitch moment the front
                                     SLA caster geometry + rear truck-arm
                                     anti-lift react through the links —
                                     instant to the tires, never pitches the
                                     body (geometry, NOT a setup value: keeps
                                     brake dive consistent across tracks) */
    antiSquatFrac: 0.65,          /* truck-arm anti-squat share on throttle */
    frontBarNpm: 50000,           /* front sway-bar N per m of L−R travel diff —
                                     FUN_00560c30 lfsusp/rfsusp; sized so the
                                     front carries ~2/3 of the roll couple like
                                     the old calibrated balance */
    rearBarNpm: 0,                /* raxle bar (FUN_005608d0) — none by default */
    cornerFzOffset: [0, 0, 0, 0], /* static per-corner load offsets from ballast/wedge */
    cornerSpring: [125000, 125000, 115000, 115000], /* N/m — Cup short-track typical */
    cornerDamperComp: [12800, 12800, 12200, 12200], /* ζ≈0.92 at default spring rates */
    cornerDamperReb: [7680, 7680, 7320, 7320],    /* comp × 0.6 — the REAL
                                     _DAT_006ee488 ratio applies now that the
                                     damper acts on travel velocity */
    bumpGapM: [0.032, 0.032, 0.032, 0.032],       /* setup slots 28-31 */
    rideHeightM: [0.10, 0.10, 0.11, 0.11],        /* setup slots 36-38 (rear) */
    bumpRateNpm3: 2.5e7,            /* cubic bump-stop (FUN_0055e490 param_5, SI-TUNED) */
    suspTravelStep: 0.01,         /* _DAT_006ea4a4 — spring table sample spacing */

    /* NR2003 driving aids (Options → Controls; the game defaults aids ON
       for non-wheel controllers — a keyboard W is a binary 750 hp switch).
       All toggleable from the viewer Controls panel via setAids(). */
    tractionControl: true,
    tcSlipThreshold: 0.09,        /* rear slip ratio where the TC steps in */
    tcMinSpeed: 4.0,              /* m/s — TC off below this (launch wheelspin OK) */
    absBrakes: true,              /* anti-lock brake assist */
    absSlipThreshold: 0.14,       /* wheel slip where the anti-lock releases */
    absMinSpeed: 3.0,             /* m/s — below this wheels may lock (full stop) */
    stabilityControl: true,       /* EB attenuation + drive bleed while sliding */
    lowSpeedSteerBoost: true,     /* NR "Boost Steering at Low Speeds" */
    steerBoostMax: 0.8,           /* up to +80% lock at rest */
    steerBoostFadeMps: 18,        /* boost fully faded by ~40 mph */

    rollingResist: 0.014,         /* rolling-resistance coeff */
  };

  /* GLOBAL MASS SCALE — the viewer's "Car mass" slider, one knob that makes
     EVERY car lighter or heavier. Each Car copies PARAMS, so scaling has to hit
     the mass AND the chassis inertias (they scale ~linearly with mass for a
     fixed body) on every live car. Springs, aero and drivetrain stay put, so a
     heavy car rolls/transfers weight more (softer, planted) and a light one
     darts (stiffer) — the real feel of changing weight. Collisions and grip
     read p.mass, so they follow for free. Airborne tumble uses AIR_INERTIA,
     scaled at its use site. */
  const MASS_SCALE_MIN = 0.5, MASS_SCALE_MAX = 2.0;
  let _massScale = 1;

  /* ---- UNIFIED 3D SOLVER (2026-07-12) --------------------------------
     One always-integrated 6-DOF rigid body replaces the split grounded
     (_stepGround, planar + travel-space suspension) / airborne (_subAirborne)
     solvers and the entire handoff layer between them (ballistic band,
     takeoff/landing transfer, blowover pivot, ground-hold grace, vz
     recapture). The ground is a set of CONTACT FORCES on the one body:
     per-wheel geometric spring/dampers (the same FUN_0055e490/0055e510
     force elements, evaluated at real geometric travel), the tuned tire
     pipeline applied AT the contact points, and the sequential-impulse
     solver as the always-on backstop for bodywork and bottomed wheels.
     Airborne/onSurface/restingOnBody become derived LABELS. This is the
     NR2003 architecture (per-wheel force thunks FUN_0055d880.. onto one
     body, no grounded/airborne split). Flip the flag off to A/B the old
     split solver: Physics.setUnified3d(false). */
  let _unified3d = false;
  function setUnified3d(v) { _unified3d = !!v; }
  function getUnified3d() { return _unified3d; }
  const AIR_LABEL_T = 0.017;        /* s with no loaded wheel before the airborne label —
                                       just past ONE 60 Hz frame: a one-frame seam blip
                                       (unloadT = 0.0167) never labels, but a real crest
                                       flips on the second frame, before the render-anchor
                                       gap and the viewer's smoothed-normal lag build up */
  const AIR_NOW_GAP_M = 0.3;        /* m — a gap this big with no wheel load is decisively
                                       flight; the label flips the same frame (cliffs) */
  const AIR_REGRIP_GAP_M = 0.18;    /* m — while the regrip window is open (just landed) a
                                       re-takeoff needs a REAL gap, not a rebound lick */
  const LAND_LABEL_HEAVE_M = 0.04;  /* m — and the springs near static: the render adds
                                       heave only when grounded, so flipping mid-crush
                                       pops the model by the whole compression */
  const ONSURF_LOAD_MIN = 0.35;     /* smoothed wheel-load fraction below which onSurface
                                       drops (the ballistic band): render anchors leave the
                                       road BEFORE the airborne flip, no accumulated pop */
  const WHEEL_BACKSTOP_XTRA = 0.03; /* m beyond the bump-stop knee where the impulse
                                       backstop takes over from the spring (crash landings
                                       / tunneling guard — never touched in normal driving) */
  const LOADFRAC_TAU = 0.06;        /* s smoothing on the wheel-load fraction that blends
                                       the flight feel constants (grav/aero ×1.15, angular
                                       damping) in and out — no mode switch, a fade */
  const SPRING_GATE_UP = 0.7;       /* upB·n above which the struts fully carry the car */
  const SPRING_GATE_DOWN = 0.35;    /* …below this the wheels are pure inelastic contact
                                       points (a car on its side cannot ride its struts) */
  const BUMPSTOP_REB_FRAC = 0.35;   /* bump-stop force fraction on the release stroke
                                       (hysteretic rubber — kills landing pogo) */
  const LAND_REB_DAMP_MUL = 3.0;    /* rebound-damper boost while the regrip window is
                                       open (post-touchdown only, normal driving untouched) */
  const LAND_ANG_DAMP_NMS = 20000;  /* N·m·s chassis pitch/roll rate damping during the
                                       regrip window with wheel contact — kills the
                                       one-axle see-saw whip of a nose-first catch and
                                       keeps the catch rotation under ~4°/frame */
  const LAND_LABEL_GAP_M = 0.05;    /* the 2-wheel grounded label waits until the tyre-
                                       plane anchor is actually AT the road (mid-catch a
                                       nose-first car is still half a metre up; the render
                                       anchor swaps at the flip, so the residual gap IS the
                                       height pop the viewer shows) */
  const PLANE_SPIKE_M = 0.22;       /* one-frame surface residual (vs the predicted rate)
                                       beyond which the height is a seam GLITCH — rejected.
                                       A real crest/descent moves smoothly (small residual)
                                       and passes through, so a fast road that falls away
                                       still launches the car; a 0.35 m one-frame spike is
                                       coasted over. Replaces the split solver's velocity
                                       clamp (which capped legit fast crests at 12 m/s). */
  const NORMAL_FOLLOW_MAX = 1.0;    /* rad — cap on the one-frame surface-normal delta the
                                       rigid re-seat will follow (an abrupt 26° bank step is
                                       real and must seat; a near-flip is data garbage) */
  const NORMAL_FOLLOW_PEN_M = 0.05; /* m — re-seat only when the new plane demands MORE extra
                                       wheel compression than this of the current pose (past
                                       the ~3 cm bump-stop band the springs can't absorb it
                                       and the impulse backstop would slam). A plane rotating
                                       AWAY never penetrates, so crests stay ballistic. */
  const _massBase = {
    mass: PARAMS.mass, yawInertia: PARAMS.yawInertia,
    rollInertia: PARAMS.rollInertia, pitchInertia: PARAMS.pitchInertia,
  };
  function applyMassScaleTo(p, s) {
    if (!p) return;
    p.mass = _massBase.mass * s;
    p.yawInertia = _massBase.yawInertia * s;
    p.rollInertia = _massBase.rollInertia * s;
    p.pitchInertia = _massBase.pitchInertia * s;
  }
  /* set the scale (future cars pick it up at construction) and rescale any live
     cars passed in. Returns the clamped value actually applied. */
  function setMassScale(s, cars) {
    _massScale = Math.max(MASS_SCALE_MIN, Math.min(MASS_SCALE_MAX, s || 1));
    if (cars) for (const c of cars) if (c) applyMassScaleTo(c.p, _massScale);
    return _massScale;
  }
  function getMassScale() { return _massScale; }

  /* global "disable damage" toggle — when on, addDamage is a no-op so every
     car's damage stays 0 (no downforce loss / drag / power cut from contact) */
  let _noDamage = false;
  function setNoDamage(on) { _noDamage = !!on; }
  function getNoDamage() { return _noDamage; }

  /* engine torque curve — N·m vs rpm (FUN_0051a870 +0x10 LUT). Cup V8 tuned to
     787 lb·ft peak @ ~4000 rpm, 750 hp peak @ ~9140 rpm (on-track operating band
     9000–9200). Negative at 0 = idle drag; engine-braking LUT (+0x224) term.

     WHY PEAK TORQUE SITS AT 4000, NOT 5000: 787 lb·ft (1067 N·m) makes
     1067 × 5000 / 7121.8 = 749 hp all by itself, i.e. the engine is already at
     its 750 hp ceiling by 5000 rpm. The previous curve put peak torque there
     and then had to DIG A TRENCH (down to 520 N·m @ 7800 = a 24% power hole)
     so that nothing out-powered the 9100 peak — the dyno showed it as a huge
     mid-range loss. Moving peak torque to 4000 drops power there to ~600 hp,
     leaving headroom for torque to fall along the 750 hp hyperbola and power
     to climb to ONE clean peak at 9140. Power now never falls back (0% dip).
     The flat 736-750 hp top from 7000-9140 is inherent to a 787 lb·ft engine,
     not a defect: a real ~540 lb·ft Cup V8 would give a peakier curve. */
  const TORQUE_RPM = [0, 1200, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 8500, 9000, 9150, 9300, 9500];
  const TORQUE_NM  = [0, 620,  819,  997,  1068, 983,  857,  749,  663,  627,  593,  584,  545,  470];

  /* uniform-ish 1-D lerp over a table (FUN_005677d1 LUT evaluator shape) */
  function lutLerp(xs, ys, x) {
    const n = xs.length;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 1;
    while (i < n && xs[i] < x) i++;
    const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return ys[i - 1] + (ys[i] - ys[i - 1]) * t;
  }

  const engineTorque = (rpm) => lutLerp(TORQUE_RPM, TORQUE_NM, rpm);
  /* engine braking (friction) grows with rpm — FUN_0051a870 +0x224 LUT intent.
     A closed-throttle race V8 drags hard (~190 N·m at 8000); through a short
     oval rear gear that's most of the "car slows the moment you lift" feel. */
  const engineBrakeTorque = (rpm) => 25 + rpm * 0.021;  /* FUN_0051a870 +0x224 */

  /* FUN_0051a870 net-torque blend:
       Tq_net = (Tq_full − idleLoad)·throttle + idleLoad − Tq_brk(rpm)
     +0x10 LUT is GROSS torque (friction not yet subtracted), so the gross
     curve = calibrated net curve + friction — full-throttle output unchanged.
     idleLoad = (_DAT_006f0e78 / max(rpm, idle)) · scale.
     _DAT_006f4738 = 65.0 and _DAT_006f0e78 = 1000.0 (static dump 2026-07-09);
     at idle the 65 N·m idle load beats the ~46 N·m friction — the small
     surplus is the game's idle creep torque (auto-clutch absorbs it at rest). */
  const ENGINE_IDLE_LOAD_NM = 65.0;             /* _DAT_006f4738 */
  const engineTorqueGross = (rpm) => engineTorque(rpm) + engineBrakeTorque(rpm);

  /* ---- patch force model (segEval = exact combined-slip LUT) ---- */
  function segEval(t,x){let idx=(x-t.o)*t.k;let i=Math.floor(idx);if(i<0)i=0;if(i>t.n)i=t.n;const f=idx-i;return t.y[i]+(t.y[i+1]-t.y[i])*f;}
  const PATCH_LAT_CURVE={o:1.539875,k:1.536700,n:5,y:[0.473,0,0,0,0,0.470,0.330],ref:0.473};
  const PATCH_FM={o:-0.19,k:0.08,n:0,y:[-0.01,-0.004]};
  const SLIP_COMB=[{o:0.127,k:21000,n:1,y:[0,2.324,2.845]},{o:0.127,k:14000,n:1,y:[0,2.324,2.845]},{o:0.127,k:14000,n:1,y:[0,2.324,2.845]},{o:0.127,k:10000,n:1,y:[0,2.324,2.845]}];
  const SLIP_ANGLE_LUT=[{o:-0.2,k:100,n:0,y:[1,1]},{o:-0.2,k:100,n:0,y:[1,1]}];
  const GOV_FADE_FRAC=0.015; const OVERREV_NMS=60; const STEER_MOM_A=0.2; const STEER_MOM_B=0.8;
  const TIRE_CAL={patchGainK:1,longFalloff:0.025,linLowAtten:0.15,slipAngNum:19135,slipAngDen:26789,curveBRef:0.473,combBase:0.127,combSlipSq:0.11,coupleScale:0.42,hubCouple:0.14,bleedLong:0.52,bleedLat:0.46,fmScale:2.8,fmSlipClamp:1.4,fmSlipSqScale:0.25,fmSlipSqOff:-0.19,longSpinSat:0.9,patchQuietFx:0.12,patchQuietSlip:0.08,patchQuietSpd:0.12,linLatScale:0.35};
  const BRUSH_B_LONG=11; const BRUSH_B_LAT=20;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const sign = (v) => (v < 0 ? -1 : 1);
  const FLAP_DEPLOY_RAD = 1.75;   /* ≈100° off-nose: roof flaps blow open (visual deploy) */

  function roofFlapDeployFrac(upB, beta, speed, flapsPresent) {
    if (!flapsPresent) return 0;
    const airOpen = Math.abs(beta) > FLAP_DEPLOY_RAD && speed > 18 ? 1 : 0;
    const gravOpen = clamp(1 - (upB ? upB[2] : 1), 0, 1);
    return Math.max(airOpen, gravOpen);
  }
  const FLAP_BLOW_TAU = 0.012;    /* s — time constant the flaps blow open on in
                                     reversed flow (the old code's 0.012 intent,
                                     now integrated implicitly so it can't diverge) */
  const FLAP_SWING_SPRING = 58;
  const FLAP_SWING_DAMP = 9;
  const FLAP_SWING_INERTIA = 0.38;
  const FLAP_EQ_RATE_K = 5.5;
  const FLAP_ANG_KICK_K = 0.42;

  function updateCarFlapSwing(car, dt, upB, beta, speed) {
    const p = car.p;
    if (!p || !p.flapsPresent) {
      car._flapSwing = 0;
      car._flapSwingV = 0;
      car._flapEqPrev = null;
      car.flapDeploy = 0;
      car.flapsDeployed = false;
      return;
    }
    const h = Math.max(dt || 0, 1e-5);
    const eq = roofFlapDeployFrac(upB, beta, speed, true);
    const windOpen = Math.abs(beta) > FLAP_DEPLOY_RAD && speed > 18;
    let s = car._flapSwing != null ? car._flapSwing : eq;
    let v = car._flapSwingV || 0;
    if (windOpen) {
      /* Reversed flow: the flaps BLOW open. Implicit (exponential) approach —
         unconditionally stable at ANY substep rate.
         THE "flaps don't deploy on Test blowover" BUG: the old explicit form
             v += ((1 - s) * 28 - v * 14) * Math.min(1, h / 0.012);
         has an effective velocity coefficient of 1 - 14*min(1, h/0.012). At the
         480 Hz substep that is 1 - 2.43 = -1.43 — magnitude > 1, so v flipped
         sign and GREW every substep and the clamp below slammed s back to 0.
         Measured over one frame: 0 -> .0101 -> .0057 -> .0221 -> .0085 -> .0380
         -> .0055 -> .0621 -> 0. The flaps never opened in reversed flow, while
         the gravity path (the stable spring branch below, coefficient 0.95)
         worked fine — hence "they deploy on gravity but not on test blowover". */
      const sPrev = s;
      s = clamp(s + (1 - s) * (1 - Math.exp(-h / FLAP_BLOW_TAU)), 0, 1);
      v = (s - sPrev) / h;     /* keep swing velocity continuous for the handoff
                                  back to the spring branch when flow re-attaches */
    } else {
      const angRate = car._airActive
        ? Math.hypot(car.wbx || 0, car.wby || 0)
        : Math.hypot(car.bodyRollV || 0, car.bodyPitchV || 0);
      const eqRate = car._flapEqPrev == null ? 0 : (eq - car._flapEqPrev) / h;
      const accel = ((eq - s) * FLAP_SWING_SPRING - v * FLAP_SWING_DAMP
        + eqRate * FLAP_EQ_RATE_K - angRate * FLAP_ANG_KICK_K) / FLAP_SWING_INERTIA;
      v += accel * h;
      s += v * h;
      if (s < 0) { s = 0; v *= -0.22; }
      if (s > 1) { s = 1; v *= -0.28; }
    }
    car._flapSwing = s;
    car._flapSwingV = v;
    car._flapEqPrev = eq;
    car.flapDeploy = clamp(s, 0, 1);
    car.flapsDeployed = car.flapDeploy > 0.35;
  }

  const FLAP_LIFT_KILL = 0.05;    /* with "Flaps prevent blowover" ON, effective flaps spoil the
                                     reversed/high-yaw roof lift to this fraction — REGIME-gated
                                     (net upward aero), not deploy-angle-gated, so the broadside
                                     barrel-roll (peaks ~65-90°, below the 100° visual deploy) is
                                     actually prevented, which the ×0.3 panel attenuation missed. */

  /* ---- free flight (airborne) — NR2003.exe static dump 2026-07-09 ----
     The exe has NO special "airborne car" state (no such strings/branches):
     rigid bodies fly whenever the tyres stop pushing. Its free-flight
     integrators (FUN_00585700 / FUN_005859a0) read these .rdata constants:
       pos += v·dt;  vz −= 9.81·dt              (_DAT_006f6920 = G above)
       per-tick damping ×0.989 linear / ×0.993 angular
                                    (_DAT_006f6934 / _DAT_006f6930, task rate)
       ground bounce  vz′ = vz·(−0.3) − 0.3     (_DAT_006f664c / _DAT_006ef640)
         — rebound ≤ 0 ⇒ stop dead; horizontal scrub ×0.94 (_DAT_006f4110)
       angles wrap 2π                            (_DAT_006f5e58) */
  /* (the ×0.989 linear per-tick damp _DAT_006f6934 is the exe's loose-object
     stand-in for drag — the car flies with the real aero drag instead) */
  const AIR_ANG_DAMP = 0.993;     /* _DAT_006f6930 (per exe tick) */
  const AIR_DAMP_HZ = 36;         /* task rate the per-tick constant assumes */
  /* (the exe loose-object bounce _DAT_006f664c/_006ef640/_006f4110 — restitution
     0.3 + scrub 0.94 — is intentionally NOT used for the car: the contact solver
     resolves every hit inelastically, so the car lands dead and heavy) */
  const SURF_VZ_MAX = 12;         /* clamp on the noisy surface-follow velocity */
  const SURF_VZ_TAU = 0.04;       /* low-pass time-const for the same (s) */
  const AIR_MIN_GAP_M = 0.055;    /* takeoff only past a real gap — seam noise
                                     was strobing airborne at 2 cm */
  const FADE_RECOVER_PER_S = 10;  /* ballistic-band tire load recovery rate —
                                     the footprint rebuilds over ~0.1 s, it
                                     doesn't slam back in one frame */
  const AIR_CONTACT_Z_M = 0.018;      /* land/contact band (hysteresis vs takeoff) */
  const SURF_Z_STEP_MAX = 0.12;       /* allowed deviation (m/frame) from the
                                         PREDICTED surface line — see step():
                                         the prediction extrapolates along the
                                         followed rate so real grades track
                                         exactly (a fixed per-frame clamp lagged
                                         metres on fast descents), while seam
                                         step-spikes deviate and get capped
                                         (a raw rate clamp let ≤0.5 m spikes
                                         through — the ground teleported under
                                         the car at speed: "hit something") */
  const AIRBORNE_HOLD_S = 0.10;       /* min flight time after takeoff — kills seam strobe */
  const WHEELS_FIRST_PITCH_RAD = 0.5;   /* landing attitude window → suspension */
  const WHEELS_FIRST_ROLL_RAD = 0.6;    /* recapture instead of a body bounce */
  const REV_STOP_U_MPS = 0.15;          /* forward body speed must bleed off */
  const REV_STOP_SPD_MPS = 0.45;        /* total speed before R + throttle */
  const BURNOUT_ENTER_SPD = 4;          /* both pedals below this = brake-stand */
  const BURNOUT_EXIT_SPD = 12;          /* latched burnout ends past this (or on
                                           pedal lift) — matches the physics
                                           inBurnout gate so neither side cuts
                                           the spin while the other holds it */
  const BURNOUT_HOLD_S = 0.4;           /* aids stay out this long across slip
                                           dips while the throttle stays down */
  /* airborne HEAVINESS (feel, 2026-07-09): flights read floaty at 1.0 — a
     little extra gravity and air authority while OFF the wheels makes jumps
     drop harder and tumbles scrub energy faster. Grounded tire loads, the
     grounded panel-aero calibration and the blowover pivot threshold are
     untouched (they use G / the grounded panelAero call directly). */
  const AIR_GRAV_SCALE = 1.15;
  const AIR_AERO_SCALE = 1.15;
  /* touchdown regrip (2026-07-10, Cameron: "when I land the tires instantly
     have grip"): a freshly-landed patch is sliding and the carcass is still
     dumping spring energy — µ ramps from (1−REGRIP_DROP) back to full over
     REGRIP_S after the wheels-down handoff. Stand-in curve; no decoded exe
     constant for this (the exe gets it emergently from tire temp/pressure
     transients we don't model). */
  const REGRIP_S = 0.6;
  const REGRIP_DROP = 0.55;
  /* the penalty is sized for a REAL jump (REGRIP_FULL_AIR_S of flight); a
     micro-hop over a banking dip scales down proportionally — a 0.1 s hop
     mid-corner must not cost 55% grip for 0.6 s ("the car loses control") */
  const REGRIP_FULL_AIR_S = 0.5;
  const BLOWOVER_MIN_MPS = 30;    /* backwards lift can pivot the car past this
                                     (~67 mph — a spun car this fast can still
                                     catch air; 40 was too high: a scrubbing spin
                                     dropped under it before the lift acted, so
                                     natural spins never flipped) */
  const LIFTOFF_HOLD_S = 0.10;    /* lift must beat the pivot for this long
                                     (0.05 fired on transient lift spikes as a
                                     spin's slide angle swept past broadside) */
  const PIVOT_REFIRE_S = 0.5;     /* no pivot re-fire this long after ANY landing:
                                     the marginal-lift regime (over threshold but
                                     unable to sustain flight) used to machine-gun
                                     fire-hop-land-refire every ~10 frames — the
                                     "bounces and fights the wind" feel. Blocked,
                                     the car rides the PRELEAN torque leaned on its
                                     springs instead; a genuine blowover fires once
                                     and flies away, never re-triggering. */
  /* blowover pivot threshold as a fraction of car weight. The reversed-flow
     lift acts on the deck/rear-overhang — AHEAD of the now-leading axle — so it
     tips the car about the trailing axle at LESS than the half-weight moment a
     centred load needs. 0.20 puts the onset near ~120 mph backwards, so a car
     that spins at racing speed and stays reversed FLIPS — the whole point of the
     roof flaps (a real spun Cup car gets light and flies in that range, like
     NR2003). 0.30 (~150 mph) needed such a fast reversed slide that natural
     spins scrubbed below it and just spun flat. Blowover only engages in
     reversed/broadside flow (aero LIFT, not the downforce of normal driving), so
     lowering it can't trip a car that's racing straight. p.blowoverScale (the
     onset slider) divides this: >1 = flies sooner, <1 = needs more speed. */
  const BLOWOVER_LIFT_FRAC = 0.20;
  /* aero ROLL moment → sprung body, but only in the net-LIFT regime (spins,
     backwards/broadside slides). The XLIFT floor quarters scoop air under the
     windward rocker: that torque must LEAN the car on its springs while the
     wheels still touch — the windward side visibly rises as the air gets
     under it — so the blowover pivot, when it fires, CONTINUES a motion the
     driver already sees instead of stepping vz+roll in from a dead-flat pose
     in one frame ("spins, then pops"). Faded in over the first kN of net
     lift and ZERO in the downforce regime: the calibrated grounded handling
     (side-force roll is already in ay·hRollArm) is untouched. Pitch needs no
     twin — the axle split (t[1] via dfFront/dfRear) already leans the body
     tail-up in a backwards slide. */
  const AERO_ROLL_GATE_N = 1500;    /* net lift over which the panel roll moment is fully in */
  const AERO_ROLL_TQ_MAX = 30000;   /* N·m integrator guard on that torque */
  /* the lean torque is FILTERED before it reaches the springs: raw lift
     swings hundreds of N frame-to-frame as the slide angle sweeps, and an
     unfiltered 24 kN·m stepping on/off rang the body against its own springs
     ("suspension so stiff it bounces"). Asymmetric: builds at wind speed,
     releases like a real unloading — never snaps back. */
  const PRELEAN_RISE_S = 0.10;
  const PRELEAN_FALL_S = 0.30;
  const PRELEAN_TQ_NM = 24000;      /* windward-up roll torque at lift == pivot threshold,
                                       broadside share applied — sized for a clearly
                                       visible (~2-3°) spring-space lean, tuned against
                                       the saved-state 163 mph full-left spin repro */
  /* share of a touchdown's closing speed the SPRUNG body actually sees —
     the unmodeled tire carcass/sidewall eats the first slice, so seeding
     the suspension with the full rate expressed a whole landing in ONE
     render frame (a 7 cm/frame heave snap = the "wheel slams down" feel) */
  const RECAPTURE_SOFT = 0.6;
  const MAX_RECAPTURE_VZ = 3;     /* m/s of impact the suspension can swallow;
                                     harder landings bottom out (excess lost). Lowered
                                     from 5: a 5 m/s heave slammed into the sprung body
                                     read as a post-landing pogo/bob — 3 gives a firm
                                     squat that settles in one compression */
  /* body OBB for wall hits + body-rest clearance (matches viewer wallCollide) */
  const CAR_HALF_LEN_F = 2.65;
  const CAR_HALF_LEN_R = 2.60;
  const CAR_HALF_WIDTH = 0.95;
  const CAR_BODY_HALF_H = 0.55;   /* roof/splitter reach above the tyre plane */
  const BODY_GROUND_GAP_M = 0.02; /* daylight under the lowest body corner */

  /* lowest world-Z of the body OBB after attPitch/attRoll/yaw.
     pitch + = nose down, roll + = left up (viewer / snapshot convention). */
  function bodyGroundLift(pitch, roll, yaw) {
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    let minZ = Infinity;
    for (const lx of [CAR_HALF_LEN_F, -CAR_HALF_LEN_R]) {
      for (const ly of [CAR_HALF_WIDTH, -CAR_HALF_WIDTH]) {
        for (const lz of [-CAR_BODY_HALF_H, CAR_BODY_HALF_H]) {
          const x1 = lx * cp + lz * sp;
          const z1 = -lx * sp + lz * cp;
          const z2 = ly * sr + z1 * cr;
          minZ = Math.min(minZ, z2);
        }
      }
    }
    return Math.max(0, -minZ + BODY_GROUND_GAP_M);
  }
  /* extra RENDER clearance when the body is tilted on its tyres (landing
     residual pitch, roll against a SAFER wall): lift only what the REAL
     body silhouette needs to stay out of the road. The old wall-OBB version
     (±0.55 m about the tyre plane) grew ~2.65·sin(pitch) from the first
     fraction of a degree — normal suspension attitudes commanded a few cm
     of phantom lift and every touchdown with residual pitch popped the car
     ~10 cm UP in one frame while the springs pulled it down (the ground
     half of "fighting air and ground"). The real splitter sits 7 cm over
     the tyre plane: small attitudes need NO lift, exactly like _restLift
     and the body-contact rework before it (see BODY_CONTACT_PTS note). */
  function bodyAttitudeExtraLift(pitch, roll, pts) {
    const P = (pts && pts.length) ? pts : BODY_CONTACT_PTS;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    let minZ = Infinity;
    for (const [lx, ly, lz] of P) {
      const z1 = -lx * sp + lz * cp;
      const z2 = ly * sr + z1 * cr;
      if (z2 < minZ) minZ = z2;
    }
    return Math.max(0, -minZ);
  }

  /* world-frame wall-test points from the car's REAL body shape at its
     CURRENT attitude — "what you see is what you hit". Each bodyPt (tyre-
     plane frame) rotates by the same attitude the renderer composes: the
     flight quaternion off the wheels, the surface-basis + suspension
     pitch/roll grounded. Returns planar offsets from the CG (the exe wall
     path is strictly planar) plus the point's height above the LOCAL
     surface, so the caller gates each point against a wall's real height
     span — a low wall is only hit by low bodywork, a flying car clears it
     with exactly the parts that visually clear it. `lift` = tyre-plane
     height above the surface (0 grounded; zPos − surfHeight off wheels). */
  function wallContactPoints(car, up, lift) {
    const off = (car.airborne || car.restingOnBody) && car._airActive;
    let q;
    if (off) q = [car.qw, car.qx, car.qy, car.qz];
    else {
      const a = car._bodyAttitude();
      q = composeRenderQuat(up || car.up || [0, 0, 1], car.yaw, a.pitch, a.roll);
    }
    const out = [];
    for (const pt of car.bodyPts) {
      const v = qRot(q, pt);
      out.push({ ox: v[0], oy: v[1], hz: v[2] + (lift || 0) });
    }
    return out;
  }

  /* mesh-accurate hitbox extraction ("what you see is what you hit"): a
     support-point cloud of the real body-part vertices. Two passes:
     - fibonacci-sphere fan → GLOBAL extremes (roof, splitter, bumper tips);
     - profile slices → the widest left/right vertex per (length × height)
       cell and the farthest nose/tail vertex per (width × height) cell.
     The slices are load-bearing for HEIGHT-GATED wall contacts: a Cup
     body's widest points are its beltline/fenders (~0.8-1.2 m up), so a
     global-extremes-only cloud let the car sink into a 1.0 m SAFER until
     the narrower bumper corners caught — the rocker/door profile has to
     exist at every height a wall can touch.
     meshes: [{verts: Float32Array xyz, count}], mapped into the physics
     frame exactly as rendered: x − xMid, z − bodyFloorZ + floorM. */
  const HULL_DIRS = 130;
  const HULL_DEDUPE_M = 0.04;
  const HULL_MIN_PTS = 8;
  const SLICE_X_M = 0.6;          /* length cell for the side profile */
  const SLICE_Y_M = 0.45;         /* width cell for the nose/tail profile */
  const SLICE_Z_M = 0.3;          /* height band for both profiles */
  function meshSupportPoints(meshes, opts) {
    const { bodyFloorZ, xMid, floorM } = opts;
    if (![bodyFloorZ, xMid, floorM].every(Number.isFinite)) return null;
    const dirs = [];
    const GA = Math.PI * (3 - Math.sqrt(5));      /* fibonacci sphere */
    for (let k = 0; k < HULL_DIRS; k++) {
      const z = 1 - (2 * k + 1) / HULL_DIRS;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      dirs.push([Math.cos(GA * k) * r, Math.sin(GA * k) * r, z]);
    }
    const best = new Array(HULL_DIRS).fill(null);
    const sideMax = new Map();    /* (ix,iz) → widest +y / −y vertex */
    const sideMin = new Map();
    const longMax = new Map();    /* (iy,iz) → farthest +x / −x vertex */
    const longMin = new Map();
    for (const m of meshes) {
      for (let i = 0; i < m.count; i++) {
        const x = m.verts[i * 3], y = m.verts[i * 3 + 1], z = m.verts[i * 3 + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        for (let k = 0; k < HULL_DIRS; k++) {
          const d = dirs[k];
          const dot = x * d[0] + y * d[1] + z * d[2];
          if (!best[k] || dot > best[k].dot) best[k] = { dot, x, y, z };
        }
        const iz = Math.floor((z - bodyFloorZ) / SLICE_Z_M);
        const ix = Math.floor((x - xMid) / SLICE_X_M);
        const iy = Math.floor(y / SLICE_Y_M);
        const kS = ix * 97 + iz;
        if (!sideMax.has(kS) || y > sideMax.get(kS).y) sideMax.set(kS, { x, y, z });
        if (!sideMin.has(kS) || y < sideMin.get(kS).y) sideMin.set(kS, { x, y, z });
        const kL = iy * 97 + iz;
        if (!longMax.has(kL) || x > longMax.get(kL).x) longMax.set(kL, { x, y, z });
        if (!longMin.has(kL) || x < longMin.get(kL).x) longMin.set(kL, { x, y, z });
      }
    }
    const cands = best.filter(Boolean);
    for (const map of [sideMax, sideMin, longMax, longMin]) {
      for (const v of map.values()) cands.push(v);
    }
    const pts = [];
    for (const b of cands) {
      const px = b.x - xMid;
      const py = b.y;
      const pz = floorM + (b.z - bodyFloorZ);
      const dup = pts.some((q) => Math.abs(q[0] - px) < HULL_DEDUPE_M
        && Math.abs(q[1] - py) < HULL_DEDUPE_M && Math.abs(q[2] - pz) < HULL_DEDUPE_M);
      if (!dup) pts.push([px, py, pz]);
    }
    return pts.length >= HULL_MIN_PTS ? pts : null;
  }

  /* The runtime aero-attitude LUT (car+0x58a +0xe8, evaluated by FUN_005677d1
     inside the FUN_0051eca0 downforce build — the reverse/high-yaw
     coefficients are runtime-only, needs the live Windows dump) is stood in
     for by the multi-surface panel model (AERO_PANELS/panelAero below): as
     the body rotates broadside/backwards to the flow the exposed panels make
     progressively more side force and lift — blowover onset stays calibrated
     at ~87 m/s ≈ 195 mph reversed (lift > m·g/2), the documented regime. */

  /* ---- 3D rigid-body flight (quaternion) ------------------------------
     Body frame: x̂ fwd, ŷ left, ẑ up. Viewer composition R = Rz(yaw)·
     Ry(pitch)·Rx(roll) with pitch + = nose down, roll + = left up.
     Quaternion stored [w,x,y,z], world←body. The old independent Euler
     attPitch/attRoll axes broke down whenever the car was yawed AND
     pitched (every tumble); the quaternion tracks any attitude. */
  function qMul(a, b) {
    return [
      a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
      a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
      a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
      a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
  }
  function qNorm(q) {
    const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  }
  function qRot(q, v) {           /* rotate body→world */
    const w = q[0], x = q[1], y = q[2], z = q[3];
    const tx = 2 * (y * v[2] - z * v[1]);
    const ty = 2 * (z * v[0] - x * v[2]);
    const tz = 2 * (x * v[1] - y * v[0]);
    return [
      v[0] + w * tx + (y * tz - z * ty),
      v[1] + w * ty + (z * tx - x * tz),
      v[2] + w * tz + (x * ty - y * tx)];
  }
  function qRotInv(q, v) { return qRot([q[0], -q[1], -q[2], -q[3]], v); }
  /* shortest-arc slerp for render interpolation between two fixed-step sim
     attitudes. Flip the second quat into the same hemisphere first (q and −q
     are the same rotation, but the raw path between them takes the long way),
     then fall back to nlerp when they are nearly parallel (sinθ→0). */
  function qSlerp(a, b, t) {
    let bw = b[0], bx = b[1], by = b[2], bz = b[3];
    let dot = a[0] * bw + a[1] * bx + a[2] * by + a[3] * bz;
    if (dot < 0) { bw = -bw; bx = -bx; by = -by; bz = -bz; dot = -dot; }
    if (dot > 0.9995) {
      return qNorm([a[0] + (bw - a[0]) * t, a[1] + (bx - a[1]) * t,
        a[2] + (by - a[2]) * t, a[3] + (bz - a[3]) * t]);
    }
    const theta = Math.acos(dot), s = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / s, wb = Math.sin(t * theta) / s;
    return [a[0] * wa + bw * wb, a[1] * wa + bx * wb,
      a[2] * wa + by * wb, a[3] * wa + bz * wb];
  }
  /* shortest-arc scalar lerp for wrapping angles (yaw): interpolate along the
     ≤π delta so heading never spins the long way through the ±π seam */
  function lerpAngle(a, b, t) {
    let d = (b - a) % (2 * Math.PI);
    if (d > Math.PI) d -= 2 * Math.PI;
    else if (d < -Math.PI) d += 2 * Math.PI;
    return a + d * t;
  }
  function qFromYPR(yaw, pitch, roll) {
    const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
    const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
    const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
    return qNorm(qMul(qMul([cy, 0, 0, sy], [cp, 0, sp, 0]), [cr, sr, 0, 0]));
  }
  function qToYPR(q) {
    const fwd = qRot(q, [1, 0, 0]);
    const left = qRot(q, [0, 1, 0]);
    const up = qRot(q, [0, 0, 1]);
    return {
      yaw: Math.atan2(fwd[1], fwd[0]),
      pitch: Math.asin(clamp(-fwd[2], -1, 1)),
      roll: Math.atan2(left[2], up[2]),
    };
  }
  function cross3(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }

  /* THE rendered-attitude composition — single source of truth for the car's
     world orientation on a surface: basis (X=fwd from yaw ⊥ up, Y=left,
     Z=up), then pitch about local Y and roll about local X. The viewer
     (placeCar), _takeOff and the landing handoff all build attitude through
     THIS function. Before, _takeOff used world-ZYX Euler (qFromYPR) while the
     viewer composed a surface basis — the two agree on flat ground but split
     by several degrees when banking and grade combine, so every takeoff from
     a banked crest SNAPPED the body to a slightly different tilt ("tilts
     like a hardcode") and every landing fought its way back. */
  function composeRenderQuat(up, yaw, pitch, roll) {
    let fx = Math.cos(yaw), fy = Math.sin(yaw), fz = 0;
    let l = cross3(up, [fx, fy, fz]);                 /* left = up × fwd */
    const ln = Math.hypot(l[0], l[1], l[2]);
    if (ln < 1e-6) return qFromYPR(yaw, pitch, roll); /* degenerate up ∥ fwd */
    l = [l[0] / ln, l[1] / ln, l[2] / ln];
    const f = cross3(l, up);                          /* fwd = left × up */
    /* column basis [fwd|left|up] → quaternion (Shepperd) */
    const m00 = f[0], m01 = l[0], m02 = up[0];
    const m10 = f[1], m11 = l[1], m12 = up[1];
    const m20 = f[2], m21 = l[2], m22 = up[2];
    const tr = m00 + m11 + m22;
    let qb;
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      qb = [s / 4, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
    } else if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      qb = [(m21 - m12) / s, s / 4, (m01 + m10) / s, (m02 + m20) / s];
    } else if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      qb = [(m02 - m20) / s, (m01 + m10) / s, s / 4, (m12 + m21) / s];
    } else {
      const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      qb = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, s / 4];
    }
    const qp = [Math.cos(pitch / 2), 0, Math.sin(pitch / 2), 0];
    const qr = [Math.cos(roll / 2), Math.sin(roll / 2), 0, 0];
    return qNorm(qMul(qMul(qb, qp), qr));
  }

  /* decompose a world attitude against a surface basis → the local pitch/roll
     that composeRenderQuat(up, yaw, pitch, roll) would need to reproduce it.
     Exact inverse (qRel ≈ Ry(pitch)·Rx(roll)) — the landing handoff used the
     Euler-view difference before, which drifts on combined bank + grade. */
  function decomposeSurfPR(q, up, yaw) {
    const qb = composeRenderQuat(up, yaw, 0, 0);
    const qRel = qMul([qb[0], -qb[1], -qb[2], -qb[3]], q);
    const fwdR = qRot(qRel, [1, 0, 0]);
    const leftR = qRot(qRel, [0, 1, 0]);
    const upR = qRot(qRel, [0, 0, 1]);
    return {
      pitch: Math.atan2(-fwdR[2], fwdR[0]),
      roll: Math.atan2(-upR[1], leftR[1]),
    };
  }

  /* world-z of the body-up axis for a [w,x,y,z] attitude quaternion */
  function quatUpZ(q) {
    return 1 - 2 * (q[1] * q[1] + q[2] * q[2]);
  }

  /* THE model placement height — single source of truth, like
     composeRenderQuat is for attitude. snapshot z anchors the BODY-frame
     tyre plane (the CG rides cgHeight above it along body-up), and the
     model file's origin sits -floorZ above that same plane — a body-frame
     offset. So the model origin belongs at zAnchor − floorZ·upBz.
     Subtracting floorZ as a world-vertical constant (the old code) is only
     right while upright: inverted it floated the car 2·|floorZ| off the
     ground ("floats on its roof"), and mid-tumble the error swung
     continuously with attitude — fake vertical bob every rotation. */
  function renderOriginZ(zAnchor, floorZ, upBz) {
    return zAnchor - floorZ * upBz;
  }

  /* world offset of the tyre-plane ANCHOR from the model-file origin: the
     anchor sits at model-space (xMid, 0, floorZ) — a BODY vector. The model
     origin belongs at anchor − R·[xMid,0,floorZ]. Projecting only its z
     (renderOriginZ) pinned the origin's x/y to the anchor, so a tumbling
     car ORBITED its own CG horizontally by |[xMid,floorZ]| (~35 cm) once
     per roll — read as "the center of mass is off / flips lopsided" (the
     physics CG is symmetric and ballistic; mirror-spin drift is exactly
     equal-and-opposite). */
  function renderAnchorOffset(q, xMid, floorZ) {
    return qRot(q, [xMid || 0, 0, floorZ || 0]);
  }

  /* flight tuning — NR dumped constants stay authoritative for damping and
     the object bounce; the rigid-body/aero shape below is the custom half */
  const AIR_INERTIA = [900, 2400, 3400];  /* whole-car Ixx/Iyy/Izz (roll/pitch/yaw) */
  const CREST_SEED_FRAC = 0.5;      /* share of the surface pitch rate the body keeps
                                       at takeoff (suspension droop decouples the rest) */

  /* ---- multi-surface aero (2026-07-09 overhaul) -------------------------
     The car is a COLLECTION OF FLAT-PLATE PANELS, not one drag/lift number.
     Every step: relative wind per panel (freestream + ω×r, so a rotating
     body damps itself physically), that panel's angle of attack against its
     own facing, quadratic-Newtonian normal force cn·sinα·|sinα| applied AT
     THE PANEL. Drag (a tilted panel's normal force leans backwards), side
     force, pitch/roll/yaw moments, centre-of-pressure migration (wake
     shadowing exposes the into-wind panels), aero damping, spin instability
     and blowovers all EMERGE from the geometry — this replaces the
     hand-tuned PLATE_ARM/TAIL_STAB/BACKWARDS_LIFT arm fractions. v² lives
     in qd, so small coefficient changes matter a lot at 200 mph (correct).

     Panels: body frame (x fwd, y left, z up), positions on the TYRE-PLANE
     z origin, CG at (0,0,cgHeight). Areas are EFFECTIVE (a surface carries
     the adjacent structure it pressurizes — e.g. the spoiler's deck).
     Calibrated so level trim reproduces the previous dumped-total model
     (CzA 3.60 / CxA 1.45 / 42% front / blowover onset ≈ 87 m/s) — the
     handling contracts pin those numbers. */
  const AERO_PANELS = [
    /* floor quarters — ground-effect suction (ge>0: splitter-sealed suction
       forward-biased) + the flat plate a blowover rides on; wakeable, so
       the into-wind quarters carry the force = CoP migration for free.
       xl<0 = broadside underbody scoop (see XLIFT): a deep-sideways car rams
       air under the exposed rocker; the into-wind quarters carry it (wake),
       so the windward side lifts first = the barrel-roll blowover. */
    { nm: 'floorFL', pos: [1.30, 0.47, 0.07], nrm: [0, 0, -1], A: 2.30, cn: 2.0, ge: 1.05, wake: 1, xl: -0.34 },
    { nm: 'floorFR', pos: [1.30, -0.47, 0.07], nrm: [0, 0, -1], A: 2.30, cn: 2.0, ge: 1.05, wake: 1, xl: -0.34 },
    { nm: 'floorRL', pos: [-1.30, 0.47, 0.07], nrm: [0, 0, -1], A: 2.30, cn: 2.0, ge: 1.05, wake: 1, xl: -0.34 },
    { nm: 'floorRR', pos: [-1.30, -0.47, 0.07], nrm: [0, 0, -1], A: 2.30, cn: 2.0, ge: 1.05, wake: 1, xl: -0.34 },
    /* greenhouse / topsides. Roof xl>0 = crossflow suction: broadside, the
       flow accelerating over the greenhouse pulls the roof up (why real spun
       stock cars get light side-on — the body is a crude wing in crossflow) */
    { nm: 'hood', pos: [1.75, 0, 0.88], nrm: [0.166, 0, 0.986], A: 1.60, cn: 1.2, ge: 0, wake: 0 },
    { nm: 'shield', pos: [0.55, 0, 1.16], nrm: [0.440, 0, 0.898], A: 1.10, cn: 1.3, ge: 0, wake: 0 },
    { nm: 'roof', pos: [-0.30, 0, 1.32], nrm: [0, 0, 1], A: 1.80, cn: 1.5, ge: 0, wake: 0, xl: 0.34 },
    { nm: 'rglass', pos: [-1.55, 0, 1.15], nrm: [-0.350, 0, 0.937], A: 1.00, cn: 1.0, ge: 0, wake: 1 },
    /* spoiler: the physical blade (normal set per-car from spoilerDeg) +
       the deck pressure field it builds upstream (forward flow only).
       Split chosen so the STATIC force matches the legacy rear share while
       the α-SLOPE (plate area × cn) is big — that slope is the pitch
       stability that flies crest jumps flat (tailplane effect). */
    { nm: 'blade', pos: [-2.45, 0, 1.02], nrm: null, A: 0.50, cn: 0.75, ge: 0, wake: 0, blade: 1 },
    { nm: 'deck', pos: [-2.00, 0, 1.03], nrm: [0, 0, 1], A: 2.00, cn: 2.0, ge: 0, wake: 0, deck: 1 },
    /* pressure faces + flanks. Side centroid sits BEHIND mid (greenhouse +
       blade side area) — side force applied there is the yaw weathervane.
       Flank cn 1.1 → 0.5 (2026-07-09, Cameron: "wind too strong — pulls the
       car around, spins slow down way too fast sideways"): 1.1 on 4.4 m²
       made broadside aero 1.78 g at 80 m/s (5× forward drag) and a
       14.6 kN·m weathervane whip (4.3 rad/s² on its own) — a spin bled
       80→40 m/s in 2.2 s at 2.36 g peak. 0.5 keeps the crosswind surface
       real (~2.5× forward drag broadside) but stops the slam/whip. */
    { nm: 'nose', pos: [2.62, 0, 0.45], nrm: [1, 0, 0], A: 0.70, cn: 0.55, ge: 0, wake: 1 },
    { nm: 'tail', pos: [-2.58, 0, 0.62], nrm: [-1, 0, 0], A: 1.30, cn: 0.45, ge: 0, wake: 1 },
    /* cpx: the flank pressure centroid migrates to MID-BODY as the flow goes
       broadside (attached small-slip crossflow loads the aft greenhouse/blade
       side area = weathervane; separated broadside flow loads the whole slab
       evenly = yaw-neutral). Without this the weathervane torque parked every
       spin at ~90° — a real spin carries through to 180 (Cameron, 2026-07-10:
       "the wind shouldn't prevent the car turning 180 when spinning"). */
    { nm: 'sideL', pos: [-0.55, 0.96, 0.60], nrm: [0, 1, 0], A: 4.40, cn: 0.5, ge: 0, wake: 1, cpx: 1 },
    { nm: 'sideR', pos: [-0.55, -0.96, 0.60], nrm: [0, -1, 0], A: 4.40, cn: 0.5, ge: 0, wake: 1, cpx: 1 },
    /* roof flaps — only when deployed (reversed flow pops them) */
    { nm: 'flapL', pos: [-0.20, 0.45, 1.33], nrm: [-0.82, 0, 0.57], A: 0.55, cn: 1.8, ge: 0, wake: 0, flap: 1 },
    { nm: 'flapR', pos: [-0.20, -0.45, 1.33], nrm: [-0.82, 0, 0.57], A: 0.55, cn: 1.8, ge: 0, wake: 0, flap: 1 },
  ];
  const GE_SUCTION = 0.38;       /* floor camber (as sinα) at full ground effect */
  const SPOILER_DECK_K = 0.30;   /* deck pressure per sin(spoiler angle) */
  const WAKE_MIN = 0.35;         /* a fully-shadowed panel keeps this share */
  const WAKE_L = 1.6;            /* m — smoothing length of the wake blend */
  const CD_SKIN = 0.012;         /* per-panel skin/profile drag coefficient */
  /* user "drag" slider (p.dragScale, 1 = stock calibration): a body-drag CdA
     added along the freestream to make the car faster/slower WITHOUT touching
     grounded downforce (a clean top-speed knob, not a grip trade). The SAME
     slider amplifies the airborne pressure force so a draggy car catches more
     air and blows over easier, a slippery one stays planted. */
  const DRAG_SLIDER_CDA = 1.45;  /* == PARAMS.dragCxA calibration target */
  const BLOWOVER_COUPLING = 0.5; /* how hard dragScale bends the airborne aero */
  const FLOOR_DIR_W = 0.35;      /* flow-direction blend width for the floor
                                    camber: nose-first = suction, tail-first
                                    = the tail scoops air UNDER the car =
                                    LIFT (why backwards cars fly), sideways
                                    = the seal is gone, neither */
  /* sideslip kills the splitter seal LONG before the flow reverses — the
     old gate (|wHat[0]| only) kept near-FULL floor suction to ~70° of body
     slip, so a spinning car was still pressed into the road and the tyre
     scrub alone read 1.6 g ("slows down way too fast sideways"). Full seal
     below ~20° slip (race slip angles are ≤10° — handling untouched),
     stalled by ~44°. Straight backwards (wHat[1]=0) is unaffected, so the
     blowover/roof-flap contracts keep their calibration. */
  const GE_YAW_SEAL_START = 0.35;   /* |sin beta| where the seal starts stalling */
  const GE_YAW_SEAL_W = 0.35;       /* fade width to fully stalled */
  /* the tail-first scoop's inlet is the exposed TAIL, not the splitter seal —
     it tolerates far more crossflow before stalling. A wider gate here fills
     the old 120–155° lift dip (crossflow lift fading while the scoop was
     still seal-blocked) so the spin sweep is one smooth curve. */
  const GE_YAW_SEAL_REV_START = 0.55;
  /* XLIFT — crossflow lift (2026-07-10, Cameron: "sideways at 205 the car
     should lift like it does backwards"). The old model only made lift in a
     narrow cone around dead-backwards (the tail-first floor scoop); a
     broadside car generated NOTHING vertical, so it could be held sideways
     at any speed. Panels with xl get a crossflow camber xl·xGate: floor
     quarters scoop air under the windward rocker (xl<0 on nrm −z = lift at
     the exposed side → roll), the roof gets greenhouse suction (xl>0).
     Gate starts at ~37° body slip, full by ~64° (2026-07-10 retune: the old
     22°-onset gate was 88% open at a 45° DRIFT — it lifted the windward
     rocker mid-drift and the leading corner visibly popped up every time;
     a drift is not a broadside slide. Broadside (75-90°) still gets gate 1,
     so the sideways-blowover calibration below is untouched). Sized so
     broadside lift ≈ the backwards scoop (~9 kN at 205 mph):
     ΣA·cn·expose·xl² ≈ 1.75 m² ⇒ broadside liftoff ≈ 65 m/s (~145 mph),
     the same onset as dead-backwards. */
  const XLIFT_ONSET = 0.6;          /* |sin β| where crossflow lift starts */
  const XLIFT_W = 0.3;              /* fade width to full crossflow lift */
  /* broadside CoP relaxation: how far the flank centroid slides to mid-body
     at full crossflow (1 = fully neutral). Rides the same xGate as XLIFT. */
  const CP_BROADSIDE_RELAX = 1.0;

  /* per-car panel geometry: the CALIBRATED Cup panel model scaled to the
     loaded model's measured mesh dimensions (a truck exposes more flank and
     roof than a Cup body, a low car less). Positions scale per-axis, normals
     re-normalize under the inverse scale, areas scale by the panel-plane
     axes (dominant-normal share). Coefficients (cn/ge/wake/deck/blade) stay
     — they carry the NR calibration, not the geometry. */
  function scaleAeroPanels(sx, sy, sz) {
    const s = [sx, sy, sz].map((v) => clamp(Number.isFinite(v) ? v : 1, 0.7, 1.4));
    if (s.every((v) => Math.abs(v - 1) < 0.02)) return null;
    return AERO_PANELS.map((P) => {
      const nrm0 = P.blade ? [Math.sin(70 * Math.PI / 180), 0, Math.cos(70 * Math.PI / 180)] : P.nrm;
      const nInv = [nrm0[0] / s[0], nrm0[1] / s[1], nrm0[2] / s[2]];
      const nLen = Math.hypot(nInv[0], nInv[1], nInv[2]) || 1;
      const nrm = P.blade ? null : [nInv[0] / nLen, nInv[1] / nLen, nInv[2] / nLen];
      /* area scales with the two axes spanning the panel plane: full volume
         scale divided by the scale along the normal */
      const sN = Math.abs(nrm0[0]) * s[0] + Math.abs(nrm0[1]) * s[1] + Math.abs(nrm0[2]) * s[2];
      const A = P.A * (s[0] * s[1] * s[2]) / sN;
      return { ...P, pos: [P.pos[0] * s[0], P.pos[1] * s[1], P.pos[2] * s[2]], nrm, A };
    });
  }

  /* panel force/torque sum, body frame about the CG.
     vB body-frame velocity (m/s), wb body angular rate [p,q,r] (rad/s),
     o = { rho, cgH, ge 0..1, flaps, dmg 0..1, spoilerDeg, panels? }.
     Returns { f:[x,y,z] N, t:[x,y,z] N·m, lift: net +z N (blowover gate) } */
  function panelAero(vB, wb, o) {
    const f = [0, 0, 0], t = [0, 0, 0];
    /* o.detail: collect per-panel body-frame forces (wind-tunnel viz — the
       arrows you see ARE the panels the sim integrates; off the hot path) */
    const det = o.detail ? [] : null;
    const sFree = Math.hypot(vB[0], vB[1], vB[2]);
    if (sFree < 2) return { f, t, lift: 0, panels: det };
    const vHat = [vB[0] / sFree, vB[1] / sFree, vB[2] / sFree];
    const spoilerA = ((o.spoilerDeg || 70) * Math.PI) / 180;
    const dmgAero = 1 - 0.35 * (o.dmg || 0);
    const dragScale = Number.isFinite(o.dragScale) ? o.dragScale : 1;
    /* the drag slider bends the LIFT the car makes (see the net-lift block after
       the panel loop) — a draggy car catches more air when it spins/goes
       backwards and blows over easier; a slippery one stays planted. Gated on
       net lift so normal downforce (grip) is never touched. */
    const liftMul = clamp(1 + (dragScale - 1) * BLOWOVER_COUPLING, 0.4, 2.0);
    /* crossflow share of the freestream — drives the XLIFT panels */
    const xGate = clamp((Math.abs(vHat[1]) - XLIFT_ONSET) / XLIFT_W, 0, 1);
    for (const P of (o.panels || AERO_PANELS)) {
      if (P.flap && !o.flaps) continue;
      const n = P.blade ? [Math.sin(spoilerA), 0, Math.cos(spoilerA)] : P.nrm;
      /* flank CoP migrates to mid-body as the flow goes broadside (cpx) —
         the side FORCE stays, the weathervane lever collapses, so a spin
         sweeps through 90° instead of parking there */
      const px = P.cpx ? P.pos[0] * (1 - CP_BROADSIDE_RELAX * xGate) : P.pos[0];
      const r = [px, P.pos[1], P.pos[2] - o.cgH];
      /* local relative wind: freestream + rotation (ω×r) */
      const wx = -(vB[0] + wb[1] * r[2] - wb[2] * r[1]);
      const wy = -(vB[1] + wb[2] * r[0] - wb[0] * r[2]);
      const wz = -(vB[2] + wb[0] * r[1] - wb[1] * r[0]);
      const s = Math.hypot(wx, wy, wz);
      if (s < 1) continue;
      const qdA = 0.5 * o.rho * s * s * P.A;
      const wHat = [wx / s, wy / s, wz / s];
      const sG = wHat[0] * n[0] + wHat[1] * n[1] + wHat[2] * n[2];
      /* wake exposure: panels on the side the flow comes FROM see clean air */
      const upwind = P.pos[0] * vHat[0] + P.pos[1] * vHat[1] + P.pos[2] * vHat[2];
      const expose = P.wake
        ? WAKE_MIN + (1 - WAKE_MIN) * clamp(0.5 + upwind / (2 * WAKE_L), 0, 1)
        : 1;
      /* built-in incidence (attached-flow terms, damage-degradable):
         floor ground-effect suction (direction-gated) + spoiler deck field */
      let camb = 0;
      if (P.ge && o.ge > 0) {
        const dir = clamp(-wHat[0] / FLOOR_DIR_W, -1, 1);
        const xw = Math.abs(wHat[1]);
        /* nose-first suction needs the splitter seal (stalls by ~44° slip);
           the tail-first scoop's inlet is the exposed TAIL — it tolerates
           far more crossflow (GE_YAW_SEAL_REV_START) */
        const seal = dir > 0
          ? clamp(1 - (xw - GE_YAW_SEAL_START) / GE_YAW_SEAL_W, 0, 1)
          : clamp(1 - (xw - GE_YAW_SEAL_REV_START) / GE_YAW_SEAL_W, 0, 1);
        /* tail-first pressurization is leakier than sealed nose-first
           suction (REV_LIFT_FRAC) — sets the ~87 m/s blowover onset */
        camb = GE_SUCTION * P.ge * o.ge * (dir > 0 ? dir : dir * 0.86) * seal
          * (o.flaps ? 0.3 : 1) * dmgAero;
      } else if (P.deck) {
        const fwd = clamp(-wHat[0], 0, 1);
        camb = -SPOILER_DECK_K * Math.sin(spoilerA) * fwd
          * (o.flaps ? 0.35 : 1) * dmgAero;
      }
      /* XLIFT crossflow camber — floor scoop needs the ground to ram against
         (gated by o.ge like the suction it replaces sideways); roof suction
         is pure body shape, acts anywhere. Deployed roof flaps spoil it
         (×0.45 on camb ≈ ×0.2 on lift) — but flaps only blow open past
         ~100° off-nose, so a pure broadside slide gets the FULL lift.
         SAME-SIGN mechanisms combine in QUADRATURE: force goes as camb², so
         hypot(camb, xn) makes lift_total = lift_scoop + lift_crossflow —
         additive camber double-counted the 110–155° overlap (a 17 kN spike
         at 135° where either mechanism alone makes ~9). Opposite signs
         (dying nose-first suction vs building crossflow lift through
         25–45° slip) still cancel linearly, as they should. */
      if (P.xl && xGate > 0) {
        const xn = P.xl * xGate * (P.ge ? o.ge : 1) * (o.flaps ? 0.45 : 1);
        camb = (camb === 0 || (camb < 0) === (xn < 0))
          ? (xn < 0 || camb < 0 ? -1 : 1) * Math.hypot(camb, xn)
          : camb + xn;
      }
      let plate = P.blade && o.flaps ? 0.35 : 1;   /* flaps spoil the blade */
      /* exposed share feels the full (plate+camber) pressure; the shadowed
         share keeps only attached SUCTION (camb>0 — sealed nose-first
         underbody flow reaches the whole floor). Reversed-flow floor
         pressurization (camb<0 = lift) needs its inlet: it only acts
         through the EXPOSED share, so the into-wind end carries the lift —
         the tail-over-nose blowover moment falls out of that. */
      const sE = sG + camb;
      const coef = plate * (expose * sE * Math.abs(sE)
        + (1 - expose) * (camb > 0 ? camb * camb : 0));
      const Fm = qdA * P.cn * coef;
      const Fx = n[0] * Fm + wHat[0] * qdA * CD_SKIN;
      const Fy = n[1] * Fm + wHat[1] * qdA * CD_SKIN;
      const Fz = n[2] * Fm + wHat[2] * qdA * CD_SKIN;
      f[0] += Fx; f[1] += Fy; f[2] += Fz;
      t[0] += r[1] * Fz - r[2] * Fy;
      t[1] += r[2] * Fx - r[0] * Fz;
      t[2] += r[0] * Fy - r[1] * Fx;
      if (det) det.push({ nm: P.nm, pos: P.pos, f: [Fx, Fy, Fz] });
    }
    /* drag slider → blowover propensity: when the NET aero force is UPWARD
       (f[2]>0 — the reversed/high-yaw regime that lifts a spun car), scale that
       lift and the pitch/roll moments that tip it over. Zero during normal
       downforce (f[2]<0), so grounded grip is byte-identical at any dragScale. */
    if (liftMul !== 1 && f[2] > 0) {
      f[2] *= liftMul;
      t[0] *= liftMul;   /* roll moment (barrel blowover) */
      t[1] *= liftMul;   /* pitch moment (tail-over-nose) */
    }
    /* "Flaps prevent blowover" (o.flapsEffective) — spoil the UPWARD lift and the
       tip-over moments so the pivot can't fire. Regime-gated on net lift (f[2]>0),
       NOT the 100° visual deploy, so the broadside barrel-roll is actually killed;
       applied AFTER liftMul so the drag slider can't re-amplify it back over the
       threshold. Downforce (f[2]<0) and the weathervane side force / yaw are
       untouched. The "Test blowover" button clears the flag so it still flips. */
    if (o.flapsEffective && f[2] > 0) {
      f[2] *= FLAP_LIFT_KILL;
      t[0] *= FLAP_LIFT_KILL;
      t[1] *= FLAP_LIFT_KILL;
    }
    /* crumpled bodywork: extra drag along the freestream (old +50% at dmg 1) */
    const dmgDrag = 0.5 * (o.dmg || 0) * 0.5 * o.rho * sFree * sFree * 1.45;
    /* user drag slider: pure body-drag CdA along the freestream (0 at dragScale
       1). Acts grounded (top speed) AND airborne (air resistance in flight) —
       no lift component, so grounded downforce is untouched. */
    const sliderDrag = (dragScale - 1) * DRAG_SLIDER_CDA * 0.5 * o.rho * sFree * sFree;
    const totalDrag = dmgDrag + sliderDrag;
    f[0] -= vHat[0] * totalDrag;
    f[1] -= vHat[1] * totalDrag;
    f[2] -= vHat[2] * totalDrag;
    return { f, t, lift: Math.max(0, f[2]), panels: det };
  }

  /* wind-tunnel probe: the steady aero on the car at a given airspeed and yaw
     of the RELATIVE WIND off the nose (0 = head-on, π = dead backwards). Same
     panel model the sim runs; returns named forces so the viewer can draw them
     and show WHY a spun car lifts. `blowThreshN` is the weight-moment the lift
     must beat to pivot the real car over (so the UI can flag "blows over"). */
  function aeroProbe(speedMps, yawRad, opts) {
    opts = opts || {};
    const vB = [speedMps * Math.cos(yawRad), speedMps * Math.sin(yawRad), 0];
    const a = panelAero(vB, [0, 0, 0], {
      rho: Number.isFinite(opts.rho) ? opts.rho : PARAMS.airDensity,
      cgH: PARAMS.cgHeight, ge: opts.ge != null ? opts.ge : 1,
      flaps: !!opts.flaps, flapsEffective: !!opts.flapsEffective, dmg: opts.dmg || 0,
      spoilerDeg: Number.isFinite(opts.spoilerDeg) ? opts.spoilerDeg : PARAMS.spoilerDeg,
      panels: opts.panels || undefined,
      dragScale: Number.isFinite(opts.dragScale) ? opts.dragScale : 1,
      detail: !!opts.detail,
    });
    const bScale = Number.isFinite(opts.blowoverScale) ? opts.blowoverScale : 1;
    return {
      panels: a.panels || null,                 /* per-panel {nm,pos,f} when detail */
      fx: a.f[0], fy: a.f[1], fz: a.f[2],       /* body-frame N (x nose, y left, z up) */
      drag: -a.f[0],                            /* + = opposing nose-forward motion */
      side: a.f[1],
      lift: Math.max(0, a.f[2]),                /* + up (blowover regime) */
      downforce: Math.max(0, -a.f[2]),          /* + down (grip regime) */
      pitchMoment: a.t[1], rollMoment: a.t[0], yawMoment: a.t[2],
      blowThreshN: (BLOWOVER_LIFT_FRAC / bScale) * PARAMS.mass * G,
      weightN: PARAMS.mass * G,
    };
  }

  const AIR_MAX_ANG = 12;           /* rad/s tumble clamp */
  /* (the airborne wheel contact is a velocity-level inelastic impulse now — no
     penalty spring/damper/bump-stop constants; see the contact solver) */
  const WHEEL_AIR_MU_LAT = 1.0;     /* lateral friction share of tyre µ at touchdown */
  const WHEEL_VN_ARREST_SUB = 0.2;  /* m/s of sink arrested per 480 Hz substep —
                                       tire-carcass compliance spreads a touchdown
                                       over ~20 ms instead of one tick */
  const WHEEL_AIR_MU_LONG = 0.04;   /* free-rolling wheels: rolling resistance only — a
                                       landing car keeps its speed, it doesn't brake */
  const BODY_GRIP_MU = 1.1;         /* bodywork-on-asphalt Coulomb µ at impact — sheet
                                       metal DIGS; applied at an offset contact point it
                                       torques the car into a flip instead of gliding.
                                       (Replaces the exe loose-object bounce, which had
                                       restitution 0.3 and only token scrub → "glides") */
  const BODY_GATE_UPRIGHT = 0.7;    /* upB·surfUp above this (≲45° tilt) → body passive,
                                       wheels own the contact (no jump-graze tumble) */
  const BODY_GATE_DOWN = 0.2;        /* …below this (≳78° tilt, on side/roof) → full grip */
  const CONTACT_DEPEN = 0.6;        /* Baumgarte positional correction fraction / substep */
  const CONTACT_DEPEN_MAX = 0.06;   /* m — cap so a deep spike can't teleport the car */
  const LAND_GRACE_S = 0.12;        /* after a wheels-down landing, hold grounded this long */
  const LAND_GRACE_GAP_M = 0.15;    /* …unless the gap exceeds this (a real launch, not
                                       the suspension rebound) — kills tyre-touchdown strobe */
  const LAND_ALIGN_MIN = 0.80;      /* body-up·surface-up to hand back to the ground model */
  /* one-wheel landing: the 2-wheel handoff gate left an upright car HOVERING
     when contact ping-ponged wheel-to-wheel (grass micro-air at a slide
     angle) — it never landed, and the per-contact impulses pumped it into a
     nose-up launch. An essentially upright car that isn't tumbling hands off
     from a single wheel; genuine one-wheel GRAZES mid-flight stay airborne
     (they carry tumble rate / tilt). */
  const LAND_ONE_WHEEL_ALIGN = 0.95;   /* stricter uprightness for the 1-wheel path */
  const LAND_ONE_WHEEL_TUMBLE = 1.2;   /* rad/s pitch+roll rate — above this it's a tumble */
  const LAND_ONE_WHEEL_GAP_M = 0.10;   /* tyre-plane anchor must BE at the road — a
                                          banked-crest touchdown catches its first
                                          wheel with the plane still ~20 cm up and
                                          must keep flying to the 2-wheel handoff
                                          (early handoff popped the rendered height) */
  const LAND_EXT_MAX_M = 0.50;         /* cap on the handoff droop transfer (see the
                                          landing block) — keeps the travel-space
                                          spring solver in its sane range. Raised
                                          0.35→0.50 so a taller/tilted touchdown
                                          settles the last bit as natural gravity
                                          droop instead of SNAPPING the excess
                                          (the "tyres slam to the ground" pop). */
  const LAND_VN_MAX = 3.2;          /* m/s residual sink accepted at handoff (rest → bodyZv).
                                       Raised from 2.0: the lower gate made the car LINGER in
                                       the airborne penalty-spring state for extra frames on a
                                       firm landing, visibly hopping the tyres before it
                                       committed. Commit sooner; the sprung suspension (capped
                                       by MAX_RECAPTURE_VZ) swallows the residual sink.
                                       DO NOT raise this to escape the air solver on fast
                                       sideways touchdowns (tried 9.0): committing while the
                                       tyre plane is still decimetres up STEPS zPos at the
                                       handoff frame — snapshot().z is the render anchor, so
                                       the car visibly pops. */
  const REST_SPEED_MAX = 0.6;       /* below this + body-down + contact = restingOnBody */
  const REST_ANG_MAX = 0.9;         /* rad/s */
  const REST_ALIGN_MAX = 0.55;      /* body-up·surface-up below this = on side/roof */
  const CREST_PITCHV_MAX = 2.0;     /* rad/s surface-following rotation carried into flight */
  /* car-SHAPED body contact points (rel. tyre plane). The old single OBB
     gave the nose/tail the full roof height, so nose-down or inverted poses
     rested on a phantom corner ~0.5 m above the visible bodywork — the car
     floated over the track and "popped" when the rest pose engaged. Heights
     follow the Cup silhouette: low splitter/bumpers, hood, cowl, cabin-only
     roof, deck+spoiler. bodyGroundLift's symmetric OBB stays for the viewer
     wall/clearance path. */
  const BODY_CONTACT_PTS = [
    /* splitter / floor corners */
    [2.65, 0.92, 0.07], [2.65, -0.92, 0.07],
    [-2.60, 0.92, 0.07], [-2.60, -0.92, 0.07],
    /* nose top (hood leading edge) */
    [2.60, 0.85, 0.72], [2.60, -0.85, 0.72],
    /* cowl / windshield base */
    [0.70, 0.88, 1.04], [0.70, -0.88, 1.04],
    /* roof — cabin only */
    [0.30, 0.72, 1.32], [0.30, -0.72, 1.32],
    [-0.90, 0.72, 1.30], [-0.90, -0.72, 1.30],
    /* deck + spoiler top */
    [-2.55, 0.90, 1.00], [-2.55, -0.90, 1.00],
  ];
  /* ---- suspension digressive damping (segEval shock shape) ---- */
  const SHOCK_SHAPE={o:0,k:100,n:23,y:[0,600,970,1260,1470,1610,1730,1820,1900,1970,2030,2080,2130,2180,2230,2280,2330,2390,2445,2500,2560,2620,2690,2760,2840]};
  const DAMPER_CORNER_RATE=[0.71,0.71,1.05,1.05];
  const REBOUND_GLOBAL=0.6; const DAMPER_BASE=4200;
  function shockDamper(compClicks,rebClicks){const n=clamp(compClicks||5,1,9),r=clamp(rebClicks!=null?rebClicks:n,1,9);return{comp:DAMPER_BASE*(0.55+0.125*(n-1)),reb:DAMPER_BASE*(0.55+0.125*(r-1))*REBOUND_GLOBAL};}
  function damperShapeGain(vTravel,corner){const rate=DAMPER_CORNER_RATE[corner]||1;const xRef=0.1*rate;const refSlope=segEval(SHOCK_SHAPE,xRef)/xRef;const x=Math.abs(vTravel)*rate;if(x<1e-6)return(SHOCK_SHAPE.y[1]*SHOCK_SHAPE.k)/refSlope;return(segEval(SHOCK_SHAPE,x)/x)/refSlope;}
  /* FUN_0055e490 spring + cubic bump-stop: linear until the bump-rubber gap
     closes, then t³ stiffening. The knee sits GAP beyond the corner's STATIC
     (preloaded) compression — the garage bump-gap slots (28-31) are rubber
     clearance measured at static ride height, so no setup can sit ON the
     stop standing still. The old (ride − gap) knee measured from free length
     did exactly that with real .sim short-track springs (25-44 kN/m → 8-13 cm
     static travel): _initSuspension's linear equilibrium seed landed past the
     knee, the cubic fired ~4e7 N at spawn, launched the body to the droop
     clamp and pegged roll/pitch clamp-to-clamp — the on-load float. */
  function springBump(comp, k, knee, gap, bumpRate) {
    let f = k * comp;
    if (comp > knee && gap > 0) {
      const t = (comp - knee) / gap;
      f += bumpRate * t * t * t;
    }
    return f;
  }
  /* integrator guards for the sprung-body step: one force ceiling for
     everything a corner can push with (tire load already capped here), and
     the at-rest pose relaxation time constant */
  const F_SUSP_MAX_N = 60000;
  const AT_REST_POSE_TAU_S = 0.4;


  /* FUN_0054cab0 Step 3 load saturation — _DAT_006e97d8 / _DAT_006f58e0 */
  function loadSaturation(fz, par) {
    const s = fz * par.loadSensPerN;
    const s0 = par.loadSensNominalN * par.loadSensPerN;
    return (1 / (s * s + 1) + 1) / (1 / (s0 * s0 + 1) + 1);
  }
  /* FUN_0054cab0 — TIRE-SPEC Steps 2–8 with dumped LUTs.
     curveA samples not recoverable: sin(atan(B*s)) brush as longitudinal/lateral
     stiffness envelope (same role as curveA LUT input). No invented yaw-damp,
     front washout, or slip-angle polynomial — slipScale from PTR_DAT_0074e080. */
  const CURVE_A_B_LONG = 11;    /* curveA stand-in stiffness until live dump */
  const CURVE_A_B_LAT = 20;     /* was 12.5 — the car needed ~10° of body slip
                                   to hold 1 g at 150 mph and kept rotating
                                   ~2.2° after the wheel was released while
                                   that sideslip washed out ("keeps turning
                                   when I let off / slides but grippy").
                                   20 → ~3° steady slip, release drift ~1°,
                                   full-steer grip unchanged (2.34 g), better
                                   straight-line stability. */

  /* static-regime (stiction) solver — Car._stepGround wheel loop. Slip-curve tires
     need slide velocity to make force, so alone they can never hold a car
     still on a slope (it always finds a creep speed where weak low-speed
     force balances gravity). Below STICK_SPEED_MPS of tread slide the patch
     is treated as static: gravity feedforward + velocity damping, capped by
     the friction circle. */
  const STICK_SPEED_MPS = 0.4;  /* tread-slide speed below which the patch sticks */
  const STICK_DAMP = 45;        /* 1/s — velocity kill rate, sub-deadbeat at 480 Hz */

  function brush(slip, B) {
    const bs = B * slip;
    return Math.sin(Math.atan(bs));
  }

  function patchForce(slipRatio, slipAngle, fz, muScale, front, cornerIdx, steer,
    wLong, wLat, p, surfClass, surfSpeed) {
    p = p || PARAMS;
    if (fz <= 1) return { fx: 0, fy: 0 };
    const tc = TIRE_CAL;
    const cls = Number.isInteger(surfClass) ? surfClass : ASPHALT_CLASS;
    const latMag = Math.abs(slipAngle);
    const patchSpd = Math.hypot(wLong, wLat);
    const inLoad = Math.max(Math.abs(wLong), 0);

    /* FUN_0054cab0 locked branch — surface linear grip when contact speed ~0 */
    if (inLoad < 0.02 && patchSpd < 0.18) {
      const A = LIN_GRIP_A[cls], B = LIN_GRIP_B[cls];
      const gripLin = (A * fz + B * LIN_GRIP_K * Math.abs(slipRatio)) * LIN_GRIP_K * LIN_BRANCH_SCALE * muScale;
      const fx = -gripLin * sign(slipRatio || wLong || 1);
      const fy = -gripLin * clamp(slipAngle, -0.45, 0.45) * 0.35;
      return { fx, fy, muFz: fz };
    }

    /* NR2003: F0 = k²·load·inLoad — grip rises with contact speed; no penalty off the line */
    const inLoadFactor = inLoad < 8 ? 1.0 : clamp(1.0 + (inLoad - 8) / 32, 1.0, 1.22);
    const muFz = p.muBase * muScale * loadSaturation(fz, p) * fz * inLoadFactor;

    /* Step 2 — curveB (+0x7ec) × long falloff (_DAT_006ee390) */
    const curveB = segEval(PATCH_LAT_CURVE, latMag);
    const bScale = Math.max(0.02, curveB / PATCH_LAT_CURVE.ref);
    const falloff = Math.max(0, tc.patchGainK - Math.abs(slipRatio) * tc.longFalloff);
    const F2 = falloff * bScale;

    /* Step 4 — slip-angle LUT: (19135/(26789−F0))·|α| per TIRE-SPEC */
    const F0load = Math.max(200, fz);
    const lutArg = (tc.slipAngNum / (tc.slipAngDen - Math.min(F0load * 0.85, 25000))) * latMag;
    const slipScale = segEval(SLIP_ANGLE_LUT[front ? 0 : 1], lutArg);

    /* curveA stand-in × F2 scale → raw forces before combined slip */
    let fxRaw = muFz * brush(slipRatio, BRUSH_B_LONG) * F2;
    let fyRaw = -muFz * brush(slipAngle, BRUSH_B_LAT) * F2 * slipScale;
    if (front) fyRaw *= p.frontLatGain;

    /* Step 5 — hub steer couple (parent+0x20) */
    const hubSteer = front ? steer : 0;
    const couple = -hubSteer * F2 * slipAngle * 0.14;

    /* Step 6 — combined-slip magnitude (normalised) */
    const slipComb = Math.hypot(fxRaw / (muFz + 1e-9), fyRaw / (muFz + 1e-9));

    /* Step 7 — combinedSlip LUT (+0x2f4) */
    const combLut = SLIP_COMB[cornerIdx] || SLIP_COMB[0];
    const combIn = combLut.o + slipComb * slipComb * 0.11;
    const coupleIn = combLut.o + Math.abs(couple) * 0.42;
    const forceMagVal = segEval(PATCH_FM, slipComb * slipComb * 0.25 - 0.19);
    const longMix = segEval(combLut, combIn);
    const latMix = segEval(combLut, coupleIn);
    const longFrac = latMix * latMix * couple + tc.patchGainK - latMix - latMix;
    const fm = Math.max(0.1, 1 + forceMagVal * clamp(slipComb, 0, 1.4) * 2.8);
    const bleed = longMix / (1 + Math.abs(longMix));

    let fx = fxRaw * fm * (1 - bleed * 0.52 * clamp(Math.abs(longFrac), 0, 1));
    let fy = fyRaw * fm * (1 - bleed * 0.46);

    /* rolling branch low-speed grip supplement (param_11 path, attenuated) */
    if (inLoad < 2.8) {
      const A = LIN_GRIP_A[cls], B = LIN_GRIP_B[cls];
      const add = (A * fz + B * LIN_GRIP_K * Math.abs(slipRatio)) * LIN_GRIP_K * LIN_LOW_K * muScale * tc.linLowAtten;
      fx += -add * sign(slipRatio || 1);
    }

    /* Step 8 — contact-patch stationary (_DAT_006f58bc/8c0/8c4) */
    if (patchSpd < 0.12 && Math.abs(slipRatio) < 0.08) {
      const k = patchSpd / 0.12;
      fx *= 0.12 + 0.88 * k;
      fy *= 0.12 + 0.88 * k;
    }

    /* direction LUT role (+0x96c, samples pending live dump): a patch
       sliding LONGITUDINALLY loses its lateral capacity — a spinning rear
       keeps thrust but sheds lateral hold (burnouts/donuts rotate), a
       locked wheel loses steering authority. Deep-sideways wash is curveB's
       job, so only the longitudinal-slide fraction collapses fy here.
       Without this, spinning rears retained ~half their lateral grip and
       the axle "held" the car straight mid-burnout. */
    const slipVLong = (typeof surfSpeed === 'number' ? surfSpeed - wLong
      : slipRatio * Math.max(Math.abs(wLong), 0.25));
    const slipSpd = Math.hypot(slipVLong, wLat);
    /* onset on the slip RATIO, past the elastic regime — limit-cornering
       power slip (~0.3) keeps its angled force; a truly spinning/locked
       wheel (|ratio| → 1+) collapses. slipSpd floor keeps crawl-speed
       integration noise out (slipComb is unreliable below ~3 m/s). */
    const sat = clamp((Math.abs(slipRatio) - 0.5) / 0.5, 0, 1);
    if (sat > 0 && slipSpd > 1.5) {
      const longFrac = Math.abs(slipVLong) / slipSpd;
      fy *= 1 - sat * longFrac * 0.9;
    }

    const g = Math.hypot(fx / muFz, fy / muFz);
    if (g > 1) { fx /= g; fy /= g; }
    return { fx, fy, muFz };
  }
  function tireForce(slipRatio,slipAngle,fz,muScale,front,cornerIdx,steer,wLong,wLat,p,surfClass,surfSpeed){return patchForce(slipRatio,slipAngle,fz,muScale,front,cornerIdx,steer,wLong,wLat,p,surfClass,surfSpeed);}

  /* ---- the player car ------------------------------------------------- */
  /* Corner order: 0 FL, 1 FR, 2 RL, 3 RR (matches wheel.axle id in TIRE-SPEC
     +0x6c: 0=LF,1=RF,2=LR,3=RR). Body frame: +x forward, +y left, +z up. */
  const CORNERS = [
    { fwd: +1, left: +1, front: true },   /* FL */
    { fwd: +1, left: -1, front: true },   /* FR */
    { fwd: -1, left: +1, front: false },  /* RL */
    { fwd: -1, left: -1, front: false },  /* RR */
  ];

  class Car {
    constructor(params) {
      this.p = Object.assign({}, PARAMS, params || {});
      applyMassScaleTo(this.p, _massScale);   /* born at the current "Car mass" setting */
      this.bodyPts = BODY_CONTACT_PTS;   /* body contact silhouette (per-car) */
      this.aeroPanels = null;            /* per-car scaled panel geometry */
      this.reset({ x: 0, y: 0, heading: 0 });
    }

    /* per-car aero: scale the calibrated panel model to the loaded model's
       measured dimensions (viewer passes length/width/height ratios vs the
       canonical Cup body). Null/identity clears back to the stock panels. */
    setAeroShape(scales) {
      this.aeroPanels = scales
        ? scaleAeroPanels(scales.sx, scales.sy, scales.sz)
        : null;
    }

    /* per-car body contact silhouette, derived from the loaded model by the
       viewer — flight contacts, rest poses and the hitbox overlay then match
       the VISIBLE bodywork of any mod instead of the idealised Cup shape.
       Invalid/missing input falls back to the canonical shape. */
    setBodyShape(pts) {
      /* upper bound guards the 480 Hz contact loops — a mesh support cloud
         is ~60-120 points; anything bigger is a caller bug */
      const ok = Array.isArray(pts) && pts.length >= 6 && pts.length <= 400
        && pts.every(
          (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite));
      this.bodyPts = ok ? pts.map((p) => p.slice()) : BODY_CONTACT_PTS;
    }

    /* apply a garage setup (SimSetup.parse result) — the full per-track
       garage model from the decomp slot map:
       - slot 48 final drive: acceleration, top speed AND lift-off engine
         braking (Bristol 6.24, Daytona 3.41)
       - slot 47 steering ratio → road-wheel lock (the "can it turn" number)
       - slot 39 brake bias
       - slots 20-23 springs → front share of the roll couple (balance)
       - slot 60 spoiler angle → rear downforce + drag
       - slots 32-35 cambers → front lateral grip trim
       - slots 61/62 left ballast + wedge → static corner-load offsets */
    applySetup(setup) {
      if (!setup) return;
      const p = { ...this.p };
      const num = (v) => typeof v === 'number' && Number.isFinite(v);

      if (num(setup.finalDrive)) p.finalDrive = setup.finalDrive;
      if (num(setup.brakeBiasFront)) p.brakeBiasFront = setup.brakeBiasFront;

      /* transmission from the setup's gear-chart indices (slots 51-55):
         per-track boxes are real — Martinsville short-stacks 1.72/1.30/1.09,
         Daytona pulls 2.56/2.04/1.43 */
      if (setup.transRatios && setup.transRatios.length === 4 && setup.transRatios.every(num)) {
        p.gearRatios = [PARAMS.gearRatios[0], ...setup.transRatios];
      }

      /* steering ratio → road-wheel lock */
      if (num(setup.steeringRatio) && setup.steeringRatio >= 6 && setup.steeringRatio <= 40) {
        p.steeringRatio = setup.steeringRatio;
        p.maxSteer = (p.steerWheelLockDeg * Math.PI / 180) / setup.steeringRatio;
      }

      /* springs → per-corner rates + front roll-couple share (front bar) */
      const spr = setup.springRatesNpm;
      if (spr && spr.length === 4 && spr.every(num)) {
        p.cornerSpring = spr.slice();
        /* ζ≈0.78 critical damping from spring rate + quarter-car mass */
        const mC = p.mass / 4;
        for (let i = 0; i < 4; i++) {
          const cCrit = 2 * Math.sqrt(spr[i] * mC);
          const clicks = setup.shockCompClicks ? setup.shockCompClicks[i] : 5;
          const rebClicks = setup.shockRebClicks ? setup.shockRebClicks[i] : clicks;
          const d = shockDamper(clicks, rebClicks);
          p.cornerDamperComp[i] = 0.92 * cCrit * (d.comp / DAMPER_BASE);
          p.cornerDamperReb[i] = 0.92 * cCrit * (d.reb / DAMPER_BASE);
        }
      }

      const bg = setup.bumpGapM;
      if (bg && bg.length === 4 && bg.every(num)) p.bumpGapM = bg.slice();

      const rh = setup.rideHeightM;
      if (rh) {
        if (num(rh.lf)) p.rideHeightM[0] = rh.lf;
        if (num(rh.rf)) p.rideHeightM[1] = rh.rf;
        if (num(rh.rear)) { p.rideHeightM[2] = rh.rear; p.rideHeightM[3] = rh.rear; }
      }

      /* rear roll center follows the setup's track-bar height (slots 44/45)
         — the truck-arm rear takes its lateral transfer through the bar, so
         a higher bar means more instant link share and less spring roll */
      const tb = setup.trackBarM;
      if (tb && num(tb[0]) && num(tb[1])) {
        p.rollCenterRM = clamp((tb[0] + tb[1]) / 2, 0.10, 0.35);
      }

      /* rear spoiler (45-70°; 70 = full downforce baseline, plate tracks
         run 55): the panel model takes the ANGLE — rear downforce and drag
         emerge from the blade + deck-field geometry at that angle */
      if (num(setup.spoilerDeg)) {
        p.spoilerDeg = clamp(setup.spoilerDeg, 45, 70);
      }

      /* front cambers → small lateral-grip gain (leaned-in contact patch) */
      const cam = setup.camberRad;
      if (cam && num(cam[0]) && num(cam[1])) {
        const lean = Math.min(Math.abs(cam[0]) + Math.abs(cam[1]), 0.14);
        p.frontLatGain = 1 + lean * 0.5;
      }

      /* rear stagger (slot 65) → locked-axle left-turn couple */
      if (num(setup.staggerRearM)) p.rearStaggerM = setup.staggerRearM;

      /* left ballast + wedge → static per-corner load offsets (N).
         Ballast levers ~0.6 m off centerline across the track width; wedge
         shifts the RF+LR diagonal (corner order FL FR RL RR). */
      if (num(setup.leftBallastKg) || num(setup.wedgeKg)) {
        const dLeft = ((setup.leftBallastKg || 0) * G * 0.6) / p.trackWidth / 2;
        const wedgeN = (setup.wedgeKg || 0) * G * 0.25;
        p.cornerFzOffset = [dLeft - wedgeN, -dLeft + wedgeN, dLeft + wedgeN, -dLeft - wedgeN];
      }

      this.p = p;
      this.setup = setup;
      this._initSuspension();
    }

    /* track environment (from track.ini via Track.parseEnv): air density from
       altitude + weather temp scales aero (panelAero rho) AND engine power
       (naturally-aspirated ∝ ρ); a length-derived default final drive applies
       ONLY when the loaded setup carried none, so a setup-less track still
       gears to its size. MUST be called AFTER applySetup (reads this.setup). */
    applyTrackEnv(env) {
      const p = { ...this.p };
      const dens = env && Number.isFinite(env.airDensity) ? env.airDensity : PARAMS.airDensity;
      p.airDensity = dens;
      p.powerScale = clamp(dens / PARAMS.airDensity, 0.7, 1.15);
      /* ambient wind (track.ini [weather]) — the aero runs on AIR-relative
         velocity, so a head/tail/crosswind is felt at speed */
      p.windX = env && Number.isFinite(env.windX) ? env.windX : 0;
      p.windY = env && Number.isFinite(env.windY) ? env.windY : 0;
      const setupFD = this.setup && Number.isFinite(this.setup.finalDrive);
      if (!setupFD && env && Number.isFinite(env.defaultFinalDrive)) {
        p.finalDrive = env.defaultFinalDrive;
      }
      this.p = p;
      this.trackEnv = env || null;
    }

    /* user aero tune — the "drag" slider from the Controls panel (all cars).
       dragScale 1 = stock; <1 slipperier+faster+calmer in the air, >1 draggier+
       slower+blows over easier. Two INDEPENDENT flap flags:
         roofFlaps      -> flapsPresent: the flaps are fitted and deploy on the
                           mesh when the flow reverses (visual only).
         flapsEffective -> employRoofFlaps: deployed flaps actually kill the
                           reversed-flow lift (real safety behaviour).
       Present + ineffective = flaps visibly pop open but the car still blows
       over (the "watch the flaps flutter as it flips" test mode). When
       flapsEffective is omitted it defaults to roofFlaps, preserving old
       single-toggle configs. Params swap immutably, driving state untouched. */
    setAeroTune(aero) {
      if (!aero) return;
      const p = { ...this.p };
      if (Number.isFinite(aero.dragScale)) p.dragScale = clamp(aero.dragScale, 0.3, 2.5);
      if (Number.isFinite(aero.blowoverScale)) p.blowoverScale = clamp(aero.blowoverScale, 0.5, 3.0);
      if (typeof aero.roofFlaps === 'boolean') p.flapsPresent = aero.roofFlaps;
      if (typeof aero.flapsEffective === 'boolean') p.employRoofFlaps = aero.flapsEffective;
      else if (typeof aero.roofFlaps === 'boolean') p.employRoofFlaps = aero.roofFlaps;
      this.p = p;
    }

    /* slam the car into a backwards, spun state at speed so its reversed-flow
       aero lifts and blows it over — the "test blowover" button. Emergent: it
       only injects the velocity + a yaw, the flip falls out of the aero. */
    triggerBlowover(mps) {
      const v = Math.abs(Number.isFinite(mps) ? mps : 85);   /* ~190 mph backwards */
      if (this.airborne) return;
      this.u = -v;              /* travelling backwards (tail-first into the wind) */
      this.v = 0;
      this.r = 1.2;             /* a yaw kick so it isn't a knife-edge — flips to a side */
      this._liftTimer = 0;
      /* the button exists to SHOW a blowover, so it runs the documented "flaps
         flutter as it flips" test mode: the flaps still deploy visually, but for
         this triggered flip they don't spoil the reversed-flow lift (otherwise
         the default effective-flaps setting would keep the car planted and the
         button would look broken). Cleared once it lands or is reset. */
      this._blowoverTest = true;
    }

    /* test aid: place the car upside-down on its roof at the current spot */
    putOnRoof(surf) {
      if (!surf) return false;
      const up = (surf.up) || [0, 0, 1];
      const zSurf = Number.isFinite(surf.height) ? surf.height : (this.zPos || 0);
      const q = composeRenderQuat(up, this.yaw, 0, Math.PI);
      const e = qToYPR(q);
      this.qw = q[0]; this.qx = q[1]; this.qy = q[2]; this.qz = q[3];
      this._airActive = true;
      this.airborne = true;
      this.restingOnBody = true;
      this.onSurface = false;
      this.attPitch = e.pitch;
      this.attRoll = e.roll;
      this._attPitchEcho = e.pitch;
      this._attRollEcho = e.roll;
      this.attPitchV = 0;
      this.attRollV = 0;
      this.wbx = 0; this.wby = 0; this.wbz = 0;
      this.yaw = e.yaw;
      this._yawEcho = e.yaw;
      this.up = up.slice();
      this.zPos = zSurf + this._restLift(q, up);
      this._zPosEcho = this.zPos;
      this._cgZ = null;
      this.u = 0; this.v = 0; this.r = 0; this.vz = 0;
      this.ax = 0; this.ay = 0;
      this.bodyPitch = 0;
      this.bodyRoll = 0;
      this.bodyZ = 0;
      this.bodyZv = 0;
      this._contactFade = 0;
      this._groundHold = 0;
      this._airContacts = { wheels: 0, body: 2, deepestBody: 0.04 };
      this._airT = 0;
      this._regripT = 0;
      const upB = qRot(q, [0, 0, 1]);
      this._flapSwing = 0.05; this._flapSwingV = 2.2; this._flapEqPrev = null;
      updateCarFlapSwing(this, 1 / 480, upB, 0, 0);
      return true;
    }

    /* NR2003 driving aids — toggled live from the Controls panel; params
       swap immutably, driving state untouched */
    setAids(aids) {
      if (!aids) return;
      const p = { ...this.p };
      if (typeof aids.tractionControl === 'boolean') p.tractionControl = aids.tractionControl;
      if (typeof aids.absBrakes === 'boolean') p.absBrakes = aids.absBrakes;
      if (typeof aids.stabilityControl === 'boolean') p.stabilityControl = aids.stabilityControl;
      if (typeof aids.lowSpeedSteerBoost === 'boolean') p.lowSpeedSteerBoost = aids.lowSpeedSteerBoost;
      this.p = p;
    }

    /* seed per-corner compression at static equilibrium (FUN_0055e490 table[0]) */
    _staticCornerLoads() {
      const p = this.p;
      const w = p.mass * G;
      const front = w * p.weightDistFront;
      const rear = w - front;
      const fz = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) {
        const c = CORNERS[i];
        fz[i] = (c.front ? front : rear) / 2 + p.cornerFzOffset[i];
      }
      return fz;
    }

    /* seed sprung-body pose at static equilibrium. Wedge/ballast offsets are
       spring PRELOAD (real wedge = turns of the jack bolt), so they live in
       the static compression, exactly like the game's setup path. */
    _initSuspension() {
      const p = this.p;
      const staticFz = this._staticCornerLoads();
      const mUn = p.unsprungMass || 42;
      this.bodyZ = 0;       /* heave (m, + = body pressed down / compressing) */
      this.bodyZv = 0;
      this.bodyRoll = 0;    /* rad, + = right side compresses */
      this.bodyRollV = 0;
      this.bodyPitch = 0;   /* rad, + = nose down */
      this.bodyPitchV = 0;
      this.suspComp0 = [0, 0, 0, 0];   /* static (preloaded) compression */
      this.suspComp = [0, 0, 0, 0];
      this.suspVel = [0, 0, 0, 0];
      this.suspFz = staticFz.slice();
      this.suspFzVel = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) {
        const sprung = Math.max(0, staticFz[i] - mUn * G);
        this.suspComp0[i] = sprung / p.cornerSpring[i];
        this.suspComp[i] = this.suspComp0[i];
      }
    }

    /* travel-space suspension + sprung-body dynamics — weight transfer is
       EMERGENT (DYNAMICS-SPEC): lateral/longitudinal acceleration torques
       the sprung mass about its roll/pitch axes; the body takes its set
       through the FUN_0055e490 springs (+cubic bump stops), the FUN_0055e510
       shape dampers (real 0.6 rebound ratio) and the sway bars; corner load
       is whatever the spring+damper+bar actually push. The only instant
       path is the geometric (roll-center) share each axle transmits through
       its links — small at the SLA front, large at the truck-arm rear. */
    _stepSuspension(h, gEff, dfFront, dfRear, axLoad, ayLoad, aeroRollTq, restBlend) {
      const p = this.p;
      const halfTW = p.trackWidth / 2, halfWB = p.wheelbase / 2;
      const mUn = p.unsprungMass || 42;
      const ms = p.mass - 4 * mUn;
      const downTotal = dfFront + dfRear;

      /* per-corner travel from the body pose */
      const fz = [0, 0, 0, 0];
      const fSusp = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) {
        const c = CORNERS[i];
        const comp = this.suspComp0[i] + this.bodyZ
          - c.left * this.bodyRoll * halfTW + c.fwd * this.bodyPitch * halfWB;
        const vel = this.bodyZv
          - c.left * this.bodyRollV * halfTW + c.fwd * this.bodyPitchV * halfWB;
        this.suspComp[i] = comp;
        this.suspVel[i] = vel;

        /* FUN_0055e490 spring + cubic bump stop; negative travel = unloaded;
           the stop engages bumpGap beyond this corner's static compression */
        const fSpring = comp > 0
          ? springBump(comp, p.cornerSpring[i],
            this.suspComp0[i] + p.bumpGapM[i], p.bumpGapM[i], p.bumpRateNpm3)
          : 0;
        /* FUN_0055e510 damper — dumped digressive shape, comp/reb asymmetry */
        let cDamp = vel > 0 ? p.cornerDamperComp[i] : p.cornerDamperReb[i];
        cDamp *= damperShapeGain(vel, i);
        cDamp *= 1 + 3 * restBlend;   /* fades in the at-rest damping boost */
        fSusp[i] = fSpring + cDamp * vel;
        this.suspFzVel[i] = p.cornerSpring[i] * vel;
      }

      /* sway bars — FUN_00560c30 (lfsusp/rfsusp) + FUN_005608d0 (raxle):
         spring on the left−right travel difference of each axle, measured
         off the STATIC set. The garage zeroes the bar links at static ride
         height (intended preload is wedge, already in cornerFzOffset) — on
         the absolute difference, asymmetric rates (Daytona LF 25 kN/m sits
         ~14 cm in, RF 137 kN/m ~2.5 cm) pre-wound the bar with a constant
         roll torque that leaned the car at speed and spun it off launches. */
      const barF = p.frontBarNpm * ((this.suspComp[0] - this.suspComp0[0])
        - (this.suspComp[1] - this.suspComp0[1]));
      const barR = (p.rearBarNpm || 0) * ((this.suspComp[2] - this.suspComp0[2])
        - (this.suspComp[3] - this.suspComp0[3]));
      fSusp[0] += barF; fSusp[1] -= barF;   /* bar loads the compressed side */
      fSusp[2] += barR; fSusp[3] -= barR;
      /* integrator guard: a corner slammed deep into the cubic stop makes
         MN-scale forces — bound what can torque the body (the tire-load path
         already caps at the same ceiling); a real rubber yields long before */
      for (let i = 0; i < 4; i++) {
        fSusp[i] = clamp(fSusp[i], -F_SUSP_MAX_N, F_SUSP_MAX_N);
      }

      /* geometric (roll-center) lateral transfer — instant, through links */
      const mF = p.mass * p.weightDistFront, mR = p.mass - mF;
      const geoF = mF * ayLoad * p.rollCenterFM / p.trackWidth;
      const geoR = mR * ayLoad * p.rollCenterRM / p.trackWidth;
      /* geometric anti-dive/anti-squat longitudinal share — the same instant
         link path: the arms react that fraction of the brake/drive moment
         straight into the tires, only the remainder works the springs */
      const antiFrac = axLoad < 0 ? p.antiDiveFrac : p.antiSquatFrac;
      const geoP = -ms * axLoad * p.cgHeight * antiFrac / p.wheelbase / 2;

      /* tire loads: suspension force + unsprung weight + geometric share */
      for (let i = 0; i < 4; i++) {
        const c = CORNERS[i];
        const geo = c.front ? geoF : geoR;
        fz[i] = Math.max(0, fSusp[i] + mUn * gEff - c.left * geo + c.fwd * geoP);
        this.suspFz[i] = fz[i];
      }

      /* sprung-body dynamics: gravity/banking + aero press the body onto the
         springs; lateral/longitudinal inertial force torques it about the
         roll/pitch arms (CG above the roll-center line) */
      const rcAvg = (p.rollCenterFM * mF + p.rollCenterRM * mR) / p.mass;
      const hRollArm = Math.max(0.05, p.cgHeight - rcAvg);
      const sumF = fSusp[0] + fSusp[1] + fSusp[2] + fSusp[3];
      const zAcc = (ms * gEff + downTotal - sumF) / ms;
      let rollTq = ms * ayLoad * hRollArm + (aeroRollTq || 0);
      let pitchTq = -ms * axLoad * p.cgHeight * (1 - antiFrac)
        + halfWB * (dfFront - dfRear);
      /* the ROLL spring torque comes from each corner's DEVIATION off its
         roll-free reference (static set + heave + pitch share), not its
         absolute force. Real oval setups run wildly ASYMMETRIC left/right
         rates (Daytona fast.cup: LF 24.7 kN/m vs RF 137.2 kN/m) — with
         absolute forces, any uniform compression (aero at speed, banking
         load) and any squat/dive pushed back harder on the stiff side and
         rolled the body into a CONSTANT ~2-3° lean that held until the
         at-rest relax leveled it at a stop ("tilts to one side and stays
         there until I stop"); the squat→roll cross-coupling even spun the
         car off the launch. The reference cancels exactly that coupling:
         roll DEVIATIONS still see the full per-corner springs, bump stops,
         dampers and sway bars, and for left/right-symmetric rates it is
         zero-sum in the roll projection (preload differences cancel against
         the static force), so the no-setup car is untouched. PITCH keeps
         absolute forces — the front/rear rate split pitching the body under
         aero heave is the real rake behavior the contracts pin. */
      for (let i = 0; i < 4; i++) {
        const c = CORNERS[i];
        const compRef = this.suspComp0[i] + this.bodyZ
          + c.fwd * this.bodyPitch * halfWB;
        const fRef = compRef > 0
          ? springBump(compRef, p.cornerSpring[i],
            this.suspComp0[i] + p.bumpGapM[i], p.bumpGapM[i], p.bumpRateNpm3)
          : 0;
        rollTq += c.left * halfTW
          * (fSusp[i] - clamp(fRef, -F_SUSP_MAX_N, F_SUSP_MAX_N));
        pitchTq -= c.fwd * halfWB * fSusp[i];
      }
      this.bodyZv += zAcc * h;
      this.bodyZ += this.bodyZv * h;
      this.bodyRollV += (rollTq / p.rollInertia) * h;
      this.bodyRoll += this.bodyRollV * h;
      this.bodyPitchV += (pitchTq / p.pitchInertia) * h;
      this.bodyPitch += this.bodyPitchV * h;

      if (restBlend > 1e-3) {
        const settle = Math.pow(0.01, h * 60 * restBlend);
        this.bodyZv *= settle; this.bodyRollV *= settle; this.bodyPitchV *= settle;
        /* the velocity settle alone FREEZES a displaced pose (it eats the
           restoring motion every substep — a knocked body held a 0.2 m droop
           for ~7 s of visible sag); relax the pose to the static set instead,
           like a real car coming to rest on its springs */
        const relax = Math.min(1, h / AT_REST_POSE_TAU_S) * restBlend;
        this.bodyZ -= this.bodyZ * relax;
        this.bodyRoll -= this.bodyRoll * relax;
        this.bodyPitch -= this.bodyPitch * relax;
      }
      /* travel sanity clamps (integrator guard, ~full bump to full droop);
         rate clamps guard the same integrator against crash-landing seeds */
      this.bodyZ = clamp(this.bodyZ, -0.2, 0.2);
      this.bodyRoll = clamp(this.bodyRoll, -0.25, 0.25);
      this.bodyPitch = clamp(this.bodyPitch, -0.2, 0.2);
      this.bodyZv = clamp(this.bodyZv, -6, 6);
      this.bodyRollV = clamp(this.bodyRollV, -6, 6);
      this.bodyPitchV = clamp(this.bodyPitchV, -6, 6);
      for (let i = 0; i < 4; i++) {
        fz[i] = Math.min(fz[i], F_SUSP_MAX_N);
        this.suspFz[i] = fz[i];
      }
      return fz;
    }

    /* world-frame planar impulse J (N·s) at offset (rx,ry) from the CG —
       matches the exe's collision constraint impulses, which act strictly in
       the ground plane (SURFACE-SPEC §Car↔wall: chassis force path, no
       vertical component). Offset hits torque the body through Iz. */
    applyImpulseAt(rx, ry, jx, jy) {
      const p = this.p;
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      this.u += (jx * cy + jy * sy) / p.mass;
      this.v += (-jx * sy + jy * cy) / p.mass;
      this.r += (rx * jy - ry * jx) / p.yawInertia;
      this.r = clamp(this.r, -6, 6);
    }

    addDamage(sev) {
      if (_noDamage) return;   /* "disable damage" toggle: stay pristine */
      this.damage = clamp((this.damage || 0) + sev, 0, 1);
    }

    _bodyAttitude() {
      /* same sign convention the viewer always got: left-compression-minus-
         right over track width; nose-compression-minus-rear over wheelbase */
      const p = this.p;
      const roll = Math.atan2(-this.bodyRoll * p.trackWidth, p.trackWidth);
      const pitch = Math.atan2(this.bodyPitch * p.wheelbase, p.wheelbase);
      return { roll, pitch };
    }

    /* place at a start pose (Papyrus-local x,y + heading), at rest */
    reset(pose) {
      this.x = pose.x || 0;
      this.y = pose.y || 0;
      this.yaw = pose.heading || 0;
      this.u = 0;          /* body longitudinal velocity (m/s) */
      this.v = 0;          /* body lateral velocity (+left) */
      this.r = 0;          /* yaw rate (rad/s) */
      this.ax = 0;         /* last body long accel (for load transfer) */
      this.ay = 0;         /* last body lat accel */
      this._tireFxN = 0;   /* last tire-path long force (pitch/anti-dive) */
      this.steer = 0;      /* current front steer angle (rad) */
      this.throttle = 0;
      this.brake = 0;
      this.gear = 1;       /* 0=R, 1..4 forward */
      this.rpm = this.p.idleRpm;
      this.shiftTimer = 0;
      this.reverseReq = false;
      this.wheelOmega = [0, 0, 0, 0];
      this.up = [0, 0, 1];         /* surface normal (Papyrus-local) */
      this.lastFz = [0, 0, 0, 0];
      this.lastSlip = [0, 0, 0, 0];
      this.lastSlideSpd = [0, 0, 0, 0];  /* m/s tread-vs-road slide (tire FX) */
      this.slipIntegrator = [0, 0, 0, 0];
      this.suspComp = [0, 0, 0, 0];
      this.suspVel = [0, 0, 0, 0];
      this.suspFz = [0, 0, 0, 0];
      this.suspFzVel = [0, 0, 0, 0];
      this.flapDeploy = 0;
      this._flapSwing = 0; this._flapSwingV = 0; this._flapEqPrev = null;
      this.flapsDeployed = false;
      this.damage = 0;      /* 0..1 — exe keeps a pit-repairable damage scalar
                               (car+0x197e, AI "Halting damage repair");
                               respawn = repaired */
      /* vertical DOF + free attitude — airborne is emergent (see AIR_ consts):
         zPos = world z of the tyre-contact plane (null → sync to the surface
         on the first step); attPitch/attRoll = world-frame attitude while
         flying (viewer convention: pitch + = nose DOWN, roll + = left up) */
      this.zPos = null;
      this.vz = 0;
      this.airborne = false;
      this.onSurface = true;     /* grounded contact (vs the ballistic band) */
      this._contactFade = 1;     /* tire-load share in the ballistic band */
      this._airT = 0;            /* accumulated flight time (regrip scaling) */
      this._dfAccelZ = 0;        /* aero downforce accel for the band chase */
      this.restingOnBody = false;
      this.attPitch = 0;
      this.attRoll = 0;
      this.attPitchV = 0;
      this.attRollV = 0;
      /* flight rigid body: world←body quaternion + body-frame angular rate.
         attPitch/attRoll stay as the extracted Euler view (HUD/save/viewer). */
      const q0 = qFromYPR(this.yaw, 0, 0);
      this.qw = q0[0]; this.qx = q0[1]; this.qy = q0[2]; this.qz = q0[3];
      this.wbx = 0; this.wby = 0; this.wbz = 0;
      this._airActive = false;     /* quat state is live (vs external airborne=true) */
      /* unified-solver canonical anchors (echoes detect external writes) */
      this._cgZ = null;
      this._zPosEcho = null;
      this._yawEcho = null;
      this._rEcho = null;
      this._attPitchEcho = this.attPitch;
      this._attRollEcho = this.attRoll;
      this._planeZ = null;
      this._planeVz = 0;
      this._planeRejN = 0;
      this._surfN = null;
      this._loadFrac = 1;
      this._unloadT = 0;
      this._airContacts = null;    /* last-substep contact summary for the handoff */
      this._surfPitch = null;      /* surface pitch tracker → crest rotation seed */
      this._crestPitchV = 0;
      this._zSurfPrev = null;
      this._vzSurfSm = null;
      this._zSurfOutlier = false;
      this._zSurfExternalShift = false;
      this._liftMag = 0;
      this._liftTimer = 0;
      this._blowoverTest = false;   /* "Test blowover" flap-override, transient */
      this._airborneHold = 0;
      this._wheelImpact = 0;   /* touchdown closing speed captured for the squat */
      this._groundHold = 0;    /* post-landing grace: no re-takeoff on rebound */
      this._burnoutHold = 0;
      this._initSuspension();
    }

    get speed() { return Math.hypot(this.u, this.v); }

    /* advance the sim by dt seconds. input = { throttle, brake, steer } targets
       in [0,1]/[0,1]/[-1,1]; surf = { up:[x,y,z] unit surface normal, grip }.
       Uses fixed substeps for a stable integrator (the game runs a fixed-rate
       tick, FUN_00545e80). */
    step(dt, input, surf) {
      dt = clamp(dt, 0, 0.05);
      if (dt <= 0) return;
      /* the vertical channel is a persistent integrator now — one NaN surface
         sample (off the lofted surface / seam glitch) would poison zPos/vz and
         the follow filter FOREVER, so sanitize the input and self-heal state */
      const zRaw = surf ? surf.height : 0;
      let zSurf = Number.isFinite(zRaw) ? zRaw
        : (Number.isFinite(this._zSurfPrev) ? this._zSurfPrev : 0);
      /* the airborne contact solver needs the TRUE ground, not the follow-
         filtered one: the predictive seam clamp below can only move the
         grounded surface 0.12 m/frame, so over terrain that drops metres per
         frame (a fast crest) the clamped plane stays stale-HIGH near the car
         while the road falls away — the body then slams into phantom ground at
         altitude. The flight solver samples the real height instead. */
      const zSurfTrue = zSurf;
      if (this._zSurfPrev !== null && Number.isFinite(this._zSurfPrev)) {
        /* PREDICTIVE seam clamp: extrapolate the surface along its own
           followed rate and allow only a small deviation from that line.
           The plain rate clamp (30 m/s) admitted seam SPIKES up to 0.5 m
           per frame — at speed the ground teleported under the car, the
           contact springs slammed ("acts like I hit something") or the
           car embedded in the road. A smooth grade tracks exactly (the
           prediction follows it); a step-glitch deviates and is capped
           at SURF_Z_STEP_MAX until it persists long enough to be real. */
        const vzPred = (!this.airborne && this._vzSurfSm !== null
          && Number.isFinite(this._vzSurfSm))
          ? this._vzSurfSm : 0;   /* stale rate mustn't steer the ground while flying */
        const pred = this._zSurfPrev + clamp(vzPred, -2 * SURF_VZ_MAX, 2 * SURF_VZ_MAX) * dt;
        /* an outlier must not TEACH the follow-rate filter — a one-frame
           spike otherwise poisoned vzSurfSm and the prediction chased a
           phantom hill for the next dozen frames. */
        const externalShift = !!this._zSurfExternalShift;
        this._zSurfExternalShift = false;
        this._extShiftFrame = externalShift;   /* unified height feed reads this */
        this._zSurfOutlier = Math.abs(zSurf - pred) > SURF_Z_STEP_MAX * 1.5 || externalShift;
        if (externalShift) {
          /* the car's x/y was moved EXTERNALLY (wall push-out). The surface at
             the NEW position is the TRUTH, not a seam glitch — and on banking a
             lateral push legitimately changes the height by far more than
             SURF_Z_STEP_MAX. Clamping it (the seam-spike path) held zSurf ABOVE
             the real surface, opening a phantom gap that launched the car
             straight up off a wall ride and floated it back down "like it's
             bugged". Accept the true height and RE-ANCHOR the grounded channel
             to it so no false gap forms; the move is a teleport, not a climb, so
             the surface-follow rate is 0 this frame (_zSurfPrev := zSurf) and any
             stale in-plane climb velocity is re-derived from the new normal. */
          const dzShift = zSurf - this._zSurfPrev;
          this._zSurfPrev = zSurf;
          if (_unified3d) {
            /* unified body: a teleport carries the car WITH the new surface
               (ride height preserved — no phantom gap above, no violent
               depenetration below) and the follow rate re-derives along the
               new plane. Flying cars are left alone: ground moving under a
               ballistic body doesn't move the body. */
            if (!this.airborne && this.zPos !== null && Number.isFinite(dzShift)) {
              this.zPos += dzShift;
              this._zPosEcho = this.zPos;
              if (this._cgZ != null) this._cgZ += dzShift;
              resyncGroundVz(this, surf && surf.up);
            }
          } else if (!this.airborne && this.zPos !== null) {
            this.zPos = zSurf;
            resyncGroundVz(this, surf && surf.up);
          }
        } else {
          zSurf = clamp(zSurf, pred - SURF_Z_STEP_MAX, pred + SURF_Z_STEP_MAX);
        }
      }
      if (!Number.isFinite(this.vz)) this.vz = 0;
      if (this._vzSurfSm !== null && !Number.isFinite(this._vzSurfSm)) this._vzSurfSm = null;
      if (this.zPos !== null && !Number.isFinite(this.zPos)) this.zPos = null;
      if (this._zSurfPrev !== null && !Number.isFinite(this._zSurfPrev)) this._zSurfPrev = null;
      const upS = (surf && surf.up) || [0, 0, 1];
      if (this.zPos === null || this._zSurfPrev === null) {
        this.zPos = zSurf;
        this._zSurfPrev = zSurf;
        if (_unified3d) {
          /* fresh car: spawn ON the surface at static equilibrium — quat
             aligned to the surface basis so there is no settle wobble on
             banked pit stalls */
          const q0 = composeRenderQuat(upS, this.yaw, 0, 0);
          this.qw = q0[0]; this.qx = q0[1]; this.qy = q0[2]; this.qz = q0[3];
          this.wbx = 0; this.wby = 0; this.wbz = 0;
          this._cgZ = null;
          this._zPosEcho = null;
          this._yawEcho = this.yaw;
          this._loadFrac = 1;
        }
      }
      const vzSurf = (zSurf - this._zSurfPrev) / dt;   /* surface-following vz */
      this._zSurfPrev = zSurf;
      /* external writes (tests/state-load) can set airborne without going
         through _takeOff — build the quat state from the Euler view so the
         rigid body starts where the caller put it */
      if (this.airborne && !this._airActive) {
        const norm = Math.hypot(this.qw, this.qx, this.qy, this.qz);
        const qOk = Number.isFinite(norm) && Math.abs(norm - 1) < 0.1;
        const eulerBig = Math.abs(this.attPitch || 0) > 0.02 || Math.abs(this.attRoll || 0) > 0.02;
        if (!qOk || (Math.abs(this.qw) > 0.9999 && eulerBig)) {
          const q = qFromYPR(this.yaw, this.attPitch || 0, this.attRoll || 0);
          this.qw = q[0]; this.qx = q[1]; this.qy = q[2]; this.qz = q[3];
          this.wbx = this.attRollV || 0;
          this.wby = this.attPitchV || 0;
          this.wbz = this.r || 0;
        }
        this._airActive = true;
      }
      /* contact plane for the solvers: through the sample point with the
         surface normal (per-frame sample, per-substep evaluation) */
      const airCtx = {
        zSurf: zSurfTrue, px: this.x, py: this.y,
        ux: upS[0], uy: upS[1], uz: Math.max(upS[2], 0.2),
        grip: surf && typeof surf.grip === 'number' ? surf.grip : 1,
        /* dig = how hard a sliding body/tire grabs the surface (grass > asphalt) —
           drives the trip-into-a-flip; defaults to grip when not supplied */
        dig: surf && typeof surf.dig === 'number' ? surf.dig
          : (surf && typeof surf.grip === 'number' ? surf.grip : 1),
      };
      const SUB = 1 / 480;                 /* ~480 Hz physics */
      if (_unified3d) {
        /* ---- UNIFIED FLOW: one solver every substep, labels derived after.
           The follow-rate filter lives here now (damper reference + the
           track-relative aero flow); the contact plane rides the CLAMPED
           height while the wheels are down (seam-spike protection for the
           springs) and the TRUE height in flight (fast crests outrun the
           clamp and the contacts need real ground). */
        const vzC = clamp(vzSurf, -SURF_VZ_MAX, SURF_VZ_MAX);
        if (!this._zSurfOutlier) {
          this._vzSurfSm = this._vzSurfSm == null ? vzC
            : this._vzSurfSm + (vzC - this._vzSurfSm) * Math.min(1, dt / SURF_VZ_TAU);
        }
        /* ---- contact-plane HEIGHT: follow the true surface, reject spikes.
           The old split solver clamped the plane's descent rate (12 m/s /
           0.12 m per frame) because it set zPos kinematically — but that cap
           also strangled legit fast events: a real crest outran it and the
           car floated instead of flying, and a 15% descent at 145 mph
           (0.16 m/frame) lagged 0.15 m. The unified body is force-driven, so
           it only needs one-frame GLITCHES filtered: track the plane, and if
           this frame's height jumps more than PLANE_SPIKE_M off the predicted
           line it's a seam glitch — coast on the prediction; otherwise follow
           the true height exactly. External x/y shifts (wall/car push) already
           re-anchored the body, so accept the new-position height there. */
        if (this._planeZ == null || !Number.isFinite(this._planeZ)) {
          this._planeZ = zSurfTrue; this._planeVz = 0;
        }
        const predPlane = this._planeZ + this._planeVz * dt;
        const planeResid = zSurfTrue - predPlane;
        /* DOWNWARD moves are always followed immediately: to a force-based
           body a falling road just unloads the springs — a one-frame down-
           glitch is a millimetre blip, while a real cliff/crest MUST open a
           gap the very frame it happens (car.step with height:-6 goes
           ballistic in one frame, like the exe). Only UPWARD spikes slam
           the springs, so those coast ONE frame and are accepted on
           persistence (real rising terrain is still there next frame). */
        if (!this._extShiftFrame && planeResid > PLANE_SPIKE_M
            && (this._planeRejN || 0) < 1) {
          this._planeRejN = 1;
          this._planeZ = predPlane;                    /* up-spike — coast */
        } else {
          this._planeRejN = 0;
          const rate = (zSurfTrue - this._planeZ) / dt;
          this._planeVz += (clamp(rate, -60, 60) - this._planeVz)
            * Math.min(1, dt / SURF_VZ_TAU);
          this._planeZ = zSurfTrue;                    /* real surface — follow */
        }
        airCtx.zSurf = this._planeZ;
        airCtx.vzPlane = 0;

        /* ---- contact-plane NORMAL: rigid re-seat ONLY when the new plane
           CUTS INTO the car beyond what the springs can absorb in a frame
           (an abrupt bank/grade step under a grounded car — the attitude
           analog of the wall-push position re-anchor). If the surface
           rotates AWAY the gaps open and the body must go ballistic — never
           bend the body (or its velocity) after a road that falls away, or
           crests/humps can't launch. Smooth banking/grade changes stay
           penetration-free frame to frame, so the springs own them. */
        {
          const nCur = [airCtx.ux, airCtx.uy, airCtx.uz];
          const nl = Math.hypot(nCur[0], nCur[1], nCur[2]) || 1;
          const nU = [nCur[0] / nl, nCur[1] / nl, nCur[2] / nl];
          if (this._surfN && !this.airborne) {
            const a = this._surfN, b = nU;
            let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
            d = clamp(d, -1, 1);
            const ang = Math.acos(d);
            let needSeat = false;
            if (ang > 1e-4 && ang < NORMAL_FOLLOW_MAX) {
              /* deepest extra wheel compression the NEW plane demands of the
                 CURRENT pose — past the bump-stop band means the springs
                 can't eat it and the impulse backstop would explode */
              const qNow = [this.qw, this.qx, this.qy, this.qz];
              const upNow = qRot(qNow, [0, 0, 1]);
              const cgNow = [this.x + upNow[0] * this.p.cgHeight,
                this.y + upNow[1] * this.p.cgHeight,
                this._cgZ == null
                  ? (this.zPos || this._planeZ) + upNow[2] * this.p.cgHeight
                  : this._cgZ];
              const hWB = this.p.wheelbase / 2, hTW = this.p.trackWidth / 2;
              for (const c of CORNERS) {
                const rW = qRot(qNow,
                  [c.fwd * hWB, c.left * hTW, -this.p.cgHeight]);
                const gapW = (cgNow[0] + rW[0] - this.x) * nU[0]
                  + (cgNow[1] + rW[1] - this.y) * nU[1]
                  + (cgNow[2] + rW[2] - this._planeZ) * nU[2];
                if (-gapW > NORMAL_FOLLOW_PEN_M) { needSeat = true; break; }
              }
            }
            if (needSeat) {
              let ax = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0]];
              const al = Math.hypot(ax[0], ax[1], ax[2]) || 1;
              ax = [ax[0] / al, ax[1] / al, ax[2] / al];
              const s = Math.sin(ang / 2);
              const qd = [Math.cos(ang / 2), ax[0] * s, ax[1] * s, ax[2] * s];
              /* rotate attitude (world-frame pre-mult), the CG about the
                 contact anchor, and the world velocity — a rigid re-seat */
              const q0 = [this.qw, this.qx, this.qy, this.qz];
              const qn = qNorm(qMul(qd, q0));
              this.qw = qn[0]; this.qx = qn[1]; this.qy = qn[2]; this.qz = qn[3];
              const up0 = qRot(q0, [0, 0, 1]);
              if (this._cgZ == null) this._cgZ = (this.zPos || zSurfTrue) + up0[2] * this.p.cgHeight;
              const anchor = [this.x, this.y, this._planeZ];
              const cgW = [this.x + up0[0] * this.p.cgHeight,
                this.y + up0[1] * this.p.cgHeight, this._cgZ];
              const off = [cgW[0] - anchor[0], cgW[1] - anchor[1], cgW[2] - anchor[2]];
              const offR = qRot(qd, off);
              const upN = qRot(qn, [0, 0, 1]);
              this.x = anchor[0] + offR[0] - upN[0] * this.p.cgHeight;
              this.y = anchor[1] + offR[1] - upN[1] * this.p.cgHeight;
              this._cgZ = anchor[2] + offR[2];
              const vW = [this.u * Math.cos(this.yaw) - this.v * Math.sin(this.yaw),
                this.u * Math.sin(this.yaw) + this.v * Math.cos(this.yaw), this.vz];
              const vR = qRot(qd, vW);
              this.vz = vR[2];
              const e0 = qToYPR(qn);
              this.yaw = e0.yaw; this._yawEcho = this.yaw;
              this.u = vR[0] * Math.cos(e0.yaw) + vR[1] * Math.sin(e0.yaw);
              this.v = -vR[0] * Math.sin(e0.yaw) + vR[1] * Math.cos(e0.yaw);
              this.zPos = this._cgZ - upN[2] * (this.p.cgHeight - (this.bodyZ || 0));
              this._zPosEcho = this.zPos;
            }
          }
          this._surfN = nU;
        }
        let remU = dt;
        while (remU > 1e-6) {
          const h = Math.min(SUB, remU);
          this._subUnified(h, input, surf, airCtx);
          remU -= h;
        }
        /* labels judge the gap against the plane the solver actually used —
           the legacy-clamped zSurf lags a cliff by 0.12 m/frame */
        this._resolveUnifiedFrame(dt, surf, this._planeZ);
        return;
      }
      let remaining = dt;
      while (remaining > 1e-6) {
        const h = Math.min(SUB, remaining);
        if (this.airborne) this._subAirborne(h, airCtx);
        else this._stepGround(h, input, surf);
        remaining -= h;
      }
      if (this.airborne) {
        this._airT = (this._airT || 0) + dt;   /* flight time → regrip scale */
        this._airResolveContact(surf, zSurf, vzSurf, dt);
        if (this.restingOnBody) this._crashSettle(dt);
      } else this._groundResolveVertical(dt, surf, zSurf, vzSurf);
      /* the "Test blowover" flap override expires once the car has settled below
         pivot speed — whether it came to rest on its wheels (grounded) or rolled
         onto its roof (restingOnBody, still in the airborne solver) — so real
         effective-flap behaviour resumes for the next spin */
      if (this._blowoverTest && this.speed < BLOWOVER_MIN_MPS
          && (this.restingOnBody || !this.airborne)) {
        this._blowoverTest = false;
      }
    }

    /* grounded vertical — the exe mechanism (FUN_005859a0 pattern, decomp
       BINARY-DUMPS §7): there is NO takeoff detector. Gravity integrates the
       body EVERY tick and the ground is a unilateral constraint — it can only
       PUSH. vz persists across frames, so over a crest the gap opens
       progressively: a slow car is caught by gravity within a frame, a fast
       car simply flies. Airborne is truly emergent.

       The surface-follow velocity vzSurf is a per-frame FINITE DIFFERENCE of
       the sampled track height, so it's noisy (segment seams, the lateral
       re-projection). It is clamped + low-passed before it can become body
       velocity (the tyre/suspension acting as the filter) — seam spikes move
       zPos by their own cm-scale amplitude at most, never inject velocity. */
    _groundResolveVertical(dt, surf, zSurf, vzSurf) {
      const p = this.p;
      if (this._pivotCool > 0) this._pivotCool -= dt;
      const vzC = clamp(vzSurf, -SURF_VZ_MAX, SURF_VZ_MAX);
      if (!this._zSurfOutlier) {
        this._vzSurfSm = this._vzSurfSm == null ? vzC
          : this._vzSurfSm + (vzC - this._vzSurfSm) * Math.min(1, dt / SURF_VZ_TAU);
      }
      /* surface pitch rate — a car cresting a hump is ROTATING nose-down with
         the road; it carries that rotation into flight (real jump dynamics) */
      {
        const up = (surf && surf.up) || [0, 0, 1];
        const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
        const pitchSurf = Math.atan2(up[0] * cy + up[1] * sy, up[2]);
        this._crestPitchV = this._surfPitch == null ? 0
          : clamp(Math.atan2(Math.sin(pitchSurf - this._surfPitch),
            Math.cos(pitchSurf - this._surfPitch)) / dt,
          -CREST_PITCHV_MAX, CREST_PITCHV_MAX);
        this._surfPitch = pitchSurf;
      }
      if (this._groundHold > 0) this._groundHold = Math.max(0, this._groundHold - dt);
      /* gravity + the aero downforce share (see _dfAccelZ) — in-air weight
         matches _subAirborne (which runs the full panel aero) so the
         ballistic band and true flight agree */
      const vzBal = this.vz - (G * AIR_GRAV_SCALE + (this._dfAccelZ || 0)) * dt;
      const zBal = this.zPos + vzBal * dt;
      const gap = zBal - zSurf;
      if (gap > 0) {                                 /* ballistics clear the road */
        /* post-landing grace: a small gap right after touchdown is the
           suspension rebounding, NOT a real launch — stay glued so the tyres
           don't strobe air/ground. A genuine jump (gap past LAND_GRACE_GAP_M)
           still takes off immediately. */
        if (this._groundHold > 0 && gap < LAND_GRACE_GAP_M) {
          this.zPos = zSurf;
          this.vz = Math.min(this.vz, this._vzSurfSm || 0);
          this.onSurface = true;
          this._contactFade = 1;
          this.restingOnBody = false;
          return;
        }
        this.zPos = zBal;
        this.vz = vzBal;
        this.onSurface = false;    /* ballistic band — render follows zPos */
        /* tyre-deflection/droop band: the wheels still reach the road while
           the body runs ballistic — tire LOAD fades with the gap (the car
           goes progressively light over a crest instead of the old binary
           full-grip→zero cliff). Full flight only past a real gap. */
        if (gap > AIR_MIN_GAP_M) {
          this._contactFade = 0;
          this._takeOff(surf, vzBal);
        } else {
          /* going light follows the gap immediately; load RECOVERY is
             rate-limited (~0.1 s to full) — the tire footprint rebuilds, it
             doesn't slam back in one frame */
          const fadePrev = this._contactFade == null ? 1 : this._contactFade;
          this._contactFade = Math.min(1 - gap / AIR_MIN_GAP_M,
            fadePrev + FADE_RECOVER_PER_S * dt);
          this._bandAbsorbed = false;       /* re-arm the re-contact squat */
        }
        this.restingOnBody = false;
        return;
      }
      /* blowover pivot: lift applied at the leading end beats the weight
         moment about the trailing axle (L·wb > m·g·wb/2 ⇒ L > m·g/2). Once it
         holds, the car pivots up off the trailing axle; it breaks contact with
         the rotation it has built and the airborne aero (panel lift) carries
         it over. Rotating about the axle, I_pivot = I + m·(wb/2)². */
      const blowThresh = (BLOWOVER_LIFT_FRAC / (p.blowoverScale || 1)) * p.mass * G;
      if (this._liftMag > blowThresh && this.speed > BLOWOVER_MIN_MPS
          && !(this._pivotCool > 0)) {
        this._liftTimer += dt;
        if (this._liftTimer > LIFTOFF_HOLD_S) {
          this._pivotCool = PIVOT_REFIRE_S;
          /* the slide direction picks the pivot: backwards = tail-over-nose
             PITCH about the trailing axle (the classic blowover), broadside =
             barrel ROLL about the leeward wheel pair (XLIFT lifts the
             windward rocker), diagonal spins get a share of both. Roll's
             short arm + small inertia means a broadside car trips up FAST. */
          const spPlanar = Math.hypot(this.u, this.v) || 1;
          const shareU = Math.abs(this.u) / spPlanar;
          const shareV = Math.abs(this.v) / spPlanar;
          const armP = p.wheelbase / 2, armR = p.trackWidth / 2;
          const iPitch = p.pitchInertia + p.mass * armP * armP;
          const iRoll = p.rollInertia + p.mass * armR * armR;
          const excess = this._liftMag - blowThresh;
          /* pivot angular velocity built over the hold time, ω = α·t */
          const pivotV = ((excess * armP / iPitch) * shareU
            + (excess * armR / iRoll) * shareV) * this._liftTimer;
          /* the leading end/side lifts: backwards ⇒ nose-down(+) pitch over
             the trailing axle; sliding left (v>0) ⇒ the windward LEFT side
             rises (roll + = left up). The CG vz seed matches the rotation
             about the still-grounded wheels, so the leading end doesn't dig
             into the contacts and kill the flip it just started.
             CONTINUATION, not a step: the lift-regime aero roll moment
             (AERO_ROLL_GATE_N) has already been leaning the sprung body, so
             the takeoff floors on the rotation the driver can SEE. The old
             hard 1.5 rad/s floor + 1.0 m/s vz epsilon materialized out of a
             dead-flat pose in one frame — at the threshold margin (lift
             barely holding) the car hopped and dropped straight back:
             "it spins, then pops". A genuine blowover carries a big excess,
             pivotV dominates, and the flip is unchanged. */
          const leanV = Math.abs(this.bodyPitchV) * shareU
            + Math.abs(this.bodyRollV) * shareV;
          /* excess-proportional authority: one fire must carry a GENUINE
             blowover to the aero-runaway regime by itself (the old code got
             there by machine-gun refiring, which the PIVOT_REFIRE_S cooldown
             now forbids). At the margin excess≈0 adds nothing — the takeoff
             stays the gentle continuation of the visible lean. */
          const w0 = Math.max(pivotV, leanV, 0.5)
            + Math.min(3, excess / blowThresh);
          const armEff = armP * shareU + armR * shareV;
          this._takeOff(surf, vzSurf + w0 * armEff + 0.3);
          this.wby += -sign(this.u || 1) * w0 * shareU;
          this.wbx += sign(this.v) * w0 * shareV;
          this.attPitchV = this.wby;
          this.attRollV = this.wbx;
          return;
        }
      } else {
        this._liftTimer = 0;
      }
      /* in contact: the ground supplies the support; the body's vertical
         velocity is the filtered surface-follow rate (tyre/susp as the filter).
         Re-entering from the ballistic band: the closing rate goes into the
         SUSPENSION as a squat (like the airborne landing handoff) — the old
         silent zPos snap was the "wheel suddenly slams to the ground" hit. */
      if (this._contactFade != null && this._contactFade < 1) {
        if (!this._bandAbsorbed) {          /* once per band episode */
          const impact = clamp((this._vzSurfSm || 0) - vzBal, 0, MAX_RECAPTURE_VZ);
          this.bodyZv += impact * RECAPTURE_SOFT;
          this._bandAbsorbed = true;
        }
        this._contactFade = Math.min(1, this._contactFade + FADE_RECOVER_PER_S * dt);
      } else {
        this._contactFade = 1;
        this._bandAbsorbed = false;
      }
      this.zPos = zSurf;
      this.vz = this._vzSurfSm;
      this.onSurface = true;       /* render anchors to the drawn surface */
      this.restingOnBody = false;
    }

    /* leave the ground: seed the rigid body from the surface tilt (resolved
       along/across the body, matching the renderer's surface-alignment basis)
       plus the sprung body's own pitch/roll, and carry the crest-following
       pitch rotation into flight */
    _takeOff(surf, vz) {
      const up = (surf && surf.up) || [0, 0, 1];
      const att = this._bodyAttitude();
      this.airborne = true;
      this.restingOnBody = false;
      /* seed the flight attitude EXACTLY as the viewer was rendering the car
         one frame earlier (surface basis + suspension pitch/roll) — the old
         world-Euler build diverged from the rendered pose on banked crests
         and the body visibly snapped at every takeoff */
      const q = composeRenderQuat(up, this.yaw, att.pitch, att.roll);
      this.qw = q[0]; this.qx = q[1]; this.qy = q[2]; this.qz = q[3];
      const e = qToYPR(q);
      this.attPitch = e.pitch;
      this.attRoll = e.roll;
      this.wbx = -this.bodyRollV;
      this.wby = this.bodyPitchV + (this._crestPitchV || 0) * CREST_SEED_FRAC;
      this.wbz = this.r;
      this.attPitchV = this.wby;
      this.attRollV = this.wbx;
      this._airActive = true;
      this._airContacts = null;
      this._wheelImpact = 0;   /* fresh flight — recapture the true touchdown speed */
      /* carry the sprung-body heave into the flight anchor: the grounded
         render adds `heave` (−bodyZ) on top of the surface anchor, the
         flight render doesn't — without this transfer the rendered body
         DROPPED by the takeoff compression (≈6 cm off a loaded crest) in
         the flip frame */
      this.zPos += -this.bodyZ;
      this.bodyZ = 0;
      this.vz = vz;
      this._liftTimer = 0;
      this._airborneHold = AIRBORNE_HOLD_S;
      this.up = [0, 0, 1];
    }

    /* airborne substep — hybrid: the exe free-flight constants (g, per-tick
       angular damping, object bounce/scrub) driving a full custom 3D rigid
       body. Quaternion attitude + body-frame angular velocity (Euler
       equations incl. gyroscopic term), physical aero (attached downforce
       that dies with AoA, flat-plate underbody lift whose centre of pressure
       migrates toward the into-wind end — blowovers EMERGE from this), and
       per-substep ground contacts: wheels land on penalty spring-dampers
       (the suspension genuinely catches the car corner-by-corner), body
       corners take the exe object bounce. */
    _subAirborne(h, ctx) {
      const p = this.p;
      /* NO resting early-return: the car ALWAYS has live physics. A body-down
         car at rest is held by the same gravity + inelastic contacts + Coulomb
         friction as everything else — it can be nudged, slide down a bank, or
         roll to a stabler pose. The old kinematic freeze (planar slide only,
         attitude/vz pinned, zPos eased onto an analytic rest plane) was the
         "comes to rest then levitates frozen" bug: restingOnBody is a LABEL
         now, not a physics mode. */
      let q = [this.qw, this.qx, this.qy, this.qz];
      let wb = [this.wbx, this.wby, this.wbz];
      const hCG = p.cgHeight;
      const m = p.mass;
      const upB0 = qRot(q, [0, 0, 1]);
      /* CG world state (zPos tracks the tyre-contact plane; CG rides hCG
         above it along body-up — rotation happens about the CG) */
      const cg = [
        this.x + upB0[0] * hCG,
        this.y + upB0[1] * hCG,
        this.zPos + upB0[2] * hCG];
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      const vel = [this.u * cy - this.v * sy, this.u * sy + this.v * cy, this.vz];

      /* ---- aero: the multi-surface panel model, freestream + rotation ----
         weathervane stability, CoP migration, backwards lift and blowover
         moments all come out of panelAero's per-surface geometry now */
      /* air-relative (ambient wind subtracted) — a tumbling car feels the
         same wind field the grounded aero does */
      const vB = qRotInv(q, [vel[0] - (p.windX || 0), vel[1] - (p.windY || 0), vel[2]]);
      const speed3 = Math.hypot(vB[0], vB[1], vB[2]);
      const beta = Math.hypot(vB[0], vB[1]) > 2 ? Math.atan2(vB[1], vB[0]) : 0;
      /* roof flaps pop in reversed flow — VISUAL deploy state (drives the mesh
         morph). Gated on flapsPresent (fitted), NOT effectiveness, so ineffective
         flaps still visibly flutter open while the car blows over. */
      const upBFlap = qRot(q, [0, 0, 1]);
      updateCarFlapSwing(this, h, upBFlap, beta, speed3);
      /* ground-effect suction fades as the floor leaves the road (decay
         length ~ floor chord/3 — long enough that a normal crest jump keeps
         most of its front-floor suction, so the pitch trim stays flat) */
      const cgGap = (cg[0] - ctx.px) * ctx.ux + (cg[1] - ctx.py) * ctx.uy
        + (cg[2] - ctx.zSurf) * ctx.uz;
      const geGate = clamp(1 - Math.max(0, cgGap - p.cgHeight) / 1.8, 0, 1);
      const aero = panelAero(vB, wb, {
        rho: p.airDensity, cgH: p.cgHeight, ge: geGate,
        /* flaps spoil the lift only when deployed AND effective (the blowover
           test suspends effectiveness so the triggered flip always completes) */
        flaps: this.flapsDeployed && !!p.employRoofFlaps && !this._blowoverTest, dmg: this.damage || 0,
        flapsEffective: !!p.flapsPresent && !!p.employRoofFlaps && !this._blowoverTest,
        spoilerDeg: p.spoilerDeg, panels: this.aeroPanels || undefined,
        dragScale: p.dragScale,
      });
      const fB = aero.f.map((v) => v * AIR_AERO_SCALE);
      const tB = aero.t.map((v) => v * AIR_AERO_SCALE);
      this._liftMag = aero.lift;

      /* gravity + aero → linear velocity (both scaled a touch heavier in
         flight — AIR_GRAV_SCALE/AIR_AERO_SCALE, feel calibration) */
      const fW = qRot(q, fB);
      vel[0] += (fW[0] / m) * h;
      vel[1] += (fW[1] / m) * h;
      vel[2] += (fW[2] / m - G * AIR_GRAV_SCALE) * h;

      /* ---- ground contacts: sequential-impulse solver (per substep) ----
         Rebuilt 2026-07-09. The wheels used to ride a stiff PENALTY SPRING
         (which stores energy and trampolines — "tyres glitch/bounce when they
         come back down") and the bodywork used the exe loose-object bounce
         (restitution 0.3, token scrub — "the body just glides"). Both gone.

         Every contact — wheel or panel — is now a velocity-level impulse with
         ZERO restitution: it removes the inbound normal velocity and nothing
         more, so no contact can EVER fling the car up (dead, heavy landings).
         Tangential friction is a clamped Coulomb impulse against the contact's
         effective mass, so it genuinely ARRESTS the slide: high µ on the
         bodywork (sheet metal digging), and applied at an offset point it
         torques the car into a flip instead of gliding. Wheels roll nearly
         free lengthwise and grip laterally like tyres. */
      const gapOf = (pt) => (pt[0] - ctx.px) * ctx.ux + (pt[1] - ctx.py) * ctx.uy
        + (pt[2] - ctx.zSurf) * ctx.uz;
      const n = [ctx.ux, ctx.uy, ctx.uz];
      const Ix = AIR_INERTIA[0] * _massScale, Iy = AIR_INERTIA[1] * _massScale, Iz = AIR_INERTIA[2] * _massScale;
      const invI = [1 / Ix, 1 / Iy, 1 / Iz];
      const fzAir = [0, 0, 0, 0];
      let wheelContacts = 0, bodyContacts = 0, deepestBody = 0, deepestWheel = 0;
      const mu = p.muBase * (ctx.grip != null ? ctx.grip : 1);
      /* lateral dig µ: a wheel scrubbing SIDEWAYS plows a furrow — grass grabs
         it (dig high) and helps trip the car. Only bites at real lateral speed
         (jLat is speed-capped), so a straight upright landing is barely touched. */
      const muDig = p.muBase * (ctx.dig != null ? ctx.dig : (ctx.grip != null ? ctx.grip : 1));
      /* body-down gate (shared by the wheel dig and the bodywork below): how
         far the car is rolled off its wheels. Computed here because the WHEEL
         lateral µ needs it too — an UPRIGHT wheel rolls/scrubs, it does not
         furrow. Giving upright wheels the full grass plow µ let a micro-air
         slide pump itself: each one-wheel contact's dig impulse torqued the
         body, the rotation rectified into climb, and the car reared up 60°+
         from an 8 cm seam hop ("sliding at an angle in grass randomly pops
         the front end up"). Rolled onto its side, the full trip µ engages —
         real grass trips are untouched. */
      const upBody = qRot(q, [0, 0, 1]);
      const align = upBody[0] * n[0] + upBody[1] * n[1] + upBody[2] * n[2];
      const bodyGate = clamp((BODY_GATE_UPRIGHT - align)
        / (BODY_GATE_UPRIGHT - BODY_GATE_DOWN), 0, 1);
      const wheelMuLat = mu + (muDig - mu) * bodyGate;
      const halfWB = p.wheelbase / 2, halfTW = p.trackWidth / 2;

      /* velocity of the contact point at world offset rW */
      const pointVel = (rW) => {
        const w = qRot(q, wb);
        return [
          vel[0] + w[1] * rW[2] - w[2] * rW[1],
          vel[1] + w[2] * rW[0] - w[0] * rW[2],
          vel[2] + w[0] * rW[1] - w[1] * rW[0]];
      };
      /* effective mass along unit world dir d, for a contact at body offset rB */
      const effMass = (rB, d) => {
        const dB = qRotInv(q, d);
        const rxd = cross3(rB, dB);
        const k = rxd[0] * rxd[0] * invI[0] + rxd[1] * rxd[1] * invI[1]
          + rxd[2] * rxd[2] * invI[2];
        return 1 / (1 / m + k);
      };
      /* apply world impulse J at body offset rB (linear + angular) */
      const applyImp = (rB, J) => {
        vel[0] += J[0] / m; vel[1] += J[1] / m; vel[2] += J[2] / m;
        const JB = qRotInv(q, J);
        const t = cross3(rB, JB);
        wb[0] += t[0] * invI[0]; wb[1] += t[1] * invI[1]; wb[2] += t[2] * invI[2];
      };

      /* CG closing speed on the surface (before any impulse) — this is the
         heave the suspension should swallow as a squat at handoff; the
         per-corner point velocity would over-count a rolling landing's spin */
      const velN0 = vel[0] * n[0] + vel[1] * n[1] + vel[2] * n[2];

      /* wheels: inelastic normal impulse + anisotropic tyre friction */
      for (let i = 0; i < 4; i++) {
        const c = CORNERS[i];
        const rB = [c.fwd * halfWB, c.left * halfTW, -hCG];
        const rW = qRot(q, rB);
        const pt = [cg[0] + rW[0], cg[1] + rW[1], cg[2] + rW[2]];
        const pen = -gapOf(pt);
        if (pen <= 0) continue;
        wheelContacts++;
        deepestWheel = Math.max(deepestWheel, pen);
        const vp = pointVel(rW);
        const vn = vp[0] * n[0] + vp[1] * n[1] + vp[2] * n[2];
        if (vn >= 0) continue;                 /* resting/separating — never pull down */
        /* tire-compliance stand-in: arrest the sink over ~20 ms instead of
           one 480 Hz substep — the instant full-arrest impulse put the whole
           touchdown through µ·jn in a single tick (a 12+ rad/s² yaw yank
           landing mid-slide, felt as the slam/veer) */
        const vnArrest = Math.max(vn, -WHEEL_VN_ARREST_SUB);
        const jn = -vnArrest * effMass(rB, n); /* e = 0: cancel the sink, no rebound */
        applyImp(rB, [jn * n[0], jn * n[1], jn * n[2]]);
        fzAir[i] = jn / h;                      /* report as a support force */
        /* tyre friction, bounded by this normal impulse; roll vs lateral */
        const vp2 = pointVel(rW);
        const vn2 = vp2[0] * n[0] + vp2[1] * n[1] + vp2[2] * n[2];
        const vt = [vp2[0] - vn2 * n[0], vp2[1] - vn2 * n[1], vp2[2] - vn2 * n[2]];
        const fwdW = qRot(q, [1, 0, 0]);
        const fdotn = fwdW[0] * n[0] + fwdW[1] * n[1] + fwdW[2] * n[2];
        const ft = [fwdW[0] - fdotn * n[0], fwdW[1] - fdotn * n[1], fwdW[2] - fdotn * n[2]];
        const ftLen = Math.hypot(ft[0], ft[1], ft[2]) || 1;
        const fu = [ft[0] / ftLen, ft[1] / ftLen, ft[2] / ftLen];
        const vLong = vt[0] * fu[0] + vt[1] * fu[1] + vt[2] * fu[2];
        const vLatV = [vt[0] - vLong * fu[0], vt[1] - vLong * fu[1], vt[2] - vLong * fu[2]];
        const vLatLen = Math.hypot(vLatV[0], vLatV[1], vLatV[2]);
        if (Math.abs(vLong) > 1e-4) {           /* free-rolling: light lengthwise scrub */
          const jL = clamp(effMass(rB, fu) * vLong, -WHEEL_AIR_MU_LONG * jn, WHEEL_AIR_MU_LONG * jn);
          applyImp(rB, [-jL * fu[0], -jL * fu[1], -jL * fu[2]]);
        }
        if (vLatLen > 1e-4) {                   /* tyre grip: arrest lateral, µ-capped */
          const lHat = [vLatV[0] / vLatLen, vLatV[1] / vLatLen, vLatV[2] / vLatLen];
          const jLat = Math.min(WHEEL_AIR_MU_LAT * wheelMuLat * jn, effMass(rB, lHat) * vLatLen);
          applyImp(rB, [-jLat * lHat[0], -jLat * lHat[1], -jLat * lHat[2]]);
        }
      }
      /* seed the landing squat from the CG closing speed on the frames a wheel
         actually touched (capped later by MAX_RECAPTURE_VZ at handoff) */
      if (wheelContacts > 0 && velN0 < 0) {
        this._wheelImpact = Math.max(this._wheelImpact, -velN0);
      }

      /* bodywork: inelastic (DEAD) normal + high-grip Coulomb friction over the
         car-shaped silhouette — a panel digs and TRIPS the car into a flip
         instead of gliding; roof/nose/flank hits land on the visible bodywork.

         GATED by how body-down the car is (upB·surfaceUp): when the car is
         upright the wheels are the intended contact and a splitter/tail merely
         GRAZING during a jump must not deliver a sharp impulse — that kick
         torqued the car into a self-amplifying tumble (a 60 mph crest jump
         backflipped instead of landing). So near-upright the body is passive
         (penetration is still corrected positionally below); once the car is
         genuinely on its side/roof the full dig-and-flip grip engages.
         (upBody/align/bodyGate computed above, shared with the wheel dig µ.) */
      /* bodywork uses DIG, not rolling grip: on asphalt dig==grip (unchanged),
         but on grass/dirt dig is HIGH so a panel bites and TRIPS the car into a
         roll instead of sliding (was grip 0.35 → it used to slide MORE on grass,
         backwards from NR2003 where grass grabs and flips you) */
      const bodyMu = BODY_GRIP_MU * (ctx.dig != null ? ctx.dig : (ctx.grip != null ? ctx.grip : 1));
      if (bodyGate > 0) for (const bp of this.bodyPts) {
        const rB = [bp[0], bp[1], bp[2] - hCG];
        const rW = qRot(q, rB);
        const pw = [cg[0] + rW[0], cg[1] + rW[1], cg[2] + rW[2]];
        const pen = -gapOf(pw);
        if (pen <= 0) continue;
        bodyContacts++;
        deepestBody = Math.max(deepestBody, pen);
        const vp = pointVel(rW);
        const vn = vp[0] * n[0] + vp[1] * n[1] + vp[2] * n[2];
        if (vn >= 0) continue;
        const jn = -vn * effMass(rB, n) * bodyGate;   /* e = 0 — heavy, no bounce */
        applyImp(rB, [jn * n[0], jn * n[1], jn * n[2]]);
        const vp2 = pointVel(rW);
        const vn2 = vp2[0] * n[0] + vp2[1] * n[1] + vp2[2] * n[2];
        const vt = [vp2[0] - vn2 * n[0], vp2[1] - vn2 * n[1], vp2[2] - vn2 * n[2]];
        const vtLen = Math.hypot(vt[0], vt[1], vt[2]);
        if (vtLen > 1e-3) {                     /* clamped Coulomb → dig + tumble */
          const tHat = [vt[0] / vtLen, vt[1] / vtLen, vt[2] / vtLen];
          const jt = Math.min(bodyMu * jn, effMass(rB, tHat) * vtLen);
          applyImp(rB, [-jt * tHat[0], -jt * tHat[1], -jt * tHat[2]]);
        }
        if (jn > 4000) this.addDamage(jn / 90000);
      }

      /* positional correction (Baumgarte): lift the deepest penetrating contact
         out along the normal so the car sits ON its wheels/panels — a pure
         velocity constraint stops inbound motion but never pushes out */
      const deepest = Math.max(deepestWheel, deepestBody);
      if (deepest > 0) {
        const push = Math.min(deepest * CONTACT_DEPEN, CONTACT_DEPEN_MAX);
        cg[0] += n[0] * push;
        cg[1] += n[1] * push;
        cg[2] += n[2] * push;
      }

      /* ---- integrate rotation (Euler equations + exe angular damping) ---- */
      wb[0] += ((tB[0] - (Iz - Iy) * wb[1] * wb[2]) / Ix) * h;
      wb[1] += ((tB[1] - (Ix - Iz) * wb[2] * wb[0]) / Iy) * h;
      wb[2] += ((tB[2] - (Iy - Ix) * wb[0] * wb[1]) / Iz) * h;
      const angD = Math.pow(AIR_ANG_DAMP, h * AIR_DAMP_HZ);
      wb[0] = clamp(wb[0] * angD, -AIR_MAX_ANG, AIR_MAX_ANG);
      wb[1] = clamp(wb[1] * angD, -AIR_MAX_ANG, AIR_MAX_ANG);
      wb[2] = clamp(wb[2] * angD, -AIR_MAX_ANG, AIR_MAX_ANG);
      const dq = qMul(q, [0, wb[0] * 0.5 * h, wb[1] * 0.5 * h, wb[2] * 0.5 * h]);
      q = qNorm([q[0] + dq[0], q[1] + dq[1], q[2] + dq[2], q[3] + dq[3]]);

      /* ---- integrate position, write back the interface state ---- */
      cg[0] += vel[0] * h;
      cg[1] += vel[1] * h;
      cg[2] += vel[2] * h;
      const upB = qRot(q, [0, 0, 1]);
      this.x = cg[0] - upB[0] * hCG;
      this.y = cg[1] - upB[1] * hCG;
      this.zPos = cg[2] - upB[2] * hCG;
      this.vz = vel[2];
      this.qw = q[0]; this.qx = q[1]; this.qy = q[2]; this.qz = q[3];
      this.wbx = wb[0]; this.wby = wb[1]; this.wbz = wb[2];
      const e = qToYPR(q);
      this.yaw = lerpAngle(this._yawEcho != null ? this._yawEcho : this.yaw, e.yaw, 1);
      this._yawEcho = this.yaw;
      this.attPitch = e.pitch;
      this.attRoll = e.roll;
      this.attPitchV = wb[1];
      this.attRollV = wb[0];
      const wWorld = qRot(q, wb);
      this.r = clamp(wWorld[2], -8, 8);
      this.u = vel[0] * Math.cos(this.yaw) + vel[1] * Math.sin(this.yaw);
      this.v = -vel[0] * Math.sin(this.yaw) + vel[1] * Math.cos(this.yaw);
      this.ax = 0;
      this.ay = 0;
      this._tireFxN = 0;
      this.lastFz = fzAir;
      this.suspFz = fzAir.slice();
      this.lastSlideSpd = [0, 0, 0, 0];   /* tire FX are grounded-only */
      this._airContacts = { wheels: wheelContacts, body: bodyContacts, deepestBody };
    }

    /* ---- THE UNIFIED SUBSTEP: one 6-DOF rigid body, always -------------
       Driving, flying, tumbling and resting are REGIMES of this one solver,
       not modes — ground support, tire grip, aero, gravity and crash
       contacts are all just forces/impulses on the same body every substep.
       The tuned force models are transplanted intact from the split solvers:
       - the drivetrain/steering/aids/slip/tireForce pipeline (from _stepGround),
         its per-wheel output applied at the contact points in 3D;
       - the suspension spring/bump-stop/shape-damper/sway-bar force
         elements (from _stepSuspension), evaluated at GEOMETRIC wheel
         travel — load transfer, banking load, crest unload and blowover
         lift-off all EMERGE from real chassis motion;
       - the panel-aero wrench and the sequential-impulse contact solver
         (from _subAirborne), zero restitution — dead, heavy landings.
       Feel preservation: lateral tire force acts at each axle's ROLL-CENTER
       height and longitudinal force acts low by the anti-dive/anti-squat
       link share, so transient load transfer keeps the old tuned arms; the
       instant link share of the tire LOAD (geoF/geoR/geoP) adds to fz
       verbatim; and the asymmetric-spring roll-reference fix is reproduced
       by applying each corner's ROLL-FREE reference force at a roll-neutral
       point (see fRef below). */
    _subUnified(h, input, surf, ctx) {
      const p = this.p;
      /* ---- canonical state in (+ absorb external writes) ---- */
      let q = [this.qw, this.qx, this.qy, this.qz];
      if ((this._attPitchEcho !== this.attPitch && Number.isFinite(this.attPitch))
          || (this._attRollEcho !== this.attRoll && Number.isFinite(this.attRoll))) {
        /* external ATTITUDE write (tests/state-load seed an inverted or
           tilted car through the Euler view): rebuild the whole quat from
           yaw/pitch/roll and the body rates from the Euler-rate view —
           mirrors the legacy external-airborne handoff. Covers a
           simultaneous yaw write too, so the yaw re-aim below is skipped. */
        q = qFromYPR(this.yaw, this.attPitch || 0, this.attRoll || 0);
        this.wbx = this.attRollV || 0;
        this.wby = this.attPitchV || 0;
        this.wbz = this.r || 0;
        this._cgZ = null;             /* re-anchor the CG under the new pose */
        this._yawEcho = this.yaw;
      } else if (this._yawEcho !== this.yaw && Number.isFinite(this.yaw)) {
        /* external yaw write (reset/save-load/tests): re-aim the quat */
        const e0 = qToYPR(q);
        let dy = this.yaw - e0.yaw;
        if (dy > Math.PI) dy -= 2 * Math.PI; else if (dy < -Math.PI) dy += 2 * Math.PI;
        if (Math.abs(dy) > 1e-9) {
          q = qNorm(qMul([Math.cos(dy / 2), 0, 0, Math.sin(dy / 2)], q));
        }
      }
      let wb = [this.wbx, this.wby, this.wbz];
      if (this._rEcho !== this.r && Number.isFinite(this.r)) {
        /* external yaw-rate write (wall/car-car impulses): fold into wb */
        const wW0 = qRot(q, wb);
        const dR = clamp(this.r, -8, 8) - wW0[2];
        if (Math.abs(dR) > 1e-9) {
          const add = qRotInv(q, [0, 0, dR]);
          wb = [wb[0] + add[0], wb[1] + add[1], wb[2] + add[2]];
        }
      }
      const hCG = p.cgHeight;
      const m = p.mass;
      const upB0 = qRot(q, [0, 0, 1]);
      if (this._cgZ == null || this._zPosEcho !== this.zPos) {
        /* external zPos write: re-anchor the CG under the same composition
           the write-back uses (zPos rides the tyre plane; the body sits
           hCG − bodyZ above it along body-up) */
        this._cgZ = (this.zPos || 0) + upB0[2] * (hCG - (this.bodyZ || 0));
      }
      const cg = [this.x + upB0[0] * hCG, this.y + upB0[1] * hCG, this._cgZ];
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      const vel = [this.u * cy - this.v * sy, this.u * sy + this.v * cy, this.vz];
      this._airActive = true;      /* the quat state is permanently live */

      /* ---- shared prep (verbatim from the split grounded solver) ---- */
      const up = (surf && surf.up) || [0, 0, 1];
      this.up = up;
      let gripScale = surf && typeof surf.grip === 'number' ? surf.grip : 1;
      const surfClass = (surf && Number.isInteger(surf.surfaceClass)) ? surf.surfaceClass : ASPHALT_CLASS;
      if (this._regripT > 0) {
        this._regripT = Math.max(0, this._regripT - h);
        gripScale *= 1 - REGRIP_DROP * (this._regripT / REGRIP_S);
      }
      this.reverseReq = !!input.reverse;
      const lockUp = !!input.lockUp;
      const tThr = lockUp ? 0 : clamp(input.throttle || 0, 0, 1);
      const tBrk = lockUp ? 1 : clamp(input.brake || 0, 0, 1);
      const tSteer = clamp(input.steer || 0, -1, 1);
      this.throttle = tThr;
      this.brake = tBrk;
      const speed = this.speed;
      const assist = 1 / (1 + p.steerSpeedFalloff * Math.max(0, speed - p.steerAssistFromMps));
      let steerLimit = p.maxSteer * Math.max(assist, p.steerAssistFloor);
      if (p.lowSpeedSteerBoost) {
        steerLimit *= 1 + p.steerBoostMax * clamp(1 - speed / p.steerBoostFadeMps, 0, 1);
      }
      const steerTarget = tSteer * steerLimit;
      const returning = Math.abs(steerTarget) < Math.abs(this.steer) ||
        (steerTarget !== 0 && this.steer !== 0 && sign(steerTarget) !== sign(this.steer));
      const slew = (steerLimit / p.steerSweepS) * (returning ? p.steerReturnMul : 1);
      this.steer += clamp(steerTarget - this.steer, -slew * h, slew * h);

      /* down-slope gravity components (stick-regime feedforward, rest hold,
         reported ax/ay). Real gravity acts on the body as a world force.
         The TRUE 3D in-plane gravity vector projected on the car's in-plane
         axes — the old world-XY shadow (gInPlane·yaw) undershot the along-
         slope pull by (1−cos²θ)/cosθ ≈ 9% on 24° banking, and the stick
         regime's damper balanced the shortfall at a steady ~9 mm/s creep
         (the "car slides down the banking during a pace lap" bug). */
      const gip = [G * up[2] * up[0], G * up[2] * up[1],
        G * (up[2] * up[2] - 1)];
      const n = [ctx.ux, ctx.uy, ctx.uz];
      const fwdW0 = qRot(q, [1, 0, 0]);
      const fdn = fwdW0[0] * n[0] + fwdW0[1] * n[1] + fwdW0[2] * n[2];
      let fwdP = [fwdW0[0] - fdn * n[0], fwdW0[1] - fdn * n[1], fwdW0[2] - fdn * n[2]];
      const fpl = Math.hypot(fwdP[0], fwdP[1], fwdP[2]) || 1;
      fwdP = [fwdP[0] / fpl, fwdP[1] / fpl, fwdP[2] / fpl];
      const leftP = cross3(n, fwdP);
      const gFwd = gip[0] * fwdP[0] + gip[1] * fwdP[1] + gip[2] * fwdP[2];
      const gLeft = gip[0] * leftP[0] + gip[1] * leftP[1] + gip[2] * leftP[2];
      /* banked-turn normal boost: only the UNSPRUNG column is fed forward —
         the sprung share is EMERGENT (centripetal acceleration presses the
         body into its springs) */
      const vxw = vel[0], vyw = vel[1];
      const aDotN = -this.r * vyw * up[0] + this.r * vxw * up[1];
      const bankBoost = clamp(aDotN, -0.6 * G, 2.6 * G);
      const gEffN = Math.max(0.15 * G, G * clamp(up[2], 0.2, 1) + bankBoost);
      const w = p.mass * gEffN;
      const dmg = this.damage || 0;

      /* continuous rest blend (see the split solver's f167 notes) */
      const speedRest = clamp((0.5 - speed) / 0.38, 0, 1);
      const driveCut = 1 - clamp((this.throttle - 0.04) / 0.06, 0, 1);
      const rb0 = this._restBlend || 0;
      this._restBlend = rb0 + (speedRest * driveCut - rb0) * Math.min(1, h / 0.12);
      const restBlend = this._restBlend;
      const loadLive = 1 - restBlend;
      const axLoad = (this._tireFxN || 0) / p.mass * loadLive;
      const ayLoad = this.ay * loadLive;

      /* ---- rigid-body helpers (verbatim from the flight solver) ---- */
      const gapOf = (pt) => (pt[0] - ctx.px) * n[0] + (pt[1] - ctx.py) * n[1]
        + (pt[2] - ctx.zSurf) * n[2];
      /* the per-car TUNED inertia tensor (mass-scale aware), not the flight
         solver's whole-car estimate: the corner dampers are tuned ζ≈0.92
         against rollInertia 550 — the flight 900 made the roll transient
         underdamped, spiking front load transfer 20%+ on turn-in and
         flipping the handling balance to terminal push */
      const Ix = p.rollInertia, Iy = p.pitchInertia, Iz = p.yawInertia;
      const invI = [1 / Ix, 1 / Iy, 1 / Iz];
      const pointVel = (rW) => {
        const wv = qRot(q, wb);
        return [
          vel[0] + wv[1] * rW[2] - wv[2] * rW[1],
          vel[1] + wv[2] * rW[0] - wv[0] * rW[2],
          vel[2] + wv[0] * rW[1] - wv[1] * rW[0]];
      };
      const effMass = (rB, d) => {
        const dB = qRotInv(q, d);
        const rxd = cross3(rB, dB);
        const k = rxd[0] * rxd[0] * invI[0] + rxd[1] * rxd[1] * invI[1]
          + rxd[2] * rxd[2] * invI[2];
        return 1 / (1 / m + k);
      };
      const applyImp = (rB, J) => {
        vel[0] += J[0] / m; vel[1] += J[1] / m; vel[2] += J[2] / m;
        const JB = qRotInv(q, J);
        const t = cross3(rB, JB);
        wb[0] += t[0] * invI[0]; wb[1] += t[1] * invI[1]; wb[2] += t[2] * invI[2];
      };
      const applyForce = (rB, F) => applyImp(rB, [F[0] * h, F[1] * h, F[2] * h]);
      /* smoothed wheel-load fraction fades the flight feel constants
         (grav/aero ×AIR_*_SCALE, exe angular damping) in and out — no mode */
      const airShare = 1 - (this._loadFrac == null ? 1 : this._loadFrac);

      /* ---- geometric suspension: real spring/damper travel ----
         The strut geometry is only meaningful near-upright: springGate fades
         the springs out as the body rolls off its wheels (a car on its side
         cannot be carried by its struts) and the contact backstop's inelastic
         wheel points fade IN over the same band — tumbles keep the tuned
         flight-solver wheel behaviour. */
      const halfWB = p.wheelbase / 2, halfTW = p.trackWidth / 2;
      const mUn = p.unsprungMass || 42;
      const fz = [0, 0, 0, 0];
      const fSusp = [0, 0, 0, 0];
      const wheelRB = [
        [halfWB, halfTW, -hCG], [halfWB, -halfTW, -hCG],
        [-halfWB, halfTW, -hCG], [-halfWB, -halfTW, -hCG]];
      const alignS = upB0[0] * n[0] + upB0[1] * n[1] + upB0[2] * n[2];
      const springGate = clamp((alignS - SPRING_GATE_DOWN)
        / (SPRING_GATE_UP - SPRING_GATE_DOWN), 0, 1);
      let loadedN = 0, compDeltaSum = 0, compVelSum = 0;
      for (let i = 0; i < 4; i++) {
        const rB = wheelRB[i];
        const rW = qRot(q, rB);
        const pt = [cg[0] + rW[0], cg[1] + rW[1], cg[2] + rW[2]];
        const gap = gapOf(pt);
        const comp = this.suspComp0[i] - gap;
        const vp = pointVel(rW);
        /* travel rate = the contact point's own normal velocity (the plane is
           re-sampled fresh each frame — a steady grade is zero travel rate) */
        const cV = -(vp[0] * n[0] + vp[1] * n[1] + vp[2] * n[2]);
        this.suspComp[i] = comp;
        this.suspVel[i] = cV;
        this.suspFzVel[i] = p.cornerSpring[i] * cV;
        if (comp > 0 && springGate > 0) {
          let fS = springBump(comp, p.cornerSpring[i],
            this.suspComp0[i] + p.bumpGapM[i], p.bumpGapM[i], p.bumpRateNpm3);
          if (cV < 0 && (this._regripT > 0 || this.airborne)) {
            /* bump rubbers are hysteretic: full force into the stop, a
               fraction on the RELEASE stroke — a hard landing can't pole-
               vault the car back off the road (the porpoise killer).
               LANDING WINDOW ONLY: a car riding its stop mid-corner (Cup on
               a short track) must keep the symmetric force, or the weak
               release stroke ratchets the corner 0.2 mm deeper — the cubic
               is ~3 kN/mm there and the handling balance tips tight. */
            const fLin = p.cornerSpring[i] * comp;
            fS = fLin + (fS - fLin) * BUMPSTOP_REB_FRAC;
          }
          let cD = cV > 0 ? p.cornerDamperComp[i] : p.cornerDamperReb[i];
          cD *= damperShapeGain(cV, i);
          cD *= 1 + 3 * restBlend;      /* at-rest damping boost, faded */
          if (cV < 0 && (this._regripT > 0 || this.airborne)) {
            /* landing-catch + regrip window: the return stroke is over-
               damped while the car is still catching — eats the rebound.
               (airborne label + loaded wheel = mid-catch, label not yet
               flipped) */
            cD *= LAND_REB_DAMP_MUL;
          }
          fSusp[i] = (fS + cD * cV) * springGate;
          loadedN++;
          compDeltaSum += comp - this.suspComp0[i];
          compVelSum += cV;
        } else {
          fSusp[i] = 0;
        }
      }
      /* sway bars on the L−R travel difference off the static set.
         UNIFIED_FRONT_BAR_REBAL (0.8): the old planar solver integrated yaw
         FLAT (bodyRoll was a cosmetic/reference DOF that never fed the u/v/r
         dynamics). The unified rigid body ROLLS for real (~1.4° at 1.6 g), and
         that roll adds a front-biased elastic load transfer + a weathervane
         yaw-damping the flat model never had — enough to push the tuned Cup
         balance from oversteer-building to neutral at the limit (a car that
         would not rotate on throttle: smoke "full throttle mid-corner rotates
         the car" fell from 34° to 1.5°). Trimming the front roll stiffness 20%
         restores the planar limit-balance: rotation back to ~35°, provoked
         slide still self-recovers. Bisected — 1.0 = won't rotate, 0.5 = the
         provoked slide diverges. Front-bar (not rear) because the roll's excess
         transfer is front-biased. */
      const UNIFIED_FRONT_BAR_REBAL = 0.8;
      const barF = UNIFIED_FRONT_BAR_REBAL * p.frontBarNpm
        * ((this.suspComp[0] - this.suspComp0[0])
        - (this.suspComp[1] - this.suspComp0[1]));
      const barR = (p.rearBarNpm || 0) * ((this.suspComp[2] - this.suspComp0[2])
        - (this.suspComp[3] - this.suspComp0[3]));
      if (this.suspComp[0] > 0) fSusp[0] += barF;
      if (this.suspComp[1] > 0) fSusp[1] -= barF;
      if (this.suspComp[2] > 0) fSusp[2] += barR;
      if (this.suspComp[3] > 0) fSusp[3] -= barR;
      /* instant link shares of the TIRE LOAD (no body torque) — verbatim */
      const mF = p.mass * p.weightDistFront, mR = p.mass - mF;
      const geoF = mF * ayLoad * p.rollCenterFM / p.trackWidth;
      const geoR = mR * ayLoad * p.rollCenterRM / p.trackWidth;
      const antiFrac = axLoad < 0 ? p.antiDiveFrac : p.antiSquatFrac;
      const ms = p.mass - 4 * mUn;
      const geoP = -ms * axLoad * p.cgHeight * antiFrac / p.wheelbase / 2;
      /* the LATERAL force line for the sprung roll couple: the old solver
         rolled ms·ay about the mass-weighted average roll center — every
         in-plane lateral force (tires AND aero side force) couples through
         this one arm, scaled by the sprung share (the unsprung mass reacts
         at road level without rolling the chassis) */
      const msFrac = ms / p.mass;
      const rcAvg = (p.rollCenterFM * mF + p.rollCenterRM * mR) / p.mass;
      const zLatAvg = -(hCG - rcAvg) * msFrac;
      /* roll-free reference (the asymmetric-spring lean fix): heave + pitch
         share of the CURRENT travel, no roll term — the roll projection of
         the springs sees only DEVIATIONS from this, so uniform compression
         with asymmetric L/R rates cannot lean the car */
      const d0 = this.suspComp[0] - this.suspComp0[0];
      const d1 = this.suspComp[1] - this.suspComp0[1];
      const d2 = this.suspComp[2] - this.suspComp0[2];
      const d3 = this.suspComp[3] - this.suspComp0[3];
      const heaveG = (d0 + d1 + d2 + d3) / 4;
      const pitchShare = ((d0 + d1) - (d2 + d3)) / 4 / 2;   /* per-halfWB share */
      for (let i = 0; i < 4; i++) {
        const c = CORNERS[i];
        fSusp[i] = clamp(fSusp[i], -F_SUSP_MAX_N, F_SUSP_MAX_N);
        const geo = c.front ? geoF : geoR;
        fz[i] = this.suspComp[i] > 0
          ? clamp(fSusp[i] + mUn * gEffN - c.left * geo + c.fwd * geoP, 0, F_SUSP_MAX_N)
          : 0;
        this.suspFz[i] = fz[i];
        if (this.suspComp[i] <= 0) continue;
        const compRef = this.suspComp0[i] + heaveG + c.fwd * pitchShare;
        const fRef = compRef > 0
          ? clamp(springBump(compRef, p.cornerSpring[i],
            this.suspComp0[i] + p.bumpGapM[i], p.bumpGapM[i], p.bumpRateNpm3),
          -F_SUSP_MAX_N, F_SUSP_MAX_N)
          : 0;
        /* reference share at a roll-neutral point (y = 0: full vertical
           support + pitch arm, zero roll arm); deviation share at the
           corner (full roll/pitch/yaw arms). Unsprung column rides the
           reference. Tires never pull: floor the roll-neutral share. */
        const refF = Math.max(0, fRef + mUn * gEffN);
        const devF = fSusp[i] - fRef;
        if (refF !== 0) {
          applyForce([wheelRB[i][0], 0, -hCG], [n[0] * refF, n[1] * refF, n[2] * refF]);
        }
        if (devF !== 0) {
          applyForce(wheelRB[i], [n[0] * devF, n[1] * devF, n[2] * devF]);
        }
      }
      this.lastFz = fz;

      /* ---- aero: the full 3D panel wrench. The flow is naturally track-
         relative on grades/banking because the BODY is really tilted there
         now — qRotInv puts the descent rate back along body-x, exactly what
         the old driving-plane evaluation approximated. */
      const vAirW = [vel[0] - (p.windX || 0), vel[1] - (p.windY || 0), vel[2]];
      /* GRIP-regime flow replicates the calibrated split-solver contract
         EXACTLY: driving-plane flow + the SPRUNG pitch AoA only (vB[2] =
         u·sin(bodyPitch); roll and the aero-torque-fed attitude stay OUT of
         the flow — that feedback loop bled ~800 N of rear downforce mid-
         corner and flipped the tuned balance to push). The TRUE-attitude
         flow fades in with airShare, so crests, jumps and blowovers keep
         the full 3D aero. Rotational aero sees yaw rate only on the ground
         (old contract) — full rates in flight. */
      const vBT = qRotInv(q, vAirW);
      let vB = vBT;
      let wbAero = wb;
      if (airShare < 1) {
        const qS = composeRenderQuat(up, this.yaw, 0, 0);
        const vBS = qRotInv(qS, vAirW);
        vBS[2] = vBS[0] * (this.bodyPitch || 0);
        vB = [vBS[0] + (vBT[0] - vBS[0]) * airShare,
          vBS[1] + (vBT[1] - vBS[1]) * airShare,
          vBS[2] + (vBT[2] - vBS[2]) * airShare];
        wbAero = [wb[0] * airShare, wb[1] * airShare, wb[2]];
      }
      const speed3 = Math.hypot(vB[0], vB[1], vB[2]);
      const betaAir = Math.hypot(vB[0], vB[1]) > 2 ? Math.atan2(vB[1], vB[0]) : 0;
      updateCarFlapSwing(this, h, upB0, betaAir, speed3);
      const cgGap = (cg[0] - ctx.px) * n[0] + (cg[1] - ctx.py) * n[1]
        + (cg[2] - ctx.zSurf) * n[2];
      const geGate = clamp(1 - Math.max(0, cgGap - p.cgHeight) / 1.8, 0, 1);
      const aero = panelAero(vB, wbAero, {
        rho: p.airDensity, cgH: p.cgHeight, ge: geGate,
        flaps: this.flapsDeployed && !!p.employRoofFlaps && !this._blowoverTest,
        dmg,
        flapsEffective: !!p.flapsPresent && !!p.employRoofFlaps && !this._blowoverTest,
        spoilerDeg: p.spoilerDeg, panels: this.aeroPanels || undefined,
        dragScale: p.dragScale,
      });
      this._liftMag = aero.lift;
      const aeroScale = 1 + (AIR_AERO_SCALE - 1) * airShare;
      const fB = [aero.f[0] * aeroScale, aero.f[1] * aeroScale, aero.f[2] * aeroScale];
      /* the aero ROLL moment is a LIFT-regime effect (blowover prelean), same
         gate the split solver used: in the grip regime the panel side-wash
         roll couple stays out of the springs — it systematically loaded the
         outside front in corners and pushed the tuned balance tight. Faded
         back in as the wheels unload (flight keeps the full wrench). */
      const rollGate = Math.max(clamp(aero.f[2] / AERO_ROLL_GATE_N, 0, 1), airShare);
      const tqAcc = [aero.t[0] * aeroScale * rollGate,
        aero.t[1] * aeroScale, aero.t[2] * aeroScale];
      /* blowover slider: scale the LIFT-regime wrench (net positive lift =
         reversed/spun flow); normal downforce untouched. Replaces the old
         explicit pivot — blowovers are emergent now. */
      const bs = p.blowoverScale || 1;
      if (bs !== 1 && aero.f[2] > 0) {
        fB[2] *= bs; tqAcc[0] *= bs; tqAcc[1] *= bs;
      }
      /* CoP leverage: the panel wrench is CG-referenced and cannot see the
         underbody centre-of-pressure migration that makes a backwards car
         pivot (the exact reason the old split solver needed an explicit
         pivot). Re-add it physically: the net positive lift acts at the
         into-wind end with the arm that reproduces the old pivot threshold
         semantics — at lift == the old blowThresh the pitch moment matches
         the weight moment about the pivot axle, past it the flip DEVELOPS
         instead of firing. fB[2] is already blowoverScale-scaled, so the
         slider carries through. Broadside slides get the roll (XLIFT) share. */
      if (fB[2] > 0 && speed3 > 15) {
        const spB = Math.hypot(vB[0], vB[1]) || 1;
        const shareU = Math.abs(vB[0]) / spB;
        const shareV = Math.abs(vB[1]) / spB;
        tqAcc[1] += -sign(vB[0]) * (halfWB / BLOWOVER_LIFT_FRAC) * fB[2] * shareU;
        tqAcc[0] += sign(vB[1]) * (halfTW / BLOWOVER_LIFT_FRAC) * fB[2] * shareV;
      }
      const fW = qRot(q, fB);
      vel[0] += (fW[0] / m) * h;
      vel[1] += (fW[1] / m) * h;
      /* gravity: the flight feel calibration fades in as the wheels unload */
      vel[2] += (fW[2] / m - G * (1 + (AIR_GRAV_SCALE - 1) * airShare)) * h;

      /* rolling resistance along the in-plane forward axis (fwdP/leftP
         computed with the gravity projections above) */
      const rollDrag = surf && typeof surf.rollDrag === 'number' ? surf.rollDrag : 1;
      let fRR = 0;
      if (Math.abs(this.u) > 0.05 && loadedN > 0) {
        fRR = -p.rollingResist * rollDrag * w * sign(this.u);
        vel[0] += (fwdP[0] * fRR / m) * h;
        vel[1] += (fwdP[1] * fRR / m) * h;
        vel[2] += (fwdP[2] * fRR / m) * h;
      }

      /* ---- drivetrain + aids (transplanted intact from the split solver) */
      const gearRatio = p.gearRatios[this.gear];
      const totalRatio = gearRatio * p.finalDrive;
      let engineThrottle = this.throttle;
      if (this.reverseReq && (this.gear !== 0 || this.u > REV_STOP_U_MPS)) engineThrottle = 0;
      else if (!this.reverseReq && this.gear === 0 && this.u < -REV_STOP_U_MPS) engineThrottle = 0;
      const drivenOmega = (this.wheelOmega[2] + this.wheelOmega[3]) * 0.5;
      const wheelRpm = Math.abs(drivenOmega * totalRatio) * (60 / (2 * Math.PI));
      let rpmCmd = Math.max(wheelRpm, p.idleRpm);
      if (engineThrottle > 0.04) {
        const throttleRpm = p.idleRpm + engineThrottle * (p.redlineRpm - p.idleRpm);
        const couple = clamp(speed / 12, 0, 1);
        rpmCmd = Math.max(wheelRpm, throttleRpm * (1 - couple * 0.35) + wheelRpm * couple * 0.35);
      } else if (this.brake < 0.05) {
        rpmCmd = Math.max(wheelRpm, p.idleRpm);
      }
      const rpmSlew = engineThrottle > 0.04 ? p.clutchSlipUpRpmS
        : (this.brake > 0.5 ? p.clutchSlipUpRpmS * 5 : p.clutchSlipUpRpmS * 2.5);
      this.rpm += clamp(rpmCmd - this.rpm, -rpmSlew * 2 * h, rpmSlew * h);
      this.rpm = clamp(this.rpm, p.idleRpm, p.redlineRpm);
      this._autoShift(h);
      let limited = engineThrottle;
      if (this.reverseReq && this.gear !== 0) limited = 0;
      const prevRearSlip = Math.max(Math.abs(this.lastSlip[2]), Math.abs(this.lastSlip[3]));
      const rawBurnout = !lockUp && engineThrottle > 0.35 && (
        prevRearSlip > 0.35
        || (this.throttle > 0.3 && this.brake > 0.25 && speed < 12));
      if (rawBurnout) this._burnoutHold = BURNOUT_HOLD_S;
      else this._burnoutHold = Math.max(0, (this._burnoutHold || 0) - h);
      const inBurnout = rawBurnout || (engineThrottle > 0.35 && this._burnoutHold > 0);
      if (p.tractionControl && limited > 0 && speed > p.tcMinSpeed && !inBurnout) {
        const rearSlip = Math.max(this.lastSlip[2], this.lastSlip[3]);
        if (rearSlip > p.tcSlipThreshold) {
          limited *= clamp(1 - (rearSlip - p.tcSlipThreshold) * 8, 0.15, 1);
        }
      }
      let ebScale = 1;
      const betaBody = speed > 2 ? Math.atan2(this.v, this.u) : 0;
      if (p.stabilityControl) {
        ebScale = 1 / (1 + Math.abs(this.steer) * 1.8);
        if (limited > 0 && speed > 6 && Math.abs(betaBody) > 0.35 && !inBurnout) {
          limited *= clamp(1 - (Math.abs(betaBody) - 0.35) * 2.2, 0.4, 1);
        }
      }
      const idleLoad = (p.idleRpm / Math.max(this.rpm, p.idleRpm)) * ENGINE_IDLE_LOAD_NM;
      const ebBurnout = inBurnout ? 0.15 : 1;
      const tqEngine = (engineTorqueGross(this.rpm) - idleLoad) * limited * (1 - 0.3 * dmg) * p.powerScale * (p.enginePowerMul ?? p.playerPowerMul ?? 1)
        + idleLoad - engineBrakeTorque(this.rpm) * ebScale * ebBurnout;
      const clutch = engineThrottle < 0.04
        ? (speed < 0.2 ? 0 : clamp((speed - 0.2) / 0.4, 0, 1))
        : 1;
      let driveGate = 1;
      if (this.reverseReq && this.gear !== 0) driveGate = 0;
      else if (!this.reverseReq && this.gear === 0) driveGate = 0;
      else if (this.reverseReq && this.gear === 0 && this.u > REV_STOP_U_MPS) driveGate = 0;
      const driveTorque = tqEngine * totalRatio * p.driveEff * clutch * driveGate;
      let revBrake = 0;
      if (this.reverseReq && this.gear !== 0) revBrake = 1;
      const brakeTotal = Math.max(this.brake, revBrake) * p.brakeTorqueMax;
      let brakeFront = brakeTotal * p.brakeBiasFront / 2;
      let brakeRear = brakeTotal * (1 - p.brakeBiasFront) / 2;
      if (lockUp) {
        const qw2 = brakeTotal * 0.25;
        brakeFront = qw2;
        brakeRear = qw2;
      } else if (inBurnout && this.brake > 0.25) brakeRear = 0;

      /* ---- per-wheel slip + tire force, applied AT the contact points ----
         Force heights scaled by the SPRUNG share ms/m: the unsprung mass's
         lateral/longitudinal reaction loads the tires at road level without
         rolling the chassis (the old travel-space solver used ms for the
         couple; a rigid body carrying all 1543 kg overshoots the roll couple
         ~11% and flips the tuned handling balance toward push). */
      let FxT = 0, FyT = 0;
      const zLong = -hCG * (1 - antiFrac) * msFrac;
      /* both axles couple through zLatAvg (defined with the geo shares):
         the axle SPLIT of the couple falls out of spring/bar stiffness
         alone, exactly like the old rollTq integrator */
      const zLatF = zLatAvg;
      const zLatR = zLatAvg;
      const radii = [p.wheelRadius, p.wheelRadius,
        p.wheelRadius - p.rearStaggerM / 2, p.wheelRadius + p.rearStaggerM / 2];
      let rearReactTorque = 0;
      let rearAtRest = true;
      const fzTot = fz[0] + fz[1] + fz[2] + fz[3] || 1;
      for (let i = 0; i < 4; i++) {
        const c = CORNERS[i];
        const px = c.fwd * halfWB, py = c.left * halfTW;
        const vlong = this.u - this.r * py;
        const vlat = this.v + this.r * px;
        const delta = c.front ? this.steer : 0;
        const cd = Math.cos(delta), sd = Math.sin(delta);
        const wLong = vlong * cd + vlat * sd;
        const wLat = -vlong * sd + vlat * cd;
        const brakeMag0 = c.front ? brakeFront : brakeRear;
        if (c.front) {
          if (lockUp) {
            this.wheelOmega[i] = 0;
          } else {
            const rollOmega = wLong / radii[i];
            const brakePed = Math.max(this.brake, revBrake);
            let lock = brakeMag0 > 0 ? clamp(brakePed, 0, 1) : 0;
            if (p.absBrakes && Math.abs(wLong) > p.absMinSpeed) {
              lock = Math.min(lock, p.absSlipThreshold);
            }
            this.wheelOmega[i] = rollOmega * (1 - lock);
          }
        }
        const slipAngle = Math.atan2(wLat, Math.abs(wLong) + 0.5);
        this.slipIntegrator[i] = slipAngle;
        const wheelSurfSpeed = this.wheelOmega[i] * radii[i];
        const denom = Math.max(Math.abs(wLong), 0.25);
        let slipRatio = (wheelSurfSpeed - wLong) / denom;
        slipRatio = clamp(slipRatio, -1.5, 1.5);
        this.lastSlip[i] = slipRatio;
        const f = tireForce(slipRatio, slipAngle, fz[i], gripScale, c.front, i, delta,
          wLong, wLat, p, surfClass, wheelSurfSpeed);
        const slipVx = wLong - wheelSurfSpeed;
        const treadSlipSpd = Math.hypot(slipVx, wLat);
        this.lastSlideSpd[i] = fz[i] > 1 ? treadSlipSpd : 0;
        const patchSpd = Math.hypot(wLong, wLat);
        if (treadSlipSpd < STICK_SPEED_MPS && patchSpd < STICK_SPEED_MPS && fz[i] > 1) {
          const mShare = p.mass * fz[i] / fzTot;
          const gWLong = gFwd * cd + gLeft * sd;
          const gWLat = -gFwd * sd + gLeft * cd;
          const braked = brakeMag0 > 1;
          const driveRelief = braked ? 1 : clamp(1 - this.throttle * 1.5, 0, 1);
          const holdFy = -mShare * (gWLat + wLat * STICK_DAMP * driveRelief);
          const holdFx = braked ? -mShare * (gWLong + slipVx * STICK_DAMP) : f.fx;
          const cap = p.muBase * gripScale * loadSaturation(fz[i], p) * fz[i];
          const mag = Math.hypot(holdFx, holdFy);
          const scale = mag > cap ? cap / mag : 1;
          f.fx = holdFx * scale;
          f.fy = holdFy * scale;
        }
        let brakeMag = brakeMag0;
        if (p.absBrakes && !lockUp && brakeMag > 0 && Math.abs(wLong) > p.absMinSpeed
            && slipRatio < -p.absSlipThreshold) {
          brakeMag *= clamp(1 - (-slipRatio - p.absSlipThreshold) * 8, 0.05, 1);
        }
        const brakeRef = Math.abs(wLong) > 0.12 ? wLong : (this.wheelOmega[i] || wLong || 1);
        const brakeT = brakeMag * -sign(brakeRef);
        if (!c.front) {
          rearReactTorque += brakeT - f.fx * radii[i];
          if (Math.abs(wLong) >= 0.3) rearAtRest = false;
        }
        const bfx = f.fx * cd - f.fy * sd;
        const bfy = f.fx * sd + f.fy * cd;
        FxT += bfx;
        FyT += bfy;
        if (fz[i] > 0.5) {
          /* longitudinal share LOW on the body (anti-dive/anti-squat link
             geometry), lateral share at the axle's roll-center height —
             keeps the tuned transient load-transfer arms of the old
             travel-space suspension */
          applyForce([px, py, zLong],
            [fwdP[0] * bfx, fwdP[1] * bfx, fwdP[2] * bfx]);
          applyForce([px, py, c.front ? zLatF : zLatR],
            [leftP[0] * bfy, leftP[1] * bfy, leftP[2] * bfy]);
        }
      }
      this._tireFxN = FxT;
      /* FUN_0054cab0 Step 9 — front steer moment, about the surface normal */
      if (Math.abs(this.steer) > 0.01 && speed > 2) {
        const fl = Math.max(fz[0], 200);
        const aux = Math.sqrt(fl * p.wheelbase * 0.5);
        const sm = STEER_MOM_A * STEER_MOM_B;
        const mzSteer = -sm * Math.sqrt(fl * aux) * this.steer;
        const tqB = qRotInv(q, [n[0] * mzSteer, n[1] * mzSteer, n[2] * mzSteer]);
        tqAcc[0] += tqB[0]; tqAcc[1] += tqB[1]; tqAcc[2] += tqB[2];
      }
      /* locked rear axle: full drive torque + both wheels' reactions on one
         shared ω (verbatim, incl. the over-rev torque governor) */
      {
        const omegaMax = (p.redlineRpm * RPM_TO_RADS) / Math.abs(totalRatio || 1);
        const omegaPrev = this.wheelOmega[2];
        const govFade = clamp((omegaMax - Math.abs(omegaPrev))
          / (omegaMax * GOV_FADE_FRAC), 0, 1);
        const drive = driveTorque > 0 ? driveTorque * govFade : driveTorque;
        const over = Math.abs(omegaPrev) - omegaMax;
        const overT = over > 0 ? -sign(omegaPrev) * OVERREV_NMS * over : 0;
        let omega = omegaPrev +
          ((drive + overT + rearReactTorque) / (2 * p.wheelInertia)) * h;
        omega = clamp(omega, -omegaMax * 1.25, omegaMax * 1.25);
        if (lockUp) {
          omega = 0;
        } else if (Math.abs(omega) < 0.15 && engineThrottle < 0.05 && rearAtRest
            && speed < 0.2) {
          omega = 0;
        }
        this.wheelOmega[2] = omega;
        this.wheelOmega[3] = omega;
      }
      /* reported body accels (geo-share targets next substep, HUD) — same
         composition the planar solver reported */
      this.ax = (FxT + fB[0] + fRR) / m + gFwd;
      this.ay = (FyT + fB[1]) / m + gLeft;

      /* ---- low-speed housekeeping (the f167 rest fixes), applied to the
         canonical state through the plane basis ---- */
      let uL = vel[0] * cy + vel[1] * sy;
      let vL = -vel[0] * sy + vel[1] * cy;
      const wWh = qRot(q, wb);
      let rL = wWh[2];
      let planarDirty = false;
      if (this.reverseReq && this.gear === 0 && this.throttle > 0.05 && Math.abs(uL) < 3) {
        const k = Math.min(1, h * 14);
        vL *= (1 - k);
        rL *= (1 - k * 0.85);
        planarDirty = true;
      }
      const slopePull = Math.hypot(gip[0], gip[1], gip[2]);
      const canHoldStill = p.muBase * gripScale * G * clamp(up[2], 0, 1) > slopePull;
      if (canHoldStill && this.throttle < 0.04 && this.brake < 0.04
          && Math.hypot(uL, vL) < 0.12 && (!this.reverseReq || this.gear === 0)) {
        const hold = Math.max(0, 1 - h * 3.5);
        uL *= hold; vL *= hold; rL *= hold;
        if (Math.hypot(uL, vL) < 0.025) { uL = 0; vL = 0; rL = 0; this.wheelOmega = [0, 0, 0, 0]; }
        planarDirty = true;
      }
      const braking = this.brake > 0.4 || (this.reverseReq && this.gear !== 0)
        || (!this.reverseReq && this.gear === 0 && uL < -0.03);
      const dirFlip = braking && (
        (this.reverseReq && uL > 0.03) || (!this.reverseReq && uL < -0.03));
      if (canHoldStill && dirFlip && Math.hypot(uL, vL) < 0.5 && !inBurnout) {
        const snap = 1 - h * 30;
        uL *= snap; vL *= snap; rL *= snap;
        if (Math.hypot(uL, vL) < 0.03) {
          uL = 0; vL = 0; rL = 0;
          this.wheelOmega = [0, 0, 0, 0];
        }
        planarDirty = true;
      }
      if (canHoldStill && this.reverseReq && this.gear !== 0 && this.brake > 0.4
          && Math.hypot(uL, vL) < 0.25) {
        const bleed = Math.max(0, 1 - h * 30);
        uL *= bleed; vL *= bleed; rL *= bleed;
        if (Math.hypot(uL, vL) < 0.02) {
          uL = 0; vL = 0; rL = 0;
          this.wheelOmega = [0, 0, 0, 0];
        }
        planarDirty = true;
      }
      if (planarDirty) {
        vel[0] = uL * cy - vL * sy;
        vel[1] = uL * sy + vL * cy;
        const dRz = rL - wWh[2];
        if (Math.abs(dRz) > 1e-12) {
          const addB = qRotInv(q, [0, 0, dRz]);
          wb[0] += addB[0]; wb[1] += addB[1]; wb[2] += addB[2];
        }
      }

      /* ---- contact backstop: sequential impulses, zero restitution ----
         Bodywork always (gated by how body-down the car is); wheels only
         BEYOND the suspension's travel (bottoming/tunneling guard — springs
         own normal driving and landings). Verbatim flight-solver contacts. */
      const mu = p.muBase * (ctx.grip != null ? ctx.grip : 1);
      const muDig = p.muBase * (ctx.dig != null ? ctx.dig : (ctx.grip != null ? ctx.grip : 1));
      const upBody = qRot(q, [0, 0, 1]);
      const align = upBody[0] * n[0] + upBody[1] * n[1] + upBody[2] * n[2];
      const bodyGate = clamp((BODY_GATE_UPRIGHT - align)
        / (BODY_GATE_UPRIGHT - BODY_GATE_DOWN), 0, 1);
      const wheelMuLat = mu + (muDig - mu) * bodyGate;
      let bodyContacts = 0, deepestBody = 0, deepestWheel = 0;
      for (let i = 0; i < 4; i++) {
        const rB = wheelRB[i];
        const rW = qRot(q, rB);
        const pt = [cg[0] + rW[0], cg[1] + rW[1], cg[2] + rW[2]];
        const penBack = -gapOf(pt)
          - (this.suspComp0[i] + p.bumpGapM[i] + WHEEL_BACKSTOP_XTRA);
        if (penBack <= 0) continue;
        deepestWheel = Math.max(deepestWheel, penBack);
        const vp = pointVel(rW);
        const vn = vp[0] * n[0] + vp[1] * n[1] + vp[2] * n[2];
        if (vn >= 0) continue;
        const vnArrest = Math.max(vn, -WHEEL_VN_ARREST_SUB);
        const jn = -vnArrest * effMass(rB, n);
        applyImp(rB, [jn * n[0], jn * n[1], jn * n[2]]);
        const vp2 = pointVel(rW);
        const vn2 = vp2[0] * n[0] + vp2[1] * n[1] + vp2[2] * n[2];
        const vt = [vp2[0] - vn2 * n[0], vp2[1] - vn2 * n[1], vp2[2] - vn2 * n[2]];
        const vtLen = Math.hypot(vt[0], vt[1], vt[2]);
        if (vtLen > 1e-3) {
          const tHat = [vt[0] / vtLen, vt[1] / vtLen, vt[2] / vtLen];
          const jt = Math.min(WHEEL_AIR_MU_LAT * wheelMuLat * jn, effMass(rB, tHat) * vtLen);
          applyImp(rB, [-jt * tHat[0], -jt * tHat[1], -jt * tHat[2]]);
        }
      }
      const bodyMu = BODY_GRIP_MU * (ctx.dig != null ? ctx.dig : (ctx.grip != null ? ctx.grip : 1));
      if (bodyGate > 0) for (const bp of this.bodyPts) {
        const rB = [bp[0], bp[1], bp[2] - hCG];
        const rW = qRot(q, rB);
        const pw = [cg[0] + rW[0], cg[1] + rW[1], cg[2] + rW[2]];
        const pen = -gapOf(pw);
        if (pen <= 0) continue;
        bodyContacts++;
        deepestBody = Math.max(deepestBody, pen);
        const vp = pointVel(rW);
        const vn = vp[0] * n[0] + vp[1] * n[1] + vp[2] * n[2];
        if (vn >= 0) continue;
        const jn = -vn * effMass(rB, n) * bodyGate;   /* e = 0 — heavy, no bounce */
        applyImp(rB, [jn * n[0], jn * n[1], jn * n[2]]);
        const vp2 = pointVel(rW);
        const vn2 = vp2[0] * n[0] + vp2[1] * n[1] + vp2[2] * n[2];
        const vt = [vp2[0] - vn2 * n[0], vp2[1] - vn2 * n[1], vp2[2] - vn2 * n[2]];
        const vtLen = Math.hypot(vt[0], vt[1], vt[2]);
        if (vtLen > 1e-3) {
          const tHat = [vt[0] / vtLen, vt[1] / vtLen, vt[2] / vtLen];
          const jt = Math.min(bodyMu * jn, effMass(rB, tHat) * vtLen);
          applyImp(rB, [-jt * tHat[0], -jt * tHat[1], -jt * tHat[2]]);
        }
        if (jn > 4000) this.addDamage(jn / 90000);
      }
      /* positional correction — only the excess past the backstop depth for
         wheels; full penetration for bodywork */
      const deepest = Math.max(deepestWheel, deepestBody);
      if (deepest > 0) {
        const push = Math.min(deepest * CONTACT_DEPEN, CONTACT_DEPEN_MAX);
        cg[0] += n[0] * push;
        cg[1] += n[1] * push;
        cg[2] += n[2] * push;
      }

      /* landing catch: while the regrip window is open and rubber is on the
         road, the chassis pitch/roll RATES are damped directly — the see-saw
         whip of a nose-first catch (front axle arrests, rear whips down,
         rock-through re-launches the car) has a phase where only ONE axle
         touches and the corner dampers can't see the rotation. Represents
         the tire-carcass/geometry compliance a point-contact model misses. */
      if (loadedN > 0 && (this._regripT > 0 || this.airborne)) {
        tqAcc[0] -= LAND_ANG_DAMP_NMS * wb[0];
        tqAcc[1] -= LAND_ANG_DAMP_NMS * wb[1];
      }
      /* ---- integrate rotation (Euler equations + faded exe damping) ---- */
      wb[0] += ((tqAcc[0] - (Iz - Iy) * wb[1] * wb[2]) / Ix) * h;
      wb[1] += ((tqAcc[1] - (Ix - Iz) * wb[2] * wb[0]) / Iy) * h;
      wb[2] += ((tqAcc[2] - (Iy - Ix) * wb[0] * wb[1]) / Iz) * h;
      const angD = Math.pow(AIR_ANG_DAMP, h * AIR_DAMP_HZ * airShare);
      wb[0] = clamp(wb[0] * angD, -AIR_MAX_ANG, AIR_MAX_ANG);
      wb[1] = clamp(wb[1] * angD, -AIR_MAX_ANG, AIR_MAX_ANG);
      wb[2] = clamp(wb[2] * angD, -AIR_MAX_ANG, AIR_MAX_ANG);
      const dq = qMul(q, [0, wb[0] * 0.5 * h, wb[1] * 0.5 * h, wb[2] * 0.5 * h]);
      q = qNorm([q[0] + dq[0], q[1] + dq[1], q[2] + dq[2], q[3] + dq[3]]);

      /* ---- integrate position, write back the interface state ---- */
      cg[0] += vel[0] * h;
      cg[1] += vel[1] * h;
      cg[2] += vel[2] * h;
      const upB = qRot(q, [0, 0, 1]);
      this.x = cg[0] - upB[0] * hCG;
      this.y = cg[1] - upB[1] * hCG;
      this._cgZ = cg[2];
      const bodyZG = loadedN > 0 ? clamp(compDeltaSum / loadedN, -0.2, 0.2) : 0;
      this.bodyZ = bodyZG;
      this.bodyZv = loadedN > 0 ? clamp(compVelSum / loadedN, -6, 6) : 0;
      /* zPos rides AT the tyre-contact plane while loaded (compression goes
         to bodyZ/heave, so the render composition is unchanged) and is the
         free rigid anchor in flight — continuous across both */
      this.zPos = cg[2] - upB[2] * (hCG - bodyZG);
      this._zPosEcho = this.zPos;
      this.vz = vel[2];
      this.qw = q[0]; this.qx = q[1]; this.qy = q[2]; this.qz = q[3];
      this.wbx = wb[0]; this.wby = wb[1]; this.wbz = wb[2];
      const e = qToYPR(q);
      this.yaw = lerpAngle(this._yawEcho != null ? this._yawEcho : this.yaw, e.yaw, 1);
      this._yawEcho = this.yaw;
      this.attPitch = e.pitch;
      this.attRoll = e.roll;
      this._attPitchEcho = this.attPitch;
      this._attRollEcho = this.attRoll;
      this.attPitchV = wb[1];
      this.attRollV = wb[0];
      const wWorld = qRot(q, wb);
      this.r = clamp(wWorld[2], -8, 8);
      this._rEcho = this.r;
      this.u = vel[0] * Math.cos(this.yaw) + vel[1] * Math.sin(this.yaw);
      this.v = -vel[0] * Math.sin(this.yaw) + vel[1] * Math.cos(this.yaw);
      const loadRaw = clamp((fz[0] + fz[1] + fz[2] + fz[3]) / (m * G), 0, 1);
      this._loadFrac = this._loadFrac == null ? loadRaw
        : this._loadFrac + (loadRaw - this._loadFrac) * Math.min(1, h / LOADFRAC_TAU);
      this._airContacts = { wheels: loadedN, body: bodyContacts, deepestBody };
    }

    /* per-frame companion of _subUnified: derived labels (airborne /
       onSurface / restingOnBody are LABELS of the one solver's state, not
       modes), the touchdown regrip ramp, and the sprung-pose view the
       renderer/HUD read (bodyPitch/bodyRoll from the true attitude vs the
       surface basis — exact inverse of the render composition). */
    _resolveUnifiedFrame(dt, surf, zSurf) {
      const up = (surf && surf.up) || [0, 0, 1];
      const q = [this.qw, this.qx, this.qy, this.qz];
      const upB = qRot(q, [0, 0, 1]);
      const align = upB[0] * up[0] + upB[1] * up[1] + upB[2] * up[2];
      const c = this._airContacts || { wheels: 0, body: 0 };
      const loaded = c.wheels || 0;
      if (loaded > 0) this._unloadT = 0;
      else this._unloadT = (this._unloadT || 0) + dt;
      const gap = (this.zPos == null ? zSurf : this.zPos) - zSurf;
      const wasAirborne = this.airborne;
      if (!this.airborne) {
        /* debounced label for ordinary bumps; a DECISIVE gap with zero
           wheel load (cliff, big crest) is flight the same frame. A car
           still in its regrip window just landed — its residual rebound
           can lick past the normal gap without being a new flight. */
        const gapMin = this._regripT > 0 ? AIR_REGRIP_GAP_M : AIR_MIN_GAP_M;
        if ((this._unloadT > AIR_LABEL_T && gap > gapMin)
            || (loaded === 0 && gap > AIR_NOW_GAP_M)) this.airborne = true;
      } else {
        const tumbleRate = Math.hypot(this.wbx, this.wby);
        if (loaded >= 2 && align > LAND_ALIGN_MIN
            && Math.abs(gap) < LAND_LABEL_GAP_M
            && Math.abs(this.bodyZ || 0) < LAND_LABEL_HEAVE_M) this.airborne = false;
        else if (loaded >= 1 && align > LAND_ONE_WHEEL_ALIGN
            && tumbleRate < LAND_ONE_WHEEL_TUMBLE
            && Math.abs(gap) < LAND_ONE_WHEEL_GAP_M) this.airborne = false;
      }
      if (this.airborne) {
        this._airT = (this._airT || 0) + dt;
      } else if (wasAirborne) {
        /* touchdown: tires earn their grip back over the regrip ramp,
           scaled by real flight time (a micro-hop costs almost nothing) */
        this._regripT = REGRIP_S * clamp((this._airT || 0) / REGRIP_FULL_AIR_S, 0.1, 1);
        this._airT = 0;
      }
      /* resting label — hysteresis only, the solver keeps owning the motion */
      const angR = Math.hypot(this.wbx, this.wby, this.wbz);
      if (this.restingOnBody) {
        if (this.speed > REST_SPEED_MAX * 2 || angR > REST_ANG_MAX * 2
            || ((c.wheels || 0) === 0 && (c.body || 0) === 0)) {
          this.restingOnBody = false;
        } else if (align > LAND_ALIGN_MIN && loaded >= 2) {
          this.restingOnBody = false;   /* rolled back onto its wheels */
        }
      } else if (this.airborne && (c.body || 0) >= 2 && this.speed < REST_SPEED_MAX
          && Math.abs(this.vz - (this._vzSurfSm || 0)) < 1.0
          && angR < REST_ANG_MAX && align < REST_ALIGN_MAX) {
        this.restingOnBody = true;
      }
      /* onSurface keeps the old ballistic-band nuance: it means "the tyre
         plane CARRIES the car" (render anchors to the road), not merely
         "a wheel is touching". As a crest progressively unloads the springs
         the viewer's max(z, surface) anchor takes over smoothly instead of
         popping the whole accumulated gap at the airborne flip. */
      const carrying = this._loadFrac == null || this._loadFrac > ONSURF_LOAD_MIN;
      this.onSurface = !this.airborne && loaded > 0 && carrying;
      this._contactFade = this._loadFrac == null ? 1 : this._loadFrac;
      /* sprung-pose view for the renderer/HUD (grounded render path) */
      const dpr = decomposeSurfPR(q, up, this.yaw);
      /* clamp must cover every attitude the landing label admits
         (LAND_ALIGN_MIN 0.80 ≈ 37°, tan ≈ 0.75) or the flip frame snaps
         the rendered pitch — the true pose IS the render pose now */
      this.bodyPitch = clamp(Math.tan(dpr.pitch), -0.75, 0.75);
      /* sign contract: the OLD solver reports +bodyRoll for the outward
         lean in a left turn (measured old +1.4° vs true attitude +1.54°);
         -tan(dpr.roll) inverted it and the render leaned INTO the corner */
      this.bodyRoll = clamp(Math.tan(dpr.roll), -0.75, 0.75);
      this.bodyPitchV = clamp(this.wby, -6, 6);
      this.bodyRollV = clamp(this.wbx, -6, 6);
      if (this.restingOnBody) this._crashSettle(dt);
      if (this._blowoverTest && this.speed < BLOWOVER_MIN_MPS
          && (this.restingOnBody || !this.airborne)) {
        this._blowoverTest = false;
      }
    }

    /* rest pose: lowest contact point (wheels + physical body corners) of
       the current attitude sits BODY_GROUND_GAP over the ground; returns the
       tyre-plane lift (zPos − zSurf).

       SLOPE-AWARE: the deepest point rests on the LOCAL ground PLANE — the one
       through the surface sample with normal `up`, i.e. the SAME plane the
       substep contact solver uses (gapOf: (pt−ref)·up). The old formula rested
       every point on a phantom HORIZONTAL plane at the CG's height (maxDrop of
       -(R·p).z). That is exact on the level, but on banked/sloped track a
       wrecked car's wide sideways footprint spans ground that drops away
       downhill, and the horizontal-plane rest floated the resting car up to
       ~1.6 m over the real surface — then restingOnBody FROZE it there (the
       "car finishes settling, lifts off by itself and levitates" bug). At the
       captured Daytona wreck pose (upBz −0.641 on 31° banking) that was
       29–126 cm of phantom lift depending on yaw. up defaults to world-up, so
       this is byte-identical to the old formula on level ground (and for the
       no-surface test callers). Derivation: with the point set fixed, gap of
       point i vs the plane is B_i + (zPos−zSurf)·uz where B_i is q/up-only;
       resting the deepest point at GAP gives (GAP − min_i B_i)/uz. */
    _restLift(q, up) {
      const p = this.p, hCG = p.cgHeight;
      const halfWB = p.wheelbase / 2, halfTW = p.trackWidth / 2;
      const pts = [];
      for (const c of CORNERS) pts.push([c.fwd * halfWB, c.left * halfTW, -hCG]);
      for (const pt of this.bodyPts) pts.push([pt[0], pt[1], pt[2] - hCG]);
      const upB = qRot(q, [0, 0, 1]);
      const ux = up ? up[0] : 0;
      const uy = up ? up[1] : 0;
      const uz = up ? Math.max(up[2], 0.2) : 1;   /* floor matches the solver's airCtx.uz */
      let minB = Infinity;
      for (const rB of pts) {
        const w = qRot(q, rB);
        /* offset of this point from the surface reference (px,py,zSurf): the
           CG sits upB·hCG off the tyre-plane anchor, the point sits w off the CG */
        const ox = w[0] + upB[0] * hCG;
        const oy = w[1] + upB[1] * hCG;
        const B = ox * ux + oy * uy + (w[2] + upB[2] * hCG) * uz;
        if (B < minB) minB = B;
      }
      return (BODY_GROUND_GAP_M - minB) / uz;
    }

    /* airborne → ground decisions (per frame). The actual contact FORCES run
       inside the substeps (_subAirborne): wheels on penalty spring-dampers,
       body corners on the exe object bounce. Here: hand the car back to the
       planar ground model once it has settled wheels-down, or freeze it into
       the body-rest slide once a body-down tumble has died. */
    _airResolveContact(surf, zSurf, vzSurf, dt) {
      const up = (surf && surf.up) || [0, 0, 1];
      const q = [this.qw, this.qx, this.qy, this.qz];
      const upB = qRot(q, [0, 0, 1]);
      const align = upB[0] * up[0] + upB[1] * up[1] + upB[2] * up[2];
      /* exact touchdown residual: what local pitch/roll on TODAY'S surface
         basis reproduces the flight attitude (the Euler-view difference
         drifted by degrees when bank and grade combined — visible snap) */
      const dpr = decomposeSurfPR(q, up, this.yaw);
      const dPitch = dpr.pitch;
      const dRoll = dpr.roll;

      if (this.restingOnBody) {
        /* restingOnBody is a LABEL, not a physics mode — the contact solver
           keeps holding the car every substep (gravity, impulses, friction),
           so a resting car can always be nudged, slide, or roll. Here: drop
           the label if the car is genuinely moving again (kicked, sliding,
           knocked clear), or hand off to the ground model once it has rolled
           back near wheels-down (the old _bodySlideOnGround recovery tail). */
        const cR = this._airContacts || { wheels: 0, body: 0 };
        const angR = Math.hypot(this.wbx, this.wby, this.wbz);
        if (this.speed > REST_SPEED_MAX * 2 || angR > REST_ANG_MAX * 2
            || (cR.wheels === 0 && cR.body === 0)) {
          this.restingOnBody = false;   /* moving again — full flight logic resumes */
        } else if (Math.abs(dPitch) < WHEELS_FIRST_PITCH_RAD * 0.55 &&
            Math.abs(dRoll) < WHEELS_FIRST_ROLL_RAD * 0.55) {
          this.airborne = false;
          this.restingOnBody = false;
          this._airActive = false;
          /* rolled back onto the wheels — ramp scaled by real flight time */
          this._regripT = REGRIP_S * clamp((this._airT || 0) / REGRIP_FULL_AIR_S, 0.1, 1);
          this._airT = 0;
          /* attitude continuity through the recovery, same as the landing
             handoff — the springs settle the residual, no snap */
          this.bodyPitch = clamp(Math.tan(dPitch), -0.18, 0.18);
          this.bodyRoll = clamp(-Math.tan(dRoll), -0.22, 0.22);
          this.attPitchV = 0;
          this.attRollV = 0;
          this.wbx = 0; this.wby = 0; this.wbz = 0;
        }
        return;
      }
      if (this._airborneHold > 0) {
        this._airborneHold = Math.max(0, this._airborneHold - dt);
        return;
      }
      const c = this._airContacts || { wheels: 0, body: 0, deepestBody: 0 };
      const angMag = Math.hypot(this.wbx, this.wby, this.wbz);
      /* wheels down, aligned, sink absorbed → back to the ground model (the
         residual seeds the travel-space suspension, clamped so a bottoming
         landing can't explode the spring solver). Upright + not tumbling
         lands from ONE wheel too — see LAND_ONE_WHEEL_ALIGN. */
      const tumbleRate = Math.hypot(this.wbx, this.wby);
      const wheelsSettled = c.wheels >= 2
        || (c.wheels >= 1 && align > LAND_ONE_WHEEL_ALIGN
            && tumbleRate < LAND_ONE_WHEEL_TUMBLE
            && Math.abs(this.zPos - zSurf) < LAND_ONE_WHEEL_GAP_M);
      if (wheelsSettled && align > LAND_ALIGN_MIN) {
        const vnRel = this.vz - vzSurf;
        if (vnRel > -LAND_VN_MAX) {
          this.airborne = false;
          this.restingOnBody = false;
          this._airActive = false;
          /* landed tires earn their grip back — penalty scaled by flight
             time, so a micro-hop costs almost nothing and a real jump the
             full ramp */
          this._regripT = REGRIP_S * clamp((this._airT || 0) / REGRIP_FULL_AIR_S, 0.1, 1);
          this._airT = 0;
          /* HEIGHT CONTINUITY: the wheels land AT the road, but the BODY may
             still be up to ~35 cm above its perch when a fast sink commits
             (tilted crest touchdown catches wheels through the attitude).
             Snapping zPos alone teleported the rendered body down by that
             whole gap in one frame. Hand the residual to the suspension as
             real spring EXTENSION (droop) instead — bodyZ− renders as +heave,
             so the drawn height is identical across the handoff frame and the
             body then settles down onto its springs (droop springs pull
             nothing; it just falls the last bit at g, like a real landing).
             The seeded landing attitude ALREADY lifts the render through
             tiltLift (viewer placeCar / bodyAttitudeExtraLift), so only the
             gap BEYOND that lift goes into the droop — double-counting it
             popped the render UP at the flip instead. */
          const seedPitch = clamp(Math.tan(dPitch), -0.18, 0.18);
          const seedRoll = clamp(-Math.tan(dRoll), -0.22, 0.22);
          const seedLift = bodyAttitudeExtraLift(seedPitch, seedRoll, this.bodyPts);
          const landGap = clamp(this.zPos - zSurf - seedLift, 0, LAND_EXT_MAX_M);
          this.bodyZ = -landGap;
          this.zPos = zSurf;
          this.onSurface = true;
          /* footprint rebuilds over ~70 ms — the touchdown suspension spike
             must not reach the tires in full for a single frame (yaw jerk) */
          this._contactFade = 0.5;
          this._groundHold = LAND_GRACE_S;   /* no re-takeoff on the settle rebound */
          this._pivotCool = PIVOT_REFIRE_S;  /* and no immediate blowover re-fire */
          this.vz = clamp(vzSurf, -SURF_VZ_MAX, SURF_VZ_MAX);
          /* the inelastic wheel contact already killed the sink, so there is
             nothing left in vz to bounce — drive the suspension squat from the
             touchdown closing speed captured during the descent instead */
          this.bodyZv += clamp(this._wheelImpact, 0, MAX_RECAPTURE_VZ) * RECAPTURE_SOFT;
          this._wheelImpact = 0;
          /* attitude continuity: hand the touchdown pitch/roll to the sprung
             body so the rendered attitude is IDENTICAL across the handoff
             frame — the springs then settle it naturally (landing squat)
             instead of the old one-frame snap to the suspension pose */
          this.bodyPitch = seedPitch;
          this.bodyRoll = seedRoll;
          /* residual rotation seeds the suspension for landing FEEL only —
             past ±3 rad/s it explodes the travel-space spring solver (the
             same failure mode as the unclamped heave injection) */
          this.bodyPitchV += clamp(this.wby, -2, 2);
          this.bodyRollV += clamp(-this.wbx, -2, 2);
          this.attPitchV = 0;
          this.attRollV = 0;
          this._liftTimer = 0;
          this._surfPitch = null;
          this._crestPitchV = 0;
          return;
        }
      }
      /* body-down tumble has died → LABEL it resting (render/HUD/recovery
         hysteresis only — the solver keeps owning the motion). ≥2 contact
         points: a one-point balance is not a stable pose, keep watching. */
      if (c.body >= 2 && this.speed < REST_SPEED_MAX
          && Math.abs(this.vz - vzSurf) < 1.0
          && angMag < REST_ANG_MAX && align < REST_ALIGN_MAX) {
        this.restingOnBody = true;
      }
    }

    /* wrecked + body-resting: kill the free-spinning wheels / pegged rpm */
    _crashSettle(dt) {
      const p = this.p;
      this.wheelOmega = [0, 0, 0, 0];
      this.rpm += (p.idleRpm - this.rpm) * Math.min(1, dt * 6);
      this.throttle *= Math.max(0, 1 - dt * 10);
      this.lastFz = [0, 0, 0, 0];
      this.suspFz = [0, 0, 0, 0];
    }

    _stepGround(h, input, surf) {
      const p = this.p;
      const up = (surf && surf.up) || [0, 0, 1];
      this.up = up;
      let gripScale = surf && typeof surf.grip === 'number' ? surf.grip : 1;
      const surfClass = (surf && Number.isInteger(surf.surfaceClass)) ? surf.surfaceClass : ASPHALT_CLASS;
      /* touchdown regrip ramp — see REGRIP_S */
      if (this._regripT > 0) {
        this._regripT = Math.max(0, this._regripT - h);
        gripScale *= 1 - REGRIP_DROP * (this._regripT / REGRIP_S);
      }

      this.reverseReq = !!input.reverse;
      const lockUp = !!input.lockUp;

      /* pedals snap instantly (keyboard/gamepad); steer still slews */
      const tThr = lockUp ? 0 : clamp(input.throttle || 0, 0, 1);
      const tBrk = lockUp ? 1 : clamp(input.brake || 0, 0, 1);
      const tSteer = clamp(input.steer || 0, -1, 1);
      this.throttle = tThr;
      this.brake = tBrk;
      /* garage steering: full ratio-based lock is always available (like the
         real sim with a wheel); a mild taper above pit speed keeps digital
         keyboard/pad input drivable without eating the lock (the old
         heavy speed falloff was why the car "could barely turn at speed") */
      const speed = this.speed;
      const beta = speed > 2 ? Math.atan2(this.v, this.u) : 0;
      const assist = 1 / (1 + p.steerSpeedFalloff * Math.max(0, speed - p.steerAssistFromMps));
      let steerLimit = p.maxSteer * Math.max(assist, p.steerAssistFloor);
      /* NR2003 "Boost Steering at Low Speeds" aid — extra lock below pit
         speed so the garage/pit-road ratio isn't the on-track ratio */
      if (p.lowSpeedSteerBoost) {
        steerLimit *= 1 + p.steerBoostMax * clamp(1 - speed / p.steerBoostFadeMps, 0, 1);
      }
      const steerTarget = tSteer * steerLimit;
      /* slew scales with the available lock (constant sweep TIME across
         ratios/speeds); unwinding toward centre is quicker than winding on */
      const returning = Math.abs(steerTarget) < Math.abs(this.steer) ||
        (steerTarget !== 0 && this.steer !== 0 && sign(steerTarget) !== sign(this.steer));
      const slew = (steerLimit / p.steerSweepS) * (returning ? p.steerReturnMul : 1);
      this.steer += clamp(steerTarget - this.steer, -slew * h, slew * h);

      /* gravity resolved into the surface plane (banking) + normal component.
         up is unit; g points -Z. */
      const gDotN = -G * up[2];
      const gInPlane = [ -gDotN * up[0], -gDotN * up[1] ];   /* horizontal pull down-slope */
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      /* body-frame components of the down-slope gravity accel */
      const gFwd = gInPlane[0] * cy + gInPlane[1] * sy;
      const gLeft = -gInPlane[0] * sy + gInPlane[1] * cy;

      /* per-corner load resolved on the surface normal. Two parts:
         gravity (m·g·nz) AND the banked-turn term — horizontal centripetal
         acceleration presses the car INTO a banked surface whose normal
         leans toward the corner centre: N = m·(g·nz + a_c·n̂ₕ). This is
         MOST of why Bristol/Daytona banking grips (~+1g of load at speed);
         in the game it emerges from the per-part wrench solver. Turning
         AGAINST the banking unloads the same way. */
      const vxw = this.u * cy - this.v * sy;         /* world-frame velocity */
      const vyw = this.u * sy + this.v * cy;
      const aDotN = -this.r * vyw * up[0] + this.r * vxw * up[1];
      const bankBoost = clamp(aDotN, -0.6 * G, 2.6 * G);
      const w = p.mass * Math.max(0.15 * G, G * clamp(up[2], 0.2, 1) + bankBoost);

      /* aero: the SAME multi-surface panel model as flight, evaluated in the
         driving plane — the sprung body's pitch tips the flow (nose dive
         presses the front), yawed flow loads the flanks and unseals the
         floor, reversed flow scoops air UNDER the car = lift (unless the
         roof flaps blow open, Aerodynamics::employRoofFlaps). Downforce,
         balance and their attitude sensitivity are emergent. VISUAL deploy is
         gated on flapsPresent; the lift-spoiling below needs employRoofFlaps. */
      const attFlap = this._bodyAttitude();
      const upBFlap = qRot(composeRenderQuat(up, this.yaw, attFlap.pitch, attFlap.roll), [0, 0, 1]);
      updateCarFlapSwing(this, h, upBFlap, beta, speed);
      /* body damage degrades the aero and the engine (magnitudes are a
         stand-in — the exe damage-accumulation formula is not decoded) */
      const dmg = this.damage || 0;
      const attB = this._bodyAttitude();
      /* AIR-relative velocity: the track's ambient wind (world frame) rotated
         into the body frame and subtracted — crosswind loads the flanks,
         a headwind adds downforce+drag, a tailwind takes them away */
      const wxB = (p.windX || 0) * cy + (p.windY || 0) * sy;
      const wyB = -(p.windX || 0) * sy + (p.windY || 0) * cy;
      const uAir = this.u - wxB, vAir = this.v - wyB;
      const aero = panelAero(
        [uAir, vAir, uAir * Math.sin(attB.pitch)],
        [0, 0, this.r],
        { rho: p.airDensity, cgH: p.cgHeight, ge: 1,
          flaps: this.flapsDeployed && !!p.employRoofFlaps && !this._blowoverTest, dmg, spoilerDeg: p.spoilerDeg,
          flapsEffective: !!p.flapsPresent && !!p.employRoofFlaps && !this._blowoverTest,
          panels: this.aeroPanels || undefined, dragScale: p.dragScale });
      /* net vertical → tyre load; the panel pitch moment sets the axle
         split (τy = halfWB·(Ff − Fr), pitch + = nose down) */
      const downforce = -aero.f[2];
      const dfFront = downforce / 2 + aero.t[1] / p.wheelbase;
      const dfRear = downforce - dfFront;
      /* net lift feeds the blowover pivot check (_groundResolveVertical) */
      this._liftMag = aero.lift;
      /* lift-regime aero roll moment for the sprung body: the windward side
         leans up BEFORE the pivot fires (see AERO_ROLL_GATE_N). The panel
         t[0] alone is invisibly small at the pivot margin (the 0.20·weight
         criterion encodes CoP LEVERAGE the CG-referenced torque can't see),
         so the lean is anchored to the pivot's own quantities: lift as a
         fraction of its threshold, windward-side-up via the same sign(v) and
         broadside share the pivot uses. At the threshold the body rides
         visibly leaned; past it the pivot CONTINUES that motion. */
      const blowThreshG = (BLOWOVER_LIFT_FRAC / (p.blowoverScale || 1)) * p.mass * G;
      const liftFrac = clamp(this._liftMag / blowThreshG, 0, 1.2);
      const spPlanarA = Math.hypot(this.u, this.v) || 1;
      const preleanTq = sign(this.v) * (Math.abs(this.v) / spPlanarA)
        * liftFrac * PRELEAN_TQ_NM;
      const liftGate = clamp(aero.f[2] / AERO_ROLL_GATE_N, 0, 1);
      const aeroRollRaw = clamp(preleanTq + liftGate * aero.t[0],
        -AERO_ROLL_TQ_MAX, AERO_ROLL_TQ_MAX);
      /* filtered (PRELEAN_RISE_S/FALL_S): the springs see a breathing load,
         not per-frame lift spikes */
      const pl0 = this._preleanSm || 0;
      const plTau = Math.abs(aeroRollRaw) > Math.abs(pl0) ? PRELEAN_RISE_S : PRELEAN_FALL_S;
      this._preleanSm = pl0 + (aeroRollRaw - pl0) * Math.min(1, h / plTau);
      const aeroRollTq = this._preleanSm;
      /* world-z downforce acceleration for the grounded ballistic band: a car
         cresting/chasing a dropping surface (sliding down the banking!) is
         pressed down by aero, not just gravity — without this the band chased
         at 1 g while the real car chases at up to ~1.8 g, so it hung airborne
         mid-corner, lost all tire load, then slammed back (the jerk/veer) */
      this._dfAccelZ = Math.max(0, downforce) / p.mass
        * Math.max(this.up ? this.up[2] : 1, 0.5);

      /* at rest: don't feed tire-force noise back into load-transfer targets.
         Pitch uses the TIRE-path longitudinal accel (last step's _tireFxN):
         only ground forces have the cgHeight arm; airborne it goes to zero
         so flight never sees phantom dive/squat loads.
         CONTINUOUS rest blend — the old binary creeping/atRest gates stepped
         the suspension's whole character (damping x4, load-transfer cut, pose
         relax on/off) the instant speed crossed a threshold: a visible clunk
         at every stop. The blend ramps over the last ~0.5 m/s, throttle keeps
         it out of launches, and a time filter forbids per-frame steps even
         when the pedals themselves step. */
      const speedRest = clamp((0.5 - speed) / 0.38, 0, 1);
      const driveCut = 1 - clamp((this.throttle - 0.04) / 0.06, 0, 1);
      const rb0 = this._restBlend || 0;
      this._restBlend = rb0 + (speedRest * driveCut - rb0) * Math.min(1, h / 0.12);
      const restBlend = this._restBlend;
      const loadLive = 1 - restBlend;
      const axLoad = (this._tireFxN || 0) / p.mass * loadLive;
      const ayLoad = this.ay * loadLive;

      /* travel-space suspension: the sprung body takes its set through the
         springs — weight transfer is emergent (DYNAMICS-SPEC) */
      const fz = this._stepSuspension(h, w / p.mass, dfFront, dfRear, axLoad, ayLoad, aeroRollTq, restBlend);
      /* ballistic-band load fade (_groundResolveVertical): over a crest the
         tires go light in proportion to the gap instead of holding full grip
         to the takeoff cliff — the felt "random push/pull" at speed */
      const cFade = this._contactFade == null ? 1 : this._contactFade;
      if (cFade < 1) for (let i = 0; i < 4; i++) fz[i] *= cFade;
      this.lastFz = fz;

      const gearRatio = p.gearRatios[this.gear];
      const totalRatio = gearRatio * p.finalDrive;

      /* cut engine throttle while braking out of the wrong direction/gear */
      let engineThrottle = this.throttle;
      if (this.reverseReq && (this.gear !== 0 || this.u > REV_STOP_U_MPS)) engineThrottle = 0;
      else if (!this.reverseReq && this.gear === 0 && this.u < -REV_STOP_U_MPS) engineThrottle = 0;

      /* engine rpm — clutch slip model (DYNAMICS-SPEC: engine + clutch inertia
         separate from wheel ω; at launch the engine REVS while tires spin) */
      const drivenOmega = (this.wheelOmega[2] + this.wheelOmega[3]) * 0.5;
      const wheelRpm = Math.abs(drivenOmega * totalRatio) * (60 / (2 * Math.PI));
      let rpmCmd = Math.max(wheelRpm, p.idleRpm);
      if (engineThrottle > 0.04) {
        const throttleRpm = p.idleRpm + engineThrottle * (p.redlineRpm - p.idleRpm);
        /* below ~15 m/s the clutch slips — engine rpm leads wheel rpm */
        const couple = clamp(speed / 12, 0, 1);
        rpmCmd = Math.max(wheelRpm, throttleRpm * (1 - couple * 0.35) + wheelRpm * couple * 0.35);
      } else if (this.brake < 0.05) {
        /* coast: rpm follows wheels down with engine braking */
        rpmCmd = Math.max(wheelRpm, p.idleRpm);
      }
      const rpmSlew = engineThrottle > 0.04 ? p.clutchSlipUpRpmS
        : (this.brake > 0.5 ? p.clutchSlipUpRpmS * 5 : p.clutchSlipUpRpmS * 2.5);
      this.rpm += clamp(rpmCmd - this.rpm, -rpmSlew * 2 * h, rpmSlew * h);
      this.rpm = clamp(this.rpm, p.idleRpm, p.redlineRpm);

      /* auto gearbox (WASD has no clutch/shift keys) */
      this._autoShift(h);

      /* engine → driven-wheel drive torque, through the traction-control
         driving aid (NR2003 aids default on for keyboard/pad): back the
         torque out as rear slip passes the threshold */
      /* no fuel-cut limiter (FUN_0051a870 has none) — the torque LUT falling
         into the friction LUT is what stops the revs; the old hard cut +
         engine friction through the axle was killing burnouts in ~50 ms */
      let limited = engineThrottle;
      if (this.reverseReq && this.gear !== 0) limited = 0;
      /* burnout guard: keep the AIDS off while the driver is deliberately
         spinning the rears — crossing tcMinSpeed mid-launch was killing
         wheelspin around 4–5 m/s, and the stability bleed was strangling
         donuts every time |beta| swept past 20° ("stops half a burnout,
         then lets me go again"). The hold timer bridges momentary slip
         dips so the aids can't grab between flare-ups; lifting the
         throttle re-arms them immediately. */
      const prevRearSlip = Math.max(Math.abs(this.lastSlip[2]), Math.abs(this.lastSlip[3]));
      const rawBurnout = !lockUp && engineThrottle > 0.35 && (
        prevRearSlip > 0.35
        || (this.throttle > 0.3 && this.brake > 0.25 && speed < 12));
      if (rawBurnout) this._burnoutHold = BURNOUT_HOLD_S;
      else this._burnoutHold = Math.max(0, (this._burnoutHold || 0) - h);
      const inBurnout = rawBurnout || (engineThrottle > 0.35 && this._burnoutHold > 0);
      if (p.tractionControl && limited > 0 && speed > p.tcMinSpeed && !inBurnout) {
        const rearSlip = Math.max(this.lastSlip[2], this.lastSlip[3]);
        if (rearSlip > p.tcSlipThreshold) {
          limited *= clamp(1 - (rearSlip - p.tcSlipThreshold) * 8, 0.15, 1);
        }
      }
      /* stability-control aid — the locked axle's lift-off engine braking
         yaws the car when steered; the aid attenuates it, and backs the
         drive torque out as the body slides. NOT in the decomp engine
         model — with the aid OFF you get the raw FUN_0051a870 output. */
      let ebScale = 1;
      if (p.stabilityControl) {
        ebScale = 1 / (1 + Math.abs(this.steer) * 1.8);
        /* only past ~20° body slip — catch flat spins, not power rotation;
           never a deliberate burnout/donut (that's the driver's slide) */
        if (limited > 0 && speed > 6 && Math.abs(beta) > 0.35 && !inBurnout) {
          limited *= clamp(1 - (Math.abs(beta) - 0.35) * 2.2, 0.4, 1);
        }
      }
      /* engine net torque — FUN_0051a870: (gross − idleLoad)·throttle
         + idleLoad − friction. Friction always drags (no invented
         (1−brake) gate); idleLoad keeps the engine idling at rest. */
      const idleLoad = (p.idleRpm / Math.max(this.rpm, p.idleRpm)) * ENGINE_IDLE_LOAD_NM;
      const ebBurnout = inBurnout ? 0.15 : 1;
      /* combustion term scales with air density (p.powerScale) — a high, hot
         track makes less power; friction/idle load are unaffected */
      const tqEngine = (engineTorqueGross(this.rpm) - idleLoad) * limited * (1 - 0.3 * dmg) * p.powerScale * (p.enginePowerMul ?? p.playerPowerMul ?? 1)
        + idleLoad - engineBrakeTorque(this.rpm) * ebScale * ebBurnout;
      /* auto-clutch (always on for keyboard/pad in NR2003): opens at closed
         throttle near a stop, so the idle-load surplus doesn't creep the car */
      const clutch = engineThrottle < 0.04
        ? (speed < 0.2 ? 0 : clamp((speed - 0.2) / 0.4, 0, 1))
        : 1;
      /* reverse stop: idle-load surplus still reached the axle when limited=0
         (tqEngine keeps +idleLoad−engineBrake) — fought revBrake at ~2 m/s */
      let driveGate = 1;
      if (this.reverseReq && this.gear !== 0) driveGate = 0;
      /* the reverse ratio NEVER drives without reverse requested — the old
         gate only blocked below 0.15 m/s, so throttle while the box was
         still in R fed full REVERSE torque ("stuck with the wheels
         spinning backwards"); _autoShift swaps to 1st on throttle intent */
      else if (!this.reverseReq && this.gear === 0) driveGate = 0;
      else if (this.reverseReq && this.gear === 0 && this.u > REV_STOP_U_MPS) driveGate = 0;
      const driveTorque = tqEngine * totalRatio * p.driveEff * clutch * driveGate;

      /* reverse: must come to a full stop before drive — hold throttle out
         of forward gears until R is engaged; auto-brake any residual roll */
      let revBrake = 0;
      if (this.reverseReq && this.gear !== 0) revBrake = 1;

      /* brake torque per wheel — burnout: throttle wins on the driven axle */
      const brakeTotal = Math.max(this.brake, revBrake) * p.brakeTorqueMax;
      let brakeFront = brakeTotal * p.brakeBiasFront / 2;
      let brakeRear = brakeTotal * (1 - p.brakeBiasFront) / 2;
      if (lockUp) {
        const qw = brakeTotal * 0.25;
        brakeFront = qw;
        brakeRear = qw;
      } else if (inBurnout && this.brake > 0.25) brakeRear = 0;

      /* ---- per-wheel slip + tire force ---- */
      let Fx = 0, Fy = 0, Mz = 0;             /* body-frame sums */
      const halfWB = p.wheelbase / 2, halfTW = p.trackWidth / 2;
      /* locked rear axle (spool): both rears run ONE ω, but their rolling
         radii differ by the stagger — the RR (bigger) is pushed into positive
         slip, the LR into negative, a permanent left-yaw couple on ovals */
      const radii = [p.wheelRadius, p.wheelRadius,
        p.wheelRadius - p.rearStaggerM / 2, p.wheelRadius + p.rearStaggerM / 2];
      let rearReactTorque = 0;
      let rearAtRest = true;
      const fzTot = fz[0] + fz[1] + fz[2] + fz[3] || 1;
      for (let i = 0; i < 4; i++) {
        const c = CORNERS[i];
        const px = c.fwd * halfWB, py = c.left * halfTW;
        /* contact-point velocity in body frame */
        const vlong = this.u - this.r * py;
        const vlat = this.v + this.r * px;
        /* steer the fronts: rotate the wheel's velocity into wheel frame */
        const delta = c.front ? this.steer : 0;
        const cd = Math.cos(delta), sd = Math.sin(delta);
        const wLong = vlong * cd + vlat * sd;
        const wLat = -vlong * sd + vlat * cd;

        const brakeMag0 = c.front ? brakeFront : brakeRear;
        /* RWD: fronts free-roll with the contact patch — never integrate
           driveshaft / Fx reaction torque (that made them spin like the rears). */
        if (c.front) {
          if (lockUp) {
            this.wheelOmega[i] = 0;
          } else {
            const rollOmega = wLong / radii[i];
            const brakePed = Math.max(this.brake, revBrake);
            let lock = brakeMag0 > 0 ? clamp(brakePed, 0, 1) : 0;
            /* ABS on the kinematic fronts: the torque-path release below only
               feeds the REAR axle integrator — the fronts locked straight off
               the raw pedal and ABS "didn't work on the front brakes". The
               kinematic slip IS the lock fraction (slip ≈ −lock at speed), so
               capping lock at the release threshold pins the fronts at the
               same near-peak slip the rear ABS regulates around: full-pedal
               stops keep steering and the wheel never flat-spots. */
            if (p.absBrakes && Math.abs(wLong) > p.absMinSpeed) {
              lock = Math.min(lock, p.absSlipThreshold);
            }
            this.wheelOmega[i] = rollOmega * (1 - lock);
          }
        }

        /* slip angle — direct kinematic input (TIRE-SPEC: wheel+0x2bc feeds the
           FUN_0054cab0 force build straight from contact velocities; the +0x2b8
           small-slip accumulator is NOT a lag on the force path. A first-order
           filter here phase-delayed the yaw loop into a slow weave — the
           "bounce in the turns"). */
        const slipAngle = Math.atan2(wLat, Math.abs(wLong) + 0.5);
        this.slipIntegrator[i] = slipAngle;
        const wheelSurfSpeed = this.wheelOmega[i] * radii[i];
        const denom = Math.max(Math.abs(wLong), 0.25);
        let slipRatio = (wheelSurfSpeed - wLong) / denom;
        slipRatio = clamp(slipRatio, -1.5, 1.5);
        this.lastSlip[i] = slipRatio;

        const f = tireForce(slipRatio, slipAngle, fz[i], gripScale, c.front, i, delta,
          wLong, wLat, p, surfClass, wheelSurfSpeed);

        /* static friction: when the tread is NOT sliding over the surface the
           patch supplies whatever force holds it still — this corner's load
           share of gravity plus a velocity kill — capped by the friction
           circle. Lateral always (a tire cannot roll sideways); longitudinal
           only when braked/locked — an unbraked wheel is free to roll
           downhill. Past the cap it degrades to a full-μ kinetic slide. */
        const slipVx = wLong - wheelSurfSpeed;
        const treadSlipSpd = Math.hypot(slipVx, wLat);
        this.lastSlideSpd[i] = treadSlipSpd;   /* viewer tire marks/smoke */
        const patchSpd = Math.hypot(wLong, wLat);
        if (treadSlipSpd < STICK_SPEED_MPS && patchSpd < STICK_SPEED_MPS && fz[i] > 1) {
          const mShare = p.mass * fz[i] / fzTot;
          const gWLong = gFwd * cd + gLeft * sd;
          const gWLat = -gFwd * sd + gLeft * cd;
          const braked = brakeMag0 > 1;
          /* drive relief: with the throttle down on an UNBRAKED wheel the
             tyre is in the rolling regime — the slip model owns it. The
             full deadbeat lateral hold at steered fronts out-muscled the
             (falloff-weak) spinning-rear thrust and pinned full-lock
             launches to a crawl. Braked wheels keep the full hold
             (brake-stands, hill holds); the gravity feedforward stays. */
          const driveRelief = braked ? 1 : clamp(1 - this.throttle * 1.5, 0, 1);
          const holdFy = -mShare * (gWLat + wLat * STICK_DAMP * driveRelief);
          const holdFx = braked ? -mShare * (gWLong + slipVx * STICK_DAMP) : f.fx;
          const cap = p.muBase * gripScale * loadSaturation(fz[i], p) * fz[i];
          const mag = Math.hypot(holdFx, holdFy);
          const scale = mag > cap ? cap / mag : 1;
          f.fx = holdFx * scale;
          f.fy = holdFy * scale;
        }

        /* wheel spin dynamics: I·dω = drive − brake − Fx·R */
        let brakeMag = brakeMag0;
        /* anti-lock brakes aid — release the wheel as it approaches lock
           (below absMinSpeed wheels may lock so the full-stop latch works) */
        if (p.absBrakes && !lockUp && brakeMag > 0 && Math.abs(wLong) > p.absMinSpeed
            && slipRatio < -p.absSlipThreshold) {
          /* release hard — an unloaded inside front needs a near-full dump */
          brakeMag *= clamp(1 - (-slipRatio - p.absSlipThreshold) * 8, 0.05, 1);
        }
        const brakeRef = Math.abs(wLong) > 0.12 ? wLong : (this.wheelOmega[i] || wLong || 1);
        const brakeT = brakeMag * -sign(brakeRef);
        if (!c.front) {
          /* rears feed the shared axle */
          rearReactTorque += brakeT - f.fx * radii[i];
          if (Math.abs(wLong) >= 0.3) rearAtRest = false;
        }

        /* rotate wheel force back into body frame */
        const bfx = f.fx * cd - f.fy * sd;
        const bfy = f.fx * sd + f.fy * cd;
        Fx += bfx;
        Fy += bfy;
        Mz += px * bfy - py * bfx;
      }

      /* FUN_0054cab0 Step 9 — front steer moment → _DAT_00c081ec */
      if (Math.abs(this.steer) > 0.01 && speed > 2) {
        const fl = Math.max(fz[0], 200);
        const aux = Math.sqrt(fl * p.wheelbase * 0.5);
        const sm = STEER_MOM_A * STEER_MOM_B;
        Mz -= sm * Math.sqrt(fl * aux) * this.steer;
      }

      /* integrate the locked rear axle: full drive torque + both wheels'
         brake/grip reactions on 2× wheel inertia, one shared ω */
      {
        const omegaMax = (p.redlineRpm * RPM_TO_RADS) / Math.abs(totalRatio || 1);
        const omegaPrev = this.wheelOmega[2];
        /* over-rev TORQUE governor (replaces the old hard kinematic clamp):
           approaching redline-equivalent wheel speed the engine's push dies
           (valve float), and past it back-driving the engine brakes the
           axle with rising friction — both act as TORQUES through the
           tires, not a speed wall. The old clamp parked the axle AT the cap
           while draft/banking/low-drag pushed the CAR past it, pinning the
           rears below road speed = a constant rear-axle brake and a hair-
           trigger yaw at top speed. Still caps Bristol top speed and 1st-
           gear burnout tire speed — the equilibrium just converges softly. */
        const govFade = clamp((omegaMax - Math.abs(omegaPrev))
          / (omegaMax * GOV_FADE_FRAC), 0, 1);
        const drive = driveTorque > 0 ? driveTorque * govFade : driveTorque;
        const over = Math.abs(omegaPrev) - omegaMax;
        const overT = over > 0 ? -sign(omegaPrev) * OVERREV_NMS * over : 0;
        let omega = omegaPrev +
          ((drive + overT + rearReactTorque) / (2 * p.wheelInertia)) * h;
        /* integrator guard only — far above any physical overrun */
        omega = clamp(omega, -omegaMax * 1.25, omegaMax * 1.25);
        if (lockUp) {
          omega = 0;
        } else if (Math.abs(omega) < 0.15 && engineThrottle < 0.05 && rearAtRest
            && speed < 0.2) {
          omega = 0;
        }
        this.wheelOmega[2] = omega;
        this.wheelOmega[3] = omega;
      }

      /* tire-path longitudinal force (body frame) — the share of ax that
         reacts at the GROUND through the suspension links; next step's
         pitch/anti-dive works from this, not total ax (aero drag and grade
         gravity act on the body/CG and have no ground-arm pitch moment) */
      this._tireFxN = Fx;

      /* panel aero in the plane: drag + side force + yaw moment, derived
         from the true flow (reverse driving and spins included) */
      Fx += aero.f[0];
      Fy += aero.f[1];
      Mz += aero.t[2];
      /* rolling resistance, multiplied by the surface's roll-drag (grass/dirt
         plows and drags the car down; asphalt rollDrag == 1, unchanged) */
      const rollDrag = surf && typeof surf.rollDrag === 'number' ? surf.rollDrag : 1;
      Fx -= p.rollingResist * rollDrag * w * sign(this.u) * (Math.abs(this.u) > 0.05 ? 1 : 0);

      /* backing up: bleed lateral slide so S works after a spin */
      if (this.reverseReq && this.gear === 0 && this.throttle > 0.05 && Math.abs(this.u) < 3) {
        const k = Math.min(1, h * 14);
        this.v *= (1 - k);
        this.r *= (1 - k * 0.85);
      }

      /* banking / grade gravity */
      Fx += p.mass * gFwd;
      Fy += p.mass * gLeft;

      /* ---- rigid-body planar dynamics (semi-implicit) ---- */
      const m = p.mass, Iz = p.yawInertia;
      const ax = Fx / m + this.r * this.v;    /* du/dt = Fx/m + r·v */
      const ay = Fy / m - this.r * this.u;    /* dv/dt = Fy/m − r·u */
      const ar = Mz / Iz;
      this.u += ax * h;
      this.v += ay * h;
      this.r = clamp(this.r + ar * h, -8, 8);  /* yaw-rate integrator guard */
      this.ax = ax - this.r * this.v;         /* store pure accel for transfer */
      this.ay = ay + this.r * this.u;

      /* parked / nearly stopped — gentle settle, no last-second velocity snap.
         (Old code bled 60%/frame below 7.8 mph with brakes and 96%/frame coasting
         below 0.8 mph — felt like stomping the pedal at the end.) */
      const slopePull = Math.hypot(gInPlane[0], gInPlane[1]);
      const canHoldStill = p.muBase * gripScale * G * clamp(up[2], 0, 1) > slopePull;
      if (canHoldStill && this.throttle < 0.04 && this.brake < 0.04
          && this.speed < 0.12 && (!this.reverseReq || this.gear === 0)) {
        const hold = 1 - h * 3.5;
        this.u *= Math.max(0, hold);
        this.v *= Math.max(0, hold);
        this.r *= Math.max(0, hold);
        if (this.speed < 0.025) { this.u = 0; this.v = 0; this.r = 0; this.wheelOmega = [0, 0, 0, 0]; }
      }

      /* direction flip: hard latch once brakes have killed opposing motion */
      const braking = this.brake > 0.4 || (this.reverseReq && this.gear !== 0)
        || (!this.reverseReq && this.gear === 0 && this.u < -0.03);
      const dirFlip = braking && (
        (this.reverseReq && this.u > 0.03) || (!this.reverseReq && this.u < -0.03));
      if (canHoldStill && dirFlip && this.speed < 0.5 && !inBurnout) {
        const snap = 1 - h * 30;
        this.u *= snap; this.v *= snap; this.r *= snap;
        if (this.speed < 0.03) {
          this.u = 0; this.v = 0; this.r = 0;
          this.wheelOmega = [0, 0, 0, 0];
        }
      }
      /* held-S stop before the box grabs R: bleed, never TELEPORT to zero —
         the old hard u=v=r=0 at 0.25 m/s froze the car (and its wheels) mid
         roll every single stop: the "magnet". 30/s kills 0.25 m/s in ~0.08 s,
         visually a firm stop; the true zero waits for an imperceptible speed */
      if (canHoldStill && this.reverseReq && this.gear !== 0 && this.brake > 0.4
          && this.speed < 0.25) {
        const bleed = Math.max(0, 1 - h * 30);
        this.u *= bleed; this.v *= bleed; this.r *= bleed;
        if (this.speed < 0.02) {
          this.u = 0; this.v = 0; this.r = 0;
          this.wheelOmega = [0, 0, 0, 0];
        }
      }

      /* integrate pose in the ground plane */
      this.x += (this.u * cy - this.v * sy) * h;
      this.y += (this.u * sy + this.v * cy) * h;
      this.yaw += this.r * h;
      if (this.yaw > Math.PI) this.yaw -= 2 * Math.PI;
      else if (this.yaw < -Math.PI) this.yaw += 2 * Math.PI;
    }

    _autoShift(h) {
      const p = this.p;
      this.shiftTimer = Math.max(0, this.shiftTimer - h);
      if (this.shiftTimer > 0) return;
      /* reverse: engage only at a DEAD stop (standard racing-game feel:
         S is a pure brake all the way down, THEN the box goes to R) —
         a sliding or creeping car must finish moving first. Gate is on
         BODY velocity, never wheel speed: locked tyres at speed must
         not read as "stopped". */
      if (this.reverseReq && this.speed < 0.3 && this.u < 0.05 && this.u > -0.8) {
        if (this.gear !== 0) { this.gear = 0; this.shiftTimer = 0.05; }
        return;
      }
      if (this.gear === 0) {
        /* leave R at rest as before — but throttle is DRIVER INTENT: a
           real box slammed from R to D just engages D, it doesn't wait
           for a sliding car to fully settle (full-lock launches got
           trapped in R with the drive gated) */
        const wantsForward = !this.reverseReq && this.throttle > 0.1
          && this.u > -0.5 && this.speed < 4;
        if ((!this.reverseReq && this.u > -REV_STOP_U_MPS && this.speed < 1.0)
            || wantsForward) {
          this.gear = 1; this.shiftTimer = 0.05;
        }
        return;
      }
      if (this.reverseReq) return;   /* hold reverse — no auto-upshift */
      /* forward auto up/down-shift on GROUND-speed rpm, not the slipping
         engine/wheel rpm — a driver holds the gear during wheelspin. Shifting
         on raw rpm ran 1st→4th mid-burnout and killed the spin. */
      const groundRpm = (Math.abs(this.u) / this.p.wheelRadius)
        * this.p.gearRatios[this.gear] * this.p.finalDrive * (30 / Math.PI);
      const spinOut = this.throttle > 0.35
        && Math.max(Math.abs(this.lastSlip[2]), Math.abs(this.lastSlip[3])) > 0.3;
      if (groundRpm > p.shiftUpRpm && !spinOut && this.gear < p.gearRatios.length - 1) {
        this.gear++; this.shiftTimer = 0.35;
      } else if (groundRpm < p.shiftDownRpm && this.gear > 1) {
        this.gear--; this.shiftTimer = 0.35;
      }
    }

    /* immutable snapshot for the renderer / HUD. Airborne, the free
       world-frame attitude replaces the suspension pitch/roll and `up`
       becomes world-up — the renderer composes the exact same way. */
    snapshot() {
      const att = this._bodyAttitude();
      const flying = this.airborne;
      return {
        x: this.x, y: this.y, yaw: this.yaw,
        up: flying ? [0, 0, 1] : this.up.slice(),
        roll: flying ? this.attRoll : att.roll,
        pitch: flying ? this.attPitch : att.pitch,
        z: this.zPos ?? 0,    /* world z of the tyre-contact plane */
        vz: this.vz,
        airborne: flying,
        /* grounded + in contact: the render should anchor to the surface at
           the car's CURRENT position (zPos is the PRE-step sample — one
           frame of travel stale, visible jitter in banked turns). False =
           ballistic pre-takeoff band: render zPos so the crest lift is
           continuous into the airborne flip. */
        onSurface: !flying && !this.restingOnBody && this.onSurface !== false,
        restingOnBody: this.restingOnBody,
        /* full attitude while off the wheels — the renderer applies this
           directly (Euler pitch/roll break down mid-tumble) */
        quat: (flying || this.restingOnBody) && this._airActive
          ? [this.qw, this.qx, this.qy, this.qz] : null,
        /* the body's CONTINUOUS world orientation — live every frame in the
           unified solver (grounded too, _airActive is permanently true), unlike
           `quat` which is null on the wheels. The renderer crossfades from its
           surface-relative grounded composition to THIS by contactFade so the
           ground↔air attitude handoff eases instead of switching representation
           (the 2.4° flip snap), and the frame interpolators can slerp it across
           the transition instead of hard-snapping when `quat` blinks on/off. */
        poseQuat: this._airActive ? [this.qw, this.qx, this.qy, this.qz] : null,
        heave: -this.bodyZ,   /* sprung-body lift vs static rest (m, + = risen) */
        /* tyre-load share (1 = full contact, 0 = light/ballistic). The renderer
           fades the heave/tilt lift out by this as the car goes light so the
           sprung-body ride eases to zero to MEET the airborne anchor (snap.z)
           at the flip — no hard heave step at takeoff/landing (NR2003 keeps one
           continuous body, never switches ground↔air composition). */
        contactFade: this._contactFade == null ? 1 : this._contactFade,
        speed: this.speed, speedMph: this.speed * MPS_TO_MPH,
        rpm: this.rpm, gear: this.gear,
        throttle: this.throttle, brake: this.brake, steer: this.steer,
        fz: this.lastFz.slice(), slip: this.lastSlip.slice(),
        slideSpd: this.lastSlideSpd.slice(),   /* m/s tread slide — tire marks/smoke */
        wheelOmega: this.wheelOmega.slice(),   /* rad/s, FL FR RL RR — wheel visuals */
        flapDeploy: this.flapDeploy != null ? this.flapDeploy : (this.flapsDeployed ? 1 : 0),
        flapsDeployed: this.flapsDeployed,     /* roof_flap_state model node */
        damage: this.damage,                   /* 0..1 body damage (HUD) */
      };
    }
  }

  /* Universal pedals: W/S (RT/LT) swap roles with motion direction — the
     standard racing-game scheme:
       Forward:  W = gas, S = brake → hold through the stop → reverse.
       Backing:  S = reverse gas, W = brake → hold through the stop → forward.
     Both pedals near rest = brake-stand burnout. `wasBurnout` is the caller's
     latch: the burnout mapping HOLDS until a pedal lifts or real road speed
     builds (BURNOUT_EXIT_SPD). The old hard `spd < 4` exit cut the throttle
     to zero + full brake the moment a rolling burnout crept past ~3 m/s,
     then re-armed as it slowed — the "stops half a burnout, then lets me go
     again" bug. Returns { throttle, brake, reverse, burnout }; feed
     `burnout` back in as `wasBurnout` next frame. */
  function mapDrivePedals(car, gas, brakePed, wasBurnout) {
    const spd = car.speed, uFwd = car.u, gear = car.gear;
    if (gas > 0 && brakePed > 0) {
      const enter = spd < BURNOUT_ENTER_SPD && Math.abs(uFwd) < 3;
      if (enter || (wasBurnout && spd < BURNOUT_EXIT_SPD)) {
        /* burnout: brake locks the fronts, gas spins the rears */
        const ped = Math.max(gas, brakePed);
        return { throttle: ped, brake: ped, reverse: false, burnout: true };
      }
      /* both pedals at real speed: brake wins */
      return { throttle: 0, brake: Math.max(gas, brakePed), reverse: false, burnout: false };
    }
    if (brakePed > 0) {
      /* S: brake until forward roll is fully dead + R engaged — never
         throttle while still creeping forward */
      if (uFwd > 0.02 || gear !== 0) {
        return { throttle: 0, brake: brakePed, reverse: true, burnout: false };
      }
      return { throttle: brakePed, brake: 0, reverse: true, burnout: false };
    }
    if (gas > 0) {
      /* W: brake until backward roll is fully dead + out of R. "Backing" =
         rolling backwards with the rears ROLLING (not lit) — a donut
         rocking the car backwards mid-wheelspin keeps its throttle. The
         old extra |u|>|v| gate exempted reverse-rolling WITH steering
         lock too: W then did nothing (R torque is gated) and the car
         coasted backwards, wheels spinning backwards, gas floored. */
      const rearSpin = Math.max(Math.abs(car.lastSlip[2]), Math.abs(car.lastSlip[3]));
      const backing = uFwd < -0.02 && rearSpin < 0.5;
      if (backing || (gear === 0 && spd > REV_STOP_SPD_MPS)) {
        return { throttle: 0, brake: gas, reverse: false, burnout: false };
      }
      return { throttle: gas, brake: 0, reverse: false, burnout: false };
    }
    return { throttle: 0, brake: 0, reverse: false, burnout: false };
  }

  /* Wall/barrier impulse — SURFACE-SPEC §Car↔wall RESPONSE: the 2.0f @
     contact+4 is a TYPE FLAG (skip drivable FUN_00575890), NOT e=2.0 bounce.
     Walls integrate through FUN_0051892a constraint forces — inelastic grind:
     normal impulse from the TRUE corner effective mass, tangential friction
     capped at µ·jN, nothing else. The old flat 0.88 velocity scrub taxed the
     WHOLE car 12% on every contact frame — a 1 cm graze at 130 mph lost
     10+ m/s in one frame and consecutive graze frames compounded it ("glitch
     collide"). And the old `leverage` speed-softening shrank only the
     rotational term of the effective mass, so jN came out ~3× too big for
     corner hits and was then applied at the FULL lever arm — the exact
     instant-spin it was meant to prevent. Full rn²/I keeps a glancing touch
     a nudge (small jN ⇒ small yaw kick) and a square hit heavy, by physics. */
  const WALL_CONTACT = {
    /* MU raised 0.42 → 0.75 / MU_SOFT 0.55 → 0.95 (2026-07-09): the 0.42 was
       the class-0 concrete TIRE grip stand-in — crumpling sheet metal gouges
       and the SAFER foam bites, so wall hits now GRAB the car ("needs more
       friction, like the surface"). GRIND_*: sustained lean-on-the-wall used
       to be frictionless (no closing speed ⇒ no impulse) — now it scrubs per
       contact frame in proportion to engagement depth. */
    MU: 0.75, MU_SOFT: 0.95, E: 0, MAX_DV: 8, MAX_SPIN: 2.2, MIN_VN: -0.8,
    GRIND_PER_M: 1.2, GRIND_MAX: 0.08,
  };
  function resolveWallImpulse(car, ox, oy, nx, ny, pen, softWall) {
    const W = WALL_CONTACT, p = car.p;
    const maxDv = softWall ? 5 : W.MAX_DV;
    const cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
    const vx = car.u * cy - car.v * sy, vy = car.u * sy + car.v * cy;
    const vpx = vx - car.r * oy, vpy = vy + car.r * ox;
    const vn = vpx * nx + vpy * ny;
    if (vn > W.MIN_VN) {
      /* resting/slow merge — eject any velocity INTO the wall, and grind
         the tangential motion in proportion to how deep the wall is
         engaged. The old flat grind treated a light graze like a deep
         merge: a full-lock burnout started beside the wall (falloff-weak
         spinning-rear thrust) was pinned at ~0.6 m/s forever — "the car
         doesn't move". A graze now grinds gently, a driver on the
         throttle grinds less still; deep merges keep the full scrub. */
      if (pen > 0.03 && car.speed < 1.5) {
        const scrubIn = Math.min(1, pen * 4);
        const vn2 = vpx * nx + vpy * ny;
        /* vn2 < 0 = moving INTO the wall (n points out of it). The old
           `vn2 > 0` gate had this inverted — it deleted the car's ESCAPE
           velocity every frame, so a car grazing the wall could never
           open the gap and drive off. */
        if (vn2 < 0) {
          car.u -= (vn2 * nx) * cy + (vn2 * ny) * sy;
          car.v -= (-(vn2 * nx) * sy + (vn2 * ny) * cy);
        }
        let grind = Math.min(0.35, pen * 1.5);
        if ((car.throttle || 0) > 0.2) grind *= 0.4;
        car.u *= 1 - scrubIn * grind;
        car.v *= 1 - scrubIn * grind;
      } else if (pen > 0.01 && car.speed >= 1.5) {
        /* sustained grind AT SPEED: leaning on the wall carried no friction
           at all (no closing speed ⇒ no impulse; the low-speed grind above
           is gated < 1.5 m/s) — riding the wall at 150 mph was free. Scrub
           the tangential motion per contact frame, scaled by engagement
           depth, as a proper impulse AT the contact point so a grinding
           corner also drags the nose around like the real thing. A 1-frame
           glancing kiss stays a nudge; parking it against the wall grabs. */
        const tx = -ny, ty = nx;
        const vt = vpx * tx + vpy * ty;
        const rt = ox * ty - oy * tx;
        const kT = 1 / p.mass + (rt * rt) / p.yawInertia;
        const grab = Math.min(W.GRIND_MAX, pen * W.GRIND_PER_M);
        const jT = (-vt * grab) / kT;
        const r0g = car.r;
        car.applyImpulseAt(ox, oy, tx * jT, ty * jT);
        car.r = r0g + clamp(car.r - r0g, -W.MAX_SPIN, W.MAX_SPIN);
      }
      return 0;
    }
    const rn = ox * ny - oy * nx;
    const kN = 1 / p.mass + (rn * rn) / p.yawInertia;
    let jN = (1 + W.E) * (-vn / kN);
    jN = Math.min(jN, p.mass * maxDv);
    if (pen > 0.25) jN *= Math.max(0.35, 1 - (pen - 0.25) * 0.4);
    const tx = -ny, ty = nx;
    const vt = vpx * tx + vpy * ty;
    const rt = ox * ty - oy * tx;
    const kT = 1 / p.mass + (rt * rt) / p.yawInertia;
    const mu = softWall ? W.MU_SOFT : W.MU;
    const jT = clamp(-vt / kT, -mu * jN, mu * jN);
    const r0 = car.r;
    car.applyImpulseAt(ox, oy, nx * jN + tx * jT, ny * jN + ty * jT);
    car.r = r0 + clamp(car.r - r0, -W.MAX_SPIN, W.MAX_SPIN);
    return jN;
  }

  /* A grounded car's vz is surface-FOLLOWING rate, not ballistic — it equals
     the in-plane velocity projected on the surface slope. A wall impulse on
     banking changes that in-plane velocity in one frame (kills a sideways
     climb), and keeping the stale vz launched the car OFF the wall touch:
     +4 m/s of leftover climb rate popped it airborne. Re-derive vz from the
     post-impulse velocity and the surface normal (up·v = 0 in the plane). */
  const GROUND_VZ_RESYNC_MAX = 12;   /* matches SURF_VZ_MAX */
  function resyncGroundVz(car, up) {
    if (car.airborne || !up || !(up[2] > 0.2)) return;
    const cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
    const vx = car.u * cy - car.v * sy, vy = car.u * sy + car.v * cy;
    car.vz = clamp(-(vx * up[0] + vy * up[1]) / up[2],
      -GROUND_VZ_RESYNC_MAX, GROUND_VZ_RESYNC_MAX);
    /* the follow FILTER must resync too. Every wall-contact frame is flagged
       an outlier (external x/y shift), which freezes _vzSurfSm at its pre-hit
       value — a car that was CLIMBING the banking kept that stale climb rate
       through the whole grind, and the grounded branch's vz := _vzSurfSm
       handed it back the instant contact ended: the car left the wall rising
       ~1.6 m/s over a falling surface and bunny-hopped 20 cm into the air.
       The slope-projected rate above IS the correct follow rate now. */
    car._vzSurfSm = car.vz;
    /* BUNNY-HOP FIX: a wall push never got the post-landing grace, so any
       residual upward vz opened a gap and popped the car off the wall. Arm the
       same glue a touchdown uses — small gaps (< LAND_GRACE_GAP_M) stay stuck
       for LAND_GRACE_S; a GENUINE launch (gap past that) still takes off. */
    car._groundHold = Math.max(car._groundHold || 0, LAND_GRACE_S);
  }

  /* Wall collidability — must match what the renderer draws (WALL-UV-DECOMP /
     tracksurface wallFacesSlotted). Phantom hits came from: full-segment collision
     on span-limited walls, zero-ct fake half-thickness planes, and apron markers. */
  function wallHasSideFace(w) {
    const faces = w.faces;
    if (!faces || !faces.length) return !!(w.texture);
    /* mirror the renderer's faceSpec exactly: slots 0/2 are the sides,
       3/4 the front/back OVERLAYS (SAFER foam over concrete), and slot 1
       is only a top cap when its texture is a "top" — otherwise it's a
       fence back. If a vertical face is DRAWN, the wall is hittable
       (Roval seg14 is a visible 1 m wall whose only face sits in slot 3). */
    return faces.some((f) => f.texture &&
      ((f.slot | 0) !== 1 || !/top/i.test(f.texture)));
  }

  function wallSpanActive(w, u) {
    const ts = w.spanTs;
    if (!ts || !ts.length) return true;
    let g = 0;
    while (g + 1 < ts.length && u >= ts[g + 1] - 1e-4) g++;
    if (u < ts[g] - 1e-4) return false;
    const end = g + 1 < ts.length ? ts[g + 1] : 1;
    return u <= end + 1e-4;
  }

  function wallTrackFaces(w, u) {
    const wd = w.d0 + (w.d1 - w.d0) * u;
    const side = wd >= 0 ? 1 : -1;
    const bt = Math.max(w.bt0 || 0, w.bt1 || 0, 0.05);
    const rendHalf = bt * 0.5;
    return {
      wd, side,
      trackFace: wd - side * rendHalf,
      outerFace: wd + side * rendHalf,
    };
  }

  /* Interior walls — drivable surface on BOTH sides (the pit wall between
     track and pit road) — are thin SLABS, not half-spaces. The old model
     computed penetration against the track face only, so a car legitimately
     BEHIND the pit wall (pit road, dlat -8 at Daytona) read as "embedded
     2.6 m" and was pushed clean through onto the track, riding an invisible
     grabbing rail the whole frontstretch ("hits bumps I can't see").
     Boundary walls (nothing drivable behind) stay half-spaces — that depth
     is the anti-tunnel guard for violent hits. */
  const WALL_SLAB_MIN_T = 0.35;
  function wallSlab(seg, w, u) {
    const f = wallTrackFaces(w, u);
    const T = Math.max((f.outerFace - f.trackFace) * f.side, WALL_SLAB_MIN_T);
    let behind = 0;
    if (seg && seg.xsecs) {
      for (const xs of seg.xsecs) {
        const ext = f.side > 0 ? Math.max(xs.d0, xs.d1) - f.outerFace
                               : f.outerFace - Math.min(xs.d0, xs.d1);
        if (ext > behind) behind = ext;
      }
    }
    return { T, interior: behind > 1.0 };
  }

  function isWallCollidable(w, u, carDlat) {
    if (!Number.isFinite(w.d0) || !Number.isFinite(w.d1)) return false;
    const h = Math.max(w.h0 || 0, w.h1 || 0);
    if (h < WALL_MIN_HEIGHT_M) return false;
    if (!wallHasSideFace(w)) return false;
    if (!wallSpanActive(w, u)) return false;
    const { side, outerFace } = wallTrackFaces(w, u);
    if (side > 0 && carDlat > outerFace + 2.5) return false;
    if (side < 0 && carDlat < outerFace - 2.5) return false;
    return true;
  }

  /* FUN_00575890 — drivable sequential-impulse restitution soften (dumped
     .rdata, BINARY-DUMPS.md §2): impulse j ≥ THRESH → e = 1 − NUM/(j + DEN),
     ceiling 1.0 (_DAT_006e97d8). Below the threshold the bump stays hard/dead. */
  const WALL_RESTITUTION = { NUM: 180000.0, DEN: 120000.0, THRESH: 60000.0 };

  /* W-section h0/h1 below this are apron/edge markers — the exe bakes real
     barrier height at loft (TRACK-SPEC +0x158/+0x15C); zero-height records
     must not become lateral collision planes (phantom hits). 0.22 keeps the
     h=0 markers dead but lets REAL low walls collide — Texas 2020/Hump ring
     the outer apron with drawn 0.30 m walls (46 records) that a spun car
     drove straight through at the old 0.45 gate. */
  const WALL_MIN_HEIGHT_M = 0.22;

  /* ---- car ↔ car collision -------------------------------------------
     The exe pairs nearby cars through the trackpos system and resolves them
     with the same planar constraint machinery as walls (mass pack 50.0f at
     FUN_0052ac80 — exact formula undecoded, so this is a stand-in on the
     wall model): each car is the same 2-D OBB the wall solver uses, SAT
     finds the minimum-translation axis, penetrating corners locate the
     contact, and a symmetric rigid-body impulse (small restitution + Coulomb
     friction, equal and opposite → momentum conserved) resolves the pair.
     STRICTLY PLANAR like walls — a car hit can never add vz. Both cars are
     shoved apart positionally (half each) with the wall external-shift flag
     set so the next surface sample can't read the shift as vertical speed. */
  const CAR_CAR_RESTITUTION = 0.12;   /* mostly-dead thud-and-shove */
  const CAR_CAR_MU = 0.45;            /* sheet metal grinding on sheet metal */
  const CAR_CAR_Z_GAP_M = 1.15;       /* legacy label — grounded pairs use GROUND_REACH×2 */
  const CAR_CAR_BODY_REACH = 0.95;    /* m vertical half-extent around zPos when off the wheels */
  const CAR_CAR_GROUND_REACH = 0.55;  /* m vertical half-extent for grounded tyre-plane ref */
  const CAR_CAR_DMG_FULL = 1543 * 40; /* N·s for damage 1.0 — the wall scale */
  /* ---- 3D WRECK DYNAMICS ---------------------------------------------------
     The car↔car impulse acts in the ground plane at a contact point BELOW the
     CG, so it physically produces a roll moment (lateral/T-bone hits) and a
     pitch moment (fore/aft hits); hard OBLIQUE hits also ride up over the other
     car. We seed those onto the airborne DOF (vz + attRoll/PitchV) and hand the
     car to the emergent flight solver (external-airborne path, step() §1961) so
     wrecks LAUNCH and TUMBLE with real weight instead of flat-shoving. Gentle
     contact (below the severity gate) stays purely planar — clean door-to-door
     racing is unaffected. All tunable; verify by eye. */
  const CAR_CAR_CG_H = 0.48;          /* m — CG height above the ground-plane contact (roll/pitch arm) */
  const WRECK_SEV_MIN = 6.0;          /* m/s of hit severity below which contact stays purely planar */
  const WRECK_LIFT_K = 0.17;          /* ride-up vz gained per m/s of severity over the gate */

  const WRECK_LIFT_MAX = 6.5;         /* m/s cap on the synthesized ride-up */
  const WRECK_REACTION = 0.35;        /* fraction of the lift the other (aggressor) car also gets */
  const WRECK_AIRBORNE_MIN = 1.1;     /* m/s vz below which a car stays grounded (no launch flicker) */
  const WRECK_ANG_K = 0.5;            /* scale on the physical roll/pitch seed (flip sign here if it tumbles the wrong way) */
  const WRECK_MASS_REF = 1543;        /* kg — base Cup mass; wreck lift scales as 2·REF/(mA+mB)
                                         so heavier cars launch LESS (factor 1.0 at default mass) */

  /* car↔car uses the REAL body attitude (flight quat or surface composition),
     not yaw-only — a tumbling car's footprint rotates with the mesh. */
  function carCollisionQuat(c) {
    if (c._airActive && Number.isFinite(c.qw)) return [c.qw, c.qx, c.qy, c.qz];
    const a = c._bodyAttitude();
    return composeRenderQuat(c.up || [0, 0, 1], c.yaw, a.pitch, a.roll);
  }
  function carPlanarOBB(c) {
    const q = carCollisionQuat(c);
    const fwd = qRot(q, [1, 0, 0]), left = qRot(q, [0, 1, 0]);
    const fl = Math.hypot(fwd[0], fwd[1]) || 1, ll = Math.hypot(left[0], left[1]) || 1;
    const f = [fwd[0] / fl, fwd[1] / fl], l = [left[0] / ll, left[1] / ll];
    const hf = CAR_HALF_LEN_F, hr = CAR_HALF_LEN_R, hw = CAR_HALF_WIDTH;
    const cx = c.x, cy = c.y;
    return {
      fwd: f, left: l,
      corners: [
        [cx + f[0] * hf + l[0] * hw, cy + f[1] * hf + l[1] * hw],
        [cx + f[0] * hf - l[0] * hw, cy + f[1] * hf - l[1] * hw],
        [cx - f[0] * hr + l[0] * hw, cy - f[1] * hr + l[1] * hw],
        [cx - f[0] * hr - l[0] * hw, cy - f[1] * hr - l[1] * hw],
      ],
    };
  }
  function carBodyZExtents(c) {
    const q = carCollisionQuat(c);
    const z0 = c.zPos || 0;
    const pts = c.bodyPts || BODY_CONTACT_PTS;
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) {
      const wz = z0 + qRot(q, p)[2];
      if (wz < lo) lo = wz;
      if (wz > hi) hi = wz;
    }
    if (!Number.isFinite(lo)) {
      lo = z0 - CAR_BODY_HALF_H; hi = z0 + CAR_BODY_HALF_H;
    }
    return { lo, hi };
  }
  function carInPlanarOBB(px, py, c) {
    const obb = carPlanarOBB(c);
    const dx = px - c.x, dy = py - c.y;
    const lon = dx * obb.fwd[0] + dy * obb.fwd[1];
    const lat = dx * obb.left[0] + dy * obb.left[1];
    return lon <= CAR_HALF_LEN_F && lon >= -CAR_HALF_LEN_R && Math.abs(lat) <= CAR_HALF_WIDTH;
  }
  function syncCarAttitudeEcho(c) {
    if (!c._airActive || !Number.isFinite(c.qw)) return;
    const e = qToYPR([c.qw, c.qx, c.qy, c.qz]);
    c.yaw = lerpAngle(c._yawEcho != null ? c._yawEcho : c.yaw, e.yaw, 1);
    c._yawEcho = c.yaw;
    c.attPitch = e.pitch;
    c.attRoll = e.roll;
    c._attPitchEcho = c.attPitch;
    c._attRollEcho = c.attRoll;
  }

  function collideCars(A, B) {
    const dx = B.x - A.x, dy = B.y - A.y;
    /* cheap reject before SAT */
    const reach = CAR_HALF_LEN_F + CAR_HALF_LEN_F + 0.2;
    if (dx * dx + dy * dy > reach * reach) return null;
    /* flying clear over the other car — no planar contact. The gap MUST be
       measured NORMAL TO THE TRACK SURFACE, not in raw world z. On banking two
       cars that are side-by-side (or one diving under, or one hopping a bump /
       tumbling low) sit at different WORLD heights purely because the track is
       tilted — yet they are the same distance apart across the asphalt and must
       still collide. Raw |zB−zA| crossed the 1.15 m gate in the turns, the SAT
       never ran, and the pair GHOSTED through each other — the "cars merge / no
       crash / hitbox not there, especially when flipping or on the edge" bug.
       In the unified solver `.up` is ALWAYS the surface normal at the car's
       ground point (body attitude lives in the render quaternion, not here), so
       the plane's own rise across (dx,dy) is −(u·d)/uz. Subtract it: the leftover
       is the true perpendicular gap — small for anyone racing alongside on the
       bank (→ collide), large only for a car genuinely lofted clear above the
       track (→ correctly skip). Works airborne and grounded alike. */
    const zA = A.zPos, zB = B.zPos;
    if (Number.isFinite(zA) && Number.isFinite(zB)) {
      const uA = A.up || [0, 0, 1], uB = B.up || [0, 0, 1];
      const ux = (uA[0] + uB[0]) * 0.5, uy = (uA[1] + uB[1]) * 0.5;
      const uz = Math.max(0.5, (uA[2] + uB[2]) * 0.5);
      const dzPlane = -(ux * dx + uy * dy) / uz;
      const extA = carBodyZExtents(A), extB = carBodyZExtents(B);
      const zMidA = (extA.lo + extA.hi) * 0.5, zMidB = (extB.lo + extB.hi) * 0.5;
      const halfA = Math.max((extA.hi - extA.lo) * 0.5, CAR_CAR_BODY_REACH);
      const halfB = Math.max((extB.hi - extB.lo) * 0.5, CAR_CAR_BODY_REACH);
      const perpSep = Math.abs((zMidB - zMidA) - dzPlane);
      /* mesh/body vertical span — always active; only skip when the REAL body
         volumes are separated perpendicular to the track (not a tyre-plane guess). */
      if (perpSep > halfA + halfB + 0.06) return null;
    }

    const obbA = carPlanarOBB(A), obbB = carPlanarOBB(B);
    const cornA = obbA.corners, cornB = obbB.corners;
    const axes = [obbA.fwd, obbA.left, obbB.fwd, obbB.left];
    const proj = (corners, ax) => {
      let lo = Infinity, hi = -Infinity;
      for (const p of corners) {
        const d = p[0] * ax[0] + p[1] * ax[1];
        if (d < lo) lo = d;
        if (d > hi) hi = d;
      }
      return [lo, hi];
    };
    let pen = Infinity, nx = 0, ny = 0;
    for (const ax of axes) {
      const [aLo, aHi] = proj(cornA, ax);
      const [bLo, bHi] = proj(cornB, ax);
      const o = Math.min(aHi, bHi) - Math.max(aLo, bLo);
      if (o <= 0) return null;                    /* separating axis */
      if (o < pen) {
        pen = o;
        const s = (dx * ax[0] + dy * ax[1]) >= 0 ? 1 : -1;   /* n points A→B */
        nx = ax[0] * s; ny = ax[1] * s;
      }
    }

    /* contact: mean of the corners each box sinks into the other; a shallow
       edge-edge graze with no captured corner falls back to the midpoint */
    const inOBB = (p, c) => carInPlanarOBB(p[0], p[1], c);
    let cxp = 0, cyp = 0, cn = 0;
    for (const p of cornB) if (inOBB(p, A)) { cxp += p[0]; cyp += p[1]; cn++; }
    for (const p of cornA) if (inOBB(p, B)) { cxp += p[0]; cyp += p[1]; cn++; }
    const px = cn ? cxp / cn : (A.x + B.x) / 2;
    const py = cn ? cyp / cn : (A.y + B.y) / 2;

    const rAx = px - A.x, rAy = py - A.y;
    const rBx = px - B.x, rBy = py - B.y;
    const worldVel = (c) => {
      const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
      return [c.u * cy - c.v * sy, c.u * sy + c.v * cy];
    };
    const [vAx, vAy] = worldVel(A);
    const [vBx, vBy] = worldVel(B);
    /* point velocities incl. spin (ω × r in the plane) */
    const pAx = vAx - A.r * rAy, pAy = vAy + A.r * rAx;
    const pBx = vBx - B.r * rBy, pBy = vBy + B.r * rBx;
    const relN = (pBx - pAx) * nx + (pBy - pAy) * ny;

    let j = 0;
    if (relN < 0) {                               /* approaching — impulse pair */
      const mA = A.p.mass, mB = B.p.mass;
      const iA = A.p.yawInertia, iB = B.p.yawInertia;
      const rAxn = rAx * ny - rAy * nx;
      const rBxn = rBx * ny - rBy * nx;
      const k = 1 / mA + 1 / mB + (rAxn * rAxn) / iA + (rBxn * rBxn) / iB;
      j = -(1 + CAR_CAR_RESTITUTION) * relN / k;
      A.applyImpulseAt(rAx, rAy, -j * nx, -j * ny);
      B.applyImpulseAt(rBx, rBy, j * nx, j * ny);
      /* Coulomb friction along the contact tangent, clamped by µ·j */
      const tx = -ny, ty = nx;
      const relT = (pBx - pAx) * tx + (pBy - pAy) * ty;
      const rAxt = rAx * ty - rAy * tx;
      const rBxt = rBx * ty - rBy * tx;
      const kt = 1 / mA + 1 / mB + (rAxt * rAxt) / iA + (rBxt * rBxt) / iB;
      const jt = clamp(-relT / kt, -CAR_CAR_MU * j, CAR_CAR_MU * j);
      A.applyImpulseAt(rAx, rAy, -jt * tx, -jt * ty);
      B.applyImpulseAt(rBx, rBy, jt * tx, jt * ty);
      A.addDamage(j / CAR_CAR_DMG_FULL);
      B.addDamage(j / CAR_CAR_DMG_FULL);

      /* --- 3D WRECK LAUNCH + TUMBLE (see CAR_CAR_CG_H / WRECK_* consts) ------
         The planar impulse just applied (J = j·n + jt·t on B, −J on A) acted at
         ground level below the CG. Convert that into vertical ride-up + roll/pitch
         angular seeds and hand hard hits to the emergent flight solver. */
      const impactDv = j * (1 / mA + 1 / mB);          /* hit severity (m/s of rel-vel change) */
      if (impactDv > WRECK_SEV_MIN) {
        const relTmag = Math.abs((pBx - pAx) * tx + (pBy - pAy) * ty);
        const oblique = relTmag / (Math.abs(relN) + relTmag + 1e-3);   /* 0 square … 1 side-swipe */
        /* WEIGHT: heavier cars plow and stay planted, lighter cars fly. At the base
           mass (or default "Car mass" slider) this factor is 1.0 — the launch is
           unchanged, so the wreck test-suite still holds; drag the mass slider up
           and wrecks get less airborne. Uses the average of the two masses. */
        const wreckMassFac = (2 * WRECK_MASS_REF) / (mA + mB);
        const lift = Math.min(WRECK_LIFT_MAX,
          (impactDv - WRECK_SEV_MIN) * WRECK_LIFT_K * (0.3 + oblique) * wreckMassFac);
        if (lift >= WRECK_AIRBORNE_MIN) {
          /* the car being run INTO climbs over the other (its metal rides up) */
          const aFast = A.speed >= B.speed;
          const upC = aFast ? B : A, dnC = aFast ? A : B;
          /* world impulse each car received: +J on B, −J on A */
          const JBx = j * nx + jt * tx, JBy = j * ny + jt * ty;
          const Ix = AIR_INERTIA[0] * _massScale, Iy = AIR_INERTIA[1] * _massScale;
          const launch = (C, Jcx, Jcy, vzAdd) => {
            const cyC = Math.cos(C.yaw), syC = Math.sin(C.yaw);
            const jFwd = Jcx * cyC + Jcy * syC;        /* fore/aft impulse (body frame) */
            const jLat = -Jcx * syC + Jcy * cyC;       /* lateral impulse (+ = body-left) */
            const upC = C.up || [0, 0, 1];
            const attC = C._bodyAttitude();
            const qC = composeRenderQuat(upC, C.yaw, attC.pitch, attC.roll);
            C.qw = qC[0]; C.qx = qC[1]; C.qy = qC[2]; C.qz = qC[3];
            C._airActive = true;
            const eC = qToYPR(qC);
            C.attPitch = eC.pitch;
            C.attRoll = eC.roll;
            C._attPitchEcho = C.attPitch;
            C._attRollEcho = C.attRoll;
            C.vz = (C.vz || 0) + vzAdd;
            /* lateral force below CG → roll; fore/aft force below CG → pitch (L = r × F) */
            C.attRollV = clamp((C.attRollV || 0) + WRECK_ANG_K * CAR_CAR_CG_H * jLat / Ix, -AIR_MAX_ANG, AIR_MAX_ANG);
            C.attPitchV = clamp((C.attPitchV || 0) - WRECK_ANG_K * CAR_CAR_CG_H * jFwd / Iy, -AIR_MAX_ANG, AIR_MAX_ANG);
            C.wbx = C.attRollV;   /* unified solver: body rates are canonical */
            C.wby = C.attPitchV;
            C.airborne = true;   /* legacy path: external-airborne handoff; unified: label, re-derived next step */
          };
          launch(upC, upC === B ? JBx : -JBx, upC === B ? JBy : -JBy, lift);
          const rLift = lift * WRECK_REACTION;
          if (rLift >= WRECK_AIRBORNE_MIN) launch(dnC, dnC === B ? JBx : -JBx, dnC === B ? JBy : -JBy, rLift);
        }
      }
    }

    /* positional split — half each, and flag the shift so neither car's
       surface-height memory converts the teleport into phantom vz */
    const half = pen / 2;
    A.x -= nx * half; A.y -= ny * half;
    B.x += nx * half; B.y += ny * half;
    A._zSurfExternalShift = true;
    B._zSurfExternalShift = true;
    if (!A.airborne && A.up) resyncGroundVz(A, A.up);
    if (!B.airborne && B.up) resyncGroundVz(B, B.up);
    syncCarAttitudeEcho(A);
    syncCarAttitudeEcho(B);
    return { j, pen, nx, ny, px, py };
  }

  const HP_TO_KW = 2 * Math.PI / 60000 * 1.341;
  const HP_TARGET_MIN = 250, HP_TARGET_MAX = 900;

  function wotNetTorqueNm(rpm, p, powerMul) {
    const mul = powerMul != null ? powerMul : (p.enginePowerMul ?? 1);
    const idleLoad = (p.idleRpm / Math.max(rpm, p.idleRpm)) * ENGINE_IDLE_LOAD_NM;
    return (engineTorqueGross(rpm) - idleLoad) * p.powerScale * mul
      + idleLoad - engineBrakeTorque(rpm);
  }
  function hpFromTorqueNm(tqNm, rpm) {
    return Math.max(0, tqNm * rpm * HP_TO_KW);
  }
  function wotHorsepowerAtRpm(rpm, p, powerMul) {
    return hpFromTorqueNm(wotNetTorqueNm(rpm, p, powerMul), rpm);
  }

  function peakHorsepower(p, powerMul = 1) {
    let peak = 0;
    for (let rpm = p.idleRpm; rpm <= p.redlineRpm; rpm += 40) {
      const tqEngine = wotNetTorqueNm(rpm, p, powerMul);
      const hp = hpFromTorqueNm(tqEngine, rpm);
      if (hp > peak) peak = hp;
    }
    return peak;
  }


  function settleCarToSurface(car, surf) {
    const up = (surf && surf.up) || car.up || [0, 0, 1];
    car.up = up;
    car.attPitch = 0;
    car.attRoll = 0;
    car.attPitchV = 0;
    car.attRollV = 0;
    car.wbx = 0;
    car.wby = 0;
    car.wbz = 0;
    car._attPitchEcho = 0;
    car._attRollEcho = 0;
    const q = composeRenderQuat(up, car.yaw, 0, 0);
    car.qw = q[0]; car.qx = q[1]; car.qy = q[2]; car.qz = q[3];
    car._airActive = false;
    car.airborne = false;
    car.onSurface = true;
    car.restingOnBody = false;
    car.zPos = surf ? surf.height : 0;
    car._zPosEcho = car.zPos;
    car._yawEcho = car.yaw;
    car._cgZ = null;
    car.vz = 0;
    car._loadFrac = 1;
    car.flapDeploy = 0;
    car.flapsDeployed = false;
    car._flapSwing = 0;
    car._flapSwingV = 0;
    car._flapEqPrev = null;
  }

  function hpTargetToMul(targetHp, p) {
    const natural = peakHorsepower(p, 1);
    const t = clamp(Number(targetHp) || 750, HP_TARGET_MIN, HP_TARGET_MAX);
    return natural > 5 ? clamp(t / natural, 0.28, 3.2) : 1;
  }

  return {
    mapDrivePedals, collideCars, settleCarToSurface,
    BODY_CONTACT_PTS,
    setMassScale, getMassScale, MASS_SCALE_MIN, MASS_SCALE_MAX,
    setNoDamage, getNoDamage,
    setUnified3d, getUnified3d,
    Car, PARAMS, surfaceGrip, tireForce, engineTorque, SURFACE_GRIP, SURF_LIN_SCALE, SURF_SLIP_SCALE, SURF_DRAG_MUL, ASPHALT_CLASS, WALL_RESTITUTION,
    resolveWallImpulse, WALL_CONTACT,
    bodyGroundLift, bodyAttitudeExtraLift, wallContactPoints, WALL_MIN_HEIGHT_M,
    REV_STOP_U_MPS, REV_STOP_SPD_MPS,
    CAR_OBB: { halfLenF: CAR_HALF_LEN_F, halfLenR: CAR_HALF_LEN_R, halfWidth: CAR_HALF_WIDTH },
    CAR_BODY_HALF_H, WALL_CLEARANCE_M: 0.05, WALL_BODY_MARGIN_M: 0.08,
    wallHasSideFace, wallSpanActive, wallTrackFaces, wallSlab, isWallCollidable, resyncGroundVz,
    composeRenderQuat, decomposeSurfPR, quatUpZ, renderOriginZ, renderAnchorOffset,
    qSlerp, lerpAngle, BODY_GROUND_GAP_M,
    panelAero, aeroProbe, AERO_PANELS, scaleAeroPanels, meshSupportPoints,
    wotNetTorqueNm, hpFromTorqueNm, wotHorsepowerAtRpm,
    peakHorsepower, hpTargetToMul, HP_TARGET_MIN, HP_TARGET_MAX
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Physics;

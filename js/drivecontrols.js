/* Drive control bindings — keyboard, gamepad. Persisted in localStorage. */
const DriveControls = (() => {
  const STORAGE = 're2003-drive-controls';
  const DEFAULTS = {
    keys: { throttle: 'w', brake: 's', steerLeft: 'a', steerRight: 'd', respawn: 'r', lockUp: 'x' },
    pad: {
      steerAxis: 0,
      steerInvert: false,
      throttleBtn: 7,
      throttleAxis: 5,
      brakeBtn: 6,
      brakeAxis: 4,
      /* bind-time pedal-axis calibration (captured with the binding): rest =
         axis value with the pedal released, dir = which way it moved. Exact
         for 0..1 triggers, −1..1 triggers, inverted triggers and sticks used
         as pedals — null/0 = never captured (runtime falls back to the
         rest-guessing path for the stock bindings). */
      throttleAxisRest: null,
      throttleAxisDir: 0,
      brakeAxisRest: null,
      brakeAxisDir: 0,
      respawnBtn: 3,
      lockUpBtn: 1,
      orbitAxis: 2,
      orbitAxisV: 3,
      orbitInvert: false,
      deadZone: 0.12,
    },
    /* Driving aids (traction control, stability) — default ON
       does for non-wheel controllers */
    aids: {
      tractionControl: true,
      absBrakes: true,
      stabilityControl: true,
      lowSpeedSteerBoost: true,
      speedSensitiveSteer: true,
    },
    /* aero tune (all cars). dragScale: 1 = stock; <1 slipperier/faster/calmer,
       >1 draggier/slower. blowoverScale: 1 = real ~150 mph onset; >1 flips
       sooner (easy to test blowovers), <1 needs more backward speed.
       roofFlaps: flaps fitted - they deploy on the mesh in reversed flow.
       flapsEffective: deployed flaps spoil the reversed-flow lift (real safety).
       roofFlaps ON + flapsEffective OFF = flaps visibly pop but the car still
       blows over. */
    aero: {
      dragScale: 1.0,
      blowoverScale: 1.0,
      roofFlaps: true,
      flapsEffective: true,
    },
    /* flow-smoke stream while driving: the wind-tunnel fog locked to a point
       ahead of the live car. height/side place the emitter (m, car frame). */
    smoke: {
      on: false,
      height: 0.85,
      side: 0.0,
    },
    /* GLOBAL wind / airflow shape — the field flowVel() advects every smoke
       puff through, in the R&D tunnel AND on track. Baked from the live
       tunnel session (see Aerodynamics > Wind & airflow shape).
         roofLift  how hard the shell throws the stream up over the roof
         liftCut   × half-length where that lift quits (the hump control)
         bodyPush  outward wrap around the shell
         downStr   rear downwash strength (pulls the stream back down)
         downStart × half-length from centre where the downwash bites (−ve = earlier)
         downFade  m past the tail it keeps pulling before trailing off
         wakeDef   wake momentum deficit
         wakeClose wake inward closure
         underRam  splitter-gap speed-up */
    flow: {
      roofLift: 1.20,
      liftCut: 0.31,
      bodyPush: 0.60,
      downStr: 0.55,
      downStart: 0.22,
      downFade: 8.5,
      wakeDef: 0.44,
      wakeClose: 0.09,
      underRam: 0.40,
    },
  };

  /* id → cfg.flow field + readout formatter (drives sync AND binding, so the
     two can never drift apart) */
  const FLOW_SLIDERS = [
    ['vp-wind-roof-lift',  'roofLift',  (v) => v.toFixed(2)],
    ['vp-wind-lift-cut',   'liftCut',   (v) => v.toFixed(2)],
    ['vp-wind-body-push',  'bodyPush',  (v) => v.toFixed(2)],
    ['vp-wind-down-str',   'downStr',   (v) => v.toFixed(2)],
    ['vp-wind-down-start', 'downStart', (v) => v.toFixed(2)],
    ['vp-wind-down-fade',  'downFade',  (v) => `${v.toFixed(1)} m`],
    ['vp-wind-wake-def',   'wakeDef',   (v) => v.toFixed(2)],
    ['vp-wind-wake-close', 'wakeClose', (v) => v.toFixed(2)],
    ['vp-wind-under-ram',  'underRam',  (v) => v.toFixed(2)],
  ];

  const AID_CHECKBOXES = [
    ['vp-aid-tc', 'tractionControl'],
    ['vp-aid-abs', 'absBrakes'],
    ['vp-aid-stab', 'stabilityControl'],
    ['vp-aid-steerboost', 'lowSpeedSteerBoost'],
    ['vp-aid-ssteer', 'speedSensitiveSteer'],
  ];

  const BIND_LABEL = { key: 'Press key…', padBtn: 'Press button…', padAxis: 'Move stick/axis…' };
  const ARM_MS = 280;
  const BTN_DELTA = 0.08;
  const BTN_MIN = 0.12;
  const AXIS_DELTA = 0.12;
  const AXIS_MIN = 0.18;

  let cfg = load();
  let listen = null;
  let listenRaf = 0;
  let padWakeBound = false;
  let statusRaf = 0;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE);
      if (!raw) {
        const out = clone(DEFAULTS);
        const b = (typeof RE2003_BAKED_DEFAULTS !== 'undefined') ? RE2003_BAKED_DEFAULTS : null;
        if (b && b.driveControls) {
          if (b.driveControls.pad) Object.assign(out.pad, b.driveControls.pad);
          if (b.driveControls.aero) Object.assign(out.aero, b.driveControls.aero);
          if (b.driveControls.smoke) Object.assign(out.smoke, b.driveControls.smoke);
          if (b.driveControls.flow) Object.assign(out.flow, b.driveControls.flow);
        }
        return out;
      }
      const parsed = JSON.parse(raw);
      const aero = { ...DEFAULTS.aero, ...(parsed.aero || {}) };
      /* migrate the old 0.30-min blowover slider: 0.30x made the pivot threshold
         a full car weight (unreachable at any speed), so a saved 0.30 could never
         blow over. New floor is 0.50x (hard but achievable). */
      if (Number.isFinite(aero.blowoverScale) && aero.blowoverScale < 0.5) aero.blowoverScale = 0.5;
      return {
        keys: { ...DEFAULTS.keys, ...(parsed.keys || {}) },
        pad: { ...DEFAULTS.pad, ...(parsed.pad || {}) },
        aids: { ...DEFAULTS.aids, ...(parsed.aids || {}) },
        aero,
        smoke: { ...DEFAULTS.smoke, ...(parsed.smoke || {}) },
        /* flow is newer than existing saves — merging over DEFAULTS keeps an
           older localStorage (which has no `flow`) from returning cfg.flow
           undefined and breaking flowVel on the first frame */
        flow: { ...DEFAULTS.flow, ...(parsed.flow || {}) },
      };
    } catch (e) {
      return clone(DEFAULTS);
    }
  }

  function save() {
    try { localStorage.setItem(STORAGE, JSON.stringify(cfg)); } catch (e) {}
    syncUI();
  }

  function get() { return cfg; }

  function reset() {
    cfg = clone(DEFAULTS);
    save();
    document.dispatchEvent(new CustomEvent('re2003-aids-change', { detail: cfg.aids }));
    document.dispatchEvent(new CustomEvent('re2003-aero-change', { detail: cfg.aero }));
  }

  /* keep the aero sliders + their readouts in sync with cfg.aero */
  function syncAeroUI() {
    const drag = document.getElementById('vp-aero-drag');
    const dragVal = document.getElementById('vp-aero-drag-val');
    if (drag) drag.value = cfg.aero.dragScale;
    if (dragVal) dragVal.textContent = cfg.aero.dragScale.toFixed(2) + '×';
    const blow = document.getElementById('vp-aero-blowover');
    const blowVal = document.getElementById('vp-aero-blowover-val');
    if (blow) blow.value = cfg.aero.blowoverScale;
    if (blowVal) blowVal.textContent = cfg.aero.blowoverScale.toFixed(2) + '×';
    const flaps = document.getElementById('vp-aero-flaps');
    if (flaps) flaps.checked = cfg.aero.roofFlaps !== false;
    const flapsEff = document.getElementById('vp-aero-flaps-eff');
    if (flapsEff) flapsEff.checked = cfg.aero.flapsEffective !== false;
    const smkOn = document.getElementById('vp-flow-smoke');
    if (smkOn) smkOn.checked = !!cfg.smoke.on;
    const smkH = document.getElementById('vp-flow-height');
    const smkHVal = document.getElementById('vp-flow-height-val');
    if (smkH) smkH.value = cfg.smoke.height;
    if (smkHVal) smkHVal.textContent = cfg.smoke.height.toFixed(2) + ' m';
    const smkS = document.getElementById('vp-flow-side');
    const smkSVal = document.getElementById('vp-flow-side-val');
    if (smkS) smkS.value = cfg.smoke.side;
    if (smkSVal) smkSVal.textContent = cfg.smoke.side.toFixed(1) + ' m';
    syncFlowUI();
  }

  /* keep the wind/airflow sliders + readouts in sync with cfg.flow */
  function syncFlowUI() {
    if (!cfg.flow) return;
    for (const [id, key, fmt] of FLOW_SLIDERS) {
      const el = document.getElementById(id);
      if (el) el.value = cfg.flow[key];
      const lab = document.getElementById(`${id}-val`);
      if (lab) lab.textContent = fmt(cfg.flow[key]);
    }
  }

  function keyId(e) {
    const k = e.key;
    if (k === 'ArrowUp') return 'arrowup';
    if (k === 'ArrowDown') return 'arrowdown';
    if (k === 'ArrowLeft') return 'arrowleft';
    if (k === 'ArrowRight') return 'arrowright';
    if (k.length === 1) return k.toLowerCase();
    return k.toLowerCase();
  }

  function labelKey(id) {
    const map = { arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' };
    return map[id] || id.toUpperCase();
  }

  /* Xbox names for the browser "standard" gamepad layout — pads often
     report bare indices (or an id of literally "Unknown Gamepad"), which
     read as "unknown name" in the panel. Names are shown alongside the
     index whenever the connected pad looks standard/Xbox. */
  const XBOX_BTN_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT',
    'View', 'Menu', 'LS click', 'RS click', 'DPad up', 'DPad down', 'DPad left', 'DPad right', 'Guide'];
  const STD_AXIS_NAMES = ['Left stick X', 'Left stick Y', 'Right stick X', 'Right stick Y'];

  function padStandardish() {
    for (const pad of connectedPads()) {
      if (pad.mapping === 'standard') return true;
      if (/xbox|x-box|045e/i.test(pad.id || '')) return true;
    }
    return false;
  }

  function labelBtn(i) {
    if (!(i >= 0)) return '-';
    const name = padStandardish() ? XBOX_BTN_NAMES[i] : null;
    return name ? `${name} (Btn ${i})` : `Btn ${i}`;
  }

  function labelAxis(i) {
    if (!(i >= 0)) return '-';
    const name = padStandardish() ? STD_AXIS_NAMES[i] : null;
    return name ? `${name} (Axis ${i})` : `Axis ${i}`;
  }

  function shortPadId(pad) {
    let id = (pad && pad.id) ? pad.id : '';
    /* "Unknown Gamepad (Vendor: 045e Product: 0b13)" → name it by vendor */
    if (!id || /unknown/i.test(id)) {
      if (/045e/i.test(id)) id = 'Controller';
      else if (/054c/i.test(id)) id = 'Controller';
      else id = id ? id.replace(/unknown gamepad/i, 'Controller') : 'controller';
    }
    id = id.replace(/\b(raiju|xbox|x-?box)\b/gi, 'controller').replace(/\s+/g, ' ').trim();
    if (/^controller$/i.test(id)) id = 'Controller';
    return id.length > 42 ? id.slice(0, 39) + '…' : id;
  }

  function padApiReady() {
    return !!navigator.getGamepads;
  }

  function padWake() {
    if (navigator.getGamepads) navigator.getGamepads();
  }

  function emitLog(msg) {
    if (typeof window.__re2003Log === 'function') window.__re2003Log(msg);
  }

  let lastPadStatus = null;
  function setPadStatus(msg, warn) {
    /* the status poller runs every rAF forever — only touch the DOM when
       the message actually changes */
    const key = `${warn ? 1 : 0}|${msg}`;
    if (key === lastPadStatus) return;
    lastPadStatus = key;
    const el = document.getElementById('vp-pad-status');
    if (el) {
      el.textContent = msg;
      el.classList.toggle('warn', !!warn);
    }
  }

  function connectedPads() {
    const list = [];
    if (!padApiReady()) return list;
    for (const pad of navigator.getGamepads()) {
      if (pad && pad.connected) list.push(pad);
    }
    return list;
  }

  function updatePadStatus(extra) {
    if (!navigator.getGamepads) {
      setPadStatus('Controller support is not available in this browser.', true);
      return;
    }
    const pads = connectedPads();
    if (!pads.length) {
      setPadStatus(extra || 'No controller yet — click here, then press any controller button (tab must be focused).', true);
      return;
    }
    const p = pads[0];
    const base = `Connected: ${shortPadId(p)} (${p.buttons.length} btns, ${p.axes.length} axes)`;
    setPadStatus(extra ? `${base} - ${extra}` : `${base}. Click a binding, then press/move input.`, false);
  }

  function eachPad(fn) {
    if (!padApiReady()) return;
    const pads = navigator.getGamepads();
    for (let pi = 0; pi < pads.length; pi++) {
      const pad = pads[pi];
      if (pad && pad.connected) fn(pad, pi);
    }
  }

  function btnValue(b) {
    if (!b) return 0;
    if (typeof b.value === 'number') return b.value;
    return b.pressed ? 1 : 0;
  }

  function capturePadState() {
    const snap = { buttons: [], axes: [] };
    eachPad((pad, pi) => {
      const bs = [], ax = [];
      for (let i = 0; i < pad.buttons.length; i++) bs.push(btnValue(pad.buttons[i]));
      for (let i = 0; i < pad.axes.length; i++) ax.push(pad.axes[i] || 0);
      snap.buttons[pi] = bs;
      snap.axes[pi] = ax;
    });
    return snap;
  }

  function listeningPad() {
    return !!(listen && (listen.kind === 'padBtn' || listen.kind === 'padAxis'));
  }

  function cancelListen() {
    if (listen && listen.btnEl) {
      const el = listen.btnEl;
      el.classList.remove('listening');
      if (el.dataset.prevText) {
        el.textContent = el.dataset.prevText;
        delete el.dataset.prevText;
      }
    }
    listen = null;
    if (listenRaf) { cancelAnimationFrame(listenRaf); listenRaf = 0; }
    document.querySelectorAll('.vp-ctrl-bind.listening').forEach((el) => {
      el.classList.remove('listening');
      if (el.dataset.prevText) {
        el.textContent = el.dataset.prevText;
        delete el.dataset.prevText;
      }
    });
    updatePadStatus();
  }

  function startListen(kind, field, btn) {
    if ((kind === 'padBtn' || kind === 'padAxis') && !padApiReady()) {
      setPadStatus('Controller API unavailable in this browser.', true);
      emitLog('Controller API unavailable in this browser.');
      return;
    }
    cancelListen();
    padWake();
    listen = { kind, field, t0: performance.now(), snap0: capturePadState(), btnEl: btn || null };
    if (btn) {
      btn.classList.add('listening');
      btn.dataset.prevText = btn.textContent;
      btn.textContent = BIND_LABEL[kind] || '…';
    }
    if (kind === 'padBtn') pollPadButton();
    else if (kind === 'padAxis') pollPadAxis();
    else updatePadStatus('Press a key…');
  }

  function pollPadButton() {
    if (!listen || listen.kind !== 'padBtn') return;
    const ready = performance.now() - listen.t0 >= ARM_MS;
    let hint = '';
    let captured = false;
    eachPad((pad, pi) => {
      for (let i = 0; i < pad.buttons.length; i++) {
        const v = btnValue(pad.buttons[i]);
        const base = (listen.snap0.buttons[pi] && listen.snap0.buttons[pi][i]) || 0;
        if (v > BTN_MIN) hint = `Btn ${i} = ${v.toFixed(2)}`;
        if (!ready || captured) continue;
        if (v >= BTN_MIN && v > base + BTN_DELTA) {
          cfg.pad[listen.field] = i;
          save();
          emitLog(`Mapped ${listen.field} → ${labelBtn(i)}`);
          cancelListen();
          captured = true;
          return;
        }
      }
    });
    if (listen && listen.btnEl && hint) listen.btnEl.textContent = hint;
    else if (listen && listen.btnEl && ready) listen.btnEl.textContent = 'Press button…';
    if (listen) listenRaf = requestAnimationFrame(pollPadButton);
  }

  /* pedal-axis listens also accept the trigger-as-BUTTON case: on the
     browser "standard" mapping an Xbox trigger is analog button 6/7 and no
     axis moves at all — pulling it during "Move stick/axis…" captured
     nothing ("my triggers don't map"). If the biggest mover is a button,
     bind the companion button field and disable the axis (−1). */
  const AXIS_COMPANION_BTN = { throttleAxis: 'throttleBtn', brakeAxis: 'brakeBtn' };
  function pollPadAxis() {
    if (!listen || listen.kind !== 'padAxis') return;
    const ready = performance.now() - listen.t0 >= ARM_MS;
    let bestIdx = -1;
    let bestVal = 0;
    let bestBase = 0;
    let bestRaw = 0;
    let bestBtnIdx = -1;
    let bestBtnVal = 0;
    let hint = '';
    const companion = AXIS_COMPANION_BTN[listen.field];
    eachPad((pad, pi) => {
      for (let i = 0; i < pad.axes.length; i++) {
        const raw = pad.axes[i] || 0;
        const baseRaw = (listen.snap0.axes[pi] && listen.snap0.axes[pi][i]) || 0;
        const delta = Math.abs(raw - baseRaw);
        if (delta > 0.06) hint = `Axis ${i} = ${raw.toFixed(2)} (Δ${delta.toFixed(2)})`;
        if (!ready) continue;
        if (delta > bestVal && delta >= AXIS_DELTA) {
          bestVal = delta;
          bestIdx = i;
          bestBase = baseRaw;
          bestRaw = raw;
        }
      }
      if (!companion) return;
      for (let i = 0; i < pad.buttons.length; i++) {
        const v = btnValue(pad.buttons[i]);
        const base = (listen.snap0.buttons[pi] && listen.snap0.buttons[pi][i]) || 0;
        const delta = v - base;
        if (v > BTN_MIN && delta > 0.06) hint = `Btn ${i} = ${v.toFixed(2)}`;
        if (!ready) continue;
        if (delta >= BTN_DELTA && v >= BTN_MIN && delta > bestBtnVal) {
          bestBtnVal = delta;
          bestBtnIdx = i;
        }
      }
    });
    if (listen && listen.btnEl && hint) listen.btnEl.textContent = hint;
    else if (listen && listen.btnEl && ready) listen.btnEl.textContent = 'Move stick/axis…';
    if (ready && (bestIdx >= 0 || bestBtnIdx >= 0)) {
      if (bestVal >= bestBtnVal && bestIdx >= 0) {
        cfg.pad[listen.field] = bestIdx;
        if (companion) {
          /* pedal axis: remember where it RESTS and which way it travels —
             the runtime maps it exactly instead of guessing the range */
          cfg.pad[listen.field + 'Rest'] = bestBase;
          cfg.pad[listen.field + 'Dir'] = bestRaw > bestBase ? 1 : -1;
        }
        emitLog(`Mapped ${listen.field} → ${labelAxis(bestIdx)}`);
      } else {
        cfg.pad[companion] = bestBtnIdx;
        cfg.pad[listen.field] = -1;   /* trigger is a button on this pad */
        cfg.pad[listen.field + 'Rest'] = null;
        cfg.pad[listen.field + 'Dir'] = 0;
        emitLog(`Mapped ${companion} → ${labelBtn(bestBtnIdx)} - this trigger is an analog button, not an axis; the axis row now points at it.`);
      }
      save();
      cancelListen();
      return;
    }
    if (listen) listenRaf = requestAnimationFrame(pollPadAxis);
  }

  function pollPadStatus() {
    if (listeningPad()) return;
    padWake();
    const pads = connectedPads();
    if (!pads.length) {
      updatePadStatus();
      statusRaf = requestAnimationFrame(pollPadStatus);
      return;
    }
    let live = '';
    const pad = pads[0];
    for (let i = 0; i < pad.buttons.length; i++) {
      const v = btnValue(pad.buttons[i]);
      if (v > 0.1) { live = `button ${i} (${v.toFixed(2)})`; break; }
    }
    if (!live) {
      for (let i = 0; i < pad.axes.length; i++) {
        const v = pad.axes[i] || 0;
        if (Math.abs(v) > 0.12) { live = `axis ${i} (${v.toFixed(2)})`; break; }
      }
    }
    updatePadStatus(live ? `saw ${live}` : null);
    statusRaf = requestAnimationFrame(pollPadStatus);
  }

  function startStatusPoll() {
    if (statusRaf) return;
    statusRaf = requestAnimationFrame(pollPadStatus);
  }

  function stopStatusPoll() {
    if (statusRaf) { cancelAnimationFrame(statusRaf); statusRaf = 0; }
  }

  function bindPadWake() {
    if (padWakeBound) return;
    padWakeBound = true;
    const wake = () => { padWake(); updatePadStatus(); };
    window.addEventListener('gamepadconnected', (e) => {
      wake();
      const gp = e.gamepad;
      emitLog(`Controller connected: ${shortPadId(gp)} (${gp.buttons.length} buttons, ${gp.axes.length} axes)`);
      syncUI();   /* re-label bindings with the pad's real button names */
    });
    window.addEventListener('gamepaddisconnected', () => { updatePadStatus('controller disconnected'); });
    document.addEventListener('pointerdown', wake, true);
    window.addEventListener('keydown', wake);
    const statusEl = document.getElementById('vp-pad-status');
    if (statusEl) {
      statusEl.addEventListener('click', () => { padWake(); updatePadStatus(); emitLog('Controller wake — press any controller button.'); });
    }
    updatePadStatus();
    startStatusPoll();
  }

  function onDocKey(e) {
    if (!listen || listen.kind !== 'key') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (e.key === 'Escape') { cancelListen(); return; }
    cfg.keys[listen.field] = keyId(e);
    save();
    cancelListen();
    e.preventDefault();
    e.stopPropagation();
  }

  function row(label, bindId, value) {
    return `<div class="vp-ctrl-row"><span>${label}</span><button type="button" class="vp-ctrl-bind" data-bind="${bindId}">${value}</button></div>`;
  }

  function syncUI() {
    const root = document.getElementById('vp-ctrl-keys');
    if (!root) return;
    const k = cfg.keys;
    const p = cfg.pad;
    root.innerHTML =
      row('Throttle', 'key:throttle', labelKey(k.throttle)) +
      row('Brake / Reverse', 'key:brake', labelKey(k.brake)) +
      row('Steer left', 'key:steerLeft', labelKey(k.steerLeft)) +
      row('Steer right', 'key:steerRight', labelKey(k.steerRight)) +
      row('Respawn', 'key:respawn', labelKey(k.respawn)) +
      row('4-wheel lock-up', 'key:lockUp', labelKey(k.lockUp)) +
      '<div class="vp-ctrl-divider">Controller</div>' +
      row('Steer axis', 'padAxis:steerAxis', labelAxis(p.steerAxis)) +
      row('Throttle button', 'padBtn:throttleBtn', labelBtn(p.throttleBtn)) +
      row('Throttle axis', 'padAxis:throttleAxis',
        p.throttleAxis >= 0 ? labelAxis(p.throttleAxis) : `uses ${labelBtn(p.throttleBtn)}`) +
      row('Brake button', 'padBtn:brakeBtn', labelBtn(p.brakeBtn)) +
      row('Brake axis', 'padAxis:brakeAxis',
        p.brakeAxis >= 0 ? labelAxis(p.brakeAxis) : `uses ${labelBtn(p.brakeBtn)}`) +
      row('Respawn button', 'padBtn:respawnBtn', labelBtn(p.respawnBtn)) +
      row('Lock-up button', 'padBtn:lockUpBtn', labelBtn(p.lockUpBtn)) +
      row('Orbit H axis', 'padAxis:orbitAxis', labelAxis(p.orbitAxis)) +
      row('Orbit V axis', 'padAxis:orbitAxisV', labelAxis(p.orbitAxisV));

    const dead = document.getElementById('vp-pad-dead');
    const deadVal = document.getElementById('vp-pad-dead-val');
    if (dead) { dead.value = p.deadZone; if (deadVal) deadVal.textContent = p.deadZone.toFixed(2); }

    const inv = document.getElementById('vp-pad-invert');
    if (inv) inv.checked = !!p.steerInvert;

    const oinv = document.getElementById('vp-pad-orbit-invert');
    if (oinv) oinv.checked = !!p.orbitInvert;

    for (const [id, field] of AID_CHECKBOXES) {
      const el = document.getElementById(id);
      if (el) el.checked = !!cfg.aids[field];
    }
    syncAeroUI();
    root.querySelectorAll('.vp-ctrl-bind').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const spec = btn.dataset.bind;
        if (!spec) return;
        const colon = spec.indexOf(':');
        const kind = spec.slice(0, colon);
        const field = spec.slice(colon + 1);
        if (kind === 'key') startListen('key', field, btn);
        else if (kind === 'padBtn') startListen('padBtn', field, btn);
        else if (kind === 'padAxis') startListen('padAxis', field, btn);
      });
    });
  }

  function bindUI() {
    bindPadWake();
    document.addEventListener('keydown', onDocKey, true);
    syncUI();

    const dead = document.getElementById('vp-pad-dead');
    if (dead) dead.addEventListener('input', (e) => {
      cfg.pad.deadZone = parseFloat(e.target.value) || DEFAULTS.pad.deadZone;
      save();
    });

    const inv = document.getElementById('vp-pad-invert');
    if (inv) inv.addEventListener('change', (e) => {
      cfg.pad.steerInvert = e.target.checked;
      save();
    });
    const oinv = document.getElementById('vp-pad-orbit-invert');
    if (oinv) oinv.addEventListener('change', (e) => {
      cfg.pad.orbitInvert = e.target.checked;
      save();
    });
    for (const [id, field] of AID_CHECKBOXES) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', (e) => {
        cfg.aids = { ...cfg.aids, [field]: e.target.checked };
        save();
        document.dispatchEvent(new CustomEvent('re2003-aids-change', { detail: cfg.aids }));
      });
    }
    const drag = document.getElementById('vp-aero-drag');
    if (drag) drag.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      cfg.aero = { ...cfg.aero, dragScale: Number.isFinite(v) ? v : DEFAULTS.aero.dragScale };
      const dragVal = document.getElementById('vp-aero-drag-val');
      if (dragVal) dragVal.textContent = cfg.aero.dragScale.toFixed(2) + '×';
      save();
      document.dispatchEvent(new CustomEvent('re2003-aero-change', { detail: cfg.aero }));
    });

    const blow = document.getElementById('vp-aero-blowover');
    if (blow) blow.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      cfg.aero = { ...cfg.aero, blowoverScale: Number.isFinite(v) ? v : DEFAULTS.aero.blowoverScale };
      const blowVal = document.getElementById('vp-aero-blowover-val');
      if (blowVal) blowVal.textContent = cfg.aero.blowoverScale.toFixed(2) + '×';
      save();
      document.dispatchEvent(new CustomEvent('re2003-aero-change', { detail: cfg.aero }));
    });

    const flaps = document.getElementById('vp-aero-flaps');
    if (flaps) flaps.addEventListener('change', (e) => {
      cfg.aero = { ...cfg.aero, roofFlaps: e.target.checked };
      save();
      document.dispatchEvent(new CustomEvent('re2003-aero-change', { detail: cfg.aero }));
    });

    const flapsEff = document.getElementById('vp-aero-flaps-eff');
    if (flapsEff) flapsEff.addEventListener('change', (e) => {
      cfg.aero = { ...cfg.aero, flapsEffective: e.target.checked };
      save();
      document.dispatchEvent(new CustomEvent('re2003-aero-change', { detail: cfg.aero }));
    });

    /* flow-smoke stream: the viewer reads cfg.smoke every frame, so these
       only have to persist + refresh their readouts */
    const smkOn = document.getElementById('vp-flow-smoke');
    if (smkOn) smkOn.addEventListener('change', (e) => {
      cfg.smoke = { ...cfg.smoke, on: e.target.checked };
      save();
    });
    const smkH = document.getElementById('vp-flow-height');
    if (smkH) smkH.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      cfg.smoke = { ...cfg.smoke, height: Number.isFinite(v) ? v : DEFAULTS.smoke.height };
      const el = document.getElementById('vp-flow-height-val');
      if (el) el.textContent = cfg.smoke.height.toFixed(2) + ' m';
      save();
    });
    const smkS = document.getElementById('vp-flow-side');
    if (smkS) smkS.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      cfg.smoke = { ...cfg.smoke, side: Number.isFinite(v) ? v : DEFAULTS.smoke.side };
      const el = document.getElementById('vp-flow-side-val');
      if (el) el.textContent = cfg.smoke.side.toFixed(1) + ' m';
      save();
    });

    /* wind / airflow shape: the viewer re-reads cfg.flow every frame, so these
       only have to persist + refresh their readout */
    for (const [id, key, fmt] of FLOW_SLIDERS) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        cfg.flow = { ...cfg.flow, [key]: Number.isFinite(v) ? v : DEFAULTS.flow[key] };
        const lab = document.getElementById(`${id}-val`);
        if (lab) lab.textContent = fmt(cfg.flow[key]);
        save();
      });
    }
    const windReset = document.getElementById('vp-wind-reset');
    if (windReset) windReset.addEventListener('click', () => {
      cfg.flow = { ...DEFAULTS.flow };
      save();                /* save() -> syncUI() -> syncFlowUI() repaints */
    });

    const resetBtn = document.getElementById('vp-ctrl-reset');
    if (resetBtn) resetBtn.addEventListener('click', reset);
  }

  return {
    get, save, reset, bindUI, keyId, labelKey, DEFAULTS, cancelListen, listeningPad, padApiReady,
  };
})();

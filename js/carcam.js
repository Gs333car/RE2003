/* RE2003 camera offsets — authored chase/cockpit defaults for the viewer.
   Reads optional MACC .cam files from user car folders (Papyrus format).
   Car-local frame: +X forward, +Y left, +Z up. */
const CarCam = (() => {
  const MAGIC = 'MACC';
  const HEADER = 12;
  const RECORD = 36;
  const LOOK_DIST = 12;
  const MACC_MODES = ['nose', 'gearbox', 'onCar', 'rollBar', 'fSusp', 'rSusp'];
  const MACC_MODE_ID = { nose: 10, gearbox: 11, onCar: 12, rollBar: 13, fSusp: 14, rSusp: 15 };

  /* Exterior camera offsets by mode index */
  const EXTERIOR = [
    [1, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
    [0, 0, 0], [0, 1, 0], [0, 0, 0], [0, 0.2, 0], [-0.5, 0, 0],
    [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
    [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
  ];

  /* Interior camera offsets */
  const INTERIOR = [
    [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
    [-1, 0.45, -0.8], [-1, 0.45, -0.8], [-1, 0.45, -0.8], [-1, 0.45, -0.8],
    [-1, 0.45, -0.8], [-1, 0.45, -0.8], [-1, 0.45, -0.8], [-1, 0.45, -0.8],
    [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
    [0, 0, 0], [0, 0, 0],
  ];

  const COCKPIT_BIAS = [0.1, 0, 0.1];
  const COCKPIT_FOV = 78.4;             /* default cockpit FOV (degrees) */

  /* Chase profile defaults */
  const CHASE = {
    near: {
      pos: [-6, 0.18, 2.25], aim: [9, 0.18, 0.1995],
      smooth: 2.25, damping: 0.2, fov: 78.4,
    },
    far: {
      pos: [-9, 0.1995, 4], aim: [12, 0.1995, 0.24],
      smooth: 4, damping: 0.2, fov: 78.4,
    },
    rear: {
      pos: [5, 0.18, 2.25], aim: [-6, 0.18, 0.1995],
      smooth: 4, damping: 0.2, fov: 78.4,
    },
  };

  let _pos, _aim, _up, _dir, _eul;
  function ensureVecs() {
    if (_pos) return;
    _pos = new THREE.Vector3();
    _aim = new THREE.Vector3();
    _up = new THREE.Vector3();
    _dir = new THREE.Vector3();
    _eul = new THREE.Euler();
  }

  function recordAim(pos, yaw, pitch, roll) {
    if (typeof THREE === 'undefined') {
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const dx = cp * cy;
      const dy = cp * sy;
      const dz = sp;
      return [pos[0] + dx * LOOK_DIST, pos[1] + dy * LOOK_DIST, pos[2] + dz * LOOK_DIST];
    }
    ensureVecs();
    _dir.set(1, 0, 0).applyEuler(_eul.set(pitch, yaw, roll, 'YXZ'));
    return [pos[0] + _dir.x * LOOK_DIST, pos[1] + _dir.y * LOOK_DIST, pos[2] + _dir.z * LOOK_DIST];
  }

  function parse(bytes) {
    if (!bytes || bytes.length < HEADER + RECORD) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== MAGIC) return null;
    const payloadLen = dv.getUint32(8, true);
    const payloadOff = HEADER;
    const payloadEnd = Math.min(bytes.byteLength, payloadOff + payloadLen);
    const records = {};
    for (let i = 0; i < MACC_MODES.length; i++) {
      const o = payloadOff + i * RECORD;
      if (o + RECORD > payloadEnd) break;
      const vals = [];
      for (let j = 0; j < 9; j++) vals.push(dv.getFloat32(o + j * 4, true));
      const pos = vals.slice(0, 3);
      const yaw = vals[3], pitch = vals[4], roll = vals[5];
      const aim = recordAim(pos, yaw, pitch, roll);
      const fov = vals[6] > 0.4 && vals[6] < 2.5 ? vals[6] * (180 / Math.PI) : 78;
      records[MACC_MODES[i]] = { pos, yaw, pitch, roll, aim, fov };
    }
    return { magic, records, mode10: records.nose || null };
  }

  function chasePreset(which) {
    return CHASE[which] || CHASE.near;
  }

  /* World-space camera pose from car-local offsets on a posed modelGroup. */
  function worldPose(modelGroup, localPos, localAim) {
    if (typeof THREE === 'undefined') return null;
    ensureVecs();
    modelGroup.updateWorldMatrix(true, false);
    _pos.set(localPos[0], localPos[1], localPos[2]).applyMatrix4(modelGroup.matrixWorld);
    _aim.set(localAim[0], localAim[1], localAim[2]).applyMatrix4(modelGroup.matrixWorld);
    _up.set(0, 0, 1).transformDirection(modelGroup.matrixWorld);
    return {
      pos: _pos.clone(),
      aim: _aim.clone(),
      up: _up.clone(),
    };
  }

  function addVec(a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  }

  function interiorPose(modeId) {
    const off = INTERIOR[modeId] || [0, 0, 0];
    const pos = addVec(off, COCKPIT_BIAS);
    const aim = [pos[0] + LOOK_DIST, pos[1], pos[2]];
    return { pos, aim, fov: COCKPIT_FOV };
  }

  /* Showroom / static snap for a named view. Returns null if data is missing. */
  function showroomView(name, modelGroup, carCam) {
    if (!modelGroup) return null;
    let local = null;
    if (name === 'chase' || name === 'drive') local = { ...chasePreset('near'), fov: chasePreset('near').fov };
    else if (name === 'farChase') local = { ...chasePreset('far'), fov: chasePreset('far').fov };
    else if (name === 'rearChase') local = { ...chasePreset('rear'), fov: chasePreset('rear').fov };
    else if (name === 'cockpit') local = interiorPose(1);
    else if (name === 'lookLeft') {
      local = interiorPose(2);
      local.aim = [local.pos[0] + 4, local.pos[1] + LOOK_DIST, local.pos[2]];
    } else if (name === 'lookRight') {
      local = interiorPose(3);
      local.aim = [local.pos[0] + 4, local.pos[1] - LOOK_DIST, local.pos[2]];
    } else if (MACC_MODES.includes(name) || name === 'hood' || name === 'nose') {
      const key = name === 'hood' ? 'nose' : name;
      const rec = carCam && carCam.records ? carCam.records[key] : null;
      if (!rec) return null;
      local = { pos: rec.pos, aim: rec.aim, fov: rec.fov };
    } else if (name === 'swingman') {
      const ext = EXTERIOR[0];
      local = { pos: [ext[0] - 4.5, ext[1] + 1.8, ext[2] + 2.2], aim: [2, 0, 0], fov: 35 };
    } else if (name === 'blimp' || name === 'zeppelin') {
      local = { pos: [-8, 0, 18], aim: [0, 0, 0], fov: 30 };
    } else return null;
    const w = worldPose(modelGroup, local.pos, local.aim);
    return { pos: w.pos, tgt: w.aim, up: w.up, fov: local.fov };
  }

  function mountVectors(rec) {
    if (typeof THREE === 'undefined') return null;
    return {
      pos: new THREE.Vector3(rec.pos[0], rec.pos[1], rec.pos[2]),
      aim: new THREE.Vector3(rec.aim[0], rec.aim[1], rec.aim[2]),
      fov: rec.fov,
    };
  }

  function chaseMount(which) {
    if (typeof THREE === 'undefined') return null;
    const p = chasePreset(which);
    return {
      pos: new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]),
      aim: new THREE.Vector3(p.aim[0], p.aim[1], p.aim[2]),
      fov: p.fov,
      smooth: p.smooth,
    };
  }

  return {
    parse, MACC_MODES, MACC_MODE_ID, CHASE, EXTERIOR, INTERIOR,
    chasePreset, chaseMount, mountVectors, showroomView, worldPose,
    MODES: MACC_MODES,
  };
})();

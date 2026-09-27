/* Cameron factory slider defaults — baked 2026-07-13 from the live RE2003 session.
   Fresh loads (no localStorage) and every Reset-to-defaults path reads this file. */
const RE2003_BAKED_DEFAULTS = {
  "ver": 1,
  "savedAt": "2026-07-13",
  "gfx": {
    "exposure": 0.9,
    "contrast": 0.26,
    "saturation": 1.0,
    "lift": 0.0,
    "mass": 1.0,
    "reflections": false,
    "reflectHigh": false,
    "reflStrength": 0.15
  },
  "steerSens": 0.6,
  "playerPeakHp": 750,
  "aiPeakHp": 750,
  "noDamage": true,
  "aiTune": {
    "speed": 1.0,
    "aggro": 0.5,
    "laneFreq": 0.0
  },
  "rideNCS22": 0.025,
  "aiParams": {
    "aDecel": 16.5,
    "brakeMargin": 0.6,
    "latG": 1.35,
    "downforceG": 0.9,
    "dfRef": 68,
    "topMps": 94,
    "lookaheadS": 0.85,
    "scanS": 2.6,
    "yawK1": 1.1,
    "yawK2": 0.42,
    "steerFF": 0.82,
    "bankHold": 0.06,
    "slipLift": 0.2,
    "spinR": 1.2,
    "recSettleLat": 6,
    "recSettleYaw": 0.8,
    "recAlign": 0.55,
    "recStuckMax": 4,
    "recWallKeep": 2.2,
    "recLockStop": 2.5,
    "latBand": 4,
    "minSide": 0.32,
    "overlapHalf": 3,
    "sepGain": 1.6,
    "sepMargin": 0.5,
    "laneJerk": 5.5,
    "spotAheadS": 1.8,
    "spotAheadMin": 50,
    "spotBehind": 45,
    "liftWindow": 4.5,
    "avoidDecel": 16,
    "carHalfW": 1,
    "draftRange": 55,
    "draftLat": 1.6,
    "draftTuck": 10,
    "draftBoost": 0.08,
    "dirtyLatG": 0.9,
    "dirtyRange": 28,
    "sideLong": 3.5,
    "sideLatMin": 2.5,
    "sideLatMax": 4.5,
    "pullClosing": 1.5,
    "pullHold": 0.6,
    "draftAccel": 3.2,
    "sideDraftAccel": 2,
    "sideDraftLeader": 0.9,
    "bumpDv": 0.55,
    "bumpGap": 3,
    "tandemAccel": 5.5,
    "aggrMin": 0.3,
    "aggrMax": 0.85,
    "skillLo": 0.94,
    "skillSpan": 0.11,
    "passHold": 1.2,
    "blockProb": 0.8,
    "laneSpacing": 3.3,
    "wallMargin": 2.6,
    "insideMargin": 4.5,
    "laneRate": 2.2
  },
  "ui": {
    "panelSectionsCollapsed": true
  },
  "driveControls": {
    "pad": {
      "deadZone": 0.12
    },
    "aero": {
      "dragScale": 1.0,
      "blowoverScale": 1.0,
      "roofFlaps": true,
      "flapsEffective": true
    },
    "smoke": {
      "on": false,
      "height": 0.85,
      "side": 0.0
    },
    "flow": {
      "roofLift": 1.20,
      "liftCut": 0.31,
      "bodyPush": 0.60,
      "downStr": 0.55,
      "downStart": 0.22,
      "downFade": 8.5,
      "wakeDef": 0.44,
      "wakeClose": 0.09,
      "underRam": 0.40
    }
  }
};

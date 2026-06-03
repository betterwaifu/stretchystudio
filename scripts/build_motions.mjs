// Generate Cubism 4 .motion3.json files for our rig + update model3.json
// to reference them so pixi-live2d-display auto-plays.
//
// Usage:
//   node scripts/build_motions.mjs <runtime_dir>
//
// Produces in <runtime_dir>/motions/:
//   idle.motion3.json     — gentle head/body sway, loops
//   wave_left.motion3.json — left arm wave (8s, single-shot)
//   bow.motion3.json       — bow forward (4s, single-shot)
// And patches <runtime_dir>/<model>.model3.json with FileReferences.Motions.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , runtimeDir] = process.argv;
if (!runtimeDir) {
  console.error('usage: node scripts/build_motions.mjs <runtime_dir>');
  process.exit(1);
}

// Build a linear-segment curve. samples = [{t, v}], time-sorted.
// Segment encoding: anchor (2 floats) + per-segment (type=0, t, v) = 3 floats.
function linearCurve(target, id, samples) {
  const segs = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (i === 0) segs.push(s.t, s.v);
    else segs.push(0, s.t, s.v);
  }
  return {
    Target: target, Id: id, Segments: segs,
    _segmentCount: Math.max(0, samples.length - 1),
    _pointCount:   samples.length,
  };
}

// Build a bezier-segment curve with ease-in/out (flat tangent at each anchor).
// Encoding: anchor (2 floats) + per-segment (type=1, cp1_t, cp1_v, cp2_t, cp2_v, t, v) = 7 floats.
function bezierEaseCurve(target, id, samples) {
  const segs = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (i === 0) {
      segs.push(s.t, s.v);
      continue;
    }
    const prev = samples[i - 1];
    const dt = s.t - prev.t;
    // Flat-tangent ease-in/out: control points at 1/3 and 2/3 of dt holding the endpoint values.
    const cp1t = prev.t + dt / 3;
    const cp1v = prev.v;
    const cp2t = s.t - dt / 3;
    const cp2v = s.v;
    segs.push(1, cp1t, cp1v, cp2t, cp2v, s.t, s.v);
  }
  return {
    Target: target, Id: id, Segments: segs,
    _segmentCount: Math.max(0, samples.length - 1),
    _pointCount:   samples.length + 2 * Math.max(0, samples.length - 1),  // anchors + control points
  };
}

// Sample a sine wave: amplitude × sin(2π × frequency × t)
function sineSamples(durationSec, fps, frequency, amplitude, phase = 0, mid = 0) {
  const steps = Math.max(2, Math.round(durationSec * fps));
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * durationSec;
    const v = mid + amplitude * Math.sin(2 * Math.PI * frequency * t + phase);
    out.push({ t, v });
  }
  return out;
}

function makeMotion(name, durationSec, loop, curves, fps = 30) {
  let totalSegments = 0, totalPoints = 0;
  for (const c of curves) {
    totalSegments += c._segmentCount ?? 0;
    totalPoints   += c._pointCount   ?? 0;
  }
  const cleanCurves = curves.map(({ _segmentCount, _pointCount, ...rest }) => rest);
  return {
    Version: 3,
    Meta: {
      Duration: durationSec,
      Fps: fps,
      Loop: loop,
      AreBeziersRestricted: true,
      CurveCount: cleanCurves.length,
      TotalSegmentCount: totalSegments,
      TotalPointCount: totalPoints,
      UserDataCount: 0,
      TotalUserDataSize: 0,
    },
    Curves: cleanCurves,
  };
}

// Anchor keyframes that wrap cleanly (last value == first) so a Loop=true motion
// transitions seamlessly. cycles per param control the rhythm.
function cyclicAnchors(durationSec, amplitude, cycles = 1, phase = 0, midline = 0, anchorsPerCycle = 6) {
  const totalAnchors = anchorsPerCycle * cycles + 1; // +1 to close the loop
  const out = [];
  for (let i = 0; i < totalAnchors; i++) {
    const t = (i / (totalAnchors - 1)) * durationSec;
    const v = midline + amplitude * Math.sin(2 * Math.PI * cycles * (i / (totalAnchors - 1)) + phase);
    out.push({ t, v });
  }
  // Snap the last value EXACTLY equal to the first so the loop is truly closed.
  out[out.length - 1].v = out[0].v;
  return out;
}

// ─── Idle: closed-loop subtle sway + breath, bezier ease ─────────────────────
// 6s loop. Head moves are small (≤5 deg on X/Y) so it doesn't look like a tennis
// match. Body sway is smaller still. Breath is the dominant visible motion.
const IDLE_DUR = 6.0;
const idle = makeMotion('idle', IDLE_DUR, true, [
  // Head: subtle, one full cycle per loop, X amplitude reduced.
  bezierEaseCurve('Parameter', 'ParamAngleX',     cyclicAnchors(IDLE_DUR,  5,  1, 0)),
  bezierEaseCurve('Parameter', 'ParamAngleY',     cyclicAnchors(IDLE_DUR,  4,  1, Math.PI / 2)),
  bezierEaseCurve('Parameter', 'ParamAngleZ',     cyclicAnchors(IDLE_DUR,  4,  1, Math.PI / 3)),
  // Body: very subtle, lags head.
  bezierEaseCurve('Parameter', 'ParamBodyAngleX', cyclicAnchors(IDLE_DUR,  2,  1, Math.PI / 4)),
  bezierEaseCurve('Parameter', 'ParamBodyAngleZ', cyclicAnchors(IDLE_DUR,  2,  1, Math.PI / 6)),
  // Breath: 2 breaths per loop, midline 0.5, full 0..1 range.
  bezierEaseCurve('Parameter', 'ParamBreath',     cyclicAnchors(IDLE_DUR,  0.5, 2, -Math.PI / 2, 0.5)),
]);

// ─── Wave: left arm raises overhead, hand swings, holds raised ────────────
// Modeled on Hiyori sample motion m03 (the canonical wave gesture):
//   • quick raise (~0.77s) to peak
//   • 3 forearm oscillations (~2s)
//   • settle to a held-raised pose; loops without dropping the arm
//   • coordinated head Z tilt ±18° + body sway ±6° (Hiyori-amplitude, not subtle)
//
// SIGN KNOBS — flip if the rig's rotation convention is reversed. Each value is
// either +1 or -1. After viewing in Cubism Editor, flip the offenders:
//   SHOULDER_DIR: +1 should raise hand AWAY from torso (outward). If it moves
//                 INWARD across the torso instead, flip to -1.
//   ELBOW_DIR:    +1 should fold the forearm toward the head (curl). Flip if
//                 forearm goes the other way.
//   HEAD_X_DIR:   sign such that head turns toward the waving hand (character's
//                 left hand = screen right). Cubism default convention is
//                 negative ParamAngleX → look to char's left, so we start at -1.
const SHOULDER_DIR = +1;
const ELBOW_DIR    = +1;
const HEAD_X_DIR   = -1;

// Elbow rotation COMPOSES with shoulder rotation (parent deformer transform is
// applied first), so total forearm rotation = shoulder + elbow. To put the
// forearm vertical (180° absolute = pointing up), we need shoulder + elbow ≈ 180.
//
// Target pose for a hello-wave:
//   • upper arm raised & leaning slightly outward, NOT straight up (~130°)
//   • forearm near vertical (absolute ≈ 180°) — so elbow ≈ 180 - 130 = 50
//   • wave swing: forearm tilts ±15° from vertical → elbow oscillates 35..65
const SHOULDER_RAISE  = 130 * SHOULDER_DIR;
const SHOULDER_HOLD   = 120 * SHOULDER_DIR;

const ELBOW_PEAK      =  50 * ELBOW_DIR;
const ELBOW_SWING_OUT =  35 * ELBOW_DIR;  // forearm tilts outward
const ELBOW_SWING_IN  =  65 * ELBOW_DIR;  // forearm tilts inward (toward face)
const ELBOW_HOLD      =  55 * ELBOW_DIR;

// Cycle: rest → raise → wave (3 swings) → lower → rest. All curves return to
// 0 at t=DUR so the loop wraps without a snap.
//   0.00–0.70  raise
//   0.70–2.70  wave (3 swings, ~0.67s each)
//   2.70–3.50  lower
//   3.50–4.20  rest pause before loop restart
const WAVE_DUR = 4.2;
const wave = makeMotion('wave_left', WAVE_DUR, true, [
  bezierEaseCurve('Parameter', 'ParamRotation_leftShoulder', [
    { t: 0.00, v: 0              },
    { t: 0.70, v: SHOULDER_RAISE },
    { t: 2.70, v: SHOULDER_RAISE },
    { t: 3.50, v: 0              },
    { t: 4.20, v: 0              },
  ]),
  bezierEaseCurve('Parameter', 'ParamRotation_leftElbow', [
    { t: 0.00, v: 0               },
    { t: 0.70, v: ELBOW_PEAK      },
    { t: 1.03, v: ELBOW_SWING_OUT },
    { t: 1.37, v: ELBOW_SWING_IN  },
    { t: 1.70, v: ELBOW_SWING_OUT },
    { t: 2.03, v: ELBOW_SWING_IN  },
    { t: 2.37, v: ELBOW_SWING_OUT },
    { t: 2.70, v: ELBOW_PEAK      },
    { t: 3.50, v: 0               },
    { t: 4.20, v: 0               },
  ]),
  // Head Z tilts back-and-forth with the wave, returns to 0.
  bezierEaseCurve('Parameter', 'ParamAngleZ', [
    { t: 0.00, v:   0 },
    { t: 1.10, v: +12 },
    { t: 1.70, v: -12 },
    { t: 2.30, v: +12 },
    { t: 2.70, v:   0 },
    { t: 4.20, v:   0 },
  ]),
  bezierEaseCurve('Parameter', 'ParamAngleX', [
    { t: 0.00, v: 0                },
    { t: 0.80, v: 12 * HEAD_X_DIR  },
    { t: 2.70, v: 12 * HEAD_X_DIR  },
    { t: 3.60, v: 0                },
    { t: 4.20, v: 0                },
  ]),
  bezierEaseCurve('Parameter', 'ParamAngleY', [
    { t: 0.00, v:  0 },
    { t: 0.80, v: +8 },
    { t: 2.70, v: +8 },
    { t: 3.60, v:  0 },
    { t: 4.20, v:  0 },
  ]),
  bezierEaseCurve('Parameter', 'ParamBodyAngleZ', [
    { t: 0.00, v:  0 },
    { t: 1.10, v: +5 },
    { t: 2.00, v: -3 },
    { t: 2.70, v: +5 },
    { t: 3.60, v:  0 },
    { t: 4.20, v:  0 },
  ]),
]);

// ─── Bow: forward body tilt ──────────────────────────────────────────────────
const bow = makeMotion('bow', 4.0, false, [
  linearCurve('Parameter', 'ParamBodyAngleY', [
    { t: 0,   v: 0 },
    { t: 0.6, v: -10 },
    { t: 2.0, v: -10 },
    { t: 2.8, v: 0 },
    { t: 4.0, v: 0 },
  ]),
  linearCurve('Parameter', 'ParamAngleY', [
    { t: 0,   v: 0 },
    { t: 0.6, v: -30 },
    { t: 2.0, v: -30 },
    { t: 2.8, v: 0 },
    { t: 4.0, v: 0 },
  ]),
]);

// ─── Write files ────────────────────────────────────────────────────────────
const motionsDir = join(runtimeDir, 'motions');
mkdirSync(motionsDir, { recursive: true });

writeFileSync(join(motionsDir, 'idle.motion3.json'), JSON.stringify(idle, null, 2));
writeFileSync(join(motionsDir, 'wave_left.motion3.json'), JSON.stringify(wave, null, 2));
writeFileSync(join(motionsDir, 'bow.motion3.json'), JSON.stringify(bow, null, 2));
console.log('[motions] wrote idle, wave_left, bow');

// Patch model3.json
const model3Files = readdirSync(runtimeDir).filter(f => f.endsWith('.model3.json'));
if (model3Files.length !== 1) {
  console.error('expected exactly one .model3.json in', runtimeDir, 'got:', model3Files);
  process.exit(2);
}
const model3Path = join(runtimeDir, model3Files[0]);
const model3 = JSON.parse(readFileSync(model3Path, 'utf8'));
model3.FileReferences = model3.FileReferences || {};
model3.FileReferences.Motions = {
  Idle: [{ File: 'motions/idle.motion3.json' }],
  TapBody: [{ File: 'motions/wave_left.motion3.json' }],
  Bow: [{ File: 'motions/bow.motion3.json' }],
};
writeFileSync(model3Path, JSON.stringify(model3, null, 2));
console.log('[motions] patched', model3Path);

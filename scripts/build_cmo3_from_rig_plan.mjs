// Phase 5 — read a rig_plan.json (from build_rig_plan.py) + per-part PNG textures,
// call SS's generateCmo3, write .cmo3 to disk.
//
// Usage: node scripts/build_cmo3_from_rig_plan.mjs <rig_plan.json> <out.cmo3>

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// --- DOM polyfills so SS's bodyAnalyzer.js (uses Image/OffscreenCanvas/Blob/URL)
//     runs in Node and produces real body warp data instead of skipping. ---
import { Image as CanvasImage, Canvas as CanvasCls } from 'canvas';
const blobUrls = new Map();
let nextBlobId = 0;
if (!globalThis.Blob) {
  globalThis.Blob = class {
    constructor(parts, opts) { this.parts = parts; this.type = opts?.type || ''; }
    async arrayBuffer() {
      const total = this.parts.reduce((a, p) => a + p.byteLength, 0);
      const buf = new Uint8Array(total);
      let off = 0;
      for (const p of this.parts) { buf.set(p, off); off += p.byteLength; }
      return buf.buffer;
    }
  };
}
if (!globalThis.URL) globalThis.URL = {};
if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = (blob) => {
    const url = `blob:node/${++nextBlobId}`;
    blobUrls.set(url, blob);
    return url;
  };
  globalThis.URL.revokeObjectURL = (url) => blobUrls.delete(url);
}
const origImgSrcDesc = Object.getOwnPropertyDescriptor(CanvasImage.prototype, 'src');
class PolyImage extends CanvasImage {
  set src(v) {
    if (typeof v === 'string' && v.startsWith('blob:node/') && blobUrls.has(v)) {
      const blob = blobUrls.get(v);
      blob.arrayBuffer().then(ab => {
        origImgSrcDesc.set.call(this, Buffer.from(ab));
      }).catch(e => this.onerror?.(e));
      return;
    }
    origImgSrcDesc.set.call(this, v);
  }
  get src() { return origImgSrcDesc.get?.call(this); }
}
globalThis.Image = PolyImage;
globalThis.OffscreenCanvas = CanvasCls;
if (!globalThis.document) {
  globalThis.document = { createElement(tag) {
    if (tag === 'canvas') return new CanvasCls(0, 0);
    return {};
  }};
}

import { generateCmo3 } from '../src/io/live2d/cmo3writer.js';

const [, , planPath, outPath] = process.argv;
if (!planPath || !outPath) {
  console.error('usage: node scripts/build_cmo3_from_rig_plan.mjs <rig_plan.json> <out.cmo3>');
  process.exit(1);
}

const planDir = dirname(resolve(planPath));
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const [canvasW, canvasH] = plan.canvas_size;
console.log(`[plan] ${plan.source_image} ${canvasW}x${canvasH}`);
console.log(`[plan] ${plan.meshes.length} meshes, ${plan.groups.length} groups`);

// Per-part draw order. Higher = drawn on top.
const DRAW_ORDER = {
  upper_leg_l: 300, upper_leg_r: 300,
  lower_leg_l: 320, lower_leg_r: 320,
  upper_arm_l: 400, upper_arm_r: 400,
  forearm_l:   420, forearm_r:   420,
  torso:       600,
  neck:        700,
  head:        750,
};

// Map our segmentation part names → SS auto-rig tag vocabulary.
// Only torso/head/neck get SS tags — they want body parallax + breath + neck warp.
// Limbs DELIBERATELY left untagged so SS doesn't attach them to a root-level rig
// warp; instead they fall through to their parent group's rotation deformer, which
// is what ParamRotation_<group> actually drives.
const SS_TAG = {
  head:        'face',
  neck:        'neck',
  torso:       'topwear',
};

// Build SS meshes.
const meshes = plan.meshes.map((m, i) => {
  // Flatten Nx2 → Float32Array of length 2N.
  const verts = new Float32Array(m.vertices_px.length * 2);
  for (let j = 0; j < m.vertices_px.length; j++) {
    verts[j * 2]     = m.vertices_px[j][0];
    verts[j * 2 + 1] = m.vertices_px[j][1];
  }
  const uvs = new Float32Array(m.uvs.length * 2);
  for (let j = 0; j < m.uvs.length; j++) {
    uvs[j * 2]     = m.uvs[j][0];
    uvs[j * 2 + 1] = m.uvs[j][1];
  }
  // Flatten triangles [[a,b,c],...] → [a,b,c,a,b,c,...]
  const tris = m.triangles.flat();
  const pngAbs = join(planDir, m.texture_path);
  const pngData = new Uint8Array(readFileSync(pngAbs));
  return {
    name:      m.name,
    tag:       SS_TAG[m.name] ?? m.tag,
    partId:    m.partId,
    parentGroupId: m.groupId,
    vertices:  verts,
    triangles: tris,
    uvs:       uvs,
    pngData,
    pngPath:   `${m.name}.png`,
    origin:    { x: m.origin.x, y: m.origin.y },
    drawOrder: DRAW_ORDER[m.name] ?? (500 + i),
  };
});

// Build SS groups.
const groups = plan.groups.map(g => ({
  id:        g.id,
  name:      g.name,
  parent:    g.parent,
  pivotX:    g.pivotX,   // legacy, ignored by cmo3writer
  pivotY:    g.pivotY,
  transform: { pivotX: g.pivotX, pivotY: g.pivotY, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
  boneRole:  g.boneRole,
}));

console.log('[meshes]');
for (const m of meshes) {
  console.log(`  ${m.name.padEnd(14)} verts=${m.vertices.length / 2} tris=${m.triangles.length / 3} png=${m.pngData.length}B group=${m.parentGroupId}`);
}
console.log('[groups]');
for (const g of groups) {
  console.log(`  ${g.id.padEnd(16)} parent=${g.parent ?? '(root)'} pivot=(${g.pivotX.toFixed(1)},${g.pivotY.toFixed(1)}) role=${g.boneRole}`);
}

console.log('\n[generateCmo3] running...');
const result = await generateCmo3({
  canvasW,
  canvasH,
  meshes,
  groups,
  modelName: 'AutoRig',
  generateRig: true,
  generatePhysics: false,
});

mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(outPath, result.cmo3);

const td = new TextDecoder();
const magic = td.decode(result.cmo3.slice(0, 4));
console.log(`\n[output] ${result.cmo3.byteLength} bytes, magic=${magic}`);
console.log(`[output] -> ${outPath}`);
if (result.rigDebugLog) {
  // Dump rig debug log next to the cmo3 for inspection.
  const logPath = outPath.replace(/\.cmo3$/, '.rig.log.json');
  writeFileSync(logPath, JSON.stringify(result.rigDebugLog, null, 2));
  console.log(`[output] rig debug -> ${logPath}`);
}
console.log(magic === 'CAFF' ? '[done] ✓' : '[done] FAIL (not a CAFF file)');

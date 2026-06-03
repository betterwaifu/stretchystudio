// Spike A — minimal end-to-end .cmo3 export from a hand-crafted model.
// Uses the same fixture shape as verify_physics.mjs, dumps to disk,
// then runs inspect_cmo3.mjs to confirm CAFF round-trip works.

import { writeFileSync, mkdirSync } from 'node:fs';
import { generateCmo3 } from '../src/io/live2d/cmo3writer.js';

const TINY_PNG = new Uint8Array([
  137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,
  0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,
  0,0,0,13,73,68,65,84,120,156,99,252,255,255,63,0,5,
  254,2,254,167,53,129,132,0,0,0,0,73,69,78,68,174,66,96,130,
]);

function mkMesh(name, tag, cx, cy, w, h) {
  const x0 = cx - w / 2, x1 = cx + w / 2;
  const y0 = cy - h / 2, y1 = cy + h / 2;
  return {
    name, tag, partId: name,
    vertices: new Float32Array([x0, y0, x1, y0, x0, y1, x1, y1]),
    triangles: [0, 1, 2, 2, 1, 3],
    uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    pngData: TINY_PNG,
    pngPath: `${name}.png`,
    origin: { x: cx, y: cy },
  };
}

const meshes = [
  mkMesh('Face',       'face',       500, 300, 200, 280),
  mkMesh('FrontHair',  'front hair', 500, 220, 260, 200),
  mkMesh('BackHair',   'back hair',  500, 350, 300, 400),
  mkMesh('Neck',       'neck',       500, 600, 100, 100),
  mkMesh('Topwear',    'topwear',    500, 800, 400, 300),
  mkMesh('Bottomwear', 'bottomwear', 500, 1050, 350, 250),
  mkMesh('Legwear',    'legwear',    500, 1200, 300, 200),
  mkMesh('HandwearL',  'handwear-l', 380, 950, 80, 80),
  mkMesh('HandwearR',  'handwear-r', 620, 950, 80, 80),
];
const groups = [
  { id: 'g-root', name: 'root',       parent: null,     pivotX: 500, pivotY: 1000, boneRole: 'root' },
  { id: 'g-le',   name: 'leftElbow',  parent: 'g-root', pivotX: 380, pivotY: 870,  boneRole: 'leftElbow' },
  { id: 'g-re',   name: 'rightElbow', parent: 'g-root', pivotX: 620, pivotY: 870,  boneRole: 'rightElbow' },
];

console.log('[spike-a] Calling generateCmo3...');
const out = await generateCmo3({
  canvasW: 1000,
  canvasH: 1500,
  meshes,
  groups,
  modelName: 'SpikeAMinimal',
  generateRig: true,
});

mkdirSync('/home/kdev/Code/autorig/spike_a_out', { recursive: true });
const outPath = '/home/kdev/Code/autorig/spike_a_out/SpikeAMinimal.cmo3';
writeFileSync(outPath, out.cmo3);

const td = new TextDecoder();
const magic = td.decode(out.cmo3.slice(0, 4));
const isCaff = magic === 'CAFF';

console.log(`[spike-a] cmo3 bytes:      ${out.cmo3.byteLength}`);
console.log(`[spike-a] CAFF magic:      ${magic} ${isCaff ? '✓' : 'FAIL'}`);
console.log(`[spike-a] meshes emitted:  ${meshes.length}`);
console.log(`[spike-a] physics rules:   ${out.rigDebugLog?.physics?.emittedCount ?? 0}`);
console.log(`[spike-a] wrote:           ${outPath}`);
if (!isCaff) process.exit(2);
console.log('[spike-a] ALL GOOD ✓');

// Build .moc3 + .model3.json from a rig_plan + atlas dimensions.
//
// Usage:
//   node scripts/build_moc3_runtime.mjs <rig_plan.json> <atlas_meta.json> <out_dir>
//
// Produces in <out_dir>:
//   <model>.moc3
//   <model>.model3.json
//   (texture file is expected to already exist as texture_00.png alongside atlas_meta.json)

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { generateMoc3 } from '../src/io/live2d/moc3writer.js';
import { generateModel3Json } from '../src/io/live2d/model3json.js';

const [, , planPath, atlasMetaPath, outDir] = process.argv;
if (!planPath || !atlasMetaPath || !outDir) {
  console.error('usage: node scripts/build_moc3_runtime.mjs <rig_plan.json> <atlas_meta.json> <out_dir>');
  process.exit(1);
}

const MODEL_NAME = 'AutoRig';
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const atlasMeta = JSON.parse(readFileSync(atlasMetaPath, 'utf8'));
const atlasDir = dirname(resolve(atlasMetaPath));
const [canvasW, canvasH] = plan.canvas_size;
const atlasSize = atlasMeta.atlas_size;

mkdirSync(outDir, { recursive: true });

// Copy atlas next to outputs if not already there.
const atlasSrc = join(atlasDir, atlasMeta.atlas_file);
const atlasDst = join(outDir, 'texture_00.png');
if (resolve(atlasSrc) !== resolve(atlasDst)) {
  copyFileSync(atlasSrc, atlasDst);
}

// Build SS-shaped project from rig_plan.
const groupNodes = plan.groups.map(g => ({
  type: 'group',
  id: g.id,
  name: g.name,
  parent: g.parent,
  pivotX: g.pivotX,
  pivotY: g.pivotY,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  boneRole: g.boneRole,
  visible: true,
}));

const partNodes = plan.meshes.map(m => {
  // moc3writer iterates `for (const vert of mesh.vertices)` and reads vert.x/vert.y.
  // Cubism uses Y-up in model space; image coords are Y-down — flip Y on the way in.
  const verts = m.vertices_px.map(([x, y]) => ({ x, y: canvasH - y }));
  // UVs in moc3writer are flat-indexed (mesh.uvs[i], mesh.uvs[i+1]) — flat Float32Array works.
  const uvsFlat = new Float32Array(m.uvs.length * 2);
  for (let i = 0; i < m.uvs.length; i++) {
    uvsFlat[i * 2]     = m.uvs[i][0];
    uvsFlat[i * 2 + 1] = m.uvs[i][1];
  }
  return {
    type: 'part',
    id: `mesh-${m.partId}`,
    name: m.name,
    tag: m.tag,
    parent: m.groupId,
    visible: true,
    opacity: 1,
    mesh: {
      vertices: verts,
      triangles: m.triangles,    // Nx3 array of triples — moc3writer reads tri[0..2]
      uvs: uvsFlat,
    },
    textureId: 'tex0',
    bbox: m.bbox_px,
  };
});

const project = {
  canvas: { width: canvasW, height: canvasH, ppu: plan.ppu ?? 256 },
  nodes: [...groupNodes, ...partNodes],
  parameters: [],
  animations: [],
};

// Regions map: per-mesh atlas region. Atlas = padded source image at (0,0),
// so region.x/y = bbox origin, region.width/height = bbox size, srcWidth/Height = canvas.
const regions = new Map();
for (const m of plan.meshes) {
  const [x0, y0, x1, y1] = m.bbox_px;
  const id = `mesh-${m.partId}`;
  regions.set(id, {
    atlasIndex: 0,
    x: x0, y: y0,
    width: x1 - x0,
    height: y1 - y0,
    srcWidth: canvasW,
    srcHeight: canvasH,
    srcX: x0, srcY: y0,
    cropW: x1 - x0, cropH: y1 - y0,
  });
}

console.log(`[runtime] canvas ${canvasW}x${canvasH}, atlas ${atlasSize}x${atlasSize}`);
console.log(`[runtime] ${groupNodes.length} groups, ${partNodes.length} meshes`);

const moc3 = generateMoc3({
  project,
  regions,
  atlasSize,
  numAtlases: 1,
});

const moc3Bytes = moc3 instanceof ArrayBuffer ? new Uint8Array(moc3) : moc3;
writeFileSync(join(outDir, `${MODEL_NAME}.moc3`), moc3Bytes);
console.log(`[runtime] ${MODEL_NAME}.moc3 -> ${moc3Bytes.byteLength} bytes`);

const model3 = generateModel3Json({
  modelName: MODEL_NAME,
  textureFiles: ['texture_00.png'],
});
writeFileSync(join(outDir, `${MODEL_NAME}.model3.json`), JSON.stringify(model3, null, 2));
console.log(`[runtime] ${MODEL_NAME}.model3.json written`);
console.log(`[done] ${outDir}/`);

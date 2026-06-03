// Dump the raw main.xml from cmo3 generation to inspect param ranges.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Image as CanvasImage, Canvas as CanvasCls } from 'canvas';

const blobUrls = new Map();
let nextBlobId = 0;
if (!globalThis.Blob) globalThis.Blob = class {
  constructor(parts, opts) { this.parts = parts; this.type = opts?.type||''; }
  async arrayBuffer() { const total=this.parts.reduce((a,p)=>a+p.byteLength,0); const buf=new Uint8Array(total); let off=0; for(const p of this.parts){buf.set(p,off);off+=p.byteLength;} return buf.buffer; }
};
if (!globalThis.URL) globalThis.URL = {};
if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = (blob)=>{ const url=`blob:node/${++nextBlobId}`; blobUrls.set(url,blob); return url; };
  globalThis.URL.revokeObjectURL = (url)=>blobUrls.delete(url);
}
const origImgSrcDesc = Object.getOwnPropertyDescriptor(CanvasImage.prototype, 'src');
class PolyImage extends CanvasImage {
  set src(v){if(typeof v==='string'&&v.startsWith('blob:node/')&&blobUrls.has(v)){const blob=blobUrls.get(v); blob.arrayBuffer().then(ab=>{origImgSrcDesc.set.call(this,Buffer.from(ab));}).catch(e=>this.onerror?.(e));return;} origImgSrcDesc.set.call(this,v);}
  get src(){return origImgSrcDesc.get?.call(this);}
}
globalThis.Image = PolyImage;
globalThis.OffscreenCanvas = CanvasCls;
if (!globalThis.document) globalThis.document = { createElement(tag){if(tag==='canvas')return new CanvasCls(0,0); return {};}};

import * as caff from '../src/io/live2d/caffPacker.js';
import { generateCmo3 } from '../src/io/live2d/cmo3writer.js';

const origPack = caff.packCaff;
Object.defineProperty(caff,'packCaff',{value: async (files,key)=>{
  const xmlFile = files.find(f=>f.path==='main.xml');
  if (xmlFile) writeFileSync('/tmp/dumped_main.xml', xmlFile.content);
  console.log('[dump] wrote /tmp/dumped_main.xml (' + (xmlFile?xmlFile.content.length:0) + ' bytes)');
  return origPack(files, key);
}, writable:true, configurable:true});

const planPath = '/home/kdev/Code/autorig/mesh_gen/out/image2/rig_plan.json';
const planDir = dirname(resolve(planPath));
const plan = JSON.parse(readFileSync(planPath,'utf8'));
const [canvasW,canvasH] = plan.canvas_size;
const meshes = plan.meshes.map((m,i)=>{
  const verts=new Float32Array(m.vertices_px.length*2);
  for(let j=0;j<m.vertices_px.length;j++){verts[j*2]=m.vertices_px[j][0]; verts[j*2+1]=m.vertices_px[j][1];}
  const uvs=new Float32Array(m.uvs.length*2);
  for(let j=0;j<m.uvs.length;j++){uvs[j*2]=m.uvs[j][0]; uvs[j*2+1]=m.uvs[j][1];}
  const tris=m.triangles.flat();
  const pngAbs=join(planDir,m.texture_path);
  const pngData=new Uint8Array(readFileSync(pngAbs));
  return {name:m.name, tag:({head:'face',neck:'neck',torso:'topwear'})[m.name]??m.tag, partId:m.partId, parentGroupId:m.groupId, vertices:verts, triangles:tris, uvs, pngData, pngPath:`${m.name}.png`, origin:{x:m.origin.x,y:m.origin.y}, drawOrder:500+i};
});
const groups = plan.groups.map(g=>({id:g.id,name:g.name,parent:g.parent,pivotX:g.pivotX,pivotY:g.pivotY, transform:{pivotX:g.pivotX,pivotY:g.pivotY,x:0,y:0,rotation:0,scaleX:1,scaleY:1}, boneRole:g.boneRole}));

const r = await generateCmo3({canvasW,canvasH,meshes,groups,modelName:'AutoRig',generateRig:true,generatePhysics:false});
console.log('[ok] cmo3 bytes:', r.cmo3.byteLength);

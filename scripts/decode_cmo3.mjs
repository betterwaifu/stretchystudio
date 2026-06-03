// Decode a .cmo3 — extract main.xml for inspection.
import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

const path = process.argv[2];
const data = readFileSync(path);
console.log(`size=${data.length}`);

let pos = 0;
const rb = () => data[pos++];
const ri32u = () => { const v = data.readUInt32BE(pos); pos += 4; return v; };
const ri64u = () => { const v = data.readBigUInt64BE(pos); pos += 8; return v; };
const skip = (n) => { pos += n; };

// XOR-aware reads
function rByteXor(k) { return rb() ^ (k & 0xFF); }
function rInt32Xor(k) { return (ri32u() ^ (k >>> 0)) >>> 0; }
function rInt64Xor(k) {
  const mask = ((BigInt(k >>> 0)) | (BigInt(k >>> 0) << 32n)) & 0xFFFFFFFFFFFFFFFFn;
  return ri64u() ^ mask;
}
// variable length number, each byte XOR'd with k&0xFF
function rNumber(k) {
  let b = rByteXor(k);
  let v = b & 0x7F;
  while (b & 0x80) {
    b = rByteXor(k);
    v = (v << 7) | (b & 0x7F);
  }
  return v;
}
function rString(k) {
  const len = rNumber(k);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = rb() ^ (k & 0xFF);
  return out.toString('utf8');
}

// Header
const magic = data.slice(0, 4).toString();
pos = 4;
skip(3);
const fmt = data.slice(pos, pos+4).toString(); pos += 4;
skip(3);
const key = ri32u();  // written without XOR
console.log(`magic=${magic} fmt=${fmt} key=${key}`);
skip(8);

// Preview block
rb(); rb();  // 127, 127
skip(2);
data.readUInt16BE(pos); pos += 2;
data.readUInt16BE(pos); pos += 2;
ri64u();
ri32u();
skip(8);

const fileCount = rInt32Xor(key);
console.log(`files=${fileCount}`);

const entries = [];
for (let i = 0; i < fileCount; i++) {
  const path_ = rString(key);
  const tag = rString(key);
  const startPos = Number(rInt64Xor(key));
  const size = rInt32Xor(key);
  const obf = rByteXor(key);
  const compress = rByteXor(key);
  skip(8);
  entries.push({ path: path_, tag, startPos, size, obfuscated: !!obf, compress });
}

for (const e of entries) {
  console.log(`  ${e.path.padEnd(30)} tag=${e.tag.padEnd(10)} start=${e.startPos} size=${e.size} obf=${e.obfuscated} compress=${e.compress}`);
  if (e.path === 'main.xml') {
    const chunk = data.slice(e.startPos, e.startPos + e.size);
    let decoded;
    if (e.obfuscated) {
      decoded = Buffer.alloc(chunk.length);
      for (let i = 0; i < chunk.length; i++) decoded[i] = chunk[i] ^ (key & 0xFF);
    } else decoded = chunk;
    let raw;
    if (e.compress === 16) raw = decoded;
    else {
      // compress=33 = ZIP container around deflate-raw. Parse local file header.
      const sig = decoded.readUInt32LE(0);
      if (sig !== 0x04034b50) { console.log('bad zip sig:', sig.toString(16)); raw = decoded; }
      else {
        const method = decoded.readUInt16LE(8);
        const compSize = decoded.readUInt32LE(18);
        const nameLen = decoded.readUInt16LE(26);
        const extraLen = decoded.readUInt16LE(28);
        const dataOff = 30 + nameLen + extraLen;
        const comp = decoded.slice(dataOff, dataOff + compSize);
        if (method === 0) raw = comp;
        else raw = zlib.inflateRawSync(comp);
      }
    }
    writeFileSync('/tmp/dumped_main.xml', raw);
    console.log(`[ok] wrote /tmp/dumped_main.xml (${raw.length} bytes)`);
  }
}

// png-squeeze v2 — fresh implementation from DESIGN-v2.md
// Node 22, built-in modules only. Deterministic: no clock, no random.
// Pipeline: parse PNG -> analyse colours -> candidate colour forms ->
// filter candidates (fixed 0..4, minsum, pairs, brute) screened by zlib-6
// -> Huffman-cost filter refinement on top candidates -> final deflate:
// iterative lazy optimal-parse (zopfli-style cost re-estimation) + block
// splitting, always compared against zlib-9 / Z_RLE / Z_FILTERED, smallest wins.
// Verify by inflate+unfilter+expand before writing.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';

const W = 1280, H = 720, NP = W * H;
const IDS = ['i001', 'i002', 'i003', 'i004', 'i005', 'i006', 'i007', 'i008'];

// ---------- CRC32 / Adler32 ----------
const CRC_T = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_T[n] = c >>> 0;
}
function crc32(buf, off, len) {
  let c = 0xFFFFFFFF;
  for (let i = off; i < off + len; i++) c = CRC_T[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length;) {
    const end = Math.min(i + 5552, buf.length);
    for (; i < end; i++) { a += buf[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------- PNG decode (bit depth 8, any colour type) ----------
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}
function unfilter(data, stride, bpp) {
  const out = new Uint8Array(H * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < H; y++) {
    const ro = y * (stride + 1), wo = y * stride, ft = data[ro];
    const row = out.subarray(wo, wo + stride);
    for (let x = 0; x < stride; x++) {
      const v = data[ro + 1 + x];
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let r;
      if (ft === 0) r = v;
      else if (ft === 1) r = v + a;
      else if (ft === 2) r = v + b;
      else if (ft === 3) r = v + ((a + b) >> 1);
      else r = v + paeth(a, b, c);
      row[x] = r & 255;
    }
    prev = row;
  }
  return out;
}
function decodePng(buf) {
  let pos = 8, w = 0, h = 0, ct = 6, idat = [], plte = null, trns = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'PLTE') plte = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = ct === 0 ? 1 : ct === 2 ? 3 : ct === 3 ? 1 : ct === 4 ? 2 : 4;
  const stride = W * bpp;
  const plane = unfilter(raw, stride, bpp);
  const rgba = new Uint8Array(NP * 4);
  if (ct === 6) { rgba.set(plane); }
  else if (ct === 2) {
    for (let i = 0, j = 0; i < NP; i++, j += 3) {
      rgba[i * 4] = plane[j]; rgba[i * 4 + 1] = plane[j + 1]; rgba[i * 4 + 2] = plane[j + 2]; rgba[i * 4 + 3] = 255;
    }
  } else if (ct === 0) {
    for (let i = 0; i < NP; i++) { const g = plane[i]; rgba[i * 4] = g; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = 255; }
  } else if (ct === 4) {
    for (let i = 0, j = 0; i < NP; i++, j += 2) { const g = plane[j]; rgba[i * 4] = g; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = plane[j + 1]; }
  } else if (ct === 3) {
    for (let i = 0; i < NP; i++) {
      const idx = plane[i];
      rgba[i * 4] = plte[idx * 3]; rgba[i * 4 + 1] = plte[idx * 3 + 1]; rgba[i * 4 + 2] = plte[idx * 3 + 2];
      rgba[i * 4 + 3] = (trns && idx < trns.length) ? trns[idx] : 255;
    }
  }
  // tRNS for CT0/CT2: key colour becomes transparent
  if (trns && (ct === 0 || ct === 2)) {
    if (ct === 0) {
      const key = trns[1];
      for (let i = 0; i < NP; i++) if (rgba[i * 4] === key) rgba[i * 4 + 3] = 0;
    } else {
      const kr = trns[1], kg = trns[3], kb = trns[5];
      for (let i = 0; i < NP; i++) if (rgba[i * 4] === kr && rgba[i * 4 + 1] === kg && rgba[i * 4 + 2] === kb) rgba[i * 4 + 3] = 0;
    }
  }
  return rgba;
}

// ---------- PNG encode ----------
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 4 + data.length), 8 + data.length);
  return out;
}
function encodePng(ct, plte, trns, idat) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = ct; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (plte) parts.push(chunk('PLTE', plte));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---------- Filtering ----------
function filterRow(type, cur, prev, bpp, out, off) {
  const n = cur.length;
  out[off] = type;
  if (type === 0) { for (let x = 0; x < n; x++) out[off + 1 + x] = cur[x]; return; }
  for (let x = 0; x < n; x++) {
    const v = cur[x];
    const a = x >= bpp ? cur[x - bpp] : 0;
    const b = prev ? prev[x] : 0;
    const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
    let p;
    if (type === 1) p = a;
    else if (type === 2) p = b;
    else if (type === 3) p = (a + b) >> 1;
    else p = paeth(a, b, c);
    out[off + 1 + x] = (v - p) & 255;
  }
}
function filterImage(raw, bpp, types) {
  const stride = W * bpp;
  const out = new Uint8Array(H * (stride + 1));
  const zero = new Uint8Array(stride);
  for (let y = 0; y < H; y++) {
    const cur = raw.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : zero;
    filterRow(types[y], cur, prev, bpp, out, y * (stride + 1));
  }
  return out;
}
// choose per-row filter in ONE pass: all 5 residuals computed in a single
// loop over the row. mode: 'minsum' | 'pairs' | Float64Array (Huffman costs per byte).
const PAIR_SEEN2 = new Int32Array(5 * 65536);
function choosePerRow(raw, bpp, mode) {
  const stride = W * bpp;
  const types = new Uint8Array(H);
  const zero = new Uint8Array(stride);
  const isCost = mode instanceof Float64Array;
  let prevRow = null;
  for (let y = 0; y < H; y++) {
    const cur = raw.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : zero;
    if (prevRow) {
      let same = true;
      for (let x = 0; x < stride; x++) if (cur[x] !== prevRow[x]) { same = false; break; }
      if (same) { types[y] = 2; prevRow = cur; continue; }
    }
    const costs = [0, 0, 0, 0, 0];
    if (isCost) for (let t = 0; t < 5; t++) costs[t] = mode[t];
    const prevR = [0, 0, 0, 0, 0];
    const stampBase = y * 5 + 1;
    for (let x = 0; x < stride; x++) {
      const v = cur[x];
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const cc = x >= bpp ? prev[x - bpp] : 0;
      const r0 = v, r1 = (v - a) & 255, r2 = (v - b) & 255, r3 = (v - ((a + b) >> 1)) & 255, r4 = (v - paeth(a, b, cc)) & 255;
      if (isCost) {
        costs[0] += mode[r0]; costs[1] += mode[r1]; costs[2] += mode[r2]; costs[3] += mode[r3]; costs[4] += mode[r4];
      } else if (mode === 'minsum') {
        costs[0] += r0 < 128 ? r0 : 256 - r0;
        costs[1] += r1 < 128 ? r1 : 256 - r1;
        costs[2] += r2 < 128 ? r2 : 256 - r2;
        costs[3] += r3 < 128 ? r3 : 256 - r3;
        costs[4] += r4 < 128 ? r4 : 256 - r4;
      } else {
        if (x >= 1) {
          const rs = [r0, r1, r2, r3, r4];
          for (let t = 0; t < 5; t++) {
            const p = (prevR[t] << 8) | rs[t];
            const idx = t * 65536 + p;
            if (PAIR_SEEN2[idx] !== stampBase + t) { PAIR_SEEN2[idx] = stampBase + t; costs[t]++; }
          }
        }
        prevR[0] = r0; prevR[1] = r1; prevR[2] = r2; prevR[3] = r3; prevR[4] = r4;
      }
    }
    let best = 0;
    for (let t = 1; t < 5; t++) if (costs[t] < costs[best]) best = t;
    types[y] = best;
    prevRow = cur;
  }
  return types;
}
// ---------- DEFLATE tables ----------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
function lenCode(len) {
  for (let c = 28; c >= 0; c--) if (len >= LEN_BASE[c]) return c;
  return 0;
}
function distCode(dist) {
  for (let c = 29; c >= 0; c--) if (dist >= DIST_BASE[c]) return c;
  return 0;
}

// ---------- Huffman lengths: heap Huffman + length limiting ----------
function huffmanLengths(freq, maxBits) {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  let syms = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) { lengths[syms[0]] = 1; return lengths; }
  // nodes: leaves 0..n-1, internal nodes appended
  const nodeFreq = [], nodeLeft = [], nodeRight = [], nodeSym = [];
  for (let i = 0; i < n; i++) { nodeFreq.push(freq[i]); nodeLeft.push(-1); nodeRight.push(-1); nodeSym.push(i); }
  // binary heap of node ids by (freq, id)
  const heap = syms.slice();
  const less = (a, b) => nodeFreq[a] < nodeFreq[b] || (nodeFreq[a] === nodeFreq[b] && a < b);
  const heapify = () => {
    for (let i = (heap.length >> 1) - 1; i >= 0; i--) {
      let r = i;
      for (;;) {
        const l = r * 2 + 1, rr = l + 1; let s = r;
        if (l < heap.length && less(heap[l], heap[s])) s = l;
        if (rr < heap.length && less(heap[rr], heap[s])) s = rr;
        if (s === r) break;
        const t = heap[r]; heap[r] = heap[s]; heap[s] = t; r = s;
      }
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; let r = 0;
      for (;;) { const l = r * 2 + 1, rr = l + 1; let s = r;
        if (l < heap.length && less(heap[l], heap[s])) s = l;
        if (rr < heap.length && less(heap[rr], heap[s])) s = rr;
        if (s === r) break; const t = heap[r]; heap[r] = heap[s]; heap[s] = t; r = s; } }
    return top;
  };
  const push = (id) => { heap.push(id); let r = heap.length - 1;
    while (r > 0) { const p = (r - 1) >> 1; if (!less(heap[r], heap[p])) break; const t = heap[r]; heap[r] = heap[p]; heap[p] = t; r = p; } };
  heapify();
  while (heap.length > 1) {
    const a = pop(), b = pop();
    const id = nodeFreq.length;
    nodeFreq.push(nodeFreq[a] + nodeFreq[b]); nodeLeft.push(a); nodeRight.push(b); nodeSym.push(-1);
    push(id);
  }
  const root = heap[0];
  const stack = [[root, 0]];
  while (stack.length) {
    const [id, d] = stack.pop();
    if (nodeSym[id] >= 0) lengths[nodeSym[id]] = d;
    else { stack.push([nodeLeft[id], d + 1]); stack.push([nodeRight[id], d + 1]); }
  }
  // limit lengths to maxBits, keeping Kraft <= 1 (cap, then lengthen rarest symbols)
  let kraft = 0;
  for (let i = 0; i < n; i++) if (lengths[i]) kraft += Math.pow(2, -lengths[i]);
  for (let i = 0; i < n; i++) if (lengths[i] > maxBits) lengths[i] = maxBits;
  kraft = 0;
  for (let i = 0; i < n; i++) if (lengths[i]) kraft += Math.pow(2, -lengths[i]);
  let guard = 0;
  while (kraft > 1 + 1e-12 && guard++ < 10000) {
    // lengthen the rarest symbol whose length < maxBits
    let best = -1, bestF = Infinity;
    for (let i = 0; i < n; i++) if (lengths[i] > 0 && lengths[i] < maxBits && freq[i] < bestF) { bestF = freq[i]; best = i; }
    if (best < 0) break;
    kraft -= Math.pow(2, -lengths[best]) - Math.pow(2, -(lengths[best] + 1));
    lengths[best]++;
  }
  return lengths;
}
function canonicalCodes(lengths) {
  const n = lengths.length;
  const blCount = new Uint16Array(16);
  for (let i = 0; i < n; i++) if (lengths[i]) blCount[lengths[i]]++;
  const codes = new Uint16Array(n);
  const next = new Uint16Array(16);
  let code = 0;
  for (let b = 1; b <= 15; b++) { code = (code + blCount[b - 1]) << 1; next[b] = code; }
  for (let i = 0; i < n; i++) if (lengths[i]) codes[i] = next[lengths[i]]++;
  return codes;
}
function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) { r = (r << 1) | (code & 1); code >>>= 1; }
  return r;
}

// ---------- Bit writer ----------
class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.nbits = 0; }
  write(code, len) {
    this.acc |= (code << this.nbits) >>> 0;
    this.nbits += len;
    while (this.nbits >= 8) { this.bytes.push(this.acc & 255); this.acc >>>= 8; this.nbits -= 8; }
  }
  writeRev(code, len) { this.write(reverseBits(code, len), len); }
  alignByte() {
    if (this.nbits > 0) { this.bytes.push(this.acc & 255); this.acc = 0; this.nbits = 0; }
  }
  result() { this.alignByte(); return Buffer.from(this.bytes); }
}

// ---------- Custom deflate: iterative lazy optimal-parse ----------
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
function buildCosts(litLen, distLen) {
  const litCost = new Float64Array(288);
  for (let i = 0; i < 288; i++) litCost[i] = litLen[i] || 0;
  const lenCost = new Float64Array(259);
  for (let len = 3; len <= 258; len++) {
    const c = lenCode(len);
    lenCost[len] = litLen[257 + c] + LEN_EXTRA[c];
  }
  const distCost = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) {
    const c = distCode(d);
    distCost[d] = distLen[c] + DIST_EXTRA[c];
  }
  return { litCost, lenCost, distCost };
}
function fixedCosts() {
  const litLen = new Uint8Array(288), distLen = new Uint8Array(32);
  for (let i = 0; i < 144; i++) litLen[i] = 8;
  for (let i = 144; i < 256; i++) litLen[i] = 9;
  for (let i = 256; i < 280; i++) litLen[i] = 7;
  for (let i = 280; i < 288; i++) litLen[i] = 8;
  for (let i = 0; i < 32; i++) distLen[i] = 5;
  return buildCosts(litLen, distLen);
}

class Matcher {
  constructor(data, maxChain) {
    this.d = data; this.n = data.length; this.maxChain = maxChain;
    this.head = new Int32Array(32768).fill(-1);
    this.prev = new Int32Array(32768).fill(-1);
  }
  hash(i) {
    const d = this.d;
    return (Math.imul(((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]), 2654435761) >>> 17) & 32767;
  }
  insert(i) {
    const h = this.hash(i);
    this.prev[i & 32767] = this.head[h];
    this.head[h] = i;
  }
  // best match at i by current cost tables; returns [len, dist] (len 0 if none)
  find(i, lenCost, distCost, chainLimit) {
    const d = this.d, n = this.n;
    if (i + 3 > n) return [0, 0];
    const maxLen = Math.min(258, n - i);
    const lim = chainLimit === undefined ? this.maxChain : chainLimit;
    let bestLen = 0, bestDist = 0, bestCost = Infinity;
    let cur = this.head[this.hash(i)];
    let chain = 0;
    while (cur >= 0 && chain < lim) {
      const dist = i - cur;
      if (dist > 32768) break;
      // verify the 3 hashed bytes actually match (hash collisions are common)
      if (d[cur] === d[i] && d[cur + 1] === d[i + 1] && d[cur + 2] === d[i + 2]) {
        let l = 3;
        while (l < maxLen && d[cur + l] === d[i + l]) l++;
        if (l >= 3) {
          // LONGEST match wins (cost only breaks ties): picking by absolute
          // cost favours short cheap matches over long ones and destroys
          // compression (a 33-byte/14-bit match beats a 258-byte/17-bit one).
          const c = lenCost[l] + distCost[dist];
          if (l > bestLen || (l === bestLen && c < bestCost)) {
            bestCost = c; bestLen = l; bestDist = dist;
          }
          if (l >= 192) break;
        }
      }
      cur = this.prev[cur & 32767];
      chain++;
      if (bestLen >= maxLen) break;
    }
    return [bestLen, bestDist];
  }
}

// Lazy parse with cost tables. Symbols encoded in one Int32Array:
// literal: 0..255 ; match: 1000000 + len*40000 + dist.
// CRITICAL: every byte position is inserted into the hash table (like zlib),
// otherwise cross-row matches (distance = row stride) are never found.
function lazyParse(data, maxChain, costs) {
  const n = data.length;
  const syms = new Int32Array(n + 1);
  let count = 0;
  const m = new Matcher(data, maxChain);
  const { litCost, lenCost, distCost } = costs;
  let inserted = 0;
  const insertUpTo = (pos) => {
    while (inserted < pos) { if (inserted + 3 <= n) m.insert(inserted); inserted++; }
  };
  let i = 0;
  while (i < n) {
    if (i + 3 > n) { syms[count++] = data[i]; i++; continue; }
    insertUpTo(i);
    const [bl, bd] = m.find(i, lenCost, distCost);
    if (i + 3 <= n) m.insert(i);
    inserted = i + 1;
    if (bl >= 3) {
      const matchCost = lenCost[bl] + distCost[bd];
      let defer = false;
      if (bl < 16 && i + 4 <= n) {
        const [nl, nd] = m.find(i + 1, lenCost, distCost, Math.max(16, maxChain >> 2));
        if (nl >= 3) {
          const nextCost = lenCost[nl] + distCost[nd];
          if (litCost[data[i]] + nextCost < matchCost - 1e-9) defer = true;
        }
      }
      if (defer) { syms[count++] = data[i]; i++; continue; }
      for (let k = 1; k < bl; k++) if (i + k + 3 <= n) m.insert(i + k);
      inserted = i + bl;
      syms[count++] = 1000000 + bl * 40000 + bd;
      i += bl;
    } else {
      syms[count++] = data[i];
      i++;
    }
  }
  return { syms: syms.subarray(0, count), count };
}
function symFreqs(syms) {
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(32);
  let bits = 0;
  for (let s = 0; s < syms.length; s++) {
    const v = syms[s];
    if (v < 1000000) litFreq[v]++;
    else {
      const t = v - 1000000, len = Math.floor(t / 40000), dist = t % 40000;
      litFreq[257 + lenCode(len)]++;
      distFreq[distCode(dist)]++;
    }
  }
  litFreq[256]++; // end of block
  return { litFreq, distFreq };
}
function symCost(syms, costs) {
  const { litCost, lenCost, distCost } = costs;
  let total = 0;
  for (let s = 0; s < syms.length; s++) {
    const v = syms[s];
    if (v < 1000000) total += litCost[v];
    else { const t = v - 1000000; total += lenCost[Math.floor(t / 40000)] + distCost[t % 40000]; }
  }
  return total;
}

// Encode one block's symbols with dynamic or fixed Huffman; returns {bits, mode, litLen, distLen, litCode, distCode}
function blockPlan(syms, start, end) {
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(32);
  let nMatch = 0;
  for (let s = start; s < end; s++) {
    const v = syms[s];
    if (v < 1000000) litFreq[v]++;
    else {
      const t = v - 1000000, len = Math.floor(t / 40000), dist = t % 40000;
      litFreq[257 + lenCode(len)]++;
      distFreq[distCode(dist)]++;
      nMatch++;
    }
  }
  litFreq[256]++;
  if (nMatch === 0) distFreq[0] = 1;
  // fixed block bits
  let fixedBits = 3;
  for (let s = start; s < end; s++) {
    const v = syms[s];
    if (v < 1000000) fixedBits += v < 144 ? 8 : 9;
    else { const t = v - 1000000, len = Math.floor(t / 40000), dist = t % 40000;
      fixedBits += (257 + lenCode(len)) < 280 ? 7 : 8; fixedBits += LEN_EXTRA[lenCode(len)] + 5 + DIST_EXTRA[distCode(dist)]; }
  }
  fixedBits += 7; // end of block (256) fixed length 7
  // dynamic block bits
  const litLen = huffmanLengths(litFreq, 15);
  const distLen = huffmanLengths(distFreq, 15);
  let dynSymBits = 0;
  for (let s = start; s < end; s++) {
    const v = syms[s];
    if (v < 1000000) dynSymBits += litLen[v];
    else { const t = v - 1000000, len = Math.floor(t / 40000), dist = t % 40000;
      dynSymBits += litLen[257 + lenCode(len)] + LEN_EXTRA[lenCode(len)] + distLen[distCode(dist)] + DIST_EXTRA[distCode(dist)]; }
  }
  dynSymBits += litLen[256];
  // code-length sequence: litLen[0..287] + distLen[0..31], trim trailing zeros
  let lastLit = 256;
  for (let i = 287; i > 256; i--) if (litLen[i]) { lastLit = i; break; }
  let lastDist = 0;
  for (let i = 31; i > 0; i--) if (distLen[i]) { lastDist = i; break; }
  const seqLen = (lastLit + 1) + (lastDist + 1);
  const seq = new Uint8Array(seqLen);
  for (let i = 0; i <= lastLit; i++) seq[i] = litLen[i];
  for (let i = 0; i <= lastDist; i++) seq[lastLit + 1 + i] = distLen[i];
  // RLE encode seq into (sym, extra) tokens
  const clFreq = new Uint32Array(19);
  const tokens = []; // [sym, extraVal, extraBits]
  {
    let i = 0;
    while (i < seq.length) {
      const v = seq[i];
      if (v === 0) {
        let run = 0;
        while (i + run < seq.length && seq[i + run] === 0 && run < 138) run++;
        if (run >= 3) {
          if (run <= 10) { tokens.push([17, run - 3, 3]); clFreq[17]++; }
          else { tokens.push([18, run - 11, 7]); clFreq[18]++; }
          i += run;
        } else { for (let k = 0; k < run; k++) { tokens.push([0, 0, 0]); clFreq[0]++; } i += run; }
      } else {
        tokens.push([v, 0, 0]); clFreq[v]++; i++;
        let run = 0;
        while (i + run < seq.length && seq[i + run] === v && run < 6) run++;
        if (run >= 3) { tokens.push([16, run - 3, 2]); clFreq[16]++; i += run; }
      }
    }
  }
  const clLen = huffmanLengths(clFreq, 7);
  // trim trailing zero cl lengths in CL_ORDER
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  let clBits = 0;
  for (const [s, , eb] of tokens) clBits += clLen[s] + eb;
  const dynBits = 3 + 5 + 5 + 4 + 3 * hclen + clBits + dynSymBits;
  if (fixedBits <= dynBits) {
    return { bits: fixedBits, mode: 1, litLen: null, distLen: null, tokens: null, clLen: null, hlit: lastLit, hdist: lastDist, hclen };
  }
  return { bits: dynBits, mode: 2, litLen, distLen, tokens, clLen, hlit: lastLit, hdist: lastDist, hclen };
}
function writeBlock(bw, syms, start, end, plan, isFinal) {
  bw.write(isFinal ? 1 : 0, 1);
  bw.write(plan.mode, 2);
  if (plan.mode === 1) {
    // fixed codes
    for (let s = start; s < end; s++) writeSymFixed(bw, syms[s]);
    bw.writeRev(0, 7); // end 256 fixed code 0 (7 bits, reversed -> 0000000)
  } else {
    const { litLen, distLen, tokens, clLen, hlit, hdist, hclen } = plan;
    bw.write(hlit - 256, 5);
    bw.write(hdist, 5);
    bw.write(hclen - 4, 4);
    for (let k = 0; k < hclen; k++) bw.write(clLen[CL_ORDER[k]], 3);
    const clCode = canonicalCodes(clLen);
    for (const [sym, extra, eb] of tokens) {
      bw.writeRev(clCode[sym], clLen[sym]);
      if (eb) bw.write(extra, eb);
    }
    const litCode = canonicalCodes(litLen);
    const distCodeArr = canonicalCodes(distLen);
    for (let s = start; s < end; s++) {
      const v = syms[s];
      if (v < 1000000) { bw.writeRev(litCode[v], litLen[v]); }
      else {
        const t = v - 1000000, len = Math.floor(t / 40000), dist = t % 40000;
        const lc = lenCode(len), dc = distCode(dist);
        bw.writeRev(litCode[257 + lc], litLen[257 + lc]);
        if (LEN_EXTRA[lc]) bw.write(len - LEN_BASE[lc], LEN_EXTRA[lc]);
        bw.writeRev(distCodeArr[dc], distLen[dc]);
        if (DIST_EXTRA[dc]) bw.write(dist - DIST_BASE[dc], DIST_EXTRA[dc]);
      }
    }
    bw.writeRev(litCode[256], litLen[256]);
  }
}
function writeSymFixed(bw, v) {
  if (v < 1000000) {
    // fixed literal codes: 0-143: 8 bits 0x30..0xBF; 144-255: 9 bits 0x190..0x1FF
    if (v < 144) bw.writeRev(0x30 + v, 8);
    else bw.writeRev(0x190 + (v - 144), 9);
  } else {
    const t = v - 1000000, len = Math.floor(t / 40000), dist = t % 40000;
    const lc = lenCode(len), dc = distCode(dist);
    const lit = 257 + lc;
    const code = lit < 280 ? (lit - 256) : (0xC0 + (lit - 280));
    const clen = lit < 280 ? 7 : 8;
    bw.writeRev(code, clen);
    if (LEN_EXTRA[lc]) bw.write(len - LEN_BASE[lc], LEN_EXTRA[lc]);
    bw.writeRev(dc, 5);
    if (DIST_EXTRA[dc]) bw.write(dist - DIST_BASE[dc], DIST_EXTRA[dc]);
  }
}

// Custom deflate entry: returns zlib stream Buffer or null on failure.
function customDeflate(data, iters, maxChain) {
  try {
    let costs = fixedCosts();
    let bestSyms = null, bestCost = Infinity;
    for (let it = 0; it < iters; it++) {
      const { syms } = lazyParse(data, maxChain, costs);
      const c = symCost(syms, costs);
      if (c < bestCost) { bestCost = c; bestSyms = syms; }
      const { litFreq, distFreq } = symFreqs(syms);
      const litLen = huffmanLengths(litFreq, 15);
      const distLen = huffmanLengths(distFreq, 15);
      costs = buildCosts(litLen, distLen);
      // convergence: if this parse's cost with new tables barely differs, stop early
      const c2 = symCost(syms, costs);
      if (it >= 2 && Math.abs(c - c2) < 0.0005 * c) break;
    }
    const syms = bestSyms;
    // symbol -> input byte position (for block boundaries)
    const symPos = new Int32Array(syms.length + 1);
    let p = 0;
    for (let s = 0; s < syms.length; s++) {
      symPos[s] = p;
      const v = syms[s];
      p += v < 1000000 ? 1 : Math.floor((v - 1000000) / 40000);
    }
    symPos[syms.length] = p;
    // try split sizes (input bytes per block): whole, 131072, 32768
    const splitSizes = [Infinity, 32768];
    let bestPlan = null, bestBits = Infinity, bestBounds = null;
    for (const size of splitSizes) {
      const bounds = [0];
      if (size !== Infinity) {
        let next = size;
        for (let s = 0; s < syms.length; s++) {
          if (symPos[s] >= next) { bounds.push(s); next += size; }
        }
      }
      bounds.push(syms.length);
      let bits = 0;
      const plans = [];
      for (let b = 0; b + 1 < bounds.length; b++) {
        const pl = blockPlan(syms, bounds[b], bounds[b + 1]);
        plans.push(pl); bits += pl.bits;
      }
      if (bits < bestBits) { bestBits = bits; bestPlan = plans; bestBounds = bounds; }
    }
    const bw = new BitWriter();
    for (let b = 0; b + 1 < bestBounds.length; b++) {
      writeBlock(bw, syms, bestBounds[b], bestBounds[b + 1], bestPlan[b], b + 2 === bestBounds.length);
    }
    const deflate = bw.result();
    const out = Buffer.alloc(2 + deflate.length + 4);
    out[0] = 0x78; out[1] = 0xDA;
    deflate.copy(out, 2);
    out.writeUInt32BE(adler32(data), 2 + deflate.length);
    return out;
  } catch (e) {
    return null;
  }
}

// ---------- Colour forms ----------
function analyse(rgba) {
  let opaque = true, grey = true;
  const map = new Map();
  let over256 = false;
  const zeroRgb = new Set();
  let hasPartial = false, opaqueHasZero = false;
  let firstOcc = new Map();
  for (let i = 0; i < NP; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    if (a !== 255) opaque = false;
    if (r !== g || g !== b) grey = false;
    if (a === 0) zeroRgb.add((r << 16) | (g << 8) | b);
    else if (a !== 255) hasPartial = true;
    const word = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
    if (!over256) {
      if (!map.has(word)) {
        if (map.size >= 256) over256 = true;
        else { map.set(word, 1); firstOcc.set(word, i); }
      } else map.set(word, map.get(word) + 1);
    }
  }
  if (true) {
    for (let i = 0; i < NP; i++) {
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
      if (a === 255 && zeroRgb.has((r << 16) | (g << 8) | b)) { opaqueHasZero = true; break; }
    }
  }
  let tkey = null;
  if (!hasPartial && zeroRgb.size === 1 && !opaqueHasZero) {
    const rgb = [...zeroRgb][0];
    tkey = { r: (rgb >> 16) & 255, g: (rgb >> 8) & 255, b: rgb & 255 };
  }
  return { opaque, grey, unique: over256 ? null : map, firstOcc, tkey };
}
function paletteOrders(map, firstOcc) {
  const entries = [...map.entries()].map(([word, count]) => ({
    word, count, first: firstOcc.get(word) || 0,
    r: (word >>> 24) & 255, g: (word >>> 16) & 255, b: (word >>> 8) & 255, a: word & 255,
  }));
  const lum = (e) => (e.r * 299 + e.g * 587 + e.b * 114) / 1000;
  const byFreq = entries.slice().sort((x, y) => y.count - x.count || x.first - y.first);
  const byTrans = entries.slice().sort((x, y) => x.a - y.a || y.count - x.count || x.first - y.first);
  const byLum = entries.slice().sort((x, y) => lum(x) - lum(y) || y.count - x.count || x.first - y.first);
  const byFirst = entries.slice().sort((x, y) => x.first - y.first);
  return { freq: byFreq, trans: byTrans, lum: byLum, first: byFirst };
}
function buildForm(rgba, an, kind, orderEntries) {
  // kind: 'ct3' | 'ct0' | 'ct2' | 'ct4' | 'ct6' | 'ct0t' | 'ct2t'
  if (kind === 'ct3') {
    const idx = new Map();
    orderEntries.forEach((e, i) => idx.set(e.word, i));
    const raw = new Uint8Array(NP);
    for (let i = 0; i < NP; i++) {
      const word = ((rgba[i * 4] << 24) | (rgba[i * 4 + 1] << 16) | (rgba[i * 4 + 2] << 8) | rgba[i * 4 + 3]) >>> 0;
      raw[i] = idx.get(word);
    }
    const plte = Buffer.alloc(orderEntries.length * 3);
    const alphas = [];
    orderEntries.forEach((e, i) => { plte[i * 3] = e.r; plte[i * 3 + 1] = e.g; plte[i * 3 + 2] = e.b; alphas.push(e.a); });
    let trns = null;
    let last = alphas.length;
    while (last > 0 && alphas[last - 1] === 255) last--;
    if (last > 0 && alphas.slice(0, last).some((a) => a !== 255)) trns = Buffer.from(alphas.slice(0, last));
    return { ct: 3, bpp: 1, raw, plte, trns, id: 'ct3' };
  }
  if (kind === 'ct0' || kind === 'ct0t') {
    const raw = new Uint8Array(NP);
    for (let i = 0; i < NP; i++) raw[i] = rgba[i * 4];
    const trns = kind === 'ct0t' ? Buffer.from([0, an.tkey.r]) : null;
    return { ct: 0, bpp: 1, raw, plte: null, trns, id: kind };
  }
  if (kind === 'ct2' || kind === 'ct2t') {
    const raw = new Uint8Array(NP * 3);
    for (let i = 0; i < NP; i++) { raw[i * 3] = rgba[i * 4]; raw[i * 3 + 1] = rgba[i * 4 + 1]; raw[i * 3 + 2] = rgba[i * 4 + 2]; }
    const trns = kind === 'ct2t' ? Buffer.from([0, an.tkey.r, 0, an.tkey.g, 0, an.tkey.b]) : null;
    return { ct: 2, bpp: 3, raw, plte: null, trns, id: kind };
  }
  if (kind === 'ct4') {
    const raw = new Uint8Array(NP * 2);
    for (let i = 0; i < NP; i++) { raw[i * 2] = rgba[i * 4]; raw[i * 2 + 1] = rgba[i * 4 + 3]; }
    return { ct: 4, bpp: 2, raw, plte: null, trns: null, id: 'ct4' };
  }
  return { ct: 6, bpp: 4, raw: Buffer.from(rgba), plte: null, trns: null, id: 'ct6' };
}
function overhead(form) {
  return 37 + (form.plte ? 12 + form.plte.length : 0) + (form.trns ? 12 + form.trns.length : 0);
}
function z6(data) { return zlib.deflateSync(data, { level: 6, memLevel: 8 }); }

// ---------- Brute-force per-row filter (zlib level 4 + 32K dict) ----------
function bruteTypes(raw, bpp) {
  const stride = W * bpp;
  const types = new Uint8Array(H);
  const tmp = new Uint8Array(stride + 1);
  const zero = new Uint8Array(stride);
  const built = [];
  let prevRow = null;
  for (let y = 0; y < H; y++) {
    const cur = raw.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : zero;
    if (prevRow) {
      let same = true;
      for (let x = 0; x < stride; x++) if (cur[x] !== prevRow[x]) { same = false; break; }
      if (same) { types[y] = 2; filterRow(2, cur, prev, bpp, tmp, 0); built.push(Buffer.from(tmp)); prevRow = cur; continue; }
    }
    // dictionary: last 32768 bytes of filtered data built so far
    let dict = null;
    if (built.length) {
      let total = 0;
      for (let k = built.length - 1; k >= 0 && total < 32768; k--) total += built[k].length;
      const parts = [];
      let need = Math.min(32768, total);
      for (let k = built.length - 1; k >= 0 && need > 0; k--) {
        const b = built[k];
        const take = Math.min(need, b.length);
        parts.unshift(b.subarray(b.length - take));
        need -= take;
      }
      dict = Buffer.concat(parts);
    }
    let best = 0, bestLen = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, tmp, 0);
      const len = zlib.deflateSync(Buffer.from(tmp), { level: 4, dictionary: dict || undefined }).length;
      if (len < bestLen) { bestLen = len; best = t; }
    }
    types[y] = best;
    filterRow(best, cur, prev, bpp, tmp, 0);
    built.push(Buffer.from(tmp));
    prevRow = cur;
  }
  return types;
}

// ---------- Huffman-cost filter refinement ----------
function refineFilter(form, data) {
  // 2 passes: frequencies of filtered bytes -> Huffman lengths -> per-row pick
  let cur = data;
  let curLen = z6(cur).length;
  for (let pass = 0; pass < 2; pass++) {
    const freq = new Uint32Array(288);
    for (let i = 0; i < cur.length; i++) freq[cur[i]]++;
    freq[256] = 1;
    const litLen = huffmanLengths(freq, 15);
    const cost = new Float64Array(256);
    for (let i = 0; i < 256; i++) cost[i] = litLen[i] || 15;
    const types = choosePerRow(form.raw, form.bpp, cost);
    const next = filterImage(form.raw, form.bpp, types);
    const nextLen = z6(next).length;
    if (nextLen >= curLen) break;
    cur = next; curLen = nextLen;
  }
  return cur;
}

// ---------- Verify output decodes to identical RGBA ----------
function verifyPng(pngBuf, rgba) {
  try {
    const dec = decodePng(pngBuf);
    if (dec.length !== rgba.length) return false;
    for (let i = 0; i < rgba.length; i++) if (dec[i] !== rgba[i]) return false;
    return true;
  } catch (e) { return false; }
}
function storedFallback(rgba) {
  const form = buildForm(rgba, { tkey: null }, 'ct6');
  const types = new Uint8Array(H); // all filter 0
  const data = filterImage(form.raw, 4, types);
  const idat = zlib.deflateSync(data, { level: 0 });
  return encodePng(6, null, null, idat);
}

// ---------- Per-instance processing ----------
function processInstance(rgba) {
  const an = analyse(rgba);
  const forms = [];
  const pushForm = (kind, orderEntries) => {
    const f = buildForm(rgba, an, kind, orderEntries);
    f.over = overhead(f);
    forms.push(f);
    return f;
  };
  // colour forms
  let ct3Forms = [];
  if (an.unique) {
    const orders = paletteOrders(an.unique, an.firstOcc);
    // screen orderings by filter-0 + zlib-6 (cheap)
    const screened = [];
    for (const key of ['freq', 'trans', 'lum', 'first']) {
      const f = buildForm(rgba, an, 'ct3', orders[key]);
      f.over = overhead(f);
      const d0 = filterImage(f.raw, 1, new Uint8Array(H));
      screened.push({ f, len: z6(d0).length + f.over, d0 });
    }
    screened.sort((a, b) => a.len - b.len);
    ct3Forms = screened.slice(0, 2).map((s) => s.f);
    // keep best ordering's filter-0 candidate in screening pool later
    ct3Forms._screened = screened;
  }
  if (an.grey && an.opaque) {
    pushForm('ct0');
    if (an.unique) ct3Forms.forEach((f) => { if (!forms.includes(f)) forms.push(f); });
  } else if (an.grey && !an.opaque) {
    pushForm('ct4');
    if (an.tkey) pushForm('ct0t');
    if (an.unique) ct3Forms.forEach((f) => { if (!forms.includes(f)) forms.push(f); });
  } else if (!an.grey && an.opaque) {
    pushForm('ct2');
    if (an.tkey) pushForm('ct2t');
  } else {
    pushForm('ct6');
    if (an.unique) ct3Forms.forEach((f) => { if (!forms.includes(f)) forms.push(f); });
  }
  if (an.unique && forms.every((f) => f.ct !== 3)) {
    ct3Forms.forEach((f) => forms.push(f));
  }
  // If CT3 exists but no other form added it (flat case), ensure CT3 forms are in list
  if (an.unique && !forms.some((f) => f.ct === 3)) forms.push(...ct3Forms);

  // filter candidates per form
  const candidates = [];
  const addCand = (form, fid, data) => {
    const len = z6(data).length;
    candidates.push({ form, fid, data, total: len + form.over, z6len: len });
  };
  for (const form of forms) {
    for (let t = 0; t < 5; t++) {
      const types = new Uint8Array(H).fill(t);
      addCand(form, 'fixed' + t, filterImage(form.raw, form.bpp, types));
    }
    const minsumTypes = choosePerRow(form.raw, form.bpp, 'minsum');
    addCand(form, 'minsum', filterImage(form.raw, form.bpp, minsumTypes));
    const pairsTypes = choosePerRow(form.raw, form.bpp, 'pairs');
    addCand(form, 'pairs', filterImage(form.raw, form.bpp, pairsTypes));
    // filter-0 candidate for extra CT3 ordering (second best) — cheap
    if (form.ct === 3 && ct3Forms._screened && ct3Forms._screened[1] && ct3Forms._screened[1].f === form) {
      // already covered by fixed0 of this form; nothing extra
    }
  }
  candidates.sort((a, b) => a.total - b.total || (a.fid < b.fid ? -1 : 1));
  // brute on best form only (skip for CT3 when filter-0 already beats minsum by >3%)
  const bestForm = candidates[0].form;
  let skipBrute = false;
  if (bestForm.ct === 3) {
    const f0 = candidates.find((c) => c.form === bestForm && c.fid === 'fixed0');
    const ms = candidates.find((c) => c.form === bestForm && c.fid === 'minsum');
    if (f0 && ms && f0.total < ms.total * 0.97) skipBrute = true;
  }
  if (!skipBrute) {
    const bt = bruteTypes(bestForm.raw, bestForm.bpp);
    addCand(bestForm, 'brute', filterImage(bestForm.raw, bestForm.bpp, bt));
    candidates.sort((a, b) => a.total - b.total || (a.fid < b.fid ? -1 : 1));
  }
  // top 3 by screening
  let top = candidates.slice(0, 3);
  // Huffman refinement on top 2 (2 passes each), keep if zlib-6 improves
  const refined = [];
  for (const cand of top.slice(0, 2)) {
    const r = refineFilter(cand.form, cand.data);
    if (r !== cand.data) {
      const len = z6(r).length;
      refined.push({ form: cand.form, fid: cand.fid + '+ref', data: r, total: len + cand.form.over, z6len: len });
    }
  }
  for (const c of refined) candidates.push(c);
  candidates.sort((a, b) => a.total - b.total || (a.fid < b.fid ? -1 : 1));
  top = candidates.slice(0, 3);

  // final: custom deflate + zlib-9 variants, pick smallest total file
  let best = null; // {png, total}
  for (let ci = 0; ci < top.length; ci++) {
    const cand = top[ci];
    const n = cand.data.length;
    const streams = [];
    const z9 = zlib.deflateSync(cand.data, { level: 9, memLevel: 9 });
    streams.push(z9);
    streams.push(zlib.deflateSync(cand.data, { level: 9, memLevel: 8 }));
    streams.push(zlib.deflateSync(cand.data, { level: 9, memLevel: 9, strategy: zlib.constants.Z_RLE }));
    streams.push(zlib.deflateSync(cand.data, { level: 9, memLevel: 9, strategy: zlib.constants.Z_FILTERED }));
    // custom deflate: expensive, and on practice it rarely beats zlib-9, so
    // run it only on the top-1 screening candidate (timeout safety first).
    const large = n > 2500000;
    if (ci === 0) {
      const iters = n <= 1000000 ? 3 : 2;
      const chain = n <= 1000000 ? 256 : n <= 2500000 ? 128 : 64;
      const cd = customDeflate(cand.data, iters, chain);
      if (cd) streams.push(cd);
    }
    for (const s of streams) {
      const total = s.length + cand.form.over;
      if (!best || total < best.total) {
        best = { png: encodePng(cand.form.ct, cand.form.plte, cand.form.trns, s), total, fid: cand.fid, form: cand.form.id };
      }
    }
  }
  if (!best || !verifyPng(best.png, rgba)) {
    // fallback: zlib-9 over filter-0 of best screening form
    const f0 = candidates.find((c) => c.fid === 'fixed0') || candidates[0];
    const s = zlib.deflateSync(f0.data, { level: 9, memLevel: 9 });
    const png = encodePng(f0.form.ct, f0.form.plte, f0.form.trns, s);
    if (verifyPng(png, rgba)) return png;
    return storedFallback(rgba);
  }
  return best.png;
}

// ---------- main ----------
function main() {
  const inDir = process.env.MAKEFUN_INPUT_DIR || '/input';
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  for (const id of IDS) {
    try {
      const buf = readFileSync(join(inDir, id, 'image.png'));
      const rgba = decodePng(buf);
      const png = processInstance(rgba);
      mkdirSync(join(outDir, id), { recursive: true });
      writeFileSync(join(outDir, id, 'image.png'), png);
    } catch (e) {
      try {
        mkdirSync(join(outDir, id), { recursive: true });
        writeFileSync(join(outDir, id, 'image.png'), storedFallback(new Uint8Array(NP * 4)));
      } catch (e2) { /* leave missing; nothing else to do */ }
    }
  }
}
main();

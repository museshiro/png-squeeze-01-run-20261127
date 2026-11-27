// png-squeeze-01-run-20261127: squeeze 1280x720 RGBA screenshots into the smallest
// lossless PNG. One program, Node 22 built-ins only, no network, deterministic.
//
// Pipeline per image:
//   1. Decode the stored PNG (colour type 6, unfiltered) to RGBA.
//   2. Analyse colours: unique RGBA count (capped at 257), all-grey?, all alpha 255?,
//      any mid alpha?, the RGB of transparent pixels (for a tRNS shortcut).
//   3. Build candidate encodings: palette (colour type 3) when <= 256 colours, grey
//      (type 0/4) when every pixel is grey, RGB (type 2) when alpha is full, RGBA
//      (type 6) otherwise, plus a tRNS variant when every transparent pixel shares
//      one colour and no opaque pixel uses it.
//   4. Filter every row with the filter (None/Sub/Up/Average/Paeth) whose filtered
//      bytes have the smallest sum of absolute signed values; a row identical to
//      the one above is filtered Up (all zeros).
//   5. Deflate the filtered bytes and keep the smallest candidate PNG.
//
// Only /output/<id>/image.png is written, never a relative path. All limits are
// counts and sizes, never the wall clock, so two runs write identical bytes.
import { deflateSync, inflateSync } from 'node:zlib';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------- PNG writing

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const PNG_SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const EMPTY = new Uint8Array(0);

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function pngOf(chunks) {
  let size = PNG_SIG.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(PNG_SIG, 0);
  let at = PNG_SIG.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out[at + 4] = type.charCodeAt(0);
    out[at + 5] = type.charCodeAt(1);
    out[at + 6] = type.charCodeAt(2);
    out[at + 7] = type.charCodeAt(3);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

// ---------------------------------------------------------------- PNG reading

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Decode any bit-depth-8, non-interlaced PNG of colour type 0/2/3/4/6 to RGBA.
function decodePng(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = 6;
  let palette = null;
  let trns = null;
  const idat = [];
  while (at + 8 <= buf.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(buf[at + 4], buf[at + 5], buf[at + 6], buf[at + 7]);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      colourType = data[9];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { rgba, width, height };
}

// ---------------------------------------------------------------- colour analysis

// One pass over RGBA: unique colours (counted exactly while <= 256), whether
// every pixel is grey, whether alpha is always 255, whether any mid alpha
// (1..254) exists, and the RGB values used by fully transparent pixels.
function analyze(rgba) {
  const counts = new Map();
  let allGray = true;
  let alphaAll255 = true;
  let hasMidAlpha = false;
  const transparentRgb = new Set();
  let transparentCount = 0;
  let tooMany = false;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const a = rgba[i + 3];
    if (r !== g || g !== b) allGray = false;
    if (a !== 255) {
      alphaAll255 = false;
      if (a === 0) {
        transparentCount++;
        if (transparentRgb.size < 2) transparentRgb.add((r << 16) | (g << 8) | b);
      } else hasMidAlpha = true;
    }
    if (!tooMany) {
      const key = r * 16777216 + g * 65536 + b * 256 + a;
      const prev = counts.get(key);
      if (prev === undefined) {
        if (counts.size >= 257) tooMany = true;
        else counts.set(key, { count: 1, first: i >> 2 });
      } else prev.count++;
    }
  }
  return { counts, allGray, alphaAll255, hasMidAlpha, transparentRgb, transparentCount, tooMany };
}

// Whether any opaque pixel uses the RGB `rgb` (tRNS is only valid when the
// transparent colour is used by transparent pixels alone).
function opaqueUsesRgb(rgba, rgb) {
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 255 && ((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]) === rgb) return true;
  }
  return false;
}

// ---------------------------------------------------------------- candidate samples

function paletteOrder(counts, transparentFirst) {
  const entries = [];
  for (const [key, v] of counts) entries.push({ key, count: v.count, first: v.first });
  entries.sort((x, y) => {
    if (transparentFirst) {
      const xt = (x.key & 255) < 255 ? 0 : 1;
      const yt = (y.key & 255) < 255 ? 0 : 1;
      if (xt !== yt) return xt - yt;
    }
    if (y.count !== x.count) return y.count - x.count;
    return x.first - y.first;
  });
  return entries;
}

function samplesPalette(rgba, order) {
  const index = new Map();
  const plte = new Uint8Array(order.length * 3);
  const trns = new Uint8Array(order.length);
  for (let e = 0; e < order.length; e++) {
    const key = order[e].key;
    index.set(key, e);
    plte[e * 3] = Math.floor(key / 16777216);
    plte[e * 3 + 1] = Math.floor(key / 65536) % 256;
    plte[e * 3 + 2] = Math.floor(key / 256) % 256;
    trns[e] = key % 256;
  }
  // Trim trailing fully-opaque tRNS entries; drop tRNS entirely when all opaque.
  let trnsLen = trns.length;
  while (trnsLen > 0 && trns[trnsLen - 1] === 255) trnsLen--;
  const n = rgba.length >> 2;
  const samples = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    samples[i] = index.get(rgba[d] * 16777216 + rgba[d + 1] * 65536 + rgba[d + 2] * 256 + rgba[d + 3]);
  }
  return { colourType: 3, samples, plte, trns: trnsLen === 0 ? null : trns.subarray(0, trnsLen) };
}

function samplesGrey(rgba, withAlpha) {
  const n = rgba.length >> 2;
  const samples = new Uint8Array(withAlpha ? n * 2 : n);
  if (withAlpha) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      samples[s] = rgba[d];
      samples[s + 1] = rgba[d + 3];
    }
    return { colourType: 4, samples, plte: null, trns: null };
  }
  for (let i = 0; i < n; i++) samples[i] = rgba[i * 4];
  return { colourType: 0, samples, plte: null, trns: null };
}

function samplesRgb(rgba, withAlpha) {
  const n = rgba.length >> 2;
  if (withAlpha) return { colourType: 6, samples: rgba, plte: null, trns: null };
  const samples = new Uint8Array(n * 3);
  for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
    samples[s] = rgba[d];
    samples[s + 1] = rgba[d + 1];
    samples[s + 2] = rgba[d + 2];
  }
  return { colourType: 2, samples, plte: null, trns: null };
}

function samplesRgbTrns(rgba, rgb) {
  const c = samplesRgb(rgba, false);
  const trns = new Uint8Array(6);
  trns[0] = 0;
  trns[1] = (rgb >> 16) & 255;
  trns[2] = 0;
  trns[3] = (rgb >> 8) & 255;
  trns[4] = 0;
  trns[5] = rgb & 255;
  c.trns = trns;
  return c;
}

function samplesGreyTrns(rgba, grey) {
  const c = samplesGrey(rgba, false);
  const trns = new Uint8Array(2);
  trns[0] = 0;
  trns[1] = grey;
  c.trns = trns;
  return c;
}

// ---------------------------------------------------------------- row filtering

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const cc = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, cc);
    }
  }
}

function signedAbsSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

function rowsEqual(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Filter every row with the minimum-sum filter; a row identical to the one
// above is filtered Up (all zeros). Row 0 skips Up, which equals None there.
function filterImage(samples, width, height, bpp) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = [];
  for (let t = 0; t < 5; t++) trial.push(new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (prev !== null && rowsEqual(cur, prev)) {
      raw[at] = 2;
      continue;
    }
    let best = Infinity;
    let bestType = 0;
    for (let t = 0; t < 5; t++) {
      if (y === 0 && t === 2) continue;
      filterRow(t, cur, prev, bpp, trial[t]);
      const s = signedAbsSum(trial[t]);
      if (s < best) {
        best = s;
        bestType = t;
      }
    }
    raw[at] = bestType;
    raw.set(trial[bestType], at + 1);
  }
  return raw;
}

// ---------------------------------------------------------------- deflate

// Best deflate of the filtered bytes: Node's zlib at level 9.
function compress(raw) {
  return deflateSync(raw, { level: 9 });
}

// ---------------------------------------------------------------- encode one image

function encodeImage(rgba, width, height) {
  const info = analyze(rgba);
  const candidates = [];
  if (!info.tooMany) {
    candidates.push(samplesPalette(rgba, paletteOrder(info.counts, false)));
    if (info.transparentCount > 0) candidates.push(samplesPalette(rgba, paletteOrder(info.counts, true)));
  }
  if (info.allGray) {
    candidates.push(samplesGrey(rgba, !info.alphaAll255));
    if (!info.alphaAll255 && !info.hasMidAlpha && info.transparentRgb.size === 1) {
      const rgb = [...info.transparentRgb][0];
      const grey = rgb & 255;
      if (((rgb >> 16) & 255) === grey && ((rgb >> 8) & 255) === grey && !opaqueUsesRgb(rgba, rgb)) {
        candidates.push(samplesGreyTrns(rgba, grey));
      }
    }
  } else if (info.alphaAll255) {
    candidates.push(samplesRgb(rgba, false));
  } else {
    candidates.push(samplesRgb(rgba, true));
    if (!info.hasMidAlpha && info.transparentRgb.size === 1) {
      const rgb = [...info.transparentRgb][0];
      if (!opaqueUsesRgb(rgba, rgb)) candidates.push(samplesRgbTrns(rgba, rgb));
    }
  }
  let best = null;
  for (const c of candidates) {
    const bpp = CHANNELS[c.colourType];
    const raw = filterImage(c.samples, width, height, bpp);
    const comp = compress(raw);
    const chunks = [['IHDR', ihdrOf(width, height, c.colourType)]];
    if (c.plte) chunks.push(['PLTE', c.plte]);
    if (c.trns) chunks.push(['tRNS', c.trns]);
    chunks.push(['IDAT', new Uint8Array(comp)]);
    chunks.push(['IEND', EMPTY]);
    const png = pngOf(chunks);
    if (best === null || png.length < best.length) best = png;
  }
  return best;
}

// ---------------------------------------------------------------- main

for (const id of readdirSync(INPUT_DIR).sort()) {
  const inPath = join(INPUT_DIR, id, 'image.png');
  let st;
  try {
    st = statSync(inPath);
  } catch {
    continue;
  }
  if (!st.isFile()) continue;
  const outDir = join(OUTPUT_DIR, id);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'image.png');
  try {
    const { rgba, width, height } = decodePng(new Uint8Array(readFileSync(inPath)));
    writeFileSync(outPath, encodeImage(rgba, width, height));
  } catch {
    // Any failure still answers the instance: copy the stored PNG verbatim.
    copyFileSync(inPath, outPath);
  }
}

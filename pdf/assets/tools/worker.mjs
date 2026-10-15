// pdf-lib work for the tool pages, off the main thread: rotate, compress, images to PDF,
// and assembling rendered page images. Same-origin module worker; no network use.
import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, PDFRawStream, PDFBool,
  decodePDFRawStream, degrees,
} from '../vendor/pdf-lib/pdf-lib.esm.min.js';

let current = 0;
const report = (done, total, label) => postMessage({id: current, type: 'progress', done, total, label});

self.onmessage = async ({data: {id, op, payload}}) => {
  current = id;
  try {
    const fn = {rotate, compress, images, rasterPages}[op];
    if (!fn) throw new Error('Unknown operation');
    const result = await fn(payload);
    const transfer = result?.bytes ? [result.bytes.buffer] : [];
    postMessage({id, type: 'done', result}, transfer);
  } catch (e) {
    postMessage({id, type: 'error', message: friendly(e)});
  }
};

function friendly(e) {
  const m = String(e?.message || e);
  if (/encrypt/i.test(m)) return 'This PDF is encrypted or password-protected. Encrypted PDFs are not supported here.';
  if (/Failed to parse|No PDF header|Invalid object ref|Expected instance of|MissingPDFHeader|could not find|Trailer/i.test(m)) return 'This file could not be read as a PDF. It may be damaged or incomplete.';
  return m;
}

async function load(bytes) {
  const doc = await PDFDocument.load(bytes, {updateMetadata: false, throwOnInvalidObject: false});
  if (doc.isEncrypted) throw new Error('encrypted');
  return doc;
}
const save = doc => doc.save({useObjectStreams: true, updateFieldAppearances: false});

// ---------- Rotate ----------
// rotations[i] is the clockwise turn (0/90/180/270) to add to page i's current /Rotate.
async function rotate({bytes, rotations}) {
  const doc = await load(bytes);
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const add = ((rotations[i] || 0) % 360 + 360) % 360;
    if (!add) return;
    const now = ((page.getRotation().angle % 360) + 360) % 360;
    page.setRotation(degrees((now + add) % 360));
  });
  return {bytes: await save(doc)};
}

// ---------- Compress ----------
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const latin1 = new TextDecoder('latin1');

// Walks a content stream and calls onDo(name, ctm) for every Do operator, tracking q/Q/cm.
function scanContent(b, ctm0, onDo) {
  let ctm = ctm0;
  const stack = [], saved = [];
  let i = 0;
  const n = b.length;
  while (i < n) {
    const c = b[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 0x25) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }
    if (c === 0x28) { // literal string
      let depth = 1; i++;
      while (i < n && depth) { const d = b[i]; if (d === 0x5c) { i += 2; continue; } if (d === 0x28) depth++; else if (d === 0x29) depth--; i++; }
      stack.push(null); continue;
    }
    if (c === 0x3c) {
      if (b[i + 1] === 0x3c) { i += 2; continue; }
      while (i < n && b[i] !== 0x3e) i++;
      i++; stack.push(null); continue;
    }
    if (c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) { i++; continue; }
    if (c === 0x2f) { // name
      let j = i + 1;
      while (j < n && !WS.has(b[j]) && !DELIM.has(b[j])) j++;
      stack.push({name: latin1.decode(b.subarray(i + 1, j)).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))});
      i = j; continue;
    }
    let j = i;
    while (j < n && !WS.has(b[j]) && !DELIM.has(b[j])) j++;
    if (j === i) { i++; continue; }
    const tok = latin1.decode(b.subarray(i, j));
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { stack.push(Number(tok)); continue; }
    if (tok === 'q') saved.push(ctm);
    else if (tok === 'Q') ctm = saved.pop() || ctm0;
    else if (tok === 'cm' && stack.length >= 6) {
      const m = stack.slice(-6);
      if (m.every(v => typeof v === 'number')) ctm = mul(m, ctm);
    } else if (tok === 'Do') {
      const top = stack[stack.length - 1];
      if (top?.name) onDo(top.name, ctm);
    } else if (tok === 'BI') { // inline image: skip to EI
      const k = findInlineEnd(b, i);
      i = k;
    }
    stack.length = 0;
  }
}
function findInlineEnd(b, i) {
  // Find " ID " then the data, ending at whitespace + "EI" + whitespace/end.
  while (i < b.length - 1 && !(b[i] === 0x49 && b[i + 1] === 0x44 && WS.has(b[i - 1]) && (WS.has(b[i + 2]) || i + 2 >= b.length))) i++;
  i += 3;
  while (i < b.length - 2) {
    if (WS.has(b[i]) && b[i + 1] === 0x45 && b[i + 2] === 0x49 && (i + 3 >= b.length || WS.has(b[i + 3]) || DELIM.has(b[i + 3]))) return i + 3;
    i++;
  }
  return b.length;
}
const mul = (m, c) => [
  m[0] * c[0] + m[1] * c[2], m[0] * c[1] + m[1] * c[3],
  m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3],
  m[4] * c[0] + m[5] * c[2] + c[4], m[4] * c[1] + m[5] * c[3] + c[5],
];

function inherited(node, key) {
  for (let d = node, depth = 0; d && depth < 64; depth++) {
    const v = d.lookup(PDFName.of(key));
    if (v) return v;
    d = d.lookup(PDFName.of('Parent'));
    if (!(d instanceof PDFDict)) return null;
  }
  return null;
}
function decoded(stream) {
  try { return decodePDFRawStream(stream).decode(); } catch { return null; }
}
const nameOf = v => v instanceof PDFName ? v.decodeText() : null;
const num = v => v instanceof PDFNumber ? v.asNumber() : null;

// Largest displayed size (in points) of every image XObject reachable from page content.
function measurePlacements(doc) {
  const ctx = doc.context;
  const sizes = new Map(); // ref tag -> {w, h}
  let budget = 20000; // form XObjects visited, against pathological files
  const visit = (bytes, resources, ctm, depth) => {
    if (!bytes || depth > 12) return;
    const xobjects = resources instanceof PDFDict ? resources.lookup(PDFName.of('XObject')) : null;
    scanContent(bytes, ctm, (name, m) => {
      if (!(xobjects instanceof PDFDict)) return;
      const ref = xobjects.get(PDFName.of(name));
      const obj = ref instanceof PDFRef ? ctx.lookup(ref) : null;
      if (!(obj instanceof PDFRawStream)) return;
      const sub = nameOf(obj.dict.lookup(PDFName.of('Subtype')));
      if (sub === 'Image') {
        const w = Math.hypot(m[0], m[1]), h = Math.hypot(m[2], m[3]);
        const prev = sizes.get(ref.tag) || {w: 0, h: 0};
        sizes.set(ref.tag, {w: Math.max(prev.w, w), h: Math.max(prev.h, h)});
      } else if (sub === 'Form' && budget-- > 0) {
        const fm = obj.dict.lookup(PDFName.of('Matrix'));
        const matrix = fm instanceof PDFArray && fm.size() === 6 ? fm.asArray().map(v => num(v) ?? 0) : [1, 0, 0, 1, 0, 0];
        const res = obj.dict.lookup(PDFName.of('Resources')) || resources;
        visit(decoded(obj), res, mul(matrix, m), depth + 1);
      }
    });
  };
  for (const page of doc.getPages()) {
    const node = page.node;
    const resources = inherited(node, 'Resources');
    const contents = node.lookup(PDFName.of('Contents'));
    const streams = contents instanceof PDFArray ? contents.asArray().map(r => ctx.lookup(r)) : [contents];
    const chunks = streams.filter(s => s instanceof PDFRawStream).map(decoded).filter(Boolean);
    const total = chunks.reduce((s, c) => s + c.length + 1, 0);
    const all = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; all[o++] = 10; }
    visit(all, resources, [1, 0, 0, 1, 0, 0], 0);
  }
  return sizes;
}

// Undo PNG predictors (FlateDecode /Predictor 10-15).
function unpredict(data, colors, bpc, columns) {
  const bpp = Math.max(1, Math.ceil(colors * bpc / 8));
  const rowLen = Math.ceil(colors * bpc * columns / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], ul = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (type === 1) v += a;
      else if (type === 2) v += up;
      else if (type === 3) v += (a + up) >> 1;
      else if (type === 4) { const p = a + up - ul, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - ul); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : ul; }
      cur[i] = v & 0xFF;
    }
    prev = cur;
  }
  return out;
}

// Removes EXIF (APP1) segments so the browser decodes the stored pixels without rotating them.
function stripApp1(b) {
  if (b[0] !== 0xFF || b[1] !== 0xD8) return b;
  const parts = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xFF) {
    const marker = b[i + 1];
    if (marker === 0xDA || marker === 0xD9) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker !== 0xE1) parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  parts.push(b.subarray(i));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function colorInfo(doc, cs) {
  // Returns {n, keep} where keep is the colour space object to keep (null = DeviceRGB).
  if (cs instanceof PDFName) {
    const name = cs.decodeText();
    if (name === 'DeviceRGB') return {n: 3, keep: null};
    if (name === 'DeviceGray') return {n: 1, keep: null};
    return null;
  }
  if (cs instanceof PDFArray && cs.size() >= 2) {
    const family = nameOf(cs.lookup(0));
    if (family === 'ICCBased') {
      const s = cs.lookup(1);
      const n = s instanceof PDFRawStream ? num(s.dict.lookup(PDFName.of('N'))) : null;
      if (n === 3) return {n: 3, keep: cs};
      if (n === 1) return {n: 1, keep: null};
    }
    if (family === 'CalRGB') return {n: 3, keep: cs};
    if (family === 'CalGray') return {n: 1, keep: null};
  }
  return null;
}

async function compress({bytes, dpi, quality}) {
  const inputSize = bytes.length;
  const doc = await load(bytes);
  const ctx = doc.context;
  report(0, 1, 'Reading the PDF…');
  const sizes = measurePlacements(doc);
  const pages = doc.getPages();
  const maxPage = pages.reduce((m, p) => { const {width, height} = p.getSize(); return {w: Math.max(m.w, width), h: Math.max(m.h, height)}; }, {w: 0, h: 0});

  const objects = ctx.enumerateIndirectObjects();
  const maskRefs = new Set();
  const images = [];
  for (const [ref, obj] of objects) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (nameOf(obj.dict.lookup(PDFName.of('Subtype'))) !== 'Image') continue;
    images.push([ref, obj]);
    for (const k of ['SMask', 'Mask']) { const m = obj.dict.get(PDFName.of(k)); if (m instanceof PDFRef) maskRefs.add(m.tag); }
  }
  const stats = {images: images.length, recompressed: 0, unchanged: 0, skipped: 0, imageBytesBefore: 0, imageBytesAfter: 0};
  let done = 0;
  for (const [ref, obj] of images) {
    report(done++, images.length, `Compressing image ${done} of ${images.length}…`);
    stats.imageBytesBefore += obj.contents.length;
    const result = maskRefs.has(ref.tag) ? null : await recompressImage(doc, ref, obj, sizes.get(ref.tag), maxPage, dpi, quality);
    if (result === 'skip' || result === null) { stats.skipped++; stats.imageBytesAfter += obj.contents.length; continue; }
    if (!result) { stats.unchanged++; stats.imageBytesAfter += obj.contents.length; continue; }
    ctx.assign(ref, result);
    stats.recompressed++;
    stats.imageBytesAfter += result.contents.length;
  }
  report(images.length, images.length, 'Compressing page streams…');
  await deflateUnfiltered(ctx);
  removeUnreachable(ctx);
  report(1, 1, 'Writing the new PDF…');
  const out = await save(doc);
  return {bytes: out, stats: {...stats, inputSize, outputSize: out.length}};
}

// Returns a new PDFRawStream, undefined (no gain), or 'skip' (unsupported image).
async function recompressImage(doc, ref, obj, placed, maxPage, dpi, quality) {
  const d = obj.dict;
  const W = num(d.lookup(PDFName.of('Width'))), H = num(d.lookup(PDFName.of('Height')));
  const bpc = num(d.lookup(PDFName.of('BitsPerComponent')));
  if (!W || !H || W * H > 60e6) return 'skip';
  if (d.lookup(PDFName.of('ImageMask')) instanceof PDFBool && d.lookup(PDFName.of('ImageMask')).asBoolean()) return 'skip';
  if (d.lookup(PDFName.of('Mask')) instanceof PDFArray) return 'skip'; // colour-key masking depends on exact values
  if (d.lookup(PDFName.of('Decode'))) return 'skip';
  const smask = d.lookup(PDFName.of('SMask'));
  if (smask instanceof PDFRawStream && smask.dict.lookup(PDFName.of('Matte'))) return 'skip'; // needs matching size
  const color = colorInfo(doc, d.lookup(PDFName.of('ColorSpace')));
  if (!color) return 'skip';
  if (obj.contents.length < 4096) return undefined; // too small to be worth it

  let filters = d.lookup(PDFName.of('Filter'));
  filters = filters instanceof PDFArray ? filters.asArray().map(f => nameOf(f instanceof PDFRef ? doc.context.lookup(f) : f)) : filters ? [nameOf(filters)] : [];
  let parms = d.lookup(PDFName.of('DecodeParms'));
  parms = parms instanceof PDFArray ? parms.asArray().map(p => p instanceof PDFRef ? doc.context.lookup(p) : p) : [parms];
  const last = filters[filters.length - 1];
  const lossless = new Set(['FlateDecode', 'LZWDecode', 'ASCII85Decode', 'ASCIIHexDecode', 'RunLengthDecode']);

  // Target size: the image's own display size at the chosen DPI. Images we cannot find in the
  // page content (for example inside annotations) are assumed to be drawn as large as a page.
  const box = placed && placed.w > 0 && placed.h > 0 ? placed : {w: maxPage.w, h: maxPage.h, guess: true};
  let scale;
  if (box.guess) scale = Math.min(1, Math.max(dpi * box.w / 72 / W, dpi * box.h / 72 / H));
  else scale = Math.min(1, Math.max(dpi * box.w / 72 / W, dpi * box.h / 72 / H));
  if (scale > 0.9) scale = 1;
  const tw = Math.max(1, Math.round(W * scale)), th = Math.max(1, Math.round(H * scale));

  let bitmap;
  try {
    if (last === 'DCTDecode') {
      if (filters.slice(0, -1).some(f => !lossless.has(f))) return 'skip';
      const dctParms = parms[filters.length - 1];
      if (dctParms instanceof PDFDict && num(dctParms.lookup(PDFName.of('ColorTransform'))) === 0) return 'skip';
      let jpeg = obj.contents;
      if (filters.length > 1) {
        const pre = PDFRawStream.of(doc.context.obj({Filter: filters.slice(0, -1)}), obj.contents);
        jpeg = decodePDFRawStream(pre).decode();
      }
      if (scale === 1 && quality >= 0.9) return undefined;
      bitmap = await createImageBitmap(new Blob([stripApp1(jpeg)], {type: 'image/jpeg'}));
      if (bitmap.width !== W || bitmap.height !== H) { bitmap.close(); return 'skip'; }
    } else if (filters.every(f => lossless.has(f))) {
      if (bpc !== 8) return 'skip';
      let raw = decodePDFRawStream(obj).decode();
      const p = parms[filters.length - 1];
      const pred = p instanceof PDFDict ? num(p.lookup(PDFName.of('Predictor'))) || 1 : 1;
      if (pred === 2 || pred > 15) return 'skip';
      if (pred >= 10) raw = unpredict(raw, num(p.lookup(PDFName.of('Colors'))) || 1, num(p.lookup(PDFName.of('BitsPerComponent'))) || 8, num(p.lookup(PDFName.of('Columns'))) || 1);
      if (raw.length < W * H * color.n) return 'skip';
      const rgba = new Uint8ClampedArray(W * H * 4);
      for (let i = 0, j = 0; i < W * H; i++, j += color.n) {
        const k = i * 4;
        if (color.n === 3) { rgba[k] = raw[j]; rgba[k + 1] = raw[j + 1]; rgba[k + 2] = raw[j + 2]; }
        else { rgba[k] = rgba[k + 1] = rgba[k + 2] = raw[j]; }
        rgba[k + 3] = 255;
      }
      bitmap = await createImageBitmap(new ImageData(rgba, W, H));
    } else {
      return 'skip'; // JPX, JBIG2, CCITT
    }
  } catch {
    return 'skip';
  }
  const canvas = new OffscreenCanvas(tw, th);
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, tw, th);
  bitmap.close();
  const jpeg = new Uint8Array(await (await canvas.convertToBlob({type: 'image/jpeg', quality})).arrayBuffer());
  if (jpeg.length >= obj.contents.length * 0.9) return undefined;
  const dict = d.clone(doc.context);
  for (const k of ['DecodeParms', 'Decode', 'Length', 'Filter', 'Width', 'Height', 'BitsPerComponent', 'ColorSpace']) dict.delete(PDFName.of(k));
  dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
  dict.set(PDFName.of('Width'), PDFNumber.of(tw));
  dict.set(PDFName.of('Height'), PDFNumber.of(th));
  dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
  dict.set(PDFName.of('ColorSpace'), color.keep || PDFName.of('DeviceRGB'));
  return PDFRawStream.of(dict, jpeg);
}

// Flate-compresses streams that have no filter at all (some generators leave page content raw).
async function deflateUnfiltered(ctx) {
  if (typeof CompressionStream !== 'function') return;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.contents.length < 512) continue;
    const d = obj.dict;
    if (d.has(PDFName.of('Filter')) || d.has(PDFName.of('DecodeParms'))) continue;
    if (nameOf(d.lookup(PDFName.of('Type'))) === 'Metadata') continue;
    const z = new Uint8Array(await new Response(new Blob([obj.contents]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    if (z.length >= obj.contents.length * 0.9) continue;
    const dict = d.clone(ctx);
    dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    ctx.assign(ref, PDFRawStream.of(dict, z));
  }
}

// Drops objects nothing refers to any more (old revisions, replaced data).
function removeUnreachable(ctx) {
  const seen = new Set();
  const stack = [];
  const push = v => { if (v) stack.push(v); };
  const t = ctx.trailerInfo;
  push(t.Root); push(t.Info);
  if (t.Encrypt) return; // never for loaded docs, but don't touch encrypted structure
  while (stack.length) {
    const v = stack.pop();
    if (v instanceof PDFRef) {
      if (seen.has(v.tag)) continue;
      seen.add(v.tag);
      push(ctx.lookup(v));
    } else if (v instanceof PDFDict) {
      for (const [, val] of v.entries()) push(val);
    } else if (v instanceof PDFArray) {
      for (const val of v.asArray()) push(val);
    } else if (v instanceof PDFRawStream || v?.dict instanceof PDFDict) {
      push(v.dict);
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
}

// ---------- Images to PDF ----------
const SIZES = {a4: [595.28, 841.89], letter: [612, 792]};

function jpegInfo(b) {
  // Orientation (EXIF 0x0112) and JFIF density, if present.
  let orientation = 1, dpi = null;
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xFF) {
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xE0 && latin1.decode(b.subarray(i + 4, i + 9)) === 'JFIF\0') {
      const units = b[i + 11], x = (b[i + 12] << 8) | b[i + 13];
      if (units === 1 && x > 0) dpi = x; else if (units === 2 && x > 0) dpi = x * 2.54;
    }
    if (marker === 0xE1 && latin1.decode(b.subarray(i + 4, i + 10)) === 'Exif\0\0') {
      const t = i + 10;
      const le = b[t] === 0x49;
      const u16 = o => le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1];
      const u32 = o => le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
      const ifd = t + u32(t + 4);
      const count = u16(ifd);
      for (let k = 0; k < count; k++) {
        const e = ifd + 2 + k * 12;
        if (u16(e) === 0x0112) orientation = u16(e + 8);
      }
    }
    if (marker === 0xDA) break;
    i += 2 + len;
  }
  return {orientation, dpi};
}
function pngDpi(b) {
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = latin1.decode(b.subarray(i + 4, i + 8));
    if (type === 'pHYs') {
      const ppm = ((b[i + 8] << 24) | (b[i + 9] << 16) | (b[i + 10] << 8) | b[i + 11]) >>> 0;
      return b[i + 16] === 1 && ppm > 0 ? ppm * 0.0254 : null;
    }
    if (type === 'IDAT') return null;
    i += 12 + len;
  }
  return null;
}
const kind = b => b[0] === 0xFF && b[1] === 0xD8 ? 'jpeg'
  : b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 ? 'png'
  : latin1.decode(b.subarray(0, 4)) === 'RIFF' && latin1.decode(b.subarray(8, 12)) === 'WEBP' ? 'webp' : null;

async function viaCanvas(bytes, type) {
  // Decodes with the browser (applying EXIF orientation) and re-encodes: PNG if any pixel is
  // transparent, otherwise JPEG at quality 0.92.
  const bmp = await createImageBitmap(new Blob([bytes], {type}));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const px = g.getImageData(0, 0, c.width, c.height).data;
  let alpha = false;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 255) { alpha = true; break; }
  const blob = await c.convertToBlob(alpha ? {type: 'image/png'} : {type: 'image/jpeg', quality: 0.92});
  return {bytes: new Uint8Array(await blob.arrayBuffer()), png: alpha};
}

async function images({files, pageSize, orientation, margin}) {
  const doc = await PDFDocument.create();
  doc.setProducer('Quire PDF (quireapps.com/pdf)');
  doc.setCreator('Quire PDF: images to PDF');
  const notes = {embeddedAsIs: 0, reencoded: 0};
  for (let i = 0; i < files.length; i++) {
    report(i, files.length, `Adding image ${i + 1} of ${files.length}…`);
    const {bytes, name} = files[i];
    const k = kind(bytes);
    let img, rot = 0, dpi = null;
    try {
      if (k === 'jpeg') {
        const info = jpegInfo(bytes);
        dpi = info.dpi;
        if ([1, 3, 6, 8].includes(info.orientation)) {
          img = await doc.embedJpg(bytes); // original bytes, no re-encoding
          rot = {1: 0, 3: 180, 6: 90, 8: 270}[info.orientation];
          notes.embeddedAsIs++;
        } else {
          const r = await viaCanvas(bytes, 'image/jpeg');
          img = r.png ? await doc.embedPng(r.bytes) : await doc.embedJpg(r.bytes);
          notes.reencoded++;
        }
      } else if (k === 'png') {
        dpi = pngDpi(bytes);
        img = await doc.embedPng(bytes);
        notes.embeddedAsIs++;
      } else if (k === 'webp') {
        const r = await viaCanvas(bytes, 'image/webp');
        img = r.png ? await doc.embedPng(r.bytes) : await doc.embedJpg(r.bytes);
        notes.reencoded++;
      } else {
        throw new Error('unsupported');
      }
    } catch {
      throw new Error(`${name} could not be read. Use JPG, PNG or WebP images.`);
    }
    if (!dpi || dpi < 50 || dpi > 1200) dpi = 96;
    // Displayed size in pixels after orientation.
    const turned = rot === 90 || rot === 270;
    const dwPx = turned ? img.height : img.width, dhPx = turned ? img.width : img.height;
    let pw, ph, dw, dh;
    if (pageSize === 'fit') {
      dw = dwPx * 72 / dpi; dh = dhPx * 72 / dpi;
      const maxSide = 14400 - 2 * margin; // PDF page size limit is 200 inches
      if (Math.max(dw, dh) > maxSide) { const s = maxSide / Math.max(dw, dh); dw *= s; dh *= s; }
      pw = dw + 2 * margin; ph = dh + 2 * margin;
    } else {
      [pw, ph] = SIZES[pageSize];
      const landscape = orientation === 'landscape' || (orientation === 'auto' && dwPx > dhPx);
      if (landscape) [pw, ph] = [ph, pw];
      const s = Math.min((pw - 2 * margin) / dwPx, (ph - 2 * margin) / dhPx);
      dw = dwPx * s; dh = dhPx * s;
    }
    const page = doc.addPage([pw, ph]);
    const bx = (pw - dw) / 2, by = (ph - dh) / 2;
    // pdf-lib draws: translate(x, y) rotate(r) scale(width, height). Rotations are counter-clockwise.
    if (rot === 0) page.drawImage(img, {x: bx, y: by, width: dw, height: dh});
    else if (rot === 90) page.drawImage(img, {x: bx, y: by + dh, width: dh, height: dw, rotate: degrees(-90)});
    else if (rot === 270) page.drawImage(img, {x: bx + dw, y: by, width: dh, height: dw, rotate: degrees(90)});
    else page.drawImage(img, {x: bx + dw, y: by + dh, width: dw, height: dh, rotate: degrees(180)});
  }
  report(files.length, files.length, 'Writing the PDF…');
  return {bytes: await doc.save({useObjectStreams: true}), notes};
}

// ---------- Pages rendered as JPEG (compress, "Rasterize" option) ----------
async function rasterPages({pages}) {
  const doc = await PDFDocument.create();
  doc.setProducer('Quire PDF (quireapps.com/pdf)');
  for (let i = 0; i < pages.length; i++) {
    report(i, pages.length, `Assembling page ${i + 1} of ${pages.length}…`);
    const {jpeg, width, height} = pages[i];
    const img = await doc.embedJpg(jpeg);
    doc.addPage([width, height]).drawImage(img, {x: 0, y: 0, width, height});
  }
  const out = await doc.save({useObjectStreams: true});
  return {bytes: out};
}

// Removes metadata from JPEG, PNG and WebP files at the byte level. The image data is copied
// unchanged, so there is no re-encoding and no quality loss.
//   JPEG: drops EXIF, XMP, IPTC/Photoshop, MPF, C2PA and other APPn segments, comments, and any
//         data after the end-of-image marker. Keeps JFIF (APP0), the ICC profile (APP2) and the
//         Adobe segment (APP14, which tells decoders how to read the colors). The compressed
//         scan data is copied byte for byte.
//   PNG:  drops eXIf, tEXt, zTXt, iTXt, tIME and caBX (C2PA) chunks, and data after IEND.
//   WebP: drops EXIF and XMP chunks, updates the VP8X flags and the RIFF size.
// Optionally writes back a minimal EXIF block holding only the Orientation tag, so rotated
// photos still display upright. Pure JS; used by strip-worker.js and by the Node tests.
import {exifSummary, orientationOnlyExif, crc32} from './exif.js';

const str = (u8, at, n) => String.fromCharCode(...u8.subarray(at, at + n));
const startsWith = (u8, s) => u8.length >= s.length && str(u8, 0, s.length) === s;
const concat = parts => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const latin1 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); return s; };

export function detectFormat(u8) {
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'jpeg';
  if (startsWith(u8, '\x89PNG\r\n\x1a\n')) return 'png';
  if (startsWith(u8, 'RIFF') && str(u8, 8, 4) === 'WEBP') return 'webp';
  return null;
}

// Collects what was found, in a form the page can show.
function report() {
  return {gps: false, lat: null, lon: null, camera: null, date: null, other: [], blocks: [], text: [], orientation: null, removed: [], removedBytes: 0};
}
function addBlock(r, label) { if (!r.blocks.includes(label)) r.blocks.push(label); }
function removed(r, label, bytes) {
  const hit = r.removed.find(x => x.label === label);
  if (hit) hit.bytes += bytes; else r.removed.push({label, bytes});
  r.removedBytes += bytes;
}
function camera(make, model) {
  if (!make) return model || null;
  if (!model) return make;
  return model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`;
}
function addExif(r, tiff) {
  const s = exifSummary(tiff);
  addBlock(r, 'EXIF');
  if (s.gps) { r.gps = true; if (s.lat != null) { r.lat = s.lat; r.lon = s.lon; } }
  r.camera ||= camera(s.make, s.model);
  r.date ||= s.date;
  for (const o of s.other) if (!r.other.includes(o)) r.other.push(o);
  if (s.thumbnail) addBlock(r, 'thumbnail');
  if (s.orientation != null) r.orientation = s.orientation;
}
function addXmp(r, text) {
  addBlock(r, 'XMP');
  if (/GPSLatitude|GPSLongitude/.test(text)) r.gps = true;
  const attr = name => (text.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`)) || text.match(new RegExp(`<${name}>([^<]*)<`)) || [])[1]?.trim() || null;
  r.camera ||= camera(attr('tiff:Make'), attr('tiff:Model'));
  r.date ||= attr('exif:DateTimeOriginal') || attr('xmp:CreateDate') || attr('photoshop:DateCreated');
  if (r.orientation == null) { const o = +attr('tiff:Orientation'); if (o >= 1 && o <= 8) r.orientation = o; }
}

async function inflate(bytes) {
  try {
    const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  } catch { return null; }
}

// ---------- JPEG ----------
const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXT_ID = 'http://ns.adobe.com/xmp/extension/\0';

export function stripJpeg(u8, {keepOrientation = true, keepIcc = true} = {}) {
  if (detectFormat(u8) !== 'jpeg') throw new Error('This is not a JPEG file.');
  const r = report();
  const parts = [u8.subarray(0, 2)];
  let jfifPart = -1, at = 2, sawEoi = false, sawSos = false;
  while (at < u8.length) {
    if (u8[at] !== 0xff) throw new Error('This JPEG file is damaged: a marker is missing at byte ' + at + '.');
    let m = at + 1;
    while (m < u8.length && u8[m] === 0xff) m++; // fill bytes
    if (m >= u8.length) break;
    const marker = u8[m];
    if (marker === 0xd9) { parts.push(u8.subarray(at, m + 1)); at = m + 1; sawEoi = true; break; }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { parts.push(u8.subarray(at, m + 1)); at = m + 1; continue; }
    if (m + 3 > u8.length) throw new Error('This JPEG file is cut off.');
    const end = m + 1 + ((u8[m + 1] << 8) | u8[m + 2]);
    if (end > u8.length) throw new Error('This JPEG file is cut off.');
    const seg = u8.subarray(at, end), p = u8.subarray(m + 3, end);
    let drop = null;
    if (marker === 0xe0) {
      if (startsWith(p, 'JFIF\0')) jfifPart = parts.length;
      else drop = startsWith(p, 'JFXX\0') ? 'JFIF thumbnail' : 'APP0 data';
    } else if (marker === 0xe1) {
      if (startsWith(p, 'Exif\0')) { addExif(r, p.subarray(6)); drop = 'EXIF'; }
      else if (startsWith(p, XMP_ID)) { addXmp(r, latin1(p.subarray(XMP_ID.length))); drop = 'XMP'; }
      else if (startsWith(p, XMP_EXT_ID)) { addXmp(r, latin1(p.subarray(XMP_EXT_ID.length + 40))); drop = 'XMP'; }
      else drop = 'APP1 data';
    } else if (marker === 0xe2) {
      if (startsWith(p, 'ICC_PROFILE\0')) { if (!keepIcc) drop = 'color profile'; }
      else if (startsWith(p, 'MPF\0')) drop = 'MPF index of extra images';
      else drop = startsWith(p, 'FPXR\0') ? 'FlashPix data' : 'APP2 data';
    } else if (marker === 0xee) {
      if (!startsWith(p, 'Adobe')) drop = 'APP14 data';
    } else if (marker === 0xed) {
      drop = startsWith(p, 'Photoshop 3.0\0') ? 'IPTC/Photoshop' : 'APP13 data';
    } else if (marker === 0xeb) {
      drop = startsWith(p, 'JP') ? 'Content Credentials (C2PA)' : 'APP11 data';
    } else if (marker >= 0xe3 && marker <= 0xef) {
      drop = `APP${marker - 0xe0} data`;
    } else if (marker === 0xfe) {
      drop = 'comment';
    }
    if (drop) { addBlock(r, drop); removed(r, drop, seg.length); } else parts.push(seg);
    at = end;
    if (marker === 0xda) {
      // Entropy-coded data: copied as is up to the next marker that is not a stuffed byte or a restart.
      sawSos = true;
      let q = at;
      while (q + 1 < u8.length) {
        if (u8[q] === 0xff) {
          const n = u8[q + 1];
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { q += 2; continue; }
          if (n === 0xff) { q += 1; continue; }
          break;
        }
        q++;
      }
      if (q + 1 >= u8.length) q = u8.length;
      parts.push(u8.subarray(at, q));
      at = q;
    }
  }
  if (!sawSos) throw new Error('This JPEG file has no image data.');
  if (at < u8.length) {
    // Phones and cameras append extra JPEGs here (previews, depth maps, gain maps, motion photo
    // video), each with its own metadata.
    addBlock(r, 'data after the image');
    removed(r, 'data after the image', u8.length - at);
  }
  if (!sawEoi) r.truncated = true;
  if (keepOrientation && r.orientation && r.orientation !== 1) {
    const tiff = orientationOnlyExif(r.orientation);
    const payload = concat([Uint8Array.from('Exif\0\0', c => c.charCodeAt(0)), tiff]);
    const seg = concat([Uint8Array.of(0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255), payload]);
    parts.splice(jfifPart >= 0 ? jfifPart + 1 : 1, 0, seg);
    r.orientationKept = r.orientation;
  }
  return {bytes: r.removedBytes || r.orientationKept ? concat(parts) : u8, report: r};
}

// ---------- PNG ----------
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export async function stripPng(u8, {keepOrientation = true, keepIcc = true} = {}) {
  if (detectFormat(u8) !== 'png') throw new Error('This is not a PNG file.');
  const r = report();
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const parts = [u8.subarray(0, 8)];
  let at = 8, sawIend = false;
  const LABEL = {eXIf: 'EXIF', tEXt: 'text fields', zTXt: 'text fields', iTXt: 'text fields', tIME: 'modification time', caBX: 'Content Credentials (C2PA)'};
  while (at + 12 <= u8.length) {
    const len = v.getUint32(at), type = str(u8, at + 4, 4), end = at + 12 + len;
    if (end > u8.length) throw new Error('This PNG file is cut off.');
    const chunk = u8.subarray(at, end), data = u8.subarray(at + 8, at + 8 + len);
    let drop = LABEL[type] || (type === 'iCCP' && !keepIcc ? 'color profile' : null);
    if (type === 'eXIf') addExif(r, startsWith(data, 'Exif\0') ? data.subarray(6) : data);
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const nul = data.indexOf(0);
      const key = latin1(data.subarray(0, nul < 0 ? data.length : nul));
      let text = null;
      if (type === 'tEXt') text = latin1(data.subarray(nul + 1));
      else if (type === 'zTXt') { const t = await inflate(data.subarray(nul + 2)); text = t && latin1(t); }
      else {
        // iTXt: keyword\0 flag method lang\0 translated\0 text
        const flag = data[nul + 1];
        let p = nul + 3;
        p = data.indexOf(0, p) + 1; p = data.indexOf(0, p) + 1;
        const raw = data.subarray(p);
        const t = flag ? await inflate(raw) : raw;
        text = t && new TextDecoder().decode(t);
      }
      if (key === 'XML:com.adobe.xmp') { addXmp(r, text || ''); drop = 'XMP'; }
      else {
        if (!r.text.includes(key)) r.text.push(key);
        if (key === 'Raw profile type exif' || key === 'Raw profile type APP1') addBlock(r, 'EXIF');
        if (/creation time|date/i.test(key) && text) r.date ||= text.trim().slice(0, 40);
      }
    }
    if (type === 'tIME') r.text.includes('modification time') || r.text.push('modification time');
    if (drop) { addBlock(r, drop); removed(r, drop, chunk.length); } else parts.push(chunk);
    at = end;
    if (type === 'IEND') { sawIend = true; break; }
  }
  if (!sawIend) throw new Error('This PNG file is cut off.');
  if (at < u8.length) { addBlock(r, 'data after the image'); removed(r, 'data after the image', u8.length - at); }
  if (keepOrientation && r.orientation && r.orientation !== 1) {
    parts.splice(2, 0, pngChunk('eXIf', orientationOnlyExif(r.orientation)));
    r.orientationKept = r.orientation;
  }
  return {bytes: r.removedBytes || r.orientationKept ? concat(parts) : u8, report: r};
}

// ---------- WebP ----------
export function stripWebp(u8, {keepOrientation = true, keepIcc = true} = {}) {
  if (detectFormat(u8) !== 'webp') throw new Error('This is not a WebP file.');
  const r = report();
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const riffEnd = Math.min(u8.length, 8 + v.getUint32(4, true));
  const chunks = [];
  let at = 12;
  while (at + 8 <= riffEnd) {
    const type = str(u8, at, 4), len = v.getUint32(at + 4, true);
    const end = Math.min(at + 8 + len + (len & 1), u8.length);
    if (at + 8 + len > u8.length) throw new Error('This WebP file is cut off.');
    const chunk = u8.subarray(at, end), data = u8.subarray(at + 8, at + 8 + len);
    let drop = null;
    if (type === 'EXIF') { addExif(r, startsWith(data, 'Exif\0') ? data.subarray(6) : data); drop = 'EXIF'; }
    else if (type === 'XMP ') { addXmp(r, latin1(data)); drop = 'XMP'; }
    else if (type === 'ICCP' && !keepIcc) drop = 'color profile';
    if (drop) { addBlock(r, drop); removed(r, drop, chunk.length); } else chunks.push({type, chunk});
    at = end;
  }
  if (u8.length > riffEnd) { addBlock(r, 'data after the image'); removed(r, 'data after the image', u8.length - riffEnd); }
  if (keepOrientation && r.orientation && r.orientation !== 1 && chunks.some(c => c.type === 'VP8X')) {
    const tiff = orientationOnlyExif(r.orientation);
    const c = new Uint8Array(8 + tiff.length + (tiff.length & 1));
    c.set(Uint8Array.from('EXIF', ch => ch.charCodeAt(0)));
    new DataView(c.buffer).setUint32(4, tiff.length, true);
    c.set(tiff, 8);
    chunks.push({type: 'EXIF', chunk: c});
    r.orientationKept = r.orientation;
  }
  if (!r.removedBytes && !r.orientationKept) return {bytes: u8, report: r};
  const vp8x = chunks.find(c => c.type === 'VP8X');
  if (vp8x) {
    const c = vp8x.chunk.slice(); // copy: the input stays untouched
    let flags = c[8];
    if (!chunks.some(x => x.type === 'EXIF')) flags &= ~0x08;
    if (!chunks.some(x => x.type === 'XMP ')) flags &= ~0x04;
    if (!chunks.some(x => x.type === 'ICCP')) flags &= ~0x20;
    c[8] = flags;
    vp8x.chunk = c;
  }
  const body = concat(chunks.map(c => c.chunk));
  const out = new Uint8Array(12 + body.length);
  out.set(u8.subarray(0, 12));
  new DataView(out.buffer).setUint32(4, 4 + body.length, true);
  out.set(body, 12);
  return {bytes: out, report: r};
}

export async function stripMetadata(u8, opts) {
  const f = detectFormat(u8);
  if (f === 'jpeg') return {format: f, ...stripJpeg(u8, opts)};
  if (f === 'png') return {format: f, ...(await stripPng(u8, opts))};
  if (f === 'webp') return {format: f, ...stripWebp(u8, opts)};
  throw new Error('This file is not a JPG, PNG or WebP image (checked by its content, not its name).');
}

// EXIF (TIFF) editing and metadata segments for JPEG and PNG output. No dependencies.
// Used by the HEIC worker and by the Node tests.

const TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4};
const GPS_POINTER = 0x8825, ORIENTATION = 0x0112;

function tiffView(tiff) {
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = String.fromCharCode(tiff[0], tiff[1]);
  if (order !== 'II' && order !== 'MM') throw new Error('not TIFF data');
  const le = order === 'II';
  if (view.getUint16(2, le) !== 42) throw new Error('bad TIFF magic');
  return {view, le, ifd0: view.getUint32(4, le)};
}

function readIfd(view, le, at) {
  if (at < 8 || at + 2 > view.byteLength) throw new Error('IFD outside data');
  const n = view.getUint16(at, le);
  if (at + 2 + n * 12 + 4 > view.byteLength) throw new Error('IFD truncated');
  const entries = [];
  for (let i = 0; i < n; i++) {
    const e = at + 2 + i * 12;
    const type = view.getUint16(e + 2, le), count = view.getUint32(e + 4, le);
    entries.push({at: e, tag: view.getUint16(e, le), type, count, size: (TYPE_SIZE[type] || 1) * count, value: view.getUint32(e + 8, le)});
  }
  return {at, n, entries};
}

// Summary used by the UI and tests.
export function inspectExif(tiff) {
  const {view, le, ifd0} = tiffView(tiff);
  const ifd = readIfd(view, le, ifd0);
  const tag = t => ifd.entries.find(e => e.tag === t);
  const o = tag(ORIENTATION);
  const g = tag(GPS_POINTER);
  let gpsTags = 0;
  if (g) { try { gpsTags = readIfd(view, le, g.value).n; } catch { gpsTags = 0; } }
  return {orientation: o ? view.getUint16(o.at + 8, le) : null, hasGps: !!g, gpsTags};
}

// Returns a new TIFF block: Orientation set to 1 (the decoder has already rotated the pixels)
// and, if removeGps, the GPS IFD erased and its pointer deleted from IFD0.
export function editExif(input, {removeGps}) {
  const tiff = input.slice();
  const {view, le, ifd0} = tiffView(tiff);
  const ifd = readIfd(view, le, ifd0);
  const o = ifd.entries.find(e => e.tag === ORIENTATION);
  if (o && o.type === 3) view.setUint16(o.at + 8, 1, le);
  let removed = false;
  const g = ifd.entries.find(e => e.tag === GPS_POINTER);
  if (removeGps && g) {
    try {
      const gps = readIfd(view, le, g.value);
      for (const e of gps.entries) {
        if (e.size > 4 && e.value + e.size <= tiff.length) tiff.fill(0, e.value, e.value + e.size);
      }
      tiff.fill(0, gps.at, gps.at + 2 + gps.n * 12 + 4);
    } catch { /* pointer to garbage: dropping the pointer below is still enough */ }
    // Remove the pointer entry: shift later entries left, keep the next-IFD offset after them.
    const idx = ifd.entries.indexOf(g);
    const start = ifd.at + 2 + idx * 12;
    const tailEnd = ifd.at + 2 + ifd.n * 12 + 4;
    tiff.copyWithin(start, start + 12, tailEnd);
    tiff.fill(0, tailEnd - 12, tailEnd);
    view.setUint16(ifd.at, ifd.n - 1, le);
    removed = true;
  }
  return {tiff, removedGps: removed};
}

// ---------- JPEG ----------
function segment(marker, payload) {
  const seg = new Uint8Array(4 + payload.length);
  seg[0] = 0xff; seg[1] = marker;
  seg[2] = (payload.length + 2) >> 8; seg[3] = (payload.length + 2) & 255;
  seg.set(payload, 4);
  return seg;
}
const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0));
const concat = parts => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// Inserts APP1 (Exif) and APP2 (ICC_PROFILE) segments after SOI and any JFIF APP0.
export function jpegWithMetadata(jpeg, {exif, icc}) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4] << 8) | jpeg[5]);
  const segs = [];
  let dropped = [];
  if (exif) {
    if (exif.length + 8 <= 65533) segs.push(segment(0xe1, concat([ascii('Exif\0\0'), exif])));
    else dropped.push('exif');
  }
  if (icc) {
    const CHUNK = 65519, count = Math.ceil(icc.length / CHUNK);
    if (count <= 255) {
      for (let i = 0; i < count; i++) {
        segs.push(segment(0xe2, concat([ascii('ICC_PROFILE\0'), Uint8Array.of(i + 1, count), icc.subarray(i * CHUNK, (i + 1) * CHUNK)])));
      }
    } else dropped.push('icc');
  }
  return {bytes: concat([jpeg.subarray(0, at), ...segs, jpeg.subarray(at)]), dropped};
}

// Lists JPEG header segments (for tests): [{marker, payload}] up to SOS.
export function jpegSegments(jpeg) {
  const out = [];
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1];
    if (marker === 0xda) break;
    const len = (jpeg[at + 2] << 8) | jpeg[at + 3];
    out.push({marker, payload: jpeg.subarray(at + 4, at + 2 + len)});
    at += 2 + len;
  }
  return out;
}

export function exifFromJpeg(jpeg) {
  const app1 = jpegSegments(jpeg).find(s => s.marker === 0xe1 && String.fromCharCode(...s.payload.subarray(0, 6)) === 'Exif\0\0');
  return app1 ? app1.payload.subarray(6) : null;
}

// ---------- PNG ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes, crc = 0) {
  crc = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return ~crc >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(ascii(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Inserts iCCP and eXIf chunks after IHDR. Removes any existing iCCP/sRGB/gAMA/cHRM/eXIf
// chunks (the encoder may write sRGB, which would conflict with an embedded profile).
export async function pngWithMetadata(png, {exif, icc}) {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const parts = [png.subarray(0, 8)];
  let at = 8;
  const drop = new Set(icc ? ['iCCP', 'sRGB', 'gAMA', 'cHRM', 'eXIf'] : ['eXIf']);
  while (at + 12 <= png.length) {
    const len = v.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const chunk = png.subarray(at, at + 12 + len);
    if (!drop.has(type)) parts.push(chunk);
    if (type === 'IHDR') {
      if (icc) parts.push(pngChunk('iCCP', concat([ascii('ICC Profile\0'), Uint8Array.of(0), await zlib(icc)])));
      if (exif) parts.push(pngChunk('eXIf', exif));
    }
    at += 12 + len;
  }
  return concat(parts);
}

export function pngChunks(png) {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out = [];
  let at = 8;
  while (at + 12 <= png.length) {
    const len = v.getUint32(at);
    out.push({type: String.fromCharCode(...png.subarray(at + 4, at + 8)), data: png.subarray(at + 8, at + 8 + len)});
    at += 12 + len;
  }
  return out;
}

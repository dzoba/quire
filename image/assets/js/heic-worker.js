// HEIC/HEIF -> JPEG or PNG, in a module worker. The file never leaves this worker except as
// the converted bytes posted back to the page.
//   decode:   libheif (LGPL-3.0), loaded from dist/vendor/libheif/ as a separate module
//   metadata: our own HEIF box reader (Exif + ICC), EXIF edited before it is written
//   encode:   MozJPEG or OxiPNG (lib/encoders.js)
import libheifFactory from '../../vendor/libheif/libheif.mjs';
import {parseHeif} from './lib/heif-meta.js';
import {editExif, inspectExif, jpegWithMetadata, pngWithMetadata} from './lib/exif.js';
import {encodeJpeg, encodePngRaw} from './lib/encoders.js';

const MAX_PIXELS = 100_000_000;
let lib;

async function libheif() {
  if (lib) return lib;
  // Fetch the .wasm ourselves so loading does not depend on the server's MIME type for .wasm.
  const res = await fetch(new URL('../../vendor/libheif/libheif.wasm', import.meta.url));
  if (!res.ok) throw new Error('Could not load the HEIC decoder (' + res.status + ')');
  lib = libheifFactory({wasmBinary: await res.arrayBuffer()});
  if (lib && typeof lib.then === 'function') lib = await lib;
  return lib;
}

async function toRgba(L, handle) {
  const img = await L.heif_js_decode_image2(handle, L.heif_colorspace_RGB, L.heif_chroma_interleaved_RGBA);
  if (!img || img.code) throw new Error('The decoder could not read this image. It may use a HEIF feature that is not supported.');
  try {
    const ch = img.channels.find(c => c.id === L.heif_channel_interleaved) || img.channels[0];
    const {width, height, stride} = ch;
    let rgba;
    if (stride === width * 4) rgba = new Uint8ClampedArray(ch.data.buffer.slice(ch.data.byteOffset, ch.data.byteOffset + width * height * 4));
    else {
      rgba = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) rgba.set(ch.data.subarray(y * stride, y * stride + width * 4), y * width * 4);
    }
    return {rgba, width, height};
  } finally {
    L.heif_image_release(img.image);
  }
}

async function convert({bytes, format, quality, metadata}, progress) {
  progress('decoding');
  const L = await libheif();
  const u8 = new Uint8Array(bytes);
  let meta = null;
  try { meta = parseHeif(u8); } catch { meta = null; }

  const decoder = new L.HeifDecoder();
  const images = decoder.decode(u8);
  let pixels, count = images.length;
  try {
    if (!count) throw new Error('This file has no image the decoder can read. It may be damaged, or not a HEIC/HEIF photo.');
    const primary = images.find(i => i.is_primary()) || images[0];
    const w = primary.get_width(), h = primary.get_height();
    if (w * h > MAX_PIXELS) throw new Error(`The image is ${w} × ${h} pixels. The limit is 100 megapixels.`);
    pixels = await toRgba(L, primary.handle);
  } finally {
    images.forEach(i => i.free());
    if (decoder.decoder) { L.heif_context_free(decoder.decoder); decoder.decoder = null; }
  }

  // Metadata policy.
  const notes = {imageCount: count, hadExif: !!meta?.exif, hadGps: false, gpsRemoved: false, exifWritten: false, iccWritten: false};
  let exif = null;
  if (meta?.exif) {
    try {
      notes.hadGps = inspectExif(meta.exif).hasGps;
      if (metadata !== 'none') {
        const edited = editExif(meta.exif, {removeGps: metadata === 'nolocation'});
        exif = edited.tiff;
        notes.gpsRemoved = edited.removedGps;
      }
    } catch { exif = null; }
  }
  if (metadata === 'none' && notes.hadGps) notes.gpsRemoved = true;
  const icc = meta?.icc || null; // colour profile: kept in every mode, it holds no personal data

  progress('encoding');
  let out;
  if (format === 'png') {
    const png = await encodePngRaw(pixels.rgba, pixels.width, pixels.height);
    out = await pngWithMetadata(png, {exif, icc});
  } else {
    const jpg = await encodeJpeg(pixels.rgba, pixels.width, pixels.height, quality);
    const r = jpegWithMetadata(jpg, {exif, icc});
    out = r.bytes;
    if (r.dropped.includes('exif')) exif = null;
  }
  notes.exifWritten = !!exif;
  notes.iccWritten = !!icc;
  return {bytes: out, width: pixels.width, height: pixels.height, notes};
}

self.onmessage = async e => {
  const {id} = e.data;
  try {
    const r = await convert(e.data, stage => self.postMessage({id, stage}));
    self.postMessage({id, ok: true, ...r}, [r.bytes.buffer]);
  } catch (err) {
    self.postMessage({id, ok: false, error: err?.message || String(err)});
  }
};

self.postMessage({ready: true});

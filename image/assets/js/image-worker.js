// JPEG/PNG/WebP decode, resize and encode in a module worker. Used by the compressor, the
// resizer and the format converters.
//   decode + resize: the browser (createImageBitmap, OffscreenCanvas)
//   JPEG: MozJPEG; WebP: the browser's encoder; PNG: the browser's encoder, then OxiPNG (lossless)
// Metadata is not carried over: EXIF (including GPS location) is removed. EXIF orientation
// is applied to the pixels first, so the photo keeps the way it was displayed.
import {encodeJpeg, optimisePng} from './lib/encoders.js';
import {fitWithin, resizeTarget} from './lib/resize.js';

const MAX_PIXELS = 100_000_000;

async function run({bytes, type, format, quality, maxW, maxH, resize, background, optimisePngOn}, progress) {
  progress('decoding');
  if (typeof OffscreenCanvas === 'undefined') throw new Error('This browser cannot process images in the background. Try a current version of Chrome, Edge, Firefox or Safari.');
  let bmp;
  try {
    bmp = await createImageBitmap(new Blob([bytes], {type}), {imageOrientation: 'from-image'});
  } catch {
    throw new Error('The browser could not read this image. It may be damaged or in a format this browser cannot open.');
  }
  const srcWidth = bmp.width, srcHeight = bmp.height;
  if (srcWidth * srcHeight > MAX_PIXELS) { bmp.close(); throw new Error(`The image is ${srcWidth} × ${srcHeight} pixels. The limit is 100 megapixels.`); }
  let size;
  try {
    size = resize ? resizeTarget(srcWidth, srcHeight, resize) : fitWithin(srcWidth, srcHeight, maxW, maxH);
  } catch (e) { bmp.close(); throw e; }
  const {width, height} = size;
  if (width * height > MAX_PIXELS) { bmp.close(); throw new Error(`The new size would be ${width} × ${height} pixels. The limit is 100 megapixels.`); }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) { bmp.close(); throw new Error('The image is too large for this browser to process. Try a smaller size.'); }
  if (format === 'jpeg') {
    // JPEG has no transparency: paint the background color first, then draw the image over it.
    ctx.fillStyle = /^#[0-9a-f]{6}$/i.test(background || '') ? background : '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();

  progress('encoding');
  let out, outType;
  if (format === 'jpeg') {
    const id = ctx.getImageData(0, 0, width, height);
    out = await encodeJpeg(id.data, width, height, quality);
    outType = 'image/jpeg';
  } else if (format === 'webp') {
    const blob = await canvas.convertToBlob({type: 'image/webp', quality: quality / 100});
    if (blob.type !== 'image/webp') throw new Error('This browser cannot create WebP files (Safari is one). Use Chrome, Edge or Firefox, or choose JPG or PNG.');
    out = new Uint8Array(await blob.arrayBuffer());
    outType = 'image/webp';
  } else {
    const blob = await canvas.convertToBlob({type: 'image/png'});
    out = new Uint8Array(await blob.arrayBuffer());
    if (optimisePngOn) {
      progress('optimising');
      out = await optimisePng(out);
    }
    outType = 'image/png';
  }
  return {bytes: out, type: outType, width, height, srcWidth, srcHeight};
}

self.onmessage = async e => {
  const {id} = e.data;
  try {
    const r = await run(e.data, stage => self.postMessage({id, stage}));
    self.postMessage({id, ok: true, ...r}, [r.bytes.buffer]);
  } catch (err) {
    self.postMessage({id, ok: false, error: err?.message || String(err)});
  }
};

self.postMessage({ready: true});

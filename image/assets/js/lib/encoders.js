// WASM encoders shared by both workers. Each codec loads from dist/vendor/ on first use.
//   JPEG: MozJPEG (via jSquash), from raw RGBA, so no canvas size limit applies.
//   PNG:  OxiPNG (via jSquash), lossless; either from raw RGBA or by re-optimising a PNG.
import mozjpegEncode from '../../../vendor/mozjpeg/encode.js';
import initOxipng, {optimise, optimise_raw} from '../../../vendor/oxipng/codec/pkg/squoosh_oxipng.js';

const OXIPNG_LEVEL = 1; // Level 2 was ~30% slower on a 12 MP photo for a 0.2% smaller file.
let oxipngReady;
const oxipng = () => (oxipngReady ||= initOxipng(new URL('../../../vendor/oxipng/codec/pkg/squoosh_oxipng_bg.wasm', import.meta.url)));

// JPEG has no transparency: composite onto white so transparent areas do not turn black.
function flattenOnWhite(rgba) {
  for (let i = 3; i < rgba.length; i += 4) {
    const a = rgba[i];
    if (a === 255) continue;
    const k = a / 255, w = 255 * (1 - k);
    rgba[i - 3] = rgba[i - 3] * k + w;
    rgba[i - 2] = rgba[i - 2] * k + w;
    rgba[i - 1] = rgba[i - 1] * k + w;
    rgba[i] = 255;
  }
  return rgba;
}

export async function encodeJpeg(rgba, width, height, quality) {
  const data = flattenOnWhite(rgba);
  const out = await mozjpegEncode({data, width, height}, {quality});
  return new Uint8Array(out);
}

export async function encodePngRaw(rgba, width, height) {
  await oxipng();
  return optimise_raw(rgba, width, height, OXIPNG_LEVEL, false, false);
}

export async function optimisePng(pngBytes) {
  await oxipng();
  return optimise(pngBytes, OXIPNG_LEVEL, false, false);
}

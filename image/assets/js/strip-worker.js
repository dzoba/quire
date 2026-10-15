// Remove EXIF: byte-level metadata removal in a module worker (lib/strip.js). The image data is
// copied as is, never decoded or re-encoded.
import {stripMetadata} from './lib/strip.js';

const MIME = {jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp'};

self.onmessage = async e => {
  const {id, bytes, keepOrientation, keepIcc} = e.data;
  try {
    self.postMessage({id, stage: 'stripping'});
    const input = new Uint8Array(bytes);
    const r = await stripMetadata(input, {keepOrientation, keepIcc});
    const out = r.bytes === input ? input : r.bytes;
    self.postMessage({id, ok: true, bytes: out, type: MIME[r.format], format: r.format, report: r.report, unchanged: r.bytes === input}, [out.buffer]);
  } catch (err) {
    self.postMessage({id, ok: false, error: err?.message || String(err)});
  }
};

self.postMessage({ready: true});

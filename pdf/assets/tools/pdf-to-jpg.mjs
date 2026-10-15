// PDF to JPG/PNG: PDF.js renders each page at the chosen DPI; the image records that DPI
// (JFIF density for JPEG, pHYs for PNG). One image downloads directly; several go in a zip.
import {$, setupPicker, pdfAccept, readBytes, status, progress, fmtBytes, baseName, clearResult,
  downloadLink, resultNote, busy, openPdf, parseRanges, makeZip, crc32} from './common.mjs';

export const MAX_PIXELS = 16777216; // per page; larger pages are rendered at a lower DPI
let doc = null, name = '';

setupPicker({accept: pdfAccept, onFiles: async ([f]) => {
  clearResult();
  status('Opening…', 'busy');
  try {
    if (doc) await doc.loadingTask.destroy();
    doc = null;
    doc = await openPdf(await readBytes(f));
  } catch (e) { status(e.message, 'error'); return; }
  name = baseName(f.name);
  $('toolFileInfo').hidden = false;
  $('toolFileInfo').textContent = `${f.name} · ${fmtBytes(f.size)} · ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`;
  $('toolOptions').hidden = false;
  $('toolActions').hidden = false;
  status('Choose the format and resolution, then select Convert.');
}});

function setJpegDpi(b, dpi) {
  // Chrome, Firefox and Safari write a JFIF APP0 segment first; set units=1 (dpi) and density.
  if (b[2] === 0xFF && b[3] === 0xE0 && String.fromCharCode(...b.subarray(6, 11)) === 'JFIF\0') {
    b[13] = 1; b[14] = dpi >> 8; b[15] = dpi & 0xFF; b[16] = dpi >> 8; b[17] = dpi & 0xFF;
  }
  return b;
}
function setPngDpi(b, dpi) {
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const v = new DataView(chunk.buffer);
  v.setUint32(0, 9); chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  v.setUint32(8, ppm); v.setUint32(12, ppm); chunk[16] = 1;
  v.setUint32(17, crc32(chunk.subarray(4, 17)));
  const out = new Uint8Array(b.length + 21);
  out.set(b.subarray(0, 33)); out.set(chunk, 33); out.set(b.subarray(33), 54); // after IHDR
  return out;
}

$('toolGo').addEventListener('click', () => busy($('toolGo'), async () => {
  if (!doc) return;
  clearResult();
  const png = $('imgFormat').value === 'png';
  const dpi = Number($('imgDpi').value);
  const quality = 0.92;
  const text = $('imgPages').value.trim();
  const pages = [];
  for (const [a, b] of text ? parseRanges(text, doc.numPages) : [[1, doc.numPages]]) for (let n = a; n <= b; n++) if (!pages.includes(n)) pages.push(n);
  const files = [];
  const reduced = [];
  const width = String(doc.numPages).length;
  for (let i = 0; i < pages.length; i++) {
    const n = pages[i];
    progress(i, pages.length, `Rendering page ${n} (${i + 1} of ${pages.length})…`);
    const page = await doc.getPage(n);
    const unit = page.getViewport({scale: 1});
    let used = dpi;
    if (Math.round(unit.width * dpi / 72) * Math.round(unit.height * dpi / 72) > MAX_PIXELS) {
      used = Math.floor(72 * Math.sqrt(MAX_PIXELS / (unit.width * unit.height)));
      reduced.push(n);
    }
    const w = Math.round(unit.width * used / 72), h = Math.round(unit.height * used / 72);
    const vp = page.getViewport({scale: used / 72});
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const g = canvas.getContext('2d');
    // Stretch the viewport by the rounding difference so the page fills the canvas exactly.
    await page.render({canvasContext: g, viewport: vp, background: '#ffffff', transform: [w / vp.width, 0, 0, h / vp.height, 0, 0]}).promise;
    const blob = await new Promise(r => canvas.toBlob(r, png ? 'image/png' : 'image/jpeg', quality));
    let data = new Uint8Array(await blob.arrayBuffer());
    data = png ? setPngDpi(data, used) : setJpegDpi(data, used);
    files.push({name: `${name} page ${String(n).padStart(width, '0')}.${png ? 'png' : 'jpg'}`, data, n, w, h});
    canvas.width = canvas.height = 0;
    page.cleanup();
  }
  progress(null);
  const type = png ? 'image/png' : 'image/jpeg';
  const box = $('toolResult');
  if (files.length === 1) {
    status(`Done. ${files[0].w} × ${files[0].h} pixels.`, 'ok');
    box.append(downloadLink(new Blob([files[0].data], {type}), files[0].name, `Download ${png ? 'PNG' : 'JPG'}`));
  } else {
    status(`Done. ${files.length} images.`, 'ok');
    box.append(downloadLink(makeZip(files), `${name} (${png ? 'PNG' : 'JPG'} ${dpi} dpi).zip`, `Download ZIP of ${files.length} images`));
    resultNote('Or download single pages:');
    const list = document.createElement('ul');
    list.className = 'tool-files';
    for (const f of files) {
      const li = document.createElement('li');
      li.append(downloadLink(new Blob([f.data], {type}), f.name, `Page ${f.n}: ${f.w} × ${f.h} px, ${fmtBytes(f.data.length)}`, false));
      list.append(li);
    }
    box.append(list);
  }
  if (reduced.length) resultNote(`Page${reduced.length === 1 ? '' : 's'} ${reduced.join(', ')} ${reduced.length === 1 ? 'is' : 'are'} too large for ${dpi} dpi in a browser, so ${reduced.length === 1 ? 'it was' : 'they were'} rendered at a lower DPI (about 16.7 million pixels per page at most).`, 'warn');
}));

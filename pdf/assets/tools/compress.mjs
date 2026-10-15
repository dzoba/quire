// Compress PDF: re-encodes and downsamples embedded images in a worker (text and vector
// content are kept as they are), or, only if the user picks it, renders every page to JPEG.
import {$, setupPicker, pdfAccept, readBytes, isPdfBytes, status, progress, fmtBytes, baseName,
  clearResult, downloadLink, resultNote, work, busy, openPdf} from './common.mjs';

const LEVELS = {
  light: {dpi: 150, quality: 0.85},
  medium: {dpi: 100, quality: 0.7},
  strong: {dpi: 72, quality: 0.5},
  raster: {dpi: 100, quality: 0.7},
};
let file = null;

setupPicker({accept: pdfAccept, onFiles: ([f]) => {
  file = f;
  clearResult();
  $('toolFileInfo').hidden = false;
  $('toolFileInfo').textContent = `${f.name} · ${fmtBytes(f.size)}`;
  $('toolOptions').hidden = false;
  $('toolActions').hidden = false;
  status('Choose a level, then select Compress PDF.');
  $('toolGo').focus();
}});

$('toolGo').addEventListener('click', () => busy($('toolGo'), async () => {
  if (!file) return;
  clearResult();
  const level = document.querySelector('input[name=level]:checked').value;
  const {dpi, quality} = LEVELS[level];
  const bytes = await readBytes(file);
  if (!isPdfBytes(bytes)) throw new Error('This file is not a PDF.');
  const before = bytes.length;
  let out, stats = null;
  if (level === 'raster') out = await rasterize(bytes, dpi, quality);
  else {
    const r = await work('compress', {bytes, dpi, quality}, [bytes.buffer], (d, t, l) => progress(d, t, l));
    out = r.bytes; stats = r.stats;
  }
  progress(null);
  const after = out.length;
  const pct = Math.round((1 - after / before) * 100);
  const box = $('toolResult');
  const sizes = document.createElement('p');
  sizes.className = 'tool-sizes';
  sizes.innerHTML = '<span>Before <strong></strong></span><span>After <strong></strong></span>';
  sizes.querySelectorAll('strong')[0].textContent = fmtBytes(before);
  sizes.querySelectorAll('strong')[1].textContent = fmtBytes(after);
  box.append(sizes);
  if (stats) {
    const parts = [`${stats.images} image${stats.images === 1 ? '' : 's'} found`, `${stats.recompressed} made smaller`];
    if (stats.skipped) parts.push(`${stats.skipped} left as they were because of their format`);
    resultNote(parts.join(', ') + '. Text and drawings were not changed.');
  } else {
    resultNote('Every page is now a JPEG image. Text in this copy cannot be selected, searched or copied.', 'warn');
  }
  if (after >= before * 0.98) {
    status(after >= before ? 'The compressed copy is not smaller than your file.' : 'The compressed copy is less than 2% smaller.', 'warn');
    resultNote(after >= before
      ? 'This setting could not make your PDF smaller, so there is nothing to download. Your file probably has few or no large images. Keep the original, or try the Strong level.'
      : `It is ${fmtBytes(before - after)} smaller. That is probably not worth replacing your original.`, 'warn');
    if (after < before) box.append(downloadLink(new Blob([out], {type: 'application/pdf'}), `${baseName(file.name)} (compressed).pdf`, 'Download anyway'));
    return;
  }
  status(`Done. The new copy is ${pct}% smaller.`, 'ok');
  box.append(downloadLink(new Blob([out], {type: 'application/pdf'}), `${baseName(file.name)} (compressed).pdf`, 'Download compressed PDF'));
}));

// Renders each page with PDF.js and wraps the JPEGs in a new PDF. Loses selectable text.
async function rasterize(bytes, dpi, quality) {
  const doc = await openPdf(bytes);
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      progress(n - 1, doc.numPages, `Rendering page ${n} of ${doc.numPages}…`);
      const page = await doc.getPage(n);
      const unit = page.getViewport({scale: 1});
      let scale = dpi / 72;
      const cap = 16777216;
      if (unit.width * unit.height * scale * scale > cap) scale = Math.sqrt(cap / (unit.width * unit.height));
      const vp = page.getViewport({scale});
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
      await page.render({canvasContext: canvas.getContext('2d'), viewport: vp, background: '#ffffff'}).promise;
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
      pages.push({jpeg: new Uint8Array(await blob.arrayBuffer()), width: unit.width, height: unit.height});
      page.cleanup();
    }
  } finally { await doc.loadingTask.destroy(); }
  const r = await work('rasterPages', {pages}, pages.map(p => p.jpeg.buffer), (d, t, l) => progress(d, t, l));
  return r.bytes;
}

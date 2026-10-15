// Extract pages: pick pages from thumbnails or type a range; PDF.js extractPages() writes
// one new PDF with those pages, in their original order.
import {$, setupPicker, pdfAccept, readBytes, status, progress, fmtBytes, baseName, clearResult,
  downloadLink, busy, openPdf, parseRanges, pagesLabel, thumbGrid} from './common.mjs';

let doc = null, name = '', stopThumbs = null;
const selected = new Set();

setupPicker({accept: pdfAccept, onFiles: async ([f]) => {
  clearResult();
  status('Opening…', 'busy');
  try {
    stopThumbs?.();
    if (doc) await doc.loadingTask.destroy();
    doc = null;
    doc = await openPdf(await readBytes(f));
  } catch (e) { status(e.message, 'error'); return; }
  name = baseName(f.name);
  selected.clear();
  $('toolFileInfo').hidden = false;
  $('toolFileInfo').textContent = `${f.name} · ${fmtBytes(f.size)} · ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`;
  $('toolOptions').hidden = false;
  $('toolActions').hidden = false;
  $('pickRanges').value = '';
  stopThumbs = thumbGrid(doc, $('thumbs'), n => {
    const li = document.createElement('li');
    li.className = 'thumb';
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = n;
    box.addEventListener('change', () => { box.checked ? selected.add(n) : selected.delete(n); syncField(); });
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    const cap = document.createElement('span');
    cap.textContent = `Page ${n}`;
    label.append(canvas, box, cap);
    li.append(label);
    return li;
  });
  sync();
  status('Tick the pages to keep, or type them in the box.');
}});

function sync() {
  for (const box of $('thumbs').querySelectorAll('input[type=checkbox]')) {
    box.checked = selected.has(Number(box.value));
    box.closest('.thumb').classList.toggle('on', box.checked);
  }
  $('pickCount').textContent = selected.size ? `${selected.size} of ${doc.numPages} pages selected` : 'No pages selected';
}
function syncField() {
  $('pickRanges').value = pagesLabel([...selected].sort((a, b) => a - b));
  $('pickRanges').removeAttribute('aria-invalid');
  sync();
}
$('pickRanges').addEventListener('change', () => {
  if (!doc) return;
  const text = $('pickRanges').value.trim();
  selected.clear();
  if (text) {
    try {
      for (const [a, b] of parseRanges(text, doc.numPages)) for (let n = a; n <= b; n++) selected.add(n);
      $('pickRanges').removeAttribute('aria-invalid');
      status('');
    } catch (e) { $('pickRanges').setAttribute('aria-invalid', 'true'); status(e.message, 'error'); }
  }
  sync();
});
$('pickAll').addEventListener('click', () => { for (let n = 1; n <= doc.numPages; n++) selected.add(n); syncField(); });
$('pickNone').addEventListener('click', () => { selected.clear(); syncField(); });

$('toolGo').addEventListener('click', () => busy($('toolGo'), async () => {
  if (!doc) return;
  clearResult();
  if ($('pickRanges').getAttribute('aria-invalid') === 'true') throw new Error('Fix the page list first.');
  const pages = [...selected].sort((a, b) => a - b);
  if (!pages.length) throw new Error('Select at least one page.');
  progress(0, 1, 'Writing the new PDF…');
  const data = await doc.extractPages([{document: null, includePages: pages.map(n => n - 1)}]);
  progress(null);
  const label = pagesLabel(pages);
  status(`Done. The new PDF has ${pages.length} page${pages.length === 1 ? '' : 's'}.`, 'ok');
  $('toolResult').append(downloadLink(new Blob([data], {type: 'application/pdf'}), `${name} (pages ${label.replace(/, /g, ',')}).pdf`.slice(0, 180), 'Download PDF'));
}));

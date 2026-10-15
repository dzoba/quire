// Split PDF: PDF.js extractPages() writes each part (it carries over form fields, links,
// outline entries and tagged structure for the pages it keeps). Parts go into a STORE zip.
import {$, setupPicker, pdfAccept, readBytes, status, progress, fmtBytes, baseName, clearResult,
  downloadLink, resultNote, busy, openPdf, parseRanges, rangeLabel, makeZip} from './common.mjs';

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
  $('splitRanges').placeholder = doc.numPages > 1 ? `for example 1-${Math.ceil(doc.numPages / 2)}, ${Math.ceil(doc.numPages / 2) + 1}-${doc.numPages}` : '1';
  status('Choose how to split, then select Split PDF.');
}});

for (const r of document.querySelectorAll('input[name=mode]')) r.addEventListener('change', syncMode);
function syncMode() {
  const mode = document.querySelector('input[name=mode]:checked').value;
  $('splitRanges').disabled = mode !== 'ranges';
  $('splitEvery').disabled = mode !== 'every';
}
syncMode();

function groups() {
  const n = doc.numPages;
  const mode = document.querySelector('input[name=mode]:checked').value;
  if (mode === 'pages') return Array.from({length: n}, (_, i) => [i + 1, i + 1]);
  if (mode === 'ranges') return parseRanges($('splitRanges').value, n);
  const k = Number($('splitEvery').value);
  if (!Number.isInteger(k) || k < 1) throw new Error('Enter a whole number of pages, 1 or more.');
  const out = [];
  for (let a = 1; a <= n; a += k) out.push([a, Math.min(n, a + k - 1)]);
  return out;
}

$('toolGo').addEventListener('click', () => busy($('toolGo'), async () => {
  if (!doc) return;
  clearResult();
  const parts = groups();
  const files = [];
  const width = String(doc.numPages).length;
  for (let i = 0; i < parts.length; i++) {
    progress(i, parts.length, `Writing part ${i + 1} of ${parts.length}…`);
    const [a, b] = parts[i];
    const data = await doc.extractPages([{document: null, includePages: [[a - 1, b - 1]]}]);
    const label = a === b ? `page ${String(a).padStart(width, '0')}` : `pages ${String(a).padStart(width, '0')}-${String(b).padStart(width, '0')}`;
    files.push({name: `${name} ${label}.pdf`, data});
  }
  progress(null);
  const box = $('toolResult');
  if (files.length === 1) {
    status('Done. One file was created.', 'ok');
    box.append(downloadLink(new Blob([files[0].data], {type: 'application/pdf'}), files[0].name, 'Download PDF'));
    return;
  }
  const zip = makeZip(files);
  status(`Done. ${files.length} PDFs are in one ZIP file.`, 'ok');
  box.append(downloadLink(zip, `${name} (split).zip`, `Download ZIP of ${files.length} PDFs`));
  const list = document.createElement('ul');
  list.className = 'tool-files';
  for (let i = 0; i < files.length; i++) {
    const li = document.createElement('li');
    li.append(downloadLink(new Blob([files[i].data], {type: 'application/pdf'}), files[i].name, `${files[i].name} (${fmtBytes(files[i].data.length)}, pages ${rangeLabel(parts[i])})`, false));
    list.append(li);
  }
  resultNote('Or download the files one at a time:');
  box.append(list);
}));

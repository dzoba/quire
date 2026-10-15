// Images to PDF: JPG, PNG and WebP in, one PDF out (pdf-lib, in a worker). JPEGs are embedded
// byte for byte; PNGs are embedded losslessly; WebP is decoded and re-encoded.
import {$, setupPicker, status, progress, fmtBytes, clearResult, downloadLink, resultNote, busy, work, MAX_BYTES, baseName} from './common.mjs';

const MAX_FILES = 500;
let items = []; // {file, url, id}
let nextId = 1;

setupPicker({multiple: true, accept: f => {
  if (!/^image\/(jpeg|png|webp)$/.test(f.type) && !/\.(jpe?g|png|webp)$/i.test(f.name)) return `${f.name} is not a JPG, PNG or WebP image.`;
  return null;
}, onFiles: files => {
  clearResult();
  for (const file of files) items.push({file, url: URL.createObjectURL(file), id: nextId++});
  const total = items.reduce((s, it) => s + it.file.size, 0);
  if (items.length > MAX_FILES) { status(`That is more than ${MAX_FILES} images. Remove some first.`, 'error'); }
  else if (total > MAX_BYTES) status(`These images add up to ${fmtBytes(total)}. The limit is 100 MB in total.`, 'error');
  else status(`${items.length} image${items.length === 1 ? '' : 's'} added. Reorder them if needed, then select Create PDF.`);
  draw();
}});

function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
  draw();
  $('imgList').querySelector(`[data-id="${items[j].id}"] [data-act="${d < 0 ? 'up' : 'down'}"]`)?.focus();
}
function remove(i) {
  URL.revokeObjectURL(items[i].url);
  items.splice(i, 1);
  draw();
  (($('imgList').querySelectorAll('[data-act="remove"]')[Math.min(i, items.length - 1)]) || $('toolChoose')).focus();
}
let dragFrom = null;
function draw() {
  const list = $('imgList');
  list.textContent = '';
  items.forEach((it, i) => {
    const li = document.createElement('li');
    li.className = 'img-item';
    li.dataset.id = it.id;
    li.draggable = true;
    li.addEventListener('dragstart', e => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
    li.addEventListener('dragover', e => { if (dragFrom !== null) { e.preventDefault(); e.stopPropagation(); } });
    li.addEventListener('drop', e => {
      if (dragFrom === null) return;
      e.preventDefault(); e.stopPropagation();
      const [moved] = items.splice(dragFrom, 1);
      items.splice(i, 0, moved);
      dragFrom = null;
      draw();
    });
    li.addEventListener('dragend', () => { dragFrom = null; });
    const img = document.createElement('img');
    img.src = it.url; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    const label = document.createElement('span');
    label.className = 'img-name';
    label.textContent = `${i + 1}. ${it.file.name} (${fmtBytes(it.file.size)})`;
    const ctrls = document.createElement('span');
    ctrls.className = 'img-ctrls';
    for (const [act, text, aria, fn, off] of [
      ['up', '↑', `Move ${it.file.name} up`, () => move(i, -1), i === 0],
      ['down', '↓', `Move ${it.file.name} down`, () => move(i, 1), i === items.length - 1],
      ['remove', '×', `Remove ${it.file.name}`, () => remove(i), false]]) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'icon-btn'; b.textContent = text; b.dataset.act = act;
      b.setAttribute('aria-label', aria); b.disabled = off;
      b.addEventListener('click', fn);
      ctrls.append(b);
    }
    li.append(img, label, ctrls);
    list.append(li);
  });
  const has = items.length > 0;
  $('toolOptions').hidden = !has;
  $('toolActions').hidden = !has;
  $('toolFileInfo').hidden = !has;
  $('toolFileInfo').textContent = has ? `${items.length} image${items.length === 1 ? '' : 's'}, ${fmtBytes(items.reduce((s, it) => s + it.file.size, 0))}` : '';
  $('imgClear').hidden = !has;
}
$('imgClear').addEventListener('click', () => { for (const it of items) URL.revokeObjectURL(it.url); items = []; clearResult(); draw(); status(''); $('toolChoose').focus(); });
$('pageSize').addEventListener('change', () => { $('orientation').disabled = $('pageSize').value === 'fit'; });
$('orientation').disabled = $('pageSize').value === 'fit';

$('toolGo').addEventListener('click', () => busy($('toolGo'), async () => {
  clearResult();
  if (!items.length) throw new Error('Add at least one image.');
  const total = items.reduce((s, it) => s + it.file.size, 0);
  if (total > MAX_BYTES) throw new Error(`These images add up to ${fmtBytes(total)}. The limit is 100 MB in total.`);
  if (items.length > MAX_FILES) throw new Error(`Use ${MAX_FILES} images or fewer.`);
  const files = [];
  for (const it of items) files.push({name: it.file.name, bytes: new Uint8Array(await it.file.arrayBuffer())});
  const r = await work('images', {
    files, pageSize: $('pageSize').value, orientation: $('orientation').value, margin: Number($('margin').value),
  }, files.map(f => f.bytes.buffer), (d, t, l) => progress(d, t, l));
  progress(null);
  status(`Done. The PDF has ${files.length} page${files.length === 1 ? '' : 's'}.`, 'ok');
  const first = items.length === 1 ? baseName(items[0].file.name) : 'Images';
  $('toolResult').append(downloadLink(new Blob([r.bytes], {type: 'application/pdf'}), `${first}.pdf`, 'Download PDF'));
  if (r.notes.reencoded) resultNote(`${r.notes.reencoded} image${r.notes.reencoded === 1 ? ' was' : 's were'} re-encoded (WebP, or a JPEG with a mirrored EXIF orientation). The rest were embedded without re-encoding.`);
}));

// Rotate pages: changes each page's /Rotate entry (pdf-lib, in a worker), so every PDF
// reader shows the new orientation. Thumbnails preview the turn.
import {$, setupPicker, pdfAccept, readBytes, status, progress, fmtBytes, baseName, clearResult,
  downloadLink, busy, openPdf, thumbGrid, work} from './common.mjs';

let doc = null, file = null, turns = [], stopThumbs = null;

setupPicker({accept: pdfAccept, onFiles: async ([f]) => {
  clearResult();
  status('Opening…', 'busy');
  try {
    stopThumbs?.();
    if (doc) await doc.loadingTask.destroy();
    doc = null;
    doc = await openPdf(await readBytes(f));
  } catch (e) { status(e.message, 'error'); return; }
  file = f;
  turns = new Array(doc.numPages).fill(0);
  $('toolFileInfo').hidden = false;
  $('toolFileInfo').textContent = `${f.name} · ${fmtBytes(f.size)} · ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`;
  $('toolOptions').hidden = false;
  $('toolActions').hidden = false;
  stopThumbs = thumbGrid(doc, $('thumbs'), n => {
    const li = document.createElement('li');
    li.className = 'thumb';
    const frame = document.createElement('div');
    frame.className = 'thumb-frame';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    frame.append(canvas);
    const cap = document.createElement('span');
    cap.className = 'thumb-cap';
    const ctrls = document.createElement('div');
    ctrls.className = 'thumb-ctrls';
    for (const [dir, label, glyph] of [[-90, 'left', '↺'], [90, 'right', '↻']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon-btn';
      b.textContent = glyph;
      b.setAttribute('aria-label', `Rotate page ${n} ${label}`);
      b.addEventListener('click', () => { turn(n - 1, dir); });
      ctrls.append(b);
    }
    li.append(frame, cap, ctrls);
    return li;
  });
  draw();
  status('Rotate single pages with their buttons, or all pages at once.');
}});

function turn(i, d) { turns[i] = ((turns[i] + d) % 360 + 360) % 360; draw(); }
function draw() {
  for (const li of $('thumbs').children) {
    const i = Number(li.dataset.page) - 1;
    li.querySelector('canvas').style.transform = `rotate(${turns[i]}deg)`;
    li.classList.toggle('on', turns[i] !== 0);
    li.querySelector('.thumb-cap').textContent = `Page ${i + 1}${turns[i] ? `, turned ${turns[i] === 270 ? '90° left' : turns[i] === 90 ? '90° right' : '180°'}` : ''}`;
  }
  const changed = turns.filter(Boolean).length;
  $('rotCount').textContent = changed ? `${changed} page${changed === 1 ? '' : 's'} will be rotated` : 'No pages rotated yet';
}
$('rotAllLeft').addEventListener('click', () => { turns = turns.map(t => (t + 270) % 360); draw(); });
$('rotAllRight').addEventListener('click', () => { turns = turns.map(t => (t + 90) % 360); draw(); });
$('rotReset').addEventListener('click', () => { turns = turns.map(() => 0); draw(); });

$('toolGo').addEventListener('click', () => busy($('toolGo'), async () => {
  if (!doc) return;
  clearResult();
  if (!turns.some(Boolean)) throw new Error('Rotate at least one page first.');
  const bytes = await readBytes(file);
  progress(0, 1, 'Saving…');
  const r = await work('rotate', {bytes, rotations: turns}, [bytes.buffer]);
  progress(null);
  status('Done. The pages are rotated in the saved PDF.', 'ok');
  $('toolResult').append(downloadLink(new Blob([r.bytes], {type: 'application/pdf'}), `${baseName(file.name)} (rotated).pdf`, 'Download rotated PDF'));
}));

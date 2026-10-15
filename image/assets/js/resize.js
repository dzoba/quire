// Image resizer page. Decoding, resizing and encoding run in image-worker.js.
import {createBatchTool, formatBytes, baseName, bindRange, el, MB, TYPES, EXT, LABEL, typeOf, isHeic} from './ui.js';

const form = document.getElementById('settings');
const quality = document.getElementById('quality');
const width = document.getElementById('width');
const height = document.getElementById('height');
const keepRatio = document.getElementById('keepRatio');
const percent = document.getElementById('percent');
const oxipng = document.getElementById('oxipng');
bindRange(quality, document.getElementById('qualityOut'));
const radio = name => form.querySelector(`input[name="${name}"]:checked`).value;
const num = input => { const n = Math.floor(+input.value); return n > 0 ? n : 0; };
const syncControls = () => {
  const by = radio('by'), f = radio('format');
  document.getElementById('bySize').hidden = by !== 'size';
  document.getElementById('byPercent').hidden = by !== 'percent';
  quality.disabled = f === 'png';
  document.getElementById('qualityNote').hidden = f !== 'png';
  oxipng.closest('.img-check').hidden = !(f === 'png' || f === 'same');
};
syncControls();

const readSettings = () => {
  const by = radio('by');
  const resize = by === 'percent'
    ? {mode: 'percent', percent: Math.max(0, +percent.value || 0)}
    : {mode: 'size', width: num(width), height: num(height), keepRatio: keepRatio.checked};
  return {resize, format: radio('format'), quality: +quality.value, optimisePngOn: oxipng.checked};
};

createBatchTool({
  workerUrl: new URL('./image-worker.js', import.meta.url),
  maxBytes: 50 * MB,
  maxFiles: 100,
  verb: 'Resizing',
  pastVerb: 'resized',
  zipName: 'resized-images.zip',
  onSettings: syncControls,
  readSettings,
  settingsKey: () => JSON.stringify(readSettings()),
  check(file) {
    if (isHeic(file)) return 'This is a HEIC photo. Convert it with the HEIC to JPG converter first.';
    return typeOf(file) ? null : 'This tool accepts JPG, PNG and WebP files.';
  },
  message(file, bytes, o) {
    const out = o.format === 'same' ? typeOf(file) : o.format;
    return {bytes, type: file.type || 'image/' + typeOf(file), format: out, quality: o.quality, resize: o.resize, optimisePngOn: o.optimisePngOn};
  },
  outType: () => 'application/octet-stream',
  outName: (file, m) => baseName(file.name) + EXT[TYPES[m.type]],
  describe(r, res) {
    const f = TYPES[res.type];
    const ratio = (res.width / res.height) / (res.srcWidth / res.srcHeight);
    const out = [el('p', {class: 'img-detail',
      text: `${res.srcWidth} × ${res.srcHeight} → ${res.width} × ${res.height} · ${LABEL[typeOf(r.file)]} ${formatBytes(r.file.size)} → ${LABEL[f]} ${formatBytes(res.blob.size)}`})];
    const notes = [];
    if (res.width > res.srcWidth || res.height > res.srcHeight) notes.push('Enlarged. Enlarging adds pixels but no detail, so the image can look soft.');
    if (Math.abs(ratio - 1) > 0.01) notes.push('The proportions changed, so the image is stretched or squeezed.');
    if (notes.length) out.push(el('p', {class: 'img-note', text: notes.join(' ')}));
    return out;
  },
});

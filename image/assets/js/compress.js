// Image compressor page. Decoding, resizing and encoding run in compress-worker.js.
import {createBatchTool, formatBytes, baseName, bindRange, el, MB} from './ui.js';

const form = document.getElementById('settings');
const quality = document.getElementById('quality');
const maxW = document.getElementById('maxW');
const maxH = document.getElementById('maxH');
const oxipng = document.getElementById('oxipng');
bindRange(quality, document.getElementById('qualityOut'));
const format = () => form.querySelector('input[name="format"]:checked').value;
const syncControls = () => {
  const f = format();
  quality.disabled = f === 'png';
  document.getElementById('qualityNote').hidden = f !== 'png';
  oxipng.closest('.img-check').hidden = !(f === 'png' || f === 'same');
};
syncControls();

const TYPES = {'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp'};
const EXT = {jpeg: '.jpg', png: '.png', webp: '.webp'};
const LABEL = {jpeg: 'JPG', png: 'PNG', webp: 'WebP'};
const typeOf = file => TYPES[file.type] || ({jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp'})[file.name.split('.').pop().toLowerCase()];
const dim = input => { const n = Math.floor(+input.value); return n > 0 ? n : 0; };
const readSettings = () => ({format: format(), quality: +quality.value, maxW: dim(maxW), maxH: dim(maxH), optimisePngOn: oxipng.checked});

const tool = createBatchTool({
  workerUrl: new URL('./compress-worker.js', import.meta.url),
  maxBytes: 50 * MB,
  maxFiles: 100,
  verb: 'Compressing',
  pastVerb: 'compressed',
  zipName: 'compressed-images.zip',
  onSettings: syncControls,
  readSettings,
  settingsKey: () => JSON.stringify(readSettings()),
  check(file) {
    if (/\.(heic|heif)$/i.test(file.name) || /^image\/hei[cf]/.test(file.type)) return 'This is a HEIC photo. Convert it with the HEIC to JPG converter first.';
    return typeOf(file) ? null : 'This tool accepts JPG, PNG and WebP files.';
  },
  message(file, bytes, o) {
    const out = o.format === 'same' ? typeOf(file) : o.format;
    return {bytes, type: file.type || 'image/' + typeOf(file), format: out, quality: o.quality, maxW: o.maxW, maxH: o.maxH, optimisePngOn: o.optimisePngOn};
  },
  outType: () => 'application/octet-stream',
  outName(file, m) {
    const f = TYPES[m.type];
    return baseName(file.name) + EXT[f];
  },
  describe(r, res) {
    const before = r.file.size, after = res.blob.size;
    const f = TYPES[res.type];
    const resized = res.width !== res.srcWidth || res.height !== res.srcHeight;
    const dims = resized ? `${res.srcWidth} × ${res.srcHeight} → ${res.width} × ${res.height}` : `${res.width} × ${res.height}`;
    const pct = Math.round(Math.abs(1 - after / before) * 100);
    const change = after < before ? `${pct}% smaller` : after > before ? `${pct}% larger` : 'same size';
    const out = [el('p', {class: 'img-detail'},
      `${dims} · ${LABEL[typeOf(r.file)]} ${formatBytes(before)} → ${LABEL[f]} ${formatBytes(after)} `,
      el('span', {class: after < before ? 'img-gain' : 'img-loss', text: `(${change})`}))];
    if (after >= before) {
      const warn = el('div', {class: 'img-warn', role: 'note'});
      warn.append(el('p', {text: r.useOriginal
        ? 'You will download the original file, unchanged.' + (f !== typeOf(r.file) || resized ? ' It keeps its original format and size in pixels.' : '')
        : `The compressed file is not smaller than the original (${formatBytes(after)} vs ${formatBytes(before)}). This happens when an image is already well compressed, or when a format holds this kind of image less efficiently.`}));
      const btn = el('button', {type: 'button', class: 'btn-sm btn-quiet', 'aria-pressed': r.useOriginal ? 'true' : 'false',
        text: r.useOriginal ? 'Use the compressed file instead' : 'Keep the original instead'});
      btn.addEventListener('click', () => {
        r.useOriginal = !r.useOriginal;
        tool.render(r);
        r.li.querySelector('.img-warn button')?.focus();
      });
      warn.append(btn);
      out.push(warn);
    }
    return out;
  },
});

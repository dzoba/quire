// Format converter pages (PNG to JPG, JPG to PNG, WebP to JPG, WebP to PNG, JPG to WebP).
// One script for all of them: the input and output formats come from the form's data attributes.
// Decoding and encoding run in image-worker.js.
import {createBatchTool, formatBytes, baseName, bindRange, el, MB, TYPES, EXT, LABEL, typeOf, isHeic} from './ui.js';

const form = document.getElementById('settings');
const FROM = form.dataset.from, TO = form.dataset.to;
const quality = document.getElementById('quality');
const background = document.getElementById('background');
const oxipng = document.getElementById('oxipng');
if (quality) bindRange(quality, document.getElementById('qualityOut'));

// Converter pages that exist, for pointing a file of the wrong type to the right page.
const PAGES = {'png>jpeg': 'png-to-jpg', 'jpeg>png': 'jpg-to-png', 'webp>jpeg': 'webp-to-jpg', 'webp>png': 'webp-to-png', 'jpeg>webp': 'jpg-to-webp'};

// Safari (and any browser without a WebP encoder) returns a PNG when asked for WebP.
if (TO === 'webp') {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  if (!c.toDataURL('image/webp').startsWith('data:image/webp')) document.getElementById('webpWarn').hidden = false;
}

const readSettings = () => ({quality: quality ? +quality.value : 0, background: background ? background.value : '#ffffff', optimisePngOn: oxipng ? oxipng.checked : false});

createBatchTool({
  workerUrl: new URL('./image-worker.js', import.meta.url),
  maxBytes: 50 * MB,
  maxFiles: 100,
  verb: 'Converting',
  pastVerb: 'converted',
  zipName: `${LABEL[FROM].toLowerCase()}-to-${LABEL[TO].toLowerCase()}.zip`,
  readSettings,
  settingsKey: () => JSON.stringify(readSettings()),
  check(file) {
    if (isHeic(file)) return 'This is a HEIC photo. Use the HEIC to JPG converter, which can also make PNG files.';
    const t = typeOf(file);
    if (!t) return `This tool converts ${LABEL[FROM]} files. This file is not a JPG, PNG or WebP image.`;
    if (t === FROM) return null;
    if (t === TO) return `This is already a ${LABEL[TO]} file. To make it smaller, use the image compressor.`;
    const other = PAGES[`${t}>${TO}`];
    return `This is a ${LABEL[t]} file, and this tool converts ${LABEL[FROM]} files.` + (other ? ` Use the ${LABEL[t]} to ${LABEL[TO]} converter.` : ' The image compressor can convert it.');
  },
  message: (file, bytes, o) => ({bytes, type: file.type || 'image/' + FROM, format: TO, quality: o.quality, background: o.background, optimisePngOn: o.optimisePngOn}),
  outType: () => 'image/' + TO,
  outName: (file, m) => baseName(file.name) + EXT[TYPES[m.type]],
  describe(r, res) {
    return [el('p', {class: 'img-detail', text: `${res.width} × ${res.height} · ${LABEL[FROM]} ${formatBytes(r.file.size)} → ${LABEL[TYPES[res.type]]} ${formatBytes(res.blob.size)}`})];
  },
});

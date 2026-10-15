// HEIC to JPG page. Decoding and encoding run in heic-worker.js.
import {createBatchTool, formatBytes, baseName, bindRange, el, MB} from './ui.js';

const form = document.getElementById('settings');
const quality = document.getElementById('quality');
bindRange(quality, document.getElementById('qualityOut'));
const value = name => form.querySelector(`input[name="${name}"]:checked`).value;
const syncQuality = () => {
  const png = value('format') === 'png';
  quality.disabled = png;
  document.getElementById('qualityNote').hidden = !png;
};
syncQuality();

const readSettings = () => ({format: value('format'), quality: +quality.value, metadata: value('metadata')});

createBatchTool({
  workerUrl: new URL('./heic-worker.js', import.meta.url),
  maxBytes: 50 * MB,
  maxFiles: 100,
  verb: 'Converting',
  pastVerb: 'converted',
  zipName: 'converted-photos.zip',
  onSettings: syncQuality,
  readSettings,
  settingsKey: () => JSON.stringify(readSettings()),
  check(file) {
    const ok = /\.(heic|heif|hif)$/i.test(file.name) || /^image\/hei[cf]/.test(file.type);
    return ok ? null : 'This is not a HEIC or HEIF file. To make a JPG, PNG or WebP file smaller, use the image compressor.';
  },
  message: (file, bytes, o) => ({bytes, format: o.format, quality: o.quality, metadata: o.metadata}),
  outType: o => (o.format === 'png' ? 'image/png' : 'image/jpeg'),
  outName: (file, m, o) => baseName(file.name) + (o.format === 'png' ? '.png' : '.jpg'),
  describe(r, res) {
    const n = res.notes, o = res.opts;
    const fmt = o.format === 'png' ? 'PNG' : 'JPG';
    const out = [el('p', {class: 'img-detail', text: `${res.width} × ${res.height} · HEIC ${formatBytes(r.file.size)} → ${fmt} ${formatBytes(res.blob.size)}`})];
    const notes = [];
    if (n.imageCount > 1) notes.push(`This file holds ${n.imageCount} images. The converter used the main (primary) one.`);
    if (!n.hadExif) notes.push('The original had no camera metadata.');
    else if (o.metadata === 'none') notes.push(n.hadGps ? 'All metadata removed, including the location.' : 'All metadata removed.');
    else if (o.metadata === 'nolocation') notes.push(n.hadGps ? 'Location removed. Date and camera details kept.' : 'No location in the original. Date and camera details kept.');
    else notes.push(n.hadGps ? 'All metadata kept, including the location.' : 'All metadata kept. The original had no location.');
    if (n.hadExif && o.metadata !== 'none' && !n.exifWritten) notes.push('The metadata was too large for a JPG header and was left out.');
    out.push(el('p', {class: 'img-note', text: notes.join(' ')}));
    return out;
  },
});

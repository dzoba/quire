// Remove EXIF page. The metadata is removed at the byte level in strip-worker.js.
import {createBatchTool, formatBytes, el, MB, LABEL, typeOf, isHeic} from './ui.js';

const keepOrientation = document.getElementById('keepOrientation');
const keepIcc = document.getElementById('keepIcc');
const readSettings = () => ({keepOrientation: keepOrientation.checked, keepIcc: keepIcc.checked});
const ORIENT = {2: 'mirrored', 3: 'rotated 180°', 4: 'mirrored vertically', 5: 'mirrored and rotated', 6: 'rotated 90° clockwise', 7: 'mirrored and rotated', 8: 'rotated 90° counterclockwise'};
const coord = (lat, lon) => `${Math.abs(lat).toFixed(5)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(5)}° ${lon < 0 ? 'W' : 'E'}`;

createBatchTool({
  workerUrl: new URL('./strip-worker.js', import.meta.url),
  maxBytes: 50 * MB,
  maxFiles: 100,
  verb: 'Cleaning',
  pastVerb: 'cleaned',
  zipName: 'images-without-metadata.zip',
  readSettings,
  settingsKey: () => JSON.stringify(readSettings()),
  check(file) {
    if (isHeic(file)) return 'This is a HEIC photo. The HEIC to JPG converter can remove all metadata while it converts (choose "Remove all metadata").';
    return typeOf(file) ? null : 'This tool accepts JPG, PNG and WebP files.';
  },
  message: (file, bytes, o) => ({bytes, keepOrientation: o.keepOrientation, keepIcc: o.keepIcc}),
  outType: () => 'application/octet-stream',
  outName: file => file.name,
  describe(r, res) {
    const f = res.report;
    const row = (k, v, cls) => [el('dt', {text: k}), el('dd', {class: cls, text: v})];
    const found = el('dl', {class: 'img-found'},
      ...row('Location (GPS)', f.gps ? (f.lat != null ? `Yes: ${coord(f.lat, f.lon)}` : 'Yes') : 'None', f.gps ? 'img-loss' : null),
      ...row('Camera', f.camera || 'None'),
      ...row('Date', f.date || 'None'),
      ...(f.other.length ? row('Other details', f.other.join(', ')) : []),
      ...(f.text.length ? row('Text fields', f.text.join(', ')) : []),
      ...row('Metadata found', f.blocks.length ? f.blocks.join(', ') : 'None'));
    const fmt = LABEL[res.format];
    const notes = [];
    if (res.unchanged) notes.push(`No metadata to remove. The file is unchanged.`);
    else {
      const what = f.removed.map(x => x.label).join(', ');
      notes.push(`Removed ${formatBytes(f.removedBytes)}: ${what}. The image data is copied as is, so quality is unchanged.`);
    }
    if (f.orientationKept) notes.push(`Kept only the orientation tag (${ORIENT[f.orientationKept] || f.orientationKept}), so the photo still displays upright.`);
    else if (f.orientation && f.orientation !== 1) notes.push('The orientation tag was removed too, so this photo may now display sideways or flipped.');
    if (f.truncated) notes.push('The original file ends early (it may be cut off). The output keeps the same image data.');
    return [
      el('p', {class: 'img-detail', text: `${fmt} ${formatBytes(r.file.size)} → ${formatBytes(res.blob.size)}`}),
      found,
      el('p', {class: 'img-note', text: notes.join(' ')}),
    ];
  },
});

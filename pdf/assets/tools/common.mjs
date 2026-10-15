// Shared helpers for the single-task PDF tool pages. Everything runs in this tab:
// files are read with the File API, processed here or in a same-origin worker, and
// handed back as blob: downloads. Nothing is sent over the network.

export const MAX_BYTES = 100 * 1024 * 1024; // stated on every page
export const $ = id => document.getElementById(id);

const statusEl = () => $('toolStatus');
const progressEl = () => $('toolProgress');

export function status(text, kind = '') {
  const el = statusEl();
  el.textContent = text;
  el.dataset.kind = kind;
}
export function progress(done, total, label) {
  const el = progressEl();
  if (done == null) { el.hidden = true; el.removeAttribute('value'); return; }
  el.hidden = false;
  el.max = total || 1;
  el.value = Math.min(done, total || 1);
  if (label) status(label, 'busy');
}
export const fmtBytes = n => n < 1024 ? `${n} bytes` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 2 : 1)} MB`;
export const baseName = name => (name || 'document').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'document';

// File picking: the Choose button, the hidden input, and drag and drop onto the drop zone
// (or anywhere on the page). `accept(file)` returns an error string or null.
export function setupPicker({multiple = false, accept, onFiles}) {
  const input = $('toolFile'), button = $('toolChoose'), zone = $('toolDrop');
  button.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files.length) take([...input.files]); input.value = ''; });
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); zone.classList.add('over'); });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) zone.classList.remove('over'); });
  document.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    zone.classList.remove('over');
    take([...e.dataTransfer.files]);
  });
  function take(files) {
    if (!multiple) files = files.slice(0, 1);
    const errors = [];
    const ok = files.filter(f => { const err = accept(f); if (err) errors.push(err); return !err; });
    if (errors.length) status(errors.join(' '), 'error');
    if (ok.length) onFiles(ok);
  }
}
export function pdfAccept(file) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return `${file.name} is not a PDF.`;
  if (file.size > MAX_BYTES) return `${file.name} is ${fmtBytes(file.size)}. The limit is 100 MB.`;
  return null;
}
export async function readBytes(file) { return new Uint8Array(await file.arrayBuffer()); }
export function isPdfBytes(b) {
  const head = new TextDecoder('latin1').decode(b.subarray(0, 1024));
  return head.includes('%PDF-');
}

// ---- PDF.js (the same build the editor uses), loaded on demand ----
let pdfjsPromise;
export function pdfjs() {
  pdfjsPromise ||= import(new URL('../../app/pdfjs/build/pdf.mjs', import.meta.url).href).then(lib => {
    lib.GlobalWorkerOptions.workerSrc = new URL('../../app/pdfjs/build/pdf.worker.mjs', import.meta.url).href;
    return lib;
  });
  return pdfjsPromise;
}
export async function openPdf(bytes) {
  const lib = await pdfjs();
  const web = new URL('../../app/pdfjs/web/', import.meta.url).href;
  const task = lib.getDocument({
    data: bytes.slice(), // PDF.js takes ownership of the buffer it is given
    isEvalSupported: false, enableXfa: false, useSystemFonts: false,
    cMapUrl: web + 'cmaps/', cMapPacked: true, standardFontDataUrl: web + 'standard_fonts/',
    wasmUrl: web + 'wasm/', iccUrl: web + 'iccs/',
  });
  let locked = false;
  task.onPassword = () => { locked = true; task.destroy(); };
  try {
    return await task.promise;
  } catch (e) {
    if (locked || e?.name === 'PasswordException') throw new Error('This PDF is password-protected. Password-protected PDFs are not supported here.');
    throw new Error('This file could not be read as a PDF. It may be damaged or incomplete.');
  }
}
// Renders a page into a canvas no wider than `maxW` CSS pixels (thumbnails).
export async function renderThumb(page, canvas, maxW, extraRotation = 0) {
  const base = page.getViewport({scale: 1, rotation: page.rotate + extraRotation});
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = Math.min(maxW / base.width, maxW * 1.4 / base.height) * dpr;
  const vp = page.getViewport({scale, rotation: page.rotate + extraRotation});
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  await page.render({canvasContext: canvas.getContext('2d'), viewport: vp, background: '#ffffff'}).promise;
}

// Thumbnail grid that renders lazily as items scroll into view.
export function thumbGrid(doc, list, makeItem) {
  list.textContent = '';
  const queue = [];
  let busy = false;
  const pump = async () => {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const {n, canvas} = queue.shift();
      try { await renderThumb(await doc.getPage(n), canvas, 150); } catch { /* leave blank */ }
      canvas.dataset.done = 'true';
    }
    busy = false;
  };
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      queue.push({n: Number(e.target.dataset.page), canvas: e.target.querySelector('canvas')});
    }
    pump();
  }, {rootMargin: '400px'});
  for (let n = 1; n <= doc.numPages; n++) {
    const li = makeItem(n);
    li.dataset.page = n;
    list.append(li);
    io.observe(li);
  }
  return () => io.disconnect();
}

// "1-3, 5, 8-" -> [[1,3],[5,5],[8,max]]. Throws a readable error.
export function parseRanges(text, max) {
  const parts = String(text).split(/[,;]+/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Enter at least one page or range, for example 1-3, 5.');
  return parts.map(p => {
    const m = /^(\d+)?\s*(?:[-–]\s*(\d+)?)?$/.exec(p);
    if (!m || (!m[1] && !m[2])) throw new Error(`"${p}" is not a page number or range.`);
    const dash = /[-–]/.test(p);
    const a = m[1] ? Number(m[1]) : 1;
    const b = m[2] ? Number(m[2]) : dash ? max : a;
    if (a < 1 || b < 1 || a > max || b > max) throw new Error(`"${p}" is outside this PDF, which has ${max} page${max === 1 ? '' : 's'}.`);
    if (a > b) throw new Error(`"${p}" runs backwards. Write it as ${b}-${a}.`);
    return [a, b];
  });
}
export const rangeLabel = ([a, b]) => a === b ? `${a}` : `${a}-${b}`;
// Compact label for a sorted list of page numbers: [1,2,3,5] -> "1-3, 5".
export function pagesLabel(nums) {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(rangeLabel([nums[i], nums[j]]));
    i = j;
  }
  return out.join(', ');
}

// ---- Results ----
const urls = [];
export function clearResult() {
  for (const u of urls.splice(0)) URL.revokeObjectURL(u);
  $('toolResult').textContent = '';
}
// Adds a download link to the result area and returns it.
export function downloadLink(blob, name, label, primary = true) {
  const url = URL.createObjectURL(blob);
  urls.push(url);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.className = primary ? 'btn tool-download' : 'tool-filelink';
  a.textContent = label || `Download ${name}`;
  if (primary) { const s = document.createElement('span'); s.className = 'tool-size'; s.textContent = ` (${fmtBytes(blob.size)})`; a.append(s); }
  return a;
}
export function resultNote(text, kind = '') {
  const p = document.createElement('p');
  p.className = 'tool-note' + (kind ? ' ' + kind : '');
  p.textContent = text;
  $('toolResult').append(p);
  return p;
}

// ---- Worker (pdf-lib) ----
let worker, seq = 0;
const pending = new Map();
export function work(op, payload, transfer = [], onProgress) {
  if (!worker) {
    worker = new Worker(new URL('./worker.mjs', import.meta.url), {type: 'module'});
    worker.onmessage = ({data}) => {
      const p = pending.get(data.id);
      if (!p) return;
      if (data.type === 'progress') return p.onProgress?.(data.done, data.total, data.label);
      pending.delete(data.id);
      data.type === 'error' ? p.reject(new Error(data.message)) : p.resolve(data.result);
    };
    worker.onerror = e => { for (const p of pending.values()) p.reject(new Error(e.message || 'The worker stopped.')); pending.clear(); worker = null; };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject, onProgress});
    worker.postMessage({id, op, payload}, transfer);
  });
}

// ---- ZIP (STORE only: PDFs and images are already compressed) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// entries: [{name, data: Uint8Array}] -> Blob (application/zip)
export function makeZip(entries, date = new Date()) {
  const enc = new TextEncoder();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts = [], central = [];
  let offset = 0;
  const used = new Set();
  for (const {name, data} of entries) {
    let unique = name, i = 2;
    while (used.has(unique)) unique = name.replace(/(\.[^.]+)?$/, ` (${i++})$1`);
    used.add(unique);
    const nameBytes = enc.encode(unique);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true); local.setUint16(10, time, true); local.setUint16(12, day, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
    parts.push(local, nameBytes, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, day, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, nameBytes.length, true); c.setUint32(42, offset, true);
    central.push(c, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  if (offset > 0xFFFFFFFF || entries.length > 0xFFFF) throw new Error('The result is too large for a ZIP file. Choose fewer pages.');
  const centralSize = central.reduce((s, p) => s + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], {type: 'application/zip'});
}

// Keyboard and screen-reader friendly busy state for the main action button.
export async function busy(button, fn) {
  button.disabled = true;
  document.body.classList.add('tool-busy');
  status('Working…', 'busy');
  try { return await fn(); }
  catch (e) { progress(null); status(e?.message || String(e), 'error'); }
  finally { button.disabled = false; document.body.classList.remove('tool-busy'); }
}

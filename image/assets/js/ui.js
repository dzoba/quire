// Shared batch UI for the image tools: file intake, a single background worker, the results
// list, progress and ZIP download. Files are read locally and passed to the worker; nothing is
// sent over the network.
import {makeZip} from './lib/zip.js';

export const MB = 1024 * 1024;
export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < MB) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' KB';
  return (n / MB).toFixed(n < 10 * MB ? 2 : 1) + ' MB';
}
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
};
export {el};

// One worker, one job at a time (keeps memory use predictable on phones).
class WorkerClient {
  constructor(url) { this.url = url; this.seq = 0; this.worker = null; this.pending = null; }
  start() {
    this.worker = new Worker(this.url, {type: 'module'});
    this.worker.onmessage = e => {
      const m = e.data, p = this.pending;
      if (!p || m.id !== p.id) return;
      if (m.stage) return p.onStage(m.stage);
      this.pending = null;
      m.ok ? p.resolve(m) : p.reject(new Error(m.error));
    };
    this.worker.onerror = e => {
      e.preventDefault?.();
      const p = this.pending;
      this.pending = null;
      this.worker.terminate();
      this.worker = null;
      if (p) p.reject(new Error('The converter stopped while working on this file, possibly because the device ran out of memory. Try a smaller file.'));
    };
  }
  run(message, transfer, onStage) {
    if (!this.worker) this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending = {id, resolve, reject, onStage};
      this.worker.postMessage({...message, id}, transfer);
    });
  }
}

export function createBatchTool(cfg) {
  const root = document.getElementById('tool');
  const input = root.querySelector('#files');
  const pick = root.querySelector('#pick');
  const drop = root.querySelector('.img-drop');
  const list = root.querySelector('#results');
  const status = root.querySelector('#status');
  const bar = root.querySelector('#progress');
  const zipBtn = root.querySelector('#zip');
  const rerun = root.querySelector('#rerun');
  const clear = root.querySelector('#clear');
  const settings = root.querySelector('#settings');
  const client = new WorkerClient(cfg.workerUrl);
  const rows = [];
  let running = false, lastKey = null;

  pick.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { add([...input.files]); input.value = ''; });

  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); drop.classList.add('over'); } });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) drop.classList.remove('over'); });
  document.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    drop.classList.remove('over');
    add([...e.dataTransfer.files]);
  });

  settings.addEventListener('input', () => { cfg.onSettings?.(); updateRerun(); });
  settings.addEventListener('change', () => { cfg.onSettings?.(); updateRerun(); });
  rerun.addEventListener('click', () => {
    for (const r of rows) if (r.state !== 'error' || r.retryable) resetRow(r);
    processQueue();
  });
  clear.addEventListener('click', () => {
    if (running) return;
    for (const r of rows) cleanup(r);
    rows.length = 0;
    list.replaceChildren();
    status.textContent = '';
    bar.hidden = true;
    lastKey = null;
    refresh();
    pick.focus();
  });
  zipBtn.addEventListener('click', async () => {
    const done = rows.filter(r => r.state === 'done');
    if (!done.length) return;
    zipBtn.disabled = true;
    const label = zipBtn.textContent;
    zipBtn.textContent = 'Building ZIP…';
    try {
      const blob = await makeZip(done.map(r => r.useOriginal ? {name: r.file.name, blob: r.file} : {name: r.result.name, blob: r.result.blob}));
      saveBlob(blob, cfg.zipName);
    } catch (e) {
      status.textContent = 'Could not build the ZIP: ' + e.message;
    } finally {
      zipBtn.textContent = label;
      zipBtn.disabled = false;
    }
  });

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', {href: url, download: name});
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function add(files) {
    const room = cfg.maxFiles - rows.length;
    const notes = [];
    if (files.length > room) { notes.push(`Only ${cfg.maxFiles} files can be in the list at once; ${files.length - Math.max(room, 0)} were not added.`); files = files.slice(0, Math.max(room, 0)); }
    for (const file of files) {
      const row = {file, state: 'queued', result: null, useOriginal: false, retryable: true};
      row.li = el('li', {class: 'img-row', 'data-state': 'queued'});
      rows.push(row);
      list.append(row.li);
      const problem = file.size > cfg.maxBytes ? `This file is ${formatBytes(file.size)}. The limit is ${formatBytes(cfg.maxBytes)} per file.` : cfg.check(file);
      if (problem) { row.state = 'error'; row.error = problem; row.retryable = false; }
      render(row);
    }
    if (notes.length) status.textContent = notes.join(' ');
    processQueue();
  }

  function resetRow(r) { cleanup(r); r.state = 'queued'; r.result = null; r.useOriginal = false; render(r); }
  function cleanup(r) {
    if (r.result?.url) URL.revokeObjectURL(r.result.url);
    if (r.origUrl) { URL.revokeObjectURL(r.origUrl); r.origUrl = null; }
  }

  async function processQueue() {
    if (running) return;
    running = true;
    refresh();
    lastKey = cfg.settingsKey();
    let next;
    while ((next = rows.find(r => r.state === 'queued'))) {
      const r = next;
      const opts = cfg.readSettings();
      r.state = 'working'; r.stage = 'reading'; render(r); progress();
      try {
        const bytes = await r.file.arrayBuffer();
        const m = await client.run(cfg.message(r.file, bytes, opts), [bytes], stage => { r.stage = stage; render(r); });
        const blob = new Blob([m.bytes], {type: m.type || cfg.outType(opts)});
        r.result = {...m, bytes: null, blob, name: cfg.outName(r.file, m, opts), url: URL.createObjectURL(blob), opts};
        r.state = 'done';
      } catch (e) {
        r.state = 'error';
        r.error = e.message;
      }
      render(r);
      progress();
    }
    running = false;
    progress();
    refresh();
  }

  function progress() {
    const total = rows.length;
    const finished = rows.filter(r => r.state === 'done' || r.state === 'error').length;
    const failed = rows.filter(r => r.state === 'error').length;
    bar.hidden = total === 0;
    bar.max = total || 1;
    bar.value = finished;
    if (running) {
      const cur = rows.findIndex(r => r.state === 'working');
      status.textContent = `${cfg.verb} ${cur + 1} of ${total}…`;
    } else if (total) {
      const ok = total - failed;
      status.textContent = `${ok} of ${total} ${ok === 1 ? 'file' : 'files'} ${cfg.pastVerb}` + (failed ? `, ${failed} could not be ${cfg.pastVerb}.` : '.');
    }
  }

  function refresh() {
    const done = rows.filter(r => r.state === 'done').length;
    zipBtn.disabled = running || done === 0;
    clear.disabled = running || rows.length === 0;
    updateRerun();
  }

  function updateRerun() {
    const changed = lastKey !== null && cfg.settingsKey() !== lastKey;
    rerun.hidden = running || !changed || !rows.some(r => r.retryable);
  }

  const STAGES = {reading: 'Reading file…', decoding: 'Decoding…', encoding: 'Encoding…', optimising: 'Optimizing PNG (this can take a few seconds)…', stripping: 'Removing metadata…'};
  function render(r) {
    const li = r.li;
    li.dataset.state = r.state;
    const name = el('p', {class: 'img-name', text: r.file.name});
    const kids = [];
    if (r.state === 'done') {
      const res = r.result;
      kids.push(el('img', {class: 'img-thumb', src: res.url, alt: '', width: 72, height: 72}));
      const body = el('div', {class: 'img-body'}, name, ...cfg.describe(r, res));
      kids.push(body);
      const name2 = r.useOriginal ? r.file.name : res.name;
      const href = r.useOriginal ? (r.origUrl ||= URL.createObjectURL(r.file)) : res.url;
      kids.push(el('div', {class: 'img-acts'}, el('a', {class: 'btn-sm', href, download: name2, 'aria-label': `Download ${name2}`, text: 'Download'})));
    } else if (r.state === 'error') {
      kids.push(el('span', {class: 'img-thumb img-thumb-x', 'aria-hidden': 'true', text: '!'}));
      kids.push(el('div', {class: 'img-body'}, name, el('p', {class: 'img-err', text: r.error})));
    } else {
      kids.push(el('span', {class: 'img-thumb img-thumb-wait', 'aria-hidden': 'true'}));
      kids.push(el('div', {class: 'img-body'}, name, el('p', {class: 'img-detail', text: r.state === 'queued' ? `${formatBytes(r.file.size)} · Waiting` : `${formatBytes(r.file.size)} · ${STAGES[r.stage] || 'Working…'}`})));
    }
    li.replaceChildren(...kids);
  }

  return {rows, render, refresh};
}

export function baseName(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

// Keeps a range input's <output> in sync.
export function bindRange(range, output, fmt = v => v) {
  const sync = () => { output.value = fmt(range.value); };
  range.addEventListener('input', sync);
  sync();
}

// JPG/PNG/WebP helpers shared by the compressor, the resizer, the converters and remove-exif.
export const TYPES = {'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp'};
export const EXT = {jpeg: '.jpg', png: '.png', webp: '.webp'};
export const LABEL = {jpeg: 'JPG', png: 'PNG', webp: 'WebP'};
export const typeOf = file => TYPES[file.type] || ({jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg', jfif: 'jpeg', png: 'png', webp: 'webp'})[file.name.split('.').pop().toLowerCase()];
export const isHeic = file => /\.(heic|heif|hif)$/i.test(file.name) || /^image\/hei[cf]/.test(file.type);

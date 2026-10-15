// Reads the parts of a HEIF/HEIC container that the pixel decoder does not hand back:
// the primary item, its Exif block and its ICC colour profile. ISO/IEC 14496-12 and 23008-12.
// Pure JS, no dependencies; used in the HEIC worker and in the Node tests.

const fourcc = (u8, at) => String.fromCharCode(u8[at], u8[at + 1], u8[at + 2], u8[at + 3]);

function readUint(view, at, size) {
  if (size === 0) return 0;
  if (size === 1) return view.getUint8(at);
  if (size === 2) return view.getUint16(at);
  if (size === 4) return view.getUint32(at);
  if (size === 8) return Number(view.getBigUint64(at));
  throw new Error('bad integer size ' + size);
}

// Yields {type, start (payload start), end} for each box between from and to.
function* boxes(u8, view, from, to) {
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    const type = fourcc(u8, at + 4);
    let header = 8;
    if (size === 1) { size = Number(view.getBigUint64(at + 8)); header = 16; }
    else if (size === 0) size = to - at;
    if (size < header || at + size > to) throw new Error('corrupt box ' + type);
    yield {type, start: at + header, end: at + size};
    at += size;
  }
}

export function parseHeif(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const top = [...boxes(u8, view, 0, u8.length)];
  const ftyp = top.find(b => b.type === 'ftyp');
  const meta = top.find(b => b.type === 'meta');
  if (!ftyp || !meta) throw new Error('not a HEIF file');
  const brands = [];
  for (let at = ftyp.start; at + 4 <= ftyp.end; at += 4) if (at !== ftyp.start + 4) brands.push(fourcc(u8, at));

  const out = {brands, primary: null, items: new Map(), locations: new Map(), refs: [], props: [], assoc: new Map(), idat: null};
  for (const b of boxes(u8, view, meta.start + 4, meta.end)) {
    if (b.type === 'pitm') {
      const v = u8[b.start];
      out.primary = v === 0 ? view.getUint16(b.start + 4) : view.getUint32(b.start + 4);
    } else if (b.type === 'iinf') {
      const v = u8[b.start];
      const first = b.start + 4 + (v === 0 ? 2 : 4);
      for (const e of boxes(u8, view, first, b.end)) {
        if (e.type !== 'infe') continue;
        const ev = u8[e.start];
        if (ev < 2) continue;
        let at = e.start + 4;
        const id = ev === 2 ? view.getUint16(at) : view.getUint32(at);
        at += ev === 2 ? 2 : 4;
        at += 2; // item_protection_index
        out.items.set(id, {id, type: fourcc(u8, at)});
      }
    } else if (b.type === 'iloc') {
      const v = u8[b.start];
      let at = b.start + 4;
      const offsetSize = u8[at] >> 4, lengthSize = u8[at] & 15;
      const baseSize = u8[at + 1] >> 4, indexSize = v > 0 ? u8[at + 1] & 15 : 0;
      at += 2;
      const count = v < 2 ? view.getUint16(at) : view.getUint32(at);
      at += v < 2 ? 2 : 4;
      for (let i = 0; i < count; i++) {
        const id = v < 2 ? view.getUint16(at) : view.getUint32(at);
        at += v < 2 ? 2 : 4;
        let method = 0;
        if (v > 0) { method = view.getUint16(at) & 15; at += 2; }
        at += 2; // data_reference_index
        const base = readUint(view, at, baseSize); at += baseSize;
        const extents = view.getUint16(at); at += 2;
        const list = [];
        for (let k = 0; k < extents; k++) {
          at += indexSize;
          const offset = readUint(view, at, offsetSize); at += offsetSize;
          const length = readUint(view, at, lengthSize); at += lengthSize;
          list.push({offset: base + offset, length});
        }
        out.locations.set(id, {method, extents: list});
      }
    } else if (b.type === 'iref') {
      const v = u8[b.start];
      const idSize = v === 0 ? 2 : 4;
      for (const r of boxes(u8, view, b.start + 4, b.end)) {
        let at = r.start;
        const from = readUint(view, at, idSize); at += idSize;
        const n = view.getUint16(at); at += 2;
        const to = [];
        for (let k = 0; k < n; k++) { to.push(readUint(view, at, idSize)); at += idSize; }
        out.refs.push({type: r.type, from, to});
      }
    } else if (b.type === 'iprp') {
      for (const p of boxes(u8, view, b.start, b.end)) {
        if (p.type === 'ipco') {
          for (const prop of boxes(u8, view, p.start, p.end)) out.props.push(prop);
        } else if (p.type === 'ipma') {
          const v = u8[p.start], flags = u8[p.start + 3];
          let at = p.start + 4;
          const n = view.getUint32(at); at += 4;
          for (let i = 0; i < n; i++) {
            const id = v < 1 ? view.getUint16(at) : view.getUint32(at);
            at += v < 1 ? 2 : 4;
            const k = u8[at++];
            const list = [];
            for (let j = 0; j < k; j++) {
              if (flags & 1) { list.push(view.getUint16(at) & 0x7fff); at += 2; }
              else { list.push(u8[at] & 0x7f); at += 1; }
            }
            out.assoc.set(id, list);
          }
        }
      }
    } else if (b.type === 'idat') {
      out.idat = {start: b.start, end: b.end};
    }
  }

  const itemData = id => {
    const loc = out.locations.get(id);
    if (!loc) return null;
    const base = loc.method === 1 ? (out.idat ? out.idat.start : NaN) : 0;
    if (loc.method > 1 || Number.isNaN(base)) return null;
    const parts = loc.extents.map(e => {
      const s = base + e.offset;
      const len = e.length || (loc.method === 1 ? out.idat.end - s : u8.length - s);
      if (s < 0 || s + len > u8.length) throw new Error('item outside file');
      return u8.subarray(s, s + len);
    });
    if (parts.length === 1) return parts[0];
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    return all;
  };

  // Image items that are not tiles, thumbnails or auxiliary images of another item.
  const imageTypes = new Set(['hvc1', 'grid', 'iden', 'iovl', 'av01', 'jpeg', 'unci']);
  const hidden = new Set();
  for (const r of out.refs) {
    if (r.type === 'dimg') r.to.forEach(id => hidden.add(id));
    if (r.type === 'thmb' || r.type === 'auxl') hidden.add(r.from);
  }
  const topLevel = [...out.items.values()].filter(i => imageTypes.has(i.type) && !hidden.has(i.id)).map(i => i.id);

  // Exif: the item that describes (cdsc) the primary image, else any Exif item.
  const exifItems = [...out.items.values()].filter(i => i.type === 'Exif');
  let exifItem = exifItems.find(i => out.refs.some(r => r.type === 'cdsc' && r.from === i.id && r.to.includes(out.primary)));
  if (!exifItem && exifItems.length === 1) exifItem = exifItems[0];
  let exif = null;
  if (exifItem) {
    const data = itemData(exifItem.id);
    if (data && data.length > 4) {
      const skip = new DataView(data.buffer, data.byteOffset, 4).getUint32(0);
      const tiff = data.subarray(4 + skip);
      if (tiff.length > 8 && (fourcc(tiff, 0).startsWith('II') || fourcc(tiff, 0).startsWith('MM'))) exif = tiff.slice();
    }
  }

  // Colour: a 'colr' property on the primary item (or on its first tile, for grids).
  const colrFor = id => {
    for (const idx of out.assoc.get(id) || []) {
      const p = out.props[idx - 1];
      if (p && p.type === 'colr') return p;
    }
    return null;
  };
  let colr = colrFor(out.primary);
  if (!colr) {
    const dimg = out.refs.find(r => r.type === 'dimg' && r.from === out.primary);
    if (dimg) colr = colrFor(dimg.to[0]);
  }
  let icc = null, nclx = null;
  if (colr) {
    const kind = fourcc(u8, colr.start);
    if (kind === 'prof' || kind === 'rICC') icc = u8.slice(colr.start + 4, colr.end);
    else if (kind === 'nclx') nclx = {primaries: view.getUint16(colr.start + 4), transfer: view.getUint16(colr.start + 6), matrix: view.getUint16(colr.start + 8)};
  }

  return {brands, primary: out.primary, imageCount: topLevel.length, exif, icc, nclx};
}

// Minimal ZIP writer (stored entries, no compression: JPEG, PNG and WebP are already compressed).
// Builds the archive as a Blob from the entries' Blobs, so file data is not copied into one buffer.
import {crc32} from './exif.js';

const enc = new TextEncoder();

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Makes names unique inside the archive: "photo.jpg", "photo (2).jpg", ...
export function uniqueNames(names) {
  const seen = new Map();
  return names.map(name => {
    const key = name.toLowerCase();
    if (!seen.has(key)) { seen.set(key, 1); return name; }
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    let n = seen.get(key);
    let candidate;
    do { n++; candidate = `${stem} (${n})${ext}`; } while (seen.has(candidate.toLowerCase()));
    seen.set(key, n);
    seen.set(candidate.toLowerCase(), 1);
    return candidate;
  });
}

// entries: [{name, blob}] -> Blob (application/zip)
export async function makeZip(entries, now = new Date()) {
  const {time, date} = dosTime(now);
  const names = uniqueNames(entries.map(e => e.name));
  const parts = [], central = [];
  let offset = 0;
  for (let i = 0; i < entries.length; i++) {
    const data = new Uint8Array(await entries[i].blob.arrayBuffer());
    const name = enc.encode(names[i]);
    const crc = crc32(data);
    if (data.length >= 0xffffffff || offset >= 0xffffffff) throw new Error('ZIP is over 4 GB');
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);          // UTF-8 names
    local.setUint16(8, 0, true);               // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(local.buffer, name, entries[i].blob);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((n, p) => n + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], {type: 'application/zip'});
}

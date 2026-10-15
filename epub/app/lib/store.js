// Storage helpers.
//  - Book files + metadata live in IndexedDB ("quire" db, "books" store) so the
//    library can reopen them without the original file.
//  - Small per-book state (reading position, bookmarks) and settings live in
//    localStorage, keyed by the book id (SHA-256 of the file bytes).
//    (Web version: the extension used chrome.storage.local for these.)

const DB_NAME = 'quire'
const DB_VERSION = 1

let dbPromise
const openDB = () => dbPromise ??= new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, DB_VERSION)
  req.onupgradeneeded = () => {
    const db = req.result
    if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' })
  }
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})

const tx = async (mode, fn) => {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction('books', mode)
    const store = t.objectStore('books')
    let result
    Promise.resolve(fn(store)).then(r => { result = r })
    t.oncomplete = () => resolve(result)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error ?? new Error('Transaction aborted'))
  })
}

const req2p = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})

export const getBook = id => tx('readonly', s => req2p(s.get(id)))
export const putBook = record => tx('readwrite', s => req2p(s.put(record)))
export const deleteBook = id => tx('readwrite', s => req2p(s.delete(id)))
export const listBooks = () => tx('readonly', s => req2p(s.getAll()))

export const touchBook = async id => {
  const rec = await getBook(id)
  if (rec) {
    rec.lastOpenedAt = Date.now()
    await putBook(rec)
  }
}

// ---- book identity -------------------------------------------------------

export const hashFile = async blob => {
  const buf = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest).slice(0, 16), b => b.toString(16).padStart(2, '0')).join('')
}

// ---- localStorage wrappers (async, same shape as chrome.storage.local) ----

const PREFIX = 'quire.epub.'
const local = {
  async get(key) {
    const out = {}
    const read = k => {
      try {
        const raw = localStorage.getItem(PREFIX + k)
        if (raw != null) out[k] = JSON.parse(raw)
      } catch {}
    }
    if (key === null) {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k?.startsWith(PREFIX)) read(k.slice(PREFIX.length))
      }
    } else read(key)
    return out
  },
  async set(items) {
    for (const [k, v] of Object.entries(items)) {
      try { localStorage.setItem(PREFIX + k, JSON.stringify(v)) } catch (e) { console.warn('Could not save', k, e) }
    }
  },
  async remove(key) {
    try { localStorage.removeItem(PREFIX + key) } catch {}
  },
}

// Fires when another tab of this site changes the settings.
export const onSettingsChanged = fn => addEventListener('storage', e => {
  if (e.key !== PREFIX + 'settings' || !e.newValue) return
  try { fn(JSON.parse(e.newValue)) } catch {}
})

// Removes a book's position and bookmarks (used when the user removes a book
// and asks to forget its reading data too).
export const forgetBookState = async id => {
  await local.remove(`pos:${id}`)
  await local.remove(`bm:${id}`)
}

export const DEFAULT_SETTINGS = {
  theme: 'light',          // light | sepia | dark
  fontFamily: 'publisher', // publisher | serif | sans | mono | dyslexic
  fontSize: 18,            // px
  lineHeight: 1.6,
  flow: 'paginated',       // paginated | scrolled
  pageWidth: 'medium',     // narrow | medium | wide
  justify: true,
  twoColumns: true,
  ttsRate: 1,
  ttsVoice: '',
}

export const getSettings = async () => {
  const { settings } = await local.get('settings')
  return { ...DEFAULT_SETTINGS, ...settings }
}
export const saveSettings = async patch => {
  const settings = { ...(await getSettings()), ...patch }
  await local.set({ settings })
  return settings
}

export const getPosition = async id => (await local.get(`pos:${id}`))[`pos:${id}`] ?? null
export const savePosition = (id, pos) => local.set({ [`pos:${id}`]: { ...pos, updatedAt: Date.now() } })

export const getBookmarks = async id => (await local.get(`bm:${id}`))[`bm:${id}`] ?? []
export const saveBookmarks = (id, list) => local.set({ [`bm:${id}`]: list })

export const getAllPositions = async () => {
  const all = await local.get(null)
  const out = {}
  for (const [k, v] of Object.entries(all)) if (k.startsWith('pos:')) out[k.slice(4)] = v
  return out
}

// ---- formatting ----------------------------------------------------------

export const formatSize = n => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export const formatLang = x => {
  if (!x) return ''
  if (typeof x === 'string') return x
  return x[Object.keys(x)[0]] ?? ''
}

export const formatAuthor = a => {
  const one = c => typeof c === 'string' ? c : formatLang(c?.name)
  return Array.isArray(a) ? a.map(one).filter(Boolean).join(', ') : one(a) ?? ''
}

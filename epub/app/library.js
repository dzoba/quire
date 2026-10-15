import { importFile } from './lib/books.js'
import * as store from './lib/store.js'
import { hydrateIcons, icons } from './lib/icons.js'

const $ = s => document.querySelector(s)
const pct = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 0 })
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

let settings
let toastTimer
const toast = msg => {
  const el = $('#toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200)
}

const ago = t => {
  const s = (t - Date.now()) / 1000
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]
  for (const [u, n] of units) if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), u)
  return 'just now'
}

// deterministic pleasant colour for books without a cover
const hue = str => [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360

const render = async () => {
  const [books, positions] = await Promise.all([store.listBooks(), store.getAllPositions()])
  books.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
  const grid = $('#grid')
  grid.textContent = ''
  const dz = $('#dropzone')
  dz.classList.toggle('big', !books.length)
  dz.classList.toggle('compact', books.length > 0)
  $('#recent-head').hidden = !books.length
  const total = books.reduce((n, b) => n + (b.size ?? 0), 0)
  $('#lib-stats').textContent = `${books.length} book${books.length === 1 ? '' : 's'} · ${store.formatSize(total)} stored in this browser`

  for (const b of books) {
    const pos = positions[b.id]
    const a = document.createElement('a')
    a.className = 'book'
    a.href = `reader.html?book=${b.id}`
    a.dataset.id = b.id
    a.title = b.title
    const cover = document.createElement('div')
    cover.className = 'cover'
    if (b.cover) {
      const img = document.createElement('img')
      img.src = URL.createObjectURL(b.cover)
      img.alt = ''
      img.loading = 'lazy'
      cover.append(img)
    } else {
      const h = hue(b.title + b.author)
      cover.style.background = `linear-gradient(160deg, hsl(${h} 38% 38%), hsl(${(h + 30) % 360} 42% 24%))`
      const gen = document.createElement('div')
      gen.className = 'gen'
      gen.innerHTML = '<div class="gt"></div><div class="ga"></div>'
      gen.querySelector('.gt').textContent = b.title
      gen.querySelector('.ga').textContent = b.author
      cover.append(gen)
    }
    if (pos?.fraction) {
      const bar = document.createElement('div')
      bar.className = 'bar'
      bar.innerHTML = `<div style="width:${Math.round(pos.fraction * 100)}%"></div>`
      cover.append(bar)
    }
    const rm = document.createElement('button')
    rm.className = 'remove'
    rm.title = 'Remove from library'
    rm.setAttribute('aria-label', `Remove ${b.title} from this browser`)
    rm.innerHTML = icons.trash
    rm.addEventListener('click', e => {
      e.preventDefault()
      e.stopPropagation()
      confirmRemove(cover, b)
    })
    cover.append(rm)
    const meta = document.createElement('div')
    meta.className = 'meta'
    meta.innerHTML = '<div class="t"></div><div class="a"></div><div class="s"></div>'
    meta.querySelector('.t').textContent = b.title
    meta.querySelector('.a').textContent = b.author || 'Unknown author'
    const progress = pos?.fraction ? `${pct.format(pos.fraction)} read` : 'Not started'
    meta.querySelector('.s').textContent = `${progress} · ${store.formatSize(b.size)} · ${ago(b.lastOpenedAt ?? b.addedAt)}`
    a.append(cover, meta)
    grid.append(a)
  }
}

const confirmRemove = (cover, b) => {
  if (cover.querySelector('.confirm')) return
  const c = document.createElement('div')
  c.className = 'confirm'
  c.innerHTML = '<div>Remove this book from this browser?<br><small>Its bookmarks and reading position are deleted too.</small></div><div class="row"><button class="yes">Remove</button><button class="no">Cancel</button></div>'
  c.addEventListener('click', e => { e.preventDefault(); e.stopPropagation() })
  c.querySelector('.no').addEventListener('click', () => c.remove())
  setTimeout(() => c.querySelector('.no').focus())
  c.querySelector('.yes').addEventListener('click', async () => {
    await store.deleteBook(b.id)
    await store.forgetBookState(b.id)
    toast(`Removed “${b.title}”`)
    render()
  })
  cover.append(c)
}

const addFiles = async files => {
  files = [...files].filter(Boolean)
  if (!files.length) return
  document.querySelector('.import-error')?.remove()
  let lastId = null
  const errors = []
  for (const f of files) {
    try {
      toast(`Adding ${f.name}…`)
      const { id } = await importFile(f, { fileName: f.name })
      lastId = id
    } catch (e) {
      console.error(e)
      errors.push(`${f.name}: ${e.title ?? 'could not be opened'}. ${e.detail ?? ''}`)
    }
  }
  if (errors.length) {
    const div = document.createElement('div')
    div.className = 'import-error'
    div.textContent = errors.join('\n')
    $('#dropzone').after(div)
  }
  if (files.length === 1 && lastId) location.href = `reader.html?book=${lastId}`
  else render()
}

const main = async () => {
  // Never render inside another site's frame; the quireapps.com page embeds this from the same origin.
  if (window.top !== window) {
    try { if (window.parent.location.origin !== location.origin) throw 0 } catch { document.body.textContent = ''; return }
  }
  settings = await store.getSettings()
  document.documentElement.dataset.theme = settings.theme
  hydrateIcons()
  const input = $('#file-input')
  $('#btn-open').addEventListener('click', () => input.click())
  $('#btn-open-2').addEventListener('click', () => input.click())
  input.addEventListener('change', () => addFiles(input.files))
  $('#btn-theme').addEventListener('click', async () => {
    const order = ['light', 'sepia', 'dark']
    settings = await store.saveSettings({ theme: order[(order.indexOf(settings.theme) + 1) % 3] })
    document.documentElement.dataset.theme = settings.theme
  })
  // The landing page forwards files dropped outside the frame (same origin only).
  addEventListener('message', e => {
    if (e.origin !== location.origin || e.source !== window.parent) return
    if (e.data?.type === 'quire-open' && e.data.file instanceof Blob) addFiles([e.data.file])
  })

  let depth = 0
  addEventListener('dragenter', e => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return
    depth++
    document.body.classList.add('dragging')
  })
  addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging') } })
  addEventListener('dragover', e => e.preventDefault())
  addEventListener('drop', e => {
    e.preventDefault()
    depth = 0
    document.body.classList.remove('dragging')
    addFiles(e.dataTransfer?.files ?? [])
  })

  // refresh when returning to the tab (progress changed while reading)
  addEventListener('visibilitychange', () => { if (!document.hidden) render() })
  store.onSettingsChanged(s => { settings = { ...settings, ...s }; document.documentElement.dataset.theme = settings.theme })
  await render()
  document.body.dataset.ready = '1'
}

main()

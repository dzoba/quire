import './vendor/foliate-js/view.js'
import { Overlayer } from './vendor/foliate-js/overlayer.js'
import { importFile, parseBook, BookError, titleOf } from './lib/books.js'
import * as store from './lib/store.js'
import { hydrateIcons, icons } from './lib/icons.js'

const $ = s => document.querySelector(s)
const $$ = s => [...document.querySelectorAll(s)]
const pct = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 0 })

const state = {
  id: null,
  book: null,
  view: null,
  record: null,
  settings: null,
  bookmarks: [],
  loc: null,
  searchGen: 0,
  searchResults: [], // flat [{cfi, el}]
  searchIndex: -1,
  lastQuery: '',
}
globalThis.quire = state // exposed for automated tests and debugging

// ---------------------------------------------------------------- helpers

const debounce = (fn, ms) => {
  let t
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
  d.flush = (...a) => { clearTimeout(t); fn(...a) }
  return d
}

let toastTimer
const toast = msg => {
  const el = $('#toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800)
}

const setState = s => {
  document.body.dataset.state = s
  $('#state-error').hidden = s !== 'error'
}

const showError = (err, { retry } = {}) => {
  console.error(err)
  const isBook = err instanceof BookError
  $('#error-title').textContent = isBook ? err.title : 'Something went wrong'
  $('#error-detail').textContent = isBook ? err.detail : 'Quire could not open this book.'
  const cause = err?.cause ?? err
  $('#error-tech').textContent = `${cause?.name ?? 'Error'}: ${cause?.message ?? String(cause)}`
  $('#error-retry').hidden = !retry
  $('#error-retry').onclick = retry ?? null
  document.title = `${isBook ? err.title : 'Error'} · Quire`
  setState('error')
}

const escapeHTML = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// ---------------------------------------------------------------- theming

const THEMES = {
  light: { bg: '#fbfaf7', fg: '#1f2328', link: '#2e6f9e', scheme: 'light' },
  sepia: { bg: '#f4ecd8', fg: '#4a3b2c', link: '#9a5b2c', scheme: 'light' },
  dark: { bg: '#17191c', fg: '#dcd8cf', link: '#8fbde3', scheme: 'dark' },
}
const FONTS = {
  publisher: null,
  serif: 'Charter, "Bitstream Charter", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  readable: 'Verdana, Tahoma, "DejaVu Sans", sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
}
const WIDTHS = { narrow: 560, medium: 720, wide: 960 }

// Returns [before, after]: "before" is inserted ahead of the book's own CSS,
// "after" behind it (so it overrides).
const bookCSS = s => {
  const t = THEMES[s.theme] ?? THEMES.light
  const font = FONTS[s.fontFamily]
  const recolor = s.theme !== 'light'
  // Chrome gives extension-origin documents body { font: 75% system-ui }.
  // Reset that before the book's CSS so the publisher's fonts still win.
  const before = `body { font-size: 1rem; font-family: ${FONTS.serif}; }`
  return [before, `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
      color-scheme: ${t.scheme};
      font-size: ${s.fontSize}px !important;
      background: ${t.bg} !important;
      color: ${t.fg} !important;
    }
    body { background: transparent !important; color: inherit !important; }
    ${recolor ? `
    body *:not(a):not(img):not(svg):not(svg *) { color: inherit !important; background-color: transparent !important; border-color: currentColor; }
    ` : ''}
    a:link, a:visited { color: ${t.link} !important; }
    ${s.theme === 'dark' ? 'img { filter: brightness(.9); }' : ''}

    ${font ? `body, p, li, blockquote, dd, dt, div, span, h1, h2, h3, h4, h5, h6, td, th, figcaption { font-family: ${font} !important; }` : ''}
    body { line-height: ${s.lineHeight}; }
    p, li, blockquote, dd {
      line-height: ${s.lineHeight} !important;
      text-align: ${s.justify ? 'justify' : 'start'};
      -webkit-hyphens: auto; hyphens: auto;
      widows: 2; orphans: 2;
    }
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    pre { white-space: pre-wrap !important; }
    img, svg, video { max-width: 100%; height: auto; }
    aside[epub|type~="footnote"], aside[epub|type~="endnote"], aside[epub|type~="rearnote"] { display: none; }
    .quire-tts-active {
      background: ${s.theme === 'dark' ? 'rgba(255,200,60,.18)' : 'rgba(255,196,0,.28)'} !important;
      border-radius: 4px; box-shadow: 0 0 0 4px ${s.theme === 'dark' ? 'rgba(255,200,60,.18)' : 'rgba(255,196,0,.28)'};
    }
    ::selection { background: ${s.theme === 'dark' ? 'rgba(127,178,220,.35)' : 'rgba(46,111,158,.22)'}; }
  `]
}

const applyUITheme = () => {
  document.documentElement.dataset.theme = state.settings.theme
  document.body.dataset.flow = state.settings.flow
}

const applySettings = () => {
  const s = state.settings
  applyUITheme()
  const r = state.view?.renderer
  if (r) {
    r.setAttribute('flow', s.flow)
    r.setAttribute('max-inline-size', `${WIDTHS[s.pageWidth] ?? 720}px`)
    r.setAttribute('max-column-count', s.twoColumns ? '2' : '1')
    r.setAttribute('margin', '36px')
    r.setAttribute('gap', '6%')
    r.setStyles?.(bookCSS(s))
  }
  syncSettingsUI()
}

const updateSettings = async patch => {
  Object.assign(state.settings, patch)
  applySettings()
  await store.saveSettings(patch)
}

// ---------------------------------------------------------------- opening

// Web version: no URL opening. Books come only from the file picker or a drop.

const openFromLibrary = async id => {
  setState('loading')
  try {
    const record = await store.getBook(id)
    if (!record) throw new BookError('This book is not in your library',
      'It may have been removed. Open the file again to add it back. Your bookmarks and position are kept.')
    const file = new File([record.file], record.fileName || 'book.epub', { type: 'application/epub+zip' })
    const book = await parseBook(file)
    store.touchBook(id)
    await openBook(id, book, record)
  } catch (e) {
    showError(e)
  }
}

const openLocalFile = async file => {
  if (!file) return
  setState('loading')
  $('#loading-title').textContent = 'Opening book…'
  $('#loading-detail').textContent = file.name
  try {
    const { id } = await importFile(file, { fileName: file.name })
    location.replace(`reader.html?book=${id}`)
  } catch (e) {
    showError(e)
  }
}

// ---------------------------------------------------------------- the book

const savePos = debounce(() => {
  const l = state.loc
  if (!state.id || !l?.cfi) return
  store.savePosition(state.id, {
    cfi: l.cfi, fraction: l.fraction ?? 0, label: l.tocItem?.label ?? '',
  })
}, 300)

const openBook = async (id, book, record) => {
  state.id = id
  state.book = book
  state.record = record
  const view = document.createElement('foliate-view')
  state.view = view
  $('#viewer').append(view)
  book.transformTarget?.addEventListener('data', ({ detail }) => {
    detail.data = Promise.resolve(detail.data).catch(e => {
      console.warn(`Failed to load ${detail.name}`, e)
      return ''
    })
  })
  await view.open(book)
  view.addEventListener('relocate', onRelocate)
  view.addEventListener('load', onSectionLoad)
  view.addEventListener('wheel', onWheel, { passive: true })
  applySettings()

  const title = titleOf(book)
  document.title = title
  $('#book-title').textContent = title
  buildTOC()
  state.bookmarks = await store.getBookmarks(id)
  renderBookmarks()

  const pos = await store.getPosition(id)
  setState('reading')
  await view.init({ lastLocation: pos?.cfi ?? null })
}

const onRelocate = ({ detail }) => {
  state.loc = detail
  const { fraction = 0, tocItem, time } = detail
  $('#chapter-title').textContent = tocItem?.label ?? ''
  $('#loc-left').textContent = tocItem?.label ?? ''
  const left = time?.section != null ? Math.max(1, Math.round(time.section)) : null
  $('#loc-right').textContent = `${pct.format(fraction)}${left != null ? ` · ${left} min left in chapter` : ''}`
  if (!progressDragging) $('#progress').value = fraction
  markTOC(tocItem?.href)
  updateBookmarkButton()
  savePos()
}

const onSectionLoad = ({ detail: { doc } }) => {
  doc.addEventListener('keydown', onKey)
  doc.addEventListener('wheel', onWheel, { passive: true })
  readAloud.onSectionLoad(doc)
}

// flush the position when the tab is hidden or closed
addEventListener('visibilitychange', () => { if (document.hidden) savePos.flush() })
addEventListener('pagehide', () => savePos.flush())

// ---------------------------------------------------------------- wheel

// In scroll mode a section ends at the bottom of the scroll area; keep
// scrolling past the end to flow into the next chapter (and up into the
// previous one). In page mode the wheel turns pages.
let wheelAcc = 0, wheelLock = 0
const onWheel = e => {
  const view = state.view
  if (!view?.renderer || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return
  const r = view.renderer
  const now = performance.now()
  if (now < wheelLock) return
  if (r.scrolled) {
    const atEnd = r.viewSize - r.end <= 2
    const atStart = r.start <= 1
    if ((e.deltaY > 0 && atEnd) || (e.deltaY < 0 && atStart)) {
      wheelAcc += e.deltaY
      if (Math.abs(wheelAcc) > 220) {
        const dir = wheelAcc
        wheelAcc = 0
        wheelLock = now + 600
        dir > 0 ? view.next() : view.prev()
      }
    } else wheelAcc = 0
  } else {
    wheelAcc += e.deltaY
    if (Math.abs(wheelAcc) > 60) {
      const dir = wheelAcc
      wheelAcc = 0
      wheelLock = now + 350
      dir > 0 ? view.next() : view.prev()
    }
  }
}

// ---------------------------------------------------------------- TOC

const tocLinks = new Map()
const buildTOC = () => {
  const root = $('#toc-view')
  root.textContent = ''
  const head = document.createElement('div')
  head.className = 'book-head'
  const t = document.createElement('div')
  t.innerHTML = `<div class="t"></div><div class="a"></div>`
  t.querySelector('.t').textContent = titleOf(state.book)
  t.querySelector('.a').textContent = store.formatAuthor(state.book.metadata?.author)
  if (state.record?.cover) {
    const img = document.createElement('img')
    img.src = URL.createObjectURL(state.record.cover)
    img.alt = ''
    head.append(img)
  }
  head.append(t)
  root.append(head)
  const toc = state.book.toc ?? []
  const build = items => {
    const ol = document.createElement('ol')
    for (const item of items) {
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.href = '#'
      a.textContent = (item.label ?? '').trim() || 'Untitled'
      a.addEventListener('click', e => {
        e.preventDefault()
        state.view.goTo(item.href)
        if (innerWidth < 1100) closePanels()
      })
      if (item.href) tocLinks.set(item.href, a)
      li.append(a)
      if (item.subitems?.length) li.append(build(item.subitems))
      ol.append(li)
    }
    return ol
  }
  if (toc.length) root.append(build(toc))
  else {
    const p = document.createElement('p')
    p.className = 'empty-note'
    p.textContent = 'This book has no table of contents.'
    root.append(p)
  }
}
let currentTOC
const markTOC = href => {
  const a = tocLinks.get(href)
  if (a === currentTOC) return
  currentTOC?.removeAttribute('aria-current')
  currentTOC = a
  if (a) {
    a.setAttribute('aria-current', 'true')
    if (!$('#sidebar').hidden) a.scrollIntoView({ block: 'nearest' })
  }
}

// ---------------------------------------------------------------- bookmarks

const currentContents = () => state.view?.renderer?.getContents?.()[0]

const bookmarksOnPage = () => {
  const loc = state.view?.lastLocation
  const contents = currentContents()
  if (!loc?.range || !contents?.doc) return []
  return state.bookmarks.filter(b => {
    try {
      const { index, anchor } = state.view.resolveCFI(b.cfi)
      if (index !== contents.index) return false
      const r = anchor(contents.doc)
      const node = r.startContainer ?? r
      const offset = r.startOffset ?? 0
      return loc.range.comparePoint(node, offset) === 0
    } catch { return false }
  })
}

const updateBookmarkButton = () => {
  const on = bookmarksOnPage().length > 0
  const btn = $('#btn-bookmark')
  btn.setAttribute('aria-pressed', String(on))
  btn.innerHTML = on ? icons.bookmarkFilled : icons.bookmark
  btn.title = on ? 'Remove bookmark (B)' : 'Bookmark this page (B)'
  btn.setAttribute('aria-label', btn.title)
}

const toggleBookmark = async () => {
  const loc = state.view?.lastLocation
  if (!loc?.cfi) return
  const here = bookmarksOnPage()
  if (here.length) {
    state.bookmarks = state.bookmarks.filter(b => !here.includes(b))
    toast('Bookmark removed')
  } else {
    const text = (loc.range?.toString() ?? '').replace(/\s+/g, ' ').trim()
    state.bookmarks.push({
      cfi: loc.cfi,
      label: loc.tocItem?.label?.trim() ?? '',
      excerpt: text.slice(0, 160),
      fraction: loc.fraction ?? 0,
      createdAt: Date.now(),
    })
    state.bookmarks.sort((a, b) => a.fraction - b.fraction)
    toast('Page bookmarked')
  }
  await store.saveBookmarks(state.id, state.bookmarks)
  renderBookmarks()
  updateBookmarkButton()
}

const renderBookmarks = () => {
  const root = $('#bookmarks-view')
  root.textContent = ''
  $('#bm-count').textContent = state.bookmarks.length ? `(${state.bookmarks.length})` : ''
  if (!state.bookmarks.length) {
    root.innerHTML = '<p class="empty-note">No bookmarks yet.<br>Press <kbd>B</kbd> or the bookmark button to mark a page.</p>'
    return
  }
  for (const b of state.bookmarks) {
    const item = document.createElement('div')
    item.className = 'bm-item'
    item.tabIndex = 0
    item.innerHTML = `<div class="bm-label"></div><div class="bm-excerpt"></div><div class="bm-meta"></div>`
    item.querySelector('.bm-label').textContent = b.label || 'Bookmark'
    item.querySelector('.bm-excerpt').textContent = b.excerpt ? `“${b.excerpt}…”` : ''
    item.querySelector('.bm-meta').textContent =
      `${pct.format(b.fraction)} · ${new Date(b.createdAt).toLocaleDateString()}`
    const del = document.createElement('button')
    del.className = 'icon-btn'
    del.title = 'Delete bookmark'
    del.setAttribute('aria-label', 'Delete bookmark')
    del.innerHTML = icons.trash
    del.addEventListener('click', async e => {
      e.stopPropagation()
      state.bookmarks = state.bookmarks.filter(x => x !== b)
      await store.saveBookmarks(state.id, state.bookmarks)
      renderBookmarks()
      updateBookmarkButton()
    })
    item.append(del)
    const go = () => { state.view.goTo(b.cfi); if (innerWidth < 1100) closePanels() }
    item.addEventListener('click', go)
    item.addEventListener('keydown', e => { if (e.key === 'Enter') go() })
    root.append(item)
  }
}

// ---------------------------------------------------------------- search

const runSearch = async query => {
  const gen = ++state.searchGen
  const view = state.view
  const results = $('#search-results')
  const summary = $('#search-summary')
  const bar = $('#search-progress')
  results.textContent = ''
  state.searchResults = []
  state.searchIndex = -1
  state.lastQuery = query
  view.clearSearch()
  if (query.trim().length < 1) {
    summary.textContent = 'Search every chapter. Press Enter to start.'
    bar.classList.remove('on')
    return
  }
  bar.classList.add('on')
  bar.firstElementChild.style.width = '0%'
  summary.textContent = 'Searching…'
  const t0 = performance.now()
  let chapters = 0
  const opts = {
    query,
    matchCase: $('#opt-case').checked,
    matchWholeWords: $('#opt-words').checked,
    matchDiacritics: false,
    draw: Overlayer.highlight,
    drawOptions: { color: state.settings.theme === 'dark' ? 'rgba(255,200,60,.45)' : 'rgba(255,196,0,.5)' },
  }
  try {
    for await (const r of view.search(opts)) {
      if (gen !== state.searchGen) return
      if (r === 'done') break
      if (r.progress != null) {
        bar.firstElementChild.style.width = `${r.progress * 100}%`
        continue
      }
      if (!r.subitems) continue
      chapters++
      const group = document.createElement('div')
      group.className = 'sr-group'
      const h = document.createElement('h3')
      h.innerHTML = `<span></span><span>${r.subitems.length}</span>`
      h.firstElementChild.textContent = r.label || 'Untitled section'
      group.append(h)
      for (const { cfi, excerpt } of r.subitems) {
        const btn = document.createElement('button')
        btn.className = 'sr-item'
        btn.dataset.cfi = cfi
        btn.innerHTML = `${escapeHTML(excerpt.pre)}<mark>${escapeHTML(excerpt.match)}</mark>${escapeHTML(excerpt.post)}`
        const i = state.searchResults.length
        btn.addEventListener('click', () => goToResult(i))
        state.searchResults.push({ cfi, el: btn })
        group.append(btn)
      }
      results.append(group)
      summary.textContent = `${state.searchResults.length} found so far…`
    }
  } catch (e) {
    console.error(e)
    summary.textContent = 'Search failed: ' + (e?.message ?? e)
    bar.classList.remove('on')
    return
  }
  if (gen !== state.searchGen) return
  bar.classList.remove('on')
  const n = state.searchResults.length
  const secs = ((performance.now() - t0) / 1000).toFixed(1)
  summary.textContent = n
    ? `${n} result${n === 1 ? '' : 's'} in ${chapters} chapter${chapters === 1 ? '' : 's'} · ${secs}s`
    : `No results for “${query}”.`
  if (!n) results.innerHTML = '<p class="empty-note">Nothing matched. Try fewer words, or turn off Match case / Whole words.</p>'
}

const goToResult = i => {
  const list = state.searchResults
  if (!list.length) return
  i = (i + list.length) % list.length
  list[state.searchIndex]?.el.classList.remove('active')
  state.searchIndex = i
  const { cfi, el } = list[i]
  el.classList.add('active')
  el.scrollIntoView({ block: 'nearest' })
  state.view.goTo(cfi)
  $('#search-summary').textContent = `Result ${i + 1} of ${list.length}`
}

// ---------------------------------------------------------------- read aloud

const readAloud = {
  active: false,
  paused: false,
  blocks: [],
  i: 0,
  doc: null,
  advancing: false,
  current: null,
  BLOCKS: 'p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, dt, dd, pre, td, th',

  supported: () => 'speechSynthesis' in globalThis,

  // Never delegate to the browser's default: it may be a network voice.
  localVoices: () => speechSynthesis.getVoices().filter(v => v.localService === true),

  chooseVoice(lang) {
    const voices = this.localVoices()
    const normalized = (lang || 'en').toLowerCase()
    const base = normalized.split('-')[0]
    return voices.find(v => v.voiceURI === state.settings.ttsVoice)
      ?? voices.find(v => v.lang.toLowerCase() === normalized)
      ?? voices.find(v => v.lang.toLowerCase().split('-')[0] === base)
      ?? voices.find(v => v.default)
      ?? voices[0]
  },

  collect(doc) {
    return [...doc.body.querySelectorAll(this.BLOCKS)]
      .filter(el => !el.querySelector(this.BLOCKS) && el.textContent.trim())
  },

  start() {
    if (!this.supported()) return toast('Read aloud is not available in this browser')
    const c = currentContents()
    if (!c?.doc) return
    this.active = true
    this.paused = false
    this.doc = c.doc
    this.blocks = this.collect(c.doc)
    const range = state.view.lastLocation?.range
    let start = range ? this.blocks.findIndex(b => range.intersectsNode(b)) : 0
    this.i = Math.max(0, start)
    $('#tts-bar').hidden = false
    $('#btn-tts').setAttribute('aria-pressed', 'true')
    this.renderControls()
    this.speak()
  },

  speak() {
    speechSynthesis.cancel()
    if (!this.active || this.paused) return
    if (this.i >= this.blocks.length) return this.nextSection()
    const lang = this.doc.documentElement.lang || state.view.language?.canonical || 'en'
    const voice = this.chooseVoice(lang)
    if (!voice) {
      this.stop()
      return toast('No local read-aloud voices are available. Install a system voice, then try again.')
    }
    const el = this.blocks[this.i]
    this.highlight(el)
    const u = new SpeechSynthesisUtterance(el.textContent.replace(/\s+/g, ' ').trim())
    u.rate = Number(state.settings.ttsRate) || 1
    u.voice = voice
    u.lang = lang
    u.onend = () => {
      if (this.current !== u) return
      this.i++
      this.speak()
    }
    u.onerror = e => {
      if (this.current !== u || e.error === 'interrupted' || e.error === 'canceled') return
      toast(`Read aloud stopped: ${e.error}`)
      this.stop()
    }
    this.current = u
    $('#tts-status').textContent = `${this.i + 1} / ${this.blocks.length}`
    speechSynthesis.speak(u)
  },

  async nextSection() {
    this.advancing = true
    const before = currentContents()?.index
    await state.view.renderer.nextSection()
    const c = currentContents()
    this.advancing = false
    if (!c || c.index === before) { toast('End of book'); return this.stop() }
    this.doc = c.doc
    this.blocks = this.collect(c.doc)
    this.i = 0
    this.speak()
  },

  onSectionLoad(doc) {
    // user navigated to another chapter while reading: stop cleanly
    if (this.active && !this.advancing && doc !== this.doc) this.stop()
  },

  highlight(el) {
    this.doc?.querySelectorAll('.quire-tts-active').forEach(x => x.classList.remove('quire-tts-active'))
    if (!el) return
    el.classList.add('quire-tts-active')
    const range = el.ownerDocument.createRange()
    range.selectNodeContents(el)
    // only move the page when the paragraph is not already visible
    const vis = state.view.lastLocation?.range
    if (!vis || !vis.intersectsNode(el) || vis.comparePoint(el, el.childNodes.length) > 0)
      state.view.renderer.scrollToAnchor?.(range)
  },

  togglePause() {
    if (!this.active) return this.start()
    this.paused = !this.paused
    if (this.paused) { this.current = null; speechSynthesis.cancel() } else this.speak()
    this.renderControls()
  },

  stop() {
    this.active = false
    this.paused = false
    this.current = null
    if (this.supported()) speechSynthesis.cancel()
    this.highlight(null)
    $('#tts-bar').hidden = true
    $('#btn-tts').setAttribute('aria-pressed', 'false')
  },

  renderControls() {
    $('#tts-play').innerHTML = this.paused ? icons.play : icons.pause
    $('#tts-status').textContent = this.paused ? 'Paused' : $('#tts-status').textContent
  },

  fillVoices() {
    if (!this.supported()) return
    const sel = $('#tts-voice')
    const voices = this.localVoices()
    const lang = (state.view?.language?.canonical ?? 'en').slice(0, 2)
    const sorted = [...voices].sort((a, b) =>
      (b.lang.startsWith(lang) - a.lang.startsWith(lang)) || a.name.localeCompare(b.name))
    sel.textContent = ''
    const def = new Option(voices.length ? 'Automatic (local voices only)' : 'No local voices available', '')
    sel.append(def)
    for (const v of sorted) sel.append(new Option(`${v.name} (${v.lang})`, v.voiceURI))
    sel.disabled = !voices.length
    sel.value = voices.some(v => v.voiceURI === state.settings.ttsVoice) ? state.settings.ttsVoice : ''
  },
}

// ---------------------------------------------------------------- panels

const closePanels = () => {
  $('#sidebar').hidden = true
  $('#searchpanel').hidden = true
  $('#settings').hidden = true
  $('#help').hidden = true
  $('#btn-toc').setAttribute('aria-pressed', 'false')
  $('#btn-search').setAttribute('aria-pressed', 'false')
  $('#btn-settings').setAttribute('aria-pressed', 'false')
  // give keyboard focus back to the book so arrows work immediately
  try { state.view?.renderer?.focusView?.() } catch {}
}

const showSidebar = (tab = 'toc') => {
  $('#searchpanel').hidden = true
  $('#settings').hidden = true
  $('#btn-search').setAttribute('aria-pressed', 'false')
  $('#btn-settings').setAttribute('aria-pressed', 'false')
  $('#sidebar').hidden = false
  $('#btn-toc').setAttribute('aria-pressed', 'true')
  for (const b of $$('#side-tabs button')) b.setAttribute('aria-pressed', String(b.dataset.tab === tab))
  $('#toc-view').hidden = tab !== 'toc'
  $('#bookmarks-view').hidden = tab !== 'bookmarks'
  if (tab === 'toc') currentTOC?.scrollIntoView({ block: 'center' })
}

const toggleSidebar = (tab = 'toc') => {
  const sb = $('#sidebar')
  const currentTab = $('#toc-view').hidden ? 'bookmarks' : 'toc'
  if (!sb.hidden && currentTab === tab) closePanels()
  else showSidebar(tab)
}

const openSearch = () => {
  $('#sidebar').hidden = true
  $('#settings').hidden = true
  $('#btn-toc').setAttribute('aria-pressed', 'false')
  $('#btn-settings').setAttribute('aria-pressed', 'false')
  $('#searchpanel').hidden = false
  $('#btn-search').setAttribute('aria-pressed', 'true')
  const input = $('#search-input')
  // a text selection inside the book becomes the query
  const sel = currentContents()?.doc?.getSelection?.()?.toString().trim()
  if (sel && sel.length < 80 && !sel.includes('\n')) input.value = sel
  input.focus()
  input.select()
}

const toggleSettings = () => {
  const el = $('#settings')
  const open = el.hidden
  closePanels()
  el.hidden = !open
  $('#btn-settings').setAttribute('aria-pressed', String(open))
}

// ---------------------------------------------------------------- settings UI

const syncSettingsUI = () => {
  const s = state.settings
  for (const b of $$('#theme-picker button')) b.setAttribute('aria-pressed', String(b.dataset.theme === s.theme))
  for (const b of $$('#flow-picker button')) b.setAttribute('aria-pressed', String(b.dataset.flow === s.flow))
  for (const b of $$('#width-picker button')) b.setAttribute('aria-pressed', String(b.dataset.width === s.pageWidth))
  $('#font-family').value = s.fontFamily
  $('#font-size').value = s.fontSize
  $('#font-size-out').textContent = `${s.fontSize}px`
  $('#line-height').value = s.lineHeight
  $('#line-height-out').textContent = Number(s.lineHeight).toFixed(1)
  $('#opt-justify').checked = s.justify
  $('#opt-columns').checked = s.twoColumns
  $('#tts-rate').value = String(s.ttsRate)
}

const cycleTheme = () => {
  const order = ['light', 'sepia', 'dark']
  const next = order[(order.indexOf(state.settings.theme) + 1) % order.length]
  updateSettings({ theme: next })
  toast(`${next[0].toUpperCase()}${next.slice(1)} theme`)
}
const toggleFlow = () => {
  const flow = state.settings.flow === 'paginated' ? 'scrolled' : 'paginated'
  updateSettings({ flow })
  toast(flow === 'scrolled' ? 'Scroll mode' : 'Page mode')
}
const fontStep = d => updateSettings({ fontSize: Math.min(32, Math.max(12, state.settings.fontSize + d)) })

// ---------------------------------------------------------------- keyboard

// Shortcut labels: Cmd on a Mac, Ctrl elsewhere (onKey accepts either).
const isMac = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || '')
const MOD = isMac ? '⌘' : 'Ctrl'
const labelShortcuts = () => {
  $('#btn-search').title = `Search the book (${MOD}+F or /)`
  $('#btn-search').setAttribute('aria-label', $('#btn-search').title)
  for (const k of $$('kbd[data-mod]')) k.textContent = MOD
}

const isTyping = t => t?.closest?.('input, textarea, select, [contenteditable]') && t.type !== 'checkbox' && t.type !== 'range'

function onKey(e) {
  const view = state.view
  const mod = e.metaKey || e.ctrlKey
  if (mod && (e.key === 'f' || e.key === 'F')) {
    if (!view) return
    e.preventDefault()
    openSearch()
    return
  }
  if (e.key === 'Escape') {
    if (readAloud.active && $('#sidebar').hidden && $('#searchpanel').hidden && $('#settings').hidden) readAloud.stop()
    closePanels()
    return
  }
  if (mod || e.altKey || isTyping(e.target) || !view || document.body.dataset.state !== 'reading') return
  const scrolled = view.renderer?.scrolled
  let handled = true
  switch (e.key) {
    case 'ArrowLeft': view.goLeft(); break
    case 'ArrowRight': view.goRight(); break
    case 'PageUp': view.prev(); break
    case 'PageDown': view.next(); break
    case ' ': e.shiftKey ? view.prev() : view.next(); break
    case 'ArrowUp': scrolled ? view.prev(80) : view.prev(); break
    case 'ArrowDown': scrolled ? view.next(80) : view.next(); break
    case '[': view.renderer.prevSection(); break
    case ']': view.renderer.nextSection(); break
    case '/': openSearch(); break
    case 't': case 'T': toggleSidebar('toc'); break
    case 'b': toggleBookmark(); break
    case 'B': toggleSidebar('bookmarks'); break
    case 'm': case 'M': toggleFlow(); break
    case 'd': case 'D': cycleTheme(); break
    case 'a': case 'A': toggleSettings(); break
    case 'r': case 'R': readAloud.active ? readAloud.togglePause() : readAloud.start(); break
    case '+': case '=': fontStep(1); break
    case '-': case '_': fontStep(-1); break
    case '?': $('#help').hidden = !$('#help').hidden; break
    default: handled = false
  }
  if (handled) e.preventDefault()
}

// ---------------------------------------------------------------- wiring

let progressDragging = false

const wire = () => {
  hydrateIcons()
  document.addEventListener('keydown', onKey)

  $('#btn-toc').addEventListener('click', () => toggleSidebar('toc'))
  $('#btn-search').addEventListener('click', () => $('#searchpanel').hidden ? openSearch() : closePanels())
  $('#btn-bookmark').addEventListener('click', toggleBookmark)
  $('#btn-settings').addEventListener('click', toggleSettings)
  $('#btn-help').addEventListener('click', () => { $('#help').hidden = false })
  $('#btn-tts').addEventListener('click', () => readAloud.active ? readAloud.stop() : readAloud.start())
  $('#help').addEventListener('click', e => { if (e.target.id === 'help') $('#help').hidden = true })
  for (const b of $$('[data-close]')) b.addEventListener('click', closePanels)
  for (const b of $$('#side-tabs button')) b.addEventListener('click', () => showSidebar(b.dataset.tab))
  $('#edge-prev').addEventListener('click', () => state.view?.goLeft())
  $('#edge-next').addEventListener('click', () => state.view?.goRight())

  // search
  const input = $('#search-input')
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (input.value === state.lastQuery && state.searchResults.length)
        goToResult(state.searchIndex + (e.shiftKey ? -1 : 1))
      else runSearch(input.value).then(() => { if (state.searchResults.length) goToResult(0) })
    }
  })
  input.addEventListener('search', () => { if (!input.value) runSearch('') })
  for (const id of ['#opt-case', '#opt-words'])
    $(id).addEventListener('change', () => { if (input.value) runSearch(input.value) })
  $('#search-next').addEventListener('click', () => goToResult(state.searchIndex + 1))
  $('#search-prev').addEventListener('click', () => goToResult(state.searchIndex - 1))

  // settings
  for (const b of $$('#theme-picker button')) b.addEventListener('click', () => updateSettings({ theme: b.dataset.theme }))
  for (const b of $$('#flow-picker button')) b.addEventListener('click', () => updateSettings({ flow: b.dataset.flow }))
  for (const b of $$('#width-picker button')) b.addEventListener('click', () => updateSettings({ pageWidth: b.dataset.width }))
  $('#font-family').addEventListener('change', e => updateSettings({ fontFamily: e.target.value }))
  $('#font-size').addEventListener('input', e => updateSettings({ fontSize: Number(e.target.value) }))
  $('#font-smaller').addEventListener('click', () => fontStep(-1))
  $('#font-larger').addEventListener('click', () => fontStep(1))
  $('#line-height').addEventListener('input', e => updateSettings({ lineHeight: Number(e.target.value) }))
  $('#opt-justify').addEventListener('change', e => updateSettings({ justify: e.target.checked }))
  $('#opt-columns').addEventListener('change', e => updateSettings({ twoColumns: e.target.checked }))

  // progress slider
  const prog = $('#progress')
  prog.addEventListener('pointerdown', () => { progressDragging = true })
  prog.addEventListener('input', () => { $('#loc-right').textContent = pct.format(Number(prog.value)) })
  prog.addEventListener('change', async () => {
    progressDragging = false
    await state.view?.goToFraction(Number(prog.value))
  })

  // read aloud
  $('#tts-play').addEventListener('click', () => readAloud.togglePause())
  $('#tts-stop').addEventListener('click', () => readAloud.stop())
  $('#tts-rate').addEventListener('change', e => {
    store.saveSettings({ ttsRate: Number(e.target.value) })
    state.settings.ttsRate = Number(e.target.value)
    if (readAloud.active && !readAloud.paused) readAloud.speak()
  })
  $('#tts-voice').addEventListener('change', e => {
    store.saveSettings({ ttsVoice: e.target.value })
    state.settings.ttsVoice = e.target.value
    if (readAloud.active && !readAloud.paused) readAloud.speak()
  })
  if (readAloud.supported()) {
    speechSynthesis.addEventListener?.('voiceschanged', () => readAloud.fillVoices())
    readAloud.fillVoices()
  } else $('#btn-tts').hidden = true
  addEventListener('pagehide', () => readAloud.stop())

  labelShortcuts()

  // open another file
  const fileInput = $('#file-input')
  fileInput.addEventListener('change', () => openLocalFile(fileInput.files[0]))
  $('#error-pick').addEventListener('click', () => fileInput.click())
  // The landing page forwards files dropped outside the frame (same origin only).
  addEventListener('message', e => {
    if (e.origin !== location.origin || e.source !== window.parent) return
    if (e.data?.type === 'quire-open' && e.data.file instanceof Blob) openLocalFile(e.data.file)
  })

  // drag and drop anywhere
  let dragDepth = 0
  addEventListener('dragenter', e => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return
    dragDepth++
    document.body.classList.add('dragging')
  })
  addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging') } })
  addEventListener('dragover', e => e.preventDefault())
  addEventListener('drop', e => {
    e.preventDefault()
    dragDepth = 0
    document.body.classList.remove('dragging')
    const file = [...(e.dataTransfer?.files ?? [])][0]
    if (file) openLocalFile(file)
  })

  // settings changed in another tab (e.g. theme in the library)
  store.onSettingsChanged(settings => {
    Object.assign(state.settings, settings)
    applySettings()
  })
}

const main = async () => {
  // Never render inside another site's frame. The quireapps.com landing page
  // embeds the reader from the same origin, which is allowed.
  if (!sameOriginParent()) { document.body.textContent = ''; return }
  state.settings = await store.getSettings()
  applyUITheme()
  wire()
  syncSettingsUI()
  const params = new URLSearchParams(location.search)
  const id = params.get('book')
  if (id) await openFromLibrary(id)
  else location.replace('library.html')
}

function sameOriginParent() {
  if (window.top === window) return true
  try { return window.parent.location.origin === location.origin } catch { return false }
}

main()

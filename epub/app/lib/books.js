// Turning bytes into a book: validation, metadata, library record.
import { makeBook } from '../vendor/foliate-js/view.js'
import { getBook, putBook, hashFile, formatLang, formatAuthor } from './store.js'

export class BookError extends Error {
  constructor(title, detail, cause) {
    super(title, { cause })
    this.title = title
    this.detail = detail
  }
}

const looksLikeZip = async blob => {
  const a = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
  return a[0] === 0x50 && a[1] === 0x4b && a[2] === 0x03 && a[3] === 0x04
}

// Font obfuscation (IDPF and Adobe) is not DRM: DRM-free books use it to
// protect embedded fonts, and foliate-js undoes it.
const FONT_OBFUSCATION = new Set([
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC',
])
const XMLENC = 'http://www.w3.org/2001/04/xmlenc#'

// Returns which DRM scheme the archive uses ('adept', 'lcp', 'encrypted'), or
// null. Any failure to read the archive returns null so the normal parse
// reports it as damaged or invalid.
const detectDRM = async file => {
  try {
    const { configure, ZipReader, BlobReader, TextWriter } =
      await import('../vendor/foliate-js/vendor/zip.js')
    configure({ useWebWorkers: false })
    const reader = new ZipReader(new BlobReader(file))
    const entries = await reader.getEntries()
    const find = name => entries.find(e => e.filename.toLowerCase() === name)
    if (find('meta-inf/rights.xml')) return 'adept'
    if (find('meta-inf/license.lcpl')) return 'lcp'
    const enc = find('meta-inf/encryption.xml')
    if (!enc) return null
    const doc = new DOMParser().parseFromString(await enc.getData(new TextWriter()), 'application/xml')
    if (doc.querySelector('parsererror')) return null
    for (const data of doc.getElementsByTagNameNS(XMLENC, 'EncryptedData')) {
      const algorithm = data.getElementsByTagNameNS(XMLENC, 'EncryptionMethod')[0]
        ?.getAttribute('Algorithm')?.trim() ?? ''
      // A missing algorithm still means the resource cannot be read as-is.
      if (!FONT_OBFUSCATION.has(algorithm)) return 'encrypted'
    }
    return null
  } catch (e) {
    console.warn('DRM check skipped', e)
    return null
  }
}

// Parse a File/Blob with foliate-js. Throws BookError with a human message.
export const parseBook = async file => {
  if (!file || !file.size) throw new BookError('This file is empty',
    'The file contains no data. If you downloaded it, try downloading it again.')
  const isZip = await looksLikeZip(file)
  const drm = isZip ? await detectDRM(file) : null
  if (drm) throw new BookError('This book is DRM-protected',
    'Quire opens DRM-free EPUBs only. Open it in the app or store it came from, such as Adobe Digital Editions.',
    new Error(`DRM detected: ${drm === 'adept' ? 'Adobe ADEPT (META-INF/rights.xml)'
      : drm === 'lcp' ? 'Readium LCP (META-INF/license.lcpl)'
      : 'encrypted resources in META-INF/encryption.xml'}`))
  let book
  try {
    book = await makeBook(file)
  } catch (e) {
    console.error(e)
    if (!isZip) throw new BookError('This is not an EPUB file',
      'EPUB books are ZIP archives, but this file is not one. It may be a web page, a damaged download, or a different format.', e)
    const msg = String(e?.message ?? e)
    if (/end of central directory|zip|signature|Unexpected end|split/i.test(msg))
      throw new BookError('This EPUB file is damaged',
        'The ZIP archive inside the book is incomplete or corrupted, often because a download was cut short. Try downloading the book again.', e)
    throw new BookError('This EPUB could not be opened',
      `The book is missing required parts (${msg}). It may be damaged or not a valid EPUB.`, e)
  }
  if (!book?.sections?.length) throw new BookError('This EPUB has no readable content',
    'The book opened but its reading order (spine) is empty.')
  if (book.rendition?.layout === 'pre-paginated') {
    // fixed-layout books render, but note it for the UI
    book.__fixedLayout = true
  }
  return book
}

const coverOf = async book => {
  try {
    const blob = await book.getCover?.()
    if (!blob) return null
    // downscale to keep the library light
    const bmp = await createImageBitmap(blob)
    const w = 240, h = Math.round(bmp.height * (240 / bmp.width))
    const canvas = new OffscreenCanvas(w, h)
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h)
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
  } catch (e) {
    console.warn('cover failed', e)
    return null
  }
}

export const titleOf = book => formatLang(book.metadata?.title) || 'Untitled book'

// Parse, then add/update the library. Returns { id, book, record }.
export const importFile = async (file, { sourceUrl = '', fileName = '' } = {}) => {
  const book = await parseBook(file)
  const id = await hashFile(file)
  const existing = await getBook(id)
  const now = Date.now()
  const record = existing ?? {
    id,
    title: titleOf(book),
    author: formatAuthor(book.metadata?.author),
    identifier: formatLang(book.metadata?.identifier) || '',
    size: file.size,
    fileName: fileName || file.name || '',
    sourceUrl,
    addedAt: now,
    cover: await coverOf(book),
    file: file instanceof File ? new Blob([file], { type: 'application/epub+zip' }) : file,
  }
  record.lastOpenedAt = now
  if (sourceUrl && !record.sourceUrl) record.sourceUrl = sourceUrl
  await putBook(record)
  return { id, book, record }
}

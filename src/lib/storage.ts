import type { Card, Line } from './paragraphs'

export interface Book {
  id: string
  name: string
  cards: Card[]
  /** 'photo': built page by page from camera/gallery photos. Missing on older (PDF) books. */
  kind?: 'pdf' | 'photo'
  /** Photo books: OCR language, detected once from the first page. */
  lang?: string
  /** Photo books: number of pages added so far. */
  pageCount?: number
}

/** A saved book plus when it was last opened, for ordering the library. */
export interface SavedBook extends Book {
  openedAt: number
}

/** One photographed page of a photo book. */
export interface PhotoPage {
  id: string
  bookId: string
  /** Reading order; not necessarily contiguous. */
  order: number
  image: Blob
  thumb: Blob
  status: 'pending' | 'done' | 'error'
  /** OCR result, once status is 'done'. */
  lines?: Line[]
}

const LEGACY_LAST_BOOK = 'kitshorts:lastBook'
const posKey = (id: string) => `kitshorts:pos:${id}`

export function bookId(file: File): string {
  return `${file.name}:${file.size}`
}

export const isPhotoBook = (b: Book) => b.kind === 'photo'

export function savePosition(id: string, index: number): void {
  try {
    localStorage.setItem(posKey(id), String(index))
  } catch {
    // storage unavailable: resume simply won't work
  }
}

export function loadPosition(id: string): number {
  try {
    return Number(localStorage.getItem(posKey(id))) || 0
  } catch {
    return 0
  }
}

// Books live in IndexedDB: a long book's cards easily exceed localStorage's ~5 MB quota.
const DB_NAME = 'kitshorts'
const BOOKS = 'books'
const PAGES = 'pages'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(BOOKS)) db.createObjectStore(BOOKS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(PAGES)) db.createObjectStore(PAGES, { keyPath: 'id' }).createIndex('bookId', 'bookId')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Runs `body` in one transaction and resolves with its result once the transaction commits. */
async function transact<T>(
  stores: string[],
  mode: IDBTransactionMode,
  body: (t: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openDb()
  const t = db.transaction(stores, mode)
  const committed = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error ?? new Error('transaction aborted'))
  })
  committed.catch(() => {}) // surfaced by the await below; avoids an unhandled rejection if body throws first
  const result = await body(t)
  await committed
  return result
}

export async function saveBook(book: Book): Promise<SavedBook> {
  const saved = { ...book, openedAt: Date.now() }
  try {
    await transact([BOOKS], 'readwrite', (t) => done(t.objectStore(BOOKS).put(saved)))
  } catch {
    // storage full or blocked: the book is readable now but not kept
  }
  return saved
}

export async function getBook(id: string): Promise<SavedBook | undefined> {
  return transact([BOOKS], 'readonly', (t) => done<SavedBook | undefined>(t.objectStore(BOOKS).get(id)))
}

/** Merges `patch` into a saved book in one transaction (safe against concurrent updates). */
export async function updateBook(id: string, patch: Partial<Book>, touch = false): Promise<SavedBook | undefined> {
  return transact([BOOKS], 'readwrite', async (t) => {
    const store = t.objectStore(BOOKS)
    const book = await done<SavedBook | undefined>(store.get(id))
    if (!book) return undefined
    const next = { ...book, ...patch, id, openedAt: touch ? Date.now() : book.openedAt }
    await done(store.put(next))
    return next
  })
}

export async function createPhotoBook(name: string): Promise<SavedBook> {
  const book: SavedBook = {
    id: `photo:${crypto.randomUUID()}`,
    name,
    cards: [],
    kind: 'photo',
    pageCount: 0,
    openedAt: Date.now(),
  }
  await transact([BOOKS], 'readwrite', (t) => done(t.objectStore(BOOKS).put(book)))
  return book
}

export async function deleteBook(id: string): Promise<void> {
  try {
    await transact([BOOKS, PAGES], 'readwrite', async (t) => {
      t.objectStore(BOOKS).delete(id)
      const pages = t.objectStore(PAGES)
      const keys = await done(pages.index('bookId').getAllKeys(id))
      keys.forEach((k) => pages.delete(k))
    })
    localStorage.removeItem(posKey(id))
  } catch {
    // nothing to clean up
  }
}

/** All saved books, most recently opened first. */
export async function loadLibrary(): Promise<SavedBook[]> {
  try {
    await migrateLegacyBook()
    const books = await transact([BOOKS], 'readonly', (t) => done<SavedBook[]>(t.objectStore(BOOKS).getAll()))
    return books.sort((a, b) => b.openedAt - a.openedAt)
  } catch {
    return []
  }
}

// Earlier versions kept only the last book, in localStorage; move it into the library.
async function migrateLegacyBook(): Promise<void> {
  const raw = localStorage.getItem(LEGACY_LAST_BOOK)
  if (!raw) return
  const book = JSON.parse(raw) as Book
  await transact([BOOKS], 'readwrite', (t) => done(t.objectStore(BOOKS).put({ ...book, openedAt: Date.now() })))
  localStorage.removeItem(LEGACY_LAST_BOOK)
}

/* Photo book pages */

/** A book's pages in reading order. */
export async function loadPages(bookId: string): Promise<PhotoPage[]> {
  const pages = await transact([PAGES], 'readonly', (t) =>
    done<PhotoPage[]>(t.objectStore(PAGES).index('bookId').getAll(bookId)),
  )
  return pages.sort((a, b) => a.order - b.order)
}

/** Appends pages (already resized) after the book's last page, in the given order. */
export async function addPages(bookId: string, images: { image: Blob; thumb: Blob }[]): Promise<PhotoPage[]> {
  return transact([BOOKS, PAGES], 'readwrite', async (t) => {
    const store = t.objectStore(PAGES)
    const existing = await done<PhotoPage[]>(store.index('bookId').getAll(bookId))
    let order = existing.reduce((max, p) => Math.max(max, p.order), 0)
    const added = images.map(({ image, thumb }) => ({
      id: crypto.randomUUID(),
      bookId,
      order: ++order,
      image,
      thumb,
      status: 'pending' as const,
    }))
    added.forEach((p) => store.put(p))
    const books = t.objectStore(BOOKS)
    const book = await done<SavedBook | undefined>(books.get(bookId))
    if (book) books.put({ ...book, pageCount: existing.length + added.length })
    return added
  })
}

/** Merges `patch` into a page; does nothing if the page was deleted meanwhile. */
export async function updatePage(id: string, patch: Partial<Omit<PhotoPage, 'id' | 'bookId'>>): Promise<void> {
  await transact([PAGES], 'readwrite', async (t) => {
    const store = t.objectStore(PAGES)
    const page = await done<PhotoPage | undefined>(store.get(id))
    if (page) store.put({ ...page, ...patch })
  })
}

export async function deletePage(page: PhotoPage): Promise<void> {
  await transact([BOOKS, PAGES], 'readwrite', async (t) => {
    const store = t.objectStore(PAGES)
    store.delete(page.id)
    const remaining = await done(store.index('bookId').count(page.bookId))
    const books = t.objectStore(BOOKS)
    const book = await done<SavedBook | undefined>(books.get(page.bookId))
    if (book) books.put({ ...book, pageCount: remaining })
  })
}

/** Rewrites page order to follow `ids`. */
export async function reorderPages(ids: string[]): Promise<void> {
  await transact([PAGES], 'readwrite', async (t) => {
    const store = t.objectStore(PAGES)
    const pages = await Promise.all(ids.map((id) => done<PhotoPage | undefined>(store.get(id))))
    pages.forEach((p, i) => p && store.put({ ...p, order: i + 1 }))
  })
}

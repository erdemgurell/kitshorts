import type { Card } from './extractParagraphs'

export interface Book {
  id: string
  name: string
  cards: Card[]
}

/** A saved book plus when it was last opened, for ordering the library. */
export interface SavedBook extends Book {
  openedAt: number
}

const LEGACY_LAST_BOOK = 'kitshorts:lastBook'
const posKey = (id: string) => `kitshorts:pos:${id}`

export function bookId(file: File): string {
  return `${file.name}:${file.size}`
}

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
const STORE = 'books'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = run(db.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveBook(book: Book): Promise<SavedBook> {
  const saved = { ...book, openedAt: Date.now() }
  try {
    await tx('readwrite', (s) => s.put(saved))
  } catch {
    // storage full or blocked: the book is readable now but not kept
  }
  return saved
}

export async function deleteBook(id: string): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(id))
    localStorage.removeItem(posKey(id))
  } catch {
    // nothing to clean up
  }
}

/** All saved books, most recently opened first. */
export async function loadLibrary(): Promise<SavedBook[]> {
  try {
    await migrateLegacyBook()
    const books = await tx<SavedBook[]>('readonly', (s) => s.getAll())
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
  await tx('readwrite', (s) => s.put({ ...book, openedAt: Date.now() }))
  localStorage.removeItem(LEGACY_LAST_BOOK)
}

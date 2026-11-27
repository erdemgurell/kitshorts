// Background OCR of photo book pages and rebuilding the book's cards from them.
import { buildCards } from './paragraphs'
import { addPages, getBook, loadPages, updateBook, updatePage, type PhotoPage } from './storage'
import { preparePage } from './imagePrep'

export interface ProcessState {
  running: boolean
  /** Pages finished in this run. */
  done: number
  /** Pages queued in this run. */
  total: number
  /** Pages a worker is reading right now. */
  active: Set<string>
  /** The book's language is being picked (first pages of a new book). */
  detecting: boolean
  /** Why the last run stopped early (OCR engine failed to start); pages stay queued. */
  error?: string
}

type Listener = (bookId: string) => void

const states = new Map<string, ProcessState>()
const controllers = new Map<string, AbortController>()
const rerun = new Set<string>()
const listeners = new Set<Listener>()
const rebuilds = new Map<string, Promise<void>>()
const errors = new Map<string, string>()

const idle = (): ProcessState => ({ running: false, done: 0, total: 0, active: new Set(), detecting: false })

export function processState(bookId: string): ProcessState {
  return states.get(bookId) ?? { ...idle(), error: errors.get(bookId) }
}

/** Called whenever a book's pages, cards or processing state change. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const emit = (bookId: string) => listeners.forEach((l) => l(bookId))

/** Resizes and stores photos as new pages at the end of the book, then starts reading them. */
export async function addPhotos(bookId: string, photos: Blob[], onEach?: (done: number) => void): Promise<number> {
  let added = 0
  for (const photo of photos) {
    try {
      await addPages(bookId, [await preparePage(photo)])
      added++
    } catch (e) {
      console.error(e) // undecodable image (e.g. HEIC in a browser that can't read it)
    }
    onEach?.(added)
    emit(bookId)
    processBook(bookId)
  }
  return added
}

/** Recomputes the book's cards from its finished pages, in page order. */
export function rebuildCards(bookId: string): Promise<void> {
  // Serialized per book so a slower, older rebuild can't overwrite a newer one.
  const next = (rebuilds.get(bookId) ?? Promise.resolve()).then(async () => {
    const pages = await loadPages(bookId)
    const cards = buildCards(pages.map((p, i) => (p.lines ?? []).map((l) => ({ ...l, page: i + 1 }))))
    await updateBook(bookId, { cards, pageCount: pages.length })
    emit(bookId)
  })
  const settled = next.catch((e) => console.error(e))
  rebuilds.set(bookId, settled)
  return settled
}

/** Reads every pending page of the book. Safe to call repeatedly; extra calls queue one more pass. */
export function processBook(bookId: string): void {
  if (states.get(bookId)?.running) {
    rerun.add(bookId)
    return
  }
  void run(bookId)
}

export function cancelProcessing(bookId: string): void {
  controllers.get(bookId)?.abort()
  rerun.delete(bookId)
}

async function run(bookId: string): Promise<void> {
  const controller = new AbortController()
  controllers.set(bookId, controller)
  const { signal } = controller
  const state = idle()
  state.running = true
  states.set(bookId, state)
  errors.delete(bookId)
  emit(bookId)

  try {
    do {
      rerun.delete(bookId)
      const book = await getBook(bookId)
      const pending = (await loadPages(bookId)).filter((p) => p.status === 'pending')
      if (!book || !pending.length) break
      state.total += pending.length
      state.detecting = !book.lang
      emit(bookId)

      const { ocrImages } = await import('./ocr')
      await ocrImages(
        pending.map((p) => ({ key: p.id, blob: p.image })),
        book.lang,
        {
          onLanguage: async (lang) => {
            state.detecting = false
            await updateBook(bookId, { lang })
            emit(bookId)
          },
          onStart: (id) => {
            state.detecting = false
            state.active.add(id)
            emit(bookId)
          },
          onPage: async (id, lines) => {
            state.active.delete(id)
            state.done++
            await updatePage(id, { status: 'done', lines })
            await rebuildCards(bookId)
          },
          onError: async (id) => {
            state.active.delete(id)
            state.done++
            await updatePage(id, { status: 'error' })
            emit(bookId)
          },
        },
        signal,
      )
    } while (rerun.has(bookId) && !signal.aborted)
  } catch (e) {
    console.error(e)
    if (!signal.aborted) errors.set(bookId, e instanceof Error ? e.message : String(e))
  } finally {
    controllers.delete(bookId)
    states.delete(bookId)
    rerun.delete(bookId)
    emit(bookId)
  }
}

/** Sets the book's OCR language and reads every page again with it. */
export async function setLanguage(bookId: string, lang: string): Promise<void> {
  cancelProcessing(bookId)
  // Let a cancelled run unwind first, or a page it was saving could land after the reset below.
  while (states.get(bookId)?.running) await new Promise((r) => setTimeout(r, 50))
  await updateBook(bookId, { lang })
  for (const page of await loadPages(bookId)) await updatePage(page.id, { status: 'pending', lines: undefined })
  await rebuildCards(bookId)
  processBook(bookId)
}

/** Puts a page back in the queue, optionally with a new photo. */
export async function rereadPage(page: PhotoPage, photo?: Blob): Promise<void> {
  const replacement = photo ? await preparePage(photo) : {}
  await updatePage(page.id, { ...replacement, status: 'pending', lines: undefined })
  await rebuildCards(page.bookId)
  processBook(page.bookId)
}

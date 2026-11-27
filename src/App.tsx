import { useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'
import Uploader from './components/Uploader'
import CardFeed from './components/CardFeed'
import BookFolder from './components/BookFolder'
import type { Progress } from './lib/paragraphs'
import {
  bookId,
  createPhotoBook,
  deleteBook,
  getBook,
  isPhotoBook,
  loadLibrary,
  saveBook,
  updateBook,
  type Book,
  type SavedBook,
} from './lib/storage'
import { addPhotos, cancelProcessing, processState, subscribe } from './lib/photoBook'
import { rememberCameraBook, restoredPhotos } from './lib/capture'

export default function App() {
  const [book, setBook] = useState<Book | null>(null)
  /** Open photo book folder; the reader can sit on top of it. */
  const [folder, setFolder] = useState<string | null>(null)
  const [library, setLibrary] = useState<SavedBook[]>([])
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const reloadLibrary = () => loadLibrary().then(setLibrary)

  useEffect(() => {
    void reloadLibrary()
  }, [])

  // Android may kill the app while the camera is open; the photo then arrives on restart.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    const handle = CapApp.addListener('appRestoredResult', async (event) => {
      const restored = await restoredPhotos(event)
      if (!restored) return
      await addPhotos(restored.bookId, restored.photos)
      setFolder(restored.bookId)
    })
    return () => {
      handle.then((h) => h.remove())
    }
  }, [])

  // A photo book open in the reader picks up cards from pages still being read in the background.
  const readingPhotoBook = book && isPhotoBook(book) ? book.id : null
  useEffect(() => {
    if (!readingPhotoBook) return
    let active = true
    const sync = async () => {
      const latest = await getBook(readingPhotoBook)
      if (!active) return
      const s = processState(readingPhotoBook)
      setProgress(s.running ? { stage: 'ocr', done: s.done, total: s.total } : null)
      if (latest?.cards.length) setBook((b) => (b?.id === latest.id ? latest : b))
    }
    void sync()
    const unsubscribe = subscribe((id) => id === readingPhotoBook && void sync())
    return () => {
      active = false
      unsubscribe()
    }
  }, [readingPhotoBook])

  const open = (b: Book) => {
    if (isPhotoBook(b)) {
      setFolder(b.id)
      void updateBook(b.id, {}, true)
      return
    }
    setBook(b)
    // Bump it to the top of the library (and save it if it's new).
    saveBook(b).then((saved) => setLibrary((lib) => [saved, ...lib.filter((x) => x.id !== saved.id)]))
  }

  const read = (b: SavedBook) => {
    setBook(b)
    void updateBook(b.id, {}, true)
  }

  const remove = (id: string) => {
    cancelProcessing(id)
    deleteBook(id)
    setLibrary((lib) => lib.filter((x) => x.id !== id))
  }

  const create = async (name: string) => {
    const created = await createPhotoBook(name)
    setLibrary((lib) => [created, ...lib])
    setFolder(created.id)
  }

  const load = async (file: File) => {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setError('Lütfen bir PDF dosyası seçin.')
      return
    }
    const id = bookId(file)
    // Book read before: reuse its cards instead of extracting (and OCR'ing) again.
    const saved = library.find((b) => b.id === id)
    if (saved) {
      setError(null)
      open(saved)
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    const meta = { id, name: file.name.replace(/\.pdf$/i, '') }
    setError(null)
    setProgress({ stage: 'text', done: 0, total: 0 })
    try {
      const { extractCards } = await import('./lib/extractParagraphs')
      const cards = await extractCards(await file.arrayBuffer(), {
        signal: controller.signal,
        onProgress: setProgress,
        onPartial: (partial) => partial.length && setBook({ ...meta, cards: partial }),
      })
      if (controller.signal.aborted) return
      if (!cards.length) {
        setBook(null)
        setError("Bu PDF'ten okunabilir metin çıkarılamadı.")
        return
      }
      open({ ...meta, cards })
    } catch (e) {
      if (controller.signal.aborted) return
      console.error(e)
      setBook(null)
      setError('PDF okunamadı. Dosya bozuk ya da şifreli olabilir.')
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
        setProgress(null)
      }
    }
  }

  const close = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setProgress(null)
    setBook(null)
  }

  const closeFolder = () => {
    setFolder(null)
    void reloadLibrary()
  }

  // Android back button: reader → folder (photo books) → library → leave the app.
  const backRef = useRef<(() => void) | null>(null)
  backRef.current = book ? close : folder ? closeFolder : null
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    const handle = CapApp.addListener('backButton', () => {
      if (backRef.current) backRef.current()
      else CapApp.exitApp()
    })
    return () => {
      handle.then((h) => h.remove())
    }
  }, [])

  if (book)
    return (
      <CardFeed
        book={book}
        progress={progress}
        onClose={close}
        backLabel={folder ? '← Sayfalar' : '← Kitaplık'}
        onAddPages={folder ? close : undefined}
      />
    )
  if (folder)
    return <BookFolder bookId={folder} onBack={closeFolder} onRead={read} onCameraOpen={rememberCameraBook} />
  return (
    <Uploader
      onFile={load}
      onCreate={create}
      progress={progress}
      error={error}
      library={library}
      onOpen={open}
      onDelete={remove}
    />
  )
}

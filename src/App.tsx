import { useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'
import Uploader from './components/Uploader'
import CardFeed from './components/CardFeed'
import type { Progress } from './lib/extractParagraphs'
import { bookId, deleteBook, loadLibrary, saveBook, type Book, type SavedBook } from './lib/storage'

export default function App() {
  const [book, setBook] = useState<Book | null>(null)
  const [library, setLibrary] = useState<SavedBook[]>([])
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    loadLibrary().then(setLibrary)
  }, [])

  const open = (b: Book) => {
    setBook(b)
    // Bump it to the top of the library (and save it if it's new).
    saveBook(b).then((saved) => setLibrary((lib) => [saved, ...lib.filter((x) => x.id !== saved.id)]))
  }

  const remove = (id: string) => {
    deleteBook(id)
    setLibrary((lib) => lib.filter((x) => x.id !== id))
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

  // Android back button: close the open book first, leave the app only from the library.
  const closeRef = useRef<(() => void) | null>(null)
  closeRef.current = book ? close : null
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    const handle = CapApp.addListener('backButton', () => {
      if (closeRef.current) closeRef.current()
      else CapApp.exitApp()
    })
    return () => {
      handle.then((h) => h.remove())
    }
  }, [])

  if (book) return <CardFeed book={book} progress={progress} onClose={close} />
  return <Uploader onFile={load} progress={progress} error={error} library={library} onOpen={open} onDelete={remove} />
}

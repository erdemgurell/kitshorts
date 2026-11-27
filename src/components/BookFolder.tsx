import { useEffect, useRef, useState } from 'react'
import { deletePage, getBook, loadPages, reorderPages, updateBook, type PhotoPage, type SavedBook } from '../lib/storage'
import { addPhotos, processBook, processState, rebuildCards, rereadPage, subscribe } from '../lib/photoBook'
import { hasNativeCamera, pickPhotos, takePhoto, takePhotos } from '../lib/capture'

interface Props {
  bookId: string
  onBack: () => void
  onRead: (book: SavedBook) => void
  /** Called before the native camera opens, so a photo can be recovered if Android kills the app meanwhile. */
  onCameraOpen: (bookId: string) => void
}

export default function BookFolder({ bookId, onBack, onRead, onCameraOpen }: Props) {
  const [book, setBook] = useState<SavedBook | null>(null)
  const [pages, setPages] = useState<PhotoPage[]>([])
  const [proc, setProc] = useState(() => processState(bookId))
  const [adding, setAdding] = useState<{ done: number; total?: number } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cameraInput = useRef<HTMLInputElement>(null)
  const galleryInput = useRef<HTMLInputElement>(null)
  const retakeInput = useRef<HTMLInputElement>(null)
  const thumbs = useRef(new Map<string, { blob: Blob; url: string }>())

  const refresh = async () => {
    const [b, p] = await Promise.all([getBook(bookId), loadPages(bookId)])
    if (b) setBook(b)
    setPages(p)
    const s = processState(bookId)
    setProc({ ...s, active: new Set(s.active) })
  }

  useEffect(() => {
    void refresh()
    // Pick up pages left unread when the app was closed mid-way.
    processBook(bookId)
    const unsubscribe = subscribe((id) => id === bookId && void refresh())
    const urls = thumbs.current
    return () => {
      unsubscribe()
      urls.forEach((t) => URL.revokeObjectURL(t.url))
      urls.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  const thumbUrl = (p: PhotoPage) => {
    const cached = thumbs.current.get(p.id)
    if (cached?.blob === p.thumb) return cached.url
    if (cached) URL.revokeObjectURL(cached.url)
    const url = URL.createObjectURL(p.thumb)
    thumbs.current.set(p.id, { blob: p.thumb, url })
    return url
  }

  const add = async (photos: Blob[]) => {
    if (!photos.length) return
    setError(null)
    setAdding({ done: 0, total: photos.length })
    const added = await addPhotos(bookId, photos, (done) => setAdding({ done, total: photos.length }))
    setAdding(null)
    if (added < photos.length) setError(`${photos.length - added} fotoğraf açılamadı (desteklenmeyen biçim olabilir).`)
  }

  const shoot = async () => {
    if (!hasNativeCamera()) return cameraInput.current?.click()
    setError(null)
    let done = 0
    setAdding({ done })
    onCameraOpen(bookId)
    await takePhotos(async (photo) => {
      await addPhotos(bookId, [photo])
      setAdding({ done: ++done })
      onCameraOpen(bookId)
    })
    setAdding(null)
  }

  const fromGallery = async () => {
    if (!hasNativeCamera()) return galleryInput.current?.click()
    onCameraOpen(bookId)
    await add(await pickPhotos())
  }

  const selectedPage = pages.find((p) => p.id === selected) ?? null
  const selectedIndex = selectedPage ? pages.indexOf(selectedPage) : -1

  const move = async (delta: number) => {
    const to = selectedIndex + delta
    if (!selectedPage || to < 0 || to >= pages.length) return
    const ids = pages.map((p) => p.id)
    ids.splice(selectedIndex, 1)
    ids.splice(to, 0, selectedPage.id)
    await reorderPages(ids)
    await rebuildCards(bookId)
  }

  const retake = async () => {
    if (!selectedPage) return
    if (!hasNativeCamera()) return retakeInput.current?.click()
    onCameraOpen(bookId)
    const photo = await takePhoto()
    if (photo) await rereadPage(selectedPage, photo)
  }

  const remove = async () => {
    if (!selectedPage || !confirm(`${selectedIndex + 1}. sayfa silinsin mi?`)) return
    setSelected(null)
    await deletePage(selectedPage)
    await rebuildCards(bookId)
  }

  const rename = async (name: string) => {
    setRenaming(false)
    const trimmed = name.trim()
    if (trimmed && trimmed !== book?.name) setBook(await updateBook(bookId, { name: trimmed }) ?? book)
  }

  if (!book) return <main className="folder" />

  const pending = pages.filter((p) => p.status === 'pending').length
  const failed = pages.filter((p) => p.status === 'error').length
  const busy = adding !== null

  return (
    <main className="folder">
      <header className="folder-head">
        <button type="button" className="back" onClick={onBack}>
          ← Kitaplık
        </button>
        {renaming ? (
          <input
            className="folder-name-input"
            defaultValue={book.name}
            autoFocus
            onBlur={(e) => rename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <button type="button" className="folder-name" onClick={() => setRenaming(true)} title="Yeniden adlandır">
            {book.name} <span aria-hidden>✎</span>
          </button>
        )}
      </header>

      <section className="folder-summary">
        <span>
          {pages.length} sayfa · {book.cards.length} kart
        </span>
        <span className="folder-status">
          {adding
            ? adding.total
              ? `Fotoğraflar ekleniyor… ${adding.done} / ${adding.total}`
              : `Seri çekim: ${adding.done} sayfa eklendi`
            : proc.running
              ? proc.detecting
                ? 'Dil tespit ediliyor (ilk seferde dil modeli indirilir)…'
                : `Sayfalar okunuyor… ${proc.done} / ${proc.total}`
              : pending
                ? `${pending} sayfa sırada`
                : failed
                  ? `${failed} sayfa okunamadı`
                  : pages.length
                    ? 'Tüm sayfalar okundu'
                    : ''}
        </span>
        {proc.running && proc.total > 0 && (
          <span className="dz-bar">
            <span style={{ width: `${(proc.done / proc.total) * 100}%` }} />
          </span>
        )}
      </section>

      <div className="folder-actions">
        <button type="button" className="action primary" onClick={shoot} disabled={busy}>
          📷 Sayfa çek
        </button>
        <button type="button" className="action" onClick={fromGallery} disabled={busy}>
          🖼 Galeriden ekle
        </button>
        <button type="button" className="action" onClick={() => onRead(book)} disabled={!book.cards.length}>
          📖 Oku
        </button>
      </div>
      {error && <p className="error">{error}</p>}

      {pages.length === 0 ? (
        <p className="folder-empty">
          Henüz sayfa yok. Kitabın sayfalarını sırayla çek ya da galeriden seç; her fotoğrafta tek sayfa olsun, düz ve iyi
          ışıkta.
        </p>
      ) : (
        <ol className="page-grid">
          {pages.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                className={`page-tile${p.id === selected ? ' selected' : ''}`}
                onClick={() => setSelected(p.id === selected ? null : p.id)}
              >
                <img src={thumbUrl(p)} alt={`${i + 1}. sayfa`} loading="lazy" />
                <span className="page-no">{i + 1}</span>
                {proc.active.has(p.id) ? (
                  <span className="page-badge reading">Okunuyor…</span>
                ) : p.status === 'pending' ? (
                  <span className="page-badge">Sırada</span>
                ) : p.status === 'error' ? (
                  <span className="page-badge failed">Hata</span>
                ) : null}
              </button>
            </li>
          ))}
        </ol>
      )}

      {selectedPage && (
        <div className="page-sheet" role="dialog" aria-label={`${selectedIndex + 1}. sayfa`}>
          <div className="page-sheet-head">
            <strong>{selectedIndex + 1}. sayfa</strong>
            <button type="button" className="back" onClick={() => setSelected(null)} aria-label="Kapat">
              ✕
            </button>
          </div>
          {selectedPage.status === 'done' && (
            <p className="page-preview">
              {selectedPage.lines?.length
                ? selectedPage.lines.map((l) => l.text).join(' ').slice(0, 280) + '…'
                : 'Bu sayfada metin bulunamadı.'}
            </p>
          )}
          <div className="page-sheet-actions">
            <button type="button" className="action" onClick={() => move(-1)} disabled={selectedIndex === 0}>
              ↑ Öne al
            </button>
            <button type="button" className="action" onClick={() => move(1)} disabled={selectedIndex === pages.length - 1}>
              ↓ Geri al
            </button>
            <button type="button" className="action" onClick={retake}>
              📷 Yeniden çek
            </button>
            {selectedPage.status !== 'pending' && (
              <button type="button" className="action" onClick={() => rereadPage(selectedPage)}>
                ↻ Tekrar oku
              </button>
            )}
            <button type="button" className="action danger" onClick={remove}>
              Sil
            </button>
          </div>
        </div>
      )}

      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          void add([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <input
        ref={galleryInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          // Browsers don't keep the picking order; phone photos are named by time, so name order is shooting order.
          const files = [...(e.target.files ?? [])].sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true }),
          )
          void add(files)
          e.target.value = ''
        }}
      />
      <input
        ref={retakeInput}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file && selectedPage) void rereadPage(selectedPage, file)
          e.target.value = ''
        }}
      />
    </main>
  )
}

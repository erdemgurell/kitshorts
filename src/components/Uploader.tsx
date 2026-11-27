import { useRef, useState } from 'react'
import { loadPosition, type SavedBook } from '../lib/storage'
import type { Progress } from '../lib/extractParagraphs'

interface Props {
  onFile: (file: File) => void
  progress: Progress | null
  error: string | null
  library: SavedBook[]
  onOpen: (book: SavedBook) => void
  onDelete: (id: string) => void
}

export default function Uploader({ onFile, progress, error, library, onOpen, onDelete }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const handleFile = (file: File | undefined) => {
    if (file) onFile(file)
  }

  return (
    <main className="upload">
      <h1 className="brand">KitShorts</h1>
      <p className="tagline">PDF'ini yükle, paragraf paragraf kaydırarak oku.</p>

      <button
        type="button"
        className={`dropzone${dragging ? ' dragging' : ''}`}
        disabled={progress !== null}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          handleFile(e.dataTransfer.files[0])
        }}
      >
        {progress ? (
          <>
            <span className="dz-title">
              {progress.stage === 'ocr' ? 'Taranmış sayfalar okunuyor (OCR)…' : 'İşleniyor…'}
            </span>
            <span className="dz-sub">
              {progress.total ? `Sayfa ${progress.done} / ${progress.total}` : 'PDF açılıyor'}
            </span>
            {progress.stage === 'ocr' && progress.done === 0 && (
              <span className="dz-sub">İlk seferde Türkçe dil modeli indiriliyor, biraz sürebilir.</span>
            )}
            <span className="dz-bar">
              <span style={{ width: progress.total ? `${(progress.done / progress.total) * 100}%` : '0%' }} />
            </span>
          </>
        ) : (
          <>
            <span className="dz-title">PDF seç ya da buraya sürükle</span>
            <span className="dz-sub">Dosya cihazından çıkmaz, her şey tarayıcında işlenir.</span>
          </>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          handleFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />

      {error && <p className="error">{error}</p>}

      {library.length > 0 && !progress && (
        <section className="library">
          <h2 className="library-title">Kitaplığım</h2>
          <ul>
            {library.map((b) => {
              const pct = Math.round(((Math.min(loadPosition(b.id), b.cards.length - 1) + 1) / b.cards.length) * 100)
              return (
                <li key={b.id} className="library-item">
                  <button type="button" className="library-open" onClick={() => onOpen(b)}>
                    <span className="resume-name">{b.name}</span>
                    <span className="library-meta">
                      %{pct} · {b.cards.length} kart
                    </span>
                    <span className="library-bar">
                      <span style={{ width: `${pct}%` }} />
                    </span>
                  </button>
                  <button
                    type="button"
                    className="library-delete"
                    aria-label={`${b.name} kitabını sil`}
                    onClick={() => confirm(`"${b.name}" kitaplıktan silinsin mi?`) && onDelete(b.id)}
                  >
                    ×
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </main>
  )
}

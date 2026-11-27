import { useEffect, useRef, useState } from 'react'
import { loadPosition, savePosition, type Book } from '../lib/storage'
import type { Progress } from '../lib/extractParagraphs'

interface Props {
  book: Book
  /** Set while later pages are still being read (OCR); more cards will arrive. */
  progress: Progress | null
  onClose: () => void
}

// Only cards this close to the visible one render their text; the rest are empty snap slots.
const WINDOW = 10

export default function CardFeed({ book, progress, onClose }: Props) {
  const { cards } = book
  const feedRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<(HTMLElement | null)[]>([])
  const [current, setCurrent] = useState(() => Math.min(loadPosition(book.id), cards.length - 1))

  // Jump to the saved position once, before observing.
  useEffect(() => {
    cardRefs.current[current]?.scrollIntoView({ block: 'start' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Where keyboard navigation is heading; lets repeated key presses stack while a smooth scroll is still running.
  const target = useRef(current)
  const lastKeyNav = useRef(0)

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const i = Number((entry.target as HTMLElement).dataset.index)
          setCurrent(i)
          if (Date.now() - lastKeyNav.current > 700) target.current = i
        }
      },
      { root: feedRef.current, threshold: 0.6 },
    )
    cardRefs.current.forEach((el) => el && observer.observe(el))
    return () => observer.disconnect()
  }, [cards])

  useEffect(() => savePosition(book.id, current), [book.id, current])

  useEffect(() => {
    const go = (i: number) => {
      target.current = Math.max(0, Math.min(cards.length - 1, i))
      lastKeyNav.current = Date.now()
      cardRefs.current[target.current]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowDown', 'PageDown', 'j'].includes(e.key) || (e.key === ' ' && !e.shiftKey)) {
        e.preventDefault()
        go(target.current + 1)
      } else if (['ArrowUp', 'PageUp', 'k'].includes(e.key) || (e.key === ' ' && e.shiftKey)) {
        e.preventDefault()
        go(target.current - 1)
      } else if (e.key === 'Home') {
        e.preventDefault()
        go(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        go(cards.length - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cards.length])

  return (
    <div className="reader">
      <header className="topbar">
        <div className="progress" style={{ width: `${((current + 1) / cards.length) * 100}%` }} />
        <button type="button" className="back" onClick={onClose} aria-label="Kitaplığa dön">
          ← Kitaplık
        </button>
        <span className="book-name">
          {progress ? `Sayfalar okunuyor… ${progress.done} / ${progress.total}` : book.name}
        </span>
        <span className="counter">
          {current + 1} / {cards.length}
        </span>
      </header>

      <div className="feed" ref={feedRef}>
        {cards.map((card, i) => (
          <section
            key={i}
            className="card"
            data-index={i}
            ref={(el) => {
              cardRefs.current[i] = el
            }}
          >
            {Math.abs(i - current) <= WINDOW && (
              <article className="card-body">
                {card.title && <h2 className="card-title">{card.title}</h2>}
                {card.text && <p className="card-text">{card.text}</p>}
                <footer className="card-meta">Sayfa {card.page}</footer>
              </article>
            )}
          </section>
        ))}
        <section className="card end-card">
          {progress ? (
            <p className="loading-more">
              Sonraki sayfalar okunuyor… ({progress.done} / {progress.total})
            </p>
          ) : (
            <>
              <p>Bitti 🎉</p>
              <button type="button" className="resume" onClick={onClose}>
                Kitaplığa dön
              </button>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

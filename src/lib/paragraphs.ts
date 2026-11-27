// Turns positioned text lines (from PDF text or OCR) into readable paragraph cards.

export interface Card {
  title?: string
  text: string
  page: number
}

export interface Line {
  text: string
  x: number
  xEnd: number
  y: number
  size: number
  page: number
  pageWidth: number
  /** Read by OCR: sizes and positions are noisier than real PDF text. */
  ocr?: boolean
}

export interface Progress {
  stage: 'text' | 'ocr'
  done: number
  total: number
}

const TERMINAL = /[.!?…:;"”’»)]$/
const SHORT_MIN = 40
const LONG_MAX = 1200
const CHUNK_TARGET = 900

export function buildCards(pages: Line[][]): Card[] {
  return toCards(buildParagraphs(removeHeadersFooters(pages)))
}

/** Drops page numbers and lines repeated near the top/bottom of many pages (running headers/footers). */
function removeHeadersFooters(pages: Line[][]): Line[] {
  // Letters only: OCR reads the same running header with varying spaces, punctuation and page numbers.
  // Short keys ("Chapter 3" -> "chapter") are never treated as headers, so chapter titles survive.
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}]/gu, '')
  const isPageNumber = (s: string) => /^[-–—(\[]?\s*(\d+|[ivxlcdm]+)\s*[-–—)\]]?$/i.test(s) || /^(sayfa|page)\s+\d+/i.test(s)

  const counts = new Map<string, number>()
  for (const lines of pages) {
    const edge = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map((l) => norm(l.text)))
    edge.forEach((k) => counts.set(k, (counts.get(k) ?? 0) + 1))
  }
  // Running headers often carry the chapter name, so a few repeats are enough in a longer document.
  const threshold = pages.length < 8 ? Math.max(2, pages.length * 0.4) : 3

  const out: Line[] = []
  for (const lines of pages) {
    lines.forEach((l, i) => {
      const atEdge = i < 2 || i >= lines.length - 2
      const key = norm(l.text)
      if (atEdge && (isPageNumber(l.text) || (key.length >= 10 && key.length < 80 && (counts.get(key) ?? 0) >= threshold))) return
      out.push(l)
    })
  }
  return out
}

export function median(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

interface Paragraph {
  text: string
  size: number
  page: number
}

function buildParagraphs(lines: Line[]): Paragraph[] {
  const gaps: number[] = []
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y
    if (lines[i].page === lines[i - 1].page && gap > 0) gaps.push(gap)
  }
  const medianGap = median(gaps)
  const bodySize = median(lines.map((l) => l.size))

  // Per-page text column edges, so indentation and short lines can be judged.
  const margins = new Map<number, { left: number; right: number }>()
  for (const page of new Set(lines.map((l) => l.page))) {
    const pl = lines.filter((l) => l.page === page)
    const xs = pl.map((l) => Math.round(l.x))
    const freq = new Map<number, number>()
    xs.forEach((x) => freq.set(x, (freq.get(x) ?? 0) + 1))
    const left = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]
    margins.set(page, { left, right: percentile(pl.map((l) => l.xEnd), 0.9) })
  }

  const paragraphs: Paragraph[] = []
  let current: Paragraph | null = null
  let prev: Line | null = null

  for (const line of lines) {
    const m = margins.get(line.page)!
    const samePage = prev?.page === line.page
    const indent = line.x - m.left
    const isIndented = indent > line.size * 0.8 && indent < line.pageWidth * 0.3
    const tolerance = line.ocr ? 0.3 : 0.15
    const sizeChanged = prev ? Math.abs(line.size - prev.size) > Math.max(1.5, bodySize * tolerance) : false
    const prevEndsSentence = prev ? TERMINAL.test(prev.text) : true
    const prevShort = prev ? prev.xEnd < margins.get(prev.page)!.right - prev.size * 3 : true
    const bigGap = samePage && prev && medianGap > 0 ? prev.y - line.y > medianGap * 1.4 : false

    const startNew =
      !current ||
      sizeChanged ||
      isIndented ||
      bigGap ||
      (prevEndsSentence && prevShort) ||
      // A heading-sized line never continues onto the next one.
      (prev !== null && prev.size > bodySize * (1 + tolerance))

    if (startNew) {
      current = { text: line.text, size: line.size, page: line.page }
      paragraphs.push(current)
    } else {
      current!.text = joinLine(current!.text, line.text)
    }
    prev = line
  }
  return paragraphs
}

function joinLine(a: string, b: string): string {
  if (/\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b
  return a + ' ' + b
}

function isHeading(p: Paragraph, bodySize: number): boolean {
  return p.text.length < 120 && !TERMINAL.test(p.text) && (p.size > bodySize * 1.1 || p.text.length < 60)
}

function toCards(paragraphs: Paragraph[]): Card[] {
  const bodySize = median(paragraphs.map((p) => p.size))
  const cards: Card[] = []
  let pendingTitle: string[] = []
  let carry = ''

  for (const p of paragraphs) {
    if (isHeading(p, bodySize) && pendingTitle.length < 3) {
      if (carry) {
        cards.push({ text: carry, page: p.page })
        carry = ''
      }
      pendingTitle.push(p.text)
      continue
    }
    const text = carry ? carry + ' ' + p.text : p.text
    if (text.length < SHORT_MIN) {
      carry = text
      continue
    }
    carry = ''
    const title = pendingTitle.length ? pendingTitle.join(' · ') : undefined
    pendingTitle = []
    splitLong(text).forEach((chunk, i) => cards.push({ title: i === 0 ? title : undefined, text: chunk, page: p.page }))
  }
  if (carry || pendingTitle.length) {
    cards.push({ title: pendingTitle.join(' · ') || undefined, text: carry, page: paragraphs.at(-1)?.page ?? 1 })
  }
  return cards
}

function splitLong(text: string): string[] {
  if (text.length <= LONG_MAX) return [text]
  const sentences = text.split(/(?<=[.!?…]["”’»]?)\s+/)
  const target = Math.ceil(text.length / Math.ceil(text.length / CHUNK_TARGET))
  const chunks: string[] = []
  let buf = ''
  for (const s of sentences) {
    if (buf && buf.length + s.length + 1 > target) {
      chunks.push(buf)
      buf = s
    } else {
      buf = buf ? buf + ' ' + s : s
    }
  }
  // Don't leave a tiny tail card; fold it into the previous chunk.
  if (chunks.length && buf.length < target * 0.35) chunks[chunks.length - 1] += ' ' + buf
  else if (buf) chunks.push(buf)
  return chunks
}

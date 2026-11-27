import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { buildCards, type Card, type Line, type Progress } from './paragraphs'

GlobalWorkerOptions.workerSrc = workerUrl

export type { Card, Line, Progress }

// A page with less text than this is treated as a scanned image.
const MIN_PAGE_CHARS = 20

export interface ExtractOptions {
  onProgress?: (p: Progress) => void
  /** Called with the cards read so far while scanned pages are still being OCR'd. */
  onPartial?: (cards: Card[]) => void
  signal?: AbortSignal
}

// While OCR runs, publish updated cards after every this many newly finished pages.
const PARTIAL_EVERY = 3

export async function extractCards(data: ArrayBuffer, { onProgress, onPartial, signal }: ExtractOptions = {}): Promise<Card[]> {
  const assets = `${import.meta.env.BASE_URL}pdfjs/`
  const task = getDocument({
    data,
    // Decoders for JBIG2/JPEG2000 images, which most scanned books use.
    wasmUrl: `${assets}wasm/`,
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    iccUrl: `${assets}iccs/`,
  })
  const pdf = await task.promise
  // null marks a scanned page whose OCR hasn't finished yet.
  const pages: (Line[] | null)[] = []
  const scanned: number[] = []
  try {
    for (let p = 1; p <= pdf.numPages && !signal?.aborted; p++) {
      const page = await pdf.getPage(p)
      const { width } = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const items = content.items.filter((i): i is TextItem => 'str' in i && i.str.length > 0)
      const lines = groupLines(items, p, width)
      const isScanned = lines.reduce((n, l) => n + l.text.length, 0) < MIN_PAGE_CHARS
      if (isScanned) scanned.push(p)
      pages.push(isScanned ? null : lines)
      page.cleanup()
      onProgress?.({ stage: 'text', done: p, total: pdf.numPages })
    }

    if (scanned.length && !signal?.aborted) {
      const { ocrPages } = await import('./ocr')
      let done = 0
      let published = 0
      onProgress?.({ stage: 'ocr', done, total: scanned.length })
      await ocrPages(
        pdf,
        scanned,
        (p, lines) => {
          pages[p - 1] = lines
          onProgress?.({ stage: 'ocr', done: ++done, total: scanned.length })
          // Cards can only be built from an unbroken run of finished pages from the start.
          const ready = pages.findIndex((l) => l === null)
          const prefix = ready === -1 ? pages.length : ready
          if (onPartial && prefix - published >= PARTIAL_EVERY && prefix < pages.length) {
            published = prefix
            onPartial(buildCards(pages.slice(0, prefix) as Line[][]))
          }
        },
        signal,
      )
    }
  } finally {
    await task.destroy()
  }

  return buildCards(pages.map((l) => l ?? []))
}

function groupLines(items: TextItem[], page: number, pageWidth: number): Line[] {
  const sorted = [...items].sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])
  const groups: TextItem[][] = []
  for (const item of sorted) {
    const y = item.transform[5]
    const size = Math.abs(item.transform[3]) || item.height || 10
    const group = groups.find((g) => Math.abs(g[0].transform[5] - y) < size * 0.5)
    if (group) group.push(item)
    else groups.push([item])
  }

  const lines: Line[] = []
  for (const g of groups) {
    g.sort((a, b) => a.transform[4] - b.transform[4])
    let text = ''
    let lastEnd = -Infinity
    let size = 0
    for (const item of g) {
      const x = item.transform[4]
      const itemSize = Math.abs(item.transform[3]) || item.height || 10
      size = Math.max(size, itemSize)
      if (text && x - lastEnd > itemSize * 0.15 && !/\s$/.test(text) && !/^\s/.test(item.str)) text += ' '
      text += item.str
      lastEnd = x + item.width
    }
    text = text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    lines.push({
      text,
      x: g[0].transform[4],
      xEnd: lastEnd,
      y: g[0].transform[5],
      size,
      page,
      pageWidth,
    })
  }
  return lines.sort((a, b) => b.y - a.y)
}

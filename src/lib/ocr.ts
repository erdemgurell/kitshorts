import { createScheduler, createWorker, type Block } from 'tesseract.js'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { median, type Line } from './paragraphs'
import { ocrCanvas } from './imagePrep'

// Render width used for OCR; roughly 200 dpi for an A4 page.
const OCR_WIDTH = 1700
const LANGUAGES = ['tur', 'eng']

type Recognize = (canvas: HTMLCanvasElement) => Promise<Block[]>

/**
 * OCRs the given pages in order and reports each page's lines (in PDF coordinates) as it finishes.
 * The book's language is picked first by reading one sample page in every candidate language.
 */
export async function ocrPages(
  pdf: PDFDocumentProxy,
  pageNumbers: number[],
  onPage: (page: number, lines: Line[]) => void,
  signal?: AbortSignal,
): Promise<void> {
  const sample = await renderPage(pdf, pageNumbers[Math.floor(pageNumbers.length / 2)])
  const lang = await detectLanguage(sample.canvas)
  if (signal?.aborted) return

  await runPool(lang, pageNumbers.length, signal, async (i, recognize) => {
    const p = pageNumbers[i]
    // Render a page only when a worker is about to take it, so canvases don't pile up in memory.
    const { canvas, scale, height, width } = await renderPage(pdf, p)
    const blocks = await recognize(canvas)
    canvas.width = canvas.height = 0
    if (signal?.aborted) return
    onPage(p, toLines(blocks, p, scale, width, height))
  })
}

export interface ImageOcrHandlers {
  /** The language was detected (only called when none was given). */
  onLanguage?: (lang: string) => void
  onStart?: (key: string) => void
  onPage: (key: string, lines: Line[]) => void | Promise<void>
  onError?: (key: string, error: unknown) => void | Promise<void>
}

/**
 * OCRs page photos. Lines come back in a per-page coordinate system scaled so body text is about
 * 10 units tall, since photos taken from varying distances would otherwise look like font changes.
 */
export async function ocrImages(
  images: { key: string; blob: Blob }[],
  lang: string | undefined,
  handlers: ImageOcrHandlers,
  signal?: AbortSignal,
): Promise<void> {
  if (!images.length) return
  if (!lang) {
    const canvas = await ocrCanvas(images[0].blob)
    lang = await detectLanguage(canvas)
    canvas.width = canvas.height = 0
    if (signal?.aborted) return
    handlers.onLanguage?.(lang)
  }

  await runPool(lang, images.length, signal, async (i, recognize) => {
    const { key, blob } = images[i]
    handlers.onStart?.(key)
    try {
      const canvas = await ocrCanvas(blob)
      const { width, height } = canvas
      const blocks = await recognize(canvas)
      canvas.width = canvas.height = 0
      if (signal?.aborted) return
      await handlers.onPage(key, normalizeSize(toLines(blocks, 0, 1, width, height)))
    } catch (e) {
      if (signal?.aborted) return
      console.error(e)
      await handlers.onError?.(key, e)
    }
  })
}

/** Runs `job(0..count-1)` on a pool of Tesseract workers, each job taking the next free index. */
async function runPool(
  lang: string,
  count: number,
  signal: AbortSignal | undefined,
  job: (index: number, recognize: Recognize) => Promise<void>,
): Promise<void> {
  const scheduler = createScheduler()
  const workerCount = Math.max(1, Math.min(count, 4, Math.floor((navigator.hardwareConcurrency || 2) / 2)))
  const recognize: Recognize = async (canvas) =>
    (await scheduler.addJob('recognize', canvas, {}, { blocks: true })).data.blocks ?? []
  try {
    await Promise.all(Array.from({ length: workerCount }, async () => scheduler.addWorker(await createWorker(lang))))
    let next = 0
    const run = async () => {
      while (next < count && !signal?.aborted) await job(next++, recognize)
    }
    await Promise.all(Array.from({ length: workerCount }, run))
  } finally {
    await scheduler.terminate()
  }
}

async function detectLanguage(sample: HTMLCanvasElement): Promise<string> {
  const worker = await createWorker(LANGUAGES[0])
  let best = { lang: LANGUAGES[0], confidence: -1 }
  try {
    for (const lang of LANGUAGES) {
      if (lang !== LANGUAGES[0]) await worker.reinitialize(lang)
      const { data } = await worker.recognize(sample)
      if (data.confidence > best.confidence) best = { lang, confidence: data.confidence }
    }
  } finally {
    await worker.terminate()
  }
  return best.lang
}

async function renderPage(pdf: PDFDocumentProxy, p: number) {
  const page = await pdf.getPage(p)
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(4, OCR_WIDTH / base.width)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  // 'print' renders without requestAnimationFrame, which stalls while the tab is in the background.
  await page.render({ canvas, viewport, intent: 'print' }).promise
  page.cleanup()
  return { canvas, scale, width: base.width, height: base.height }
}

function toLines(blocks: Block[], page: number, scale: number, pageWidth: number, pageHeight: number): Line[] {
  const lines: Line[] = []
  for (const block of blocks) {
    for (const para of block.paragraphs) {
      for (const l of para.lines) {
        const text = l.text.replace(/\s+/g, ' ').trim()
        if (!text || isNoise(text, l.confidence)) continue
        const height = l.rowAttributes?.rowHeight || l.bbox.y1 - l.bbox.y0
        lines.push({
          text,
          x: l.bbox.x0 / scale,
          xEnd: l.bbox.x1 / scale,
          y: pageHeight - (l.baseline?.y0 ?? l.bbox.y1) / scale,
          size: height / scale,
          page,
          pageWidth,
          ocr: true,
        })
      }
    }
  }
  return lines.sort((a, b) => b.y - a.y)
}

const BODY_SIZE = 10

function normalizeSize(lines: Line[]): Line[] {
  const body = median(lines.map((l) => l.size))
  if (!body) return lines
  const f = BODY_SIZE / body
  return lines.map((l) => ({ ...l, x: l.x * f, xEnd: l.xEnd * f, y: l.y * f, size: l.size * f, pageWidth: l.pageWidth * f }))
}

/** Text Tesseract "reads" off pictures, specks and page edges: low confidence, few real letters. */
function isNoise(text: string, confidence: number): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0
  if (confidence < 45) return true
  if (confidence < 70 && letters / text.length < 0.6) return true
  return letters < 2 && !/^\d+$/.test(text)
}

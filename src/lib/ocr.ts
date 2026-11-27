import { createScheduler, createWorker as createTesseractWorker, OEM, type Block } from 'tesseract.js'
import { Capacitor } from '@capacitor/core'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { median, type Line } from './paragraphs'
import { ocrCanvas } from './imagePrep'

// Render width used for OCR; roughly 200 dpi for an A4 page.
const OCR_WIDTH = 1700

type Recognize = (canvas: HTMLCanvasElement) => Promise<Block[]>

// Bundled copies (see vite.config.ts); absolute because the worker runs from a blob: URL.
const assets = new URL(`${import.meta.env.BASE_URL}tesseract/`, location.href).href
// Tesseract only reports some startup failures (e.g. language data that can't be loaded) to
// errorHandler and never settles its promise; turn those into a rejection instead of hanging.
const createWorker = (lang: string) =>
  new Promise<Awaited<ReturnType<typeof createTesseractWorker>>>((resolve, reject) => {
    createTesseractWorker(lang, OEM.LSTM_ONLY, {
      workerPath: `${assets}worker.min.js`,
      corePath: `${assets}core`,
      langPath: `${assets}lang`,
      // The bundled language files are stored unpacked (see vite.config.ts).
      gzip: false,
      errorHandler: (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))),
    }).then(resolve, reject)
  })

/**
 * OCRs the given pages in order and reports each page's lines (in PDF coordinates) as it finishes.
 * The book's language is picked first from one sample page (see detectLanguage).
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
  // Phones run out of memory with many workers each holding a page image and the model.
  const maxWorkers = Capacitor.isNativePlatform() ? 2 : 4
  const workerCount = Math.max(1, Math.min(count, maxWorkers, Math.floor((navigator.hardwareConcurrency || 2) / 2)))
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

// Reading the sample doesn't need full resolution; a smaller one keeps this quick on phones.
const DETECT_MAX = 1200

/**
 * Reads a sample page with the Turkish model and keeps Turkish unless the page is clearly English.
 * (Comparing the two models' confidences doesn't work: the English model is often *more* confident
 * on Turkish text, reading "şey" as "sey" and "ığ" as garbage, which ruined whole books.)
 */
async function detectLanguage(page: HTMLCanvasElement): Promise<string> {
  const scale = Math.min(1, DETECT_MAX / Math.max(page.width, page.height))
  const sample = document.createElement('canvas')
  sample.width = Math.round(page.width * scale)
  sample.height = Math.round(page.height * scale)
  sample.getContext('2d')!.drawImage(page, 0, 0, sample.width, sample.height)
  const worker = await createWorker('tur')
  try {
    const { data } = await worker.recognize(sample)
    return guessLanguage(data.text)
  } finally {
    await worker.terminate()
    sample.width = sample.height = 0
  }
}

const TURKISH_WORDS = new Set(['ve', 'bir', 'bu', 'da', 'de', 'için', 'ile', 'ne', 'çok', 'gibi', 'daha', 'o', 'ama', 'ki'])
const ENGLISH_WORDS = new Set(['the', 'and', 'of', 'to', 'is', 'in', 'that', 'it', 'was', 'for', 'with', 'he', 'she', 'you'])

/** 'eng' only for text with almost no Turkish letters and mostly English function words. */
export function guessLanguage(text: string): 'tur' | 'eng' {
  const letters = text.match(/\p{L}/gu)?.length ?? 0
  const turkishLetters = text.match(/[çğıöşüÇĞİÖŞÜ]/g)?.length ?? 0
  // Turkish prose has roughly 8% of these; a stray misread on an English page stays far below 1%.
  if (!letters || turkishLetters / letters >= 0.01) return 'tur'
  const words = text.toLocaleLowerCase('tr').match(/\p{L}+/gu) ?? []
  const eng = words.filter((w) => ENGLISH_WORDS.has(w)).length
  const tur = words.filter((w) => TURKISH_WORDS.has(w)).length
  return eng >= 3 && eng > tur * 2 ? 'eng' : 'tur'
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

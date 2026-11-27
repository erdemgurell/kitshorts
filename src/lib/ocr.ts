import { createScheduler, createWorker, type Block } from 'tesseract.js'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Line } from './extractParagraphs'

// Render width used for OCR; roughly 200 dpi for an A4 page.
const OCR_WIDTH = 1700
const LANGUAGES = ['tur', 'eng']

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
  const lang = await detectLanguage(pdf, pageNumbers[Math.floor(pageNumbers.length / 2)])
  if (signal?.aborted) return

  const scheduler = createScheduler()
  const workerCount = Math.max(1, Math.min(pageNumbers.length, 4, Math.floor((navigator.hardwareConcurrency || 2) / 2)))
  try {
    await Promise.all(Array.from({ length: workerCount }, async () => scheduler.addWorker(await createWorker(lang))))

    let next = 0
    // Render a page only when a worker is about to take it, so canvases don't pile up in memory.
    const run = async () => {
      while (next < pageNumbers.length && !signal?.aborted) {
        const p = pageNumbers[next++]
        const { canvas, scale, height, width } = await renderPage(pdf, p)
        const { data } = await scheduler.addJob('recognize', canvas, {}, { blocks: true })
        canvas.width = canvas.height = 0
        if (signal?.aborted) return
        onPage(p, toLines(data.blocks ?? [], p, scale, width, height))
      }
    }
    await Promise.all(Array.from({ length: workerCount }, run))
  } finally {
    await scheduler.terminate()
  }
}

async function detectLanguage(pdf: PDFDocumentProxy, sample: number): Promise<string> {
  const { canvas } = await renderPage(pdf, sample)
  const worker = await createWorker(LANGUAGES[0])
  let best = { lang: LANGUAGES[0], confidence: -1 }
  try {
    for (const lang of LANGUAGES) {
      if (lang !== LANGUAGES[0]) await worker.reinitialize(lang)
      const { data } = await worker.recognize(canvas)
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

/** Text Tesseract "reads" off pictures, specks and page edges: low confidence, few real letters. */
function isNoise(text: string, confidence: number): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0
  if (confidence < 45) return true
  if (confidence < 70 && letters / text.length < 0.6) return true
  return letters < 2 && !/^\d+$/.test(text)
}

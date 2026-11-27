// Resizing and cleanup of page photos, for storage and for OCR.

/** Longest side of the stored page photo; enough for OCR of a phone-photographed book page. */
const STORE_MAX = 2000
const THUMB_MAX = 240

async function decode(blob: Blob): Promise<ImageBitmap> {
  // 'from-image' applies the EXIF rotation phones write instead of rotating the pixels.
  return createImageBitmap(blob, { imageOrientation: 'from-image' })
}

function draw(source: CanvasImageSource & { width: number; height: number }, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(source.width * scale)
  canvas.height = Math.round(source.height * scale)
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', quality),
  )
}

/** Turns a camera/gallery photo into the JPEG kept for the page plus a small thumbnail. */
export async function preparePage(photo: Blob): Promise<{ image: Blob; thumb: Blob }> {
  const bitmap = await decode(photo)
  try {
    const full = draw(bitmap, STORE_MAX)
    const thumb = draw(full, THUMB_MAX)
    const result = { image: await toBlob(full, 0.82), thumb: await toBlob(thumb, 0.7) }
    full.width = full.height = thumb.width = thumb.height = 0
    return result
  } finally {
    bitmap.close()
  }
}

/**
 * The stored page photo as a grayscale canvas with its contrast stretched, which helps Tesseract
 * with the dim, uneven light of photos (paper reads grey, ink reads dark grey).
 */
export async function ocrCanvas(image: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await decode(image)
  const canvas = draw(bitmap, STORE_MAX)
  bitmap.close()
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = img.data

  const hist = new Uint32Array(256)
  for (let i = 0; i < d.length; i += 4) {
    const y = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8
    d[i] = y
    hist[y]++
  }
  // Stretch the 1st..99th percentile of brightness to the full range.
  const n = d.length / 4
  let lo = 0
  let hi = 255
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < n * 0.01; lo++);
  for (let acc = 0; hi > 0 && (acc += hist[hi]) < n * 0.01; hi--);
  const range = Math.max(1, hi - lo)
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / range))
    d[i] = d[i + 1] = d[i + 2] = v
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

// Native camera and gallery access (Android app). The web build uses <input type="file"> instead.
import { Capacitor } from '@capacitor/core'
import { Camera } from '@capacitor/camera'

export const hasNativeCamera = () => Capacitor.isNativePlatform()

const PHOTO = { quality: 85, correctOrientation: true }

async function fetchBlob(webPath: string | undefined): Promise<Blob | null> {
  if (!webPath) return null
  return (await fetch(webPath)).blob()
}

/** Opens the camera for one photo; null if the user backs out. */
export async function takePhoto(): Promise<Blob | null> {
  try {
    const photo = await Camera.takePhoto({ ...PHOTO, saveToGallery: false })
    return await fetchBlob(photo.webPath)
  } catch {
    // Cancelling the camera rejects.
    return null
  }
}

/**
 * Serial shooting: reopens the camera after every photo until the user backs out of it,
 * handing each photo to `onPhoto` (awaited, so pages are saved in shooting order).
 */
export async function takePhotos(onPhoto: (photo: Blob) => Promise<void>): Promise<void> {
  for (;;) {
    const photo = await takePhoto()
    if (!photo) return
    await onPhoto(photo)
  }
}

const LAST_BOOK = 'kitshorts:cameraBook'

/** Remembers which book the camera/gallery was opened for, in case Android kills the app while it is open. */
export function rememberCameraBook(bookId: string): void {
  try {
    localStorage.setItem(LAST_BOOK, bookId)
  } catch {
    // recovery just won't know the book
  }
}

/**
 * Photos from a camera/gallery call whose result arrived after Android restarted the app
 * (the App plugin's 'appRestoredResult' event), with the book they were taken for.
 */
export async function restoredPhotos(event: {
  pluginId: string
  methodName: string
  success: boolean
  data?: { webPath?: string; results?: { webPath?: string }[] }
}): Promise<{ bookId: string; photos: Blob[] } | null> {
  const bookId = localStorage.getItem(LAST_BOOK)
  if (event.pluginId !== 'Camera' || !event.success || !event.data || !bookId) return null
  const paths = event.methodName === 'chooseFromGallery' ? (event.data.results ?? []).map((r) => r.webPath) : [event.data.webPath]
  const photos = (await Promise.all(paths.map((p) => fetchBlob(p).catch(() => null)))).filter((b): b is Blob => b !== null)
  return photos.length ? { bookId, photos } : null
}

/** Multi-select from the gallery, in the order the user picked them. */
export async function pickPhotos(): Promise<Blob[]> {
  try {
    const { results } = await Camera.chooseFromGallery({ ...PHOTO, allowMultipleSelection: true })
    const blobs = await Promise.all(results.map((r) => fetchBlob(r.webPath)))
    return blobs.filter((b): b is Blob => b !== null)
  } catch {
    return []
  }
}

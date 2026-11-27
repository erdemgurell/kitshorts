import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { gunzipSync } from 'node:zlib'

// pdf.js loads these at runtime by directory URL (image decoders for scanned PDFs, CMaps, fonts),
// so they are served as-is under /pdfjs/ instead of going through the bundler.
const pdfjsAssets = ['wasm', 'cmaps', 'standard_fonts', 'iccs']

// Tesseract's worker, WASM engine (one per CPU feature level; it picks at runtime) and the
// Turkish/English recognition data ship with the app, so OCR never downloads anything.
const tesseractAssets = [
  { src: 'node_modules/tesseract.js/dist/worker.min.js', dest: 'tesseract' },
  { src: 'node_modules/tesseract.js-core/tesseract-core-*lstm.wasm.js', dest: 'tesseract/core' },
]
// Stored unpacked: Android's asset packaging silently unzips `.gz` files and drops the extension,
// so a `.gz` name that works on the web would 404 inside the app. (The APK compresses them anyway.)
const tesseractLangs = ['tur', 'eng'].map((lang) => ({
  src: `node_modules/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`,
  dest: 'tesseract/lang',
  rename: { stripBase: true as const, name: `${lang}.traineddata` },
  transform: { encoding: 'buffer' as const, handler: (content: Buffer) => gunzipSync(content) },
}))

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        ...pdfjsAssets.map((dir) => ({
          src: `node_modules/pdfjs-dist/${dir}/*`,
          dest: `pdfjs/${dir}`,
          rename: { stripBase: true },
        })),
        ...tesseractAssets.map((t) => ({ ...t, rename: { stripBase: true } })),
        ...tesseractLangs,
      ],
    }),
  ],
})

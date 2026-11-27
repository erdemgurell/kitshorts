import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// pdf.js loads these at runtime by directory URL (image decoders for scanned PDFs, CMaps, fonts),
// so they are served as-is under /pdfjs/ instead of going through the bundler.
const pdfjsAssets = ['wasm', 'cmaps', 'standard_fonts', 'iccs']

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: pdfjsAssets.map((dir) => ({
        src: `node_modules/pdfjs-dist/${dir}/*`,
        dest: `pdfjs/${dir}`,
        rename: { stripBase: true },
      })),
    }),
  ],
})

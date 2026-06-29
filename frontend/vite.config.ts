import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Pre-bundle the grapher libs so the first dynamic import doesn't trigger a
  // dep re-optimization + full page reload (which would close the grapher modal).
  optimizeDeps: {
    // MathJax is loaded as a prebuilt bundle via a <script> tag (?url), so it is
    // intentionally NOT pre-bundled here.
    include: ['plotly.js-dist-min', 'mathjs'],
  },
})

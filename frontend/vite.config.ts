import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Pre-bundle the grapher libs so the first dynamic import doesn't trigger a
  // dep re-optimization + full page reload (which would close the grapher modal).
  optimizeDeps: {
    include: ['plotly.js-dist-min', 'mathjs'],
  },
})

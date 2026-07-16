import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative base so the built SPA works whether it's served at the site root
  // (standalone, no reverse proxy) OR under a stripped path prefix like /rdpm/
  // (behind a reverse proxy). Assets resolve relative to index.html either way.
  base: './',
})

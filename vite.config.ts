import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split heavy research UI and SSE timeline rendering into their own
        // chunks so the initial load doesn't block on them. The main entry
        // (App + settings + idle state) stays small for fast first paint.
        manualChunks(id) {
          if (id.includes('src/components/research-chat')) return 'research'
          if (id.includes('node_modules/streamdown')) return 'streamdown'
        },
      },
    },
  },
})

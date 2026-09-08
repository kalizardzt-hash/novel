import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.NOVEL_PORT ?? 4317}` },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (/@tiptap|prosemirror/.test(id)) return 'editor';
            if (/@xyflow|d3-/.test(id)) return 'graph';
            if (/zod/.test(id)) return 'validation';
            return 'vendor';
          }
        },
      },
    },
  },
});

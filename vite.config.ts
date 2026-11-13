import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': `http://localhost:${apiPort}` } },
  build: { outDir: 'dist' },
});

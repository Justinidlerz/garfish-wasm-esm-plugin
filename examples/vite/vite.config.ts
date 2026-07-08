import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const exampleRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root: exampleRoot,
  resolve: {
    alias: {
      'garfish-wasm-esm-plugin': fileURLToPath(
        new URL('../../src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5174,
    fs: {
      allow: [repoRoot],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        host: fileURLToPath(new URL('./index.html', import.meta.url)),
        subapp: fileURLToPath(new URL('./subapp.html', import.meta.url)),
      },
    },
  },
});

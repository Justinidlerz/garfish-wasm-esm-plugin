import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import { garfishPrecompile } from '../../src/vite';

const exampleRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root: exampleRoot,
  plugins: [
    garfishPrecompile({
      copyAssets: false,
      htmlEntries: ['subapp.html'],
      wasm: new Uint8Array(
        readFileSync(
          fileURLToPath(
            new URL('../../pkg/garfish_wasm_esm_plugin_bg.wasm', import.meta.url),
          ),
        ),
      ),
    }),
  ],
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

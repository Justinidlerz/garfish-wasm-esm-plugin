import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { browserBenchmarkFixtures } from "./fixtures";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    browserBenchmarkFixtures(
      new Uint8Array(
        readFileSync(
          new URL("../../pkg/garfish_wasm_esm_plugin_bg.wasm", import.meta.url)
        )
      )
    ),
  ],
  build: {
    outDir: fileURLToPath(
      new URL("../../log/browser-benchmark/dist", import.meta.url)
    ),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        trial: fileURLToPath(new URL("./trial.html", import.meta.url)),
      },
    },
  },
});

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(
  new URL("../../log/browser-benchmark/dist/", import.meta.url)
);
const port = Number(process.env.ESM_BROWSER_BENCHMARK_PORT || 5176);
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
};
await readFile(resolve(root, "manifest.json"));
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const path = resolve(
      root,
      "." +
        decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)
    );
    if (!path.startsWith(resolve(root) + sep)) {
      res.writeHead(403).end();
      return;
    }
    const data = await readFile(path);
    res.writeHead(200, {
      "Content-Type": mime[extname(path)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    res.end(data);
  } catch (error) {
    res
      .writeHead(error.code === "ENOENT" ? 404 : 500)
      .end("Benchmark asset unavailable");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Browser ESM execution benchmark: http://127.0.0.1:${port}/`);
});

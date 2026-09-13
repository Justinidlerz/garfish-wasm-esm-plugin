import { Runtime } from "../../src/runtime-entry";
import type { Manifest, Mode, TrialResult } from "./types";

const query = new URLSearchParams(location.search);
const mode = query.get("mode") as Mode;
const fixtureId = query.get("fixture");
const token = query.get("token");
let hidden = document.visibilityState !== "visible";
document.addEventListener("visibilitychange", () => {
  hidden ||= document.visibilityState !== "visible";
});
const errors: string[] = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) =>
  errors.push(String(event.reason))
);

async function run(): Promise<TrialResult> {
  if (!["native", "precompiled"].includes(mode))
    throw new Error("Invalid mode");
  const response = await fetch("./manifest.json");
  if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
  const manifest: Manifest = await response.json();
  const fixture = manifest.fixtures.find((item) => item.id === fixtureId);
  if (!fixture) throw new Error("Unknown fixture");
  const preparedAt = performance.now();
  const sourceUrl = new URL(
    `./fixtures/${mode}/${fixture.id}.js`,
    location.href
  ).href;
  const resource = await fetch(sourceUrl);
  if (!resource.ok) throw new Error(`Fixture HTTP ${resource.status}`);
  const code = await resource.text();
  const bytes = new TextEncoder().encode(code);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  const expectedHash =
    mode === "native" ? fixture.sourceHash : fixture.artifactHash;
  if (hash !== expectedHash)
    throw new Error("Fixture does not match this build");

  // Both inputs are already in memory. A new Blob URL avoids native module-map
  // hits; a new Runtime avoids instance/graph caches on the precompiled path.
  const blobUrl =
    mode === "native"
      ? URL.createObjectURL(new Blob([code], { type: "text/javascript" }))
      : undefined;
  const runtime =
    mode === "precompiled"
      ? new Runtime({
          scope: "browser-benchmark",
          runtimeCompile: false,
          compileCache: false,
        })
      : undefined;
  const prepareMs = performance.now() - preparedAt;
  let module: Record<string, any>;
  let endedAt: number;
  const startedAt = performance.now();
  try {
    module =
      mode === "native"
        ? await import(/* @vite-ignore */ blobUrl!)
        : (await runtime!.importByCode(code, sourceUrl))!;
    endedAt = performance.now();
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }
  performance.measure("module-benchmark:import-ready", {
    start: startedAt,
    end: endedAt,
  });

  const revisionBefore = module.revision;
  module.bump();
  const resources = performance
    .getEntriesByType("resource")
    .map((entry) => entry.toJSON());
  const checks = {
    checksum: module.checksum === fixture.expectedChecksum,
    defaultExport: module.default.checksum === fixture.expectedChecksum,
    data:
      module.rowCount === fixture.rows &&
      module.groupCount === fixture.expectedGroups,
    exports: Object.keys(module).length === fixture.expectedExports,
    callResult: module.run(1) === fixture.expectedSingleRound,
    liveBinding:
      revisionBefore === 0 &&
      module.revision === 1 &&
      module.select0() === fixture.expectedFirst + 1,
    executedOnce: (globalThis as any).__moduleBenchmarkExecutions === 1,
    foreground: !hidden && document.visibilityState === "visible",
    noRuntimeWasm: !resources.some((entry) =>
      new URL(entry.name).pathname.endsWith(".wasm")
    ),
    noErrors: errors.length === 0,
    timing:
      Number.isFinite(module.bodyMs) &&
      module.bodyMs >= 0 &&
      endedAt >= startedAt,
  };
  if (Object.values(checks).some((value) => !value))
    throw new Error(`Invalid trial: ${JSON.stringify({ checks, errors })}`);
  return {
    mode,
    fixture: fixture.id,
    buildId: manifest.buildId,
    importReadyMs: endedAt - startedAt,
    importStartedAt: startedAt,
    importEndedAt: endedAt,
    bodyMs: module.bodyMs,
    prepareMs,
    checksum: module.checksum,
    bytes: bytes.byteLength,
    userAgent: navigator.userAgent,
    crossOriginIsolated,
    visibility: document.visibilityState,
    checks,
    resources,
  };
}

void run()
  .then((result) => {
    document.querySelector("#status")!.textContent = `${result.mode} · ${
      result.fixture
    } · ${result.importReadyMs.toFixed(3)} ms`;
    parent.postMessage(
      { type: "esm-execution-result", token, result },
      location.origin
    );
  })
  .catch((error) => {
    const message = String(error?.stack || error);
    document.querySelector("#status")!.textContent = message;
    parent.postMessage(
      { type: "esm-execution-error", token, message },
      location.origin
    );
  });

import "../../examples/vite/src/performance.css";
import "./style.css";
import { summarize } from "./summary.mjs";
import type { Manifest, Mode, Suite, TrialResult } from "./types";

const progress = document.querySelector("#progress")!;
const runButton = document.querySelector<HTMLButtonElement>("#run")!;
const downloadButton = document.querySelector<HTMLButtonElement>("#download")!;
const fixtureSelect = document.querySelector<HTMLSelectElement>("#fixture")!;
let manifest: Manifest;
let running = false;
let suite: Suite | undefined;
const api = {
  runSuite,
  get suite() {
    return suite;
  },
  get running() {
    return running;
  },
};
(window as any).esmExecutionBenchmark = api;

function render() {
  const report = summarize(suite);
  const body = document.querySelector("#results")!;
  body.replaceChildren();
  const ms = (n: number) => n.toFixed(3);
  for (const group of report) {
    const row = document.createElement("tr");
    const values = [
      `${group.fixture} / ${group.pairs}`,
      `${ms(group.native.importReadyMs.median)} / ${ms(
        group.native.importReadyMs.p75
      )}`,
      `${ms(group.precompiled.importReadyMs.median)} / ${ms(
        group.precompiled.importReadyMs.p75
      )}`,
      group.ratio === null
        ? "Below timer resolution"
        : `${group.ratio.toFixed(2)}×`,
      `${group.pairedOverheadMs.median >= 0 ? "+" : ""}${ms(
        group.pairedOverheadMs.median
      )}`,
      `${ms(group.native.bodyMs.median)} / ${ms(
        group.precompiled.bodyMs.median
      )}`,
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    }
    body.appendChild(row);
  }
}

function trial(fixture: string, mode: Mode): Promise<TrialResult> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.title = `${fixture} · ${mode}`;
    const token = crypto.randomUUID();
    const finish = (error?: Error, result?: TrialResult) => {
      clearTimeout(timer);
      window.removeEventListener("message", listener);
      frame.remove();
      error ? reject(error) : resolve(result!);
    };
    const listener = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== frame.contentWindow ||
        event.data?.token !== token
      )
        return;
      if (event.data.type === "esm-execution-result")
        finish(undefined, event.data.result);
      if (event.data.type === "esm-execution-error")
        finish(new Error(event.data.message));
    };
    const timer = setTimeout(
      () => finish(new Error("Trial timed out after 30 seconds")),
      30000
    );
    window.addEventListener("message", listener);
    frame.src = `./trial.html?${new URLSearchParams({ fixture, mode, token })}`;
    document.querySelector("#frame-host")!.replaceChildren(frame);
  });
}

async function runSuite({
  fixtures = manifest?.fixtures.map((f) => f.id) || [],
  pairs = 20,
  warmups = 2,
  condition = "No external throttling",
} = {}) {
  if (running) throw new Error("A suite is already running");
  if (
    !manifest ||
    !Number.isInteger(pairs) ||
    pairs < 1 ||
    pairs > 100 ||
    !Number.isInteger(warmups) ||
    warmups < 1 ||
    warmups > 10 ||
    !fixtures.length ||
    new Set(fixtures).size !== fixtures.length ||
    fixtures.some((id) => !manifest.fixtures.some((f) => f.id === id))
  )
    throw new Error("Invalid suite configuration");
  if (document.visibilityState !== "visible")
    throw new Error("Keep the benchmark tab in the foreground");
  suite = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    manifest,
    config: { fixtures, pairs, warmups, condition },
    samples: [],
    failures: [],
    completed: false,
  };
  running = true;
  runButton.disabled = true;
  downloadButton.disabled = true;
  document.querySelector("#results")!.replaceChildren();
  try {
    for (const fixture of fixtures) {
      for (let pair = -warmups; pair < pairs; pair++) {
        const modes: Mode[] =
          pair % 2 === 0
            ? ["native", "precompiled"]
            : ["precompiled", "native"];
        for (const mode of modes) {
          progress.textContent = `${fixture} · ${mode} · ${
            pair < 0
              ? `warmup ${pair + warmups + 1}/${warmups}`
              : `pair ${pair + 1}/${pairs}`
          }`;
          try {
            const result = await trial(fixture, mode);
            if (result.fixture !== fixture || result.mode !== mode)
              throw new Error("Trial identity mismatch");
            suite.samples.push({ ...result, pair, warmup: pair < 0 });
          } catch (error) {
            suite.failures.push({
              fixture,
              mode,
              pair,
              message: String(error),
            });
            throw error;
          }
        }
      }
    }
    suite.completed = true;
    render();
    progress.textContent = `Complete · ${
      fixtures.length * pairs * 2
    } measured samples · all correctness checks passed`;
    return suite;
  } catch (error) {
    suite.completed = false;
    progress.textContent = `Stopped: ${String(
      error
    )}. Partial results can be exported; no performance summary is reported.`;
    throw error;
  } finally {
    running = false;
    runButton.disabled = false;
    downloadButton.disabled = false;
  }
}

runButton.onclick = () => {
  void runSuite({
    fixtures:
      fixtureSelect.value === "all"
        ? manifest.fixtures.map((f) => f.id)
        : [fixtureSelect.value],
    pairs: Number(document.querySelector<HTMLInputElement>("#pairs")!.value),
    condition: document.querySelector<HTMLInputElement>("#condition")!.value,
  }).catch((error) => {
    progress.textContent = String(error);
  });
};
downloadButton.onclick = () => {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(
    new Blob([JSON.stringify(suite, null, 2)], { type: "application/json" })
  );
  link.download = `esm-browser-benchmark-${suite!.id}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
};

void fetch("./manifest.json")
  .then(async (response) => {
    if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
    manifest = await response.json();
    for (const fixture of manifest.fixtures) {
      fixtureSelect.add(new Option(fixture.id, fixture.id));
    }
    document.querySelector("#build")!.textContent = `Plugin ${
      manifest.packageVersion
    } · build ${manifest.buildId.slice(0, 12)} · ${
      crossOriginIsolated
        ? "isolated timer environment"
        : "standard timer environment"
    }`;
    document.querySelector("#workloads")!.textContent = manifest.fixtures
      .map(
        (f) =>
          `${f.id}: ${f.rows} rows, ${f.functions} selector functions, ${
            f.rounds
          } aggregation rounds; native ${(f.nativeBytes / 1024).toFixed(
            1
          )} KiB / precompiled ${(f.precompiledBytes / 1024).toFixed(1)} KiB`
      )
      .join(". ");
    progress.textContent =
      "Ready. Keep this tab visible while the comparison runs.";
    runButton.disabled = false;
  })
  .catch((error) => {
    progress.textContent = String(error);
  });

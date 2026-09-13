import './performance.css';
const results: any[] = [];
const progress = document.querySelector('#progress')!;
const button = document.querySelector<HTMLButtonElement>('#run')!;
const download = document.querySelector<HTMLButtonElement>('#download')!;
const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  return (
    sorted[Math.floor(index)] +
    (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index % 1)
  );
};
function render() {
  const rows = new Map<string, any[]>();
  results
    .filter((r) => !r.warmup)
    .forEach((r) => {
      const key = JSON.stringify([r.condition, r.profile, r.mode]);
      rows.set(key, [...(rows.get(key) || []), r]);
    });
  const body = document.querySelector('#results')!;
  body.replaceChildren();
  for (const rs of rows.values()) {
    const row = document.createElement('tr');
    const values = [
      rs[0].condition || 'unspecified',
      rs[0].profile,
      rs[0].mode,
      rs.length,
      `${quantile(
        rs.map((r) => r.graphMs),
        0.5,
      ).toFixed(1)} ms`,
      `${quantile(
        rs.map((r) => r.appReadyMs),
        0.5,
      ).toFixed(1)} ms`,
      `${quantile(
        rs.map((r) => r.appReadyMs),
        0.75,
      ).toFixed(1)} ms`,
    ];
    values.forEach((value) => {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      row.appendChild(cell);
    });
    body.appendChild(row);
  }
}
function trial(profile: string, mode: string, seed: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.title = `${profile} ${mode} trial`;
    const finish = (error?: Error, value?: any) => {
      clearTimeout(timer);
      window.removeEventListener('message', listener);
      iframe.remove();
      error ? reject(error) : resolve(value);
    };
    const listener = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== iframe.contentWindow
      )
        return;
      if (event.data?.type === 'esm-perf-result')
        finish(undefined, event.data.result);
      if (event.data?.type === 'esm-perf-error')
        finish(new Error(event.data.message));
    };
    const timer = setTimeout(
      () => finish(new Error('Trial exceeded 30 seconds')),
      30000,
    );
    window.addEventListener('message', listener);
    iframe.src = `/performance-run.html?profile=${profile}&mode=${mode}&seed=${seed}`;
    document.querySelector('#frame-host')!.replaceChildren(iframe);
  });
}
let running = false;
async function runSuite({
  profiles = ['mixed'],
  pairs = 8,
  condition = 'CPU 1x',
} = {}) {
  if (running) throw new Error('A suite is already running');
  if (
    !profiles.every((p) => ['mixed', 'uniform', 'local'].includes(p)) ||
    !Number.isInteger(pairs) ||
    pairs < 1 ||
    pairs > 20
  )
    throw new Error('Invalid experiment configuration');
  running = true;
  button.disabled = true;
  const suiteId = crypto.randomUUID();
  try {
    for (const profile of profiles) {
      for (let pair = -1; pair < pairs; pair++) {
        const order =
          pair % 2 === 0 ? ['batch', 'streaming'] : ['streaming', 'batch'];
        for (const mode of order) {
          progress.textContent = `${profile} · ${mode} · ${
            pair < 0 ? 'warmup (excluded)' : `pair ${pair + 1}/${pairs}`
          }`;
          const result = await trial(profile, mode, 41 + pair);
          results.push({ ...result, pair, warmup: pair < 0, condition, suiteId });
          render();
        }
      }
    }
    progress.textContent = `Completed ${
      results.filter((r) => !r.warmup).length
    } measured trials. Every correctness check passed.`;
    download.disabled = false;
    return results;
  } finally {
    running = false;
    button.disabled = false;
  }
}
button.onclick = () => {
  void runSuite({
    profiles: [(document.querySelector('#profile') as HTMLSelectElement).value],
    pairs: Number((document.querySelector('#pairs') as HTMLInputElement).value),
    condition: (document.querySelector('#condition') as HTMLInputElement).value,
  }).catch((e) => {
    progress.textContent = String(e);
  });
};
download.onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' }),
  );
  a.download = 'esm-performance-results.json';
  a.click();
  URL.revokeObjectURL(a.href);
};
(window as any).esmPerformance = { runSuite, results, render };

import Garfish from 'garfish';
import {
  GarfishEsModule,
  type RuntimeLoadEvent,
} from '../../../src/runtime-entry';
import './performance.css';

const query = new URLSearchParams(location.search);
const mode = query.get('mode') === 'streaming' ? 'streaming' : 'batch';
const profile = query.get('profile') || 'mixed';
const seed = Number(query.get('seed') || 41);
const events: RuntimeLoadEvent[] = [];
const longTasks: Array<{ startTime: number; duration: number }> = [];
const lcp: Array<{ startTime: number; size: number }> = [];
for (const [type, target] of [
  ['longtask', longTasks],
  ['largest-contentful-paint', lcp],
] as const) {
  if (PerformanceObserver.supportedEntryTypes.includes(type)) {
    new PerformanceObserver((list) =>
      target.push(
        ...list.getEntries().map((entry: any) => ({
          startTime: entry.startTime,
          duration: entry.duration,
          size: entry.size,
        })),
      ),
    ).observe({ type, buffered: true });
  }
}
const startByModule = new Map<string, number>();
const graphStarts = new Map<number, number>();
const short = (url: string) => url.split('/').pop();
Garfish.run({
  disablePreloadApp: true,
  plugins: [
    GarfishEsModule({
      runtimeCompile: false,
      dependencyScheduling: mode,
      loadObserver(event) {
        if (events.length < 10000) events.push(event);
        if (event.type === 'load-start')
          startByModule.set(event.storeId, event.timestamp);
        if (event.type === 'load-end' && startByModule.has(event.storeId)) {
          performance.measure(`esm:load:${short(event.storeId)}`, {
            start: startByModule.get(event.storeId)!,
            end: event.timestamp,
          });
        }
        if (event.type === 'graph-start')
          graphStarts.set(event.graphId!, event.timestamp);
        if (event.type === 'graph-ready')
          performance.measure('esm:graph', {
            start: graphStarts.get(event.graphId!)!,
            end: event.timestamp,
          });
        if (event.type === 'dependency-expand' && event.readyAt !== undefined) {
          performance.measure(`esm:expand-wait:${short(event.storeId)}`, {
            start: event.readyAt,
            end: event.timestamp,
          });
        }
      },
    }),
  ],
});

async function run() {
  const manifest = await fetch('/performance/manifest.json').then((r) =>
    r.json(),
  );
  let resolveReady!: (value: any) => void;
  const ready = new Promise<any>((resolve) => {
    resolveReady = resolve;
  });
  const startedAt = performance.now();
  performance.mark('esm:app-start');
  const app = await Garfish.loadApp('esm-performance-workload', {
    entry: new URL(
      `/__esm_perf__/${profile}/${seed}/subapp.html`,
      location.href,
    ).href,
    domGetter: '#trial-app',
    sandbox: { strictIsolation: false, disableLinkTransformToStyle: true },
    props: { onReady: resolveReady },
  });
  if (!app) throw new Error('Garfish did not create the workload app');
  const mounted = await app.mount();
  if (!mounted) throw new Error('Garfish workload failed to mount');
  const data = await ready;
  const readyAt = performance.now();
  performance.measure('esm:app-ready', { start: startedAt, end: readyAt });
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
  const paintedAt = performance.now();
  performance.measure('esm:app-frame', { start: startedAt, end: paintedAt });
  const mainEvents = [...events];
  const dynamicStart = performance.now();
  const lazy = await data.loadDynamic();
  const dynamicMs = performance.now() - dynamicStart;
  const expected = manifest.expectedOrder;
  const checks = {
    checksum: data.token === manifest.expectedToken,
    executionOrder: JSON.stringify(data.order) === JSON.stringify(expected),
    executedOnce:
      expected.every((id: string) => data.counts[id] === 1) &&
      Object.keys(data.counts).length === expected.length,
    liveBinding: data.before === 4 && data.after === 6,
    dynamicImport: lazy.token === manifest.lazyToken,
    concurrency: Math.max(...events.map((e) => e.activeLoads || 0)) <= 24,
  };
  const graphStart = mainEvents.find((e) => e.type === 'graph-start')!;
  const graphEnd = mainEvents.find((e) => e.type === 'graph-ready')!;
  const expansions = mainEvents
    .filter((e) => e.type === 'dependency-expand')
    .map((e) => e.timestamp - e.readyAt!);
  const resources = performance
    .getEntriesByType('resource')
    .filter((e) => e.name.includes('/__esm_perf__/'))
    .map((e) => JSON.parse(JSON.stringify(e.toJSON())));
  const result = {
    mode,
    profile,
    seed,
    userAgent: navigator.userAgent,
    startedAt,
    readyAt,
    paintedAt,
    appReadyMs: readyAt - startedAt,
    appFrameMs: paintedAt - startedAt,
    graphMs: graphEnd.timestamp - graphStart.timestamp,
    dynamicMs,
    expandWaitSumMs: expansions.reduce((a, b) => a + b, 0),
    expandWaitMaxMs: Math.max(...expansions),
    moduleCount: expected.length,
    maxActiveLoads: Math.max(...events.map((e) => e.activeLoads || 0)),
    checks,
    token: data.token,
    executionOrder: data.order,
    events,
    resources,
    longTasks,
    lcp,
    cachePolicy: 'fresh document + fixture Cache-Control:no-store',
  };
  if (Object.values(checks).some((ok) => !ok))
    throw new Error(`Workload validation failed: ${JSON.stringify(checks)}`);
  document.querySelector(
    '#trial-status',
  )!.textContent = `${mode} · ${profile} · ${Math.round(
    result.appReadyMs,
  )} ms · ${expected.length} modules · all checks passed`;
  (window as any).__esmPerfResult = result;
  parent.postMessage({ type: 'esm-perf-result', result }, location.origin);
  return result;
}
(window as any).__esmPerfDone = run().catch((error) => {
  const message = String(error?.stack || error);
  document.querySelector('#trial-status')!.textContent = message;
  (window as any).__esmPerfError = message;
  parent.postMessage({ type: 'esm-perf-error', message }, location.origin);
  throw error;
});

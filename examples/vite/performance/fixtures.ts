import type { Plugin } from 'vite';
import { compileGarfishModule } from '../../../src/compiler';
import type { WasmInitInput } from '../../../src/wasm';

// The workload is generated from a graph, not from runtime URL special cases.
// Layer widths deliberately exceed the runtime's request limit in later layers.
export function createScenario(widths = [8, 24, 24, 24, 24], sharedCount = 10) {
  const sources = new Map<string, string>();
  const edges: Record<string, string[]> = {};
  const tokens = new Map<string, number>();
  const hash = (s: string) =>
    [...s].reduce(
      (n, c) => Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0,
      2166136261,
    );
  const record = (id: string) =>
    `window.__esmWorkload ||= { order: [], counts: {} }; window.__esmWorkload.order.push(${JSON.stringify(
      id,
    )}); window.__esmWorkload.counts[${JSON.stringify(
      id,
    )}] = (window.__esmWorkload.counts[${JSON.stringify(id)}] || 0) + 1;`;
  const add = (id: string, deps: string[]) => {
    const size = 1024 + (hash(id) % 6144);
    const payload = Array.from({ length: size }, (_, i) =>
      String.fromCharCode(65 + ((hash(id) + i * 17) % 26)),
    ).join('');
    edges[id] = deps;
    tokens.set(id, size + deps.reduce((n, dep) => n + tokens.get(dep)!, 0));
    sources.set(
      id,
      `${deps
        .map((dep, i) => `import { token as t${i} } from './${dep}';`)
        .join('\n')}
${record(id)}
const payload = ${JSON.stringify(payload)};
export const token = payload.length${deps.map((_, i) => ` + t${i}`).join('')};
`,
    );
  };
  for (let i = 0; i < sharedCount; i++) add(`shared-${i}.js`, []);
  for (let depth = widths.length - 1; depth >= 0; depth--) {
    for (let i = 0; i < widths[depth]; i++) {
      const deps =
        depth + 1 < widths.length
          ? Array.from(
              { length: depth === 0 ? 3 : 2 },
              (_, j) =>
                `layer-${depth + 1}-${
                  (i * (depth === 0 ? 3 : 2) + j) % widths[depth + 1]
                }.js`,
            )
          : [];
      deps.push(`shared-${i % sharedCount}.js`);
      add(`layer-${depth}-${i}.js`, deps);
    }
  }
  edges['cycle-a.js'] = ['cycle-b.js'];
  edges['cycle-b.js'] = ['cycle-a.js'];
  sources.set(
    'cycle-a.js',
    `import { readB } from './cycle-b.js'; ${record(
      'cycle-a.js',
    )} export let counter = 1; export function bump() { counter++; } export function readCycle() { return counter + readB(); }`,
  );
  sources.set(
    'cycle-b.js',
    `import { counter } from './cycle-a.js'; ${record(
      'cycle-b.js',
    )} export function readB() { return counter + 2; }`,
  );
  const roots = Array.from({ length: widths[0] }, (_, i) => `layer-0-${i}.js`);
  edges['entry.js'] = [...roots, 'cycle-a.js'];
  const expectedToken = roots.reduce((n, id) => n + tokens.get(id)!, 0);
  sources.set(
    'entry.js',
    `${roots
      .map((id, i) => `import { token as t${i} } from './${id}';`)
      .join('\n')}
import { readCycle, bump } from './cycle-a.js';
${record('entry.js')}
const token = ${roots.map((_, i) => `t${i}`).join(' + ')};
const provider = {
  render({ dom, props }) {
    const root = dom.querySelector('#performance-root');
    const before = readCycle(); bump(); const after = readCycle();
    const section = document.createElement('section');
    section.innerHTML = '<h1 class="hero">A complete workspace,<br>ready to explore.</h1><p>Sales, inventory, analytics and shared services have loaded.</p><div class="cards"></div>';
    const cards = section.querySelector('.cards');
    for (let i = 0; i < 80; i++) {
      const card = document.createElement('article');
      card.textContent = 'Report ' + (i + 1) + ' · ' + ((token * (i + 1)) % 100000).toLocaleString();
      cards.appendChild(card);
    }
    root.replaceChildren(section);
    props.onReady({ token, before, after, order: [...window.__esmWorkload.order], counts: { ...window.__esmWorkload.counts }, loadDynamic: () => import('./lazy.js') });
  },
  destroy({ dom }) { dom.querySelector('#performance-root')?.replaceChildren(); }
};
__GARFISH_EXPORTS__.provider = provider;
export { provider };
`,
  );
  for (let i = 0; i < 6; i++) add(`lazy-${i}.js`, [`shared-${i}.js`]);
  add(
    'lazy.js',
    Array.from({ length: 6 }, (_, i) => `lazy-${i}.js`),
  );
  const expectedOrder: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    edges[id].forEach(visit);
    expectedOrder.push(id);
  };
  visit('entry.js');
  return {
    sources,
    manifest: {
      widths,
      sharedCount,
      edges,
      expectedToken,
      expectedOrder,
      staticModules: expectedOrder.length,
      totalModules: sources.size,
      lazyToken: tokens.get('lazy.js'),
    },
  };
}

export function performanceFixtures(wasm: WasmInitInput): Plugin {
  return {
    name: 'esm-performance-fixtures',
    apply: 'build',
    async generateBundle() {
      const { sources, manifest } = createScenario();
      for (const [id, source] of sources) {
        this.emitFile({
          type: 'asset',
          fileName: `performance/fixtures/${id}`,
          source: await compileGarfishModule(source, id, { wasm }),
        });
        this.emitFile({
          type: 'asset',
          fileName: `performance/source/${id}`,
          source,
        });
      }
      this.emitFile({
        type: 'asset',
        fileName: 'performance/manifest.json',
        source: JSON.stringify(manifest, null, 2),
      });
    },
  };
}

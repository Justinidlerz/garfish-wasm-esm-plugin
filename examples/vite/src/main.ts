import Garfish from 'garfish';
import { GarfishEsModule } from 'garfish-wasm-esm-plugin';
import './styles.css';

const loadButton = document.querySelector<HTMLButtonElement>('#load-app');
const unmountButton = document.querySelector<HTMLButtonElement>('#unmount-app');
const statusNode = document.querySelector<HTMLElement>('#status');
const container = document.querySelector<HTMLElement>('#subapp-container');
const metricsLog = document.querySelector<HTMLOListElement>('#metrics-log');

if (!loadButton || !unmountButton || !statusNode || !container || !metricsLog) {
  throw new Error('Example shell is missing required DOM nodes.');
}

let app: Awaited<ReturnType<typeof Garfish.loadApp>> | null = null;

const setStatus = (value: string) => {
  statusNode.textContent = value;
};

const appendMetric = (label: string) => {
  const item = document.createElement('li');
  item.textContent = label;
  metricsLog.prepend(item);
  while (metricsLog.children.length > 8) {
    metricsLog.lastElementChild?.remove();
  }
};

Garfish.run({
  disablePreloadApp: true,
  plugins: [
    GarfishEsModule({
      metrics(metric) {
        appendMetric(
          `${metric.storeId.split('/').pop()}: ${Math.round(
            metric.totalMs ?? metric.evalMs ?? 0,
          )}ms${metric.cacheHit ? ' cache' : ''}`,
        );
      },
    }),
  ],
});

loadButton.addEventListener('click', async () => {
  loadButton.disabled = true;
  setStatus('Loading module app');

  try {
    if (app?.mounted) {
      app.unmount();
    }

    container.replaceChildren();
    app = await Garfish.loadApp('vite-esm-subapp', {
      entry: new URL('./subapp.html', window.location.href).toString(),
      domGetter: () => container,
      props: {
        loadedAt: new Date().toLocaleTimeString(),
      },
    });

    await app?.mount();
    setStatus('Mounted');
    unmountButton.disabled = false;
  } catch (error) {
    setStatus((error as Error).message);
    loadButton.disabled = false;
  }
});

unmountButton.addEventListener('click', () => {
  app?.unmount();
  app = null;
  setStatus('Unmounted');
  loadButton.disabled = false;
  unmountButton.disabled = true;
});

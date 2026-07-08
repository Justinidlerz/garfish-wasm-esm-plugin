import { accentColor, createMessage } from './sub-dependency';

declare const __GARFISH_EXPORTS__: {
  provider?: Provider;
};

interface ProviderRenderParams {
  dom: Element | ShadowRoot | Document;
  props?: {
    loadedAt?: string;
  };
}

interface Provider {
  render(params: ProviderRenderParams): void;
  destroy(params: ProviderRenderParams): void;
}

const getRoot = (dom: Element | ShadowRoot | Document) => {
  const mountedRoot = dom.querySelector?.('#vite-subapp-root');
  return mountedRoot ?? dom;
};

const provider: Provider = {
  render({ dom, props }) {
    const root = getRoot(dom);
    const loadedAt = props?.loadedAt ?? new Date().toLocaleTimeString();
    const view = document.createElement('section');
    view.className = 'subapp-panel';
    view.innerHTML = `
      <header>
        <span class="status-dot"></span>
        <strong>ESM subapp mounted</strong>
      </header>
      <p>${createMessage(loadedAt)}</p>
      <p class="module-url">${import.meta.url}</p>
    `;
    view
      .querySelector<HTMLElement>('.status-dot')
      ?.style.setProperty('background', accentColor);
    root.replaceChildren(view);
  },

  destroy({ dom }) {
    getRoot(dom).replaceChildren();
  },
};

__GARFISH_EXPORTS__.provider = provider;

export { provider };
export default provider;

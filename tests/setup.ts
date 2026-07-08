const schedule = (callback: () => void) => setTimeout(callback, 0);

Object.assign(globalThis, {
  location: {
    href: 'https://example.test/',
  },
  window: {
    requestAnimationFrame: schedule,
    requestIdleCallback: schedule,
  },
});

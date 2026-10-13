import '@testing-library/jest-dom/vitest';

// jsdom lacks these; components that measure/scroll need harmless stubs.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver ??= RO;
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
}

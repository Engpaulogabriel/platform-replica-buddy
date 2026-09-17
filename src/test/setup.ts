import "@testing-library/jest-dom";

// Testes com `@vitest-environment node` não têm DOM — nada a configurar.
if (typeof window === "undefined") {
  // no-op
} else
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

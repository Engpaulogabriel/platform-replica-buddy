import "@testing-library/jest-dom";

// O teste de SQL (automation-log-transitions) roda no ambiente `node`, sem DOM —
// o stub de matchMedia só faz sentido quando existe window.
if (typeof window !== "undefined") {
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
}

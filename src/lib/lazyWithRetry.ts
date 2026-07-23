// lazyWithRetry: envelopa `React.lazy` para lidar com "Failed to fetch
// dynamically imported module" após novos deploys. Se falhar por chunk
// desatualizado, tenta 1x recarregar o import; se falhar de novo,
// força reload da página (uma única vez por sessão) para pegar o
// novo index.html.
import { lazy, ComponentType } from "react";

const RELOAD_KEY = "__chunk_reload_done__";

function isChunkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /ChunkLoadError/i.test(msg)
  );
}

export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    try {
      return await factory();
    } catch (e1) {
      if (!isChunkError(e1)) throw e1;
      // Retry rápido — pode ser flake de rede
      try {
        await new Promise((r) => setTimeout(r, 400));
        return await factory();
      } catch (e2) {
        if (!isChunkError(e2)) throw e2;
        // Chunk desatualizado por novo deploy — força reload uma única vez
        try {
          const already = sessionStorage.getItem(RELOAD_KEY);
          if (!already) {
            sessionStorage.setItem(RELOAD_KEY, "1");
            window.location.reload();
            // aguarda o reload — resolve com nunca
            return await new Promise<{ default: T }>(() => {});
          }
        } catch { /* sessionStorage indisponível */ }
        throw e2;
      }
    }
  });
}

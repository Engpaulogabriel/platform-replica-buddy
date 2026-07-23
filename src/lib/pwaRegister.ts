/**
 * PWA DESATIVADO — emergência 2026-06-10 (cache do Service Worker servia bundle
 * antigo quebrado no Chrome/Firefox; Edge sem SW funcionava).
 *
 * Este módulo agora APENAS desregistra qualquer Service Worker do app (/sw.js)
 * e limpa os caches conhecidos. Nenhum SW novo é registrado.
 *
 * O arquivo public/sw.js foi substituído por um kill-switch worker que se
 * auto-destrói — necessário para navegadores que voltam com o SW antigo ativo.
 *
 * O suporte a "Adicionar à tela inicial" (manifest) continua funcionando —
 * só o modo offline foi removido.
 */

const APP_SW_PATH = "/sw.js";
const APP_CACHES = ["html-cache", "api-cache", "static-media", "static-code"];

async function unregisterAppSw(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) {
      const scriptUrl =
        reg.active?.scriptURL ??
        reg.installing?.scriptURL ??
        reg.waiting?.scriptURL ??
        "";
      // Só desregistra o SW do app (não toca em workers de mensageria, ex. FCM)
      if (scriptUrl.endsWith(APP_SW_PATH)) {
        await reg.unregister();
      }
    }
  } catch {
    /* ignore */
  }
  // Limpa caches do app (precache Workbox antigo + runtime caches conhecidos)
  try {
    const names = await caches.keys();
    for (const name of names) {
      const isWorkbox = /(^|-)precache-|(^|-)runtime-/.test(name);
      if (isWorkbox || APP_CACHES.includes(name)) {
        await caches.delete(name);
      }
    }
  } catch {
    /* ignore */
  }
}

export function registerPwa(): void {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  // Nunca registra — apenas remove o que existir.
  void unregisterAppSw();
}

// KILL-SWITCH Service Worker — emergência 2026-06-10.
// Substitui o SW Workbox antigo no MESMO caminho (/sw.js). Quando o navegador
// faz o update check, este worker assume, limpa os caches do app, recarrega as
// abas abertas e se auto-desregistra. Sem ele, Chrome/Firefox continuariam
// servindo o bundle antigo para sempre.
// Cache Storage é por origem; só deletamos os caches Workbox deste registro.
function isWorkboxCacheForThisRegistration(name) {
  const hasWorkboxBucket = /(^|-)precache-v\d+-|(^|-)runtime-|(^|-)googleAnalytics-/.test(name);
  const isAppRuntimeCache = ["html-cache", "api-cache", "static-media", "static-code"].includes(name);
  return (hasWorkboxBucket && name.endsWith(self.registration.scope)) || isAppRuntimeCache;
}

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      try {
        const cacheNames = await caches.keys();
        const workboxCacheNames = cacheNames.filter(isWorkboxCacheForThisRegistration);
        await Promise.allSettled(workboxCacheNames.map((name) => caches.delete(name)));
        await self.clients.claim();
        const windowClients = await self.clients.matchAll({ type: "window" });
        await Promise.allSettled(windowClients.map((client) => client.navigate(client.url)));
      } finally {
        await self.registration.unregister();
      }
    })(),
  ),
);

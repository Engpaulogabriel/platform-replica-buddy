// F2 — Rate limit comportamental (client-side).
// Registra "hits" agrupados (rota, evento) na tabela api_hits e chama
// periodicamente check_scraping_pattern. Padrão abusivo → registra alerta em
// security_alerts.
//
// v(fix login): NÃO DESLOGA MAIS por este guard. O polling do dashboard em redes
// rurais (Starlink, com retries) podia bater o limiar de "scraping" e derrubar a
// sessão do operador — falso-positivo inaceitável. Mantemos a DETECÇÃO + o alerta
// (o admin revisa e revoga manualmente se for abuso real), mas a sessão do usuário
// NUNCA é encerrada automaticamente aqui.

import { supabase } from "@/integrations/supabase/client";

interface Hit { endpoint: string; ts: number }
const buffer: Hit[] = [];
const MAX_BUFFER = 50;
let flushing = false;

export function trackHit(endpoint: string) {
  buffer.push({ endpoint, ts: Date.now() });
  if (buffer.length >= MAX_BUFFER) void flush();
}

async function flush() {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer.splice(0, buffer.length);
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const rows = batch.map(b => ({
      user_id: user.id,
      endpoint: b.endpoint,
      user_agent: navigator.userAgent,
      created_at: new Date(b.ts).toISOString(),
    }));
    await supabase.from("api_hits").insert(rows);
  } catch { /* silencioso */ }
  finally { flushing = false; }
}

let flushTimer: number | null = null;
let scrapingTimer: number | null = null;

export function startBehavioralGuard(onAbusive: (reason: string) => void) {
  if (flushTimer) return;
  // Flush a cada 20s
  flushTimer = window.setInterval(() => { void flush(); }, 20_000);
  // Check de padrão a cada 60s
  scrapingTimer = window.setInterval(async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data, error } = await supabase.rpc("check_scraping_pattern", { _user_id: user.id });
      if (error || !data) return;
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.is_abusive) {
        try {
          await supabase.from("security_alerts").insert({
            alert_type: "behavioral_abuse",
            severity: "high",
            details: {
              reason: row.reason,
              hits_last_minute: row.hits_last_minute,
              distinct_endpoints: row.distinct_endpoints,
              user_id: user.id,
              user_agent: navigator.userAgent,
            } as any,
          } as any);
        } catch { /* noop */ }
        // NÃO desloga: apenas registra o alerta. onAbusive fica sem uso de propósito.
        console.warn("[AUTH] padrão comportamental suspeito registrado (sem logout)", row.reason);
        void onAbusive; // evita unused sem alterar a assinatura pública
      }
    } catch { /* noop */ }
  }, 60_000);

  // Hit em navegação (SPA)
  window.addEventListener("popstate", () => trackHit(location.pathname));
}

export function stopBehavioralGuard() {
  if (flushTimer) { window.clearInterval(flushTimer); flushTimer = null; }
  if (scrapingTimer) { window.clearInterval(scrapingTimer); scrapingTimer = null; }
  buffer.length = 0;
}

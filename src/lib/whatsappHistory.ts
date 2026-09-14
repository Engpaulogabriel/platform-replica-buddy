// whatsappHistory.ts — regras puras do Histórico de Conversas WhatsApp.
// ---------------------------------------------------------------------------
// Estão aqui, fora do componente, porque são exatamente as partes que quebraram
// e precisam de teste de verdade: janela de datas, montagem da lista lateral,
// paginação sem duplicata e descarte de resposta obsoleta.
//
// Módulo PURO: sem React, sem Supabase, sem rede, sem DOM. Não escreve nada —
// não há INSERT, UPDATE nem DELETE em nenhuma parte desta correção.

/** Linha leve, o suficiente para montar a lista lateral. */
export interface ContactSeed {
  phone: string;
  operator_name: string | null;
  created_at: string;
  farm_id: string | null;
}

export interface Contact {
  phone: string;
  name: string;
  count: number;
  lastAt: string;
  farmId: string | null;
}

// ── Datas ──────────────────────────────────────────────────────────────────
// O bug antigo: `new Date().toISOString().slice(0,10)` devolve a data em UTC.
// Entre 21h e a meia-noite (BRT = UTC-3) isso já é o dia seguinte, então o
// período padrão saltava um dia. Aqui a data é montada a partir dos campos
// LOCAIS, que é o que o usuário vê no seletor.

/** `YYYY-MM-DD` no fuso LOCAL, `daysAgo` dias atrás. Nunca usa UTC. */
export function localDateString(daysAgo = 0, base: Date = new Date()): string {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() - daysAgo);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Período padrão da tela. 30 dias: em 7 dias havia 6 mensagens; em 30, 10.122. */
export const DEFAULT_RANGE_DAYS = 30;

/** Início do dia local, 00:00:00.000. */
export function startOfLocalDay(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/**
 * Fim do dia local, 23:59:59.**999**.
 * O `.999` importa: com `23:59:59.000` as mensagens do último segundo do dia
 * ficavam de fora, e o usuário nunca saberia.
 */
export function endOfLocalDay(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}

/** Janela pronta para o PostgREST (ISO/UTC), calculada a partir do dia LOCAL. */
export function dateRangeToIso(from: string, to: string): { from: string; to: string } {
  return { from: startOfLocalDay(from).toISOString(), to: endOfLocalDay(to).toISOString() };
}

// ── Telefone ───────────────────────────────────────────────────────────────
// Mantidos idênticos ao comportamento atual da tela: agrupam as variantes
// (com/sem "+", com/sem 9º dígito) da mesma pessoa numa conversa só.

export function formatPhone(phone: string): string {
  const d = (phone || "").replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("55")) return `+55 ${d.slice(2, 4)} ${d.slice(4, 9)}-${d.slice(9)}`;
  if (d.length === 12 && d.startsWith("55")) return `+55 ${d.slice(2, 4)} ${d.slice(4, 8)}-${d.slice(8)}`;
  return phone;
}

/** Telefone canônico BR: 55 + DDD(2) + 9 dígitos, sem "+"/espaços. */
export function canonPhone(raw: string): string {
  let d = (raw || "").replace(/\D/g, "");
  if (!d) return "";
  if (!d.startsWith("55") && (d.length === 10 || d.length === 11)) d = "55" + d;
  if (d.startsWith("55")) {
    const rest = d.slice(2);
    if (rest.length === 10) d = "55" + rest.slice(0, 2) + "9" + rest.slice(2);
  }
  return d;
}

/** Últimos 8 dígitos — estáveis entre todos os formatos do mesmo número. */
export function phoneSuffix8(raw: string): string {
  return (raw || "").replace(/\D/g, "").slice(-8);
}

// ── Lista lateral ──────────────────────────────────────────────────────────

/**
 * Monta a lista de contatos a partir das linhas leves.
 *
 * O QUE MUDOU: as linhas que alimentam isto NÃO são mais filtradas por data.
 * Antes, a lista lateral vinha da mesma janela das mensagens, então um período
 * com 6 mensagens de uma pessoa fazia os outros 26 contatos sumirem da tela —
 * como se tivessem sido apagados. O filtro de data passa a valer só para as
 * mensagens do painel central.
 *
 * O filtro de FAZENDA continua valendo aqui: é escopo de acesso, não recorte
 * temporal. `farm_id NULL` é preservado como `farmId: null` e agrupado em
 * "Sem fazenda" — esses 292 registros continuam visíveis em "Todas".
 */
export function buildContacts(seeds: ContactSeed[]): Contact[] {
  const map = new Map<string, Contact>();
  for (const r of seeds) {
    if (!r?.phone) continue;
    const key = canonPhone(r.phone) || r.phone.replace(/\D/g, "");
    if (!key) continue;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      if (r.operator_name && (existing.name === formatPhone(existing.phone) || !existing.name)) {
        existing.name = r.operator_name;
      }
      if (!existing.farmId && r.farm_id) existing.farmId = r.farm_id;
      if (r.created_at > existing.lastAt) existing.lastAt = r.created_at;
    } else {
      map.set(key, {
        phone: key,
        name: r.operator_name || formatPhone(key),
        count: 1,
        lastAt: r.created_at,
        farmId: r.farm_id ?? null,
      });
    }
  }
  // Conversa mais recente primeiro.
  return Array.from(map.values()).sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

// ── Paginação ──────────────────────────────────────────────────────────────

/** Tamanho de página das mensagens. O `.limit(2000)` mudo virou isto. */
export const PAGE_SIZE = 1000;
/** Página das linhas leves da lista lateral (payload pequeno). */
export const CONTACT_PAGE_SIZE = 1000;

/**
 * Teto de segurança EXPLÍCITO. Existe para não travar o navegador, mas nunca
 * some em silêncio: quando é atingido, `truncated` fica true e a tela avisa.
 * Hoje a base tem 19.622 mensagens, então o teto não é alcançado.
 */
export const MAX_ROWS = 50_000;

/** Faixa `[from, to]` do `.range()` do PostgREST para a página `page` (0-based). */
export function pageRange(page: number, size: number = PAGE_SIZE): [number, number] {
  const from = page * size;
  return [from, from + size - 1];
}

/** Só há próxima página se a atual veio cheia. */
export function hasMorePages(lastPageLength: number, size: number = PAGE_SIZE): boolean {
  return lastPageLength === size;
}

/**
 * Junta uma página nova ao acumulado, descartando `id` já presente.
 *
 * Necessário mesmo com ordenação estável: entre duas páginas pode chegar
 * mensagem nova, o offset desloca e uma linha da borda se repetiria.
 */
export function mergeUnique<T extends { id: string }>(prev: T[], page: T[]): T[] {
  const seen = new Set(prev.map((r) => r.id));
  const out = prev.slice();
  for (const r of page) {
    if (!r?.id || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

// ── Corrida de requisições ─────────────────────────────────────────────────

/**
 * Token monotônico: só a requisição MAIS RECENTE pode escrever no estado.
 *
 * Sem isto, trocar rapidamente de contato ou de período faz a resposta lenta
 * de um filtro antigo chegar depois e sobrescrever o resultado do filtro novo
 * — o usuário vê dados que não correspondem ao que selecionou.
 */
export function createRequestGuard() {
  let current = 0;
  return {
    /** Abre uma requisição e devolve o token dela. */
    begin(): number { return ++current; },
    /** O token ainda é o mais recente? Se não, a resposta deve ser descartada. */
    isCurrent(token: number): boolean { return token === current; },
  };
}

/** Mensagem do painel central quando o período não tem nada. */
export function emptyStateMessage(hasContactSelected: boolean): string {
  return hasContactSelected
    ? "Nenhuma mensagem encontrada no período selecionado."
    : "Nenhuma mensagem encontrada no período selecionado.";
}

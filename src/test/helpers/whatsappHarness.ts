// ─────────────────────────────────────────────────────────────────────────────
// Harness de integração do whatsapp-webhook
// ─────────────────────────────────────────────────────────────────────────────
// Existe porque 156 testes verdes não impediram três bugs em produção. Aqueles
// testes procuravam strings no arquivo e executavam helpers puros; um deles
// chegou a afirmar que a desambiguação de fazenda existia — e existia mesmo,
// dentro de `createAutomacaoFromText`, função que mensagem de comando nunca
// alcança. Presença de código não é comportamento.
//
// Este harness carrega o ARQUIVO REAL da edge function, transpila, e roda
// `processMessage` de verdade: parser, tratamento de pendência,
// handleParsedFlow, resolução de fazenda, resolução de equipamento, montagem
// da confirmação. O que é falsificado é só infraestrutura — banco, envio ao
// WhatsApp, relógio, LLM. A decisão sob teste nunca é falsificada.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildSync } from "esbuild";

const SRC = "supabase/functions/whatsapp-webhook/index.ts";

// ── banco em memória ────────────────────────────────────────────────────────
export type Linha = Record<string, any>;
export type Banco = Record<string, Linha[]>;

const clonar = (x: any) => JSON.parse(JSON.stringify(x));

/** Query builder mínimo, porém fiel ao que o código usa. */
function criarQuery(banco: Banco, tabela: string, envios: any[]) {
  let linhas: Linha[] = clonar(banco[tabela] ?? []);
  let colunas: string[] | null = null;
  let limite: number | null = null;
  let contar = false;
  let cabeca = false;

  const api: any = {
    select(cols?: string, opt?: { count?: string; head?: boolean }) {
      // "*, farms(name)" e afins: não projeta, devolve a linha inteira. Projetar
      // errado criaria campos undefined e mudaria a decisão sob teste.
      if (cols && cols !== "*" && !/[()]/.test(cols)) {
        colunas = cols.split(",").map((c) => c.trim().split(" ")[0]).filter(Boolean);
      }
      if (opt?.count) { contar = true; cabeca = !!opt.head; }
      return api;
    },
    eq(col: string, val: any) { linhas = linhas.filter((r) => r[col] === val); return api; },
    neq(col: string, val: any) { linhas = linhas.filter((r) => r[col] !== val); return api; },
    in(col: string, vals: any[]) { linhas = linhas.filter((r) => vals.includes(r[col])); return api; },
    is(col: string, val: any) { linhas = linhas.filter((r) => r[col] === val); return api; },
    not(col: string, _op: string, val: any) { linhas = linhas.filter((r) => r[col] !== val); return api; },
    gt(col: string, v: any) { linhas = linhas.filter((r) => r[col] > v); return api; },
    gte(col: string, v: any) { linhas = linhas.filter((r) => r[col] >= v); return api; },
    lt(col: string, v: any) { linhas = linhas.filter((r) => r[col] < v); return api; },
    lte(col: string, v: any) { linhas = linhas.filter((r) => r[col] <= v); return api; },
    ilike(col: string, padrao: string) {
      const re = new RegExp("^" + padrao.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
      linhas = linhas.filter((r) => re.test(String(r[col] ?? "")));
      return api;
    },
    order(col: string, opt?: { ascending?: boolean }) {
      const asc = opt?.ascending !== false;
      linhas.sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
      return api;
    },
    limit(n: number) { limite = n; return api; },
    maybeSingle() { return api.then0(true); },
    single() { return api.then0(true); },
    then0(unico: boolean) {
      let out = limite !== null ? linhas.slice(0, limite) : linhas;
      if (colunas) out = out.map((r) => Object.fromEntries(colunas!.map((c) => [c, r[c]])));
      const base: any = { data: unico ? (out[0] ?? null) : out, error: null };
      if (contar) { base.count = linhas.length; if (cabeca) base.data = null; }
      return Promise.resolve(base);
    },
    insert(payload: Linha | Linha[]) {
      const novos = (Array.isArray(payload) ? payload : [payload]).map((r, i) => ({
        id: r.id ?? `gen-${tabela}-${(banco[tabela]?.length ?? 0) + i}`,
        created_at: r.created_at ?? new Date().toISOString(),
        ...r,
      }));
      banco[tabela] = [...(banco[tabela] ?? []), ...novos];
      envios.push({ tipo: "insert", tabela, linhas: clonar(novos) });
      const res: any = Promise.resolve({ data: novos, error: null });
      res.select = () => ({ ...res, single: () => Promise.resolve({ data: novos[0], error: null }),
                                    maybeSingle: () => Promise.resolve({ data: novos[0], error: null }) });
      return res;
    },
    update(patch: Linha) {
      const alvo = api;
      const exec = () => {
        const ids = new Set(linhas.map((r) => r.id));
        banco[tabela] = (banco[tabela] ?? []).map((r) => (ids.has(r.id) ? { ...r, ...patch } : r));
        envios.push({ tipo: "update", tabela, patch: clonar(patch), ids: [...ids] });
        return Promise.resolve({ data: null, error: null });
      };
      const chain: any = {
        eq(col: string, val: any) { linhas = linhas.filter((r) => r[col] === val); return chain; },
        in(col: string, vals: any[]) { linhas = linhas.filter((r) => vals.includes(r[col])); return chain; },
        then: (res: any, rej: any) => exec().then(res, rej),
      };
      void alvo;
      return chain;
    },
    delete() {
      const chain: any = {
        eq(col: string, val: any) {
          const rem = linhas.filter((r) => r[col] === val).map((r) => r.id);
          banco[tabela] = (banco[tabela] ?? []).filter((r) => !rem.includes(r.id));
          envios.push({ tipo: "delete", tabela, ids: rem });
          return Promise.resolve({ data: null, error: null });
        },
        in(col: string, vals: any[]) {
          const rem = linhas.filter((r) => vals.includes(r[col])).map((r) => r.id);
          banco[tabela] = (banco[tabela] ?? []).filter((r) => !rem.includes(r.id));
          envios.push({ tipo: "delete", tabela, ids: rem });
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
    upsert(payload: Linha) {
      banco[tabela] = [...(banco[tabela] ?? []).filter((r) => r.operator_phone !== payload.operator_phone), payload];
      envios.push({ tipo: "upsert", tabela, linhas: [clonar(payload)] });
      return Promise.resolve({ data: [payload], error: null });
    },
    then: (res: any, rej: any) => api.then0(false).then(res, rej),
  };
  return api;
}

export interface Resultado {
  /** Tudo que o bot respondeu ao operador, em ordem. */
  respostas: string[];
  /** Escritas que o código tentou fazer, para provar que NADA foi criado. */
  escritas: any[];
  /** Toda URL que o código tentou chamar. Prova de que nada saiu daqui. */
  urls: string[];
  banco: Banco;
}

// ── compilação do arquivo real (uma vez por processo) ───────────────────────
// A fonte vai por stdin com resolveDir apontando para o diretório real, porque
// index.ts importa irmãos relativos (./ai-router.ts, ./ai-classifier.ts,
// ./action-classifier.ts). Nada é escrito dentro do repositório.
let bundleTexto: string | null = null;
let bundleDir: string | null = null;
let seq = 0;

function compilarUmaVez(): string {
  if (bundleTexto && bundleDir) {
    const p = join(bundleDir, `wh-${++seq}.mjs`);
    writeFileSync(p, bundleTexto, "utf8");
    return p;
  }

  let js = readFileSync(SRC, "utf8");
  // 1) o import do supabase-js vira um stub local
  js = js.replace(
    /import\s+\{[^}]*createClient[^}]*\}\s+from\s+["'][^"']*supabase-js[^"']*["'];?/,
    "const createClient = globalThis.__fakeCreateClient;",
  );
  // 2) não registrar servidor HTTP: só queremos as funções internas
  js = js.replace(/Deno\.serve\(/, "globalThis.__handler = (");
  // 3) expor o que o teste precisa atravessar
  js += "\nglobalThis.__processMessage = processMessage;\n";

  const out = buildSync({
    stdin: { contents: js, loader: "ts", sourcefile: "index.ts",
             resolveDir: resolve("supabase/functions/whatsapp-webhook") },
    bundle: true, format: "esm", target: "es2022", platform: "neutral",
    external: ["https://*", "node:*"], write: false,
  });
  bundleTexto = out.outputFiles[0].text;
  bundleDir = mkdtempSync(join(tmpdir(), "wa-harness-"));
  const p = join(bundleDir, `wh-${++seq}.mjs`);
  writeFileSync(p, bundleTexto, "utf8");
  return p;
}

/**
 * Entrega uma mensagem ao webhook real e devolve o que ele respondeu.
 * Sem `decisaoDoLLM` o Gemini responde vazio — o cenário real em que a
 * mensagem explícita foi engolida por uma pendência em produção.
 */
export async function enviarMensagem(opts: {
  texto: string;
  telefone?: string;
  banco: Banco;
  /** Resposta do Gemini para o classificador de pendência. Ausente = o LLM
   *  não respondeu nada útil, que foi o cenário real de 22/09. */
  decisaoDoLLM?: { decision: "confirm" | "cancel" | "modify" | "unrelated"; confidence: number; reply?: string; new_command?: string };
}): Promise<Resultado> {
  const telefone = opts.telefone ?? "5577999608294";
  const envios: any[] = [];
  const respostas: string[] = [];
  const urls: string[] = [];

  const saida = compilarUmaVez();

  const g = globalThis as any;
  g.__fakeCreateClient = () => ({
    from: (t: string) => criarQuery(opts.banco, t, envios),
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: null } }) },
    functions: { invoke: async () => ({ data: null, error: null }) },
  });
  g.Deno = {
    env: { get: (k: string) => ({
      SUPABASE_URL: "http://x", SUPABASE_SERVICE_ROLE_KEY: "k",
      GEMINI_API_KEY: "k",
    } as Record<string, string>)[k] },
  };
  g.EdgeRuntime = { waitUntil: (p: Promise<any>) => p };

  // envio ao WhatsApp e chamadas ao LLM: capturados, nunca disparados
  const fetchOriginal = globalThis.fetch;
  g.fetch = async (url: any, init?: any) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("graph.facebook.com")) {
      try {
        const corpo = JSON.parse(init?.body ?? "{}");
        const txt = corpo?.text?.body ?? corpo?.template?.name ?? "";
        if (txt) respostas.push(txt);
      } catch { /* ignore */ }
      return new Response(JSON.stringify({ messages: [{ id: "wamid.fake" }] }), { status: 200 });
    }
    if (u.includes("generativelanguage")) {
      const corpo = opts.decisaoDoLLM
        ? { candidates: [{ content: { parts: [{ text: JSON.stringify(opts.decisaoDoLLM) }] } }] }
        : { candidates: [] };
      return new Response(JSON.stringify(corpo), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const mod = await import(/* @vite-ignore */ `file://${saida}`);
    void mod;
    await g.__processMessage(telefone, opts.texto, null);
  } finally {
    globalThis.fetch = fetchOriginal;
  }

  return { respostas, escritas: envios, urls, banco: opts.banco };
}

// ── cenário real: operador com acesso às três fazendas ──────────────────────
export function bancoDeTeste(): Banco {
  const SEMEAR = "f-semear", SYKUE = "f-sykue", TN = "f-terranorte";
  const eq = (id: string, name: string, farm_id: string, extra: Linha = {}) => ({
    id, name, farm_id, active: true, type: "poco", saida: 1,
    desired_running: true, last_outputs_state: "100000", last_confirmed_state: 1,
    last_communication: new Date().toISOString(), maintenance_mode: false,
    communication_status: "online", plc_group_id: `plc-${id}`,
    hw_id: "110101", command_blocked_until: null, pending_command_id: null,
    last_actuation_origin: "remote-desired", forced_shutdown_enabled: false, ...extra,
  });
  return {
    farms: [
      { id: SEMEAR, name: "Semear", comm_timeout_minutes: 15, timezone: "America/Sao_Paulo" },
      { id: SYKUE, name: "Fazenda Sykue", comm_timeout_minutes: 15, timezone: "America/Sao_Paulo" },
      { id: TN, name: "Fazenda Terra Norte", comm_timeout_minutes: 15, timezone: "America/Sao_Paulo" },
    ],
    farm_operational_backend: [
      { farm_id: SEMEAR, backend: "new" }, { farm_id: SYKUE, backend: "new" },
      { farm_id: TN, backend: "new" },
    ],
    equipments: [
      eq("e-semear-11", "POÇO 11 R4", SEMEAR),
      eq("e-semear-03", "POÇO 03 R2", SEMEAR),
      eq("e-semear-05", "POÇO 05 R3", SEMEAR),
      eq("e-semear-14", "POÇO 14 R3", SEMEAR),
      eq("e-semear-15", "POÇO 15 R3", SEMEAR),
      eq("e-sykue-11", "POÇO 11 R06", SYKUE),
      eq("e-tn-11", "Poço 11", TN),
    ],
    plc_groups: [],
    // o operador existe nas TRÊS fazendas; o default aponta para Terra Norte,
    // exatamente como o caso real
    whatsapp_operators: [
      { id: "op-1", phone: "5577999608294", name: "Gabriel Carneiro", role: "admin",
        is_active: true, farm_id: TN, default_farm_id: TN, can_control: true, ai_enabled: false,
        user_id: "u-1", can_turn_on: true, can_turn_off: true, skip_confirmation: false },
      { id: "op-2", phone: "5577999608294", name: "Gabriel Carneiro", role: "admin",
        is_active: true, farm_id: SEMEAR, default_farm_id: TN, can_control: true, ai_enabled: false,
        user_id: "u-1", can_turn_on: true, can_turn_off: true, skip_confirmation: false },
      { id: "op-3", phone: "5577999608294", name: "Gabriel Carneiro", role: "admin",
        is_active: true, farm_id: SYKUE, default_farm_id: TN, can_control: true, ai_enabled: false,
        user_id: "u-1", can_turn_on: true, can_turn_off: true, skip_confirmation: false },
    ],
    whatsapp_pending_actions: [],
    whatsapp_conversation_state: [],
    whatsapp_maintenance_pending: [],
    whatsapp_message_log: [
      { id: "m1", phone: "5577999608294", direction: "incoming", message_body: "oi",
        created_at: new Date(Date.now() - 864e5).toISOString() },
      { id: "m2", phone: "5577999608294", direction: "incoming", message_body: "ok",
        created_at: new Date(Date.now() - 3600e3).toISOString() },
    ],
    whatsapp_config: [{ farm_id: null, api_token: "t", phone_number_id: "p", bot_number: "b" }],
    commands: [],
    automation_log: [],
    user_roles: [{ user_id: "u-1", role: "admin", farm_id: SEMEAR }],
    automation_schedules: [],
    registration_flow_state: [],
  };
}

/** Comandos físicos criados. Precisa ser ZERO antes do SIM. */
export const comandosCriados = (r: Resultado) =>
  r.escritas.filter((e) => e.tipo === "insert" && e.tabela === "commands");

/** Confirmações físicas pendentes criadas. */
export const pendenciasCriadas = (r: Resultado) =>
  r.escritas.filter((e) => e.tipo === "insert" && e.tabela === "whatsapp_pending_actions");

export const juntou = (r: Resultado) => r.respostas.join("\n---\n");

/** URLs fora dos dois destinos falsificados. Precisa ser vazio: nenhuma
 *  chamada de teste pode alcançar Supabase, Meta ou Gemini de verdade. */
export const urlsInesperadas = (r: Resultado) =>
  r.urls.filter((u) => !u.includes("graph.facebook.com") && !u.includes("generativelanguage"));

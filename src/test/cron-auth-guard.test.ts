// @vitest-environment node
// A guarda das funções agendadas: só passa com CRON_SECRET válido ou
// service_role. Anon key, JWT de usuário, query param e afins não passam.
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { isAuthorizedCron, timingSafeEqual } from
  "../../supabase/functions/_shared/cronAuth.ts";

const SECRET  = "s3cr3t-de-cron-com-32-bytes-ou-mais-aqui";
const SERVICE = "service-role-key-que-nunca-sai-do-servidor";
const ANON    = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.anon.publica";
const env = { cronSecret: SECRET, serviceRoleKey: SERVICE };
const h = (o: Record<string, string> = {}) => new Headers(o);

describe("1 a 3. chamadas não autorizadas são barradas", () => {
  it("sem credencial nenhuma → 401", () => {
    const r = isAuthorizedCron(h(), env);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(401); expect(r.reason).toBe("missing_cron_secret"); }
  });

  it("x-cron-secret inválido → 403", () => {
    const r = isAuthorizedCron(h({ "x-cron-secret": "chute" }), env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("segredo quase certo (um caractere a menos) → bloqueado", () => {
    expect(isAuthorizedCron(h({ "x-cron-secret": SECRET.slice(0, -1) }), env).ok).toBe(false);
  });

  it("ANON KEY no Authorization → bloqueado (é pública por definição)", () => {
    expect(isAuthorizedCron(h({ authorization: `Bearer ${ANON}`, apikey: ANON }), env).ok).toBe(false);
  });

  it("JWT de usuário comum → bloqueado", () => {
    expect(isAuthorizedCron(h({ authorization: "Bearer eyJ.usuario.comum" }), env).ok).toBe(false);
  });

  it("apikey sozinha não autentica", () => {
    expect(isAuthorizedCron(h({ apikey: SECRET }), env).ok).toBe(false);
  });

  it("origem, referer, IP e user-agent não autenticam", () => {
    expect(isAuthorizedCron(h({
      origin: "https://supabase.com", referer: "https://supabase.com",
      "x-forwarded-for": "127.0.0.1", "user-agent": "pg_net/1.0",
    }), env).ok).toBe(false);
  });

  it("segredo vazio no header não passa", () => {
    expect(isAuthorizedCron(h({ "x-cron-secret": "" }), env).ok).toBe(false);
    expect(isAuthorizedCron(h({ "x-cron-secret": "   " }), env).ok).toBe(false);
  });
});

describe("4. chamadas legítimas passam", () => {
  it("x-cron-secret correto → ok", () => {
    const r = isAuthorizedCron(h({ "x-cron-secret": SECRET }), env);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.via).toBe("cron_secret");
  });

  it("service_role no Authorization → ok", () => {
    const r = isAuthorizedCron(h({ authorization: `Bearer ${SERVICE}` }), env);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.via).toBe("service_role");
  });

  it("espaço em volta do segredo é tolerado", () => {
    expect(isAuthorizedCron(h({ "x-cron-secret": ` ${SECRET} ` }), env).ok).toBe(true);
  });
});

describe("falha FECHADA", () => {
  it("sem CRON_SECRET configurado, ninguém passa — nem com service_role", () => {
    const semSecret = { cronSecret: "", serviceRoleKey: SERVICE };
    const r = isAuthorizedCron(h({ authorization: `Bearer ${SERVICE}` }), semSecret);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(403); expect(r.reason).toBe("cron_secret_not_configured"); }
  });

  it("env totalmente vazio → bloqueado", () => {
    expect(isAuthorizedCron(h({ "x-cron-secret": "x" }), {}).ok).toBe(false);
  });
});

describe("comparação em tempo constante", () => {
  it("compara valor, não prefixo", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("a", "")).toBe(false);
  });

  it("aceita UTF-8 sem quebrar", () => {
    expect(timingSafeEqual("segredo-ção", "segredo-ção")).toBe(true);
    expect(timingSafeEqual("segredo-ção", "segredo-cao")).toBe(false);
  });
});

// ── 5 e 7. a guarda vem ANTES de qualquer ação, e o segredo não vaza ───────
describe("5 e 7. posição da guarda e não vazamento", () => {
  const FUNCS = ["scheduled-shutdown", "well-hours-watchdog", "agent-offline-watchdog",
                 "security-anomaly-watchdog", "whatsapp-alerts-healthcheck",
                 "whatsapp-automation-notify"];
  const REPO = path.resolve(__dirname, "../..");
  const src = (f: string) =>
    fs.readFileSync(path.join(REPO, `supabase/functions/${f}/index.ts`), "utf8");

  for (const f of FUNCS) {
    it(`${f}: guarda presente e antes de createClient/consulta`, () => {
      const s = src(f);
      expect(s).toContain("guardCron");
      const guard = s.indexOf("guardCron(req");
      expect(guard, "guarda ausente").toBeGreaterThan(0);
      for (const acao of ["createClient(", ".from(", "http_post", "fetch("]) {
        const i = s.indexOf(acao, s.indexOf("Deno.serve"));
        if (i > 0) expect(guard, `${acao} acontece antes da guarda`).toBeLessThan(i);
      }
    });

    it(`${f}: não imprime o segredo`, () => {
      const s = src(f);
      expect(s).not.toMatch(/console\.[a-z]+\([^)]*CRON_SECRET/);
      expect(s).not.toMatch(/console\.[a-z]+\([^)]*x-cron-secret/i);
    });
  }

  it("a migration não contém segredo literal", () => {
    const m = fs.readFileSync(
      path.join(REPO, "supabase/migrations/20260816010000_cron_secret_vault.sql"), "utf8");
    expect(m).toContain("vault.decrypted_secrets");
    // nada que pareça um JWT ou um segredo colado
    expect(m).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(m).not.toMatch(/CRON_SECRET\s*(text)?\s*:?=\s*'[^']{8,}'/);
  });

  it("a migration dos jobs cobre exatamente os seis, sem segredo literal", () => {
    const m = fs.readFileSync(
      path.join(REPO, "supabase/migrations/20260816020000_cron_jobs_use_secret.sql"), "utf8");
    const JOBS = ["scheduled-shutdown-semear-17h", "agent-offline-watchdog-every-minute",
                  "agent-offline-watchdog-tick", "security-anomaly-watchdog-tick",
                  "well-hours-watchdog-tick", "whatsapp-alerts-healthcheck-daily"];
    for (const j of JOBS) expect(m, `job ${j} ausente`).toContain(j);
    // nada de anon key / JWT colado, nem segredo literal
    expect(m).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(m).not.toMatch(/x-cron-secret['"]?\s*,\s*['"][^'"]{8,}/);
    // schedule vem do banco, não hardcoded
    expect(m).toContain("SELECT schedule, command INTO");
    expect(m).toContain("cron.schedule(v_job, v_sched");
    // trava para não encostar nos demais jobs
    expect(m).toContain("v_outros_antes <> v_outros_depois");
    // backup para rollback por job
    expect(m).toContain("cron_job_backup");
  });

  it("nenhum job passa a usar net.http_post direto com token", () => {
    const m = fs.readFileSync(
      path.join(REPO, "supabase/migrations/20260816020000_cron_jobs_use_secret.sql"), "utf8");
    const agenda = m.slice(m.indexOf("PERFORM cron.schedule"), m.indexOf("RAISE NOTICE"));
    expect(agenda).toContain("cron_invoke");
    expect(agenda).not.toContain("net.http_post");
  });

  it("whatsapp-automation-notify: guarda é a 1ª coisa do handler", () => {
    const s2 = src("whatsapp-automation-notify");
    // Ordem de EXECUÇÃO é dentro do handler; funções auxiliares declaradas
    // antes não executam sozinhas. Medimos a partir do corpo do handler.
    const corpo = s2.slice(s2.lastIndexOf("Deno.serve"));
    const guard = corpo.indexOf("guardCron(req");
    expect(guard, "guarda ausente no handler").toBeGreaterThan(0);
    // procura o USO em código, não a menção em comentário
    for (const acao of ['fetch(`https://graph.facebook.com', '.from("whatsapp_message_log")', 'createClient(']) {
      const i = corpo.indexOf(acao);
      if (i > 0) expect(guard, `${acao} executa antes da guarda`).toBeLessThan(i);
    }
    // e nada de substancial antes dela, além do OPTIONS
    const antes = corpo.slice(0, guard);
    expect(antes).not.toMatch(/await |\.from\(|fetch\(/);
  });

  it("a migration dos 8 jobs cobre exatamente eles, preserva schedule e body", () => {
    const m = fs.readFileSync(
      path.join(REPO, "supabase/migrations/20260816030000_cron_jobs_alerts_whatsapp.sql"), "utf8");
    const JOBS = ["critical-alerts-tick-every-minute",
      "whatsapp-automation-notify-every-minute", "whatsapp-automation-notify-every-10s-10",
      "whatsapp-automation-notify-every-10s-20", "whatsapp-automation-notify-every-10s-30",
      "whatsapp-automation-notify-every-10s-40", "whatsapp-automation-notify-every-10s-50",
      "wa-batch-tick-every-minute"];
    for (const j of JOBS) expect(m, `job ${j} ausente`).toContain(j);
    expect(m).toContain("SELECT schedule, command INTO");    // schedule do banco
    expect(m).toMatch(/v_body := substring\(v_cmd/);          // body do banco
    expect(m).toContain("v_outros_antes <> v_outros_depois"); // não toca nos demais
    expect(m).toContain("cron_job_backup");                   // rollback por job
    expect(m).toMatch(/app\.cron_secret/);                    // rejeita o GUC vazio
    expect(m).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);           // sem anon key
    expect(m).not.toMatch(/create_secret|rotate|DROP SECRET/i); // não mexe em segredo
  });

  it("os jobs já protegidos não aparecem na migration nova como alvo", () => {
    const m = fs.readFileSync(
      path.join(REPO, "supabase/migrations/20260816030000_cron_jobs_alerts_whatsapp.sql"), "utf8");
    const alvo = m.slice(m.indexOf("v_jobs text[] := ARRAY["), m.indexOf("];"));
    for (const j of ["scheduled-shutdown-semear-17h", "well-hours-watchdog-tick",
                     "agent-offline-watchdog-tick", "security-anomaly-watchdog-tick",
                     "whatsapp-alerts-healthcheck-daily"]) {
      expect(alvo, `${j} não pode ser alvo`).not.toContain(j);
    }
  });

  it("o helper não devolve o segredo na resposta HTTP", () => {
    const g = fs.readFileSync(
      path.join(REPO, "supabase/functions/_shared/cronAuth.ts"), "utf8");
    const corpo = g.slice(g.indexOf("export function guardCron"));
    expect(corpo).toContain('"unauthorized"');
    expect(corpo).not.toMatch(/JSON\.stringify\([^)]*secret/i);
    expect(corpo).not.toMatch(/console\./);
  });
});

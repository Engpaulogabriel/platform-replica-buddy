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
const REPO2 = path.resolve(__dirname, "../..");
const src2 = (f: string) =>
  fs.readFileSync(path.join(REPO2, `supabase/functions/${f}/index.ts`), "utf8");

describe("5 e 7. posição da guarda e não vazamento", () => {
  // DOIS excluídos DELIBERADAMENTE desta frente:
  //   • whatsapp-automation-notify
  //   • scheduled-shutdown
  // Produção envia o segredo rotacionado CRON_SECRET_V2, que `guardCron` ainda
  // não conhece; aplicar a guarda neles devolveria 401 — foi o que aconteceu com
  // critical-alerts-tick. No scheduled-shutdown o dano seria maior: pararia o
  // próprio desligamento programado, não só o aviso.
  // Ambos voltam quando o CRON_SECRET_V2 for tratado em cronAuth.
  const FUNCS = ["well-hours-watchdog", "agent-offline-watchdog",
                 "security-anomaly-watchdog", "whatsapp-alerts-healthcheck"];
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

  it("scheduled-shutdown NÃO leva a guarda nesta entrega", () => {
    // Excluído junto com o notify — mesma razão do CRON_SECRET_V2. Aqui um 401
    // pararia o desligamento programado inteiro.
    const s3 = src2("scheduled-shutdown");
    expect(s3).not.toContain("guardCron");
    expect(s3).not.toContain("_shared/cronAuth.ts");
  });

  it("whatsapp-automation-notify NÃO leva a guarda nesta entrega", () => {
    // Exclusão deliberada — ver comentário no topo do describe. Enquanto
    // `guardCron` só conhecer CRON_SECRET, a guarda aqui significaria 401 no
    // cron de produção e zero notificação para os operadores.
    const s2 = src2("whatsapp-automation-notify");
    expect(s2).not.toContain("guardCron");
    expect(s2).not.toContain("_shared/cronAuth.ts");
  });

  it("o notify preserva a política POR DESTINATÁRIO (não o kill-switch antigo)", () => {
    const s2 = src2("whatsapp-automation-notify");
    expect(s2).toContain("POLÍTICA POR DESTINATÁRIO (não mais blanket)");
    // o drain do cron sempre passa — é por ele que automation_execution_log é lido
    expect(s2).toContain("const _isCronDrain = _b.immediate !== true;");
    expect(s2).toContain("if (!_isWatchdogSystem && !_isEquipmentState && !_isCronDrain)");
    // e o blanket antigo, que marcava notified_at sem enviar, não voltou
    expect(s2).not.toContain("blocked_by_killswitch");
    expect(s2).not.toContain("KILL-SWITCH DE POLÍTICA");
    expect(s2).not.toMatch(/update\(\{ notified_at: nowIso2 \}\)/);
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

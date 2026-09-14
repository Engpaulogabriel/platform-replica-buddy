// @vitest-environment node
// Regressão 401 do cron. A função tem de aceitar o segredo ROTACIONADO que o
// `cron_invoke()` de produção envia (CRON_SECRET_V2) sem afrouxar nada: sem
// credencial continua 401, credencial errada continua 401, ambiente sem
// segredo continua fechado.
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { authorizeCron, type CronAuthEnv,
       } from "../../supabase/functions/critical-alerts-tick/auth.ts";

const V1 = "segredo-antigo-nao-rotacionado";
const V2 = "segredo-rotacionado-v2";
const SR = "service-role-key-de-teste";

/** Headers mínimos, case-insensitive como os do runtime. */
const H = (h: Record<string, string> = {}) => ({
  get: (n: string) => h[n.toLowerCase()] ?? null,
});

const ENV: CronAuthEnv = { cronSecret: V1, cronSecretV2: V2, serviceRole: SR };

describe("1 e 2. o que era 401 continua 401", () => {
  it("1. sem x-cron-secret e sem authorization → NÃO autoriza", () => {
    const r = authorizeCron(H(), ENV);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_secret_presented");
  });

  it("2. segredo inválido → NÃO autoriza", () => {
    const r = authorizeCron(H({ "x-cron-secret": "chute" }), ENV);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("secret_mismatch");
  });

  it("2b. bearer inválido → NÃO autoriza", () => {
    const r = authorizeCron(H({ authorization: "Bearer nao-e-a-chave" }), ENV);
    expect(r.ok).toBe(false);
  });

  it("2c. header vazio não casa com segredo configurado", () => {
    expect(authorizeCron(H({ "x-cron-secret": "" }), ENV).ok).toBe(false);
  });

  it("2d. prefixo correto do segredo NÃO basta — comparação é exata", () => {
    expect(authorizeCron(H({ "x-cron-secret": V2.slice(0, -1) }), ENV).ok).toBe(false);
    expect(authorizeCron(H({ "x-cron-secret": V2 + "x" }), ENV).ok).toBe(false);
  });
});

describe("3 e 4. os segredos configurados são aceitos", () => {
  it("3. CRON_SECRET válido → autoriza", () => {
    const r = authorizeCron(H({ "x-cron-secret": V1 }), ENV);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("cron_secret");
  });

  it("4. CRON_SECRET_V2 válido → autoriza (o caso do 401 em produção)", () => {
    const r = authorizeCron(H({ "x-cron-secret": V2 }), ENV);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("cron_secret_v2");
  });

  it("4b. só o V2 configurado (rotação concluída) → autoriza", () => {
    const r = authorizeCron(H({ "x-cron-secret": V2 }),
                            { cronSecretV2: V2, serviceRole: SR });
    expect(r.ok).toBe(true);
    expect(r.secretsConfigured).toBe(1);
  });

  it("4c. só o V1 configurado (antes da rotação) → V2 NÃO passa", () => {
    const r = authorizeCron(H({ "x-cron-secret": V2 }),
                            { cronSecret: V1, serviceRole: SR });
    expect(r.ok).toBe(false);
  });

  it("bearer com service_role continua autorizando", () => {
    const r = authorizeCron(H({ authorization: `Bearer ${SR}` }), ENV);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("service_role");
  });
});

describe("5. ambiente sem segredo NÃO abre a função", () => {
  it("nenhuma credencial configurada → fecha, com motivo explícito", () => {
    const r = authorizeCron(H({ "x-cron-secret": "qualquer" }), {});
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not_configured");
    expect(r.secretsConfigured).toBe(0);
  });

  it("segredos vazios não viram candidatos — vazio não casa com vazio", () => {
    const r = authorizeCron(H({ "x-cron-secret": "" }),
                            { cronSecret: "", cronSecretV2: "", serviceRole: "" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not_configured");
  });

  it("sem segredo mas com service_role, só o bearer correto entra", () => {
    const env = { serviceRole: SR };
    expect(authorizeCron(H({ "x-cron-secret": "x" }), env).ok).toBe(false);
    expect(authorizeCron(H({ authorization: `Bearer ${SR}` }), env).ok).toBe(true);
  });

  it("nunca autoriza por ausência de credencial", () => {
    for (const env of [{}, { cronSecret: V1 }, { cronSecretV2: V2 }, { serviceRole: SR }]) {
      expect(authorizeCron(H(), env as CronAuthEnv).ok, JSON.stringify(env)).toBe(false);
    }
  });
});

describe("o index.ts usa a decisão e não vaza segredo", () => {
  const REPO = path.resolve(__dirname, "../..");
  const DIR = path.join(REPO, "supabase/functions/critical-alerts-tick");
  const TICK = fs.readFileSync(path.join(DIR, "index.ts"), "utf8");
  const AUTH = fs.readFileSync(path.join(DIR, "auth.ts"), "utf8");

  it("lê os dois segredos exclusivamente do ambiente", () => {
    expect(TICK).toContain('Deno.env.get("CRON_SECRET")');
    expect(TICK).toContain('Deno.env.get("CRON_SECRET_V2")');
  });

  it("nenhum valor de segredo literal no código", () => {
    for (const src of [TICK, AUTH]) {
      expect(src).not.toMatch(/CRON_SECRET(_V2)?\s*=\s*["'][^"']+["']/);
      expect(src).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    }
  });

  it("o log nunca imprime o valor do segredo", () => {
    const bloco = TICK.slice(TICK.indexOf("const auth = authorizeCron"),
                             TICK.indexOf("authorized invocation") + 200);
    expect(bloco).toContain("reason: auth.reason");
    expect(bloco).not.toMatch(/console\.(warn|log|error)[^;]*\bCRON_SECRET\b/);
    expect(bloco).not.toMatch(/cronHeader|presented|bearer/);
  });

  it("a decisão vem do módulo, não de comparação solta no handler", () => {
    expect(TICK).toContain('import { authorizeCron } from "./auth.ts";');
    expect(TICK).not.toMatch(/cronHeader === CRON_SECRET/);
  });

  it("continua devolvendo 401 e não outro status", () => {
    const bloco = TICK.slice(TICK.indexOf("if (!auth.ok)"),
                             TICK.indexOf("authorized invocation"));
    expect(bloco).toContain("status: 401");
  });

  it("NÃO importa o helper compartilhado (outras funções não são afetadas)", () => {
    expect(TICK).not.toContain("_shared/cronAuth.ts");
  });

  it("auth.ts não grava em banco nem faz rede", () => {
    expect(AUTH).not.toMatch(/createClient|fetch\(|\.from\(|insert|update/);
  });
});

describe("6. a classificação de falta de energia permanece idêntica", () => {
  const REPO = path.resolve(__dirname, "../..");
  const TICK = fs.readFileSync(
    path.join(REPO, "supabase/functions/critical-alerts-tick/index.ts"), "utf8");
  const ini = TICK.indexOf("const powerWindowStart");
  const fim = TICK.indexOf("// ─── #7 safety_timer_fired");
  const BLOCO = TICK.slice(ini, fim);

  it("o bloco #6 continua lá, intacto nos seus critérios", () => {
    expect(ini).toBeGreaterThan(0);
    expect(BLOCO).toContain('.in("action", ["turn_off", "pump_off"])');
    expect(BLOCO).toContain('.in("origin", ["reading", "system"])');
    expect(BLOCO).toContain('.in("type", ["manual", "automation"])');
    expect(BLOCO).toContain("hasCompatibleCommandOrAutomation: commandedNearby");
    expect(BLOCO).toMatch(/uuidFromString\(incidentRef\(/);
    expect(BLOCO).toContain("title: cls.title");
    expect(BLOCO).not.toContain("noise_reason");
  });

  it("a auth não introduziu nada dentro do bloco de classificação", () => {
    expect(BLOCO).not.toMatch(/CRON_SECRET|authorizeCron|unauthorized/);
  });
});

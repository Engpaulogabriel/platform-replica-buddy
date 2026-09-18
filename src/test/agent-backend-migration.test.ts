// ─────────────────────────────────────────────────────────────────────────────
// Agent — máquina de estados da migração de backend
// ─────────────────────────────────────────────────────────────────────────────
// Regressão do incidente de 18/09/2026: a Fazenda Pérola operou ~12 horas sem
// falha no backend novo e, após ~1 minuto sem internet, voltou SOZINHA para o
// antigo. Cinco falhas `cloud_network` consecutivas bastavam — o gatilho ficava
// armado para sempre.
//
// Módulo puro: nenhum teste abre rede, toca serial, envia comando ou grava
// arquivo. Só decisão sobre objetos de config.

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const bm = require_("../../electron-agent/lib/backendMigration.cjs");

const { ESTADOS, PADROES, ensureBackendConfig, buildPromotedConfig,
        buildRollbackConfig, noteOutcome, isCommitted, reconcileOnBoot,
        decidePromotion, safeSummary, CHECKS } = bm;

const OLD_URL = "https://dnyukgfedredvxpzjpqz.supabase.co";
const NEW_URL = "https://uzqvtimpsynnupmfozru.supabase.co";
const KEY_OLD = "x".repeat(60);
const KEY_NEW = "y".repeat(60);

const T0 = Date.parse("2026-09-17T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const HORA = 60 * MIN;

/** Config de um Agent que nunca migrou (só o backend antigo). */
const configLegado = () => ({ supabaseUrl: OLD_URL, supabaseAnonKey: KEY_OLD });

/** Config logo após a promoção para o backend novo. */
function configPromovido(quandoMs = T0) {
  const base = ensureBackendConfig(configLegado());
  const r = buildPromotedConfig(base, {
    primaryUrl: NEW_URL, primaryAnonKey: KEY_NEW,
    fallbackUrl: null, fallbackAnonKey: null,
    migrationId: "mig-1",
  }, iso(quandoMs));
  expect(r.ok).toBe(true);
  return r.config;
}

/** Aplica N falhas de nuvem seguidas e devolve o último resultado. */
function falhas(cfg: any, n: number, agoraMs: number, kind = "cloud_network") {
  let c = cfg;
  let r: any = null;
  for (let i = 0; i < n; i++) {
    r = noteOutcome(c, kind, false, agoraMs);
    c = r.config;
  }
  return { config: c, ultimo: r };
}

// ── 1, 12 — promoção ────────────────────────────────────────────────────────
describe("promoção", () => {
  it("set_backend promove e guarda o backend anterior como fallback", () => {
    const c = configPromovido();
    const b = c.backendConfig;
    expect(b.activeBackend).toBe("primary");
    expect(b.migrationState).toBe(ESTADOS.PROMOTED);
    expect(b.primaryUrl).toBe(NEW_URL);
    // anti-lockout: o antigo NUNCA é descartado
    expect(b.fallbackUrl).toBe(OLD_URL);
    expect(b.fallbackAnonKey).toBe(KEY_OLD);
    expect(b.committedAt).toBeNull();
  });

  it("só promove com todas as checagens verdes", () => {
    const todas = Object.fromEntries(CHECKS.map((c: string) => [c, true]));
    expect(decidePromotion(todas, {}, "mig-x").promote).toBe(true);
    const faltando = { ...todas, license_validate: false };
    const d = decidePromotion(faltando, {}, "mig-x");
    expect(d.promote).toBe(false);
    expect(d.failed).toContain("license_validate");
  });
});

// ── 2, 3, 4, 13, 17 — dentro da janela de validação ─────────────────────────
describe("janela de validação", () => {
  it("logo após promover, ainda NÃO está committed", () => {
    expect(isCommitted(configPromovido(), T0 + 1 * MIN)).toBe(false);
  });

  it("5 falhas de nuvem DENTRO da janela ainda revertem — é o propósito dela", () => {
    const { ultimo } = falhas(configPromovido(), 5, T0 + 2 * MIN);
    expect(ultimo.rollback).toBe(true);
    expect(ultimo.failures).toBe(5);
  });

  it("4 falhas não revertem, e um sucesso zera o contador", () => {
    const { config, ultimo } = falhas(configPromovido(), 4, T0 + 2 * MIN);
    expect(ultimo.rollback).toBe(false);
    const ok = noteOutcome(config, "cloud_network", true, T0 + 2 * MIN);
    expect(ok.config.backendConfig.consecutiveCloudFailures).toBe(0);
    // e a contagem recomeça do zero
    const depois = falhas(ok.config, 4, T0 + 3 * MIN);
    expect(depois.ultimo.rollback).toBe(false);
  });

  it("falha que não é de nuvem nunca conta (rádio/PLC são problema de campo)", () => {
    const { ultimo } = falhas(configPromovido(), 20, T0 + 2 * MIN, "serial_timeout");
    expect(ultimo.rollback).toBe(false);
    expect(ultimo.reason).toBe("falha_nao_e_de_nuvem");
  });

  it("rollback dentro da janela leva ao backend antigo e exige migration_id novo", () => {
    const { config } = falhas(configPromovido(), 5, T0 + 2 * MIN);
    const r = buildRollbackConfig(config, iso(T0 + 3 * MIN), "falhas_de_nuvem");
    expect(r.ok).toBe(true);
    expect(r.config.supabaseUrl).toBe(OLD_URL);
    expect(r.config.backendConfig.migrationState).toBe(ESTADOS.ROLLED_BACK);
    const d = decidePromotion(
      Object.fromEntries(CHECKS.map((c: string) => [c, true])), r.config, "mig-1");
    expect(d.promote).toBe(false);
    expect(d.reason).toBe("migration_revertida_exige_id_novo");
  });
});

// ── 5 — critério de commit ──────────────────────────────────────────────────
describe("commit da migração", () => {
  it("fecha por TEMPO ao vencer a janela", () => {
    const c = configPromovido();
    expect(isCommitted(c, T0 + PADROES.validationWindowMs - 1)).toBe(false);
    expect(isCommitted(c, T0 + PADROES.validationWindowMs)).toBe(true);
  });

  it("fecha ANTES por sucessos consecutivos de nuvem", () => {
    let c = configPromovido();
    for (let i = 0; i < PADROES.commitAfterHealthySuccesses; i++) {
      c = noteOutcome(c, "cloud_network", true, T0 + 60_000).config;
    }
    expect(c.backendConfig.migrationState).toBe(ESTADOS.COMMITTED);
    expect(c.backendConfig.committedAt).toBeTruthy();
  });

  it("o commit é carimbado no config assim que observado", () => {
    const c = configPromovido();
    const r = noteOutcome(c, "cloud_network", true, T0 + 31 * MIN);
    expect(r.committed).toBe(true);
    expect(r.config.backendConfig.migrationState).toBe(ESTADOS.COMMITTED);
  });
});

// ── 6, 7, 8, 9 — depois de COMMITTED, nada reverte sozinho ──────────────────
describe("após COMMITTED nenhuma falha de nuvem reverte", () => {
  const committed = () => noteOutcome(configPromovido(), "cloud_network", true,
                                      T0 + 31 * MIN).config;

  it.each([
    ["cloud_network", 5],
    ["cloud_network", 50],
    ["api_unavailable", 50],
    ["cloud_auth", 50],
    ["license_validate", 50],
  ])("%s ×%i → permanece no backend novo", (kind, n) => {
    const { config, ultimo } = falhas(committed(), n as number, T0 + 32 * MIN, kind as string);
    expect(ultimo.rollback).toBe(false);
    expect(config.backendConfig.activeBackend).toBe("primary");
    expect(config.supabaseUrl).toBe(NEW_URL);
    expect(config.backendConfig.migrationState).toBe(ESTADOS.COMMITTED);
  });

  it("o fallback continua guardado, apenas não é escolhido sozinho", () => {
    const { config } = falhas(committed(), 50, T0 + 32 * MIN);
    expect(config.backendConfig.fallbackUrl).toBe(OLD_URL);
    expect(config.backendConfig.fallbackAnonKey).toBe(KEY_OLD);
  });

  it("volta DELIBERADA continua possível (caminho humano/administrativo)", () => {
    const r = buildRollbackConfig(committed(), iso(T0 + 40 * MIN), "decisao_humana");
    expect(r.ok).toBe(true);
    expect(r.config.supabaseUrl).toBe(OLD_URL);
  });
});

// ── 19 — a regressão da Pérola ──────────────────────────────────────────────
describe("REGRESSÃO — Pérola 18/09/2026", () => {
  it.each([1, 5, 30, 120, 720])(
    "12 h saudável no novo + %i min sem internet → NUNCA volta ao antigo",
    (minutosSemInternet) => {
      // 12 horas de operação saudável
      let c = configPromovido(T0);
      c = noteOutcome(c, "cloud_network", true, T0 + 12 * HORA).config;
      expect(c.backendConfig.migrationState).toBe(ESTADOS.COMMITTED);

      // queda de internet: falha a cada ~10 s durante todo o período
      const ciclos = Math.floor((minutosSemInternet * MIN) / 10_000);
      const { config, ultimo } = falhas(c, ciclos, T0 + 12 * HORA + 1000);

      expect(ultimo.rollback).toBe(false);
      expect(config.backendConfig.activeBackend).toBe("primary");
      expect(config.supabaseUrl).toBe(NEW_URL);
      expect(config.backendConfig.migrationState).toBe(ESTADOS.COMMITTED);
    });

  it("quando a internet volta, segue no backend novo", () => {
    let c = noteOutcome(configPromovido(), "cloud_network", true, T0 + 12 * HORA).config;
    c = falhas(c, 200, T0 + 12 * HORA + 1000).config;
    const volta = noteOutcome(c, "cloud_network", true, T0 + 13 * HORA);
    expect(volta.config.supabaseUrl).toBe(NEW_URL);
    expect(volta.config.backendConfig.consecutiveCloudFailures).toBe(0);
  });
});

// ── 10, 14, 15, 16, 17, 18 — reinício e compatibilidade ─────────────────────
describe("reinício e configs existentes", () => {
  it("COMMITTED + reinício permanece no novo", () => {
    const c = noteOutcome(configPromovido(), "cloud_network", true, T0 + 31 * MIN).config;
    const r = reconcileOnBoot(c, iso(T0 + 32 * MIN));
    expect(r.changed).toBe(false);
    expect(r.config.supabaseUrl).toBe(NEW_URL);
  });

  it("COMMITTED ignora rollback_pending herdado de versão anterior", () => {
    const c = noteOutcome(configPromovido(), "cloud_network", true, T0 + 31 * MIN).config;
    const adulterado = {
      ...c,
      backendConfig: { ...c.backendConfig, migrationState: ESTADOS.COMMITTED,
                       rollbackPendingLegado: true },
    };
    const r = reconcileOnBoot(adulterado, iso(T0 + 33 * MIN));
    expect(r.config.supabaseUrl).toBe(NEW_URL);
  });

  it("rollback_pending dentro da janela ainda é concluído no boot", () => {
    const c = configPromovido();
    const pend = { ...c, backendConfig: { ...c.backendConfig,
      migrationState: ESTADOS.ROLLBACK_PENDING } };
    const r = reconcileOnBoot(pend, iso(T0 + 3 * MIN));
    expect(r.action).toBe("rollback_concluido_no_boot");
    expect(r.config.supabaseUrl).toBe(OLD_URL);
  });

  it("Agent já revertido (caso atual da Pérola) permanece no antigo — sem recuperação automática", () => {
    const { config } = falhas(configPromovido(), 5, T0 + 2 * MIN);
    const rb = buildRollbackConfig(config, iso(T0 + 3 * MIN), "falhas_de_nuvem").config;
    const boot = reconcileOnBoot(rb, iso(T0 + 4 * HORA));
    expect(boot.config.supabaseUrl).toBe(OLD_URL);
    expect(boot.config.backendConfig.activeBackend).toBe("fallback");
    // e nenhum sucesso no antigo o traz de volta ao novo sozinho
    const r = noteOutcome(boot.config, "cloud_network", true, T0 + 5 * HORA);
    expect(r.config.supabaseUrl).toBe(OLD_URL);
    expect(r.reason).toBe("nao_migrado");
  });

  it("Agent nunca migrado permanece onde está", () => {
    const c = ensureBackendConfig(configLegado());
    expect(c.backendConfig.migrationState).toBe(ESTADOS.IDLE);
    const r = noteOutcome(c, "cloud_network", false, T0);
    expect(r.rollback).toBe(false);
    expect(r.reason).toBe("nao_migrado");
  });

  it("config legado sem os campos novos carrega sem erro", () => {
    const antigo = {
      supabaseUrl: NEW_URL, supabaseAnonKey: KEY_NEW,
      backendConfig: {
        primaryUrl: NEW_URL, primaryAnonKey: KEY_NEW,
        fallbackUrl: OLD_URL, fallbackAnonKey: KEY_OLD,
        activeBackend: "primary", migrationState: ESTADOS.PROMOTED,
        lastSwitchAt: iso(T0), consecutiveCloudFailures: 0,
        // sem committedAt, sem healthySuccesses
      },
    };
    expect(() => ensureBackendConfig(antigo)).not.toThrow();
    expect(isCommitted(antigo, T0 + 31 * MIN)).toBe(true);
    const { ultimo } = falhas(antigo, 50, T0 + 31 * MIN);
    expect(ultimo.rollback).toBe(false);
  });

  it("promoção sem lastSwitchAt válido não vira committed por acidente", () => {
    const sem = { backendConfig: { primaryUrl: NEW_URL, primaryAnonKey: KEY_NEW,
      fallbackUrl: OLD_URL, fallbackAnonKey: KEY_OLD, activeBackend: "primary",
      migrationState: ESTADOS.PROMOTED, lastSwitchAt: null } };
    expect(isCommitted(sem, T0 + 10 * HORA)).toBe(false);
  });
});

// ── 13 — observabilidade sem vazar segredo ──────────────────────────────────
describe("diagnóstico", () => {
  it("safeSummary expõe estado e host, nunca chave", () => {
    const c = noteOutcome(configPromovido(), "cloud_network", true, T0 + 31 * MIN).config;
    const s = safeSummary(c);
    expect(s.migrationState).toBe(ESTADOS.COMMITTED);
    expect(s.primaryHost).toBe("uzqvtimpsynnupmfozru.supabase.co");
    expect(s.fallbackHost).toBe("dnyukgfedredvxpzjpqz.supabase.co");
    expect(s.committedAt).toBeTruthy();
    const texto = JSON.stringify(s);
    expect(texto).not.toContain(KEY_NEW);
    expect(texto).not.toContain(KEY_OLD);
  });
});

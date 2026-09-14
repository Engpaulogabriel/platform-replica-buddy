// @vitest-environment node
// Configuração de partida escalonada POR FAZENDA, editável na tela do Modo
// Automático. O que vale é o valor persistido em `farms` — nada de estado só
// em React, nada de fallback que minta sobre o banco.
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { validateStaggerConfig, STAGGER_DEFAULTS, STAGGER_LIMITS } from "../lib/automaticPumpState.ts";

const REPO = path.resolve(__dirname, "../..");
const HOOK = fs.readFileSync(path.join(REPO, "src/hooks/useCloudAutomation.ts"), "utf8");
const PAGE = fs.readFileSync(path.join(REPO, "src/pages/Automatico.tsx"), "utf8");
const MIG = fs.readFileSync(path.join(REPO,
  "supabase/migrations/20260904120000_automation_tick_resilient_idempotent.sql"), "utf8");

describe("15 a 18. carregar a configuração persistida", () => {
  it("o hook lê as três colunas de farms", () => {
    expect(HOOK).toContain("automatic_start_stagger_enabled, automatic_start_stagger_seconds, automatic_start_batch_size");
    expect(HOOK).toContain('.from("farms")');
  });

  it("16. enabled=false é respeitado (não vira true por ausência)", () => {
    expect(HOOK).toContain("fr?.automatic_start_stagger_enabled !== false");
  });

  it("17 e 18. batch e stagger vêm do banco, com default só se NULL", () => {
    expect(HOOK).toContain("fr?.automatic_start_batch_size ?? STAGGER_DEFAULTS.batchSize");
    expect(HOOK).toContain("fr?.automatic_start_stagger_seconds ?? STAGGER_DEFAULTS.staggerSeconds");
  });
});

describe("19 a 25. persistência e validação", () => {
  it("19 a 21. salvar faz UPDATE em farms e só então atualiza a UI", () => {
    const bloco = HOOK.slice(HOOK.indexOf("const setStaggerConfig"), HOOK.indexOf("const createSchedule"));
    expect(bloco).toContain('.from("farms")');
    expect(bloco).toContain("automatic_start_stagger_enabled: next.enabled");
    expect(bloco).toContain("automatic_start_batch_size: next.batchSize");
    expect(bloco).toContain("automatic_start_stagger_seconds: next.staggerSeconds");
    const iErr = bloco.indexOf("if (error) throw");
    const iSet = bloco.indexOf("setStaggerState(next)");
    expect(iErr).toBeGreaterThan(0);
    expect(iSet).toBeGreaterThan(iErr);          // erro aborta antes de mudar a UI
  });

  it("23 a 25. valores inválidos são rejeitados ANTES de gravar", () => {
    expect(validateStaggerConfig(0, 60)).toMatch(/Bombas por grupo/);
    expect(validateStaggerConfig(-1, 60)).toMatch(/Bombas por grupo/);
    expect(validateStaggerConfig(1, 0)).toMatch(/Intervalo/);
    expect(validateStaggerConfig(1, -30)).toMatch(/Intervalo/);
    expect(validateStaggerConfig(Number.NaN, 60)).toMatch(/Bombas por grupo/);
    expect(validateStaggerConfig(1, Number.NaN)).toMatch(/Intervalo/);
    const bloco = HOOK.slice(HOOK.indexOf("const setStaggerConfig"), HOOK.indexOf("const createSchedule"));
    const iVal = bloco.indexOf("validateStaggerConfig");
    expect(iVal).toBeGreaterThan(0);
    expect(iVal).toBeLessThan(bloco.indexOf(".update("));   // valida antes do UPDATE
  });

  it("falha ao salvar não finge sucesso", () => {
    const bloco = PAGE.slice(PAGE.indexOf("const salvarStagger"), PAGE.indexOf("const salvarStagger") + 900);
    expect(bloco).toContain("notify.fail");
    expect(bloco).toContain("setBatchInput(String(cloud.stagger.batchSize))");  // reverte
  });

  it("22. o refresh ressincroniza os inputs com o banco", () => {
    expect(PAGE).toContain("}, [cloud.stagger.batchSize, cloud.stagger.staggerSeconds]);");
  });
});

describe("26 a 29. escopo por fazenda e acoplamento com o núcleo", () => {
  it("26 e 27. o UPDATE é filtrado por farm_id — não vaza entre fazendas", () => {
    const bloco = HOOK.slice(HOOK.indexOf("const setStaggerConfig"), HOOK.indexOf("const createSchedule"));
    expect(bloco).toContain('.eq("id", farmId)');
    expect(bloco).toContain('if (!farmId) throw new Error');
  });

  it("28 e 29. os campos da UI são EXATAMENTE os lidos pelo backend", () => {
    for (const campo of ["automatic_start_batch_size", "automatic_start_stagger_seconds",
                         "automatic_start_stagger_enabled"]) {
      expect(HOOK, `hook: ${campo}`).toContain(campo);
      expect(MIG, `migration: ${campo}`).toContain(campo);
    }
    // e o run_automation_tick realmente os consome
    expect(MIG).toContain("COALESCE(f.automatic_start_batch_size, 1) AS batch_size");
    expect(MIG).toContain("COALESCE(f.automatic_start_stagger_seconds, 60) AS stagger_s");
  });

  it("defaults conservadores, iguais aos do banco", () => {
    expect(STAGGER_DEFAULTS).toEqual({ enabled: true, batchSize: 1, staggerSeconds: 60 });
    expect(MIG).toContain("automatic_start_batch_size int NOT NULL DEFAULT 1");
    expect(MIG).toContain("automatic_start_stagger_seconds int NOT NULL DEFAULT 60");
    expect(MIG).toContain("automatic_start_stagger_enabled boolean NOT NULL DEFAULT true");
  });
});

describe("a seção existe na tela do Modo Automático", () => {
  it("tem switch, os dois campos e a descrição pedida", () => {
    expect(PAGE).toContain("Partida escalonada");
    expect(PAGE).toContain("Bombas por grupo");
    expect(PAGE).toContain("Intervalo entre grupos");
    expect(PAGE).toMatch(/reduzindo picos de demanda/);
  });

  it("com o escalonamento desligado os valores continuam visíveis, só desabilitados", () => {
    expect(PAGE).toContain("disabled={!cloud.stagger.enabled || savingStagger}");
    expect(PAGE).not.toMatch(/cloud\.stagger\.enabled &&\s*\(?\s*<Input/);
  });

  it("não criou tela nova — foi na página existente", () => {
    expect(fs.existsSync(path.join(REPO, "src/pages/Automatico.tsx"))).toBe(true);
    expect(STAGGER_LIMITS.batchMin).toBe(1);
  });
});

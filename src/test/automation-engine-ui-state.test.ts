// @vitest-environment node
// A UI mostrava "Modo Automático ATIVO" quando `automation_engine` não tinha
// linha (ou tinha enabled=false), porque assumia `?? true`. O motor, com INNER
// JOIN em `enabled=true`, não executava nada. Foi o que escondeu o incidente da
// SOSSEGO. Ausência de informação NUNCA pode significar ATIVO.
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const HOOK = fs.readFileSync(path.join(REPO, "src/hooks/useCloudAutomation.ts"), "utf8");
const CODE = HOOK.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");

/** A regra, isolada: exatamente o que o hook passou a fazer. */
const engineActiveFrom = (row: { enabled?: boolean } | null | undefined) => row?.enabled === true;

describe("18 a 20. o estado vem do banco, nunca de suposição", () => {
  it("18. enabled=false → DESATIVADO", () => {
    expect(engineActiveFrom({ enabled: false })).toBe(false);
  });

  it("19. enabled=true → ATIVO", () => {
    expect(engineActiveFrom({ enabled: true })).toBe(true);
  });

  it("20. linha inexistente → NÃO assumir ativo", () => {
    expect(engineActiveFrom(null)).toBe(false);
    expect(engineActiveFrom(undefined)).toBe(false);
    expect(engineActiveFrom({})).toBe(false);
  });

  it("o hook não contém mais nenhum fallback otimista", () => {
    expect(CODE).not.toContain("?? true");
    expect(CODE).not.toContain("enabled ?? true");
  });

  it("o estado inicial é DESATIVADO, não ATIVO", () => {
    expect(CODE).toContain("useState(false)");
    expect(CODE).not.toMatch(/const \[engineActive, setEngineActiveState\] = useState\(true\)/);
  });

  it("as duas leituras do banco usam comparação estrita", () => {
    expect(CODE).toContain("setEngineActiveState(engRes.data?.enabled === true)");
    expect(CODE).toContain("const remote = data?.enabled === true;");
  });

  it("sem fazenda também é DESATIVADO", () => {
    const bloco = CODE.slice(CODE.indexOf("const refresh = useCallback"), CODE.indexOf("const refresh = useCallback") + 400);
    expect(bloco).toContain("setEngineActiveState(false)");
  });
});

describe("21 e 22. o toggle persiste e o refresh reflete o banco", () => {
  it("21. ativar/desativar faz upsert em automation_engine", () => {
    expect(CODE).toContain('.from("automation_engine")');
    expect(CODE).toContain(".upsert(");
    expect(CODE).toContain("enabled: active");
    expect(CODE).toContain('onConflict: "farm_id"');
  });

  it("21b. a UI só muda DEPOIS da confirmação do banco", () => {
    const i = CODE.indexOf(".upsert(");
    const j = CODE.indexOf("setEngineActiveState(active)");
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);          // estado local vem depois do await
    const entre = CODE.slice(i, j);
    expect(entre).toContain("if (error)"); // e aborta se o upsert falhar
  });

  it("22. o refresh relê do banco — não há estado só em React", () => {
    expect(CODE).toContain('.from("automation_engine")');
    expect(CODE).toContain(".select(\"enabled\")");
    expect(CODE).toContain('table: "automation_engine"');   // realtime re-sincroniza
  });
});

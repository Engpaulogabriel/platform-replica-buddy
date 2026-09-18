// ─────────────────────────────────────────────────────────────────────────────
// Escritas operacionais — roteamento por fazenda (fail-closed)
// ─────────────────────────────────────────────────────────────────────────────
// Uma LEITURA no backend errado mostra dado velho: o operador percebe.
// Uma ESCRITA no backend errado é silenciosa — o comando é aceito, some, e
// ninguém descobre até a bomba não desligar. Estes testes travam isso.
//
// Sem I/O: varredura estrutural do código-fonte + roteamento puro.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PEROLA = "1014a8ab-b02a-47c7-90fc-1646d52a991e";
const SOSSEGO = "3e45b5ac-856e-4d29-b3b8-4dd71f86140d";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { __id: "OLD", channel: () => ({ __id: "OLD_CHANNEL" }), removeChannel: async () => "ok" },
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ __id: "NEW" }) }));

import {
  assertOperationalClient,
  getSupabaseForFarm,
  setNewBackendAuthReady,
  BackendRoutingError,
} from "@/lib/supabaseRouter";
import { MIGRATED_FARMS } from "@/lib/migrationRegistry";

const idOf = (c: unknown) => (c as { __id: string }).__id;
const src = (p: string) => readFileSync(p, "utf8");

/** Tabelas cujo conteúdo é consumido pelo Agent/automação daquela fazenda. */
const OPER_TABLES = [
  "equipments", "commands", "agent_commands", "site_health", "plc_groups", "sectors",
  "agent_logs", "automation_log", "automation_schedules", "automation_engine",
  "automation_holiday_configs", "automation_guards", "automations", "automation_audit_log",
  "scheduled_automations", "service_mode_locks", "agent_update_status", "agent_config",
  "agent_hardware", "device_licenses", "peak_hour_config", "farm_productivity_config",
  "farm_inema_config", "rf_routing",
];
/** RPCs que criam comando, telemetria ou ordem para o Agent. */
const OPER_RPC = [
  "apply_pump_telemetry", "enqueue_polling_for_due_equipments", "mark_commands_timeout",
  "platform_send_agent_reboot", "platform_clear_pending_commands", "reset_agent_hardware",
  "clear_agent_update", "set_switching_protection", "request_agent_update",
  "enqueue_remote_command", "platform_unbind_device", "farm_backup_create",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.|\/test\//.test(p)) out.push(p);
  }
  return out;
}

/** Escritas operacionais farm-scoped feitas pelo singleton ANTIGO. */
function writeLeaks(): string[] {
  const leaks: string[] = [];
  for (const file of walk("src")) {
    const code = src(file);
    if (!code.includes('from "@/integrations/supabase/client"')) continue;

    for (const t of OPER_TABLES) {
      const re = new RegExp(`\\bsupabase\\s*\\n?\\s*\\.from\\(\\s*["\`]${t}["\`][^)]*\\)([\\s\\S]{0,400})`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(code))) {
        if (!/\.(insert|update|upsert|delete)\s*\(/.test(m[1])) continue;
        const ctx = code.slice(Math.max(0, m.index - 600), m.index + 700);
        if (!/farm_id|farmId|_farm_id/.test(ctx)) continue;
        leaks.push(`${file}: WRITE ${t}`);
      }
    }
    for (const r of OPER_RPC) {
      if (new RegExp(`\\bsupabase\\s*\\n?\\s*\\.rpc\\(\\s*["\`]${r}["\`]`).test(code)) {
        leaks.push(`${file}: RPC ${r}`);
      }
    }
  }
  return leaks;
}

beforeEach(() => setNewBackendAuthReady(true));

// ── 7 — a trava que importa ─────────────────────────────────────────────────
describe("varredura completa de src/", () => {
  it("nenhuma escrita operacional farm-scoped usa o singleton antigo", () => {
    expect(writeLeaks()).toEqual([]);
  });
});

// ── 1 — comandos físicos ────────────────────────────────────────────────────
describe("escritores de comando físico", () => {
  const WRITERS: Array<[string, RegExp]> = [
    ["commandQueue (ON/OFF manual)", /assertOperationalClient\(/],
    ["automationProtectiveOff (off protetivo)", /assertOperationalClient\(farmId\)\.from\("commands"\)\.insert/],
    ["pollingScheduler (enfileira polling)", /assertOperationalClient\(farmId\)\.rpc\("enqueue_polling_for_due_equipments"/],
    ["DemandaEnergia (corte de carga)", /assertOperationalClient\(farmId\)\.from\("commands"\)\.insert/],
    ["PlatformServiceMode (frame serial)", /const db = assertOperationalClient\(farmId\);/],
  ];
  const FILES: Record<string, string> = {
    "commandQueue (ON/OFF manual)": "src/lib/commandQueue.ts",
    "automationProtectiveOff (off protetivo)": "src/lib/automationProtectiveOff.ts",
    "pollingScheduler (enfileira polling)": "src/lib/pollingScheduler.ts",
    "DemandaEnergia (corte de carga)": "src/pages/DemandaEnergia.tsx",
    "PlatformServiceMode (frame serial)": "src/components/platform/PlatformServiceMode.tsx",
  };

  it.each(WRITERS)("%s resolve o cliente pela fazenda", (nome, padrao) => {
    expect(src(FILES[nome])).toMatch(padrao);
  });

  it("Pérola → NEW e demais → OLD em qualquer escrita de comando", () => {
    expect(idOf(assertOperationalClient(PEROLA))).toBe("NEW");
    expect(idOf(assertOperationalClient(SOSSEGO))).toBe("OLD");
  });
});

// ── 6 — pipeline do worker: MESMO cliente do começo ao fim ──────────────────
describe("commandWorker — um cliente por comando, do TX à confirmação", () => {
  const W = src("src/lib/commandWorker.ts");

  it("o cliente é resolvido uma vez, no start, e é fail-closed", () => {
    expect(W).toMatch(/let activeDb: RenovSupabase \| null = null;/);
    expect(W).toMatch(/activeDb = assertOperationalClient\(farmId\);/);
    expect(W).toMatch(/worker não iniciado/);
  });

  it("reserva, erro e busca de pendentes usam o cliente recebido", () => {
    expect(W).toMatch(/async function fetchNextPending\(db: RenovSupabase, farmId: string\)/);
    expect(W).toMatch(/async function markSent\(db: RenovSupabase, commandId: string\)/);
    expect(W).toMatch(/async function markError\(db: RenovSupabase, commandId: string/);
  });

  it("cada comando em voo carrega o próprio cliente até a confirmação", () => {
    expect(W).toMatch(/interface InflightCommand \{\s*\n\s*db: RenovSupabase;/);
    expect(W).toMatch(/updateCommandWithRetry\(\s*\n?\s*info\.db,/);
    expect(W).toMatch(/updateCommandWithRetry\(cmd\.db, cmd\.id/);
  });

  it("confirmações pendentes drenam no backend em que nasceram", () => {
    expect(W).toMatch(/interface PendingConfirmation \{\s*\n\s*db: RenovSupabase;/);
    expect(W).toMatch(/item\.db\.from\("commands"\)/);
  });

  it("telemetria vai para o backend da fazenda do frame", () => {
    expect(W).toMatch(/assertOperationalClient\(farmId\)\.rpc\("apply_pump_telemetry"/);
  });
});

// ── 2 — automação ───────────────────────────────────────────────────────────
describe("escritas de automação", () => {
  it("engine, schedules, feriados e guards seguem a fazenda", () => {
    const A = src("src/hooks/useCloudAutomation.ts");
    expect(A).toMatch(/assertOperationalClient\(farmId\)\s*\n?\s*\.from\("automation_engine"\)/);
    expect(A).toMatch(/assertOperationalClient\(farmId\)\s*\n?\s*\.from\("automation_schedules"\)\s*\n?\s*\.insert/);
    expect(A).toMatch(/assertOperationalClient\(farmId\)\.from\("automation_schedules"\)\.update/);
    expect(A).toMatch(/assertOperationalClient\(farmId\)\s*\n?\s*\.from\("automation_holiday_configs"\)/);
    expect(src("src/lib/automationGuard.ts")).toMatch(/assertOperationalClient\(farmId\)\s*\n?\s*\.from\("automation_guards"\)/);
    expect(src("src/hooks/useAutomacoes.ts")).toMatch(/assertOperationalClient\(farmId\)\s*\n?\s*\.from\("automations"\)/);
    expect(src("src/components/automacoes/ScheduledShutdownSection.tsx"))
      .toMatch(/assertOperationalClient\(farmId\)\s*\n?\s*\.from\("scheduled_automations"\)/);
  });

  it("DELETE de programação carimba e apaga com o MESMO cliente", () => {
    const A = src("src/hooks/useCloudAutomation.ts");
    expect(A).toMatch(/const db = assertOperationalClient\(farmId\);[\s\S]{0,400}await db\s*\n?\s*\.from\("automation_schedules"\)[\s\S]{0,300}db\.from\("automation_schedules"\)\.delete/);
  });
});

// ── 3 — cadastro operacional ────────────────────────────────────────────────
describe("equipments / plc_groups / sectors", () => {
  it("a migração local→nuvem usa UM cliente em todas as etapas", () => {
    const C = src("src/lib/cadastrosCloud.ts");
    expect(C).toMatch(/const db = assertOperationalClient\(farmId\);/);
    expect(C).not.toMatch(/supabase\.from\("equipments"\)\.delete/);
    for (const t of ["plc_groups", "sectors", "equipments"]) {
      expect(C).toMatch(new RegExp(`db\\s*\\n?\\s*\\.from\\("${t}"\\)`));
    }
  });

  it("a troca de TSNN renomeia PLC e bombas no mesmo backend", () => {
    const P = src("src/components/diagnostico/PumpCfgDialog.tsx");
    expect(P).toMatch(/const db = assertOperationalClient\(farmId\);/);
    expect(P).toMatch(/db\.from\("plc_groups"\)\.update/);
  });

  it("edições pontuais de equipamento também roteiam", () => {
    expect(src("src/pages/Produtividade.tsx")).toMatch(/assertOperationalClient\(farmId\)\.from\("equipments"\)/);
    expect(src("src/components/demanda/EquipmentPowerConfig.tsx")).toMatch(/const db = assertOperationalClient\(farmId\);/);
    expect(src("src/components/SectorsConfig.tsx")).toMatch(/assertOperationalClient\(cloudFarmId\)/);
  });
});

// ── 4 — serviço, manutenção e OTA ───────────────────────────────────────────
describe("modo serviço, licença e OTA", () => {
  it("locks e frames do Modo Serviço são fail-closed", () => {
    const S = src("src/components/platform/PlatformServiceMode.tsx");
    expect(S).toMatch(/assertOperationalClient\(farmId\)\.from\("service_mode_locks"\)\.upsert/);
    expect(S).toMatch(/assertOperationalClient\(farmId\)\.from\("service_mode_locks"\)\.delete/);
  });

  it("ordens de OTA e reautorização de hardware seguem a fazenda", () => {
    expect(src("src/components/platform/PlatformUpdates.tsx")).toMatch(/assertOperationalClient\(fid\)\.rpc\("request_agent_update"/);
    expect(src("src/components/platform/AgentUpdateStatusPanel.tsx")).toMatch(/assertOperationalClient\(farmId\)\.rpc\("clear_agent_update"/);
    expect(src("src/components/HardwareSecurityPanel.tsx")).toMatch(/assertOperationalClient\(farmId\)\.rpc\("reset_agent_hardware"/);
    expect(src("src/components/platform/PlatformDevices.tsx")).toMatch(/assertOperationalClient\(d\.farm_id\)\.rpc\("platform_unbind_device"/);
  });

  it("reboot e limpeza de fila do Agent também", () => {
    const R = src("src/components/platform/PlatformRemoteControl.tsx");
    expect(R).toMatch(/assertOperationalClient\(farmId\)\.rpc\("platform_send_agent_reboot"/);
    expect(R).toMatch(/assertOperationalClient\(farmId\)\.rpc\("platform_clear_pending_commands"/);
  });

  it("proteção de manobra segue a fazenda nas duas ações", () => {
    const S = src("src/components/tecnico/SwitchingProtectionPanel.tsx");
    expect((S.match(/assertOperationalClient\(farmId\)\.rpc\("set_switching_protection"/g) ?? []).length).toBe(2);
  });
});

// ── 5 — sem fallback silencioso ─────────────────────────────────────────────
describe("fail-closed", () => {
  it("Pérola sem sessão no NEW recusa a escrita e NUNCA devolve OLD", () => {
    setNewBackendAuthReady(false);
    let erro: unknown;
    try { assertOperationalClient(PEROLA); } catch (e) { erro = e; }
    expect(erro).toBeInstanceOf(BackendRoutingError);
    expect((erro as BackendRoutingError).code).toBe("new_backend_unauthenticated");
    expect(idOf(assertOperationalClient(SOSSEGO))).toBe("OLD"); // demais seguem normais
  });

  it("escrita sem fazenda identificada é recusada", () => {
    let erro: unknown;
    try { assertOperationalClient(null); } catch (e) { erro = e; }
    expect((erro as BackendRoutingError).code).toBe("farm_unknown");
  });

  it("leitura de acompanhamento cai no mesmo backend da escrita", () => {
    expect(idOf(getSupabaseForFarm(PEROLA))).toBe(idOf(assertOperationalClient(PEROLA)));
    expect(idOf(getSupabaseForFarm(SOSSEGO))).toBe(idOf(assertOperationalClient(SOSSEGO)));
  });
});

describe("invariantes", () => {
  it("MIGRATED_FARMS continua contendo somente a Pérola", () => {
    expect([...MIGRATED_FARMS]).toEqual([PEROLA]);
  });
});

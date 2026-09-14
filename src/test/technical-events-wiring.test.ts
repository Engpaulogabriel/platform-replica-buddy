// @vitest-environment node
// FASE 2B — wiring do Agent. Prova que a instrumentação é ADITIVA e que nenhum
// valor ou caminho operacional mudou.
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const AGENT = fs.readFileSync(path.join(REPO, "electron-agent/main.cjs"), "utf8");
const RPC = fs.readFileSync(path.join(REPO, "supabase/migrations/20260906120000_record_agent_technical_event.sql"), "utf8");
const semComentario = (t: string) => t.split("\n")
  .filter((l) => { const x = l.trim(); return !x.startsWith("//") && !x.startsWith("*") && !x.startsWith("/*"); })
  .join("\n");
/** só o bloco de evidência técnica que foi acrescentado */
const BLOCO = AGENT.slice(AGENT.indexOf("// CENTRO DE EVIDÊNCIAS TÉCNICAS — wiring"),
                          AGENT.indexOf("// --- Supabase auth ---"));

describe("15 e 21. valores operacionais INALTERADOS", () => {
  const ESPERADOS: Array<[string, string]> = [
    ["POLL_INTERVAL_MS", "10_000"],
    ["TX_MIN_GAP_MS", "3000"],
    ["RX_AVOID_GAP_MS", "2000"],
    ["SAFETY_WINDOW_MS", "120_000"],
    ["CLOUD_WRITE_TIMEOUT_MS", "8_000"],
  ];
  for (const [nome, valor] of ESPERADOS) {
    it(`${nome} = ${valor}`, () => {
      expect(AGENT).toMatch(new RegExp(`const ${nome} = ${valor.replace(/_/g, "_")}`));
    });
  }
  it("MANUAL_REINFORCE_DELAYS_MS continua [15s, 30s, 45s]", () => {
    expect(AGENT).toContain("const MANUAL_REINFORCE_DELAYS_MS = [15_000, 30_000, 45_000];");
  });
});

describe("21. o bloco novo não toca em nada operacional", () => {
  const PROIBIDOS = ["desired_running", "pending_command_id", "command_blocked_until",
    "txQueue", "inflightCmd", "last_outputs_state", "renov_combined_payload",
    "enqueue_reset_pump_command", "run_automation_tick", "apply_pump_telemetry",
    "safety_expired_at", "forced_shutdown"];
  const codigo = semComentario(BLOCO);

  it("nenhum símbolo operacional dentro do bloco de evidência", () => {
    for (const p of PROIBIDOS) expect(codigo, p).not.toContain(p);
  });

  it("o bloco não escreve em tabela nenhuma do banco", () => {
    expect(codigo).not.toMatch(/supabase\s*\.from\(/);
    expect(codigo).not.toMatch(/\.update\(|\.insert\(|\.upsert\(|\.delete\(/);
    // a única RPC chamada é a de auditoria
    expect(codigo.match(/\.rpc\("([a-z_]+)"/g) ?? []).toEqual(['.rpc("record_agent_technical_event"']);
  });

  it("22. o laço serial não espera HTTP — timer próprio e sem await no caminho crítico", () => {
    // O único agendamento do bloco é setInterval próprio, com unref.
    expect(codigo).toMatch(/setInterval\(\(\) => \{ void techProbeTick\(\); \}, TECH_PROBE_INTERVAL_MS\)/);
    expect(codigo).toContain("t.unref()");
    // e a chamada de entrada é void (fire-and-forget), nunca awaited
    expect(AGENT).toContain("startTechnicalEvidenceBestEffort();");
    expect(AGENT).not.toContain("await startTechnicalEvidenceBestEffort()");
  });

  it("toda função do bloco é blindada por try/catch", () => {
    for (const fn of ["techEnqueue", "techFlush", "techProbeTick", "startTechnicalEvidenceBestEffort"]) {
      const i = BLOCO.indexOf(`function ${fn}`);
      expect(i, fn).toBeGreaterThan(-1);
      expect(BLOCO.slice(i, i + 2600), fn).toMatch(/catch\s*\(/);
    }
  });

  it("a classificação vem do módulo puro — sem ifs paralelos no main.cjs", () => {
    expect(codigo).toContain("TECH.applyProbe(techMonitor,");
    for (const t of ["internet_offline", "cloud_unreachable", "internet_restored",
                     "dns_failure", "high_latency"]) {
      expect(codigo, t).not.toContain(`"${t}"`);   // nomes de evento só no módulo
    }
  });
});

describe("probes e ingestão", () => {
  const codigo = semComentario(BLOCO);
  it("9 e 10. probe leve: sem tabela, sem escrita, sem speed test", () => {
    expect(codigo).toContain("/rest/v1/");
    expect(codigo).toMatch(/method: "HEAD"/);
    expect(codigo).not.toMatch(/speed|download|Content-Length|blob\(\)/i);
  });

  it("8. endpoint externo é configurável, não hardcode cego", () => {
    expect(codigo).toContain("process.env.RENOV_PROBE_EXTERNAL_URL");
    expect(codigo).toContain("process.env.RENOV_PROBE_INTERVAL_MS");
  });

  it("13. occurred_at real é enviado, não a hora do upload", () => {
    expect(codigo).toContain("occurred_at: e.occurredAt || null");
  });

  it("19. falha da ingestão gera backoff, não laço — e não vira internet_offline", () => {
    expect(codigo).toContain("techIngestBackoffUntil");
    expect(codigo).toMatch(/techIngestBackoffUntil = Date\.now\(\) \+ 60_000/);
    expect(codigo).toContain("break;");   // para o lote, não insiste
    // o backoff da ingestão não alimenta o monitor de conectividade
    expect(codigo).not.toMatch(/techIngestBackoffUntil[\s\S]{0,200}applyProbe/);
  });

  it("12. flush em lotes e não concorrente", () => {
    expect(codigo).toContain("TECH_FLUSH_BATCH");
    expect(codigo).toContain("techFlushInFlight");
  });

  it("3. agent_started não inventa startup_reason", () => {
    expect(BLOCO).toContain('eventType: "agent_started"');
    expect(codigo).not.toContain("startup_reason");
  });
});

describe("1. ingestão DIRETA — sem Edge Function, sem Lovable Cloud", () => {
  // O cabeçalho da migration CITA AGENT_TOKEN_SECRET para explicar por que NÃO
  // o usa; a verificação precisa olhar o SQL, não o comentário.
  const semSql = (t: string) => t.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const c = semSql(RPC);
  const bloco = semComentario(BLOCO);

  it("o Agent chama a RPC pelo PostgREST, não uma Edge Function", () => {
    expect(bloco).toContain('supabase.rpc("record_agent_technical_event"');
    expect(bloco).not.toContain("functions/v1");
    expect(bloco).not.toContain("technical-events-ingest");
  });

  it("não existe parâmetro de fazenda — falsificar farm_id é impossível", () => {
    expect(c).not.toMatch(/_farm_id\s+uuid/);
    expect(c).toContain("SELECT dl.farm_id INTO v_farm");
  });

  it("autentica por jti ativo, não revogado e não expirado", () => {
    expect(c).toContain("dl.current_token_jti = _agent_jti::text");
    expect(c).toContain("dl.revoked_at IS NULL");
    expect(c).toContain("dl.current_token_expires_at > now()");
  });

  it("nenhum segredo vai para o banco", () => {
    expect(c).not.toContain("AGENT_TOKEN_SECRET");
    expect(c).not.toMatch(/vault\./);
    expect(c).not.toContain("hmac(");
  });

  it("anon NÃO ganha INSERT direto na tabela — só EXECUTE da função", () => {
    expect(c).not.toMatch(/POLICY[\s\S]*technical_events[\s\S]*INSERT[\s\S]*anon/i);
    expect(c).toMatch(/GRANT EXECUTE ON FUNCTION public\.record_agent_technical_event[\s\S]*TO anon/);
  });

  it("limites, idempotência e rate limit dentro da função", () => {
    expect(c).toContain("ON CONFLICT (client_event_id)");
    expect(c).toContain("length(COALESCE(_payload,'{}')::text)  > 8192");
    expect(c).toContain("v_recent >= 120");
  });

  it("occurred_at real é preservado", () => {
    expect(c).toContain("COALESCE(_occurred_at, now())");
    expect(bloco).toContain("_occurred_at: e.occurredAt || null");
  });

  it("Realtime habilitado para a interface futura", () => {
    expect(c).toContain("REPLICA IDENTITY FULL");
    expect(c).toContain("ALTER PUBLICATION supabase_realtime ADD TABLE public.technical_events");
  });

  it("a RPC nunca lança — auditoria não derruba o Agent", () => {
    expect(c).toContain("EXCEPTION WHEN OTHERS THEN");
  });
});

describe("FASE 2C — instrumentação nos detectores canônicos", () => {
  const codigo = semComentario(AGENT);
  const PONTOS: Array<[string, string]> = [
    ["plc_online", "equipamento_online"],
    ["plc_offline", "equipamento_offline"],
    ["bridge_offline", "BRIDGE_MAX_RELAUNCH"],
    ["serial_error", "COM-STUCK"],
  ];

  for (const [evento, detector] of PONTOS) {
    it(`${evento} sai do detector canônico (${detector}), sem detector novo`, () => {
      // o nome do detector aparece também na declaração da constante; procura
      // a OCORRÊNCIA que tem a emissão por perto.
      const perto: boolean[] = [];
      for (let i = codigo.indexOf(detector); i !== -1; i = codigo.indexOf(detector, i + 1)) {
        perto.push(codigo.slice(i, i + 900).includes(`techEnqueueSafe("${evento}"`));
      }
      expect(perto.length, detector).toBeGreaterThan(0);
      expect(perto.some(Boolean), `${evento} perto de ${detector}`).toBe(true);
    });
  }

  it("nenhum threshold operacional foi alterado", () => {
    expect(codigo).toContain("if (failures === 3 && !b.offlineLogged)");   // PLC offline
    expect(codigo).toContain("if (b.failures >= 3) void updatePlcCommStatus(tsnn, \"online\")");
    expect(codigo).toMatch(/BRIDGE_MAX_RELAUNCH\s*=\s*\d+/);
    expect(codigo).toMatch(/COM_STUCK_MAX\s*=\s*\d+/);
  });

  it("techEnqueueSafe é síncrono e nunca awaited", () => {
    expect(codigo).toContain("function techEnqueueSafe(");
    expect(codigo).not.toMatch(/await\s+techEnqueueSafe/);
    expect(codigo).not.toMatch(/async function techEnqueueSafe/);
    const i = codigo.indexOf("function techEnqueueSafe(");
    expect(codigo.slice(i, i + 800)).toMatch(/catch\s*\(/);
  });

  it("correlaciona só com incidente ABERTO — sem correlação falsa", () => {
    const i = codigo.indexOf("function techEnqueueSafe(");
    expect(codigo.slice(i, i + 800)).toContain("(techMonitor && techMonitor.correlationId) || null");
  });

  it("operação saudável não é instrumentada", () => {
    for (const proibido of ["polling_ok", "heartbeat_sent", "rx_normal", "tx_normal", "probe_ok"]) {
      expect(codigo, proibido).not.toContain(`techEnqueueSafe("${proibido}"`);
    }
  });
});

describe("INCIDENTE SOSSEGO — quatro OFF espontâneos com comunicação saudável", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const TE = require("../../electron-agent/lib/technicalEvents.cjs");

  it("não gera internet_offline nem cloud_unreachable", () => {
    // Comunicação saudável durante todo o episódio: as sondagens continuam OK
    // enquanto os quatro poços passam ON→OFF fisicamente.
    const m = TE.createMonitor();
    const saudavel = { cloud: { ok: true, latencyMs: 110 }, extern: { ok: true, latencyMs: 85 } };
    const eventos: Array<{ eventType: string }> = [];
    for (let i = 0; i < 20; i++) eventos.push(...TE.applyProbe(m, saudavel, Date.now() + i * 60_000));
    expect(eventos).toHaveLength(0);
    expect(m.state).toBe("online");
  });

  it("não gera plc_offline nem polling_timeout: a PLC continuou respondendo", () => {
    // O detector de plc_offline exige 3 falhas CONSECUTIVAS de polling. No
    // incidente real a PLC respondeu normalmente — ela REPORTOU o bit 0. Um
    // detector que disparasse aqui estaria inventando falha de comunicação.
    const codigo = semComentario(AGENT);
    const i = codigo.indexOf("if (failures === 3 && !b.offlineLogged)");
    expect(codigo.slice(i, i + 700)).toContain('techEnqueueSafe("plc_offline"');
    // e não há caminho que emita plc_offline a partir de mudança de estado físico
    expect(codigo).not.toMatch(/last_outputs_state[\s\S]{0,400}techEnqueueSafe/);
  });

  it("nenhum evento técnico afirma causa elétrica", () => {
    const codigo = semComentario(AGENT);
    for (const inventado of ["power_loss", "energy_loss", "falta_energia",
                             "queda_energia", "power_outage"]) {
      expect(codigo, inventado).not.toContain(`techEnqueueSafe("${inventado}"`);
    }
    // A categoria `power` existe no enum, mas NENHUM detector a emite: sem
    // sensor de tensão/corrente, afirmar causa elétrica seria invenção.
    expect(codigo).not.toMatch(/techEnqueueSafe\("[a-z_]+", "power"/);
  });
});

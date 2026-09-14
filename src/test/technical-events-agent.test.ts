// @vitest-environment node
// Agent — monitor de conectividade e buffer local (módulos PUROS).
// A Edge Function de ingestão foi REMOVIDA: o Agent grava direto no PostgREST
// via RPC `record_agent_technical_event`, sem consumir Lovable Cloud.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TE = require("../../electron-agent/lib/technicalEvents.cjs");

const REPO = path.resolve(__dirname, "../..");
describe("B. monitor de internet — histerese e classificação", () => {
  const okP  = { cloud: { ok: true, latencyMs: 120 }, extern: { ok: true, latencyMs: 90 } };
  const bad  = { cloud: { ok: false, errorClass: "network" }, extern: { ok: false, errorClass: "network" } };
  const soCloud = { cloud: { ok: false, errorClass: "network", httpStatus: 503 }, extern: { ok: true, latencyMs: 80 } };
  const T = 1_700_000_000_000;
  let m: ReturnType<typeof TE.createMonitor>;
  beforeEach(() => { m = TE.createMonitor(); for (let i = 0; i < 2; i++) TE.applyProbe(m, okP, T); });

  it("5. uma falha NÃO marca offline", () => {
    expect(TE.applyProbe(m, bad, T + 1000)).toHaveLength(0);
    expect(m.state).toBe("online");
  });

  it("6. três falhas consecutivas → internet_offline", () => {
    TE.applyProbe(m, bad, T + 1000); TE.applyProbe(m, bad, T + 2000);
    const e = TE.applyProbe(m, bad, T + 3000);
    expect(e).toHaveLength(1);
    expect(e[0].eventType).toBe("internet_offline");
    expect(e[0].severity).toBe("critical");
  });

  it("7. recuperação → internet_restored com duração", () => {
    for (let i = 1; i <= 3; i++) TE.applyProbe(m, bad, T + i * 1000);
    TE.applyProbe(m, okP, T + 60_000);
    const e = TE.applyProbe(m, okP, T + 120_000);
    expect(e[0].eventType).toBe("internet_restored");
    expect(e[0].payload.duration_seconds).toBeGreaterThan(0);
  });

  it("8. nuvem falha e externo OK → cloud_unreachable, NÃO internet_offline", () => {
    let ev8: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
    for (let i = 1; i <= 3; i++) ev8 = TE.applyProbe(m, soCloud, T + i * 1000);
    expect(ev8[0].eventType).toBe("cloud_unreachable");
    expect(ev8[0].payload.http_status).toBe(503);
  });

  it("10. falha de DNS tem classe própria", () => {
    const dns = { cloud: { ok: false, errorClass: "dns" }, extern: { ok: false, errorClass: "dns" } };
    let e: Array<{ eventType: string }> = [];
    for (let i = 1; i <= 3; i++) e = TE.applyProbe(m, dns, T + i * 1000);
    expect(e[0].eventType).toBe("dns_failure");
  });

  it("latência elevada e recuperação são eventos próprios", () => {
    const lento = { cloud: { ok: true, latencyMs: 5000 }, extern: { ok: true, latencyMs: 80 } };
    let e: Array<{ eventType: string }> = [];
    for (let i = 1; i <= 3; i++) e = TE.applyProbe(m, lento, T + i * 1000);
    expect(e[0].eventType).toBe("high_latency");
    for (let i = 4; i <= 6; i++) e = TE.applyProbe(m, okP, T + i * 1000);
    expect(e[0].eventType).toBe("latency_recovered");
  });

  it("13. o incidente compartilha correlation_id e fecha na recuperação", () => {
    let abre: Array<{ correlationId: string }> = [];
    for (let i = 1; i <= 3; i++) abre = TE.applyProbe(m, bad, T + i * 1000);
    const cid = abre[0].correlationId;
    TE.applyProbe(m, okP, T + 60_000);
    const fecha = TE.applyProbe(m, okP, T + 120_000);
    expect(fecha[0].correlationId).toBe(cid);
    expect(m.correlationId).toBeNull();       // não vaza para o próximo incidente
  });

  it("22 e 23. sondagem normal NÃO gera evento", () => {
    for (let i = 0; i < 30; i++) expect(TE.applyProbe(m, okP, T + i * 60_000)).toHaveLength(0);
  });
});

describe("C. buffer local durável", () => {
  let dir = "", file = "";
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "renov-buf-")); file = path.join(dir, "tech.ndjson"); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ } });

  const mk = (id: string, occ: string) => ({ clientEventId: id, eventType: "internet_offline", occurredAt: occ });

  it("11, 12 e 14. sobrevive a restart e preserva occurred_at e ordem", () => {
    const t1 = "2026-09-05T10:00:00.000Z", t2 = "2026-09-05T10:01:00.000Z";
    TE.bufferAppend(file, mk("a", t1)); TE.bufferAppend(file, mk("b", t2));
    const lido = TE.bufferRead(file);   // releitura = novo processo
    expect(lido.map((e: { clientEventId: string }) => e.clientEventId)).toEqual(["a", "b"]);
    expect(lido[0].occurredAt).toBe(t1);
  });

  it("13 e 16. flush remove só os confirmados — retry não duplica", () => {
    TE.bufferAppend(file, mk("a", "2026-09-05T10:00:00.000Z"));
    TE.bufferAppend(file, mk("b", "2026-09-05T10:01:00.000Z"));
    TE.bufferDrop(file, ["a"]);
    expect(TE.bufferRead(file).map((e: { clientEventId: string }) => e.clientEventId)).toEqual(["b"]);
  });

  it("linha truncada por queda de energia não invalida o arquivo", () => {
    TE.bufferAppend(file, mk("a", "2026-09-05T10:00:00.000Z"));
    fs.appendFileSync(file, '{"clientEventId":"b","occ');   // append cortado
    expect(TE.bufferRead(file)).toHaveLength(1);
  });

  it("nunca lança, mesmo com caminho inválido", () => {
    expect(TE.bufferAppend("/proc/inexistente/x/y.ndjson", mk("a", "x"))).toBe(false);
    expect(TE.bufferRead("/nao/existe.ndjson")).toEqual([]);
  });
});

describe("D. não regressão — auditoria não toca na operação", () => {
  const PROIBIDOS = ["desired_running", "pending_command_id", "command_blocked_until",
    "public.commands", "run_automation_tick", "enqueue_reset_pump_command",
    "last_outputs_state", "platform_set_farm_suspended", "license_key"];
  const semComentario = (t: string) => t.split("\n")
    .filter((l) => { const x = l.trim(); return !x.startsWith("//") && !x.startsWith("*") && !x.startsWith("/*"); })
    .join("\n");
  const MOD = semComentario(fs.readFileSync(path.join(REPO, "electron-agent/lib/technicalEvents.cjs"), "utf8"));

  it("o módulo do Agent não escreve estado operacional", () => {
    for (const p of PROIBIDOS) expect(MOD, p).not.toContain(p);
  });

  it("o módulo nunca lança", () => {
    expect(() => TE.applyProbe(TE.createMonitor(), undefined, Date.now())).not.toThrow();
    expect(() => TE.applyProbe(TE.createMonitor(), {}, Date.now())).not.toThrow();
  });

  it("a Edge Function de ingestão não existe mais", () => {
    expect(fs.existsSync(path.join(REPO, "supabase/functions/technical-events-ingest"))).toBe(false);
  });
});

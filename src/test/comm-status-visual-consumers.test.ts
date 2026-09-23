// ─────────────────────────────────────────────────────────────────────────────
// communication_status não decide comunicação em componente visual
// ─────────────────────────────────────────────────────────────────────────────
// `equipments.communication_status` é um flag PERSISTIDO e está congelado: no
// NEW nada o escreve por passagem de tempo. O único escritor é o trigger
// auto_flip_online_on_telemetry, que só promove 'offline' → 'online' — e ainda
// exige `OLD.communication_status = 'offline'`, então quem está em 'unknown'
// nunca sai de lá. Medição de 22/09/2026, nas 10 fazendas:
//     online 64 (9 calados > janela) · unknown 61 (14 calados) · offline 3
// Os mesmos 64/9 do incidente de 21/09 — o campo não se moveu em 24 h.
//
// A regra única é frescor: last_communication (ou level_last_raw_at, para
// nível) contra farms.comm_timeout_minutes. Já vale no PumpCard
// (useDashboardEquipment) e no WhatsApp (semComunicacao), ambos intocados aqui.
//
// Nenhum comando é criado, nenhum frame enviado, nenhum dado escrito.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

const arquivo = (p: string) => readFileSync(p, "utf8");

const corpoDe = (src: string, assinatura: string): string => {
  const i = src.indexOf(assinatura);
  expect(i).toBeGreaterThan(-1);
  return src.slice(i, src.indexOf("\n}", i) + 2);
};

// linhas que realmente DECIDEM algo com o flag (ignora comentário e select)
const decisoriasDoFlag = (src: string): string[] =>
  src.split("\n")
    .filter((l) => l.includes("communication_status"))
    .map((l) => l.trimStart())
    .filter((l) => !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"))
    .filter((l) => !/\.select\(|selectCols|: string \| null/.test(l));

describe("consumidores visuais decidem por frescor, não pelo flag", () => {
  const alvos = [
    ["PeakHourBanner", "src/components/PeakHourBanner.tsx"],
    ["DemandaEnergia", "src/components/energy/DemandaEnergia.tsx"],
    ["CommunicationReport", "src/components/CommunicationReport.tsx"],
  ] as const;

  for (const [nome, caminho] of alvos) {
    it(`${nome} não usa communication_status para decidir`, () => {
      expect(decisoriasDoFlag(arquivo(caminho))).toEqual([]);
    });
  }

  it("PeakHourBanner e DemandaEnergia decidem por last_communication", () => {
    for (const p of ["src/components/PeakHourBanner.tsx",
                     "src/components/energy/DemandaEnergia.tsx"]) {
      const corpo = corpoDe(arquivo(p), "function isCommunicating(");
      expect(corpo).toMatch(/last_communication/);
      // o flag pode aparecer no comentário que explica por que ele saiu;
      // o que não pode é sobrar linha de código decidindo por ele
      expect(decisoriasDoFlag(corpo)).toEqual([]);
    }
  });

  it("CommunicationReport usa o helper compartilhado, sem duplicar a regra", () => {
    const src = arquivo("src/components/CommunicationReport.tsx");
    expect(src).toMatch(/import \{ isEquipmentOnline \} from "@\/hooks\/useDashboardEquipment"/);
    expect(src).toMatch(/online: isEquipmentOnline\(e\.last_communication\)/);
  });

  it("o helper reutilizado é o mesmo do PumpCard", () => {
    const hook = arquivo("src/hooks/useDashboardEquipment.ts");
    expect(hook).toMatch(/export const isEquipmentOnline/);
    expect(corpoDe(hook, "export const isEquipmentOnline")).toMatch(
      /getEquipmentCommunicationStatus\(lastComm\) !== "offline"/,
    );
  });
});

describe("o que NÃO pode ter mudado", () => {
  it("PumpCard segue lendo o status DERIVADO do hook, não o flag do banco", () => {
    const src = arquivo("src/components/dashboard/PumpCard.tsx");
    // a propriedade essencial: offline vem de pump.communicationStatus, que o
    // useDashboardEquipment calcula por frescor — nunca da coluna do banco
    expect(src).toMatch(/pump\.communicationStatus === "offline"/);
    expect(decisoriasDoFlag(src)).toEqual([]);
  });

  it("o WhatsApp segue com a própria regra, intocada (quando o repo a contém)", () => {
    // O repo de frontend carrega uma cópia ANTIGA da edge function (o deploy
    // sai do platform-replica-buddy). Só afirmamos onde a regra existe.
    const p = "supabase/functions/whatsapp-webhook/index.ts";
    if (!existsSync(p)) return;
    const src = arquivo(p);
    if (!src.includes("function semComunicacao(")) return;
    expect(corpoDe(src, "function semComunicacao(")).toMatch(/last_communication/);
  });

  it("nenhum consumidor visual escreve em equipments", () => {
    for (const p of ["src/components/PeakHourBanner.tsx",
                     "src/components/energy/DemandaEnergia.tsx",
                     "src/components/CommunicationReport.tsx"]) {
      const src = arquivo(p);
      expect(src).not.toMatch(/\.from\("equipments"\)\s*\.\s*(update|upsert|insert|delete)/);
      expect(src).not.toMatch(/communication_status\s*[:=]\s*["']/);
    }
  });
});

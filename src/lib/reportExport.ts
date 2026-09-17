import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { getWatermarkText } from "@/lib/securityClient";
import renovLogo from "@/assets/renov-logo.png";

export interface FarmHeaderInfo {
  name: string;
  city?: string | null;
  state?: string | null;
  phone?: string | null;
}

const DEFAULT_FARM: FarmHeaderInfo = { name: "Fazenda", city: null, state: null, phone: null };
// Usa o actor_label como veio (já resolvido no componente). null/vazio → "Desconhecido"
// (nunca "Sistema" inventado nem "Remoto (usuário não registrado)").
// Sem fallback textual: o que a tela mostra é o que sai no CSV e no PDF.
const safeAutomationUser = (user?: string | null) => (user ?? "").trim();

// ============================================================================
// Premium PDF Design System — shared across all reports
// ============================================================================

// Page geometry (mm)
const PAGE = {
  marginTop: 20,
  marginBottom: 20,
  marginLeft: 15,
  marginRight: 15,
};

// Colors (RGB tuples for jsPDF)
const COLOR = {
  textDark: [26, 26, 26] as [number, number, number],       // #1a1a1a
  textMid: [85, 85, 85] as [number, number, number],         // #555
  textLight: [119, 119, 119] as [number, number, number],    // #777
  divider: [224, 224, 224] as [number, number, number],      // #e0e0e0
  borderRow: [232, 232, 232] as [number, number, number],    // #e8e8e8
  navy: [30, 58, 95] as [number, number, number],            // #1e3a5f
  zebra: [248, 249, 250] as [number, number, number],        // #f8f9fa
  footer: [153, 153, 153] as [number, number, number],       // #999
  green: [22, 163, 74] as [number, number, number],          // #16a34a
  red: [220, 38, 38] as [number, number, number],            // #dc2626
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function formatFarmLocation(farm: FarmHeaderInfo): string {
  return [farm.city, farm.state].filter(Boolean).join(" - ");
}

/**
 * Draws the premium header on the FIRST page only.
 * Returns the Y coordinate (mm) where the report title block ends — content below should start there.
 */
async function drawHeader(doc: jsPDF, farm: FarmHeaderInfo, title: string, subtitle?: string): Promise<number> {
  const pageW = doc.internal.pageSize.getWidth();
  const left = PAGE.marginLeft;
  const right = pageW - PAGE.marginRight;
  const topY = PAGE.marginTop;

  // Logo (left, ~50px ≈ 13.2mm height; jsPDF mm units)
  const logoH = 13.2;
  const logoW = 26;
  try {
    const img = await loadImage(renovLogo);
    doc.addImage(img, "PNG", left, topY, logoW, logoH);
  } catch {
    // fallback: no logo
  }

  // Brand block to the right of logo
  const textX = left + logoW + 5;
  let y = topY + 4.5;

  doc.setTextColor(...COLOR.textDark);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Gestor de Bombas Renov", textX, y);

  y += 4.8;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...COLOR.textMid);
  doc.text(farm.name || "Fazenda", textX, y);

  const loc = formatFarmLocation(farm);
  if (loc) {
    y += 4.2;
    doc.setFontSize(9);
    doc.setTextColor(...COLOR.textLight);
    doc.text(loc, textX, y);
  }

  // Generation date — far right top
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...COLOR.textLight);
  const genText = `Gerado em ${new Date().toLocaleString("pt-BR")}`;
  const genW = doc.getTextWidth(genText);
  doc.text(genText, right - genW, topY + 4.5);

  // Divider line below header
  const dividerY = topY + logoH + 5;
  doc.setDrawColor(...COLOR.divider);
  doc.setLineWidth(0.3);
  doc.line(left, dividerY, right, dividerY);

  // Report title
  let titleY = dividerY + 8;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(...COLOR.textDark);
  doc.text(title, left, titleY);

  if (subtitle) {
    titleY += 5.5;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(...COLOR.textMid);
    doc.text(subtitle, left, titleY);
  }

  return titleY + 6;
}

/** Footer drawn on every page. */
function drawFooter(doc: jsPDF) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const left = PAGE.marginLeft;
  const right = pageW - PAGE.marginRight;
  const lineY = pageH - PAGE.marginBottom + 6;
  const textY = lineY + 4;

  doc.setDrawColor(...COLOR.divider);
  doc.setLineWidth(0.3);
  doc.line(left, lineY, right, lineY);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(...COLOR.footer);

  const year = new Date().getFullYear();
  doc.text(`Renov Tecnologia Agrícola® — Todos os direitos reservados © ${year}`, left, textY);

  const totalPages = (doc as unknown as { internal: { getNumberOfPages: () => number } }).internal.getNumberOfPages();
  const current = (doc as unknown as { internal: { getCurrentPageInfo: () => { pageNumber: number } } }).internal.getCurrentPageInfo().pageNumber;
  const pageText = `Página ${current} de ${totalPages}`;
  const w = doc.getTextWidth(pageText);
  doc.text(pageText, right - w, textY);
}

/** Marca d'água diagonal com identificação do usuário exportador. */
function drawWatermark(doc: jsPDF) {
  let text = "";
  try {
    text = getWatermarkText();
  } catch {
    text = "";
  }
  if (!text) return;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const gs = (doc as any).GState ? (doc as any).GState({ opacity: 0.08 }) : null;
  doc.saveGraphicsState?.();
  if (gs) (doc as any).setGState(gs);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.setTextColor(120, 120, 120);
  doc.text(text, pageW / 2, pageH / 2, { align: "center", angle: 35 });
  doc.restoreGraphicsState?.();
}

/** Apply footer to all pages at the end. */
function applyFooterToAllPages(doc: jsPDF) {
  const total = (doc as unknown as { internal: { getNumberOfPages: () => number } }).internal.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    drawWatermark(doc);
    drawFooter(doc);
  }
}


/** Shared autoTable styling. */
function sharedTableOptions(startY: number, opts: {
  head: string[][];
  body: (string | number)[][];
  columnStyles?: Record<number, { halign?: "left" | "center" | "right"; cellWidth?: number | "auto" }>;
  didParseCell?: (data: import("jspdf-autotable").CellHookData) => void;
  foot?: (string | number)[][];
}) {

  return {
    startY,
    head: opts.head,
    body: opts.body,
    foot: opts.foot,
    margin: { left: PAGE.marginLeft, right: PAGE.marginRight, bottom: PAGE.marginBottom + 8 },
    styles: {
      font: "helvetica",
      fontSize: 9,
      cellPadding: { top: 3.5, right: 3, bottom: 3.5, left: 3 },
      textColor: COLOR.textDark,
      lineColor: COLOR.borderRow,
      lineWidth: { top: 0, right: 0, bottom: 0.2, left: 0 },
      minCellHeight: 8,
    },
    headStyles: {
      fillColor: COLOR.navy,
      textColor: [255, 255, 255] as [number, number, number],
      fontSize: 9,
      fontStyle: "bold" as const,
      halign: "left" as const,
      cellPadding: { top: 4, right: 3, bottom: 4, left: 3 },
      lineWidth: 0,
    },
    bodyStyles: {
      fillColor: [255, 255, 255] as [number, number, number],
    },
    alternateRowStyles: {
      fillColor: COLOR.zebra,
    },
    footStyles: {
      fillColor: [240, 243, 248] as [number, number, number],
      textColor: COLOR.textDark,
      fontStyle: "bold" as const,
      fontSize: 9,
    },
    columnStyles: opts.columnStyles,
    didParseCell: opts.didParseCell,
  };
}

// Uppercase head helper
const upperHead = (cols: string[]) => [cols.map((c) => c.toUpperCase())];

// ============================================================================
// AUTOMAÇÃO
// ============================================================================

export interface AutomacaoExportRow {
  date: string;
  time: string;
  pump: string;
  action: string;
  origin: string;
  user: string;
  result?: "success" | "fail" | string;
}

// "OK" só para sucesso/executed; timeout/error/fail → "Falhou".
const resultLabel = (r?: string) => {
  const s = (r ?? "").toLowerCase();
  return s === "fail" || s === "failed" || s === "timeout" || s === "error" ? "Falhou" : "OK";
};

export async function exportAutomacaoPDF(data: AutomacaoExportRow[], farm: FarmHeaderInfo = DEFAULT_FARM, period?: { from: string; to: string }) {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });

  const subtitle = (() => {
    const parts: string[] = [];
    if (period?.from && period?.to) {
      const fmt = (d: string) => d.includes("-") ? d.split("-").reverse().join("/") : d;
      parts.push(`Período: ${fmt(period.from)} a ${fmt(period.to)}`);
    }
    parts.push(`${data.length} ${data.length === 1 ? "evento" : "eventos"}`);
    return parts.join(" | ");
  })();

  const startY = await drawHeader(doc, farm, "Relatório de Automação", subtitle);

  autoTable(doc, sharedTableOptions(startY, {
    head: upperHead(["Data", "Hora", "Equipamento", "Ação", "Origem", "Usuário"]),
    body: data.map((r) => [r.date, r.time, r.pump, r.action, r.origin, safeAutomationUser(r.user)]),
    columnStyles: {
      0: { cellWidth: 24 },   // Data — largura suficiente p/ "DD/MM/AAAA" sem cortar o ano
      1: { cellWidth: 15 },
    },
    didParseCell: (data) => {
      if (data.section !== "body") return;
      const txt = (data.cell.text?.[0] ?? "").toLowerCase();
      // Color "Ação" column (index 3)
      if (data.column.index === 3) {
        if (txt.includes("ligar") || txt === "ligada" || txt.includes("ligou")) {
          data.cell.styles.textColor = COLOR.green;
          data.cell.styles.fontStyle = "bold";
        } else if (txt.includes("desligar") || txt === "desligada" || txt.includes("desligou")) {
          data.cell.styles.textColor = COLOR.red;
          data.cell.styles.fontStyle = "bold";
        }
      }
    },

  }));

  applyFooterToAllPages(doc);
  doc.save("relatorio-automacao.pdf");
}

// ============================================================================
// HORÍMETRO
// ============================================================================

function fmtHM(hoursDecimal: number): string {
  const totalMinutes = Math.max(0, Math.round(hoursDecimal * 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, "0")}min`;
}

export interface HorimetroPumpReport {
  pump: string;
  days: { day: string; hours: number }[];
  monthTotal: number;
  currentMonthTotal: number;
  yearTotal: number;
}

export async function exportHorimetroPDF(data: HorimetroPumpReport[], farm: FarmHeaderInfo = DEFAULT_FARM) {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const subtitle = `${data.length} ${data.length === 1 ? "equipamento" : "equipamentos"}`;
  let cursorY = await drawHeader(doc, farm, "Relatório de Horímetro", subtitle);

  const pageH = doc.internal.pageSize.getHeight();
  const bottomLimit = pageH - PAGE.marginBottom - 12;

  for (let i = 0; i < data.length; i++) {
    const pump = data[i];

    // Need at least ~30mm for the pump block header + first rows
    if (cursorY > bottomLimit - 30) {
      doc.addPage();
      cursorY = PAGE.marginTop;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...COLOR.textDark);
    doc.text(pump.pump, PAGE.marginLeft, cursorY);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...COLOR.textMid);
    doc.text(
      `Período: ${fmtHM(pump.monthTotal)}   |   Mês: ${fmtHM(pump.currentMonthTotal)}   |   Ano: ${fmtHM(pump.yearTotal)}`,
      PAGE.marginLeft,
      cursorY + 5,
    );

    autoTable(doc, sharedTableOptions(cursorY + 9, {
      head: upperHead(["Dia", "Tempo Ligada"]),
      body: pump.days.length === 0
        ? [["—", "Sem registros no período"]]
        : pump.days.map((d) => [d.day, fmtHM(d.hours)]),
      columnStyles: {
        0: { cellWidth: 40 },
        1: { halign: "right" },
      },
    }));

    cursorY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;
  }

  applyFooterToAllPages(doc);
  doc.save("relatorio-horimetro.pdf");
}

// ============================================================================
// DEMANDA
// ============================================================================

export interface DemandReportRow {
  date: string;
  pump: string;
  powerKw: number;
  hoursOn: number;
  consumptionKwh: number;
}

export async function exportDemandaPDF(
  data: DemandReportRow[],
  summary: { contractedDemand: number; unit: string; totalKwh: number; period: string },
  farm: FarmHeaderInfo = DEFAULT_FARM,
) {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });

  const subtitle = `${summary.period}  |  Demanda contratada: ${summary.contractedDemand} ${summary.unit}  |  Consumo total: ${summary.totalKwh.toFixed(1)} kWh`;
  const startY = await drawHeader(doc, farm, "Relatório de Demanda de Energia", subtitle);

  autoTable(doc, sharedTableOptions(startY, {
    head: upperHead(["Data", "Equipamento", "Potência (kW)", "Horas Ligada", "Consumo (kWh)"]),
    body: data.map((r) => [r.date, r.pump, String(r.powerKw), `${r.hoursOn}h`, r.consumptionKwh.toFixed(1)]),
    foot: [["", "", "", "TOTAL", `${summary.totalKwh.toFixed(1)} kWh`]],
    columnStyles: {
      0: { cellWidth: 25 },
      2: { halign: "right" },
      3: { halign: "right" },
      4: { halign: "right" },
    },
  }));

  applyFooterToAllPages(doc);
  doc.save("relatorio-demanda-energia.pdf");
}

// ============================================================================
// CSV (unchanged behavior)
// ============================================================================

export function exportAutomacaoCSV(data: { date: string; time: string; pump: string; action: string; origin: string; user: string }[]) {
  const header = "Data,Hora,Equipamento,Ação,Origem,Usuário";
  const rows = data.map((r) => `${r.date},${r.time},${r.pump},${r.action},${r.origin},${safeAutomationUser(r.user)}`);
  const csv = [header, ...rows].join("\n");
  downloadFile(csv, "relatorio-automacao.csv", "text/csv");
}

export function exportHorimetroCSV(data: HorimetroPumpReport[]) {
  const header = "Equipamento,Dia,Tempo Ligada";
  const rows = data.flatMap((p) => p.days.map((d) => `${p.pump},${d.day},${fmtHM(d.hours)}`));
  const totals = [
    "",
    "Equipamento,Métrica,Total",
    ...data.flatMap((p) => [
      `${p.pump},Período selecionado,${fmtHM(p.monthTotal)}`,
      `${p.pump},Mês corrente,${fmtHM(p.currentMonthTotal)}`,
      `${p.pump},Ano corrente,${fmtHM(p.yearTotal)}`,
    ]),
  ];
  const csv = [header, ...rows, ...totals].join("\n");
  downloadFile(csv, "relatorio-horimetro.csv", "text/csv");
}

export function exportDemandaCSV(
  data: DemandReportRow[],
  summary: { contractedDemand: number; unit: string; totalKwh: number; period: string },
) {
  const info = `Período:,${summary.period}\nDemanda Contratada:,${summary.contractedDemand} ${summary.unit}\nConsumo Total:,${summary.totalKwh.toFixed(1)} kWh\n`;
  const header = "Data,Equipamento,Potência (kW),Horas Ligada,Consumo (kWh)";
  const rows = data.map((r) => `${r.date},${r.pump},${r.powerKw},${r.hoursOn},${r.consumptionKwh.toFixed(1)}`);
  const csv = [info, header, ...rows].join("\n");
  downloadFile(csv, "relatorio-demanda-energia.csv", "text/csv");
}

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob(["\uFEFF" + content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================================================
// INEMA — Compliance (kit fiscalização): uso do dia vs limites da outorga.
// ============================================================================
export interface InemaComplianceRow {
  well: string;
  hoursToday: number;
  hoursLimit: number | null;
  volumeToday: number | null;
  volumeLimit: number | null;
  monthVolume: number | null;
  monthVolumeLimit: number | null;
  status: string;              // "OK" | "Atenção" | "Risco"
  portaria: string | null;
  titular: string | null;
  expiry: string | null;       // dd/mm/aaaa
  // Dados institucionais da outorga (INEMA)
  processNumber?: string | null;
  maxFlowM3h?: number | null;
  waterUsePurpose?: string | null;
  hydrographicBasin?: string | null;
}

const nOr = (v: number | null, d = 0) => (v == null ? "—" : v.toLocaleString("pt-BR", { maximumFractionDigits: d }));

/** Junta valores únicos não-nulos das outorgas para exibir no cabeçalho. */
function uniqueValues(rows: InemaComplianceRow[], key: keyof InemaComplianceRow): string {
  const set = new Set<string>();
  for (const r of rows) {
    const v = r[key];
    if (v == null || v === "") continue;
    set.add(String(v));
  }
  return set.size === 0 ? "—" : Array.from(set).join(" · ");
}

export async function exportInemaCompliancePDF(rows: InemaComplianceRow[], farm: FarmHeaderInfo = DEFAULT_FARM) {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape" });
  const gen = new Date().toLocaleString("pt-BR");
  let startY = await drawHeader(doc, farm, "Relatório de Compliance Hídrico — INEMA",
    `Uso do dia vs. outorga · Gerado em ${gen}`);

  // Bloco institucional da outorga (cabeçalho): processo, finalidade, bacia, vazão máx.
  const processos = uniqueValues(rows, "processNumber");
  const finalidades = uniqueValues(rows, "waterUsePurpose");
  const bacias = uniqueValues(rows, "hydrographicBasin");
  const vazoes = (() => {
    const vs = rows.map((r) => r.maxFlowM3h).filter((v): v is number => v != null);
    if (vs.length === 0) return "—";
    const uniq = Array.from(new Set(vs));
    return uniq.map((v) => v.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " m³/h").join(" · ");
  })();

  const infoLines: [string, string][] = [
    ["Processo INEMA", processos],
    ["Finalidade de uso", finalidades],
    ["Bacia / Aquífero", bacias],
    ["Vazão máx. outorgada", vazoes],
  ];
  doc.setFontSize(9);
  const boxX = PAGE.marginLeft;
  const boxW = doc.internal.pageSize.getWidth() - PAGE.marginLeft - PAGE.marginRight;
  const lineH = 4.5;
  const boxH = infoLines.length * lineH + 4;
  doc.setDrawColor(...COLOR.divider);
  doc.setFillColor(...COLOR.zebra);
  doc.roundedRect(boxX, startY, boxW, boxH, 1.5, 1.5, "FD");
  let y = startY + 4;
  for (const [k, v] of infoLines) {
    doc.setTextColor(...COLOR.textLight);
    doc.setFont("helvetica", "bold");
    doc.text(k + ":", boxX + 2, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...COLOR.textDark);
    doc.text(v, boxX + 40, y);
    y += lineH;
  }
  startY = startY + boxH + 3;

  autoTable(doc, sharedTableOptions(startY, {
    head: upperHead(["Poço", "Horas hoje", "Limite h", "Volume hoje (m³)", "Limite/dia", "Volume mês (m³)", "Limite/mês", "Status", "Portaria", "Validade"]),
    body: rows.map((r) => [
      r.well, nOr(r.hoursToday, 2), nOr(r.hoursLimit, 0),
      nOr(r.volumeToday, 0), nOr(r.volumeLimit, 0),
      nOr(r.monthVolume, 0), nOr(r.monthVolumeLimit, 0),
      r.status, r.portaria ?? "—", r.expiry ?? "—",
    ]),
    columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" } },
    didParseCell: (data) => {
      if (data.section !== "body" || data.column.index !== 7) return;
      const t = (data.cell.text?.[0] ?? "").toLowerCase();
      if (t.includes("risco")) { data.cell.styles.textColor = COLOR.red; data.cell.styles.fontStyle = "bold"; }
      else if (t.includes("aten")) { data.cell.styles.textColor = [180, 130, 0]; data.cell.styles.fontStyle = "bold"; }
      else if (t === "ok") { data.cell.styles.textColor = COLOR.green; }
    },
  }));
  applyFooterToAllPages(doc);
  doc.save("compliance-inema.pdf");
}

// ============================================================================
// Compat shim: InemaReportTab usa nomes antigos (exportInemaPDF/XLSX).
// ============================================================================
export interface InemaPermitHeader {
  portaria_number: string | null;
  process_number: string | null;
  water_use_purpose: string | null;
  hydrographic_basin: string | null;
  expiration_date: string | null;
  max_flow_m3h: number | null;
  max_daily_volume_m3: number | null;
  max_daily_hours: number | null;
  equipment_id?: string | null;
}

export interface InemaFarmHeader {
  name: string;
  city: string | null;
  state: string | null;
  cnpj: string | null;
  proprietario: string | null;
  endereco: string | null;
  zip_code?: string | null;
  phone?: string | null;
  email?: string | null;
  latitude: number | null;
  longitude: number | null;
  outorgaNumero: string | null;
  orgao: string | null;
  vazaoOutorgadaM3h: number | null;
  permits?: InemaPermitHeader[];
}

export interface InemaReportRow {
  bucketLabel: string;
  pump: string;
  hours: number;
  flowRate: number | null;
  volume: number | null;
  accumulated: number;
}

export interface InemaPeriodComplianceRow {
  pump: string;
  hours: number;
  flow: number | null;
  volume: number;
  periodLimit: number | null; // m³ para o período selecionado
  pct: number | null; // 0..1+
}

export interface InemaReportData {
  farm: InemaFarmHeader;
  period: { fromIso: string; toIso: string };
  grouping: "dia" | "semana" | "mes";
  rows: InemaReportRow[];
  totalsByPump: { pump: string; hours: number; volume: number; flow: number | null }[];
  totalFarm: number;
  /** Resumo de compliance por poço (Volume vs. Limite do Período). Opcional. */
  complianceByPump?: InemaPeriodComplianceRow[];
  /** Assinatura do declarante e RT — quando presentes, gera a página final. */
  titular?: InemaSignatureTitular | null;
  rt?: InemaSignatureRT | null;
}

function inemaFarmToHeader(f: InemaFarmHeader): FarmHeaderInfo {
  return {
    name: f.name,
    city: f.city ?? undefined,
    state: f.state ?? undefined,
  } as FarmHeaderInfo;
}

function fmtDateBRIso(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("T")[0].split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

function drawIdentificationBlock(doc: jsPDF, startY: number, farm: InemaFarmHeader): number {
  const pageW = doc.internal.pageSize.getWidth();
  const left = PAGE.marginLeft;
  const right = pageW - PAGE.marginRight;
  const innerW = right - left;
  const colW = innerW / 2;
  const rowH = 5.2;
  const padX = 3;

  const farmFields: [string, string][] = [
    ["Proprietário/Titular", farm.proprietario ?? "—"],
    ["CNPJ/CPF", farm.cnpj ?? "—"],
    ["Endereço", farm.endereco ?? "—"],
    ["CEP", farm.zip_code ?? "—"],
    ["Cidade/UF", [farm.city, farm.state].filter(Boolean).join(" / ") || "—"],
    ["Telefone", farm.phone ?? "—"],
    ["E-mail", farm.email ?? "—"],
  ];

  const permit = (farm.permits && farm.permits[0]) || null;
  const permitFields: [string, string][] = [
    ["Nº da Portaria", permit?.portaria_number ?? "—"],
    ["Nº do Processo INEMA", permit?.process_number ?? permit?.portaria_number ?? "—"],
    ["Finalidade de uso", permit?.water_use_purpose ?? "—"],
    ["Bacia/Aquífero", permit?.hydrographic_basin ?? "—"],
    ["Validade", fmtDateBRIso(permit?.expiration_date ?? null)],
    ["Vazão máx. outorgada", permit?.max_flow_m3h != null ? `${permit.max_flow_m3h.toLocaleString("pt-BR")} m³/h` : "—"],
    ["Volume máx. diário", permit?.max_daily_volume_m3 != null ? `${permit.max_daily_volume_m3.toLocaleString("pt-BR")} m³/dia` : "—"],
    ["Horas máx./dia", permit?.max_daily_hours != null ? `${permit.max_daily_hours} h` : "—"],
  ];

  const rows = Math.max(farmFields.length, permitFields.length);
  const blockH = rowH * (rows + 1) + 4;

  // Section titles
  doc.setFillColor(...COLOR.navy);
  doc.rect(left, startY, colW - 1, rowH, "F");
  doc.rect(left + colW + 1, startY, colW - 1, rowH, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("DADOS DA FAZENDA", left + padX, startY + rowH - 1.6);
  doc.text("DADOS DA OUTORGA", left + colW + 1 + padX, startY + rowH - 1.6);

  // Body rows
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  const labelW = 38;
  for (let i = 0; i < rows; i++) {
    const y = startY + rowH + i * rowH;
    if (i % 2 === 0) {
      doc.setFillColor(...COLOR.zebra);
      doc.rect(left, y, colW - 1, rowH, "F");
      doc.rect(left + colW + 1, y, colW - 1, rowH, "F");
    }
    doc.setTextColor(...COLOR.textMid);
    doc.setFont("helvetica", "bold");
    if (farmFields[i]) doc.text(farmFields[i][0] + ":", left + padX, y + rowH - 1.6);
    if (permitFields[i]) doc.text(permitFields[i][0] + ":", left + colW + 1 + padX, y + rowH - 1.6);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...COLOR.textDark);
    if (farmFields[i]) {
      const v = doc.splitTextToSize(farmFields[i][1], colW - padX * 2 - labelW)[0] ?? "";
      doc.text(v, left + padX + labelW, y + rowH - 1.6);
    }
    if (permitFields[i]) {
      const v = doc.splitTextToSize(permitFields[i][1], colW - padX * 2 - labelW)[0] ?? "";
      doc.text(v, left + colW + 1 + padX + labelW, y + rowH - 1.6);
    }
  }

  // Border
  doc.setDrawColor(...COLOR.divider);
  doc.setLineWidth(0.3);
  doc.rect(left, startY, colW - 1, rowH * (rows + 1));
  doc.rect(left + colW + 1, startY, colW - 1, rowH * (rows + 1));

  return startY + blockH;
}


export async function exportInemaPDF(data: InemaReportData) {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape" });
  const gen = new Date().toLocaleString("pt-BR");
  const subtitle = `Período ${data.period.fromIso} → ${data.period.toIso} · Gerado em ${gen}`;
  const headerY = await drawHeader(doc, inemaFarmToHeader(data.farm),
    "Relatório INEMA — Captação de Água Subterrânea", subtitle);
  let startY = drawIdentificationBlock(doc, headerY + 2, data.farm) + 4;

  // TODAS as outorgas da fazenda (INEMA exige que todas apareçam no relatório).
  // O quadro "DADOS DA OUTORGA" acima mostra a principal; esta seção lista todas.
  const permitsAll = data.farm.permits ?? [];
  if (permitsAll.length > 1) {
    doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(...COLOR.navy);
    doc.text("OUTORGAS VIGENTES DA FAZENDA", PAGE.marginLeft, startY);
    startY += 3;
    autoTable(doc, sharedTableOptions(startY, {
      head: upperHead(["Portaria", "Processo", "Validade", "Vazão máx. (m³/h)", "Volume máx. (m³/dia)", "Horas/dia"]),
      body: permitsAll.map((p) => [
        p.portaria_number ?? "—",
        p.process_number ?? "—",
        fmtDateBRIso(p.expiration_date),
        nOr(p.max_flow_m3h, 2),
        nOr(p.max_daily_volume_m3, 2),
        p.max_daily_hours == null ? "—" : String(p.max_daily_hours),
      ]),
      columnStyles: { 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" } },
    }));
    startY = (doc as any).lastAutoTable.finalY + 6;
  }

  autoTable(doc, sharedTableOptions(startY, {
    head: upperHead(["Período", "Poço", "Horas", "Vazão (m³/h)", "Volume (m³)", "Acumulado (m³)"]),
    body: data.rows.map((r) => [
      r.bucketLabel, r.pump,
      nOr(r.hours, 2),
      nOr(r.flowRate, 2),
      nOr(r.volume, 2),
      nOr(r.accumulated, 2),
    ]),
    columnStyles: { 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" } },
  }));

  // Preferir tabela de compliance (com limite do período + % utilização) quando disponível
  if (data.complianceByPump && data.complianceByPump.length > 0) {
    autoTable(doc, sharedTableOptions((doc as any).lastAutoTable.finalY + 8, {
      head: upperHead([
        "Poço", "Horas Totais", "Vazão (m³/h)", "Volume Total (m³)",
        "Limite do Período (m³)", "Índice de Utilização (%)",
      ]),
      body: data.complianceByPump.map((p) => [
        p.pump,
        nOr(p.hours, 2),
        nOr(p.flow, 2),
        nOr(p.volume, 2),
        p.periodLimit == null ? "—" : nOr(p.periodLimit, 2),
        p.pct == null ? "—" : `${(p.pct * 100).toFixed(1)}%`,
      ]),
      columnStyles: {
        1: { halign: "right" }, 2: { halign: "right" },
        3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" },
      },
    }));
  } else if (data.totalsByPump.length > 0) {
    autoTable(doc, sharedTableOptions((doc as any).lastAutoTable.finalY + 8, {
      head: upperHead(["Poço", "Horas totais", "Vazão (m³/h)", "Volume total (m³)"]),
      body: data.totalsByPump.map((p) => [
        p.pump, nOr(p.hours, 2), nOr(p.flow, 2), nOr(p.volume, 2),
      ]),
      columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" } },
    }));
  }

  // Página final de assinatura (opcional — só se algum dado foi passado)
  if (data.titular || data.rt) {
    const periodLabel = `${fmtDateBRIso(data.period.fromIso)} a ${fmtDateBRIso(data.period.toIso)}`;
    drawFinalSignaturePage(doc, periodLabel, data.titular ?? null, data.rt ?? null);
  }

  applyFooterToAllPages(doc);
  doc.save(`inema-${data.period.fromIso}-${data.period.toIso}.pdf`);
}

export function exportInemaXLSX(data: InemaReportData) {
  const header = ["Período", "Poço", "Horas", "Vazão (m³/h)", "Volume (m³)", "Acumulado (m³)"];
  const rows = data.rows.map((r) => [
    r.bucketLabel, r.pump, r.hours, r.flowRate ?? "", r.volume ?? "", r.accumulated,
  ]);
  const totals = data.totalsByPump.map((p) => [p.pump, p.hours, p.flow ?? "", p.volume]);
  const csv = [
    [`Fazenda: ${data.farm.name}`],
    [`Período: ${data.period.fromIso} a ${data.period.toIso}`],
    [],
    header,
    ...rows,
    [],
    ["Totais por Poço"],
    ["Poço", "Horas totais", "Vazão (m³/h)", "Volume total (m³)"],
    ...totals,
    [],
    ["Total da fazenda (m³)", data.totalFarm],
  ]
    .map((r) => r.map((c) => {
      // Arredonda qualquer n\u00FAmero a 2 casas (evita 2597.6899999999996 no CSV).
      const cell = typeof c === "number" ? Math.round(c * 100) / 100 : c;
      const s = String(cell ?? "");
      return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(";"))
    .join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `inema-${data.period.fromIso}-${data.period.toIso}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================================================
// Relatório Anual INEMA — resumo mensal por poço + gráfico uso vs. limite
// ============================================================================
export interface InemaAnnualMonth {
  hours: number;
  volume: number;
  limit: number; // m³ mês
  pct: number; // 0..1+
}
export interface InemaAnnualPump {
  id: string;
  name: string;
  flowRate: number | null;
  maxDailyVolumeM3: number | null;
  maxDailyHours: number | null;
  monthly: InemaAnnualMonth[]; // length = 12
  totalHours: number;
  totalVolume: number;
  totalLimit: number;
  latitude?: number | null;
  longitude?: number | null;
  capturePoint?: string | null;
}
export interface InemaSignatureTitular {
  name: string;
  cpfCnpj: string;
  /** Qualidade do declarante: titular da outorga, procurador legal ou representante legal. */
  capacity?: "titular" | "procurador" | "representante" | null;
  /** Nº da procuração, quando o declarante for procurador legal. */
  attorneyNumber?: string | null;
  digital?: boolean;
  signedAt?: string; // ISO
}
export interface InemaSignatureRT {
  name: string;
  formation?: string;
  crea: string;
  art: string;
  digital?: boolean;
  signedAt?: string;
}

export interface InemaAnnualReportData {
  farm: InemaFarmHeader;
  year: number;
  pumps: InemaAnnualPump[];
  titular?: InemaSignatureTitular | null;
  rt?: InemaSignatureRT | null;
}

const MESES_ABREV = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];

// Paleta premium RENOV (usada no Relatório Anual INEMA)
const BRAND = {
  navy: [11, 42, 74] as [number, number, number],           // #0B2A4A
  navyDark: [7, 28, 51] as [number, number, number],        // #071C33
  navySoft: [230, 236, 244] as [number, number, number],    // #E6ECF4
  green: [5, 150, 105] as [number, number, number],         // #059669
  amber: [217, 119, 6] as [number, number, number],         // #D97706
  red: [220, 38, 38] as [number, number, number],           // #DC2626
  ink: [17, 24, 39] as [number, number, number],            // #111827
  slate: [75, 85, 99] as [number, number, number],          // #4B5563
  muted: [107, 114, 128] as [number, number, number],       // #6B7280
  zebra: [249, 250, 251] as [number, number, number],       // #F9FAFB
  hair: [229, 231, 235] as [number, number, number],        // #E5E7EB
  chartBar: [209, 213, 219] as [number, number, number],    // #D1D5DB (limite)
};

function pctColor(p: number): [number, number, number] {
  if (p >= 1) return BRAND.red;
  if (p >= 0.8) return BRAND.amber;
  return BRAND.green;
}

/** Formata decimal em DMS (graus, minutos, segundos) com sufixo hemisfério. */
function toDMS(dec: number | null | undefined, isLat: boolean): string {
  if (dec == null || Number.isNaN(dec)) return "—";
  const hemi = isLat ? (dec >= 0 ? "N" : "S") : (dec >= 0 ? "E" : "W");
  const abs = Math.abs(dec);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  return `${deg}°${String(min).padStart(2, "0")}'${sec.toFixed(2)}"${hemi}`;
}

// ============================================================================
// Relatório Anual INEMA — layout PREMIUM (paisagem, 1 poço por página)
// ============================================================================

/** Banner navy no topo da página com logo + título + ano/data. Retorna Y final. */
async function drawAnnualBanner(
  doc: jsPDF,
  pump: InemaAnnualPump,
  year: number,
  permit: InemaPermitHeader | null,
  farm: InemaFarmHeader,
  generatedAt: string,
): Promise<number> {
  const pageW = doc.internal.pageSize.getWidth();
  const bannerH = 16;

  // Faixa navy
  doc.setFillColor(...BRAND.navy);
  doc.rect(0, 0, pageW, bannerH, "F");
  // Accent verde
  doc.setFillColor(...BRAND.green);
  doc.rect(0, bannerH, pageW, 0.9, "F");

  // Logo à esquerda
  const logoH = 9;
  const logoW = 18;
  try {
    const img = await loadImage(renovLogo);
    doc.addImage(img, "PNG", 10, (bannerH - logoH) / 2, logoW, logoH);
  } catch {
    /* noop */
  }

  // Título centralizado
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(255, 255, 255);
  doc.text("RELATÓRIO ANUAL DE MONITORAMENTO INEMA", 10 + logoW + 6, 6.5);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.8);
  doc.setTextColor(215, 225, 240);
  const subA = `${(farm.name ?? "").toUpperCase()}  ·  ${pump.name}  ·  Exercício ${year}`;
  doc.text(subA, 10 + logoW + 6, 11.5);

  // Data à direita
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.8);
  doc.setTextColor(215, 225, 240);
  const genTxt = `Gerado em ${generatedAt}`;
  const genW = doc.getTextWidth(genTxt);
  doc.text(genTxt, pageW - 10 - genW, 6.5);
  const outorgaTxt = permit?.portaria_number
    ? `Outorga: Portaria INEMA nº ${permit.portaria_number}` +
      (permit.expiration_date ? `  (Val. ${fmtDateBRIso(permit.expiration_date)})` : "")
    : "Outorga: não cadastrada";
  const outW = doc.getTextWidth(outorgaTxt);
  doc.text(outorgaTxt, pageW - 10 - outW, 11.5);

  return bannerH + 0.9;
}

/** Bloco de identificação (coluna esquerda). */
function drawIdentificationCard(
  doc: jsPDF,
  x: number, y: number, w: number,
  farm: InemaFarmHeader,
  pump: InemaAnnualPump,
  permit: InemaPermitHeader | null,
): number {
  const headerH = 5.8;
  const rowH = 4.6;
  const padX = 2.2;
  const labelW = 34;

  const lat = pump.latitude ?? farm.latitude;
  const lon = pump.longitude ?? farm.longitude;
  const coordText = (lat != null && lon != null)
    ? `${toDMS(lat, true)}  ${toDMS(lon, false)}`
    : "—";

  const vazaoMax = permit?.max_flow_m3h ?? farm.vazaoOutorgadaM3h;
  const horasMax = permit?.max_daily_hours;
  const volMaxDia = permit?.max_daily_volume_m3;
  let vazaoStr = "—";
  if (vazaoMax != null) {
    const extras: string[] = [];
    if (horasMax != null) extras.push(`${horasMax} h/dia`);
    if (volMaxDia != null) extras.push(`${volMaxDia.toLocaleString("pt-BR")} m³/dia`);
    vazaoStr = `${vazaoMax.toLocaleString("pt-BR")} m³/h` + (extras.length ? `  (${extras.join(" · ")})` : "");
  }
  const municipio = [farm.city, farm.state].filter(Boolean).join(" - ") || "—";

  const fields: [string, string][] = [
    ["Titular", farm.proprietario ?? "—"],
    ["CPF/CNPJ", farm.cnpj ?? "—"],
    ["Empreendimento", farm.name ?? "—"],
    ["Município", municipio],
    ["Processo", permit?.process_number ?? "—"],
    ["Finalidade", permit?.water_use_purpose ?? "—"],
    ["Bacia Hidrográfica", permit?.hydrographic_basin ?? "—"],
    ["Ponto de Captação", pump.capturePoint ?? pump.name ?? "—"],
    ["Coordenadas", coordText],
    ["Vazão Outorgada", vazaoStr],
  ];

  // Cabeçalho (navy)
  doc.setFillColor(...BRAND.navy);
  doc.rect(x, y, w, headerH, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text("IDENTIFICAÇÃO DO EMPREENDIMENTO E DA OUTORGA", x + padX, y + headerH - 1.7);

  // Corpo
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.8);
  for (let i = 0; i < fields.length; i++) {
    const ry = y + headerH + i * rowH;
    if (i % 2 === 0) {
      doc.setFillColor(...BRAND.zebra);
      doc.rect(x, ry, w, rowH, "F");
    }
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND.slate);
    doc.text(fields[i][0], x + padX, ry + rowH - 1.4);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...BRAND.ink);
    const value = doc.splitTextToSize(fields[i][1], w - padX * 2 - labelW)[0] ?? "";
    doc.text(value, x + padX + labelW, ry + rowH - 1.4);
  }

  const totalH = headerH + rowH * fields.length;
  doc.setDrawColor(...BRAND.hair);
  doc.setLineWidth(0.2);
  doc.rect(x, y, w, totalH);
  return y + totalH;
}

/** Tabela semestral NE/ND (coluna esquerda, abaixo da identificação). */
function drawLevelsCard(doc: jsPDF, x: number, y: number, w: number): number {
  const headerH = 5.8;
  doc.setFillColor(...BRAND.navy);
  doc.rect(x, y, w, headerH, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text("MONITORAMENTO DE NÍVEIS (NE / ND) — SEMESTRAL", x + 2.2, y + headerH - 1.7);

  autoTable(doc, {
    startY: y + headerH,
    margin: { left: x, right: doc.internal.pageSize.getWidth() - (x + w) },
    tableWidth: w,
    head: [["Semestre", "Data", "NE (m)", "ND (m)", "Vazão (m³/h)"]],
    body: [
      ["1º Sem.", "", "", "", ""],
      ["2º Sem.", "", "", "", ""],
    ],
    styles: {
      font: "helvetica",
      fontSize: 7.6,
      cellPadding: { top: 1.6, right: 1.6, bottom: 1.6, left: 1.6 },
      textColor: BRAND.ink,
      lineColor: BRAND.hair,
      lineWidth: 0.15,
      minCellHeight: 6,
      halign: "center",
      valign: "middle",
    },
    headStyles: {
      fillColor: BRAND.navySoft,
      textColor: BRAND.navy,
      fontSize: 7.4,
      fontStyle: "bold",
      halign: "center",
      cellPadding: { top: 1.8, right: 1.6, bottom: 1.8, left: 1.6 },
    },
    alternateRowStyles: { fillColor: BRAND.zebra },
    columnStyles: {
      0: { cellWidth: 16, fontStyle: "bold" as const, halign: "left" },
    },
  });
  return (doc as any).lastAutoTable.finalY;
}

/** Tabela mensal de captação (coluna direita). */
function drawMonthlyCard(
  doc: jsPDF,
  x: number, y: number, w: number,
  pump: InemaAnnualPump,
): number {
  const headerH = 5.8;
  doc.setFillColor(...BRAND.navy);
  doc.rect(x, y, w, headerH, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text("REGISTRO MENSAL DE CAPTAÇÃO", x + 2.2, y + headerH - 1.7);

  const body = pump.monthly.map((m, i) => [
    MESES_ABREV[i],
    nOr(m.hours, 1),
    nOr(m.volume, 2),
    m.limit > 0 ? nOr(m.limit, 2) : "—",
    m.limit > 0 ? `${(m.pct * 100).toFixed(1)}%` : "—",
  ]);
  const totalPct = pump.totalLimit > 0 ? pump.totalVolume / pump.totalLimit : 0;

  autoTable(doc, {
    startY: y + headerH,
    margin: { left: x, right: doc.internal.pageSize.getWidth() - (x + w) },
    tableWidth: w,
    head: [["Mês", "Tempo (h)", "Volume Captado (m³)", "Limite Outorgado (m³)", "Utilização"]],
    body,
    foot: [[
      "TOTAL",
      pump.totalHours.toLocaleString("pt-BR", { maximumFractionDigits: 1 }),
      pump.totalVolume.toLocaleString("pt-BR", { maximumFractionDigits: 2 }),
      pump.totalLimit > 0 ? pump.totalLimit.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) : "—",
      pump.totalLimit > 0 ? `${(totalPct * 100).toFixed(1)}%` : "—",
    ]],
    styles: {
      font: "helvetica",
      fontSize: 7.8,
      cellPadding: { top: 1.5, right: 2, bottom: 1.5, left: 2 },
      textColor: BRAND.ink,
      lineColor: BRAND.hair,
      lineWidth: 0.15,
      minCellHeight: 5.6,
    },
    headStyles: {
      fillColor: BRAND.navy,
      textColor: [255, 255, 255],
      fontSize: 7.6,
      fontStyle: "bold",
      halign: "center",
      cellPadding: { top: 2, right: 2, bottom: 2, left: 2 },
    },
    alternateRowStyles: { fillColor: BRAND.zebra },
    footStyles: {
      fillColor: BRAND.navySoft,
      textColor: BRAND.navy,
      fontStyle: "bold",
      fontSize: 8,
    },
    columnStyles: {
      0: { cellWidth: 16, fontStyle: "bold" as const, halign: "left" },
      1: { halign: "right" },
      2: { halign: "right" },
      3: { halign: "right" },
      4: { halign: "right", fontStyle: "bold" as const },
    },
    didParseCell: (d) => {
      if (d.section === "body" && d.column.index === 4) {
        const m = pump.monthly[d.row.index];
        if (m && m.limit > 0) {
          d.cell.styles.textColor = pctColor(m.pct);
        }
      }
    },
  });
  return (doc as any).lastAutoTable.finalY;
}

/** Gráfico de barras minimalista uso vs. limite. */
function drawPremiumBarChart(
  doc: jsPDF,
  x: number, y: number, w: number, h: number,
  monthly: InemaAnnualMonth[],
) {
  // Título discreto na área do gráfico
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...BRAND.navy);
  doc.text("USO MENSAL vs. LIMITE OUTORGADO (m³)", x, y - 1.5);

  // Legenda no canto direito
  const legendY = y - 3.8;
  const legX = x + w - 78;
  doc.setFontSize(7);
  doc.setTextColor(...BRAND.muted);
  doc.setFillColor(...BRAND.chartBar);
  doc.rect(legX, legendY, 3, 3, "F");
  doc.text("Limite outorgado", legX + 4.5, legendY + 2.4);
  doc.setFillColor(...BRAND.green); doc.rect(legX + 30, legendY, 3, 3, "F");
  doc.text("< 80%", legX + 34.5, legendY + 2.4);
  doc.setFillColor(...BRAND.amber); doc.rect(legX + 44, legendY, 3, 3, "F");
  doc.text("80-100%", legX + 48.5, legendY + 2.4);
  doc.setFillColor(...BRAND.red); doc.rect(legX + 64, legendY, 3, 3, "F");
  doc.text("> 100%", legX + 68.5, legendY + 2.4);

  const padL = 12, padR = 6, padT = 3, padB = 8;
  const innerX = x + padL;
  const innerY = y + padT;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  const maxVal = Math.max(1, ...monthly.map((m) => Math.max(m.volume, m.limit)));

  // Só 2 gridlines (mínimo/máximo/meio) para look minimalista
  doc.setDrawColor(240, 241, 244);
  doc.setLineWidth(0.15);
  doc.setFontSize(6.5);
  doc.setTextColor(...BRAND.muted);
  for (let i = 0; i <= 2; i++) {
    const gy = innerY + innerH - (innerH * i) / 2;
    doc.line(innerX, gy, innerX + innerW, gy);
    const val = (maxVal * i) / 2;
    const lbl = val >= 1000 ? `${(val / 1000).toFixed(1)}k` : `${Math.round(val)}`;
    doc.text(lbl, x + 1, gy + 1.4);
  }
  // eixo X
  doc.setDrawColor(...BRAND.hair);
  doc.setLineWidth(0.25);
  doc.line(innerX, innerY + innerH, innerX + innerW, innerY + innerH);

  const slotW = innerW / 12;
  const barW = slotW * 0.36;
  for (let i = 0; i < 12; i++) {
    const cx = innerX + slotW * i + slotW / 2;
    const m = monthly[i];
    // Limite (translúcido cinza claro)
    if (m.limit > 0) {
      const lh = (m.limit / maxVal) * innerH;
      doc.setFillColor(...BRAND.chartBar);
      doc.rect(cx - barW - 0.3, innerY + innerH - lh, barW, lh, "F");
    }
    // Uso (colorido por %)
    if (m.volume > 0) {
      const uh = (m.volume / maxVal) * innerH;
      doc.setFillColor(...pctColor(m.pct));
      doc.rect(cx + 0.3, innerY + innerH - uh, barW, uh, "F");
    }
    doc.setFontSize(6.8);
    doc.setTextColor(...BRAND.slate);
    const lbl = MESES_ABREV[i];
    const lw = doc.getTextWidth(lbl);
    doc.text(lbl, cx - lw / 2, innerY + innerH + 3.6);
  }
}

/** Página única final de Declaração e Assinatura. */
function drawFinalSignaturePage(
  doc: jsPDF,
  periodLabel: string | number,
  titular?: InemaSignatureTitular | null,
  rt?: InemaSignatureRT | null,
) {
  doc.addPage();
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const left = PAGE.marginLeft;
  const right = pageW - PAGE.marginRight;
  const innerW = right - left;

  let cursor = PAGE.marginTop + 6;

  // Título
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(...BRAND.navy);
  doc.text("DECLARAÇÃO E ASSINATURA", pageW / 2, cursor, { align: "center" });
  cursor += 3;
  doc.setDrawColor(...BRAND.green);
  doc.setLineWidth(0.8);
  const underlineW = 60;
  doc.line((pageW - underlineW) / 2, cursor + 1.5, (pageW + underlineW) / 2, cursor + 1.5);
  cursor += 10;

  // Texto de declaração
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...BRAND.ink);
  const periodDesc = typeof periodLabel === "number"
    ? `ao exercício de ${periodLabel}`
    : `ao período ${periodLabel}`;
  const decl =
    `Declaro, sob as penas da lei, que as informações prestadas neste relatório são verdadeiras ` +
    `e correspondem aos dados registrados pelo sistema de monitoramento, referentes ${periodDesc} ` +
    `para todos os pontos de captação listados neste documento.`;
  const declLines = doc.splitTextToSize(decl, innerW * 0.85);
  doc.text(declLines, pageW / 2, cursor, { align: "center" });
  cursor += declLines.length * 5 + 14;

  const fmtDT = (iso?: string) => {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString("pt-BR"); } catch { return iso; }
  };
  const BLANK = "____________________________________";

  const drawSignatureBlock = (
    y: number,
    title: string,
    lines: string[],
    mark: string,
  ): number => {
    doc.setDrawColor(...BRAND.ink);
    doc.setLineWidth(0.3);
    const lineW = innerW * 0.5;
    const lineX = left + (innerW - lineW) / 2;
    doc.line(lineX, y, lineX + lineW, y);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(...BRAND.navy);
    doc.text(title, pageW / 2, y + 5, { align: "center" });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...BRAND.ink);
    let ly = y + 10.5;
    for (const f of lines) {
      doc.text(f, pageW / 2, ly, { align: "center" });
      ly += 4.4;
    }
    if (mark) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(8);
      doc.setTextColor(...BRAND.muted);
      doc.text(mark, pageW / 2, ly + 1, { align: "center" });
      ly += 5;
    }
    return ly + 4;
  };

  const decName = titular?.name?.trim() || "";
  const decDoc = titular?.cpfCnpj?.trim() || "";
  const capacityLabel = (() => {
    switch (titular?.capacity) {
      case "titular": return "Titular da Outorga";
      case "procurador": return "Procurador Legal";
      case "representante": return "Representante Legal";
      default: return "";
    }
  })();
  const capacityLine = capacityLabel
    ? `Qualidade: ${capacityLabel}`
    : "Qualidade: ( ) Titular   ( ) Procurador Legal   ( ) Representante Legal";
  const attorneyLine = `Procuração nº (se aplicável): ${titular?.attorneyNumber?.trim() || BLANK}`;
  const decMark = titular?.digital && decName
    ? `Assinado digitalmente por ${decName} em ${fmtDT(titular.signedAt)}`
    : "";
  cursor = drawSignatureBlock(cursor, "DECLARANTE", [
    `Nome: ${decName || BLANK}`,
    `CPF: ${decDoc || BLANK}`,
    capacityLine,
    attorneyLine,
  ], decMark);

  cursor += 22;

  const hasRT = !!(rt && rt.name && rt.name.trim());
  const rtMark = hasRT && rt!.digital
    ? `Assinado digitalmente por ${rt!.name} em ${fmtDT(rt!.signedAt)}`
    : "";
  cursor = drawSignatureBlock(cursor, "RESPONSÁVEL TÉCNICO (opcional)", [
    `Nome: ${hasRT ? rt!.name : BLANK}`,
    `CREA: ${hasRT && rt!.crea ? rt!.crea : BLANK}    ART: ${hasRT && rt!.art ? rt!.art : BLANK}`,
  ], rtMark);

  // Rodapé institucional
  doc.setDrawColor(...BRAND.hair);
  doc.setLineWidth(0.3);
  const footLineY = pageH - PAGE.marginBottom - 4;
  doc.line(left, footLineY, right, footLineY);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...BRAND.muted);
  const footTxt =
    `Documento gerado pela plataforma RENOV em ${new Date().toLocaleString("pt-BR")}. ` +
    "Monitoramento conforme Portarias INEMA nº 19.452/2019 e nº 21.953/2020. Protocolar via SEI BAHIA.";
  const footLines = doc.splitTextToSize(footTxt, innerW);
  doc.text(footLines, pageW / 2, footLineY + 4, { align: "center" });
}

export async function exportInemaAnnualPDF(data: InemaAnnualReportData) {
  // Paisagem real, margens compactas
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape" });
  const generatedAt = new Date().toLocaleString("pt-BR");

  const pageW = doc.internal.pageSize.getWidth();   // 297
  const pageH = doc.internal.pageSize.getHeight();  // 210
  const M = 10;                                     // margem lateral compacta
  const contentW = pageW - M * 2;                   // 277
  const gutter = 6;
  const leftColW = Math.round(contentW * 0.4);      // ~111
  const rightColW = contentW - leftColW - gutter;   // ~160
  const leftColX = M;
  const rightColX = M + leftColW + gutter;

  const permits = data.farm.permits ?? [];
  const findPermit = (pumpId: string): InemaPermitHeader | null =>
    permits.find((p) => p.equipment_id === pumpId) ?? permits[0] ?? null;

  let first = true;
  for (const pump of data.pumps) {
    if (!first) doc.addPage();
    first = false;

    const permit = findPermit(pump.id);

    // 1) Banner navy premium
    const bannerBottom = await drawAnnualBanner(doc, pump, data.year, permit, data.farm, generatedAt);
    const contentTop = bannerBottom + 4;

    // 2) Coluna esquerda: Identificação + NE/ND
    const idBottom = drawIdentificationCard(doc, leftColX, contentTop, leftColW, data.farm, pump, permit);
    drawLevelsCard(doc, leftColX, idBottom + 3, leftColW);

    // 3) Coluna direita: tabela mensal
    const monthlyBottom = drawMonthlyCard(doc, rightColX, contentTop, rightColW, pump);

    // 4) Gráfico (100% largura, abaixo)
    const gridBottom = Math.max(idBottom + 3 + 20, monthlyBottom);
    const chartTop = Math.max(gridBottom + 10, pageH - 52);
    const chartH = Math.min(38, pageH - 14 - chartTop);
    if (chartH >= 20) {
      drawPremiumBarChart(doc, M, chartTop, contentW, chartH, pump.monthly);
    }

  }

  // Página final única de Declaração e Assinatura
  drawFinalSignaturePage(doc, data.year, data.titular ?? null, data.rt ?? null);

  // Rodapé unificado com numeração "Página X de Y" (aplicado após todas as páginas)
  applyFooterToAllPages(doc);

  doc.save(`inema-anual-${data.year}.pdf`);
}


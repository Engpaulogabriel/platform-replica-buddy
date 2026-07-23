import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import renovLogo from "@/assets/renov-logo.png";

export interface FarmHeaderInfo {
  name: string;
  city?: string | null;
  state?: string | null;
  phone?: string | null;
}

const DEFAULT_FARM: FarmHeaderInfo = { name: "Fazenda", city: null, state: null, phone: null };
const safeAutomationUser = (user?: string | null) => user && user.trim() ? user.trim() : "Sistema";

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

/** Apply footer to all pages at the end. */
function applyFooterToAllPages(doc: jsPDF) {
  const total = (doc as unknown as { internal: { getNumberOfPages: () => number } }).internal.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
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

const resultLabel = (r?: string) => (r === "fail" ? "Falhou" : "OK");

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
    head: upperHead(["Data", "Hora", "Equipamento", "Ação", "Origem", "Usuário", "Resultado"]),
    body: data.map((r) => [r.date, r.time, r.pump, r.action, r.origin, safeAutomationUser(r.user), resultLabel(r.result)]),
    columnStyles: {
      0: { cellWidth: 20 },
      1: { cellWidth: 16 },
      6: { halign: "center", cellWidth: 20 },
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
      // Color "Resultado" column (index 6)
      if (data.column.index === 6) {
        if (txt === "ok") {
          data.cell.styles.textColor = COLOR.green;
          data.cell.styles.fontStyle = "bold";
        } else if (txt === "falhou") {
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

// Edge Function: generate-inema-pdf
// ─────────────────────────────────────────────────────────────────────────────
// Gera o RELATÓRIO INEMA (Captação de Água) em PDF NO SERVIDOR, para NÃO depender
// do deploy do frontend (Lovable às vezes não sincroniza o código novo, deixando
// o exportPDF antigo — que lia de inema_permits, vazia — em produção).
//
// Fonte de dados (a MESMA lógica dos commits 638546d / 3301ade):
//   • water_permits + water_permit_wells  → outorgas + poços (coords DMS da portaria)
//   • equipments (type=poco)              → vazão operacional (estimated_flow_m3h)
//   • RPC get_horimetro_daily             → horas operadas no período
//   • farms.state_code → environmental_agencies → órgão (default INEMA-BA)
//   • mainPortaria = outorga VIGENTE mais recente (fallback: a mais recente)
//
// AUTH: verify_jwt=false no gateway, mas a função valida o Bearer do usuário e
// usa um client COM esse token → o RLS decide o que ele pode ler (só as fazendas
// dele). Sem token válido → 401. Nada de service role aqui (evita vazar dados).
//
// Body (POST): { farm_id, date_start?, date_end?, type? }  // type: "semanal"|"anual"
// Resposta: application/pdf (attachment).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";
import { jsPDF } from "https://esm.sh/jspdf@2.5.2";
import autoTable from "https://esm.sh/jspdf-autotable@3.8.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_AGENCY = {
  state_code: "BA",
  state_name: "Bahia",
  agency_name: "Instituto do Meio Ambiente e Recursos Hídricos",
  agency_acronym: "INEMA",
};

const fmtDate = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString("pt-BR");
};
const fmtNum = (n: number | null | undefined, dec = 0): string =>
  n == null ? "—" : Number(n).toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });

const daysToExpiry = (end: string): number =>
  Math.ceil((new Date(end + "T00:00:00").getTime() - Date.now()) / 86_400_000);

// Portaria principal = outorga vigente mais recente (fallback: a mais recente).
function pickMainPortaria(list: any[]): any | null {
  if (!list.length) return null;
  const vigentes = list.filter((p) => daysToExpiry(p.validity_end) >= 0);
  const pool = vigentes.length ? vigentes : list;
  return pool.slice().sort((a, b) => new Date(b.permit_date).getTime() - new Date(a.permit_date).getTime())[0];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;

    // 1) Valida o token do usuário e usa-o nas queries (RLS aplica).
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "missing_authorization" }, 401);
    const db = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await db.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "invalid_token" }, 401);

    const body = await req.json().catch(() => ({}));
    const farmId = String(body?.farm_id ?? "");
    if (!farmId) return json({ error: "missing_farm_id" }, 400);

    // 2) Período (date_start/date_end explícitos vencem; senão deriva de `type`).
    const now = new Date();
    let from: Date, to: Date;
    if (body?.date_start && body?.date_end) {
      from = new Date(String(body.date_start));
      to = new Date(String(body.date_end));
    } else {
      to = now;
      const days = body?.type === "anual" ? 365 : body?.type === "semanal" ? 7 : 30;
      from = new Date(now.getTime() - days * 86_400_000);
    }
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      to = now; from = new Date(now.getTime() - 30 * 86_400_000);
    }
    const rangeDays = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));

    // 3) Dados (RLS pelo token do usuário).
    const [{ data: permitRows }, { data: eqRows }, { data: horas }, { data: farmRow }] = await Promise.all([
      db.from("water_permits").select("*").eq("farm_id", farmId).order("validity_end", { ascending: true }),
      db.from("equipments").select("id,name,estimated_flow_m3h,flow_total_m3,flow_daily_start_m3")
        .eq("farm_id", farmId).eq("type", "poco").order("name"),
      db.rpc("get_horimetro_daily", { _farm_id: farmId, _from: from.toISOString(), _to: to.toISOString() }),
      db.from("farms").select("state_code").eq("id", farmId).maybeSingle(),
    ]);

    const pList = (permitRows ?? []) as any[];
    const ids = pList.map((p) => p.id);
    let wells: any[] = [];
    if (ids.length) {
      const { data: w } = await db.from("water_permit_wells").select("*").in("permit_id", ids);
      wells = (w ?? []) as any[];
    }
    const permits = pList.map((p) => ({ ...p, wells: wells.filter((w) => w.permit_id === p.id) }));

    // Órgão ambiental por estado (default INEMA-BA).
    const code = String((farmRow as any)?.state_code ?? "BA").toUpperCase().slice(0, 2);
    const { data: ag } = await db.from("environmental_agencies")
      .select("state_code, state_name, agency_name, agency_acronym").eq("state_code", code).maybeSingle();
    const agency = (ag as any) ?? { ...DEFAULT_AGENCY, state_code: code };

    // Monitoramento: volume captado = horas reais × vazão operacional (estimated_flow_m3h).
    const hoursByEq: Record<string, number> = {};
    for (const r of (horas ?? []) as Array<{ equipment_id: string; hours: number }>) {
      hoursByEq[r.equipment_id] = (hoursByEq[r.equipment_id] ?? 0) + Number(r.hours || 0);
    }
    const monitoring = ((eqRows ?? []) as any[]).map((e) => {
      const h = hoursByEq[e.id] ?? 0;
      const flow = e.estimated_flow_m3h ?? null;
      return { name: e.name, hours: h, flow, volume: h * Number(flow ?? 0) };
    });

    // 4) PDF (mesma estrutura do exportPDF do frontend).
    const mp = pickMainPortaria(permits);
    const wellsSum = (p: any) => p.wells.reduce((a: number, wl: any) => a + Number(wl.flow_rate_m3_day || 0), 0);

    const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
    const W = doc.internal.pageSize.getWidth();
    doc.setFillColor(66, 147, 80); doc.rect(0, 0, W, 50, "F");
    doc.setTextColor(255, 255, 255); doc.setFontSize(16); doc.setFont("helvetica", "bold");
    doc.text("Renov Tecnologia Agrícola", 30, 22);
    doc.setFontSize(11); doc.setFont("helvetica", "normal");
    doc.text(`Relatório ${agency.agency_acronym} — Captação de Água`, 30, 38);
    doc.setFontSize(9);
    doc.text(`${agency.agency_name} (${agency.state_code})`, W - 30, 38, { align: "right" });
    doc.setTextColor(0, 0, 0);

    let y = 70;
    doc.setFontSize(11); doc.setFont("helvetica", "bold"); doc.text("Dados da outorga (principal)", 30, y); y += 15;
    doc.setFontSize(10); doc.setFont("helvetica", "normal");
    if (mp) {
      const volDay = wellsSum(mp);
      const hrs = Number(mp.regime_hours_per_day ?? 18) || 18;
      const flowM3h = hrs > 0 ? volDay / hrs : 0;
      const rows: Array<[string, string]> = [
        ["Nº da Portaria", mp.permit_number],
        ["Nº do Processo", mp.process_number],
        ["Titular", `${mp.holder_name}${mp.holder_cpf_cnpj ? ` — CPF ${mp.holder_cpf_cnpj}` : ""}`],
        ["Finalidade de uso", mp.purpose ?? "—"],
        ["Bacia / Aquífero", mp.basin ?? "—"],
        ["Município", mp.municipality ?? "—"],
        ["Validade", `${fmtDate(mp.validity_start)} a ${fmtDate(mp.validity_end)}`],
        ["Vazão máx. outorgada", `${fmtNum(flowM3h, 1)} m³/h`],
        ["Volume máx. diário", `${fmtNum(volDay)} m³/dia`],
        ["Horas máx./dia", `${fmtNum(hrs)} h`],
      ];
      for (const [k, v] of rows) { doc.text(`${k}: ${v}`, 30, y); y += 13; }
    } else {
      doc.text("Nenhuma outorga cadastrada.", 30, y); y += 13;
    }
    y += 6;

    doc.setFont("helvetica", "bold"); doc.text("Outorgas da fazenda", 30, y);
    autoTable(doc, {
      startY: y + 6,
      head: [["Portaria", "Processo", "Validade", "Área (ha)", "Poços", "Vazão total (m³/dia)"]],
      body: permits.map((p) => [
        p.permit_number, p.process_number,
        `${fmtDate(p.validity_start)}–${fmtDate(p.validity_end)}`,
        fmtNum(p.irrigated_area_ha, 2), String(p.wells.length), fmtNum(wellsSum(p)),
      ]),
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: { fillColor: [66, 147, 80], textColor: 255 },
    });
    y = (doc as any).lastAutoTable.finalY + 18;

    // Poços outorgados — coordenadas EXATAMENTE como na portaria (DMS da outorga).
    const wellRows = permits.flatMap((p) =>
      p.wells.map((wl: any) => [
        p.permit_number, wl.well_name, wl.latitude ?? "—", wl.longitude ?? "—",
        fmtNum(wl.flow_rate_m3_day), wl.datum ?? "—",
      ]),
    );
    if (wellRows.length) {
      doc.setFont("helvetica", "bold");
      doc.text("Poços outorgados (coordenadas da portaria)", 30, y);
      autoTable(doc, {
        startY: y + 6,
        head: [["Portaria", "Poço", "Latitude", "Longitude", "Vazão (m³/dia)", "Datum"]],
        body: wellRows,
        styles: { fontSize: 8, cellPadding: 3 },
        headStyles: { fillColor: [66, 147, 80], textColor: 255 },
      });
      y = (doc as any).lastAutoTable.finalY + 18;
    }

    doc.setFont("helvetica", "bold");
    doc.text(`Monitoramento (${fmtDate(from.toISOString())} a ${fmtDate(to.toISOString())})`, 30, y);
    autoTable(doc, {
      startY: y + 6,
      head: [["Poço", "Horas operadas", "Vazão nominal (m³/h)", "Volume captado (m³)"]],
      body: monitoring.map((m) => [m.name, fmtNum(m.hours, 1), fmtNum(m.flow, 1), fmtNum(m.volume)]),
      styles: { fontSize: 9, cellPadding: 3 },
      headStyles: { fillColor: [66, 147, 80], textColor: 255 },
    });

    const H = doc.internal.pageSize.getHeight();
    doc.setFontSize(8); doc.setTextColor(120);
    doc.text("Volume captado estimado por horas × vazão nominal (medição indireta). Nível estático/dinâmico não medido pela telemetria.", 30, H - 30);
    doc.text(`Gerado em ${new Date().toLocaleString("pt-BR")} — Gestor de Bombas Renov (${rangeDays} dias).`, 30, H - 18);

    const ab = doc.output("arraybuffer");
    const filename = `renov-${String(agency.agency_acronym).toLowerCase()}-${new Date().toISOString().slice(0, 10)}.pdf`;
    return new Response(ab, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"` },
    });
  } catch (e) {
    return json({ error: "pdf_generation_failed", detail: String((e as Error)?.message ?? e) }, 500);
  }
});

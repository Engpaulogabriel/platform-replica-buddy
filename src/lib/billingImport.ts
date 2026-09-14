// ─────────────────────────────────────────────────────────────────────────────
// Importação da carteira — normalização, validação e duplicidade.
// ─────────────────────────────────────────────────────────────────────────────
// Módulo PURO: sem rede, sem Supabase, sem React. É o que torna as regras
// testáveis de verdade. O parsing de arquivo (xlsx/papaparse) fica no adaptador
// separado; aqui só entram linhas já em forma de objeto.
//
// PRINCÍPIO: `raw` NUNCA é perdido. A normalização produz `mapped` ao lado,
// jamais no lugar — auditoria precisa do que veio no arquivo.

export type RowStatus = "valida" | "invalida" | "duplicada" | "ignorada" | "aplicada";

export interface ValidationIssue { code: string; field?: string; detail?: string }

/** Só dígitos. Preserva zeros à esquerda porque a entrada é string. */
export const onlyDigits = (v: unknown): string => String(v ?? "").replace(/\D/g, "");

export function normalizeName(v: unknown): string {
  return String(v ?? "").trim().replace(/\s+/g, " ");
}

export function normalizeEmail(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const isValidEmail = (v: unknown): boolean => EMAIL_RE.test(normalizeEmail(v));

/**
 * Telefone brasileiro: devolve só dígitos com DDI 55 removido quando presente.
 * NÃO inventa o 9º dígito — inferir número que o cliente não forneceu foi
 * exatamente o defeito que quebrou a entrega de WhatsApp neste projeto.
 */
export function normalizePhoneBR(v: unknown): string {
  let d = onlyDigits(v);
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  return d;
}

/**
 * Valor monetário BR → centavos, sem ponto flutuante no resultado.
 * Trata "R$ 2.800,00", "2800,00", "2.800", "2800.50" e número puro.
 * A ambiguidade real é "1.234": pode ser milhar BR ou decimal EN. Regra: se o
 * separador final tem 3 dígitos depois e não há vírgula, é MILHAR.
 */
export function parseMoneyToCents(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 100);
  let s = String(v ?? "").trim().replace(/[R$\s\u00A0]/gi, "");
  if (!s) return null;
  const neg = /^-/.test(s); s = s.replace(/^-/, "");
  if (!/^[\d.,]+$/.test(s)) return null;

  const temVirgula = s.includes(","), temPonto = s.includes(".");
  if (temVirgula && temPonto) s = s.replace(/\./g, "").replace(",", ".");
  else if (temVirgula) s = s.replace(",", ".");
  else if (temPonto) {
    const dec = s.split(".").pop() ?? "";
    if (dec.length === 3) s = s.replace(/\./g, "");   // milhar
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (neg ? -1 : 1);
}

/**
 * Data. Aceita Date, serial do Excel e texto BR/ISO.
 * Serial do Excel: dias desde 1899-12-30 (o "bug do ano 1900" da Lotus já está
 * embutido nessa época). Sem isso, "45000" viraria data inválida ou 1970.
 */
export function parseDateFlexible(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 2_958_466) {
    const ms = Math.round((v - 25569) * 86400 * 1000);   // 25569 = 1970-01-01
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(v ?? "").trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(s);
  if (m) {
    const [, dd, mm, yy] = m;
    const ano = yy.length === 2 ? `20${yy}` : yy;
    const d = new Date(`${ano}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}T00:00:00Z`);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return null;
}

// ── CPF / CNPJ: dígitos verificadores de verdade ───────────────────────────
export function isValidCPF(v: unknown): boolean {
  const d = onlyDigits(v);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (len: number) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += Number(d[i]) * (len + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

export function isValidCNPJ(v: unknown): boolean {
  const d = onlyDigits(v);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const dv = (len: number) => {
    const pesos = len === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    let s = 0;
    for (let i = 0; i < len; i++) s += Number(d[i]) * pesos[i];
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
}

export type DocType = "cpf" | "cnpj";
export function classifyDoc(v: unknown): { type: DocType | null; valid: boolean; digits: string } {
  const digits = onlyDigits(v);
  if (digits.length === 11) return { type: "cpf", valid: isValidCPF(digits), digits };
  if (digits.length === 14) return { type: "cnpj", valid: isValidCNPJ(digits), digits };
  return { type: null, valid: false, digits };
}

// ── MAPEAMENTO ─────────────────────────────────────────────────────────────
/** Cabeçalho do arquivo → campo do banco. Salvo em billing_import_jobs. */
export type ColumnMapping = Record<string, string>;

export function applyMapping(raw: Record<string, unknown>, map: ColumnMapping): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [coluna, campo] of Object.entries(map)) {
    if (!campo) continue;
    if (Object.prototype.hasOwnProperty.call(raw, coluna)) out[campo] = raw[coluna];
  }
  return out;
}

// ── NORMALIZAÇÃO + VALIDAÇÃO DE UMA LINHA ──────────────────────────────────
export interface NormalizedRow {
  mapped: Record<string, unknown>;
  validation: ValidationIssue[];
  status: RowStatus;
}

export function normalizeAndValidate(rawMapped: Record<string, unknown>): NormalizedRow {
  const m: Record<string, unknown> = {};
  const issues: ValidationIssue[] = [];

  const nome = normalizeName(rawMapped.legal_name ?? rawMapped.name);
  if (!nome) issues.push({ code: "campo_obrigatorio_ausente", field: "legal_name" });
  m.legal_name = nome;
  if (rawMapped.trade_name) m.trade_name = normalizeName(rawMapped.trade_name);

  const doc = classifyDoc(rawMapped.doc_number);
  if (!doc.digits) issues.push({ code: "campo_obrigatorio_ausente", field: "doc_number" });
  else if (!doc.type) issues.push({ code: "documento_invalido", field: "doc_number", detail: "tamanho" });
  else if (!doc.valid) issues.push({ code: "documento_invalido", field: "doc_number", detail: "dígito verificador" });
  m.doc_number = doc.digits;
  if (doc.type) m.doc_type = doc.type;

  if (rawMapped.email_billing != null && String(rawMapped.email_billing).trim() !== "") {
    const e = normalizeEmail(rawMapped.email_billing);
    if (!isValidEmail(e)) issues.push({ code: "email_invalido", field: "email_billing" });
    m.email_billing = e;
  }
  if (rawMapped.phone_billing) m.phone_billing = normalizePhoneBR(rawMapped.phone_billing);
  if (rawMapped.whatsapp_billing) m.whatsapp_billing = normalizePhoneBR(rawMapped.whatsapp_billing);

  if (rawMapped.amount_cents != null && String(rawMapped.amount_cents).trim() !== "") {
    const c = parseMoneyToCents(rawMapped.amount_cents);
    if (c === null || c <= 0) issues.push({ code: "valor_invalido", field: "amount_cents" });
    else m.amount_cents = c;
  }

  if (rawMapped.start_date != null && String(rawMapped.start_date).trim() !== "") {
    const d = parseDateFlexible(rawMapped.start_date);
    if (!d) issues.push({ code: "data_invalida", field: "start_date" });
    else m.start_date = d;
  }

  if (rawMapped.due_day != null && String(rawMapped.due_day).trim() !== "") {
    const n = Number(onlyDigits(rawMapped.due_day));
    // 1–28: o CHECK do banco recusa acima disso, e mês curto produziria
    // vencimento inválido. Falhar aqui dá mensagem melhor que erro de constraint.
    if (!Number.isFinite(n) || n < 1 || n > 28) issues.push({ code: "data_invalida", field: "due_day" });
    else m.due_day = n;
  }

  for (const campo of ["billing_type", "description", "periodicity", "notes",
                       "endereco", "city", "state", "zip_code", "farm"]) {
    if (rawMapped[campo] != null && String(rawMapped[campo]).trim() !== "") {
      m[campo] = typeof rawMapped[campo] === "string"
        ? normalizeName(rawMapped[campo]) : rawMapped[campo];
    }
  }

  return { mapped: m, validation: issues, status: issues.length ? "invalida" : "valida" };
}

// ── DUPLICIDADE ────────────────────────────────────────────────────────────
export interface ExistingCustomer { id: string; doc_number: string; email_billing?: string | null; legal_name?: string | null }

export interface DuplicateVerdict {
  duplicateOfCustomerId: string | null;
  /** e-mail igual com documento diferente: ALERTA, nunca merge automático. */
  alerts: ValidationIssue[];
  /** nome parecido: só sugestão humana. */
  suggestions: string[];
}

export function detectCustomerDuplicate(
  mapped: Record<string, unknown>, existentes: ExistingCustomer[],
): DuplicateVerdict {
  const doc = onlyDigits(mapped.doc_number);
  const email = normalizeEmail(mapped.email_billing);
  const nome = normalizeName(mapped.legal_name).toLowerCase();
  const alerts: ValidationIssue[] = [];
  const suggestions: string[] = [];

  // 1) documento normalizado — determinístico
  const porDoc = existentes.find((c) => onlyDigits(c.doc_number) === doc && doc.length > 0);
  if (porDoc) return { duplicateOfCustomerId: porDoc.id, alerts, suggestions };

  // 2) e-mail igual com documento DIFERENTE: alerta, sem merge
  if (email) {
    const porEmail = existentes.find((c) => normalizeEmail(c.email_billing) === email);
    if (porEmail) {
      alerts.push({ code: "email_conflitante", field: "email_billing",
                    detail: `e-mail já usado por outro documento (${porEmail.id})` });
    }
  }

  // 3) nome semelhante: apenas sugestão
  if (nome) {
    for (const c of existentes) {
      const n = normalizeName(c.legal_name).toLowerCase();
      if (n && (n === nome || n.startsWith(nome) || nome.startsWith(n))) suggestions.push(c.id);
    }
  }
  return { duplicateOfCustomerId: null, alerts, suggestions };
}

export interface ExistingFarm { id: string; name: string; cnpj?: string | null }
export interface FarmMatch { farmId: string | null; how: "cnpj" | "nome_exato" | "nome_aproximado" | "nenhum"; candidates: string[] }

/**
 * Matching de fazenda. Nome aproximado NUNCA vincula automaticamente — devolve
 * candidatos para decisão humana no preview.
 */
export function matchFarm(mapped: Record<string, unknown>, farms: ExistingFarm[]): FarmMatch {
  const cnpj = onlyDigits(mapped.farm_cnpj ?? mapped.doc_number);
  const alvo = normalizeName(mapped.farm).toLowerCase();

  if (cnpj) {
    const f = farms.find((x) => onlyDigits(x.cnpj) === cnpj && cnpj.length >= 11);
    if (f) return { farmId: f.id, how: "cnpj", candidates: [] };
  }
  if (alvo) {
    const exato = farms.filter((x) => normalizeName(x.name).toLowerCase() === alvo);
    if (exato.length === 1) return { farmId: exato[0].id, how: "nome_exato", candidates: [] };
    const aprox = farms.filter((x) => {
      const n = normalizeName(x.name).toLowerCase();
      return n.includes(alvo) || alvo.includes(n);
    });
    if (aprox.length) {
      return { farmId: null, how: "nome_aproximado", candidates: aprox.map((x) => x.id) };
    }
  }
  return { farmId: null, how: "nenhum", candidates: [] };
}

// ── PREVIEW ────────────────────────────────────────────────────────────────
export interface PreviewRow {
  rowNumber: number; status: RowStatus;
  raw: Record<string, unknown>; mapped: Record<string, unknown>;
  validation: ValidationIssue[];
  matchCustomerId: string | null; matchFarmId: string | null;
  farmMatchHow: FarmMatch["how"]; farmCandidates: string[];
  duplicateOfCustomerId: string | null;
  proposedAction: "criar_cliente" | "usar_cliente_existente" | "ignorar";
}

export interface PreviewSummary {
  total: number; validas: number; invalidas: number; duplicadas: number;
  semFazenda: number; comAlerta: number; rows: PreviewRow[];
}

export function buildPreview(
  linhas: Array<{ rowNumber: number; raw: Record<string, unknown> }>,
  mapping: ColumnMapping, clientes: ExistingCustomer[], farms: ExistingFarm[],
): PreviewSummary {
  const rows: PreviewRow[] = linhas.map(({ rowNumber, raw }) => {
    const mappedRaw = applyMapping(raw, mapping);
    const n = normalizeAndValidate(mappedRaw);
    const dup = detectCustomerDuplicate(n.mapped, clientes);
    const farm = matchFarm(n.mapped, farms);
    const validation = [...n.validation, ...dup.alerts];

    let status: RowStatus = n.status;
    if (status === "valida" && dup.duplicateOfCustomerId) status = "duplicada";

    return {
      rowNumber, status, raw, mapped: n.mapped, validation,
      matchCustomerId: dup.duplicateOfCustomerId,
      matchFarmId: farm.farmId, farmMatchHow: farm.how, farmCandidates: farm.candidates,
      duplicateOfCustomerId: dup.duplicateOfCustomerId,
      proposedAction: status === "invalida" ? "ignorar"
        : dup.duplicateOfCustomerId ? "usar_cliente_existente" : "criar_cliente",
    };
  });

  return {
    total: rows.length,
    validas: rows.filter((r) => r.status === "valida").length,
    invalidas: rows.filter((r) => r.status === "invalida").length,
    duplicadas: rows.filter((r) => r.status === "duplicada").length,
    semFazenda: rows.filter((r) => !r.matchFarmId).length,
    comAlerta: rows.filter((r) => r.validation.some((v) => v.code === "email_conflitante")).length,
    rows,
  };
}

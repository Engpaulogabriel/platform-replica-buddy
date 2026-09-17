// @vitest-environment node
// ETAPA 1 — importação da carteira. Helpers puros + staging/commit em Postgres
// 17 real (pglite), com SET ROLE: superusuário ignora RLS.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";
import { makeXlsx, type CellSpec } from "./helpers/makeXlsx";
import {
  onlyDigits, normalizeName, normalizeEmail, normalizePhoneBR, parseMoneyToCents,
  parseDateFlexible, isValidCPF, isValidCNPJ, classifyDoc, applyMapping,
  normalizeAndValidate, detectCustomerDuplicate, matchFarm, buildPreview,
  type ColumnMapping,
} from "@/lib/billingImport";
import { parseXlsx, parseCsv, listSheets, assertFileAcceptable,
         ImportFileError, FILE_LIMITS } from "@/lib/billingImportParse";

const REPO = path.resolve(__dirname, "../..");
const M0 = fs.readFileSync(path.join(REPO, "supabase/migrations/20260905120000_billing_foundation.sql"), "utf8");
const M1 = fs.readFileSync(path.join(REPO, "supabase/migrations/20260908160000_billing_import_staging.sql"), "utf8");

const S = (v: string): CellSpec => ({ t: "s", v });
const N = (v: number): CellSpec => ({ t: "n", v });
const E: CellSpec = { t: "e" };

describe("4 e 5. parsing de arquivo (read-excel-file)", () => {
  it("1. XLSX de uma sheet: cabeçalho e linhas", async () => {
    const buf = makeXlsx([{ name: "Carteira", rows: [
      [S("Cliente"), S("CNPJ"), S("Valor Mensal"), S("Vencimento")],
      [S("Fazenda Semear"), S("11222333000181"), S("R$ 2.800,00"), N(10)],
    ] }]);
    const p = await parseXlsx(buf);
    expect(p.headers).toEqual(["Cliente", "CNPJ", "Valor Mensal", "Vencimento"]);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]["Cliente"]).toBe("Fazenda Semear");
    expect(p.rows[0]["Vencimento"]).toBe(10);   // número continua número
  });

  it("múltiplas sheets: lista e leitura por nome", async () => {
    const buf = makeXlsx([
      { name: "Clientes", rows: [[S("Cliente")], [S("A")]] },
      { name: "Contratos", rows: [[S("Descricao")], [S("Taxa")]] },
    ]);
    expect(await listSheets(buf)).toEqual(["Clientes", "Contratos"]);
    const p = await parseXlsx(buf, "Contratos");
    expect(p.headers).toEqual(["Descricao"]);
    expect(p.rows[0]["Descricao"]).toBe("Taxa");
  });

  it("células vazias viram null e não deslocam colunas", async () => {
    const buf = makeXlsx([{ name: "S", rows: [
      [S("A"), S("B"), S("C")], [S("x"), E, S("z")],
    ] }]);
    const p = await parseXlsx(buf);
    expect(p.rows[0]).toMatchObject({ A: "x", B: null, C: "z" });
  });

  it("CNPJ como TEXTO preserva o zero à esquerda", async () => {
    const buf = makeXlsx([{ name: "S", rows: [[S("CNPJ")], [S("01234567000195")]] }]);
    const p = await parseXlsx(buf);
    expect(p.rows[0]["CNPJ"]).toBe("01234567000195");
  });

  it("documento NUMÉRICO: o zero à esquerda NÃO existe no arquivo — não inventamos", async () => {
    // Correção de uma afirmação anterior minha: nenhum parser recupera um zero
    // que o Excel nunca guardou. A célula numérica vale 1234567000195.
    const buf = makeXlsx([{ name: "S", rows: [[S("CNPJ")], [N(1234567000195)]] }]);
    const p = await parseXlsx(buf);
    expect(p.rows[0]["CNPJ"]).toBe(1234567000195);
    // e a validação rejeita por tamanho, em vez de "consertar" com um zero
    const r = normalizeAndValidate({ legal_name: "X", doc_number: p.rows[0]["CNPJ"] });
    expect(r.status).toBe("invalida");
    expect(r.validation.map((v) => v.code)).toContain("documento_invalido");
  });

  it("data como serial numérico chega como número e é convertida explicitamente", async () => {
    const buf = makeXlsx([{ name: "S", rows: [[S("Inicio")], [N(45000)]] }]);
    const p = await parseXlsx(buf);
    expect(parseDateFlexible(p.rows[0]["Inicio"])).toBe("2023-03-15");
  });

  it("dinheiro como texto e como número", async () => {
    const buf = makeXlsx([{ name: "S", rows: [
      [S("A"), S("B")], [S("R$ 2.800,00"), N(380)],
    ] }]);
    const p = await parseXlsx(buf);
    expect(parseMoneyToCents(p.rows[0]["A"])).toBe(280000);
    expect(parseMoneyToCents(p.rows[0]["B"])).toBe(38000);
  });

  it("arquivo inválido/corrompido → erro, não silêncio", async () => {
    await expect(parseXlsx(new Uint8Array([1, 2, 3, 4]).buffer)).rejects.toThrow();
  });

  it("limites: tamanho, extensão e arquivo vazio", () => {
    expect(() => assertFileAcceptable("c.xlsx", FILE_LIMITS.maxBytes + 1, "xlsx"))
      .toThrow(ImportFileError);
    expect(() => assertFileAcceptable("c.xlsx", 10, "xlsx")).toThrow(/vazio|corrompido/i);
    expect(() => assertFileAcceptable("c.exe", 1000, "xlsx")).toThrow(/Extensão/);
    expect(() => assertFileAcceptable("c.pdf", 1000, "csv")).toThrow(/Extensão/);
    expect(() => assertFileAcceptable("c.xlsx", 1000, "xlsx")).not.toThrow();
    expect(() => assertFileAcceptable("c.csv", 1000, "csv")).not.toThrow();
  });

  it("2. CSV com ponto e vírgula (padrão BR) — texto preserva zeros", () => {
    const p = parseCsv("Cliente;CNPJ;Valor Mensal\nSykue;01.234.567/0001-95;R$ 380,00\n");
    expect(p.headers).toEqual(["Cliente", "CNPJ", "Valor Mensal"]);
    expect(p.rows[0]["CNPJ"]).toBe("01.234.567/0001-95");
  });

  it("CSV sem cabeçalho → erro claro", () => {
    expect(() => parseCsv("")).toThrow(/cabeçalho/i);
  });
});

describe("7 a 9. normalização e documento", () => {
  it("3 e 4. CPF válido e inválido", () => {
    expect(isValidCPF("529.982.247-25")).toBe(true);
    expect(isValidCPF("111.111.111-11")).toBe(false);
    expect(isValidCPF("529.982.247-26")).toBe(false);
    expect(isValidCPF("123")).toBe(false);
  });
  it("5 e 6. CNPJ válido e inválido", () => {
    expect(isValidCNPJ("11.222.333/0001-81")).toBe(true);
    expect(isValidCNPJ("11.222.333/0001-82")).toBe(false);
    expect(isValidCNPJ("00.000.000/0000-00")).toBe(false);
  });
  it("classifyDoc separa CPF de CNPJ pelo tamanho normalizado", () => {
    expect(classifyDoc("529.982.247-25")).toMatchObject({ type: "cpf", valid: true });
    expect(classifyDoc("11222333000181")).toMatchObject({ type: "cnpj", valid: true });
    expect(classifyDoc("12345")).toMatchObject({ type: null, valid: false });
  });

  it("7. valores monetários BR em todas as formas", () => {
    expect(parseMoneyToCents("R$ 2.800,00")).toBe(280000);
    expect(parseMoneyToCents("2800,50")).toBe(280050);
    expect(parseMoneyToCents("2.800")).toBe(280000);   // milhar BR
    expect(parseMoneyToCents("2800.50")).toBe(280050); // decimal EN
    expect(parseMoneyToCents(380)).toBe(38000);
    expect(parseMoneyToCents("abc")).toBeNull();
    expect(parseMoneyToCents("")).toBeNull();
  });

  it("8. datas: serial do Excel, BR e ISO", () => {
    expect(parseDateFlexible(45000)).toBe("2023-03-15");   // serial Excel
    expect(parseDateFlexible("15/03/2023")).toBe("2023-03-15");
    expect(parseDateFlexible("2023-03-15")).toBe("2023-03-15");
    expect(parseDateFlexible("banana")).toBeNull();
  });

  it("telefone BR não inventa o 9º dígito", () => {
    expect(normalizePhoneBR("+55 (71) 98888-7777")).toBe("71988887777");
    expect(normalizePhoneBR("(71) 8888-7777")).toBe("7188887777");   // fica com 10
  });

  it("nome e e-mail normalizados; raw nunca é alterado", () => {
    expect(normalizeName("  Fazenda   Semear  ")).toBe("Fazenda Semear");
    expect(normalizeEmail("  A@B.COM ")).toBe("a@b.com");
    expect(onlyDigits("12.345.678/0001-90")).toBe("12345678000190");
  });

  it("linha com documento inválido vira 'invalida' e não propõe criar cliente", () => {
    const r = normalizeAndValidate({ legal_name: "X", doc_number: "111.111.111-11" });
    expect(r.status).toBe("invalida");
    expect(r.validation.map((v) => v.code)).toContain("documento_invalido");
  });

  it("due_day fora de 1..28 é recusado antes do CHECK do banco", () => {
    expect(normalizeAndValidate({ legal_name: "X", doc_number: "11222333000181", due_day: 31 })
      .validation.map((v) => v.code)).toContain("data_invalida");
  });
});

describe("10 a 13. duplicidade e fazenda", () => {
  const existentes = [{ id: "c1", doc_number: "11.222.333/0001-81", email_billing: "fin@sykue.com", legal_name: "Sykue Bioenergia" }];

  it("9. documento igual (com máscara diferente) → duplicata determinística", () => {
    const v = detectCustomerDuplicate({ doc_number: "11222333000181" }, existentes);
    expect(v.duplicateOfCustomerId).toBe("c1");
  });

  it("10. e-mail igual com documento diferente → ALERTA, sem merge", () => {
    const v = detectCustomerDuplicate(
      { doc_number: "12345678000190", email_billing: "FIN@SYKUE.COM" }, existentes);
    expect(v.duplicateOfCustomerId).toBeNull();
    expect(v.alerts.map((a) => a.code)).toContain("email_conflitante");
  });

  it("nome semelhante é só sugestão, nunca duplicata", () => {
    const v = detectCustomerDuplicate({ doc_number: "12345678000190", legal_name: "Sykue" }, existentes);
    expect(v.duplicateOfCustomerId).toBeNull();
    expect(v.suggestions).toContain("c1");
  });

  const farms = [
    { id: "f1", name: "SEMEAR", cnpj: "12.345.678/0001-90" },
    { id: "f2", name: "SEMEAR II", cnpj: null },
  ];
  it("11. fazenda por CNPJ", () => {
    expect(matchFarm({ farm_cnpj: "12345678000190" }, farms)).toMatchObject({ farmId: "f1", how: "cnpj" });
  });
  it("12. fazenda por nome exato", () => {
    expect(matchFarm({ farm: "semear ii" }, farms)).toMatchObject({ farmId: "f2", how: "nome_exato" });
  });
  it("13. nome aproximado NÃO auto-vincula — devolve candidatos", () => {
    const m = matchFarm({ farm: "SEME" }, farms);
    expect(m.farmId).toBeNull();
    expect(m.how).toBe("nome_aproximado");
    expect(m.candidates.length).toBeGreaterThan(1);
  });
});

describe("14 e 16. preview", () => {
  const map: ColumnMapping = { "Cliente": "legal_name", "CNPJ": "doc_number",
    "Valor Mensal": "amount_cents", "Fazenda": "farm" };
  const linhas = [
    { rowNumber: 1, raw: { Cliente: "Sykue", CNPJ: "11222333000181", "Valor Mensal": "R$ 380,00", Fazenda: "SEMEAR" } },
    { rowNumber: 2, raw: { Cliente: "Ruim", CNPJ: "111", "Valor Mensal": "x", Fazenda: "" } },
    { rowNumber: 3, raw: { Cliente: "Novo", CNPJ: "529.982.247-25", "Valor Mensal": "2800", Fazenda: "SEMEAR" } },
  ];
  const clientes = [{ id: "c1", doc_number: "11222333000181", legal_name: "Sykue" }];
  const farms = [{ id: "f1", name: "SEMEAR", cnpj: null }];

  it("16. linha inválida NÃO derruba o preview", () => {
    const p = buildPreview(linhas, map, clientes, farms);
    expect(p.total).toBe(3);
    expect(p.invalidas).toBe(1);
    expect(p.duplicadas).toBe(1);
    expect(p.validas).toBe(1);
    expect(p.rows[1].status).toBe("invalida");
    expect(p.rows[0].proposedAction).toBe("usar_cliente_existente");
    expect(p.rows[2].proposedAction).toBe("criar_cliente");
  });

  it("cada linha traz raw, normalizado, problemas e ação proposta", () => {
    const p = buildPreview(linhas, map, clientes, farms);
    const r = p.rows[0];
    expect(r.raw.CNPJ).toBe("11222333000181");     // raw preservado
    expect(r.mapped.amount_cents).toBe(38000);      // normalizado ao lado
    expect(r.matchFarmId).toBe("f1");
  });
});

// ── BANCO ──────────────────────────────────────────────────────────────────
const BOOT = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
CREATE TABLE public.farms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, cnpj text);
CREATE TABLE public.platform_admins (user_id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.is_platform_admin(_u uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id=_u); $$;
`;

let db: PGlite; let ADMIN = "", FIN = "", VIEW = "", NINGUEM = "", FARM = "";
interface Rows { rows: unknown[] }
async function asUser(role: "anon" | "authenticated", u: string | null, sql: string): Promise<Rows> {
  await db.exec(`SET ROLE ${role};`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [u ?? ""]);
  try { return (await db.query(sql)) as Rows; } finally { await db.exec(`RESET ROLE;`); }
}
const jobPronto = async () => {
  const j = (await db.query<{ id: string }>(
    `INSERT INTO public.billing_import_jobs (kind,source_filename,source_sha256,source_bytes,status,created_by)
     VALUES ('carteira','carteira.xlsx',repeat('a',64),1024,'validado',$1) RETURNING id`, [FIN])).rows[0].id;
  await db.query(
    `INSERT INTO public.billing_import_rows (job_id,row_number,raw,mapped,row_status,match_farm_id)
     VALUES ($1,1,'{}'::jsonb,$2::jsonb,'valida',$3),
            ($1,2,'{}'::jsonb,'{}'::jsonb,'invalida',NULL)`,
    [j, JSON.stringify({ legal_name: "Sykue", doc_type: "cnpj", doc_number: "11222333000181",
                         amount_cents: 38000, billing_type: "taxa_acesso_online",
                         description: "Taxa de acesso online", due_day: 10 }), FARM]);
  return j;
};

describe("15 a 24. staging, aprovação e commit", () => {
  beforeEach(async () => {
    db = new PGlite(); await db.exec(BOOT); await db.exec(M0); await db.exec(M1);
    const mk = async () => (await db.query<{ id: string }>(
      `INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
    ADMIN = await mk(); FIN = await mk(); VIEW = await mk(); NINGUEM = await mk();
    await db.query(`INSERT INTO public.platform_admins VALUES ($1)`, [ADMIN]);
    await db.query(`INSERT INTO public.billing_roles (user_id,role) VALUES ($1,'finance'),($2,'finance_viewer')`, [FIN, VIEW]);
    FARM = (await db.query<{ id: string }>(
      `INSERT INTO public.farms (name,cnpj) VALUES ('SEMEAR','12345678000190') RETURNING id`)).rows[0].id;
  }, 90_000);
  afterEach(async () => { await db?.close(); });

  const contagens = async () => {
    const r = await db.query<{ c: number; ct: number; ch: number }>(
      `SELECT (SELECT count(*) FROM billing_customers)::int c,
              (SELECT count(*) FROM billing_contracts)::int ct,
              (SELECT count(*) FROM billing_charges)::int ch`);
    return r.rows[0];
  };

  it("17. preview/staging NÃO grava em tabela definitiva", async () => {
    await jobPronto();
    expect(await contagens()).toMatchObject({ c: 0, ct: 0, ch: 0 });
  });

  it("18. finance_viewer NÃO aprova", async () => {
    const j = await jobPronto();
    const r = await asUser("authenticated", VIEW, `SELECT public.billing_import_approve('${j}') AS r`);
    expect((r.rows[0] as { r: Record<string, unknown> }).r).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("19 e 20. finance aprova e o commit é transacional — só linhas válidas", async () => {
    const j = await jobPronto();
    const ap = await asUser("authenticated", FIN, `SELECT public.billing_import_approve('${j}') AS r`);
    expect((ap.rows[0] as { r: { ok: boolean } }).r.ok).toBe(true);
    const cm = await asUser("authenticated", FIN, `SELECT public.billing_import_commit('${j}') AS r`);
    expect((cm.rows[0] as { r: Record<string, unknown> }).r).toMatchObject({ ok: true, customers_created: 1, contracts_created: 1 });
    expect(await contagens()).toMatchObject({ c: 1, ct: 1 });
    // a linha inválida ficou no staging, não aplicada
    const st = await db.query<{ row_status: string }>(
      `SELECT row_status FROM billing_import_rows WHERE row_number=2`);
    expect(st.rows[0].row_status).toBe("invalida");
  });

  it("commit sem aprovação → recusa", async () => {
    const j = await jobPronto();
    const r = await asUser("authenticated", FIN, `SELECT public.billing_import_commit('${j}') AS r`);
    expect((r.rows[0] as { r: Record<string, unknown> }).r).toMatchObject({ ok: false, error: "not_approved" });
    expect(await contagens()).toMatchObject({ c: 0 });
  });

  it("21. job aplicado NÃO aplica de novo", async () => {
    const j = await jobPronto();
    await asUser("authenticated", FIN, `SELECT public.billing_import_approve('${j}')`);
    await asUser("authenticated", FIN, `SELECT public.billing_import_commit('${j}')`);
    const r2 = await asUser("authenticated", FIN, `SELECT public.billing_import_commit('${j}') AS r`);
    expect((r2.rows[0] as { r: Record<string, unknown> }).r).toMatchObject({ ok: false, error: "already_applied" });
    expect(await contagens()).toMatchObject({ c: 1, ct: 1 });   // não duplicou
  });

  it("22. billing_events registra aprovação, aplicação e entidades criadas", async () => {
    const j = await jobPronto();
    await asUser("authenticated", FIN, `SELECT public.billing_import_approve('${j}')`);
    await asUser("authenticated", FIN, `SELECT public.billing_import_commit('${j}')`);
    const e = await db.query<{ event: string }>(`SELECT event FROM billing_events ORDER BY id`);
    const eventos = e.rows.map((x) => x.event);
    expect(eventos).toContain("import_approved");
    expect(eventos).toContain("import_applied");
    expect(eventos).toContain("customer_created");
    expect(eventos).toContain("contract_created");
  });

  it("23. anon sem qualquer acesso ao staging", async () => {
    await jobPronto();
    for (const sql of [`SELECT * FROM public.billing_import_jobs`,
                       `SELECT * FROM public.billing_import_rows`]) {
      let vazio = false;
      try { vazio = ((await asUser("anon", null, sql)).rows.length === 0); } catch { vazio = true; }
      expect(vazio, sql).toBe(true);
    }
  });

  it("authenticated sem papel financeiro não enxerga o staging", async () => {
    await jobPronto();
    const r = await asUser("authenticated", NINGUEM, `SELECT * FROM public.billing_import_jobs`);
    expect(r.rows).toHaveLength(0);
  });

  it("o vínculo cliente↔fazenda é criado sem escrever em farms", async () => {
    const antes = (await db.query<{ n: string }>(`SELECT name n FROM public.farms WHERE id=$1`, [FARM])).rows[0].n;
    const j = await jobPronto();
    await asUser("authenticated", FIN, `SELECT public.billing_import_approve('${j}')`);
    await asUser("authenticated", FIN, `SELECT public.billing_import_commit('${j}')`);
    const cf = await db.query<{ n: number }>(`SELECT count(*)::int n FROM billing_customer_farms`);
    expect(Number(cf.rows[0].n)).toBe(1);
    const depois = (await db.query<{ n: string }>(`SELECT name n FROM public.farms WHERE id=$1`, [FARM])).rows[0].n;
    expect(depois).toBe(antes);
  });
});

describe("24. barreira operacional", () => {
  const PROIBIDOS = ["desired_running", "pending_command_id", "public.commands", "public.equipments",
    "automation_", "scheduled_", "license_key", "device_licenses",
    "platform_set_farm_suspended", "platform_toggle_suspend"];
  const semSql = (t: string) => t.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const semTs  = (t: string) => t.split("\n").filter((l) => { const x = l.trim();
    return !x.startsWith("//") && !x.startsWith("*") && !x.startsWith("/*"); }).join("\n");

  it("a migration de staging não referencia nada operacional", () => {
    const c = semSql(M1);
    for (const p of PROIBIDOS) expect(c, p).not.toContain(p);
  });

  it("os helpers TS também não", () => {
    for (const f of ["src/lib/billingImport.ts", "src/lib/billingImportParse.ts"]) {
      const c = semTs(fs.readFileSync(path.join(REPO, f), "utf8"));
      for (const p of PROIBIDOS) expect(c, `${f}:${p}`).not.toContain(p);
    }
  });

  it("farms aparece só como leitura — nunca escrita", () => {
    const c = semSql(M1);
    expect(c).not.toMatch(/UPDATE\s+public\.farms/i);
    expect(c).not.toMatch(/INSERT\s+INTO\s+public\.farms/i);
    expect(c).not.toMatch(/DELETE\s+FROM\s+public\.farms/i);
    expect(c).not.toMatch(/ALTER\s+TABLE\s+public\.farms/i);
  });

  it("nenhuma policy ampla baseada só em authenticated", () => {
    const c = semSql(M1);
    expect(c).not.toMatch(/USING\s*\(\s*true\s*\)/i);
    expect(c).toMatch(/REVOKE ALL ON public\.%I FROM PUBLIC, anon;/);
  });
});

// Adaptador de arquivo → linhas. ISOLADO das regras: as bibliotecas de leitura
// só são importadas aqui, para que normalização/validação/duplicidade
// continuem testáveis sem I/O nem dependência externa.
//
// XLSX: `read-excel-file`. Escolhida por SUPERFÍCIE: só LÊ .xlsx. Não escreve,
// não avalia fórmula, não executa macro, não processa imagem nem estilo — e
// nada disso é necessário aqui. `xlsx`/SheetJS foi removida por carregar
// vulnerabilidades conhecidas cujas correções o upstream distribui fora do npm.
// `/universal`: mesma API no navegador e no Node — permite que o teste exercite
// o parser REAL, em vez de um mock que não provaria nada.
import readXlsxFile, { readSheet } from "read-excel-file/universal";
import Papa from "papaparse";

export interface ParsedFile { sheet: string | null; headers: string[]; rows: Array<Record<string, unknown>> }

/** Limites aplicados ANTES do parsing. Arquivo do financeiro é pequeno; um
 *  arquivo enorme só chegaria aqui por engano ou por má-fé. */
export const FILE_LIMITS = {
  maxBytes: 10 * 1024 * 1024,   // 10 MB
  maxRows: 20_000,
  maxSheets: 50,
  minBytes: 32,
};

export class ImportFileError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "ImportFileError"; }
}

export function assertFileAcceptable(name: string, bytes: number, kind: "xlsx" | "csv"): void {
  if (bytes < FILE_LIMITS.minBytes) throw new ImportFileError("arquivo_vazio", "Arquivo vazio ou corrompido");
  if (bytes > FILE_LIMITS.maxBytes) {
    throw new ImportFileError("arquivo_muito_grande",
      `Arquivo acima de ${FILE_LIMITS.maxBytes / 1024 / 1024} MB`);
  }
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  const ok = kind === "xlsx" ? ["xlsx"] : ["csv", "txt"];
  if (!ok.includes(ext)) {
    throw new ImportFileError("extensao_incompativel", `Extensão .${ext} não é aceita para ${kind}`);
  }
}

type Cell = string | number | boolean | Date | null;

/**
 * Converte a célula preservando o TIPO ORIGINAL do arquivo.
 *
 * ZEROS À ESQUERDA — a regra correta, e uma correção do que eu afirmei antes:
 * se a célula foi salva como NÚMERO, os zeros à esquerda NÃO EXISTEM no
 * arquivo. Nenhum parser os recupera, porque não há o que recuperar — o Excel
 * guardou `12345678000190`, não a string. Prometi preservação impossível.
 *
 * O que fazemos: devolver exatamente o que está armazenado, marcando a origem.
 * Célula de texto → string íntegra. Célula numérica → o número tal como está.
 * A checagem de quantidade de dígitos é da validação (`classifyDoc`), que já
 * rejeita documento com tamanho incompatível. NUNCA inventamos um zero.
 */
function cellToValue(c: Cell): unknown {
  if (c === null || c === undefined) return null;
  if (c instanceof Date) return c;                 // data continua Date
  if (typeof c === "number") return c;             // número continua número
  if (typeof c === "boolean") return c;
  const s = String(c);
  return s.trim() === "" ? null : s;               // texto íntegro, vazio vira null
}

/** Planilhas do arquivo, para o operador escolher qual importar. */
export async function listSheets(input: File | Blob | ArrayBuffer): Promise<string[]> {
  // v9: `readXlsxFile` devolve TODAS as planilhas; `readSheet` lê uma.
  const sheets = await readXlsxFile(input as never);
  const nomes = sheets.map((s) => s.sheet);   // v9: { sheet, data }
  if (nomes.length > FILE_LIMITS.maxSheets) {
    throw new ImportFileError("planilhas_demais", `Arquivo com ${nomes.length} planilhas`);
  }
  return nomes;
}

/** Lê uma planilha: 1ª linha é cabeçalho; demais viram objetos. */
export async function parseXlsx(input: File | Blob | ArrayBuffer, sheet?: string | number): Promise<ParsedFile> {
  const matriz = (sheet !== undefined
    ? await readSheet(input as never, sheet)
    : await readSheet(input as never)) as unknown as Cell[][];
  if (!matriz || !matriz.length) return { sheet: typeof sheet === "string" ? sheet : null, headers: [], rows: [] };
  if (matriz.length - 1 > FILE_LIMITS.maxRows) {
    throw new ImportFileError("linhas_demais", `Planilha com mais de ${FILE_LIMITS.maxRows} linhas`);
  }

  const headers = (matriz[0] ?? []).map((h) => String(h ?? "").trim());
  const rows = matriz.slice(1)
    .filter((l) => Array.isArray(l) && l.some((c) => c !== null && String(c).trim() !== ""))
    .map((l) => {
      const o: Record<string, unknown> = {};
      headers.forEach((h, i) => { if (h) o[h] = cellToValue(l[i] ?? null); });
      return o;
    });
  return { sheet: typeof sheet === "string" ? sheet : null, headers, rows };
}

/**
 * CSV. Delimitador detectado entre `;` e `,` — planilha brasileira exporta com
 * ponto e vírgula. Cabeçalho é OBRIGATÓRIO: sem ele não há mapeamento possível.
 * Aqui o documento chega SEMPRE como texto, então zeros à esquerda sobrevivem.
 */
export function parseCsv(text: string): ParsedFile {
  const r = Papa.parse<Record<string, unknown>>(text, {
    header: true, skipEmptyLines: "greedy",
    delimitersToGuess: [";", ",", "\t", "|"],
    transformHeader: (h) => String(h ?? "").trim(),
  });
  const headers = (r.meta?.fields ?? []).filter(Boolean);
  if (!headers.length) {
    throw new ImportFileError("sem_cabecalho",
      "CSV sem cabeçalho: a primeira linha precisa conter os nomes das colunas");
  }
  if ((r.data?.length ?? 0) > FILE_LIMITS.maxRows) {
    throw new ImportFileError("linhas_demais", `CSV com mais de ${FILE_LIMITS.maxRows} linhas`);
  }
  return { sheet: null, headers, rows: r.data ?? [] };
}

/** SHA-256 do arquivo, para auditoria de origem e alerta de reimportação. */
export async function fileSha256(data: ArrayBuffer): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

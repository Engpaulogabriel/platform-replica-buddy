// action-classifier.ts
// Classificador rápido de AÇÃO via Gemini. Substitui a fragilidade de regex
// para detectar ligar/desligar/manutenção/modo automático em linguagem natural.
//
// Saída: { intent, equipment, farm, canonical }
//   - canonical: comando reescrito na forma canônica que o parser de regex
//     existente já entende (ex.: "ligar poço 03", "manutenção poço 02",
//     "ativar modo automatico bomba 1 fazenda sossego", "liberar poço 03").
//   - intent === "conversa_livre" → o fluxo principal segue normalmente
//     (IA conversacional, fallback regex, etc.).
//
// Falha silenciosa (sem chave, timeout, JSON inválido) → retorna null. O
// caller deve cair no fluxo legado quando isso acontecer.

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-flash-latest";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export type ActionIntent =
  | "ligar"
  | "desligar"
  | "manutencao_ativar"
  | "manutencao_desativar"
  | "manutencao_concluida"
  | "modo_auto_ativar"
  | "modo_auto_desativar"
  | "conversa_livre";

export interface ActionClassification {
  intent: ActionIntent;
  equipment: string | null;
  farm: string | null;
  canonical: string;
  confidence: number;
}

const SYSTEM_PROMPT =
  `Você é o classificador de AÇÕES do bot de irrigação Renov. Sua única tarefa
é decidir se a mensagem do operador é um comando de AÇÃO sobre equipamentos
(bomba/poço) e, em caso afirmativo, extrair intent + equipamento + fazenda.

Responda APENAS chamando a função classify_action.

Intenções possíveis:
- ligar: ligar/ativar/acionar/dar partida/colocar pra rodar um equipamento
- desligar: desligar/parar/desativar/cortar/baixar um equipamento
- manutencao_ativar: colocar/ativar/ligar/habilitar/bloquear modo manutenção
- manutencao_desativar: tirar/remover/liberar/desligar/desbloquear manutenção
  (uso operacional simples — apenas remove o bloqueio)
- manutencao_concluida: manutenção FOI RESOLVIDA/concluída/finalizada/terminada/
  feita/pronta/ok pelo técnico. Frases típicas: "manutenção resolvida poço 03",
  "poço 03 pronto", "manutenção concluída bomba 02", "manutencao finalizada
  poco 08", "liberar poço 03 manutenção ok", "equipamento pronto para operar".
  Diferente de manutencao_desativar: indica conclusão do reparo e dispara
  broadcast para a equipe. Se houver QUALQUER palavra entre {concluída,
  resolvida, finalizada, terminada, feita, pronta, ok} junto à menção do
  equipamento, prefira esta intenção sobre manutencao_desativar.
- modo_auto_ativar: ativar/ligar modo automático (programações horárias)
- modo_auto_desativar: desativar/desligar/parar modo automático
- conversa_livre: pergunta, status, consulta, cumprimento, dúvida, ou
  qualquer mensagem que NÃO é um comando de ação dos tipos acima.

REGRAS:
1. Status/níveis/listagens/programações NÃO são ação — use conversa_livre.
2. Tolere erros de digitação ("manuten;ao", "manutencao", "deliga", "poxo").
3. "ligar modo manutencao poço 3" → manutencao_ativar (NÃO ligar).
4. "desligar modo automatico" → modo_auto_desativar (NÃO desligar equipamento).
5. equipment: preserve a forma original ("poço 03", "bomba 7", "todas").
   Se não houver, deixe null.
6. farm: nome da fazenda mencionada, ou null.
7. canonical: reescreva o comando na forma que o parser entende:
   - ligar: "ligar <equipment>"
   - desligar: "desligar <equipment>"
   - manutencao_ativar: "manutenção <equipment>"
   - manutencao_desativar: "liberar manutenção <equipment>"
   - manutencao_concluida: "manutencao concluida <equipment>"
   - modo_auto_ativar: "ativar modo automatico <equipment>"
   - modo_auto_desativar: "desativar modo automatico <equipment>"
   Se houver fazenda, acrescente " fazenda <farm>" no final.
   Se equipment for null, deixe só o verbo (o handler perguntará qual).
   Se intent for conversa_livre, canonical = "".
8. confidence: 0.0–1.0. Acima de 0.7 só quando você TEM CERTEZA da intent.`;

const TOOL = {
  name: "classify_action",
  description: "Classifica uma mensagem do operador como AÇÃO ou conversa livre",
  parameters: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        enum: [
          "ligar",
          "desligar",
          "manutencao_ativar",
          "manutencao_desativar",
          "manutencao_concluida",
          "modo_auto_ativar",
          "modo_auto_desativar",
          "conversa_livre",
        ],
      },
      equipment: { type: "string" },
      farm: { type: "string" },
      canonical: { type: "string" },
      confidence: { type: "number" },
    },
    required: ["intent", "canonical", "confidence"],
  },
};

// ── Circuit breaker ──────────────────────────────────────────────────────────
// O classificador Gemini é uma MELHORIA, não dependência crítica. Quando o
// upstream falha (429 quota, 5xx, timeout, rede), abrimos o circuito por 5min
// para não desperdiçar latência em chamadas que vão falhar — o caller cai no
// regex legado e o sistema continua 100% funcional.
const CIRCUIT_TTL_MS = 5 * 60 * 1000;
let circuitOpenUntil = 0;
let lastFailureReason: string | null = null;

export function isGeminiAvailable(): boolean {
  return Date.now() >= circuitOpenUntil;
}

export function getClassifierStatus(): {
  available: boolean;
  openUntilMs: number;
  msRemaining: number;
  lastFailureReason: string | null;
} {
  const now = Date.now();
  return {
    available: now >= circuitOpenUntil,
    openUntilMs: circuitOpenUntil,
    msRemaining: Math.max(0, circuitOpenUntil - now),
    lastFailureReason,
  };
}

function tripCircuit(reason: string): void {
  circuitOpenUntil = Date.now() + CIRCUIT_TTL_MS;
  lastFailureReason = reason;
  console.warn(
    `[action-classifier] CIRCUIT OPEN reason=${reason} ttl=${
      CIRCUIT_TTL_MS / 1000
    }s — fallback regex será usado até reset`,
  );
}

function closeCircuit(): void {
  if (circuitOpenUntil !== 0 || lastFailureReason !== null) {
    console.log("[action-classifier] CIRCUIT CLOSED — Gemini respondeu OK");
  }
  circuitOpenUntil = 0;
  lastFailureReason = null;
}

export async function classifyAction(
  message: string,
): Promise<ActionClassification | null> {
  if (!GEMINI_API_KEY) return null;
  const text = (message || "").trim();
  if (!text) return null;

  // Circuit aberto → não tenta. Caller deve checar isGeminiAvailable() ANTES
  // para logar o WARNING uma única vez por mensagem.
  if (!isGeminiAvailable()) return null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), attempt === 1 ? 4000 : 6000);
      const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text }] }],
          tools: [{ functionDeclarations: [TOOL] }],
          toolConfig: {
            functionCallingConfig: {
              mode: "ANY",
              allowedFunctionNames: ["classify_action"],
            },
          },
          generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
        }),
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        console.error(
          "[action-classifier] gemini",
          resp.status,
          body.slice(0, 200),
        );
        // 429 (quota) e 5xx → trip circuit imediatamente. Não adianta retry
        // dentro do mesmo request: se a quota estourou, vai estourar de novo.
        if (resp.status === 429 || resp.status >= 500) {
          tripCircuit(`http_${resp.status}`);
          return null;
        }
        // 4xx genérico (auth/payload inválido) também trip — algo está
        // estruturalmente errado e não vamos recuperar em 1 retry.
        tripCircuit(`http_${resp.status}`);
        return null;
      }
      const data = await resp.json();
      const parts = data?.candidates?.[0]?.content?.parts ?? [];
      const args = parts.find((p: any) => p?.functionCall)?.functionCall?.args;
      if (!args) {
        // Sucesso HTTP mas resposta vazia/malformada — fecha circuito (upstream
        // está vivo), mas devolve null para o caller cair no regex.
        closeCircuit();
        return null;
      }
      closeCircuit();
      const out: ActionClassification = {
        intent: (args.intent ?? "conversa_livre") as ActionIntent,
        equipment: (args.equipment ?? null) || null,
        farm: (args.farm ?? null) || null,
        canonical: String(args.canonical ?? "").trim(),
        confidence: typeof args.confidence === "number" ? args.confidence : 0,
      };
      return out;
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`[action-classifier] failed attempt=${attempt}:`, msg);
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      // Após 2 tentativas com exceção (timeout/rede) → trip circuit.
      tripCircuit(`exception:${msg.slice(0, 40)}`);
      return null;
    }
  }
  return null;
}


// ai-classifier.ts
// Classifica comandos do operador via Lovable AI Gateway (Gemini 3 Flash) com
// function calling. Retorna intent estruturada + um comando canônico em
// português que o parser de regex existente já entende, de modo que a
// integração não exige reescrever os handlers.
//
// Falhas (sem LOVABLE_API_KEY, timeout, 5xx, JSON inválido) retornam null —
// nesses casos o webhook usa a mensagem original (fallback transparente).

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-flash-latest";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export interface ClassificationResult {
  intent:
    | "turn_on"
    | "turn_off"
    | "schedule_create"
    | "schedule_delete"
    | "schedule_list"
    | "maintenance_on"
    | "maintenance_off"
    | "status"
    | "level_status"
    | "auto_mode_on"
    | "auto_mode_off"
    | "automation_create"
    | "automation_list"
    | "automation_delete"
    | "generate_code"
    | "manage_operator"
    | "help"
    | "greeting"
    | "feedback"
    | "needs_clarification"
    | "unknown";
  feedback_polarity?: "positive" | "negative" | "correction";
  equipments: string[];
  time_on?: string;
  time_off?: string;
  delay_minutes?: number;
  days?: string[];
  condition?: "before_peak" | "after_peak" | "none";
  automation_name?: string;
  maintenance_reason?: string;
  canonical_command: string;
  ai_response?: string;
  missing_field?: string;
  confidence: number;
  raw_message: string;
  tokens_input?: number;
  tokens_output?: number;
  execution_time_ms?: number;
}

const SYSTEM_PROMPT = `Você é o classificador de comandos do sistema de irrigação da Renov Tecnologia.
Sua ÚNICA função é interpretar mensagens curtas de operadores rurais e
extrair a intenção usando a ferramenta fornecida.

CONTEXTO:
- O sistema controla bombas/poços de irrigação (BOMBA 1, POÇO 2, etc.)
- "Horário de ponta" = 18h às 21h (condition=before_peak antes desse horário)
- "Modo automático" = roteamento de programações horárias
- "Automação" = regra independente (criar/listar/excluir)

CONTEXTO CONVERSACIONAL:
Você tem acesso às últimas mensagens da conversa. Use esse contexto para
entender referências como "o que houve?", "por que não funcionou?", "e agora?",
"faz de novo", "tenta de novo", "cadê?", etc. Se o operador perguntar algo
sobre um comando anterior, responda com base no histórico (na ai_response,
quando o intent for greeting/unknown/feedback) ou reaproveite o canonical
anterior quando ele pedir para repetir/refazer a ação.

FEEDBACK (auto-aprendizado):
Quando o operador estiver reagindo à SUA última resposta (e não emitindo um
novo comando), classifique como intent="feedback" e preencha feedback_polarity:
- "isso mesmo", "exato", "perfeito", "valeu", "show", "👍" → positive
- "não era isso", "errado", "não foi isso que pedi", "tá errado" → negative
- "eu quis dizer …", "na verdade era …", "queria …" → correction
Para correção, reescreva o que o operador realmente queria em canonical_command
(ex.: "ligar poço 3"). Para positive/negative deixe canonical_command vazio.

REGRAS:
1. "liga a 1 e a 3" → equipments=["1","3"]
2. "todas"/"todos" → equipments=["todos"]
3. Range "1-4" → ["1","2","3","4"]
4. "1,2,3" → ["1","2","3"]
5. Tolere ortografia: poxo=poço, boba/bomaba=bomba, deliga=desligar
6. Programar/agendar/timer → schedule_create
7. Apagar/excluir prog → schedule_delete
8. Ver/listar prog → schedule_list
9. Manutenção/reparo/bloquear → maintenance_on
10. Liberar/sair manutenção → maintenance_off
11. Ativar/ligar automático → auto_mode_on
12. Desativar/parar automático → auto_mode_off
13. Cumprimentos ("oi","bom dia") → greeting
13.0. Códigos de cadastro/convites/acessos para novos operadores/supervisores → intent="generate_code".
    Variantes e canonical_command:
    - GERAR: "gerar código", "gerar código para cadastro", "novo código", "criar código", "novo acesso", "criar convite" → canonical_command="gerar codigo"
    - LISTAR: "códigos ativos", "listar códigos", "ver códigos", "quais códigos estão ativos", "códigos abertos" → canonical_command="codigos ativos"
    - CANCELAR TODOS: "cancele os códigos", "cancele os dois códigos", "cancelar todos os códigos", "cancela os códigos ativos", "invalida os códigos", "apagar códigos", "excluir códigos" → canonical_command="cancelar codigos"
    - CANCELAR ESPECÍFICO: "cancelar código 48271635" → canonical_command="cancelar codigo 48271635"
    Sempre use intent="generate_code" para QUALQUER operação de códigos (gerar/listar/cancelar). Nunca responda que não consegue; apenas classifique para o webhook executar.
13.0b. GERENCIAMENTO DE OPERADORES (super_admin) → intent="manage_operator".
    Variantes e canonical_command (preserve nome e fazenda EXATAMENTE como o usuário escreveu):
    - EXCLUIR: "excluir gestor João Silva", "remover operador Maria da Fazenda X", "revogar acesso de Paulo", "desativar João" → canonical_command="excluir gestor João Silva" (ou "excluir gestor João da fazenda X")
    - BLOQUEAR: "bloquear João", "suspender Maria" → canonical_command="bloquear João"
    - DESBLOQUEAR: "desbloquear João", "reativar Maria", "ativar João" → canonical_command="desbloquear João"
    - LISTAR: "listar operadores", "quem tem acesso", "operadores da fazenda X", "gestores ativos", "supervisores" → canonical_command="listar operadores" (ou "listar operadores da fazenda X")
    Sempre use intent="manage_operator" para QUALQUER operação de gerenciamento de operadores. NÃO confunda com generate_code.
13.1. STATUS vs NÍVEIS — DISTINÇÃO CRÍTICA:
    - "status", "como estão as bombas", "resumo", "como tá tudo", "geral",
      "situação das bombas" → intent="status", canonical_command="status"
      (resumo geral de bombas/poços ligados/desligados).
    - "níveis", "nível", "como estão os níveis", "qual o nível",
      "nível do reservatório", "nível do canal", "leitura do reservatório",
      "altura da água", "quanto tem de água" → intent="level_status",
      canonical_command="nivel" (ou "nivel reservatorio 1" se especificar).
      "Níveis" refere-se a SENSORES DE NÍVEL (reservatório/canal), NUNCA ao
      status geral de bombas.
14. confidence > 0.7 só quando você TEM CERTEZA do intent e dos equipamentos
15. NUNCA invente equipamentos não mencionados
16. "daqui X minutos/horas" → preencher delay_minutes
17. NUMERAÇÃO: preserve EXATAMENTE como o operador escreveu no canonical_command.
    Se o usuário disse "poço 02", o canonical é "ligar poço 02" (NÃO "ligar poço 2").
    Se disse "bomba 7", mantenha "7". Isso garante casamento com nomes cadastrados
    como "POÇO 02", "BOMBA 7", etc.
18. CLARIFICAÇÃO (needs_clarification): quando o operador mencionar equipamento
    no SINGULAR (bomba, poço, conjunto, motor) SEM número e SEM indicação de
    "todas/todos/tudo/geral", responda intent="needs_clarification" e pergunte
    qual. NÃO tente adivinhar e NÃO pegue um aleatório. Exemplos:
    - "status da bomba" → needs_clarification, ai_response="Qual bomba? Me diz o número."
    - "liga a bomba" → needs_clarification, ai_response="Qual bomba quer ligar?"
    - "desliga o poço" → needs_clarification, ai_response="Qual poço quer desligar?"
    - "manutenção bomba" → needs_clarification, ai_response="Qual bomba entrou em manutenção?"
    EXCEÇÕES (NÃO peça clarificação):
    - Plural ("status das bombas", "liga as bombas") → trate como TODAS.
    - "status geral", "como estão as bombas", "resumo" → status de TODAS.
    - "todas/todos/tudo" explícito → equipments=["todos"].
    - Contexto conversacional torna óbvio qual equipamento (ex.: bot acabou de
      perguntar "qual bomba?" e operador respondeu "3" → resolva para bomba 3).
    Para needs_clarification preencha missing_field="equipment_number" e deixe
    equipments=[] e canonical_command="".

CANONICAL_COMMAND (obrigatório):
Reescreva a mensagem na forma canônica que o parser entende, sem gírias e
sem erros de digitação. Exemplos:
- "liga a boba 1 e a 3" → "ligar bomba 1 e ligar bomba 3"
- "para tudo agora" → "desligar todas"
- "manuten poço 2 troca de fio" → "manutenção poço 2 troca de fio"
- "ver progs" → "listar programações"
- "gerar código para cadastro de supervisor" → "gerar codigo"
- "bom dia" → "" (string vazia para greeting/unknown/needs_clarification)
Use vírgula ou " e " entre comandos compostos.

AI_RESPONSE (apenas para intent='greeting', 'unknown' e 'needs_clarification'):
Gere uma resposta curta e natural em português, como um colega de trabalho
profissional responderia no WhatsApp. Máximo 1-2 linhas. Sem menus, sem
bullet points, sem emojis exagerados, sem se identificar como bot ou
assistente. Seja direto e eficiente — operadores rurais são pessoas ocupadas.

Use o primeiro nome do operador OCASIONALMENTE (não em toda mensagem). Combine
naturalmente com o horário do dia (bom dia/boa tarde/boa noite) quando o
operador cumprimentar.

Exemplos CORRETOS para greeting:
- "Boa tarde! Tudo certo por aí? Precisa de algo?"
- "Boa tarde, Gabriel. No que posso te ajudar?"
- "Bom dia. Precisa de alguma coisa?"

Exemplos CORRETOS para unknown:
- "Não entendi bem. Quer ligar ou desligar alguma bomba?"
- "Como assim? Me explica melhor o que precisa."

Exemplos CORRETOS para needs_clarification:
- "Qual bomba? Me diz o número."
- "Qual poço quer ligar?"
- "Qual bomba você quer desligar?"

Exemplos ERRADOS (NUNCA faça):
- "Olá! Sou o assistente da Renov..."
- "Comandos rápidos: • ligar/desligar..."
- Listas com bullet points ou menus formatados.

Para outros intents, deixe ai_response vazio.`;

const TOOL_DEFINITION = {
  type: "function" as const,
  function: {
    name: "classify_command",
    description: "Classifica o comando de irrigação do operador",
    parameters: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          enum: [
            "turn_on",
            "turn_off",
            "schedule_create",
            "schedule_delete",
            "schedule_list",
            "maintenance_on",
            "maintenance_off",
            "status",
            "level_status",
            "auto_mode_on",
            "auto_mode_off",
            "automation_create",
            "automation_list",
            "automation_delete",
            "generate_code",
            "manage_operator",
            "help",
            "greeting",
            "feedback",
            "needs_clarification",
            "unknown",
          ],
        },
        equipments: { type: "array", items: { type: "string" } },
        time_on: { type: "string" },
        time_off: { type: "string" },
        delay_minutes: { type: "number" },
        days: {
          type: "array",
          items: {
            type: "string",
            enum: ["seg", "ter", "qua", "qui", "sex", "sab", "dom"],
          },
        },
        condition: { type: "string", enum: ["before_peak", "after_peak", "none"] },
        automation_name: { type: "string" },
        maintenance_reason: { type: "string" },
        canonical_command: {
          type: "string",
          description:
            "Mensagem reescrita na forma canônica que o parser de regex entende.",
        },
        ai_response: {
          type: "string",
          description:
            "Resposta natural curta (apenas para intent=greeting, unknown, needs_clarification ou feedback). Vazio para outros intents.",
        },
        missing_field: {
          type: "string",
          enum: ["equipment_number", "time", "days"],
          description:
            "Apenas quando intent=needs_clarification. Indica qual informação está faltando.",
        },
        feedback_polarity: {
          type: "string",
          enum: ["positive", "negative", "correction"],
          description:
            "Apenas quando intent=feedback. Indica se o operador confirmou (positive), refutou (negative) ou corrigiu (correction) a última resposta do bot.",
        },
        confidence: { type: "number" },
      },
      required: ["intent", "equipments", "canonical_command", "confidence"],
    },
  },
};

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export async function classifyMessage(
  message: string,
  conversationHistory: ConversationTurn[] = [],
): Promise<ClassificationResult | null> {
  if (!GEMINI_API_KEY) {
    console.warn("[ai-classifier] GEMINI_API_KEY ausente — usando fallback regex");
    return null;
  }
  const started = Date.now();
  const history = (conversationHistory || [])
    .filter((m) => m && typeof m.content === "string" && m.content.trim().length > 0)
    .slice(-5)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content.slice(0, 500) }],
    }));
  const toolDecl = TOOL_DEFINITION.function;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), attempt === 1 ? 5000 : 7000);
      const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [
            ...history,
            { role: "user", parts: [{ text: message }] },
          ],
          tools: [{ functionDeclarations: [toolDecl] }],
          toolConfig: {
            functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["classify_command"] },
          },
          generationConfig: { temperature: 0.4, maxOutputTokens: 512 },
        }),
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        console.error("[ai-classifier] gemini", resp.status, body.slice(0, 200));
        if ((resp.status === 429 || resp.status >= 500) && attempt < 3) {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          continue;
        }
        return null;
      }
      const data = await resp.json();
      const parts = data?.candidates?.[0]?.content?.parts ?? [];
      const fnCall = parts.find((p: any) => p?.functionCall)?.functionCall;
      if (!fnCall?.args) return null;
      const parsed = fnCall.args as ClassificationResult;
      parsed.raw_message = message;
      parsed.execution_time_ms = Date.now() - started;
      parsed.tokens_input = data?.usageMetadata?.promptTokenCount;
      parsed.tokens_output = data?.usageMetadata?.candidatesTokenCount;
      return parsed;
    } catch (e) {
      console.error(`[ai-classifier] falhou attempt=${attempt}:`, (e as Error).message);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      return null;
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// CONFIRMATION CLASSIFIER — usado quando há comando pendente aguardando
// confirmação do operador. Não usa lista de palavras: a IA decide se a
// resposta é confirmar, cancelar, modificar ou não-relacionada.
// ──────────────────────────────────────────────────────────────────────────────

export interface PendingDecision {
  decision: "confirm" | "cancel" | "modify" | "unrelated";
  new_command?: string;
  reply?: string;
  confidence: number;
}

const PENDING_TOOL = {
  type: "function" as const,
  function: {
    name: "decide_pending",
    description: "Decide o que fazer com um comando pendente baseado na resposta do operador",
    parameters: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          enum: ["confirm", "cancel", "modify", "unrelated"],
          description:
            "confirm = executar o pendente; cancel = cancelar; modify = operador quer comando diferente (preencha new_command); unrelated = mensagem sobre outro assunto (mantém pendente).",
        },
        new_command: {
          type: "string",
          description:
            "Apenas para decision=modify. Reescreva o comando que o operador realmente quer agora, na forma canônica (ex.: 'desligar poço 03').",
        },
        reply: {
          type: "string",
          description:
            "Curta resposta natural opcional (ex.: 'Ok, cancelado.'). Vazio para confirm/modify.",
        },
        confidence: { type: "number" },
      },
      required: ["decision", "confidence"],
    },
  },
};

export async function classifyPendingResponse(
  message: string,
  pendingDescription: string,
): Promise<PendingDecision | null> {
  if (!GEMINI_API_KEY) return null;
  const sys = `Você é o juiz de confirmações do sistema de irrigação Renov.
O operador acabou de receber uma pergunta de confirmação para o comando: "${pendingDescription}".
Ele respondeu uma mensagem. Decida UMA das opções:
- confirm: ele aceitou / mandou prosseguir (ex.: "sim", "pode", "manda", "beleza", "vai", "👍", "faz isso", "tá", "com certeza", "sim por favor", "claro").
- cancel: ele recusou / mandou parar (ex.: "não", "cancela", "deixa", "esquece", "para", "espera", "agora não", "depois", "👎", "❌").
- modify: ele quer um comando diferente (ex.: "não, desliga o 3", "na verdade liga o 5", "muda pra poço 7"). Preencha new_command com a forma canônica.
- unrelated: a mensagem não tem relação com a confirmação — é outro pedido ou pergunta (ex.: "qual o status?", "que horas são?", "qual o nível?").

Seja decisivo. Em caso de dúvida entre confirm e unrelated, prefira unrelated.
Em caso de dúvida entre cancel e unrelated, prefira unrelated.`;
  const toolDecl = PENDING_TOOL.function;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: sys }] },
          contents: [{ role: "user", parts: [{ text: message }] }],
          tools: [{ functionDeclarations: [toolDecl] }],
          toolConfig: {
            functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["decide_pending"] },
          },
          generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
        }),
      });
      clearTimeout(timer);
      if (!resp.ok) {
        console.error("[pending-classifier] gemini", resp.status);
        if ((resp.status === 429 || resp.status >= 500) && attempt < 2) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        return null;
      }
      const data = await resp.json();
      const parts = data?.candidates?.[0]?.content?.parts ?? [];
      const fnCall = parts.find((p: any) => p?.functionCall)?.functionCall;
      if (!fnCall?.args) return null;
      return fnCall.args as PendingDecision;
    } catch (e) {
      console.error("[pending-classifier] falhou:", (e as Error).message);
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      return null;
    }
  }
  return null;
}

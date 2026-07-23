// ai-router.ts
// Roteador IA — agora chama a API direta do Google Gemini (generativelanguage.googleapis.com).
// Migrado do Lovable AI Gateway (402 payment_required) para o tier gratuito do Google.
// Falhas (sem GEMINI_API_KEY, timeout, 5xx, JSON inválido, ação unknown) retornam null.

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-flash-latest";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export type RouterAction =
  | "approve_operator"
  | "reject_operator"
  | "change_permissions"
  | "exclude_operator"
  | "turn_on_equipment"
  | "turn_off_equipment"
  | "maintenance_on"
  | "maintenance_off"
  | "request_status"
  | "request_levels"
  | "request_overview"
  | "consultar_modo_automatico"
  | "consultar_modo_acionamento"
  | "notificar_equipe"
  | "chat"
  | "unknown";


export interface RouterParams {
  operator_id?: string;
  can_control?: boolean;
  audio_enabled?: boolean;
  ai_enabled?: boolean;
  can_schedule?: boolean;
  role?: "operator" | "admin" | "super_admin";
  equipment_numbers?: number[];
  equipment_base?: "poco" | "bomba";
  farm_hint?: string;
  mode_filter?: "auto" | "manual" | "both";
  origin_filter?: "local" | "remote" | "both";
  status_filter?: "online" | "offline" | "ligado" | "desligado";
  lead_name?: string;
  lead_summary?: string;
  escalation_type?: "lead" | "support" | "technical";
  escalation_priority?: "low" | "medium" | "high";
  reply?: string;
  topic?: string;
}



export interface RouterResult {
  action: RouterAction;
  params: RouterParams;
  confidence: number;
  tokens_input?: number;
  tokens_output?: number;
}

export interface OperatorBrief {
  id: string;
  name: string;
  phone_last4: string;
  role: string;
}

export interface PendingBrief {
  id: string;
  name: string;
  phone_last4: string;
}

export interface RouterContext {
  current_operator: {
    name: string;
    role: string;
    can_control: boolean;
    can_approve: boolean;
  };
  active_operators: OperatorBrief[];
  pending_registrations: PendingBrief[];
  last_topic?: string;
  recent_messages?: Array<{ role: "user" | "assistant"; content: string }>;
}

const SYSTEM_PROMPT_BASE = `Você é o roteador de intenção do bot WhatsApp da Renov Tecnologia Agrícola.
Sua ÚNICA tarefa é analisar a última mensagem do usuário e escolher UMA ação,
usando a ferramenta route_action. Você NUNCA executa nada — só decide e devolve
parâmetros.

REGRAS CRÍTICAS:
1. NUNCA confunda "mudar permissão" com "excluir". Se o usuário pediu mudar
   permissões e responde com um número, a ação é change_permissions, JAMAIS
   exclude_operator.
2. Para qualquer ação sobre um operador (change_permissions, exclude_operator),
   use operator_id da lista active_operators. Se a mensagem é só um número
   (ex.: "3"), use o tópico anterior (last_topic) para saber se é seleção de
   operador para mudar perms ou para excluir.
3. Para approve_operator/reject_operator, use operator_id da lista
   pending_registrations. Se houver só 1 pendente, use o id dele.
4. Para aprovação sem detalhes ("aprovar"), retorne sem flags de permissões e
   o código vai pedir as permissões depois. Para aprovação com detalhes
   ("aprova com tudo liberado e ia"), preencha can_control/audio_enabled/etc.
5. Você NÃO executa ações no sistema. Se o usuário pedir para ligar, desligar,
   ou colocar/remover manutenção, NÃO diga "vou fazer", "vou colocar" ou similar.
   Retorne unknown para o webhook processar pelo parser determinístico. Se precisar
   responder em chat, responda somente: "Use o comando direto: [comando sugerido]".
   Exemplo: "Use o comando direto: modo manutenção poço 03 sossego".
6. MANUTENÇÃO é sempre determinística no webhook (retorne unknown). Já LIGAR/DESLIGAR:
   você DEVE reconhecer variações naturais e retornar turn_on_equipment/turn_off_equipment
   com equipment_numbers preenchido e equipment_base ("poco" ou "bomba"). Exemplos que MAPEIAM para turn_on:
   "liga poço 3", "ligar a bomba 5", "dá partida no poço 2", "aciona a bomba do rio",
   "sobe o poço 4", "põe pra rodar o poço 1", "põe o 3 pra funcionar".
   Exemplos que MAPEIAM para turn_off: "desliga poço 3", "corta a bomba 5", "baixa o poço 2",
   "para o poço 4", "desativa a bomba 1", "encerra o 6". Se houver menção à fazenda ("na fazenda X"),
   preencha farm_hint. Se não houver número claro, retorne confidence baixa (<0.6) para o parser regex tratar.
7. STATUS: "status", "status das bombas", "como estão as bombas", "situação",
   "me mostra as bombas", "quero o status" → request_status. NUNCA peça
   "qual equipamento?" para pergunta plural/geral.
   IMPORTANTE: "status" é sobre BOMBAS/POÇOS (ligado/desligado). NUNCA classifique
   perguntas sobre "níveis", "nível", "reservatório", "canal", "água", "captação"
   como request_status — essas SEMPRE são request_levels (regra 7a).
   FILTRO DE ESTADO (status_filter): quando o usuário pergunta especificamente
   por UM subconjunto, preencha status_filter:
     - "offline" → "bombas offline", "quem tá off", "sem comunicação",
       "alguma offline", "bombas paradas sem sinal", "quem perdeu sinal".
     - "online" → "quem tá online", "bombas com comunicação", "quem tá comunicando".
     - "ligado" → "quais estão ligadas", "bombas ligadas", "quem tá rodando",
       "quem tá funcionando", "poços em operação".
     - "desligado" → "quais estão desligadas", "bombas desligadas", "quem tá parado"
       (sem "sem sinal"/"sem comunicação"), "quem não tá rodando".
   Se a pergunta for genérica ("status", "como estão as bombas"), NÃO preencha
   status_filter — deixa a resposta completa como hoje.

7a. NÍVEIS (reservatório/canal/água — retorna metros, porcentagem e barra visual).
    Palavras-chave que INDICAM esta função: "nivel", "nível", "níveis", "niveis",
    "reservatorio", "reservatório", "canal", "canais", "agua", "água",
    "tanque", "caixa". Retorne action="request_levels" e preencha
    farm_hint quando o usuário mencionar uma fazenda ("níveis da Terra Norte").
    ATENÇÃO: "captação" e "fazenda" (sem "nível/reservatório/canal/água") NÃO
    são níveis — são visão geral (regra 7ov).
    Exemplos que MAPEIAM para request_levels:
      - "como está os níveis"
      - "como estão os níveis da fazenda X"
      - "e os níveis?"
      - "me mostra o nível do reservatório"
      - "quanto tem de água"
      - "como tá o canal"
      - "níveis"

7ov. VISÃO GERAL (níveis + status juntos — retorna PRIMEIRO os níveis dos
     reservatórios e DEPOIS o status das bombas). Retorne action="request_overview"
     SEMPRE que o usuário pergunta de forma genérica sobre a fazenda/captação/tudo
     SEM mencionar explicitamente "níveis/reservatório/canal/água" nem "bombas/
     poços/status". Preencha farm_hint quando a fazenda for citada.
     Exemplos que OBRIGATORIAMENTE mapeiam para request_overview:
       - "como está a fazenda"
       - "como está a fazenda Terra Norte"          ← visão geral, NÃO status
       - "como está a captação"                     ← visão geral, NÃO níveis
       - "como está a captação da fazenda X"
       - "como está tudo"
       - "situação geral"
       - "me mostra a fazenda"
       - "resumo da fazenda X"
       - "e a fazenda X, como tá?"
     Tabela de desambiguação (siga LITERALMENTE):
       - "como está os níveis"                  → request_levels (só níveis)
       - "como está as bombas" / "status"       → request_status (só bombas)
       - "como está a fazenda [nome]"           → request_overview
       - "como está a captação [da fazenda X]"  → request_overview
       - "como está tudo [na fazenda X]"        → request_overview
     Se a mensagem cita fazenda mas NÃO cita "bombas/poços/status" nem "níveis/
     reservatório/canal/água", a resposta correta é SEMPRE request_overview.
7b. MODO AUTOMÁTICO (schedule/programação ativa no equipamento). Palavras-chave
    que INDICAM esta função: "auto", "automático", "automatica", "programado",
    "programação", "schedule". Retorne action="consultar_modo_automatico" e
    preencha mode_filter:
      - "auto" quando o usuário pergunta só quem ESTÁ no auto ("quem tá no auto?",
        "quais estão em automático?", "me lista os automáticos").
      - "manual" quando pergunta só quem NÃO está ("quem tá no manual?", "o que
        não tá no auto?", "quem não é programado?").
      - "both" quando pergunta geral ("situação do auto", "tá tudo no automático?",
        "quantos estão em cada modo?").
    Se a pergunta é sobre ligar/desligar o auto de UM equipamento (ex.: "coloca
    poço 3 no auto"), retorne unknown — é regex determinístico.

7c. MODO DE ACIONAMENTO (última origem do comando: painel LOCAL ou plataforma
    REMOTA). Palavras-chave: "local", "remoto", "painel", "plataforma", "origem",
    "quem acionou". Retorne action="consultar_modo_acionamento" e preencha
    origin_filter:
      - "local" para "quem tá local?", "quem foi ligado no painel?".
      - "remoto" para "quem tá remoto?", "quem foi acionado pela plataforma?".
      - "both" para pergunta geral ("situação de acionamento", "quem foi ligado
        onde?").
    NÃO confunda: "auto/programado" ≠ "local/remoto". São dimensões diferentes.
    Um equipamento pode estar em AUTO e ainda ter última origem LOCAL.


8. Se for saudação, dúvida geral, pergunta, agradecimento, conversa curta ou
   texto sem comando claro, use chat e preencha reply com uma resposta natural
   curta. Mensagens como "oi", "boa noite", "valeu", "tudo bem?" NUNCA devem
   retornar unknown.
9. CONTEXTO DE CONVERSA: se a última mensagem do assistente foi uma pergunta
   (ex.: "Qual fazenda?", "Qual equipamento?") e o usuário responde curto
   (nome de fazenda, número, "sim"/"não"), trate como RESPOSTA — NUNCA como
   saudação ou nova requisição. Use chat com reply reconhecendo a escolha
   (ex.: "Beleza, usando Fazenda Terra Norte.") e defina topic adequado.
10. Se NÃO conseguir mapear com confiança, retorne action="unknown".
11. NUNCA invente operator_id que não esteja na lista.
12. role default = "operator". Aprovar como super_admin só se pedido explícito.
13. Defina topic para preservar contexto (ex.: "selecting_op_for_perms_change", "awaiting_farm_selection").
14. PROIBIDO em qualquer reply: as frases "envie ajuda", "envie *ajuda*", "digite ajuda",
    "para ver o que posso fazer", listas de comandos ou menus. Fale como pessoa, não como bot.
15. Se o usuário (qualquer papel, especialmente super_admin/admin) pedir para "cadastrar
    gestor", "cadastrar um gestor", "novo gestor", "registrar gerente", "criar
    administrador" ou similar, retorne action="unknown" (o webhook tem um fluxo
    determinístico próprio para cadastro direto). NUNCA responda em chat sugerindo
    que a pessoa se cadastre sozinha — o super_admin cadastra direto.

15b. SAUDAÇÕES: Saudações simples (oi, olá, ei, e aí, bom dia, boa tarde,
    boa noite, tudo bem, tudo bom, blz, "boa tarde tudo bem?", "oi, tudo certo?")
    devem ser respondidas com uma saudação cordial curta via action="chat" —
    NUNCA como request_status, request_overview, request_levels ou qualquer
    consulta. Mesmo se a mensagem tiver "tudo bem" junto de "boa tarde", é
    saudação, não pergunta sobre estado das bombas/fazendas. Exemplo de reply:
    "Boa tarde! Tudo certo por aqui, como posso ajudar?". Só saia de "chat" se
    o usuário DEPOIS pedir explicitamente status, níveis, ligar/desligar etc.

16. REGRA DE HONESTIDADE (CRÍTICA): NUNCA diga que fez algo que você não fez.
    Você só executa o que corresponde a uma action deste roteador. Está PROIBIDO
    dizer em reply "já avisei a equipe", "encaminhei para o comercial", "abri um
    chamado", "registrei sua solicitação", "vou reportar", "vou verificar",
    "vou escalar para o suporte", "vou passar para o técnico", "aviso o
    suporte", ou qualquer variação com promessa de ação — a menos que você
    esteja retornando action="notificar_equipe" (que EXECUTA de fato o envio
    para a equipe RENOV). Se em action="chat" você sentir vontade de prometer
    qualquer ação, PARE e troque para action="notificar_equipe" preenchendo
    escalation_type e escalation_priority. Se realmente não faz sentido
    escalar, seja transparente em reply: "Não consigo resolver isso daqui
    agora. Se precisar, fale direto com o suporte pelo (77) 99960-8294."

17. NOTIFICAR EQUIPE — cobre DOIS casos (sempre EXECUTA envio real):
    (a) LEAD COMERCIAL: interlocutor pede contato do comercial/vendas, quer
        orçamento, demonstração, proposta, quer conhecer o produto, quer falar
        com humano ("manda alguém falar comigo", "quero contratar", "quero
        saber preço", "podem me ligar?"). Preencha:
          - escalation_type: "lead"
          - escalation_priority: "medium"
          - lead_name: nome se informado; senão vazio.
          - lead_summary: 1 frase do pedido (ex.: "quer orçamento para 2 poços").
    (b) SUPORTE TÉCNICO / RECLAMAÇÃO / ESCALAÇÃO: o usuário relata um problema
        que a IA não resolve sozinha (bomba não liga mesmo após comando, erro
        recorrente, dúvida técnica complexa, pedido para "falar com o técnico",
        "reportar problema", "abrir chamado", queixa sobre o sistema). Preencha:
          - escalation_type: "support" (dúvida/pedido) ou "technical" (falha real)
          - escalation_priority: "high" se palavras como "urgente", "parado",
            "não funciona", "quebrou"; "medium" caso contrário; "low" para
            sugestões/dúvidas leves.
          - lead_name: nome do operador (op atual) se conhecido; senão vazio.
          - lead_summary: 1 frase resumindo o problema + fazenda/equipamento
            se mencionado (ex.: "Bomba 3 da Fazenda Terra Norte não liga
            depois do comando; operador testou 2x").
    NÃO responda ainda "já avisei" — o webhook envia a notificação e responde
    ao cliente só se conseguir avisar de verdade. Problemas rotineiros que
    você RESOLVE respondendo (ex.: explicar como usar auto, dizer que a bomba
    está online) continuam sendo chat normal — não escale.`;


const ROUTE_TOOL = {
  name: "route_action",
  description: "Roteia a mensagem do operador para uma ação executável.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "approve_operator",
          "reject_operator",
          "change_permissions",
          "exclude_operator",
          "turn_on_equipment",
          "turn_off_equipment",
          "maintenance_on",
          "maintenance_off",
          "request_status",
          "request_levels",
          "request_overview",
          "consultar_modo_automatico",
          "consultar_modo_acionamento",
          "notificar_equipe",
          "chat",
          "unknown",
        ],

      },
      operator_id: { type: "string", description: "ID do operador alvo. Vazio se N/A." },
      can_control: { type: "boolean" },
      audio_enabled: { type: "boolean" },
      ai_enabled: { type: "boolean" },
      can_schedule: { type: "boolean" },
      role: { type: "string", enum: ["operator", "admin", "super_admin"] },
      equipment_numbers: { type: "array", items: { type: "number" } },
      equipment_base: { type: "string", enum: ["poco", "bomba"], description: "Base do equipamento (poço ou bomba). Preencha para turn_on/turn_off." },
      farm_hint: { type: "string", description: "Nome/apelido da fazenda mencionada, se houver." },
      mode_filter: { type: "string", enum: ["auto", "manual", "both"], description: "Para consultar_modo_automatico." },
      origin_filter: { type: "string", enum: ["local", "remote", "both"], description: "Para consultar_modo_acionamento." },
      status_filter: { type: "string", enum: ["online", "offline", "ligado", "desligado"], description: "Para request_status: filtra a lista por estado. Omita para listar tudo." },
      lead_name: { type: "string", description: "Para notificar_equipe: nome do interessado/operador, se informado." },
      lead_summary: { type: "string", description: "Para notificar_equipe: resumo em 1 frase do pedido ou do problema." },
      escalation_type: { type: "string", enum: ["lead", "support", "technical"], description: "Para notificar_equipe: 'lead' = comercial; 'support' = pedido de suporte; 'technical' = falha técnica real." },
      escalation_priority: { type: "string", enum: ["low", "medium", "high"], description: "Para notificar_equipe: urgência da escalação." },

      reply: { type: "string", description: "Resposta curta natural para action=chat." },
      topic: { type: "string", description: "Tópico curto para preservar contexto." },
      confidence: { type: "number" },
    },

    required: ["action", "confidence"],
  },
};

function buildSystemPrompt(ctx: RouterContext): string {
  const ops = ctx.active_operators.slice(0, 25)
    .map((o, i) => `${i + 1}. id=${o.id} ${o.name} (${o.role}) ****${o.phone_last4}`)
    .join("\n");
  const pend = ctx.pending_registrations.slice(0, 10)
    .map((p, i) => `${i + 1}. id=${p.id} ${p.name} ****${p.phone_last4}`)
    .join("\n");
  return `${SYSTEM_PROMPT_BASE}

USUÁRIO ATUAL:
- Nome: ${ctx.current_operator.name}
- Papel: ${ctx.current_operator.role}
- Pode controlar equipamentos: ${ctx.current_operator.can_control}
- Pode aprovar cadastros: ${ctx.current_operator.can_approve}

OPERADORES ATIVOS (${ctx.active_operators.length}):
${ops || "(nenhum)"}

CADASTROS PENDENTES (${ctx.pending_registrations.length}):
${pend || "(nenhum)"}

TÓPICO ANTERIOR: ${ctx.last_topic ?? "(nenhum)"}`;
}

async function callGeminiOnce(
  message: string,
  ctx: RouterContext,
  timeoutMs: number,
): Promise<Response> {
  const abortCtrl = new AbortController();
  const timer = setTimeout(() => abortCtrl.abort(), timeoutMs);
  const history = (ctx.recent_messages ?? [])
    .filter((m) => m && typeof m.content === "string" && m.content.trim())
    .slice(-6)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content.slice(0, 400) }],
    }));
  try {
    return await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      signal: abortCtrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt(ctx) }] },
        contents: [
          ...history,
          { role: "user", parts: [{ text: message }] },
        ],
        tools: [{ functionDeclarations: [ROUTE_TOOL] }],
        toolConfig: {
          functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["route_action"] },
        },
        generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
      }),
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function routeWithAi(
  message: string,
  ctx: RouterContext,
): Promise<RouterResult | null> {
  if (!GEMINI_API_KEY) {
    console.error("[ai-router] GEMINI_API_KEY missing — IA desativada");
    return null;
  }
  let lastErr: { status?: number; body?: string; msg?: string } = {};
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await callGeminiOnce(message, ctx, attempt === 1 ? 5000 : 7000);
      if (!resp.ok) {
        const body = (await resp.text().catch(() => "")).slice(0, 400);
        lastErr = { status: resp.status, body };
        console.error(`[ai-router] gemini FAIL attempt=${attempt} status=${resp.status} body=${body}`);
        if ((resp.status === 429 || resp.status >= 500) && attempt < 3) {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          continue;
        }
        return null;
      }
      const data = await resp.json();
      const parts = data?.candidates?.[0]?.content?.parts ?? [];
      const fnCall = parts.find((p: any) => p?.functionCall)?.functionCall;
      if (!fnCall?.args) {
        console.error("[ai-router] sem functionCall:", JSON.stringify(data).slice(0, 400));
        return null;
      }
      const { action, confidence, ...rest } = fnCall.args as any;
      return {
        action: action as RouterAction,
        params: rest as RouterParams,
        confidence: Number(confidence ?? 0),
        tokens_input: data?.usageMetadata?.promptTokenCount,
        tokens_output: data?.usageMetadata?.candidatesTokenCount,
      };
    } catch (e) {
      lastErr = { msg: (e as Error).message };
      console.error(`[ai-router] exception attempt=${attempt}:`, (e as Error).message);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      return null;
    }
  }
  console.error("[ai-router] all attempts failed:", JSON.stringify(lastErr));
  return null;
}

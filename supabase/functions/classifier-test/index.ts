// Temporary E2E test harness for the action classifier.
// Invokes Gemini directly via classifyAction() for a known battery of messages.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { classifyAction } from "./action-classifier.ts";

const CASES: Array<{ text: string; expected: string; note?: string }> = [
  { text: "bota o poço 03 em manutenção", expected: "manutencao_ativar" },
  { text: "liga o 03 da sossego", expected: "ligar" },
  { text: "desliga tudo da terra norte", expected: "desligar" },
  { text: "tira manutenção do poço 01", expected: "manutencao_desativar" },
  { text: "ativa modo automático poço 04 semear", expected: "modo_auto_ativar" },
  { text: "desativa auto do conjunto 01", expected: "modo_auto_desativar" },
  { text: "manuten;ao poco 03", expected: "manutencao_ativar", note: "typos" },
  { text: "liga modo manutencao", expected: "manutencao_ativar", note: "no equipment → ask" },
  { text: "desliga tudo", expected: "desligar", note: "bulk → confirm" },
  { text: "qual o status do poco 03?", expected: "conversa_livre" },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const results = [];
  for (const c of CASES) {
    const t0 = Date.now();
    const r = await classifyAction(c.text);
    results.push({
      text: c.text,
      expected: c.expected,
      note: c.note ?? null,
      got_intent: r?.intent ?? null,
      equipment: r?.equipment ?? null,
      farm: r?.farm ?? null,
      canonical: r?.canonical ?? null,
      confidence: r?.confidence ?? null,
      pass: r?.intent === c.expected,
      ms: Date.now() - t0,
    });
    await new Promise((res) => setTimeout(res, 4500)); // respect 15 RPM free tier
  }
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
  };
  return new Response(JSON.stringify({ summary, results }, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

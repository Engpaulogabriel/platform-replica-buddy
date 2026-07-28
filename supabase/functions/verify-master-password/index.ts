import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Compara em tempo constante (evita timing side-channel na descoberta da senha).
function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const len = Math.max(ea.length, eb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  }
  return diff === 0;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ valid: false, error: "method_not_allowed" }, 405);
  }

  const masterPassword = Deno.env.get("MASTER_PASSWORD");
  if (!masterPassword) {
    // Secret ausente no projeto — não é senha errada, é configuração.
    return json({ valid: false, error: "not_configured" }, 503);
  }

  let password = "";
  try {
    const body = await req.json();
    password = typeof body?.password === "string" ? body.password : "";
  } catch (_) {
    return json({ valid: false, error: "bad_request" }, 400);
  }

  const valid = constantTimeEqual(password.trim(), masterPassword.trim());

  // 200 tanto para válido quanto inválido — o cliente lê `data.valid`.
  // Status !=2xx fica reservado a erros reais (not_configured/bad_request).
  return json({ valid }, 200);
});

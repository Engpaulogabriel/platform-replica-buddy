// validate-diag-pin — Modo Técnico do renov_diag.
// ───────────────────────────────────────────────────────────────────────────
// A ferramenta manda { pin, machine_id }. Validamos o PIN (diag_pins: não usado,
// não expirado), marcamos usado + machine_id, e devolvemos a senha CFG
// CRIPTOGRAFADA com AES-256-GCM. A chave é derivada de PBKDF2(pin, salt=machine_id)
// — a ferramenta re-deriva a MESMA chave (conhece pin+machine_id) e decifra. A
// senha ("renovrenov", env DIAG_CFG_PASSWORD) NUNCA vai em claro nem fica no
// binário; só sai daqui cifrada, e só após PIN válido. Sessão de 10 min.
// verify_jwt=false: o segredo é o próprio PIN de uso único (gerado por admin).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const ITERS = 100_000;
const SESSION_SECONDS = 600;

async function deriveKey(pin: string, machineId: string): Promise<CryptoKey> {
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: new TextEncoder().encode(machineId), iterations: ITERS, hash: "SHA-256" },
    km, { name: "AES-GCM", length: 256 }, false, ["encrypt"],
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  let body: any = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const pin = String(body?.pin ?? "").trim();
  const machineId = String(body?.machine_id ?? "").trim();
  if (!/^\d{6}$/.test(pin) || !machineId) return json({ ok: false, reason: "missing_params" }, 400);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: row } = await supabase
    .from("diag_pins")
    .select("id, used, expires_at")
    .eq("pin", pin).eq("used", false)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1).maybeSingle();
  if (!row) return json({ ok: false, reason: "pin_invalido_ou_expirado" }, 403);

  // consome o PIN (uso único) e amarra à máquina
  await supabase.from("diag_pins")
    .update({ used: true, used_at: new Date().toISOString(), machine_id: machineId })
    .eq("id", row.id).eq("used", false);

  // cifra a senha CFG (env; nunca no binário) com chave derivada de pin+machine_id
  const password = Deno.env.get("DIAG_CFG_PASSWORD") || "renovrenov";
  const key = await deriveKey(pin, machineId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctTag = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(password),
  )); // Web Crypto: ciphertext + tag(16) concatenados
  const out = new Uint8Array(iv.length + ctTag.length);
  out.set(iv, 0); out.set(ctTag, iv.length);
  const encrypted_password = btoa(String.fromCharCode(...out));

  return json({ ok: true, encrypted_password, expires_in: SESSION_SECONDS });
});

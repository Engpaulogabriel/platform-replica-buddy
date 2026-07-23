// Edge function: platform-user-admin
// Operações que requerem service role: criar usuário no auth, resetar senha, deletar.
// Apenas Platform Admins podem chamar.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface InviteBody { action: "invite"; email: string; full_name?: string; password?: string; }
interface ResetBody { action: "reset_password"; user_id: string; new_password?: string; }
interface DeleteBody { action: "delete"; user_id: string; }
type Body = InviteBody | ResetBody | DeleteBody;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) {
      return json({ ok: false, error: "missing_auth" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey     = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Cliente com JWT do usuário para validar permissão
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return json({ ok: false, error: "invalid_token" }, 401);

    const { data: isAdmin } = await userClient.rpc("is_platform_admin" as any, { _user_id: user.id });
    if (!isAdmin) return json({ ok: false, error: "forbidden" }, 403);

    // Cliente service role para operar em auth.users
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const body = (await req.json()) as Body;

    if (body.action === "invite") {
      if (!body.email || !body.email.includes("@")) {
        return json({ ok: false, error: "invalid_email" }, 400);
      }
      // Cria usuário já confirmado (admin atribui senha provisória)
      const password = body.password && body.password.length >= 8
        ? body.password
        : crypto.randomUUID().replace(/-/g, "").slice(0, 12) + "Aa1!";

      const { data, error } = await admin.auth.admin.createUser({
        email: body.email.trim().toLowerCase(),
        password,
        email_confirm: true,
        user_metadata: { full_name: body.full_name ?? null },
      });
      if (error) return json({ ok: false, error: error.message }, 400);

      return json({
        ok: true, user_id: data.user?.id, email: data.user?.email,
        provisional_password: password,
      });
    }

    if (body.action === "reset_password") {
      if (!body.user_id) return json({ ok: false, error: "missing_user_id" }, 400);
      const password = body.new_password && body.new_password.length >= 8
        ? body.new_password
        : crypto.randomUUID().replace(/-/g, "").slice(0, 12) + "Aa1!";
      const { error } = await admin.auth.admin.updateUserById(body.user_id, { password });
      if (error) return json({ ok: false, error: error.message }, 400);
      return json({ ok: true, new_password: password });
    }

    if (body.action === "delete") {
      if (!body.user_id) return json({ ok: false, error: "missing_user_id" }, 400);
      if (body.user_id === user.id) return json({ ok: false, error: "cannot_delete_self" }, 400);
      const { error } = await admin.auth.admin.deleteUser(body.user_id);
      if (error) return json({ ok: false, error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (e) {
    console.error("platform-user-admin error:", e);
    return json({ ok: false, error: String((e as Error).message ?? e) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

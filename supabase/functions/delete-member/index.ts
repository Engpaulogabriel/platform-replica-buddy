// Edge Function: delete-member
// Remove um usuário de uma fazenda (apaga user_roles).
// Se o usuário não tiver mais nenhuma fazenda, deleta a conta do Auth.
// Apenas admins/owners da fazenda podem chamar.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface Body {
  user_id: string;
  farm_id: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
      Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ error: "missing_authorization" }, 401);
    }
    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "invalid_token" }, 401);
    const caller = userData.user;

    const body = (await req.json()) as Body;
    if (!body?.user_id || !body?.farm_id) {
      return json({ error: "missing_fields" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: isAdmin, error: roleErr } = await admin.rpc("is_farm_admin", {
      _user_id: caller.id,
      _farm_id: body.farm_id,
    });
    if (roleErr) return json({ error: "role_check_failed", detail: roleErr.message }, 500);
    if (!isAdmin) return json({ error: "forbidden_not_farm_admin" }, 403);

    if (body.user_id === caller.id) {
      return json({ error: "cannot_remove_self" }, 400);
    }

    // Apaga vínculo da fazenda
    const { error: delErr } = await admin
      .from("user_roles")
      .delete()
      .eq("user_id", body.user_id)
      .eq("farm_id", body.farm_id);
    if (delErr) return json({ error: "role_delete_failed", detail: delErr.message }, 500);

    // Se não tem mais nenhuma fazenda, deleta o usuário do Auth
    const { count } = await admin
      .from("user_roles")
      .select("id", { count: "exact", head: true })
      .eq("user_id", body.user_id);

    let authDeleted = false;
    if ((count ?? 0) === 0) {
      const { error: authErr } = await admin.auth.admin.deleteUser(body.user_id);
      if (!authErr) authDeleted = true;
    }

    return json({ ok: true, auth_deleted: authDeleted });
  } catch (e) {
    return json({ error: "unexpected", detail: String(e) }, 500);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

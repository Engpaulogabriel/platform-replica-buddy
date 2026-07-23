// Edge Function: invite-member
// Cria membro de uma fazenda em dois modos:
//   - "direct":  cria usuário com senha imediata (auto-confirma email)
//   - "magic":   envia link mágico de convite por email
// Em ambos os casos: cria/garante a linha em user_roles vinculando ao farm.
// Apenas admins/owners da fazenda podem chamar.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Role = "owner" | "admin" | "operator" | "viewer";
interface Body {
  mode: "direct" | "magic";
  email: string;
  full_name?: string;
  password?: string; // obrigatório em "direct"
  role: Role;
  farm_id: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
      Deno.env.get("SUPABASE_ANON_KEY")!;

    // 1) Valida JWT do chamador
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
    if (!body?.email || !body?.role || !body?.farm_id || !body?.mode) {
      return json({ error: "missing_fields" }, 400);
    }
    if (body.mode === "direct" && (!body.password || body.password.length < 8)) {
      return json({ error: "password_min_8" }, 400);
    }

    // 2) APENAS super-admin da plataforma pode cadastrar QUALQUER usuário
    //    (impede que admins de fazenda convidem terceiros que possam copiar o sistema)
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: isPlatAdm, error: pErr } = await admin.rpc("is_platform_admin", {
      _user_id: caller.id,
    });
    if (pErr) return json({ error: "platform_check_failed", detail: pErr.message }, 500);
    if (!isPlatAdm) {
      return json({
        error: "forbidden_platform_admin_only",
        detail: "Apenas o super-admin da plataforma pode cadastrar usuários.",
      }, 403);
    }

    // 3) Cria/convida usuário no Auth
    let targetUserId: string | null = null;
    const meta = body.full_name ? { full_name: body.full_name } : undefined;

    if (body.mode === "direct") {
      const { data, error } = await admin.auth.admin.createUser({
        email: body.email,
        password: body.password!,
        email_confirm: true,
        user_metadata: meta,
      });
      if (error) {
        // Se já existir, tenta localizar por email
        if (/already.*registered|exists/i.test(error.message)) {
          const { data: list } = await admin.auth.admin.listUsers();
          targetUserId = list?.users.find((u) => u.email === body.email)?.id ?? null;
          if (!targetUserId) return json({ error: "email_exists_lookup_failed" }, 409);
        } else {
          return json({ error: "create_user_failed", detail: error.message }, 500);
        }
      } else {
        targetUserId = data.user!.id;
      }
    } else {
      // magic: usa inviteUserByEmail (gera link e envia)
      const { data, error } = await admin.auth.admin.inviteUserByEmail(body.email, {
        data: meta,
      });
      if (error) {
        if (/already.*registered|exists/i.test(error.message)) {
          const { data: list } = await admin.auth.admin.listUsers();
          targetUserId = list?.users.find((u) => u.email === body.email)?.id ?? null;
          if (!targetUserId) return json({ error: "email_exists_lookup_failed" }, 409);
        } else {
          return json({ error: "invite_failed", detail: error.message }, 500);
        }
      } else {
        targetUserId = data.user!.id;
      }
    }

    if (!targetUserId) return json({ error: "no_target_user" }, 500);

    // 4) Garante user_role no farm (idempotente)
    const { error: roleInsErr } = await admin
      .from("user_roles")
      .upsert(
        { user_id: targetUserId, farm_id: body.farm_id, role: body.role },
        { onConflict: "user_id,farm_id" },
      );
    if (roleInsErr) {
      // fallback caso não exista o índice único: deleta e insere
      await admin.from("user_roles")
        .delete()
        .eq("user_id", targetUserId)
        .eq("farm_id", body.farm_id);
      const { error: e2 } = await admin.from("user_roles").insert({
        user_id: targetUserId, farm_id: body.farm_id, role: body.role,
      });
      if (e2) return json({ error: "role_assign_failed", detail: e2.message }, 500);
    }

    return json({ ok: true, user_id: targetUserId, mode: body.mode });
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

// Edge Function: agent-release-signed-url
// Devolve uma URL assinada para baixar o app.asar de uma release do agente.
// SEGURANÇA: exige identidade real — service role key, JWT de usuário Supabase
// autenticado (painel/operador) OU o token próprio do Agent (HS256 assinado com
// AGENT_TOKEN_SECRET, emitido por agent-auth). A apikey/anon key é pública (vai
// no bundle) e por isso NÃO é aceita como autenticação.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";
import { jwtVerify } from "https://esm.sh/jose@5.9.6";
import { timingSafeEqual } from "../_shared/cronAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-agent-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // ── AUTENTICAÇÃO ────────────────────────────────────────────────────────
    // Aceita: (a) service role key, (b) JWT de usuário Supabase real (painel),
    // (c) token próprio do Agent (HS256 assinado com AGENT_TOKEN_SECRET,
    // emitido por agent-auth). Anon key NUNCA é aceita como identidade.
    const auth = (req.headers.get("authorization") ?? "").trim();
    const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    const agentHeader = (req.headers.get("x-agent-token") ?? "").trim();
    const unauthorized = (reason?: string) =>
      new Response(JSON.stringify({ error: "unauthorized", ...(reason ? { reason } : {}) }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    const isAnon = (t: string) => !!t && !!anonKey && timingSafeEqual(t, anonKey);
    const admin = createClient(supabaseUrl, serviceKey);

    // (c) token do Agent: verificação criptográfica obrigatória + claims + device_licenses
    const verifyAgentToken = async (t: string): Promise<boolean> => {
      const secretStr = Deno.env.get("AGENT_TOKEN_SECRET");
      if (!t || !secretStr || isAnon(t)) return false;
      try {
        const { payload } = await jwtVerify(t, new TextEncoder().encode(secretStr), {
          algorithms: ["HS256"],
        });
        const deviceId = typeof payload.sub === "string" ? payload.sub : "";
        const fp = typeof payload.fp === "string" ? payload.fp : "";
        const farmId = typeof payload.farm_id === "string" ? payload.farm_id : "";
        if (!deviceId || !fp || !farmId || !payload.exp || !payload.jti) return false;
        const { data: dev } = await admin
          .from("device_licenses")
          .select("id, farm_id, machine_id_hash, revoked_at")
          .eq("id", deviceId)
          .maybeSingle();
        if (!dev || dev.revoked_at || dev.machine_id_hash !== fp || dev.farm_id !== farmId) {
          return false;
        }
        console.log("[signed-url] agent autenticado", JSON.stringify({ device_id: deviceId, farm_id: farmId }));
        return true;
      } catch {
        return false;
      }
    };

    let authorized = false;
    if (bearer && !!serviceKey && timingSafeEqual(bearer, serviceKey)) {
      authorized = true;
    }
    if (!authorized) authorized = await verifyAgentToken(agentHeader);
    if (!authorized) authorized = await verifyAgentToken(bearer);
    if (!authorized && bearer && !isAnon(bearer)) {
      // (b) sessão de usuário real do painel/operador
      const authed = createClient(supabaseUrl, anonKey || bearer, {
        global: { headers: { Authorization: `Bearer ${bearer}` } },
        auth: { persistSession: false },
      });
      const { data: userRes, error: userErr } = await authed.auth.getUser(bearer);
      if (!userErr && userRes?.user?.id && userRes.user.role !== "anon") authorized = true;
    }
    if (!authorized) {
      // (d) FLUXO LEGADO: Agent sem Agent Token envia apenas a chave pública do
      // próprio projeto (header apikey e/ou Bearer). Aceito EXCLUSIVAMENTE para
      // baixar releases já registradas em agent_releases: a versão é resolvida
      // na tabela e o storage_path vem sempre do registro — nunca do cliente.
      // A chave é aceita só se: (1) for idêntica à SUPABASE_ANON_KEY do
      // ambiente, ou (2) for uma chave anon JWT do PRÓPRIO projeto, com
      // assinatura validada pelo gateway do Supabase (/auth/v1/settings).
      const projectRef = (supabaseUrl.match(/https:\/\/([a-z0-9]+)\./)?.[1]) ?? "";
      const isProjectAnonKey = async (t: string): Promise<boolean> => {
        if (!t) return false;
        if (isAnon(t)) return true;
        const parts = t.split(".");
        if (parts.length !== 3) return false;
        try {
          const claims = JSON.parse(
            atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
          );
          if (claims?.role !== "anon" || claims?.ref !== projectRef) return false;
        } catch {
          return false;
        }
        const probe = await fetch(`${supabaseUrl}/auth/v1/settings`, {
          headers: { apikey: t },
        });
        return probe.status === 200;
      };

      const apikeyHeader = (req.headers.get("apikey") ?? "").trim();
      const candidate = apikeyHeader || bearer;
      const legacyAnon =
        !!candidate &&
        (!bearer || !apikeyHeader || bearer === apikeyHeader) &&
        (await isProjectAnonKey(candidate));
      if (legacyAnon) {
        console.log("[signed-url] fluxo legado autorizado (chave pública do projeto)");
        authorized = true;
      }
    }
    if (!authorized) return unauthorized();




    // ── VERSÃO ──────────────────────────────────────────────────────────────
    // Aceita a versão em JSON, form-urlencoded, texto puro ou query string.
    // Agentes antigos podem enviar `agent_version`/`target_version`.
    const rawBody = await req.text().catch(() => "");
    let body: Record<string, unknown> = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody) ?? {};
      } catch {
        try {
          body = Object.fromEntries(new URLSearchParams(rawBody).entries());
        } catch {
          body = {};
        }
      }
    }
    const url = new URL(req.url);
    const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
    const version =
      pick(body.version) ||
      pick(body.target_version) ||
      pick(body.agent_version) ||
      pick(url.searchParams.get("version")) ||
      pick(url.searchParams.get("target_version")) ||
      (rawBody && !rawBody.trim().startsWith("{") && !rawBody.includes("=") ? rawBody.trim() : "");

    if (!version) {
      console.log(
        "[signed-url] missing_version",
        JSON.stringify({
          content_type: req.headers.get("content-type"),
          body_len: rawBody.length,
          body_preview: rawBody.slice(0, 120),
          query: url.search,
        }),
      );
      return new Response(
        JSON.stringify({
          error: "missing_version",
          hint: "envie {\"version\":\"x.y.z\"} no corpo JSON ou ?version=x.y.z",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    console.log("[signed-url] version solicitada:", version);

    // `admin` (service role) já criado acima para ler tabela e assinar URLs


    const { data: release, error: relErr } = await admin
      .from("agent_releases")
      .select(
        "version, storage_path, file_hash, file_size_bytes, artifact_type, download_url",
      )
      .eq("version", version)
      .maybeSingle();

    if (relErr || !release) {
      return new Response(JSON.stringify({ error: "release_not_found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fallback compat: releases legadas (.exe) podem não ter storage_path.
    // Devolve direto a download_url externa.
    if (!release.storage_path) {
      if (!release.download_url) {
        return new Response(JSON.stringify({ error: "no_artifact" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          url: release.download_url,
          file_hash: release.file_hash,
          file_size_bytes: release.file_size_bytes,
          artifact_type: release.artifact_type ?? "exe",
          signed: false,
          expires_in: null,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Curta duração (1h) — suficiente para OTA lento via Starlink
    const SIGNED_URL_TTL = 3600;
    const { data: signed, error: signErr } = await admin.storage
      .from("agent-releases")
      .createSignedUrl(release.storage_path, SIGNED_URL_TTL);

    if (signErr || !signed?.signedUrl) {
      return new Response(
        JSON.stringify({
          error: "sign_failed",
          detail: signErr?.message ?? "no_url",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({
        url: signed.signedUrl,
        file_hash: release.file_hash,
        file_size_bytes: release.file_size_bytes,
        artifact_type: release.artifact_type ?? "asar",
        signed: true,
        expires_in: SIGNED_URL_TTL,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: "fatal", message: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

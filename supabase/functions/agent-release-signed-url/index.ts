// Edge Function: agent-release-signed-url
// Devolve uma URL assinada para baixar o app.asar de uma release do agente.
// Compat OTA legacy: agentes v3.12.0 podem chamar com access_token expirado,
// então a função autentica pela apikey anon fixa e NÃO depende do Bearer JWT.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";

const AGENT_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const auth = req.headers.get("Authorization") ?? "";
    const apiKey = req.headers.get("apikey") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || AGENT_ANON_KEY;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Fix definitivo para OTA v3.12.0: a anon key não expira e já é enviada
    // pelo agente junto com o Bearer. O gateway deve estar com verify_jwt=false
    // para token expirado não ser barrado antes de chegar aqui.
    if (!apiKey || (apiKey !== anonKey && apiKey !== AGENT_ANON_KEY)) {
      return new Response(JSON.stringify({ error: "invalid_apikey" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validação tolerante: agentes v3.12.0 não fazem refresh de token, então
    // quando o access_token expira o OTA quebrava com 401 mesmo com credenciais
    // salvas válidas. O artefato .asar é ofuscado (RC4) e validado via SHA-256
    // no cliente, então basta exigir a apikey (anon) — token expirado não
    // bloqueia o download. Isso destrava o OTA legacy da Terra Norte.
    if (auth.toLowerCase().startsWith("bearer ")) try {
      const userClient = createClient(
        supabaseUrl,
        anonKey,
        { global: { headers: { Authorization: auth } } },
      );
      const { data: userRes } = await userClient.auth.getUser();
      if (!userRes?.user) {
        console.warn("[signed-url] token expirado/ausente — liberando OTA legacy");
      }
    } catch (e) {
      console.warn("[signed-url] falha ao validar token, seguindo:", e instanceof Error ? e.message : String(e));
    }

    const body = await req.json().catch(() => ({}));
    const version = typeof body?.version === "string" ? body.version.trim() : "";
    if (!version) {
      return new Response(JSON.stringify({ error: "missing_version" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // service role para ler tabela e assinar URLs
    const admin = createClient(supabaseUrl, serviceKey);

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

    // 24h de validade para tolerar OTA lento em fazendas com Starlink instável
    const SIGNED_URL_TTL = 86400;
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

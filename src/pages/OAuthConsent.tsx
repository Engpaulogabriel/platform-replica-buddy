import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldCheck, XCircle } from "lucide-react";

/**
 * Consent screen for Lovable-managed OAuth 2.1 authorization.
 * Route: /.lovable/oauth/consent?authorization_id=...
 *
 * Uses the supabase.auth.oauth beta namespace. If TS can't see it we call
 * through `any` — the runtime methods exist in @supabase/supabase-js.
 */
const oauth = (supabase.auth as any).oauth as {
  getAuthorizationDetails: (id: string) => Promise<{ data: any; error: any }>;
  approveAuthorization: (id: string) => Promise<{ data: any; error: any }>;
  denyAuthorization: (id: string) => Promise<{ data: any; error: any }>;
};

function isSameOriginRelative(next: string | null | undefined) {
  return !!next && next.startsWith("/") && !next.startsWith("//");
}

export default function OAuthConsent() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const authorizationId = params.get("authorization_id") ?? "";
  const [details, setDetails] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!authorizationId) {
        setError("Parâmetro authorization_id ausente na URL.");
        return;
      }
      const { data: sess } = await supabase.auth.getSession();
      if (!sess.session) {
        // Preserve the FULL consent URL so login returns the user here.
        const next = window.location.pathname + window.location.search;
        navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
        return;
      }
      try {
        const { data, error } = await oauth.getAuthorizationDetails(authorizationId);
        if (!active) return;
        if (error) {
          setError(error.message ?? "Não foi possível carregar esta autorização.");
          return;
        }
        const immediate = data?.redirect_url ?? data?.redirect_to;
        if (immediate && !data?.client) {
          window.location.href = immediate;
          return;
        }
        setDetails(data);
      } catch (e: any) {
        setError(e?.message ?? "Erro inesperado ao consultar a autorização.");
      }
    })();
    return () => {
      active = false;
    };
  }, [authorizationId, navigate]);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      const { data, error } = approve
        ? await oauth.approveAuthorization(authorizationId)
        : await oauth.denyAuthorization(authorizationId);
      if (error) {
        setError(error.message ?? "Falha ao processar sua decisão.");
        return;
      }
      const target = data?.redirect_url ?? data?.redirect_to;
      if (!target) {
        setError("Servidor de autorização não retornou URL de redirecionamento.");
        return;
      }
      window.location.href = target;
    } catch (e: any) {
      setError(e?.message ?? "Erro inesperado.");
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="max-w-md w-full rounded-2xl border-2 border-destructive/30 bg-card p-6 space-y-4">
          <div className="flex items-center gap-2 text-destructive">
            <XCircle className="w-5 h-5" />
            <h1 className="text-lg font-bold">Não foi possível carregar</h1>
          </div>
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Tentar novamente
          </Button>
        </div>
      </main>
    );
  }

  if (!details) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Carregando autorização…</span>
        </div>
      </main>
    );
  }

  const clientName =
    details?.client?.name ?? details?.client?.client_name ?? "um aplicativo";
  const redirectHost = (() => {
    try {
      const u = new URL(details?.client?.redirect_uri ?? details?.redirect_uri ?? "");
      return u.host;
    } catch {
      return null;
    }
  })();
  const scopes: string[] = Array.isArray(details?.scopes)
    ? details.scopes
    : typeof details?.scope === "string"
      ? details.scope.split(/\s+/).filter(Boolean)
      : [];

  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-md w-full rounded-2xl border-2 border-border bg-card p-6 space-y-5 shadow-lg">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-foreground">
              Conectar {clientName}
            </h1>
            <p className="text-xs text-muted-foreground">
              ao RENOV Gestor de Bombas
            </p>
          </div>
        </div>

        <p className="text-sm text-foreground">
          {clientName} poderá chamar as ferramentas MCP deste app <b>como você</b>,
          respeitando as permissões da sua conta e as políticas de acesso das suas fazendas.
        </p>

        {redirectHost && (
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Destino da conexão
            </div>
            <div className="text-sm font-mono text-foreground break-all">{redirectHost}</div>
          </div>
        )}

        {scopes.length > 0 && (
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Permissões solicitadas
            </div>
            <ul className="text-sm space-y-1">
              {scopes.map((s) => (
                <li key={s} className="text-foreground">• {s}</li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Isto não substitui as políticas de acesso do app — apenas concede a esse
          cliente a possibilidade de agir em seu nome.
        </p>

        <div className="flex gap-2 pt-2">
          <Button variant="secondary" className="flex-1" disabled={busy} onClick={() => decide(false)}>
            Cancelar
          </Button>
          <Button className="flex-1" disabled={busy} onClick={() => decide(true)}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Aprovar conexão"}
          </Button>
        </div>
      </div>
    </main>
  );
}

// Silence unused var when isSameOriginRelative isn't referenced elsewhere.
void isSameOriginRelative;

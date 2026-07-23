import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Lock, Mail, Loader2, ArrowRight, Droplets } from "lucide-react";
import renovLogo from "@/assets/renov-logo.png";
import pivotBg from "@/assets/login-pivot-irrigation.jpg";

/**
 * Pós-login: platform_admins / platform_support → /platform.
 * Demais usuários → /home (dashboard da fazenda).
 */
async function resolvePostLoginRoute(userId: string): Promise<string> {
  try {
    const [admin, support] = await Promise.all([
      supabase.from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle(),
      supabase.from("platform_support" as any).select("user_id").eq("user_id", userId).maybeSingle(),
    ]);
    if (admin.data || support.data) return "/platform";
  } catch {
    // se a checagem falhar, cai no fluxo padrão de cliente
  }
  return "/home";
}

const Login = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetMsg, setResetMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { login, isAuthenticated, user } = useAuth();
  const navigate = useNavigate();
  const [search] = useSearchParams();

  // If the user was redirected here from an OAuth consent flow (or any
  // internal same-origin route), preserve the target and return them to it
  // after sign-in. Reject non-same-origin values.
  const rawNext = search.get("next");
  const nextPath =
    rawNext && rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : null;

  // Já autenticado ao abrir /login → roteia conforme papel (ou volta para `next`)
  useEffect(() => {
    if (!isAuthenticated || !user?.id) return;
    let cancelled = false;
    (async () => {
      const dest = nextPath ?? (await resolvePostLoginRoute(user.id));
      if (!cancelled) navigate(dest, { replace: true });
    })();
    return () => { cancelled = true; };
  }, [isAuthenticated, user?.id, navigate, nextPath]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    const res = await login(email.trim(), password);
    if (res.ok) {
      sessionStorage.setItem("just_logged_in", "1");
      sessionStorage.removeItem("onboarding_shown_this_session");
      const { data: { session } } = await supabase.auth.getSession();
      const authedUser = session?.user;
      const dest = nextPath ?? (authedUser?.id ? await resolvePostLoginRoute(authedUser.id) : "/home");
      navigate(dest, { replace: true });
    } else {
      const err = (res.error ?? "").toLowerCase();
      if (err === "ip_blocked") {
        const mins = Math.ceil((res.retryAfterSeconds ?? 0) / 60);
        setError(`Muitas tentativas. Tente novamente em ${mins} minuto${mins === 1 ? "" : "s"}.`);
      } else if (err === "captcha_required_v2" || err === "captcha_required_v3") {
        setError("Verificação anti-robô necessária. Recarregue a página e tente novamente.");
      } else if (err === "invalid_credentials" || err.includes("invalid")) {
        setError("E-mail ou senha incorretos");
      } else if (err.includes("tempo esgotado")) {
        setError("Conexão demorou demais. Recarregue a página e tente novamente.");
      } else {
        setError(res.error || "Falha ao entrar");
      }
    }
    setLoading(false);
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetMsg(null);
    const target = resetEmail.trim();
    if (!target) {
      setResetMsg({ ok: false, text: "Informe o e-mail cadastrado." });
      return;
    }
    setResetLoading(true);
    const { error: rErr } = await supabase.auth.resetPasswordForEmail(target, {
      redirectTo: `${window.location.origin}/alterar-senha`,
    });
    setResetLoading(false);
    if (rErr) {
      setResetMsg({ ok: false, text: rErr.message || "Não foi possível enviar o link." });
    } else {
      setResetMsg({
        ok: true,
        text: "Se o e-mail estiver cadastrado, enviaremos um link para redefinir a senha. O link expira em 1 hora.",
      });
    }
  };

  return (
    <div className="min-h-screen flex">
      <div className="hidden lg:flex lg:w-1/2 relative overflow-hidden bg-accent">
        <img
          src={pivotBg}
          alt="Pivô central irrigando lavoura ao pôr do sol"
          className="absolute inset-0 w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-br from-accent/80 via-accent/60 to-primary/40" />
        <div className="absolute inset-0 bg-gradient-to-t from-accent/90 via-transparent to-transparent" />

        <div className="relative z-10 flex flex-col justify-between p-12 w-full">
          <div />

          <div className="space-y-6">
            <img src={renovLogo} alt="RENOV Tecnologia Agrícola" className="h-16 w-auto object-contain" />
            <h1 className="text-4xl font-bold text-white leading-tight">
              Gestor de<br />
              <span className="text-primary">Captação de Água</span>
            </h1>
            <p className="text-white/60 text-lg max-w-sm leading-relaxed">
              Gerencie seu sistema de captação de água com eficiência, automação e controle total.
            </p>
          </div>

          <p className="text-white/30 text-xs">
            © {new Date().getFullYear()} RENOV Tecnologia Agrícola
          </p>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm space-y-8">
          <div className="lg:hidden flex flex-col items-center space-y-3">
            <img src={renovLogo} alt="RENOV Tecnologia Agrícola" className="h-14 w-auto object-contain" />
            <div className="flex items-center gap-2 text-primary">
              <Droplets className="w-5 h-5" />
              <p className="text-sm font-semibold">Gestor de Captação de Água</p>
            </div>
          </div>

          <div className="space-y-1 text-center lg:text-left">
            <h2 className="text-2xl font-bold text-foreground tracking-tight">Entrar no Sistema</h2>
            <p className="text-xs text-muted-foreground">Acesso restrito — solicite credenciais ao administrador.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm font-bold text-foreground">
                <div className="w-7 h-7 rounded-lg bg-info/15 flex items-center justify-center">
                  <Mail className="w-4 h-4 text-info" />
                </div>
                E-mail
              </label>
              <Input
                type="email"
                autoComplete="email"
                placeholder="seu@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-14 text-base bg-card border-2 border-border text-foreground placeholder:text-muted-foreground/40 rounded-xl focus:border-info focus:ring-2 focus:ring-info/20 transition-all"
              />
            </div>

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm font-bold text-foreground">
                <div className="w-7 h-7 rounded-lg bg-warning/15 flex items-center justify-center">
                  <Lock className="w-4 h-4 text-warning" />
                </div>
                Senha
              </label>
              <Input
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-14 text-base bg-card border-2 border-border text-foreground placeholder:text-muted-foreground/40 rounded-xl focus:border-warning focus:ring-2 focus:ring-warning/20 transition-all"
              />
            </div>

            {error && (
              <div className="flex items-center gap-3 bg-destructive/10 border-2 border-destructive/30 rounded-xl px-4 py-3">
                <div className="w-8 h-8 rounded-full bg-destructive/20 flex items-center justify-center shrink-0">
                  <span className="text-destructive text-lg font-bold">!</span>
                </div>
                <p className="text-sm text-destructive font-bold">{error}</p>
              </div>
            )}

            <Button
              type="submit"
              className="w-full h-14 text-base font-bold bg-primary text-primary-foreground hover:bg-primary/90 rounded-xl shadow-lg shadow-primary/25 transition-all hover:shadow-xl hover:shadow-primary/30 hover:-translate-y-0.5 gap-3"
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="w-6 h-6 animate-spin" />
              ) : (
                <>
                  <ArrowRight className="w-5 h-5" />
                  ENTRAR
                </>
              )}
            </Button>

            <div className="text-center">
              <button
                type="button"
                onClick={() => { setShowReset((v) => !v); setResetMsg(null); setResetEmail(email); }}
                className="text-xs font-semibold text-primary hover:text-primary/80 hover:underline transition-colors"
              >
                {showReset ? "Cancelar" : "Esqueci minha senha"}
              </button>
            </div>
          </form>

          {showReset && (
            <form onSubmit={handleReset} className="space-y-3 p-4 rounded-xl border-2 border-border bg-card/50">
              <div className="space-y-1">
                <p className="text-sm font-bold text-foreground">Redefinir senha</p>
                <p className="text-[11px] text-muted-foreground">
                  Enviaremos um link de redefinição para o seu e-mail. O link expira em 1 hora.
                </p>
              </div>
              <Input
                type="email"
                autoComplete="email"
                placeholder="seu@email.com"
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
                className="h-12 bg-background border-2 border-border rounded-xl focus:border-info focus:ring-2 focus:ring-info/20"
              />
              {resetMsg && (
                <p className={`text-xs font-semibold ${resetMsg.ok ? "text-primary" : "text-destructive"}`}>
                  {resetMsg.text}
                </p>
              )}
              <Button
                type="submit"
                disabled={resetLoading}
                className="w-full h-12 font-bold bg-primary/90 hover:bg-primary text-primary-foreground rounded-xl gap-2"
              >
                {resetLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : "Enviar link de redefinição"}
              </Button>
            </form>
          )}

          <p className="text-[11px] text-center text-muted-foreground/50">
            RENOV Tecnologia Agrícola — Todos os direitos reservados
          </p>
        </div>
      </div>
    </div>
  );
};

export default Login;

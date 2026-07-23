import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useMasterManager } from "@/contexts/MasterManagerContext";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Lock, Loader2, ShieldCheck, AlertCircle } from "lucide-react";

const PASSWORD_RULE =
  "Mínimo 8 caracteres, com pelo menos 1 letra maiúscula e 1 número.";

function validatePassword(pw: string): string | null {
  if (pw.length < 8) return "A senha deve ter no mínimo 8 caracteres.";
  if (!/[A-Z]/.test(pw)) return "A senha deve conter pelo menos 1 letra maiúscula.";
  if (!/[0-9]/.test(pw)) return "A senha deve conter pelo menos 1 número.";
  return null;
}

export default function AlterarSenha() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { manager, refresh } = useMasterManager();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const err = validatePassword(pw);
    if (err) return setError(err);
    if (pw !== pw2) return setError("As senhas não coincidem.");

    setLoading(true);
    try {
      const { error: upErr } = await supabase.auth.updateUser({ password: pw });
      if (upErr) throw upErr;

      if (manager?.id) {
        const { error: flagErr } = await supabase
          .from("master_managers" as any)
          .update({ must_change_password: false })
          .eq("id", manager.id);
        if (flagErr) throw flagErr;
      }

      await refresh();
      navigate("/home", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao atualizar a senha.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2">
          <div className="w-12 h-12 rounded-xl bg-primary/15 flex items-center justify-center">
            <ShieldCheck className="w-6 h-6 text-primary" />
          </div>
          <CardTitle className="text-xl">Alterar senha</CardTitle>
          <p className="text-sm text-muted-foreground">
            Este é seu primeiro acesso com uma senha provisória. Por segurança,
            defina uma nova senha para continuar.
          </p>
          <p className="text-xs text-muted-foreground">
            Conta: <span className="font-medium text-foreground">{user?.email}</span>
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-semibold flex items-center gap-2">
                <Lock className="w-4 h-4" /> Nova senha
              </label>
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="••••••••"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                className="h-12"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-semibold flex items-center gap-2">
                <Lock className="w-4 h-4" /> Confirmar nova senha
              </label>
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="••••••••"
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                className="h-12"
              />
            </div>
            <p className="text-xs text-muted-foreground">{PASSWORD_RULE}</p>

            {error && (
              <div className="flex items-start gap-2 bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2 text-sm text-destructive">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={async () => { await logout(); navigate("/login", { replace: true }); }}
                disabled={loading}
              >
                Sair
              </Button>
              <Button type="submit" className="flex-1" disabled={loading}>
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Salvar nova senha"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

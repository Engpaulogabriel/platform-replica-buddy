import { useState, useEffect, useRef, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Shield, Copy, LogIn, Loader2, RefreshCw, KeyRound, Lock, Ban, Timer } from "lucide-react";
import { notify } from "@/lib/notify";
import renovLogo from "@/assets/renov-logo.png";

const SUPABASE_URL = "https://feqyexitblmhyzykttgu.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZlcXlleGl0YmxtaHl6eWt0dGd1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5MzU0MDQsImV4cCI6MjA4NzUxMTQwNH0.zy3VEqRg_wicaHH9annVoDxq1YLEsN327Z9ksppSnkc";

const MASTER_PASSWORD = "renov012.144";
const MAX_ATTEMPTS = 3;
const CHALLENGE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface RestrictedAuthProps {
  children: React.ReactNode;
  title: string;
  description: string;
}

const generateChallenge = (): string => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

const RESTRICTED_AUTH_KEY = "restricted_auth_ts";
const AUTH_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

const isRestrictedAuthenticated = () => {
  const ts = localStorage.getItem(RESTRICTED_AUTH_KEY);
  if (!ts) return false;
  return Date.now() - Number(ts) < AUTH_EXPIRY_MS;
};

const setRestrictedAuthenticated = () => {
  localStorage.setItem(RESTRICTED_AUTH_KEY, String(Date.now()));
};

const RestrictedAuth = ({ children, title, description }: RestrictedAuthProps) => {
  const [authenticated, setAuthenticated] = useState(() => isRestrictedAuthenticated());
  const [challenge, setChallenge] = useState("");
  const [responseCode, setResponseCode] = useState("");
  const [masterPassword, setMasterPassword] = useState("");
  const [error, setError] = useState("");
  const [validating, setValidating] = useState(false);

  // Security: attempt limiting
  const [attempts, setAttempts] = useState(0);
  const [masterLocked, setMasterLocked] = useState(false);

  // Challenge timer
  const [timeLeft, setTimeLeft] = useState(CHALLENGE_INTERVAL_MS / 1000);
  const challengeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const rotateChallengeNow = useCallback(() => {
    setChallenge(generateChallenge());
    setResponseCode("");
    setTimeLeft(CHALLENGE_INTERVAL_MS / 1000);
  }, []);

  // Initialize challenge + auto-rotate every 5 min
  useEffect(() => {
    rotateChallengeNow();

    challengeTimerRef.current = setInterval(() => {
      rotateChallengeNow();
    }, CHALLENGE_INTERVAL_MS);

    return () => {
      if (challengeTimerRef.current) clearInterval(challengeTimerRef.current);
    };
  }, [rotateChallengeNow]);

  // Countdown display
  useEffect(() => {
    countdownRef.current = setInterval(() => {
      setTimeLeft((prev) => (prev <= 1 ? CHALLENGE_INTERVAL_MS / 1000 : prev - 1));
    }, 1000);

    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, []);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const copyChallenge = () => {
    navigator.clipboard.writeText(challenge);
    notify.ok("Acesso Restrito", "Código de desafio copiado!");
  };

  const handleMasterLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (masterLocked) return;

    if (masterPassword === MASTER_PASSWORD) {
      setAuthenticated(true);
      setRestrictedAuthenticated();
      setAttempts(0);
      notify.ok("Acesso Restrito", "Acesso autorizado");
    } else {
      const newAttempts = attempts + 1;
      setAttempts(newAttempts);
      const remaining = MAX_ATTEMPTS - newAttempts;

      if (newAttempts >= MAX_ATTEMPTS) {
        setMasterLocked(true);
        setError("Login Master bloqueado por excesso de tentativas. Use a autenticação online (2FA).");
        notify.fail("Acesso Restrito", "Login Master bloqueado!");
      } else {
        setError(`Senha incorreta. ${remaining} tentativa${remaining > 1 ? "s" : ""} restante${remaining > 1 ? "s" : ""}.`);
      }
    }
  };

  const handleValidate2FA = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = responseCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

    if (code.length !== 6) {
      setError("Insira o código de 6 caracteres recebido do administrador.");
      return;
    }

    setValidating(true);
    setError("");

    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/validate-2fa`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          action: "validate",
          challenge: challenge,
          response: code,
        }),
      });

      const data = await res.json();

      if (res.ok && data?.valid) {
        setAuthenticated(true);
        setRestrictedAuthenticated();
        notify.ok("Acesso Restrito", "Acesso autorizado");
      } else {
        setError("Código inválido. Solicite um novo código ao administrador.");
      }
    } catch {
      setError("Erro de conexão. Verifique sua internet.");
    } finally {
      setValidating(false);
    }
  };

  if (authenticated) return <>{children}</>;

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="text-center space-y-3">
          <img src={renovLogo} alt="Renov" className="h-10 w-auto mx-auto" />
          <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Shield className="w-6 h-6 text-primary" />
          </div>
          <CardTitle className="text-lg text-foreground">{title}</CardTitle>
          <p className="text-xs text-muted-foreground">{description}</p>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue={masterLocked ? "2fa" : "master"} onValueChange={() => setError("")}>
            <TabsList className="w-full bg-secondary border border-border">
              <TabsTrigger
                value="master"
                disabled={masterLocked}
                className="flex-1 gap-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground disabled:opacity-40"
              >
                {masterLocked ? <Ban className="w-4 h-4" /> : <KeyRound className="w-4 h-4" />}
                Login Master
              </TabsTrigger>
              <TabsTrigger value="2fa" className="flex-1 gap-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                <Shield className="w-4 h-4" />
                Código 2FA
              </TabsTrigger>
            </TabsList>

            <TabsContent value="master" className="mt-4">
              {masterLocked ? (
                <div className="text-center space-y-3 py-4">
                  <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
                    <Ban className="w-6 h-6 text-destructive" />
                  </div>
                  <p className="text-sm font-semibold text-destructive">Login Master Bloqueado</p>
                  <p className="text-xs text-muted-foreground">
                    Excesso de tentativas ({MAX_ATTEMPTS}). Utilize a autenticação online via código 2FA ou desbloqueie abaixo.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setMasterLocked(false);
                      setAttempts(0);
                      setError("");
                      setMasterPassword("");
                      notify.ok("Acesso Restrito", "Login Master desbloqueado.");
                    }}
                  >
                    <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Desbloquear Login Master
                  </Button>
                </div>
              ) : (
                <form onSubmit={handleMasterLogin} className="space-y-4" autoComplete="off">
                  {/* Honeypot dummy fields to absorb browser autofill */}
                  <input type="text" name="fakeuser" autoComplete="username" style={{ display: "none" }} tabIndex={-1} aria-hidden="true" />
                  <input type="password" name="fakepass" autoComplete="current-password" style={{ display: "none" }} tabIndex={-1} aria-hidden="true" />
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">Senha Master</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        type="password"
                        name="restricted-access-code"
                        id="restricted-access-code"
                        placeholder="Digite a senha master"
                        value={masterPassword}
                        onChange={(e) => { setMasterPassword(e.target.value); setError(""); }}
                        className="pl-9 bg-secondary border-border"
                        autoComplete="new-password"
                        data-lpignore="true"
                        data-1p-ignore="true"
                        data-form-type="other"
                        spellCheck={false}
                        readOnly
                        onFocus={(e) => e.currentTarget.removeAttribute("readonly")}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] text-muted-foreground">
                        Acesso restrito a pessoas autorizadas.
                      </p>
                      {attempts > 0 && !masterLocked && (
                        <p className="text-[10px] text-muted-foreground">
                          {attempts}/{MAX_ATTEMPTS}
                        </p>
                      )}
                    </div>
                  </div>
                  {error && <p className="text-xs text-destructive">{error}</p>}
                  <Button type="submit" className="w-full">
                    <LogIn className="w-4 h-4 mr-2" />
                    Acessar
                  </Button>
                </form>
              )}
            </TabsContent>

            <TabsContent value="2fa" className="mt-4">
              <form onSubmit={handleValidate2FA} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Código de Desafio</label>
                  <div className="flex gap-2">
                    <div className="flex-1 bg-secondary border border-border rounded-md px-3 py-2 text-center">
                      <span className="font-mono text-xl font-bold tracking-[0.4em] text-foreground">
                        {challenge}
                      </span>
                    </div>
                    <Button type="button" variant="outline" size="icon" onClick={copyChallenge} title="Copiar">
                      <Copy className="w-4 h-4" />
                    </Button>
                    <Button type="button" variant="outline" size="icon" onClick={rotateChallengeNow} title="Novo código">
                      <RefreshCw className="w-4 h-4" />
                    </Button>
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      Envie este código ao administrador.
                    </p>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Timer className="w-3 h-3" />
                      <span className="font-mono">{formatTime(timeLeft)}</span>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Código de Resposta</label>
                  <Input
                    maxLength={6}
                    placeholder="______"
                    value={responseCode}
                    onChange={(e) => {
                      setResponseCode(e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase());
                      setError("");
                    }}
                    className="font-mono text-center text-xl tracking-[0.4em] bg-secondary border-border text-foreground placeholder:text-muted-foreground"
                  />
                </div>

                {error && <p className="text-xs text-destructive">{error}</p>}

                <Button type="submit" disabled={validating} className="w-full">
                  {validating ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <LogIn className="w-4 h-4 mr-2" />
                      Validar e Acessar
                    </>
                  )}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
};

export default RestrictedAuth;

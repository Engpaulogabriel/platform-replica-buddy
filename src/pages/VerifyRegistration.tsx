import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Loader2, MapPin, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import logo from "@/assets/renov-logo.png";

const PROJECT_ID = import.meta.env.VITE_SUPABASE_PROJECT_ID as string;
const FN_URL = `https://${PROJECT_ID}.supabase.co/functions/v1/verify-registration`;
const ANON = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

type Status =
  | "checking"
  | "invalid"
  | "ready"
  | "requesting"
  | "success"
  | "denied"
  | "error";

export default function VerifyRegistration() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<Status>("checking");
  const [errorMsg, setErrorMsg] = useState<string>("");

  useEffect(() => {
    if (!token) {
      setStatus("invalid");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `${FN_URL}?token=${encodeURIComponent(token)}`,
          { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } },
        );
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!j?.valid) {
          setStatus("invalid");
          return;
        }
        if (j.already) {
          setStatus("success");
          return;
        }
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("invalid");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit(payload: Record<string, unknown>): Promise<boolean> {
    try {
      const r = await fetch(FN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: ANON,
          Authorization: `Bearer ${ANON}`,
        },
        body: JSON.stringify({ token, ...payload }),
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  function verify() {
    setErrorMsg("");
    setStatus("requesting");
    if (!("geolocation" in navigator)) {
      setStatus("error");
      setErrorMsg(
        "Seu dispositivo não suporta geolocalização. Tente abrir o link em outro navegador.",
      );
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const ok = await submit({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
        setStatus(ok ? "success" : "error");
        if (!ok)
          setErrorMsg(
            "Não foi possível enviar sua localização. Tente novamente.",
          );
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setStatus("denied");
        } else {
          setStatus("error");
          setErrorMsg(
            "Não foi possível obter sua localização. Verifique se o GPS está ativado e tente novamente.",
          );
        }
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#ffffff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      <div style={{ width: "100%", maxWidth: 400, textAlign: "center" }}>
        <img
          src={logo}
          alt="Renov Tecnologia Agrícola"
          style={{ width: 180, margin: "0 auto", display: "block" }}
        />

        <h1
          style={{
            marginTop: 24,
            fontSize: 24,
            fontWeight: 700,
            color: "#1a1a1a",
          }}
        >
          Verificação de Segurança
        </h1>

        {status === "checking" && (
          <div
            style={{
              marginTop: 32,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              color: "#666",
            }}
          >
            <Loader2 size={20} className="animate-spin" />
            <span>Validando link...</span>
          </div>
        )}

        {status === "invalid" && (
          <>
            <p style={{ marginTop: 16, fontSize: 16, color: "#666" }}>
              ❌ Link inválido ou expirado.
            </p>
            <p style={{ marginTop: 12, fontSize: 14, color: "#666" }}>
              Solicite um novo código de acesso para continuar.
            </p>
          </>
        )}

        {(status === "ready" ||
          status === "requesting" ||
          status === "denied" ||
          status === "error") && (
          <>
            <p
              style={{
                marginTop: 16,
                fontSize: 16,
                color: "#666",
                lineHeight: 1.5,
              }}
            >
              Para completar seu cadastro no sistema Renov, precisamos
              verificar sua localização.
            </p>

            <div
              style={{
                marginTop: 24,
                display: "flex",
                justifyContent: "center",
              }}
            >
              <MapPin size={64} color="#16a34a" strokeWidth={2} />
            </div>

            <button
              onClick={verify}
              disabled={status === "requesting"}
              style={{
                marginTop: 32,
                width: "100%",
                height: 56,
                borderRadius: 12,
                border: "none",
                background:
                  status === "requesting" ? "#15803d" : "#16a34a",
                color: "#ffffff",
                fontSize: 16,
                fontWeight: 700,
                cursor: status === "requesting" ? "default" : "pointer",
                boxShadow: "0 4px 12px rgba(22,163,74,0.25)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
              onMouseOver={(e) => {
                if (status !== "requesting")
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "#15803d";
              }}
              onMouseOut={(e) => {
                if (status !== "requesting")
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "#16a34a";
              }}
            >
              {status === "requesting" ? (
                <>
                  <Loader2 size={20} className="animate-spin" />
                  Obtendo localização...
                </>
              ) : status === "denied" || status === "error" ? (
                "Tentar novamente"
              ) : (
                "📍 Verificar minha localização"
              )}
            </button>

            {status === "denied" && (
              <div
                style={{
                  marginTop: 16,
                  padding: 12,
                  background: "#fef2f2",
                  borderRadius: 8,
                  color: "#b91c1c",
                  fontSize: 14,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                <XCircle size={20} />
                <span>
                  Permissão de localização negada. Habilite e tente novamente.
                </span>
              </div>
            )}

            {status === "error" && errorMsg && (
              <div
                style={{
                  marginTop: 16,
                  padding: 12,
                  background: "#fef2f2",
                  borderRadius: 8,
                  color: "#b91c1c",
                  fontSize: 14,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                <AlertTriangle size={20} />
                <span>{errorMsg}</span>
              </div>
            )}

            <p
              style={{
                marginTop: 16,
                fontSize: 14,
                color: "#d97706",
                textAlign: "center",
              }}
            >
              ⚠️ A permissão de localização é obrigatória para o cadastro.
            </p>
          </>
        )}

        {status === "success" && (
          <>
            <div
              style={{
                marginTop: 24,
                display: "flex",
                justifyContent: "center",
              }}
            >
              <CheckCircle2 size={64} color="#16a34a" strokeWidth={2} />
            </div>
            <p
              style={{
                marginTop: 16,
                fontSize: 18,
                fontWeight: 700,
                color: "#16a34a",
              }}
            >
              ✅ Verificação concluída!
            </p>
            <p
              style={{
                marginTop: 12,
                fontSize: 15,
                color: "#666",
                lineHeight: 1.5,
              }}
            >
              Volte ao WhatsApp e envie seu código de acesso para continuar o
              cadastro.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

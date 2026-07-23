import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

export const IRRIGACAO_ALLOWED_EMAIL = "contato@renovelectronics.com.br";

export function isIrrigacaoAllowed(email?: string | null) {
  return (email || "").trim().toLowerCase() === IRRIGACAO_ALLOWED_EMAIL;
}

export function IrrigacaoGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!isIrrigacaoAllowed(user?.email)) {
    return <Navigate to="/platform" replace />;
  }
  return <>{children}</>;
}

import { Navigate, useLocation } from "react-router-dom";
import { useMasterManager } from "@/contexts/MasterManagerContext";
import { Loader2 } from "lucide-react";

/**
 * Bloqueia qualquer navegação enquanto um Gestor Master estiver com
 * `must_change_password = true`. Redireciona para /alterar-senha.
 * Não afeta demais perfis: isMasterManager=false → passa direto.
 */
export function MasterPasswordGate({ children }: { children: React.ReactNode }) {
  const { loading, isMasterManager, mustChangePassword } = useMasterManager();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (isMasterManager && mustChangePassword && location.pathname !== "/alterar-senha") {
    return <Navigate to="/alterar-senha" replace />;
  }

  // Se já trocou a senha, não faz sentido continuar em /alterar-senha
  if (isMasterManager && !mustChangePassword && location.pathname === "/alterar-senha") {
    return <Navigate to="/home" replace />;
  }

  return <>{children}</>;
}

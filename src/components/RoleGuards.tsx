// Guards de rota por papel — esconde a página inteira quando o perfil
// do usuário na fazenda atual não tem permissão. RLS continua sendo a
// fonte da verdade no banco; isto é só UX.
import { useFarmAccess } from "@/hooks/useFarmAccess";
import AccessDenied from "@/components/AccessDenied";
import { Loader2 } from "lucide-react";

export function RequireAutomation({ children }: { children: React.ReactNode }) {
  const { loading, canAccessAutomation } = useFarmAccess();
  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  if (!canAccessAutomation) {
    return <AccessDenied reason="O perfil Operador não tem acesso ao módulo Automático. Fale com o Administrador da fazenda." />;
  }
  return <>{children}</>;
}

export function RequireFinancial({ children }: { children: React.ReactNode }) {
  const { loading, canViewFinancial } = useFarmAccess();
  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  if (!canViewFinancial) {
    return <AccessDenied reason="Esta área contém dados financeiros (ROI/tarifas) e está disponível apenas para o Administrador da fazenda." />;
  }
  return <>{children}</>;
}

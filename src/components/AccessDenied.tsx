// Tela simples mostrada quando o usuário não tem permissão para a rota.
import { Lock } from "lucide-react";

export default function AccessDenied({ reason }: { reason?: string }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] p-6 text-center">
      <div className="p-4 rounded-2xl bg-muted/40 border border-border mb-4">
        <Lock className="w-10 h-10 text-muted-foreground" />
      </div>
      <h1 className="text-xl font-bold text-foreground mb-1">Acesso restrito</h1>
      <p className="text-sm text-muted-foreground max-w-md">
        {reason ?? "Seu perfil de usuário não tem permissão para acessar esta área. Fale com o Administrador ou a Renov."}
      </p>
    </div>
  );
}

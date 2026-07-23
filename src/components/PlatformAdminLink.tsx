import { Link } from "react-router-dom";
import { Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePlatformAccess } from "@/hooks/usePlatformAccess";

export function PlatformAdminLink() {
  const { isAdmin } = usePlatformAccess();
  if (!isAdmin) return null;
  return (
    <Button asChild variant="ghost" size="sm" className="gap-1.5 text-primary hover:bg-primary/10">
      <Link to="/platform" title="Painel da Plataforma">
        <Shield className="w-4 h-4" />
        <span className="hidden md:inline text-xs font-semibold uppercase tracking-wider">Plataforma</span>
      </Link>
    </Button>
  );
}

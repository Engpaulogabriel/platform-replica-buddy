// FeatureGate — Bloqueia acesso direto via URL a páginas cujo módulo está
// desativado para a fazenda atual. Redireciona para /home quando bloqueado.
import { Navigate } from "react-router-dom";
import { useFarmFeatures } from "@/hooks/useFarmFeatures";

type FeatureKey = "energia" | "vazao_consumo" | "niveis";

export function FeatureGate({ feature, children }: { feature: FeatureKey; children: React.ReactNode }) {
  const features = useFarmFeatures();
  if (features.loading) return null;
  if (!features[feature]) return <Navigate to="/home" replace />;
  return <>{children}</>;
}

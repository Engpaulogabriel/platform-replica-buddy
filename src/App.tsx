import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { MasterManagerProvider } from "@/contexts/MasterManagerContext";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { PlanProvider } from "@/contexts/PlanContext";
import { NotificationProvider } from "@/contexts/NotificationContext";
import { UserOnlineProvider } from "@/contexts/UserOnlineContext";

import { NoInternetBanner } from "@/components/NoInternetBanner";
import LicenseGate from "@/components/LicenseGate";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppLayout } from "@/components/AppLayout";
import { MasterPasswordGate } from "@/components/MasterPasswordGate";
import { IrrigacaoGuard } from "@/components/IrrigacaoGuard";
import AlterarSenha from "./pages/AlterarSenha";
import { lazy, Suspense } from "react";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import { Loader2 } from "lucide-react";

// Rotas críticas (eager — primeira pintura precisa ser instantânea)
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Privacidade from "./pages/Privacidade";
import OAuthConsent from "./pages/OAuthConsent";

// Rotas secundárias (lazy com retry + reload em caso de chunk desatualizado)
const Automatico = lazyWithRetry(() => import("./pages/Automatico"));
const Automacoes = lazyWithRetry(() => import("./pages/Automacoes"));
const Manutencao = lazyWithRetry(() => import("./pages/Manutencao"));
const Produtividade = lazyWithRetry(() => import("./pages/Produtividade"));
const DemandaEnergia = lazyWithRetry(() => import("./pages/DemandaEnergia"));
const Indicadores = lazyWithRetry(() => import("./pages/Indicadores"));
const Alarmes = lazyWithRetry(() => import("./pages/Alarmes"));
const Relatorios = lazyWithRetry(() => import("./pages/Relatorios"));
const Irrigacao = lazyWithRetry(() => import("./pages/Irrigacao"));
const Usuarios = lazyWithRetry(() => import("./pages/Usuarios"));
const Configuracoes = lazyWithRetry(() => import("./pages/Configuracoes"));
const Integracoes = lazyWithRetry(() => import("./pages/Integracoes"));
const Ajuda = lazyWithRetry(() => import("./pages/Ajuda"));
const SuporteTecnico = lazyWithRetry(() => import("./pages/SuporteTecnico"));
const PlatformAdmin = lazyWithRetry(() => import("./pages/PlatformAdmin"));
const MinhasFazendas = lazyWithRetry(() => import("./pages/MinhasFazendas"));
const Contato = lazyWithRetry(() => import("./pages/Contato"));
const LogsAgente = lazyWithRetry(() => import("./pages/LogsAgente"));

const NotFound = lazy(() => import("./pages/NotFound"));
import VerifyRegistration from "./pages/VerifyRegistration";


import { PageErrorBoundary } from "@/components/PageErrorBoundary";
import { GlobalErrorBoundary, useVisibilityRecovery } from "@/components/GlobalErrorBoundary";
import { RequireAutomation, RequireFinancial } from "@/components/RoleGuards";
import { FeatureGate } from "@/components/FeatureGate";

// Starlink-tolerant defaults: 3 retries com backoff exponencial (1s/2s/4s, cap 10s),
// staleTime 14s ≈ ao polling padrão (mantém dados "fresh" entre ciclos),
// refetchOnWindowFocus desligado para evitar flood quando a aba reabre.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      staleTime: 14_000,
      gcTime: 5 * 60_000,
      retry: 3,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
    },
  },
});

function RouteFallback() {
  return (
    <div className="flex items-center justify-center min-h-[40vh] text-muted-foreground">
      <Loader2 className="w-5 h-5 animate-spin mr-2" />
      <span className="text-sm">Carregando…</span>
    </div>
  );
}

const lazyRoute = (pageName: string, El: React.LazyExoticComponent<React.ComponentType>) => (
  <PageErrorBoundary pageName={pageName}>
    <Suspense fallback={<RouteFallback />}>
      <El />
    </Suspense>
  </PageErrorBoundary>
);

const App = () => {
  useVisibilityRecovery();
  return (
  <GlobalErrorBoundary>
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <ThemeProvider>
        <LicenseGate>
          <LanguageProvider>
            <PlanProvider>
              <BrowserRouter>
                <AuthProvider>
                  <MasterManagerProvider>
                  <UserOnlineProvider>
                  <NoInternetBanner />
                  <NotificationProvider>
                    <Routes>
                      <Route path="/login" element={<Login />} />
                      <Route path="/privacidade" element={<Privacidade />} />
                      <Route path="/verify/:token" element={<VerifyRegistration />} />
                      <Route path="/.lovable/oauth/consent" element={<OAuthConsent />} />
                      <Route path="/alterar-senha" element={<ProtectedRoute><AlterarSenha /></ProtectedRoute>} />
                      <Route element={<ProtectedRoute><MasterPasswordGate><AppLayout /></MasterPasswordGate></ProtectedRoute>}>
                        <Route path="/" element={<PageErrorBoundary pageName="Dashboard"><Dashboard /></PageErrorBoundary>} />
                        <Route path="/home" element={<PageErrorBoundary pageName="Home"><Dashboard /></PageErrorBoundary>} />
                        <Route path="/dashboard" element={<Navigate to="/home" replace />} />
                        <Route path="/automatico" element={<PageErrorBoundary pageName="Automático"><RequireAutomation><Suspense fallback={<RouteFallback />}><Automatico /></Suspense></RequireAutomation></PageErrorBoundary>} />
                        <Route path="/automacoes" element={lazyRoute("Automações", Automacoes)} />

                        <Route path="/manutencao" element={lazyRoute("Manutenção", Manutencao)} />
                        <Route path="/produtividade" element={<PageErrorBoundary pageName="Produtividade"><RequireFinancial><Suspense fallback={<RouteFallback />}><Produtividade /></Suspense></RequireFinancial></PageErrorBoundary>} />
                        <Route path="/demanda-energia" element={<FeatureGate feature="energia">{lazyRoute("Demanda de Energia", DemandaEnergia)}</FeatureGate>} />
                        <Route path="/indicadores" element={lazyRoute("Indicadores", Indicadores)} />
                        <Route path="/alarmes" element={lazyRoute("Alarmes", Alarmes)} />
                        <Route path="/relatorios" element={lazyRoute("Relatórios", Relatorios)} />
                        <Route path="/irrigacao/*" element={<IrrigacaoGuard>{lazyRoute("Irrigação", Irrigacao)}</IrrigacaoGuard>} />
                        <Route path="/usuarios" element={lazyRoute("Usuários", Usuarios)} />
                        <Route path="/configuracoes" element={lazyRoute("Configurações", Configuracoes)} />
                        <Route path="/integracoes" element={lazyRoute("Integrações", Integracoes)} />
                        

                        <Route path="/suporte-tecnico" element={lazyRoute("Suporte Técnico", SuporteTecnico)} />
                        <Route path="/bridge" element={<Navigate to="/suporte-tecnico" replace />} />
                        <Route path="/ajuda" element={lazyRoute("Ajuda", Ajuda)} />
                        <Route path="/contato" element={lazyRoute("Contato", Contato)} />
                        <Route path="/logs-agente" element={lazyRoute("Logs do Agente", LogsAgente)} />
                        <Route path="/platform" element={lazyRoute("Painel da Plataforma", PlatformAdmin)} />
                        <Route path="/minhas-fazendas" element={lazyRoute("Minhas Fazendas", MinhasFazendas)} />
                      </Route>
                      <Route path="*" element={<Suspense fallback={<RouteFallback />}><NotFound /></Suspense>} />
                    </Routes>
                  </NotificationProvider>
                  </UserOnlineProvider>
                  </MasterManagerProvider>
                </AuthProvider>

              </BrowserRouter>
              <Toaster
                richColors
                closeButton
                position="top-right"
                visibleToasts={3}
                expand={false}
              />
            </PlanProvider>
          </LanguageProvider>
        </LicenseGate>
      </ThemeProvider>
    </TooltipProvider>
  </QueryClientProvider>
  </GlobalErrorBoundary>
  );
};

export default App;

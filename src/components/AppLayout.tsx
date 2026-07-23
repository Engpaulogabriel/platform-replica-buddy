import { useState, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { Droplets } from "lucide-react";
import renovLogo from "@/assets/renov-logo.png";
import { loadFazendaData } from "@/pages/Fazenda";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NotificationCenter } from "@/components/NotificationCenter";
import { BridgeStatusBadge } from "@/components/BridgeStatusBadge";
import { CloudBridgeStatusBadge } from "@/components/CloudBridgeStatusBadge";


import { PlatformAdminLink } from "@/components/PlatformAdminLink";
import { FarmSwitcher } from "@/components/FarmSwitcher";
import { FarmMessagesBanner } from "@/components/FarmMessagesBanner";
import { PeakHourBanner } from "@/components/PeakHourBanner";
import { PeakHourPauseBanner } from "@/components/PeakHourPauseBanner";
import DemoModeBanner from "@/components/platform/DemoModeBanner";
import { MaintenanceBanner } from "@/components/MaintenanceBanner";
import { usePumpFailureNotifications } from "@/hooks/usePumpFailureNotifications";

import { OnboardingWizard } from "@/components/OnboardingWizard";
import { startAutomationLogSync } from "@/lib/automationLog";
import { migrateLocalCadastrosToCloud, purgeExpiredBackups } from "@/lib/cadastrosCloud";
import { setSectorsScope } from "@/lib/sectors";
import { migrateLegacyAutomationToCloud } from "@/lib/automationLegacyMigration";
import { startPollingScheduler } from "@/lib/pollingScheduler";
import { startCommandWorker } from "@/lib/commandWorker";
import { pullRfRoutingFromCloud } from "@/lib/rfRouting";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { notify } from "@/lib/notify";
import "@/styles/guided-tour.css";

export function AppLayout() {
  const { user } = useAuth();
  // Observa o automation_log e dispara notificação no sino + toast para cada
  // nova falha ("Bomba não ligou" / "Bomba não desligou"), incluindo as do
  // Automático que chegam via Realtime quando o usuário reabre a aba.
  usePumpFailureNotifications();
  const [farmId, setFarmId] = useState<string | null>(null);
  const [cadastrosMigrationReady, setCadastrosMigrationReady] = useState(false);
  const [fazenda, setFazenda] = useState(loadFazendaData);
  const [showOnboarding, setShowOnboarding] = useState(() => {
    if (sessionStorage.getItem("onboarding_shown_this_session")) return false;
    if (!localStorage.getItem("onboarding_done")) return true;
    if (sessionStorage.getItem("just_logged_in")) {
      sessionStorage.removeItem("just_logged_in");
      return true;
    }
    return false;
  });

  // Resolve farmId do profile do usuário logado (uma vez)
  useEffect(() => {
    if (!user?.id) { setFarmId(null); setSectorsScope(null); return; }
    let cancelled = false;
    const impersonate = sessionStorage.getItem("impersonate_farm_id")
      ?? sessionStorage.getItem("demo_farm_id");
    if (impersonate) { setFarmId(impersonate); setSectorsScope(impersonate); }
    void supabase.from("profiles").select("default_farm_id").eq("id", user.id).maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const fid = impersonate ?? data?.default_farm_id ?? null;
        setFarmId(fid);
        setSectorsScope(fid);
      });
    return () => { cancelled = true; };
  }, [user?.id]);

  // Etapa 2: scheduler de polling (todos clientes) + worker de fila TX/RX (Electron)
  useEffect(() => {
    if (!farmId) return;
    // Sincroniza o roteamento RF (rádio R1/R2/R3, via repetidor) da nuvem para o cache
    // local. Garante que o automático e o manual usem o mesmo frame.
    void pullRfRoutingFromCloud(farmId);
    const stopScheduler = startPollingScheduler(farmId);
    const stopWorker = startCommandWorker(farmId);
    return () => { stopScheduler(); stopWorker(); };
  }, [farmId]);

  // Migração one-shot das programações antigas (localStorage) → nuvem
  useEffect(() => {
    if (!farmId || !cadastrosMigrationReady) return;
    void migrateLegacyAutomationToCloud(farmId).then(() => {
      // Toasts de migração de programações de automação removidos a pedido.
    });
  }, [farmId, cadastrosMigrationReady]);

  useEffect(() => {
    const handler = () => setFazenda(loadFazendaData());
    window.addEventListener("fazenda-updated", handler);
    return () => window.removeEventListener("fazenda-updated", handler);
  }, []);

  // Inicia sincronização do log de automação com a nuvem (Realtime + flush pendentes)
  useEffect(() => {
    void startAutomationLogSync();
  }, []);

  // Migração automática de cadastros local → nuvem (1ª vez de owner/admin com nuvem vazia)
  useEffect(() => {
    setCadastrosMigrationReady(false);
    purgeExpiredBackups();
    void migrateLocalCadastrosToCloud()
      .then((res) => {
        if (res.status === "migrated") {
          notify.ok("Sistema", `Cadastros sincronizados na nuvem: ${res.counts.plcs} PLCs, ${res.counts.sectors} setores, ${res.counts.equips} equipamentos.`);
        } else if (res.status === "rolled_back") {
          notify.fail("Sistema", `Falha ao migrar cadastros (rollback aplicado). ${res.error}`);
        }
      })
      .finally(() => {
        setCadastrosMigrationReady(true);
      });
  }, []);

  return (
    <SidebarProvider>
      <div className="h-screen flex w-full app-botanical-bg overflow-hidden">
        <AppSidebar />
        <div className="flex-1 flex flex-col h-screen min-h-0">
          {/* === Header Principal === */}
          <header data-tour="header" className="shrink-0 h-14 sm:h-16 border-b border-[hsl(210,20%,85%)] relative z-50">
            <div className="absolute inset-0 bg-gradient-to-r from-[hsl(210,25%,97%)] via-white to-[hsl(210,25%,97%)]" />
            <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-primary/0 via-primary to-primary/0" />
            <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[hsl(210,15%,82%)] to-transparent" />

            {/* Desktop / Tablet: layout em 3 colunas */}
            <div className="hidden sm:flex relative h-full items-center px-4 z-10 gap-2">
              <div className="flex-1 flex items-center gap-2 min-w-0">
                <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-primary/10 border border-primary/15 shrink-0">
                  <Droplets className="w-3.5 h-3.5 text-primary" />
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-bold text-foreground uppercase tracking-[0.15em] truncate">
                    Gestor de Bombas
                  </span>
                  <span className="text-[9px] text-muted-foreground uppercase tracking-[0.2em] font-medium truncate hidden md:inline">
                    Sistema de Controle
                  </span>
                </div>
              </div>

              {/* Logo central só em telas ≥1024px (lg) — evita overlap com FarmSwitcher em tablet */}
              <div className="relative shrink-0 mx-8 hidden lg:flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <div className="w-8 h-[1px] bg-gradient-to-r from-transparent to-primary/40" />
                  <div className="w-1.5 h-1.5 rounded-full border border-primary/30 bg-primary/10" />
                  <div className="w-3 h-[1px] bg-primary/30" />
                </div>
                <img
                  src={renovLogo}
                  alt="RENOV"
                  className="h-9 w-auto object-contain"
                />
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-[1px] bg-primary/30" />
                  <div className="w-1.5 h-1.5 rounded-full border border-primary/30 bg-primary/10" />
                  <div className="w-8 h-[1px] bg-gradient-to-l from-transparent to-primary/40" />
                </div>
              </div>

              <div className="flex-1 flex items-center justify-end gap-2 min-w-0 z-20">
                <FarmSwitcher />
                <div className="hidden md:flex items-center gap-2">
                  <PlatformAdminLink />
                  <div data-tour="bridge-status" className="flex items-center gap-1.5">
                    <CloudBridgeStatusBadge />
                    <BridgeStatusBadge />
                  </div>
                </div>

                <div data-tour="notifications"><NotificationCenter /></div>
                <div data-tour="theme-toggle"><ThemeToggle /></div>
              </div>
            </div>

            {/* Mobile: layout em 2 linhas */}
            <div className="sm:hidden relative h-full flex flex-col z-10">
              {/* Linha 1: hamburger + logo compacta + ícones */}
              <div className="flex items-center justify-between h-14 px-2 gap-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <SidebarTrigger
                    className="-ml-1 h-8 w-8 shrink-0"
                    aria-label="Abrir menu"
                  />
                  <img
                    src={renovLogo}
                    alt="RENOV"
                    className="h-5 w-auto object-contain shrink-0"
                  />
                </div>
                <div className="flex items-center justify-end gap-1 z-20">
                  <div data-tour="notifications"><NotificationCenter /></div>
                  <div data-tour="theme-toggle"><ThemeToggle /></div>
                </div>
              </div>
            </div>
          </header>

          {/* Mobile sub-header: fazenda sempre visível e clicável */}
          <div className="sm:hidden shrink-0 border-b border-border bg-card/90 backdrop-blur-sm px-2 py-1.5 flex items-center z-40">
            <FarmSwitcher />
          </div>
          <DemoModeBanner />
          <MaintenanceBanner farmId={farmId} />
          <FarmMessagesBanner farmId={farmId} />
          <PeakHourBanner />
          <PeakHourPauseBanner />
          <main className="flex-1 min-h-0 p-3 md:p-6 overflow-auto">
            <Outlet />
          </main>
          <footer className="py-3 px-6 border-t border-border bg-card text-center">
            <p className="text-[11px] text-muted-foreground">
              Desenvolvido por Renov Tecnologia Agrícola® — Todos os direitos reservados © {new Date().getFullYear()}
            </p>
          </footer>
        </div>
      </div>
      <OnboardingWizard open={showOnboarding} onClose={() => { sessionStorage.setItem("onboarding_shown_this_session", "1"); setShowOnboarding(false); }} />
    </SidebarProvider>
  );
}

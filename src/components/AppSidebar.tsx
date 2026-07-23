import { useEffect, useRef, useCallback } from "react";
import {
  Home,
  Cpu,
  BarChart3,
  Users,
  
  Settings,
  LogOut,
  Bell,
  Bot,
  HelpCircle,
  Lock,
  Menu,
  ChevronLeft,
  Wrench,
  Zap,
  LineChart,
  Phone,
  Crown,
  Tractor,
  Workflow,
  Sprout,
  MessageSquare,

  
} from "lucide-react";

import { NavLink } from "@/components/NavLink";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { usePlan } from "@/contexts/PlanContext";
import { useUserFarms } from "@/hooks/useUserFarms";
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin";
import { useFarmAccess } from "@/hooks/useFarmAccess";
import { useFarmFeatures } from "@/hooks/useFarmFeatures";
import { useMasterManager } from "@/contexts/MasterManagerContext";

import { useNavigate } from "react-router-dom";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";



export function AppSidebar() {
  const { logout, user } = useAuth();
  const { t } = useLanguage();
  const { isPro } = usePlan();
  const navigate = useNavigate();
  const { state, toggleSidebar, isMobile } = useSidebar();
  const collapsed = state === "collapsed";
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { farms } = useUserFarms();
  const showMinhasFazendas = farms.length >= 2;
  const { isPlatformAdmin } = usePlatformAdmin();
  const { canAccessAutomation } = useFarmAccess();
  const features = useFarmFeatures();
  const { isMasterManager, permissions } = useMasterManager();

  // Gestor Master respeita permissões; demais perfis têm tudo liberado
  const mmCan = (k: keyof typeof permissions) => !isMasterManager || permissions[k];

  const mainItems = [
    { title: t.home, url: "/home", icon: Home, proOnly: false, show: mmCan("can_view_dashboard") },
    ...(showMinhasFazendas ? [{ title: "Minhas Fazendas", url: "/minhas-fazendas", icon: Tractor, proOnly: false, show: true }] : []),
    { title: t.automation, url: "/automatico", icon: Cpu, proOnly: true, show: canAccessAutomation && mmCan("can_edit_schedules") },
    { title: "Automações", url: "/automacoes", icon: Workflow, proOnly: true, show: canAccessAutomation },
    { title: "Manutenção", url: "/manutencao", icon: Wrench, proOnly: false, show: true },
    { title: "Energia", url: "/demanda-energia", icon: Zap, proOnly: true, show: features.energia && mmCan("can_view_financial") },
    { title: "Indicadores", url: "/indicadores", icon: LineChart, proOnly: false, show: mmCan("can_view_indicators") },

    { title: t.reports, url: "/relatorios", icon: BarChart3, proOnly: false, show: mmCan("can_view_reports") },
    { title: "Irrigação", url: "/irrigacao", icon: Sprout, proOnly: false, show: (user?.email || "").trim().toLowerCase() === "contato@renovelectronics.com.br" },

    { title: t.settings, url: "/configuracoes", icon: Settings, proOnly: false, show: !isMasterManager },
    { title: t.help, url: "/ajuda", icon: HelpCircle, proOnly: false, show: true },
    { title: "Contato", url: "/contato", icon: Phone, proOnly: false, show: true },
  ].filter(item => (isPro || !item.proOnly) && item.show);


  const restrictedItems = isPro
    ? [
        { title: t.aiIntegrations, url: "/integracoes", icon: Bot },
        
        { title: "Suporte Técnico", url: "/suporte-tecnico", icon: Wrench },
      ]
    : [];


  // Auto-collapse + hover-expand: SOMENTE desktop. No mobile o sidebar é
  // um Sheet (drawer) e qualquer toggleSidebar() programático abriria o
  // drawer sozinho de tempos em tempos — comportamento indesejado.
  const resetTimer = useCallback(() => {
    if (isMobile) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (state === "expanded") {
      timerRef.current = setTimeout(() => {
        toggleSidebar();
      }, 5000);
    }
  }, [state, toggleSidebar, isMobile]);

  useEffect(() => {
    if (isMobile) {
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }
    resetTimer();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [resetTimer, isMobile]);

  const handleMouseEnter = () => {
    if (isMobile) return;
    resetTimer();
    if (state === "collapsed") {
      toggleSidebar();
    }
  };

  const handleMouseMove = () => {
    if (isMobile) return;
    resetTimer();
  };
  const handleMouseLeave = () => {
    if (isMobile) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (state === "expanded") {
      timerRef.current = setTimeout(() => {
        toggleSidebar();
      }, 5000);
    }
  };

  // Keyboard shortcut: Ctrl+B to toggle sidebar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleSidebar]);

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };



  return (
    <div
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      /* z-index 2 > z-index 1 aplicado pelo .app-botanical-bg > * em todos os
         filhos do layout — sem isso o conteúdo (que vem depois no DOM) pinta
         POR CIMA do sidebar expandido e do backdrop no tablet. */
      style={{ position: "relative", zIndex: 2 }}
    >
    {/* Tablet (≤1024px): backdrop quando sidebar expandido — clique fecha */}
    {!isMobile && !collapsed && (
      <div
        onClick={toggleSidebar}
        className="fixed inset-0 z-40 bg-black/50 hidden md:block min-[1025px]:!hidden"
        aria-hidden="true"
      />
    )}
    <Sidebar collapsible="icon" className="border-r-0 bg-sidebar" data-tour="sidebar">

      <div className="h-16 flex items-center justify-center px-2 border-b border-sidebar-border">
        <button
          onClick={toggleSidebar}
          className="p-2 rounded-lg text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
          title={collapsed ? t.expandMenu : t.collapseMenu}
        >
          {collapsed ? <Menu className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
        </button>
      </div>

      <SidebarContent className="px-2 py-3">
        <SidebarGroup>
          {!collapsed && (
            <SidebarGroupLabel className="text-[10px] text-sidebar-foreground/50 uppercase tracking-[0.15em] font-semibold px-3 mb-1">
              {t.navigation}
            </SidebarGroupLabel>
          )}
          <SidebarGroupContent>
            <SidebarMenu className={`space-y-0.5 ${collapsed ? "items-center" : ""}`}>
              {mainItems.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild tooltip={collapsed ? item.title : undefined}>
                    <NavLink
                      to={item.url}
                      className={`flex items-center ${collapsed ? "justify-center px-0 gap-0" : "gap-3 px-3"} py-2.5 rounded-xl text-sidebar-foreground/65 text-sm font-medium transition-all duration-200 hover:bg-sidebar-accent hover:text-sidebar-foreground`}
                      activeClassName="bg-primary text-primary-foreground shadow-md shadow-primary/25 hover:bg-primary hover:text-primary-foreground"
                    >
                      <item.icon className="w-5 h-5 shrink-0" />
                      {!collapsed && <span>{item.title}</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          {!collapsed && (
            <SidebarGroupLabel className="text-[10px] text-sidebar-foreground/50 uppercase tracking-[0.15em] font-semibold px-3 mb-1">
              <Lock className="w-3 h-3 mr-1 inline" />
              {t.restricted}
            </SidebarGroupLabel>
          )}
          {collapsed && (
            <div className="flex justify-center py-1">
              <Lock className="w-3 h-3 text-sidebar-foreground/30" />
            </div>
          )}
          <SidebarGroupContent>
            <SidebarMenu className={`space-y-0.5 ${collapsed ? "items-center" : ""}`}>
              {restrictedItems.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild tooltip={collapsed ? item.title : undefined}>
                    <NavLink
                      to={item.url}
                      className={`flex items-center ${collapsed ? "justify-center px-0 gap-0" : "gap-3 px-3"} py-2.5 rounded-xl text-sidebar-foreground/65 text-sm font-medium transition-all duration-200 hover:bg-sidebar-accent hover:text-sidebar-foreground`}
                      activeClassName="bg-primary text-primary-foreground shadow-md shadow-primary/25 hover:bg-primary hover:text-primary-foreground"
                    >
                      <item.icon className="w-5 h-5 shrink-0" />
                      {!collapsed && <span>{item.title}</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>


      <SidebarFooter className="p-2 space-y-2">
        <div data-tour="plan-badge">
          {!collapsed && (
            <div className="mx-1 flex items-center justify-center">
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isPro ? "bg-warning/15 text-warning" : "bg-info/15 text-info"}`}>
                <Crown className="w-3 h-3 inline mr-0.5" />
                {isPro ? "PRO" : "LITE"}
              </span>
            </div>
          )}
        </div>
        {!collapsed && <div className="mx-1 h-px bg-sidebar-border" />}
        <div className={`flex items-center ${collapsed ? "justify-center p-1" : "gap-3 px-2 py-2"} rounded-xl bg-sidebar-accent`}>
          <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center ring-2 ring-primary/20 shrink-0">
            <span className="text-xs font-bold text-primary">
              {user?.email?.charAt(0).toUpperCase() || "U"}
            </span>
          </div>
          {!collapsed && (
            <>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-sidebar-foreground truncate">{user?.email}</p>
                <p className="text-[10px] text-sidebar-foreground/50 font-medium">{t.administrator}</p>
              </div>
              <button
                onClick={handleLogout}
                className="p-2 rounded-lg text-sidebar-foreground/45 hover:text-destructive hover:bg-destructive/10 transition-all duration-200"
                title={t.logout}
              >
                <LogOut className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </SidebarFooter>
    </Sidebar>
    </div>
  );
}

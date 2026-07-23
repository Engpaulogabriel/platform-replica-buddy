import { useCallback } from "react";
import { driver, type DriveStep } from "driver.js";
import "driver.js/dist/driver.css";

const mainTourSteps: DriveStep[] = [
  {
    element: "[data-tour='sidebar']",
    popover: {
      title: "📋 Menu de navegação",
      description: "Aqui você acessa todas as áreas: Início, Automático, Demanda de Energia, Alarmes, Relatórios, Usuários, Configurações, IA, Ajuda e Contato. Passe o mouse para expandir ou use Ctrl+B.",
      side: "right",
      align: "start",
    },
  },
  {
    element: "[data-tour='header']",
    popover: {
      title: "🏠 Cabeçalho",
      description: "Mostra o nome da fazenda e cidade/UF, status da bridge serial (.exe da fazenda), notificações, idioma e tema claro/escuro.",
      side: "bottom",
      align: "center",
    },
  },
  {
    element: "[data-tour='notifications']",
    popover: {
      title: "🔔 Sino de alertas",
      description: "Lista APENAS comandos não obedecidos (Local / Remoto / Automático). Use o botão 'Limpar' para esconder as falhas atuais sem apagar o histórico de Relatórios. Sucessos vão direto para Relatórios.",
      side: "bottom",
      align: "end",
    },
  },
  {
    element: "[data-tour='theme-toggle']",
    popover: {
      title: "🌙 Tema",
      description: "Alterne entre modo claro e escuro. A preferência fica salva por usuário.",
      side: "bottom",
      align: "end",
    },
  },
  {
    element: "[data-tour='dashboard-cards']",
    popover: {
      title: "📊 Centro de Comando",
      description: "Cards de resumo: bombas ligadas / desligadas, reservatórios em alerta e equipamentos sem comunicação RF. Atualiza a cada 15 s.",
      side: "bottom",
      align: "center",
    },
  },
  {
    element: "[data-tour='dashboard-views']",
    popover: {
      title: "👁 Lista / Detalhes / Mapa",
      description: "Lista é compacta (muitas bombas), Detalhes mostra sinal RF + último comando + horímetro, Mapa exibe a posição real (Lat/Lng) de cada equipamento via OpenStreetMap.",
      side: "bottom",
      align: "start",
    },
  },
  {
    element: "[data-tour='pump-list']",
    popover: {
      title: "💧 Painel de bombas",
      description: "Use o switch para ligar/desligar cada bomba — o comando vai pelo rádio RS-232 (não depende de internet). A barra de 4 barrinhas no card é o único indicador de bomba 'online'. Bombas em AUTO ficam bloqueadas — quem manda é a nuvem.",
      side: "top",
      align: "center",
    },
  },
  {
    element: "[data-tour='reservoir-gauges']",
    popover: {
      title: "📈 Reservatórios",
      description: "Nível em tempo real. Verde = saudável, amarelo = atenção, vermelho = crítico. Vazio (< 25 %) ou Cheio (≥ 95 %) pulsam e disparam alerta sonoro.",
      side: "top",
      align: "center",
    },
  },
  {
    element: "[data-tour='plan-badge']",
    popover: {
      title: "👑 Seu plano",
      description: "PRO libera Demanda de Energia, IA WhatsApp e relatórios avançados. LITE inclui o essencial (controle, automação e níveis).",
      side: "top",
      align: "center",
    },
  },
  {
    element: "[data-tour='network-health']",
    popover: {
      title: "📡 Saúde da rede",
      description: "Conexão da fazenda com a nuvem (polling Cloudflare a cada 30 s). Se cair, o agente Electron continua operando local com SQLite — só a sincronização pausa temporariamente.",
      side: "top",
      align: "center",
    },
  },
];

const restrictedTourSteps: DriveStep[] = [
  {
    element: "[data-tour='suporte-tabs']",
    popover: {
      title: "🔧 Abas de Suporte Técnico",
      description: "Navegue entre Equipamentos, Login, Diagnóstico, Licenças, Porta COM e Fazenda.",
      side: "bottom",
      align: "center",
    },
  },
  {
    element: "[data-tour='tab-equipamentos']",
    popover: {
      title: "📋 Equipamentos",
      description: "Cadastre PLCs e vincule poços, bombeamentos e sensores de nível às saídas disponíveis.",
      side: "bottom",
      align: "start",
    },
  },
  {
    element: "[data-tour='tab-login']",
    popover: {
      title: "🔑 Gestão de Login",
      description: "Gerencie credenciais de acesso, perfis (Admin, Operador, Visualizador) e status dos usuários.",
      side: "bottom",
      align: "start",
    },
  },
  {
    element: "[data-tour='tab-diagnostico']",
    popover: {
      title: "🩺 Diagnóstico",
      description: "Teste comunicação com PLCs, envie comandos individuais e verifique latência e taxa de erros.",
      side: "bottom",
      align: "start",
    },
  },
  {
    element: "[data-tour='tab-licencas']",
    popover: {
      title: "🛡 Licenças",
      description: "Veja o status da licença, data de expiração e ative novas chaves.",
      side: "bottom",
      align: "start",
    },
  },
  {
    element: "[data-tour='tab-porta-com']",
    popover: {
      title: "🔌 Porta COM",
      description: "Configure os parâmetros da comunicação serial: baud rate, data bits, paridade e stop bits.",
      side: "bottom",
      align: "start",
    },
  },
  {
    element: "[data-tour='tab-fazenda']",
    popover: {
      title: "🏗 Fazenda",
      description: "Configure nome, localização e dados de contato da fazenda que aparece no cabeçalho do sistema.",
      side: "bottom",
      align: "start",
    },
  },
];

function createTourDriver(steps: DriveStep[]) {
  return driver({
    showProgress: true,
    animate: true,
    smoothScroll: true,
    allowClose: true,
    overlayColor: "hsl(0 0% 0% / 0.6)",
    stagePadding: 8,
    stageRadius: 12,
    popoverClass: "renov-tour-popover",
    nextBtnText: "Próximo →",
    prevBtnText: "← Anterior",
    doneBtnText: "Concluir ✓",
    progressText: "{{current}} de {{total}}",
    steps,
  });
}

export function useGuidedTour() {
  const startMainTour = useCallback(() => {
    const d = createTourDriver(mainTourSteps);
    d.drive();
  }, []);

  const startRestrictedTour = useCallback(() => {
    const d = createTourDriver(restrictedTourSteps);
    d.drive();
  }, []);

  return { startMainTour, startRestrictedTour };
}

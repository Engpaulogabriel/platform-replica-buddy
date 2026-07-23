export type Language = "pt" | "en" | "es";

export interface Translations {
  // Sidebar
  navigation: string;
  restricted: string;
  home: string;
  automation: string;
  alarms: string;
  reports: string;
  users: string;
  settings: string;
  aiIntegrations: string;
  help: string;
  equipment: string;
  diagnostics: string;
  licenses: string;
  administrator: string;
  logout: string;
  expandMenu: string;
  collapseMenu: string;

  // Dashboard
  commandCenter: string;
  realTimeMonitoring: string;
  active: string;
  offline: string;
  alerts: string;
  wellsPumps: string;
  levels: string;
  consumption: string;
  list: string;
  details: string;
  map: string;
  layout: string;
  customizeLayout: string;
  sectionOrder: string;
  invertOrder: string;
  pumpOrder: string;
  reservoirOrder: string;
  restoreDefault: string;
  layoutRestored: string;
  wellsAndPumps: string;
  reservoirs: string;
  localMode: string;

  // Reservoir
  empty: string;
  full: string;
  muteAlarm: string;
  enableSound: string;

  // Pump table
  name: string;
  status: string;
  mode: string;
  hourMeter: string;
  flow: string;
  dailyConsumption: string;
  signal: string;
  lastCommand: string;
  action: string;
  on: string;
  off: string;
  manual: string;
  auto: string;
  turningOn: string;
  turningOff: string;
  error: string;
  noFlow: string;

  // Language
  language: string;
}

export const translations: Record<Language, Translations> = {
  pt: {
    navigation: "Navegação",
    restricted: "Área Restrita",
    home: "Início",
    automation: "Automático",
    alarms: "Alarmes",
    reports: "Relatórios",
    users: "Usuários",
    settings: "Configurações",
    aiIntegrations: "IA e Integrações",
    help: "Ajuda",
    equipment: "Equipamentos",
    diagnostics: "Diagnóstico",
    licenses: "Licenças",
    administrator: "Administrador",
    logout: "Sair",
    expandMenu: "Expandir menu",
    collapseMenu: "Recolher menu",

    commandCenter: "Centro de Comando",
    realTimeMonitoring: "Monitoramento em tempo real",
    active: "Ativas",
    offline: "Offline",
    alerts: "Alertas",
    wellsPumps: "Poços/Bombas",
    levels: "Níveis",
    consumption: "Consumo",
    list: "Lista",
    details: "Detalhes",
    map: "Mapa",
    layout: "Layout",
    customizeLayout: "Personalizar Layout",
    sectionOrder: "Ordem das Seções",
    invertOrder: "Inverter Ordem",
    pumpOrder: "Ordem dos Poços",
    reservoirOrder: "Ordem dos Reservatórios",
    restoreDefault: "Restaurar Padrão",
    layoutRestored: "Layout restaurado ao padrão",
    wellsAndPumps: "Poços e Bombas",
    reservoirs: "Reservatórios",
    localMode: "Modo Local (IP)",

    empty: "VAZIO",
    full: "CHEIO",
    muteAlarm: "Silenciar alarme",
    enableSound: "Ativar som",

    name: "Nome",
    status: "Status",
    mode: "Modo",
    hourMeter: "Horímetro",
    flow: "Vazão",
    dailyConsumption: "Consumo Diário",
    signal: "Sinal",
    lastCommand: "Último Comando",
    action: "Ação",
    on: "Ligado",
    off: "Desligado",
    manual: "Manual",
    auto: "Automático",
    turningOn: "Ligando...",
    turningOff: "Desligando...",
    error: "Erro",
    noFlow: "Sem vazão",

    language: "Idioma",
  },

  en: {
    navigation: "Navigation",
    restricted: "Restricted Area",
    home: "Home",
    automation: "Automation",
    alarms: "Alarms",
    reports: "Reports",
    users: "Users",
    settings: "Settings",
    aiIntegrations: "AI & Integrations",
    help: "Help",
    equipment: "Equipment",
    diagnostics: "Diagnostics",
    licenses: "Licenses",
    administrator: "Administrator",
    logout: "Logout",
    expandMenu: "Expand menu",
    collapseMenu: "Collapse menu",

    commandCenter: "Command Center",
    realTimeMonitoring: "Real-time monitoring",
    active: "Active",
    offline: "Offline",
    alerts: "Alerts",
    wellsPumps: "Wells/Pumps",
    levels: "Levels",
    consumption: "Consumption",
    list: "List",
    details: "Details",
    map: "Map",
    layout: "Layout",
    customizeLayout: "Customize Layout",
    sectionOrder: "Section Order",
    invertOrder: "Invert Order",
    pumpOrder: "Pump Order",
    reservoirOrder: "Reservoir Order",
    restoreDefault: "Restore Default",
    layoutRestored: "Layout restored to default",
    wellsAndPumps: "Wells & Pumps",
    reservoirs: "Reservoirs",
    localMode: "Local Mode (IP)",

    empty: "EMPTY",
    full: "FULL",
    muteAlarm: "Mute alarm",
    enableSound: "Enable sound",

    name: "Name",
    status: "Status",
    mode: "Mode",
    hourMeter: "Hour Meter",
    flow: "Flow",
    dailyConsumption: "Daily Consumption",
    signal: "Signal",
    lastCommand: "Last Command",
    action: "Action",
    on: "On",
    off: "Off",
    manual: "Manual",
    auto: "Automatic",
    turningOn: "Turning on...",
    turningOff: "Turning off...",
    error: "Error",
    noFlow: "No flow",

    language: "Language",
  },

  es: {
    navigation: "Navegación",
    restricted: "Área Restringida",
    home: "Inicio",
    automation: "Automatización",
    alarms: "Alarmas",
    reports: "Informes",
    users: "Usuarios",
    settings: "Configuración",
    aiIntegrations: "IA e Integraciones",
    help: "Ayuda",
    equipment: "Equipos",
    diagnostics: "Diagnóstico",
    licenses: "Licencias",
    administrator: "Administrador",
    logout: "Salir",
    expandMenu: "Expandir menú",
    collapseMenu: "Contraer menú",

    commandCenter: "Centro de Mando",
    realTimeMonitoring: "Monitoreo en tiempo real",
    active: "Activas",
    offline: "Fuera de línea",
    alerts: "Alertas",
    wellsPumps: "Pozos/Bombas",
    levels: "Niveles",
    consumption: "Consumo",
    list: "Lista",
    details: "Detalles",
    map: "Mapa",
    layout: "Diseño",
    customizeLayout: "Personalizar Diseño",
    sectionOrder: "Orden de Secciones",
    invertOrder: "Invertir Orden",
    pumpOrder: "Orden de Pozos",
    reservoirOrder: "Orden de Reservorios",
    restoreDefault: "Restaurar Predeterminado",
    layoutRestored: "Diseño restaurado al predeterminado",
    wellsAndPumps: "Pozos y Bombas",
    reservoirs: "Reservorios",
    localMode: "Modo Local (IP)",

    empty: "VACÍO",
    full: "LLENO",
    muteAlarm: "Silenciar alarma",
    enableSound: "Activar sonido",

    name: "Nombre",
    status: "Estado",
    mode: "Modo",
    hourMeter: "Horómetro",
    flow: "Caudal",
    dailyConsumption: "Consumo Diario",
    signal: "Señal",
    lastCommand: "Último Comando",
    action: "Acción",
    on: "Encendido",
    off: "Apagado",
    manual: "Manual",
    auto: "Automático",
    turningOn: "Encendiendo...",
    turningOff: "Apagando...",
    error: "Error",
    noFlow: "Sin caudal",

    language: "Idioma",
  },
};

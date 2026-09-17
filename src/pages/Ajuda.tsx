import { useState } from "react";
import {
  HelpCircle, Home, Cpu, Bell, BarChart3, Users, Settings, Bot,
  Stethoscope, Shield, ChevronRight, ChevronDown, CheckCircle2,
  Droplets, Navigation, Zap, Phone, Wrench, MapPin, Radio,
  Power, Trash2, ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGuidedTour } from "@/hooks/useGuidedTour";

interface GuideStep {
  title: string;
  description: string;
}

interface GuideSection {
  id: string;
  title: string;
  icon: React.ElementType;
  color: string;
  description: string;
  steps: GuideStep[];
  tips?: string[];
}

const guides: GuideSection[] = [
  {
    id: "dashboard",
    title: "Início — Centro de Comando",
    icon: Home,
    color: "text-primary",
    description: "Visão geral em tempo real de todas as bombas, reservatórios, status de comunicação e ações rápidas.",
    steps: [
      { title: "Cards de resumo (topo)", description: "Mostram total de bombas (Ligadas / Desligadas), reservatórios em alerta e equipamentos sem comunicação RF nas últimas leituras. Atualizam a cada 15 s." },
      { title: "Visualização Lista / Detalhes / Mapa", description: "Botões no topo do painel. Lista é compacta para muitos equipamentos. Detalhes mostra tudo (sinal, último comando, horímetro). Mapa exibe a localização real (Lat/Lng cadastrado)." },
      { title: "Ligar / desligar uma bomba", description: "Use o switch no card. O comando vai pelo rádio RS-232 (não depende de internet). Enquanto a bomba responde, aparece o estado 'Ligando…'. Se passar do tempo, vira ⚠ falha — toque o switch para resetar." },
      { title: "Sinal RF (4 barrinhas)", description: "Único indicador de 'online' por bomba. Mede a latência da última resposta: ≤4 s = 4 barras, ≤5 s = 3, ≤6 s = 2, ≤8 s = 1, acima disso a antena fica apagada." },
      { title: "Badge AUTO", description: "Aparece quando a bomba tem ao menos 1 programação ativa. Em AUTO o switch fica bloqueado — quem manda é o motor de automação na nuvem." },
      { title: "Reservatórios", description: "Cada reservatório mostra o nível em % com cor: verde (saudável), amarelo (atenção), vermelho (crítico — vazio < 25 % ou cheio ≥ 95 %). Em estado crítico, o card pulsa e dispara alerta sonoro." },
      { title: "Personalizar layout", description: "Botão 'Layout' permite reordenar bombas, mover reservatórios para cima/baixo e esconder seções. A escolha fica salva por usuário." },
    ],
    tips: [
      "Duplo clique numa bomba na visão Lista abre as programações daquela bomba.",
      "Bomba que desligou sozinha fora do horário tem o automático desativado por segurança — clique no badge de alerta para reativar.",
      "Se o agente Electron da fazenda cair, todos os cards continuam mostrando o último estado conhecido até o agente voltar.",
    ],
  },
  {
    id: "automacao",
    title: "Automático — Programações 24/7",
    icon: Cpu,
    color: "text-warning",
    description: "Cria horários automáticos por bomba, por dia da semana. Roda 100 % na nuvem (não precisa do PC ligado).",
    steps: [
      { title: "Motor de Automação", description: "Switch global no topo. Quando desligado, o sistema NÃO envia nenhum comando automático — útil para manutenção." },
      { title: "Novo agendamento", description: "Botão '+ Novo'. Escolha bomba, dias da semana, horário de ligar e horário de desligar. Múltiplos horários por bomba são permitidos." },
      { title: "Modos do agendamento", description: "Ligar+Desligar (padrão), Só Ligar (só envia comando de ligar) ou Só Desligar (proteção fim de turno)." },
      { title: "Configuração de Feriado", description: "Por bomba você pode definir um modo especial em feriados (ex: só liga em janela reduzida). A lista de feriados nacionais já vem pronta." },
      { title: "Guarda de Segurança", description: "Se uma bomba desligar fisicamente fora do horário programado, o automático dela é pausado automaticamente e aparece um alerta no Dashboard. Reative com 1 clique quando o problema for resolvido." },
      { title: "Histórico de execução", description: "Cada disparo é registrado com origem 'Automático' no histórico — você vê em Relatórios e no sino do header." },
    ],
    tips: [
      "Pelo menos 1 agendamento ativo = bomba ganha o badge AUTO no Dashboard.",
      "O motor roda no servidor a cada 1 minuto — não importa se o PC da fazenda estiver desligado.",
    ],
  },
  {
    id: "demanda",
    title: "Demanda de Energia (PRO)",
    icon: Zap,
    color: "text-warning",
    description: "Monitora o consumo elétrico em tempo real e desliga bombas por prioridade quando você ultrapassa o teto contratado.",
    steps: [
      { title: "Configurar limite", description: "Defina o teto da sua conta de energia (kW ou MW — o sistema converte automaticamente)." },
      { title: "Demanda de cada bomba", description: "No cadastro de cada equipamento informe a demanda em kW. O sistema soma o que está ligado em tempo real." },
      { title: "Prioridade", description: "Ordene as bombas por importância. Quando o consumo total ultrapassar o teto, as bombas de menor prioridade desligam automaticamente." },
      { title: "Horário de pico", description: "Configure faixas de horário de pico para cada bomba. Ela é evitada nesses horários quando possível." },
    ],
  },
  {
    id: "alertas",
    title: "Sino de Alertas (header)",
    icon: Bell,
    color: "text-destructive",
    description: "Notifica falhas de comando e eventos importantes. Fica no canto superior direito.",
    steps: [
      { title: "O que aparece aqui", description: "APENAS comandos não obedecidos — 'Bomba não ligou' ou 'Bomba não desligou' (Local, Remoto ou Automático). Sucessos vão direto para Relatórios." },
      { title: "Aba Falhas", description: "Lista cronológica das falhas mais recentes, com nome da bomba, origem, usuário e tempo." },
      { title: "Aba Sistema", description: "Notificações gerais do sistema (atualizações, mensagens da Renov, manutenção)." },
      { title: "Botão Limpar", description: "Esconde as falhas atuais do sino sem apagar o histórico — Relatórios continuam intactos. Novas falhas voltam a aparecer normalmente." },
      { title: "Botão Relatório", description: "Atalho para o histórico completo com filtros por data, bomba e origem." },
    ],
  },
  {
    id: "relatorios",
    title: "Relatórios — Histórico Completo",
    icon: BarChart3,
    color: "text-primary",
    description: "Histórico de todos os comandos, automações, horímetros, consumo e níveis. Exporta PDF e CSV.",
    steps: [
      { title: "Período", description: "Seletor de datas: hoje, 7 dias, 30 dias ou personalizado." },
      { title: "Abas", description: "Comandos (cada ligar/desligar), Horímetro (horas trabalhadas por bomba), Níveis (histórico dos reservatórios), Automação (disparos do motor)." },
      { title: "Filtros", description: "Por bomba, por origem (Local / Remoto / Automático) e por resultado (sucesso / falha)." },
      { title: "Exportar PDF", description: "Gera relatório com a marca Renov, cabeçalho da fazenda e todas as tabelas selecionadas." },
      { title: "Exportar CSV", description: "Para abrir no Excel, fazer análises ou enviar à contabilidade." },
    ],
  },
  {
    id: "usuarios",
    title: "Usuários — Acesso e Funções",
    icon: Users,
    color: "text-info",
    description: "Cadastro de quem pode acessar a fazenda e qual o nível de permissão.",
    steps: [
      { title: "Funções disponíveis", description: "Owner (dono): acesso total + licença/dispositivo. Admin (Supervisor): mesmos poderes do dono no dia a dia. Operador: liga/desliga e cria automações. Viewer: só visualiza." },
      { title: "Adicionar usuário", description: "'+ Novo Usuário' → email, nome, senha provisória e função. O sistema cria o login automaticamente — o usuário já entra direto." },
      { title: "Resetar senha", description: "Botão de chave ao lado do usuário. Gera nova senha provisória que você envia ao operador." },
      { title: "Desativar / excluir", description: "Remove o acesso imediatamente. O histórico do que o usuário fez fica preservado nos Relatórios." },
    ],
    tips: [
      "Para criar um Supervisor com poderes do dono, escolha a função Admin.",
      "Cada fazenda tem apenas 1 dono. Se precisar transferir, peça à Renov.",
    ],
  },
  {
    id: "configuracoes",
    title: "Configurações — Ajustes do Sistema",
    icon: Settings,
    color: "text-muted-foreground",
    description: "Módulos opcionais, temporizadores, RF, idioma e dados da fazenda.",
    steps: [
      { title: "Módulos opcionais", description: "Vazão e Consumo vêm desativados de fábrica. Quando ativos, aparecem novas colunas no Dashboard e nos Relatórios." },
      { title: "Temporizadores", description: "Ajusta tempo máximo de comunicação para automação (5–30 min), tempo de leitura de níveis e auto-reset de comandos pendentes." },
      { title: "Roteamento RF", description: "Define o rádio (R1/R2/R3) e se passa por repetidor para a fazenda toda. É possível sobrescrever por equipamento se houver bomba isolada." },
      { title: "Idioma", description: "🇧🇷 Português, 🇺🇸 Inglês ou 🇪🇸 Espanhol. A troca é imediata." },
      { title: "Dados da fazenda", description: "Nome, cidade, UF e fuso horário. O nome aparece no cabeçalho de toda a aplicação." },
    ],
  },
  {
    id: "integracoes",
    title: "IA e Integrações",
    icon: Bot,
    color: "text-primary",
    description: "Assistente WhatsApp e outras integrações externas.",
    steps: [
      { title: "Assistente WhatsApp", description: "Conecte o número da fazenda lendo o QR Code. O assistente responde perguntas e envia alertas críticos pelo WhatsApp." },
      { title: "Histórico de interações", description: "Veja todas as conversas e comandos enviados pelo WhatsApp para auditoria." },
      { title: "Ativação", description: "Disponível apenas no plano PRO. Peça à Renov para liberar." },
    ],
  },
  {
    id: "ajuda",
    title: "Ajuda — Você está aqui!",
    icon: HelpCircle,
    color: "text-info",
    description: "Tutoriais escritos + Tour Guiado interativo de toda a interface.",
    steps: [
      { title: "Tour Guiado", description: "Botão verde no topo. Destaca cada parte da tela e explica em pop-ups. Ideal para o primeiro uso ou para treinar novos operadores." },
      { title: "Guias por seção", description: "Cada item desta página é um passo a passo da funcionalidade. Clique para expandir." },
    ],
  },
  {
    id: "contato",
    title: "Contato — Suporte Renov",
    icon: Phone,
    color: "text-primary",
    description: "Telefone, e-mail, WhatsApp, redes sociais e endereço com link para o Google Maps.",
    steps: [
      { title: "Como falar com a gente", description: "WhatsApp, telefone fixo e e-mail oficial. Clique para abrir direto no aplicativo correspondente." },
      { title: "Endereço com Maps", description: "Botão 'Como chegar (Google Maps)' abre a rota até a sede da Renov em Luís Eduardo Magalhães — BA." },
    ],
  },
  {
    id: "suporte",
    title: "Suporte Técnico (área restrita)",
    icon: Wrench,
    color: "text-warning",
    description: "Hub para o instalador/técnico. Protegido por senha de acesso técnico.",
    steps: [
      { title: "Como entrar", description: "Item 'Suporte Técnico' no menu lateral inferior. Pede uma senha de acesso técnico — sessão fica ativa por 30 min." },
      { title: "Equipamentos / PLCs / Setores", description: "Cadastro central: PLC (placa de comunicação, máx. 6 saídas), depois vincule cada bomba/reservatório a uma saída. ID da bomba na nuvem = '<plcHex><saída 2 dígitos>'." },
      { title: "Diagnóstico RS-485", description: "Envia frames manuais, mostra o que sai e o que entra na porta serial. Inclui PING, STATUS, CFG remoto de bomba/repetidor/servidor." },
      { title: "Porta COM", description: "Define qual COM o agente Electron deve usar (9600 baud, 8N1)." },
      { title: "Licença e Dispositivo", description: "Mostra a chave de licença e o hardware vinculado. Anticlone via HMAC JWT 48h." },
    ],
  },
  {
    id: "plataforma",
    title: "Plataforma (apenas Renov)",
    icon: ShieldCheck,
    color: "text-primary",
    description: "Painel exclusivo da equipe Renov para gerir todas as fazendas: licenças, alertas cross-farm, relatórios consolidados e controle remoto.",
    steps: [
      { title: "Aba Fazendas", description: "Tabela com todas as fazendas: nome, plano, licença, agente online, equipamentos e usuários. Clique no Farm ID (UUID) para copiar." },
      { title: "Modo Demonstração", description: "Dropdown amarelo no header: ativa fazendas fictícias para apresentação a clientes, sem afetar dados reais." },
      { title: "Acessar Fazenda", description: "Dropdown azul: impersonate seguro em fazendas reais (com busca e status online) para dar suporte." },
      { title: "Alertas, Relatórios, Controle Remoto", description: "Feed unificado cross-farm, KPIs consolidados, reboot do agente, mensagens em banner e toggle de módulos opcionais por fazenda." },
    ],
  },
];

export default function Ajuda() {
  const [expandedGuide, setExpandedGuide] = useState<string | null>(null);
  const { startMainTour } = useGuidedTour();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-bold text-foreground flex items-center gap-2">
            <HelpCircle className="w-5 h-5 text-primary" />
            Central de Ajuda
          </h1>
          <p className="text-xs text-muted-foreground">
            Tutorial passo a passo de cada funcionalidade do sistema atualizado
          </p>
        </div>
        <Button onClick={startMainTour} className="gap-2 h-9">
          <Navigation className="w-4 h-4" />
          Tour Guiado
        </Button>
      </div>

      {/* Quick overview */}
      <div className="bg-card border border-border rounded-lg p-3 space-y-2">
        <p className="text-xs font-semibold text-foreground">🚀 Primeiros passos</p>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          {[
            { step: "1", text: "Cadastre PLCs e equipamentos em Suporte Técnico", icon: Cpu },
            { step: "2", text: "Acompanhe bombas e níveis no Início", icon: Droplets },
            { step: "3", text: "Crie programações no Automático", icon: Power },
            { step: "4", text: "Acompanhe falhas no sino e Relatórios", icon: Bell },
          ].map(item => (
            <div key={item.step} className="flex items-start gap-2 p-2 rounded-md bg-secondary/30 border border-border">
              <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                {item.step}
              </span>
              <span className="text-xs text-foreground">{item.text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Comunicação info */}
      <div className="bg-info/5 border border-info/20 rounded-lg p-3 flex items-start gap-3">
        <Radio className="w-5 h-5 text-info shrink-0 mt-0.5" />
        <div className="text-xs text-foreground space-y-1">
          <p className="font-semibold">Como funciona a comunicação</p>
          <p className="text-muted-foreground leading-relaxed">
            Os comandos para as bombas saem do PC da fazenda (agente Electron) pelo rádio RS-232 — <strong>não dependem de internet</strong>.
            A nuvem é usada para automação 24/7, histórico, relatórios e acesso remoto.
            O único indicador visual de bomba "online" é a barra de sinal RF de 4 barrinhas em cada card.
          </p>
        </div>
      </div>

      {/* Guide sections */}
      <div className="space-y-2">
        {guides.map(guide => (
          <div key={guide.id} className="bg-card border border-border rounded-lg overflow-hidden">
            <button
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-secondary/30 transition-colors"
              onClick={() => setExpandedGuide(expandedGuide === guide.id ? null : guide.id)}
            >
              <div className="w-8 h-8 rounded-md bg-secondary flex items-center justify-center shrink-0">
                <guide.icon className={`w-4 h-4 ${guide.color}`} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">{guide.title}</p>
                <p className="text-[10px] text-muted-foreground">{guide.description}</p>
              </div>
              {expandedGuide === guide.id ? (
                <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
              ) : (
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              )}
            </button>

            {expandedGuide === guide.id && (
              <div className="px-4 pb-4 space-y-3">
                <div className="border-t border-border pt-3 space-y-2">
                  {guide.steps.map((step, i) => (
                    <div key={i} className="flex gap-3">
                      <div className="flex flex-col items-center">
                        <span className="w-6 h-6 rounded-full bg-primary/15 text-primary flex items-center justify-center text-[10px] font-bold shrink-0">
                          {i + 1}
                        </span>
                        {i < guide.steps.length - 1 && (
                          <div className="w-px flex-1 bg-border my-1" />
                        )}
                      </div>
                      <div className="pb-3">
                        <p className="text-xs font-semibold text-foreground">{step.title}</p>
                        <p className="text-[11px] text-muted-foreground leading-relaxed">{step.description}</p>
                      </div>
                    </div>
                  ))}
                </div>

                {guide.tips && guide.tips.length > 0 && (
                  <div className="bg-info/5 border border-info/20 rounded-md p-3 space-y-1.5">
                    <p className="text-[10px] font-bold text-info uppercase tracking-wide">💡 Dicas</p>
                    {guide.tips.map((tip, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <CheckCircle2 className="w-3 h-3 text-info shrink-0 mt-0.5" />
                        <p className="text-[11px] text-foreground">{tip}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

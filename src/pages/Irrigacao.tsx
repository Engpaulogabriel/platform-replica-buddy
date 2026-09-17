import { useState } from "react";
import { Routes, Route, useNavigate, useParams, Link, Navigate } from "react-router-dom";
import {
  CircleArrowLeft,
  Square,
  ArrowRight,
  Droplets,
  Gauge,
  Clock,
  Thermometer,
  Zap,
  Compass,
  Wind,
  Wifi,
  Info,
  ArrowLeft,
  Settings,
  Activity,
} from "lucide-react";

// ============ MOCK DATA ============
type PivoStatus = "Rodando" | "Parado" | "Falha";
interface PivoResumo {
  id: string;
  nome: string;
  cultura: string;
  status: PivoStatus;
  angulo: number;
  velocidade: number;
  ultima: string;
}

const pivos: PivoResumo[] = [
  { id: "pivo_01", nome: "Pivô 01 - Soja",    cultura: "Soja",    status: "Rodando", angulo: 284, velocidade: 80, ultima: "2 min atrás" },
  { id: "pivo_02", nome: "Pivô 02 - Milho",   cultura: "Milho",   status: "Parado",  angulo: 120, velocidade: 0,  ultima: "8 min atrás" },
  { id: "pivo_03", nome: "Pivô 03 - Algodão", cultura: "Algodão", status: "Rodando", angulo: 45,  velocidade: 60, ultima: "1 min atrás" },
];

const detalhesPorId: Record<string, {
  nome: string; cultura: string; talhao: string; area: number; comprimento: number;
  latitude: number; longitude: number; tsnn: string;
  angulo_atual: number; percentimetro_atual: number; lamina_mm: number;
  tensao_painel: number; pressao_ponta: number; temperatura: number;
  tempo_restante_volta: string; status_operacao: PivoStatus;
  status_canhao_1: boolean; status_canhao_2: boolean;
  bomba_poco_intertravamento: boolean; reversao_automatica: boolean;
  last_poll: string;
}> = {
  pivo_01: { nome: "Pivô 01 - Soja", cultura: "Soja", talhao: "Talhão 12", area: 125.6, comprimento: 480, latitude: -13.245, longitude: -46.128, tsnn: "2201", angulo_atual: 284, percentimetro_atual: 80, lamina_mm: 5.98, tensao_painel: 519, pressao_ponta: 0.41, temperatura: 24.4, tempo_restante_volta: "12h 07m", status_operacao: "Rodando", status_canhao_1: true, status_canhao_2: false, bomba_poco_intertravamento: true, reversao_automatica: false, last_poll: "2 min atrás" },
  pivo_02: { nome: "Pivô 02 - Milho", cultura: "Milho", talhao: "Talhão 08", area: 98.2, comprimento: 420, latitude: -13.251, longitude: -46.135, tsnn: "2202", angulo_atual: 120, percentimetro_atual: 0, lamina_mm: 0, tensao_painel: 512, pressao_ponta: 0, temperatura: 23.1, tempo_restante_volta: "—", status_operacao: "Parado", status_canhao_1: false, status_canhao_2: false, bomba_poco_intertravamento: true, reversao_automatica: true, last_poll: "8 min atrás" },
  pivo_03: { nome: "Pivô 03 - Algodão", cultura: "Algodão", talhao: "Talhão 05", area: 142.0, comprimento: 510, latitude: -13.238, longitude: -46.140, tsnn: "2203", angulo_atual: 45, percentimetro_atual: 60, lamina_mm: 7.20, tensao_painel: 524, pressao_ponta: 0.38, temperatura: 25.8, tempo_restante_volta: "16h 30m", status_operacao: "Rodando", status_canhao_1: true, status_canhao_2: true, bomba_poco_intertravamento: true, reversao_automatica: false, last_poll: "1 min atrás" },
};

// ============ ROUTER ROOT ============
export default function Irrigacao() {
  return (
    <Routes>
      <Route index element={<PivoPainel />} />
      <Route path=":id" element={<PivoDetalhe />} />
      <Route path=":id/config" element={<PivoConfig />} />
      <Route path="*" element={<Navigate to="/irrigacao" replace />} />
    </Routes>
  );
}

// ============ HELPERS ============
function statusBadge(status: PivoStatus) {
  if (status === "Rodando") return { cls: "bg-green-500/15 text-green-400 border-green-500/30", dot: "bg-green-400 animate-pulse" };
  if (status === "Parado")  return { cls: "bg-slate-500/15 text-slate-300 border-slate-500/30", dot: "bg-slate-400" };
  return { cls: "bg-red-500/15 text-red-400 border-red-500/30", dot: "bg-red-400 animate-pulse" };
}

function MiniPivo({ angulo }: { angulo: number }) {
  const cx = 20, cy = 20, r = 16;
  const polar = (deg: number, rr: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + rr * Math.cos(rad), y: cy + rr * Math.sin(rad) };
  };
  const s = polar(0, r), e = polar(angulo, r);
  const large = angulo > 180 ? 1 : 0;
  const filled = `M ${cx} ${cy} L ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y} Z`;
  return (
    <svg viewBox="0 0 40 40" className="h-10 w-10">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
      <path d={filled} fill="rgba(56,189,248,0.45)" stroke="rgba(125,211,252,0.7)" strokeWidth="1" />
      <circle cx={cx} cy={cy} r={2} fill="#f8fafc" />
    </svg>
  );
}

// ============ TELA 1: PAINEL ============
function PivoPainel() {
  const navigate = useNavigate();
  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950 text-slate-100 p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Irrigação · Painel de Pivôs</h1>
        <p className="text-sm text-slate-400 mt-1">Clique em um pivô para visualizar controle e sensores em tempo real</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {pivos.map((p) => {
          const b = statusBadge(p.status);
          return (
            <button
              key={p.id}
              onClick={() => navigate(`/irrigacao/${p.id}`)}
              className="text-left rounded-xl border border-slate-800 bg-slate-900 hover:bg-slate-900/80 hover:border-sky-700 transition p-5 shadow-md hover:shadow-xl active:scale-[0.99]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-lg font-bold text-white truncate">{p.nome}</h3>
                  <p className="text-xs text-slate-400 mt-0.5">🌱 {p.cultura}</p>
                </div>
                <MiniPivo angulo={p.angulo} />
              </div>

              <div className="mt-4">
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${b.cls}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${b.dot}`} />
                  {p.status}
                </span>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2">
                <div className="rounded-md bg-slate-950/60 border border-slate-800 p-2 text-center">
                  <div className="text-xs text-slate-400">Ângulo</div>
                  <div className="text-sm font-bold text-white">{p.angulo}°</div>
                </div>
                <div className="rounded-md bg-slate-950/60 border border-slate-800 p-2 text-center">
                  <div className="text-xs text-slate-400">Velocidade</div>
                  <div className="text-sm font-bold text-white">{p.velocidade}%</div>
                </div>
                <div className="rounded-md bg-slate-950/60 border border-slate-800 p-2 text-center">
                  <div className="text-xs text-slate-400">Poll</div>
                  <div className="text-[11px] font-semibold text-slate-200 leading-tight">{p.ultima}</div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============ SVG DO PIVÔ (compacto) ============
function PivoOverlay({ angulo }: { angulo: number }) {
  const cx = 300, cy = 300, r = 200;
  const polar = (deg: number, radius: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
  };
  const start = polar(0, r);
  const end = polar(angulo, r);
  const largeArc = angulo > 180 ? 1 : 0;
  const filledPath = `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
  const dashEnd = polar(360 - 0.01, r);
  const dashLarge = 360 - angulo > 180 ? 1 : 0;
  const dashPath = `M ${end.x} ${end.y} A ${r} ${r} 0 ${dashLarge} 1 ${dashEnd.x} ${dashEnd.y}`;
  const raio = polar(angulo, r);
  return (
    <svg viewBox="0 0 600 600" className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid meet">
      <path d={filledPath} fill="rgba(56, 189, 248, 0.28)" stroke="rgba(125,211,252,0.6)" strokeWidth="1.5" />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2" />
      <path d={dashPath} fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeDasharray="6 6" />
      <line x1={cx} y1={cy} x2={raio.x} y2={raio.y} stroke="#f8fafc" strokeWidth="3.5" strokeLinecap="round" />
      {[0.25, 0.5, 0.75].map((f) => {
        const p = polar(angulo, r * f);
        return <circle key={f} cx={p.x} cy={p.y} r={4} fill="#0ea5e9" stroke="#f8fafc" strokeWidth="1.5" />;
      })}
      <circle cx={raio.x} cy={raio.y} r={7} fill="#22c55e" stroke="#f8fafc" strokeWidth="2" />
      <circle cx={cx} cy={cy} r={8} fill="#f8fafc" />
      <circle cx={cx} cy={cy} r={3} fill="#0f172a" />
    </svg>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-green-500" : "bg-slate-600"}`}
      aria-pressed={checked}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

// ============ HEADER com Voltar + Tabs ============
function PivoHeader({ id, nome, aba }: { id: string; nome: string; aba: "controle" | "config" }) {
  return (
    <div className="border-b border-slate-800 bg-slate-900/60 px-4 py-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/irrigacao"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-200"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Voltar
          </Link>
          <div className="min-w-0">
            <h1 className="text-base sm:text-lg font-bold text-white truncate">{nome}</h1>
            <p className="text-[11px] text-slate-400">Monitoramento e controle em tempo real</p>
          </div>
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
          <Link
            to={`/irrigacao/${id}`}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${aba === "controle" ? "bg-sky-600 text-white" : "text-slate-300 hover:bg-slate-800"}`}
          >
            <Activity className="h-3.5 w-3.5" /> Controle
          </Link>
          <Link
            to={`/irrigacao/${id}/config`}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${aba === "config" ? "bg-sky-600 text-white" : "text-slate-300 hover:bg-slate-800"}`}
          >
            <Settings className="h-3.5 w-3.5" /> Configurações
          </Link>
        </div>
      </div>
    </div>
  );
}

// ============ TELA 2: DETALHE ============
function PivoDetalhe() {
  const { id = "" } = useParams();
  const pivo = detalhesPorId[id];
  if (!pivo) return <Navigate to="/irrigacao" replace />;

  const [bombaPoco, setBombaPoco] = useState(pivo.bomba_poco_intertravamento);
  const [reversaoAuto, setReversaoAuto] = useState(pivo.reversao_automatica);
  const [acaoAtiva, setAcaoAtiva] = useState<"reversao" | "parar" | "avanco">(
    pivo.status_operacao === "Parado" ? "parar" : "avanco"
  );
  const [aguaLigada, setAguaLigada] = useState(pivo.percentimetro_atual > 0);

  return (
    <div className="h-[calc(100vh-4rem)] overflow-hidden bg-slate-950 text-slate-100 flex flex-col">
      <PivoHeader id={id} nome={pivo.nome} aba="controle" />

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-2 p-2 overflow-hidden">
        {/* MAPA */}
        <div
          className="relative flex-1 min-h-0 lg:max-w-[60%] rounded-xl overflow-hidden border border-slate-800"
          style={{
            background:
              "radial-gradient(ellipse at center, #1a2e1a 0%, #0f1a0f 55%, #0a0f0a 100%)",
          }}
        >
          <div
            className="absolute inset-0 opacity-60 pointer-events-none"
            style={{
              backgroundImage:
                "repeating-linear-gradient(45deg, rgba(30,60,35,0.35) 0 3px, rgba(10,20,12,0.15) 3px 8px), repeating-linear-gradient(-45deg, rgba(20,50,25,0.25) 0 4px, transparent 4px 10px)",
            }}
          />
          <div
            className="absolute inset-0 opacity-25 pointer-events-none"
            style={{
              backgroundImage:
                "linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)",
              backgroundSize: "40px 40px",
            }}
          />

          <div className="absolute inset-4 flex items-center justify-center">
            <div className="relative aspect-square h-full max-h-full max-w-full" style={{ width: "min(100%, 100%)" }}>
              <PivoOverlay angulo={pivo.angulo_atual} />
            </div>
          </div>

          <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded-full bg-slate-900/85 border border-slate-700 px-2 py-0.5 backdrop-blur">
            <Wifi className="h-3 w-3 text-green-400" />
            <span className="text-[10px] text-slate-200 font-medium">
              Poll OK <span className="text-slate-400">• {pivo.last_poll}</span>
            </span>
          </div>

          <div className="absolute bottom-2 left-2 rounded-lg bg-slate-900/85 border border-slate-700 px-2 py-1 backdrop-blur text-[10px] space-y-0.5">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-3 rounded-sm bg-sky-400/40 border border-sky-300/60" />
              <span className="text-slate-300">Área irrigada</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-0 w-3 border-t-2 border-dashed border-white/80" />
              <span className="text-slate-300">Restante</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-green-500 border border-white" />
              <span className="text-slate-300">Ponta</span>
            </div>
          </div>

          <div className="absolute top-2 right-2 rounded-md bg-slate-900/80 border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 font-mono">
            {pivo.latitude}°, {pivo.longitude}°
          </div>
        </div>

        {/* PAINEL DIREITO */}
        <aside className="w-full lg:w-[340px] xl:w-[360px] shrink-0 rounded-xl border border-slate-800 bg-slate-900 p-2.5 space-y-2 overflow-hidden flex flex-col">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-bold tracking-tight text-white truncate">{pivo.nome}</h2>
              <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium border ${statusBadge(pivo.status_operacao).cls}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${statusBadge(pivo.status_operacao).dot}`} />
                {pivo.status_operacao}
              </span>
            </div>
            <div className="mt-1 inline-flex items-center gap-1 rounded-md bg-slate-800 border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300">
              🌱 {pivo.cultura} — {pivo.talhao}
            </div>
          </div>

          <div className="grid grid-cols-4 gap-1.5">
            <ActionButton label="REV" icon={<CircleArrowLeft className="h-3.5 w-3.5" />} variant="green" active={acaoAtiva === "reversao"} onClick={() => setAcaoAtiva("reversao")} />
            <ActionButton label="STOP" icon={<Square className="h-3.5 w-3.5 fill-current" />} variant="red" active={acaoAtiva === "parar"} onClick={() => setAcaoAtiva("parar")} />
            <ActionButton label="AVANÇO" icon={<ArrowRight className="h-3.5 w-3.5" />} variant="slate" active={acaoAtiva === "avanco"} onClick={() => setAcaoAtiva("avanco")} />
            <ActionButton label="ÁGUA" icon={<Droplets className="h-3.5 w-3.5" />} variant="blue" active={aguaLigada} onClick={() => setAguaLigada((v) => !v)} />
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            <MetricCard icon={<Gauge className="h-3 w-3 text-sky-400" />} value={`${pivo.percentimetro_atual}%`} label="Veloc." />
            <MetricCard icon={<Droplets className="h-3 w-3 text-sky-400" />} value={`${pivo.lamina_mm.toString().replace(".", ",")}mm`} label="Lâmina" />
            <MetricCard icon={<Clock className="h-3 w-3 text-sky-400" />} value={pivo.tempo_restante_volta} label="Volta" />
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-950/60">
            <div className="px-2 py-1 border-b border-slate-800 text-[9px] uppercase tracking-wider text-slate-400 font-semibold">Sensores</div>
            <ul className="divide-y divide-slate-800">
              <SensorRow icon={<Compass className="h-3 w-3 text-slate-400" />} label="Ângulo" value={`${pivo.angulo_atual}°`} />
              <SensorRow icon={<Zap className="h-3 w-3 text-amber-400" />} label="Tensão" value={`${pivo.tensao_painel} V`} />
              <SensorRow icon={<Wind className="h-3 w-3 text-slate-400" />} label="Pressão" value={`${pivo.pressao_ponta.toString().replace(".", ",")} bar`} />
              <SensorRow icon={<Thermometer className="h-3 w-3 text-orange-400" />} label="Temp." value={`${pivo.temperatura.toString().replace(".", ",")}°C`} />
            </ul>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-2 py-1.5 space-y-1">
            <div className="text-[9px] uppercase tracking-wider text-slate-400 font-semibold">Acessórios</div>
            <AccessoryRow label="Canhão Final 1" on={pivo.status_canhao_1} />
            <AccessoryRow label="Canhão Final 2" on={pivo.status_canhao_2} />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 rounded-lg border border-green-500/30 bg-green-500/5 px-2 py-1.5">
              <div className="min-w-0">
                <div className="flex items-center gap-1">
                  <span className="text-[11px] font-medium text-white">Bomba do Poço</span>
                  <Info className="h-3 w-3 text-green-400" />
                </div>
                <p className="text-[9px] text-green-300/80 leading-tight">Intertravamento RENOV</p>
              </div>
              <Toggle checked={bombaPoco} onChange={setBombaPoco} />
            </div>
            <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-2 py-1.5">
              <div>
                <span className="text-[11px] font-medium text-white">Reversão Automática</span>
                <p className="text-[9px] text-slate-400 leading-tight">Inverte ao final</p>
              </div>
              <Toggle checked={reversaoAuto} onChange={setReversaoAuto} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ============ TELA 3: CONFIGURAÇÕES ============
function PivoConfig() {
  const { id = "" } = useParams();
  const pivo = detalhesPorId[id];
  if (!pivo) return <Navigate to="/irrigacao" replace />;

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950 text-slate-100 flex flex-col">
      <PivoHeader id={id} nome={pivo.nome} aba="config" />

      <div className="flex-1 p-4 sm:p-6 overflow-auto">
        <div className="max-w-3xl mx-auto space-y-5">
          <FormSection title="Dados Gerais">
            <Field label="Nome do Pivô"><input defaultValue={pivo.nome} className={inputCls} /></Field>
            <Field label="Cultura atual">
              <select defaultValue={pivo.cultura} className={inputCls}>
                {["Soja", "Milho", "Algodão", "Feijão", "Café"].map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Talhão"><input defaultValue={pivo.talhao} className={inputCls} /></Field>
            <Field label="Área total (ha)"><input type="number" defaultValue={pivo.area} className={inputCls} /></Field>
            <Field label="Comprimento do pivô (m)"><input type="number" defaultValue={pivo.comprimento} className={inputCls} /></Field>
          </FormSection>

          <FormSection title="Coordenadas GPS">
            <Field label="Latitude centro"><input type="number" step="0.0001" defaultValue={pivo.latitude} className={inputCls} /></Field>
            <Field label="Longitude centro"><input type="number" step="0.0001" defaultValue={pivo.longitude} className={inputCls} /></Field>
            <Field label="Raio (m)"><input type="number" defaultValue={pivo.comprimento} className={inputCls} /></Field>
          </FormSection>

          <FormSection title="Comunicação">
            <Field label="TSNN do Gateway"><input defaultValue={pivo.tsnn} className={inputCls} /></Field>
            <Field label="Frequência de polling">
              <select defaultValue="30s" className={inputCls}>
                {["15s", "30s", "60s", "120s"].map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Status comunicação">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/30 px-2.5 py-1 text-xs font-medium">
                <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" /> Online
              </span>
            </Field>
          </FormSection>

          <FormSection title="Limites e Alarmes">
            <Field label="Pressão mínima ponta (bar)"><input type="number" step="0.01" defaultValue={0.20} className={inputCls} /></Field>
            <Field label="Tensão mínima (V)"><input type="number" defaultValue={380} className={inputCls} /></Field>
            <Field label="Temperatura máxima (°C)"><input type="number" defaultValue={45} className={inputCls} /></Field>
            <Field label="Ação em falha">
              <select defaultValue="Parar pivô + Desligar bomba" className={inputCls}>
                <option>Parar pivô + Desligar bomba</option>
                <option>Apenas parar pivô</option>
                <option>Apenas alerta</option>
              </select>
            </Field>
          </FormSection>

          <FormSection title="Intertravamento com Bomba" highlight>
            <Field label="Bomba vinculada">
              <select defaultValue="TESTE — Poço 01" className={inputCls}>
                <option>TESTE — Poço 01</option>
                <option>Bomba Principal — Poço 02</option>
                <option>Bomba Auxiliar — Poço 03</option>
              </select>
            </Field>
            <Field label="Intertravamento ativo">
              <ConfigToggle initial={true} />
            </Field>
            <Field label="Delay para desligar bomba (s)"><input type="number" defaultValue={10} className={inputCls} /></Field>
            <Field label="Delay para religar bomba (s)"><input type="number" defaultValue={30} className={inputCls} /></Field>
          </FormSection>

          <div className="flex justify-end pt-2">
            <button
              disabled
              title="Em breve — aguardando integração com banco"
              className="inline-flex items-center gap-2 rounded-lg bg-sky-600/40 border border-sky-700/50 px-5 py-2.5 text-sm font-semibold text-sky-200 cursor-not-allowed"
            >
              Salvar Configurações
            </button>
          </div>
          <div className="text-[10px] text-slate-500 text-center pb-4">
            Tela de demonstração · dados simulados
          </div>
        </div>
      </div>
    </div>
  );
}

// ============ FORM PRIMITIVES ============
const inputCls =
  "w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-500";

function FormSection({ title, highlight, children }: { title: string; highlight?: boolean; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl border p-4 ${highlight ? "border-green-500/30 bg-green-500/5" : "border-slate-800 bg-slate-900"}`}>
      <h3 className={`text-sm font-semibold uppercase tracking-wider mb-3 ${highlight ? "text-green-300" : "text-slate-300"}`}>
        {title}
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-slate-400 mb-1">{label}</span>
      {children}
    </label>
  );
}
function ConfigToggle({ initial }: { initial: boolean }) {
  const [v, setV] = useState(initial);
  return <Toggle checked={v} onChange={setV} />;
}

// ============ SHARED UI ============
function ActionButton({ label, icon, variant, active, onClick }: { label: string; icon: React.ReactNode; variant: "green" | "red" | "blue" | "slate"; active: boolean; onClick: () => void; }) {
  const base = "group relative flex flex-col items-center justify-center gap-0.5 rounded-lg border px-2 py-2 text-[11px] font-bold uppercase tracking-wide transition-all shadow-md hover:shadow-lg active:scale-[0.98]";
  const variants: Record<string, string> = {
    green: active ? "bg-green-600 border-green-400 text-white shadow-green-600/30" : "bg-green-600/20 border-green-700/50 text-green-300 hover:bg-green-600/30",
    red: active ? "bg-red-600 border-red-400 text-white shadow-red-600/30" : "bg-red-600/20 border-red-700/50 text-red-300 hover:bg-red-600/30",
    blue: active ? "bg-blue-600 border-blue-400 text-white shadow-blue-600/30" : "bg-blue-600/20 border-blue-700/50 text-blue-300 hover:bg-blue-600/30",
    slate: active ? "bg-slate-600 border-slate-400 text-white" : "bg-slate-700/60 border-slate-600 text-slate-300 hover:bg-slate-700",
  };
  return (
    <button type="button" onClick={onClick} className={`${base} ${variants[variant]}`}>
      {icon}
      <span>{label}</span>
    </button>
  );
}
function MetricCard({ icon, value, label }: { icon: React.ReactNode; value: string; label: string; }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2 flex flex-col items-center text-center">
      <div className="mb-0.5">{icon}</div>
      <div className="text-sm font-bold text-white leading-tight">{value}</div>
      <div className="text-[9px] uppercase tracking-wide text-slate-400 mt-0.5">{label}</div>
    </div>
  );
}
function SensorRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string; }) {
  return (
    <li className="flex items-center justify-between px-3 py-1.5">
      <div className="flex items-center gap-2 text-xs text-slate-300">
        {icon}
        <span>{label}</span>
      </div>
      <span className="text-xs font-semibold text-white font-mono">{value}</span>
    </li>
  );
}
function AccessoryRow({ label, on }: { label: string; on: boolean }) {
  return (
    <div className="flex items-center justify-between px-1">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${on ? "bg-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.9)] animate-pulse" : "bg-slate-600"}`} />
        <span className="text-xs text-slate-200">{label}</span>
      </div>
      <span className={`text-[11px] font-semibold ${on ? "text-sky-400" : "text-slate-500"}`}>{on ? "Ligado" : "Desligado"}</span>
    </div>
  );
}

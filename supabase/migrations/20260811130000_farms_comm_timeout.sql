-- Timeout de comunicação configurável por fazenda ───────────────────────────
-- O equipamento só é considerado OFFLINE após ESTE tempo (em minutos) SEM
-- comunicação real (baseado em last_communication), NÃO após N falhas de polling.
-- Falhas momentâneas de RF (1–2 ciclos) não derrubam mais o card para "offline".
-- Este valor DEVE corresponder ao parâmetro de proteção configurado no PLC:
-- enquanto a plataforma espera este tempo, o PLC mantém o último estado com
-- autonomia local (proteção ativa). Default 15 min (comportamento atual).
--
-- Lido por:
--   • frontend  → src/hooks/useDashboardEquipment.ts (getEquipmentCommunicationStatus)
--   • backend   → supabase/functions/critical-alerts-tick (isStaleFor)
--   • agente    → electron-agent/main.cjs (boot + cada heartbeat; wasOfflineLong)
ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS comm_timeout_minutes integer NOT NULL DEFAULT 15;

COMMENT ON COLUMN public.farms.comm_timeout_minutes IS
  'Minutos sem comunicação antes de considerar um equipamento offline. Deve bater com o parâmetro de proteção do PLC. Default 15.';

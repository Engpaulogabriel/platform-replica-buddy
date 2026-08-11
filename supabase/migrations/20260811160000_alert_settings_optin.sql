-- Sistema inteligente de alertas — configurável por fazenda (opt-in) ─────────
-- Regras:
--   • Default = TUDO desativado. Nada sai até a fazenda ativar na aba "Alertas".
--   • Os alertas OBRIGATÓRIOS (AGENTE OFFLINE / BRIDGE MORTA) NÃO estão aqui —
--     são sempre enviados (1x) pelo agent-offline-watchdog e não podem ser
--     desativados.
--   • Colunas NOVAS (não reaproveita as antigas alert_*_enabled) para garantir
--     default OFF mesmo em fazendas com linhas legadas.
-- Lidas por: supabase/functions/whatsapp-alerts (gate opt-in + destinatários).
ALTER TABLE public.whatsapp_alert_settings
  ADD COLUMN IF NOT EXISTS alerts_master_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS alert_ligar_desligar  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS alert_sem_resposta    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS alert_com_restaurada  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS alert_pico            boolean NOT NULL DEFAULT false,
  -- admin | operators | all — quem recebe os tipos configuráveis (default: admin)
  ADD COLUMN IF NOT EXISTS alert_recipients      text    NOT NULL DEFAULT 'admin';

COMMENT ON COLUMN public.whatsapp_alert_settings.alerts_master_enabled IS
  'Chave-mestra por fazenda. Se false, NENHUM alerta configurável sai (obrigatórios agente/bridge seguem via watchdog).';
COMMENT ON COLUMN public.whatsapp_alert_settings.alert_recipients IS
  'Quem recebe os alertas configuráveis: admin | operators | all. Não afeta os obrigatórios.';

-- Garante 1 linha por fazenda (o painel faz upsert onConflict=farm_id).
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_alert_settings_farm_id_key
  ON public.whatsapp_alert_settings (farm_id);

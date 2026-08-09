-- Debounce ATÔMICO de notificações WhatsApp por equipamento ─────────────────
-- BUG: "POÇO 03 — LIGADO" foi enviado 6x em 2s. O trigger de estado dispara
-- múltiplas vezes (vários UPDATEs no equipamento) e o whatsapp-automation-notify
-- envia a cada chamada, sem dedup. Um dedup por consulta ao log tem RACE (os 6
-- disparos concorrentes checam antes de qualquer um logar → todos passam).
--
-- Solução race-proof: um "claim" ATÔMICO via UPDATE condicional. O lock de linha
-- do Postgres serializa os 6 disparos; só o PRIMEIRO satisfaz o WHERE e retorna
-- linha (claimed=true → envia). Os demais veem last_notification_sent_at já setado
-- (<60s, mesma chave) → 0 linhas → claimed=false → descartam. Chave = ação
-- (on/off), então um liga seguido de desliga dentro de 60s AINDA notifica (chave
-- diferente); só o MESMO evento repetido é bloqueado.

ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS last_notification_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_notification_key text;

CREATE OR REPLACE FUNCTION public.try_claim_equipment_notification(
  _equipment_id uuid,
  _key text,
  _window_seconds int DEFAULT 60
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_claimed boolean;
BEGIN
  UPDATE public.equipments
     SET last_notification_sent_at = now(),
         last_notification_key = _key
   WHERE id = _equipment_id
     AND (
       last_notification_sent_at IS NULL
       OR last_notification_sent_at < now() - make_interval(secs => _window_seconds)
       OR last_notification_key IS DISTINCT FROM _key
     )
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed, false);
END $$;

REVOKE ALL ON FUNCTION public.try_claim_equipment_notification(uuid, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.try_claim_equipment_notification(uuid, text, int) TO service_role, authenticated;

COMMENT ON FUNCTION public.try_claim_equipment_notification(uuid, text, int) IS
  'Debounce atômico de notificação por equipamento+ação. Retorna true se ESTE '
  'disparo deve enviar (ganhou o claim), false se é duplicata dentro da janela. '
  'Race-proof via UPDATE condicional (lock de linha). Ver whatsapp-automation-notify.';

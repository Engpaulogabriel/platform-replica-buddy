-- Keepalive do webhook do WhatsApp — mantém a Edge Function QUENTE p/ evitar cold start.
--
-- Problema: a Meta (WhatsApp Business API) exige 200 em <~5s. Depois de um cold
-- start da Edge Function, o 1º request demora mais que isso → a Meta marca o
-- webhook como falho e entra em backoff exponencial → as mensagens PARAM de
-- chegar (voltam quando algo "acorda" a função). Além da correção no código
-- (responder 200 imediato + processar em background via EdgeRuntime.waitUntil),
-- este cron pinga o fast-path GET ?health=1 (responde "warm" 200 SEM tocar no
-- banco) a cada 4 minutos, mantendo o isolate vivo.
--
-- Requer: pg_cron + pg_net (já habilitados neste projeto).
-- A função whatsapp-webhook tem verify_jwt=false → não precisa de Authorization.
-- OBS: a URL aponta pro projeto ANTIGO (dnyukgfedredvxpzjpqz). No cutover da
--      migração, troque o host pelo projeto NOVO.

-- Remove agendamento anterior (idempotente).
do $$
begin
  perform cron.unschedule('whatsapp-webhook-keepalive');
exception when others then
  null;
end $$;

select cron.schedule(
  'whatsapp-webhook-keepalive',
  '*/4 * * * *',
  $$
    select net.http_get(
      url := 'https://dnyukgfedredvxpzjpqz.supabase.co/functions/v1/whatsapp-webhook?health=1',
      timeout_milliseconds := 8000
    );
  $$
);

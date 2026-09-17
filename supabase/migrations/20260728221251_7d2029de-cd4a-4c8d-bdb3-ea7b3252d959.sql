-- 1) TABELAS
create table if not exists public.whatsapp_health_log (
  id               bigint generated always as identity primary key,
  checked_at       timestamptz not null default now(),
  status           text not null check (status in ('healthy','degraded','down','recovered')),
  subscription_ok  boolean,
  last_incoming_at timestamptz,
  last_outgoing_at timestamptz,
  action_taken     text,
  details          jsonb
);
create index if not exists idx_wa_health_log_checked_at on public.whatsapp_health_log (checked_at desc);

grant select on public.whatsapp_health_log to authenticated;
grant all on public.whatsapp_health_log to service_role;
alter table public.whatsapp_health_log enable row level security;
create policy "wa_health_log_platform_read" on public.whatsapp_health_log
  for select to authenticated using (public.is_platform_admin(auth.uid()));

create table if not exists public.whatsapp_webhook_monitor_state (
  id                int primary key default 1,
  phase             text not null default 'healthy'
                    check (phase in ('healthy','degraded','recovering','alerted')),
  down_strikes      int  not null default 0,
  recovery_attempts int  not null default 0,
  probe_req_id      bigint,
  probe_sent_at     timestamptz,
  last_recovery_at  timestamptz,
  last_healthy_at   timestamptz,
  updated_at        timestamptz not null default now(),
  constraint whatsapp_monitor_singleton check (id = 1)
);
insert into public.whatsapp_webhook_monitor_state (id) values (1) on conflict (id) do nothing;

grant select on public.whatsapp_webhook_monitor_state to authenticated;
grant all on public.whatsapp_webhook_monitor_state to service_role;
alter table public.whatsapp_webhook_monitor_state enable row level security;
create policy "wa_monitor_state_platform_read" on public.whatsapp_webhook_monitor_state
  for select to authenticated using (public.is_platform_admin(auth.uid()));

create table if not exists public.system_alerts (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  severity    text not null check (severity in ('info','warning','critical')),
  source      text,
  title       text,
  details     jsonb,
  resolved    boolean not null default false,
  resolved_at timestamptz
);
create index if not exists idx_system_alerts_unresolved
  on public.system_alerts (created_at desc) where not resolved;

grant select on public.system_alerts to authenticated;
grant all on public.system_alerts to service_role;
alter table public.system_alerts enable row level security;
create policy "system_alerts_platform_read" on public.system_alerts
  for select to authenticated using (public.is_platform_admin(auth.uid()));

-- 2) HELPERS
create or replace function public.wa_webhook_resubscribe()
returns void language plpgsql security definer set search_path = public as $fn$
declare v_token text;
begin
  select api_token into v_token from public.whatsapp_config where api_token is not null limit 1;
  if v_token is null then raise notice '[wa] sem api_token em whatsapp_config'; return; end if;
  perform net.http_post(
    url  := 'https://graph.facebook.com/v25.0/886881460645058/subscribed_apps',
    body := jsonb_build_object(
              'override_callback_uri','https://dnyukgfedredvxpzjpqz.supabase.co/functions/v1/whatsapp-webhook',
              'verify_token','renov_whatsapp_token_2026' ),
    headers := jsonb_build_object('Authorization','Bearer '||v_token,'Content-Type','application/json'),
    timeout_milliseconds := 8000
  );
end $fn$;

create or replace function public.wa_send_message(p_to text, p_body text)
returns void language plpgsql security definer set search_path = public as $fn$
declare v_token text;
begin
  select api_token into v_token from public.whatsapp_config where api_token is not null limit 1;
  if v_token is null then return; end if;
  perform net.http_post(
    url  := 'https://graph.facebook.com/v21.0/1122648170939922/messages',
    body := jsonb_build_object('messaging_product','whatsapp','to',p_to,'type','text',
                               'text', jsonb_build_object('body', p_body )),
    headers := jsonb_build_object('Authorization','Bearer '||v_token,'Content-Type','application/json'),
    timeout_milliseconds := 8000
  );
end $fn$;

-- 3) MONITOR MESTRE
create or replace function public.wa_webhook_monitor()
returns void language plpgsql security definer set search_path = public as $fn$
declare
  st          public.whatsapp_webhook_monitor_state%rowtype;
  v_code      int;
  v_content   text;
  v_ready     boolean := false;
  v_sub_ok    boolean := false;
  v_last_in   timestamptz;
  v_last_out  timestamptz;
  v_token     text;
  v_probe     bigint;
  v_action    text := null;
  v_slog      text := null;
begin
  select * into st from public.whatsapp_webhook_monitor_state where id = 1 for update;
  select max(created_at) into v_last_in  from public.whatsapp_message_log where direction = 'incoming';
  select max(created_at) into v_last_out from public.whatsapp_message_log where direction = 'outgoing';

  if st.probe_req_id is not null then
    select status_code, content into v_code, v_content
      from net._http_response where id = st.probe_req_id;
    if found then
      v_ready  := true;
      v_sub_ok := (v_code = 200 and coalesce(v_content,'' ) ilike '%override_callback_uri%');
      st.probe_req_id := null;
    elsif st.probe_sent_at < now() - interval '2 minutes' then
      st.probe_req_id := null;
    else
      return;
    end if;
  end if;

  if v_ready then
    if v_sub_ok then
      if st.phase <> 'healthy' then
        v_slog := 'recovered';
        v_action := 'assinatura OK — webhook recuperado (estava '||st.phase||')';
        update public.system_alerts set resolved = true, resolved_at = now()
          where source = 'whatsapp-webhook' and not resolved;
        if st.phase in ('recovering','alerted') then
          perform public.wa_send_message('5577999608294',
            E'\u2705 WhatsApp recuperado automaticamente às '||
            to_char(now() at time zone 'America/Bahia','DD/MM HH24:MI')||'.');
        end if;
      else
        v_slog := 'healthy';
      end if;
      st.phase := 'healthy'; st.down_strikes := 0; st.recovery_attempts := 0; st.last_healthy_at := now();
    else
      st.down_strikes := st.down_strikes + 1;
      if st.phase = 'healthy' and st.down_strikes < 2 then
        v_slog := 'degraded';
        v_action := 'assinatura ausente (strike '||st.down_strikes||'/2) — aguardando confirmação';
        st.phase := 'degraded';
      elsif st.recovery_attempts < 2 then
        perform public.wa_webhook_resubscribe();
        st.phase := 'recovering';
        st.recovery_attempts := st.recovery_attempts + 1;
        st.last_recovery_at := now();
        v_slog := 'down';
        v_action := 'QUEDA confirmada — re-inscrição disparada (tentativa '||st.recovery_attempts||'/2)';
      else
        if st.phase <> 'alerted' then
          insert into public.system_alerts(severity, source, title, details)
          values ('critical','whatsapp-webhook','CRÍTICO: WhatsApp webhook não recuperou',
            jsonb_build_object(
              'detected_at', now(), 'attempts', st.recovery_attempts,
              'last_incoming_at', v_last_in, 'last_outgoing_at', v_last_out,
              'ultimas_5', (select jsonb_agg(x) from (
                 select direction, phone, message_body, created_at
                   from public.whatsapp_message_log order by created_at desc limit 5) x)));
          perform public.wa_send_message('5577999608294',
            'CRITICO: webhook do WhatsApp NAO recuperou apos 2 tentativas automaticas ('||
            to_char(now() at time zone 'America/Bahia','DD/MM HH24:MI')||
            '). Ultima recebida: '||coalesce(to_char(v_last_in at time zone 'America/Bahia','DD/MM HH24:MI'),'?')||
            '. Verifique o Meta Dashboard.');
          v_action := 'ESGOTOU 2 tentativas — ALERTA CRITICO (system_alerts + WhatsApp)';
        elsif st.last_recovery_at is null or st.last_recovery_at < now() - interval '30 minutes' then
          perform public.wa_webhook_resubscribe();
          st.last_recovery_at := now();
          v_action := 'ainda fora — nova tentativa de re-inscrição (pós-alerta, a cada 30min)';
        else
          v_action := 'ainda fora — aguardando (alerta crítico já emitido)';
        end if;
        st.phase := 'alerted'; st.down_strikes := 0; v_slog := 'down';
      end if;
    end if;

    insert into public.whatsapp_health_log(
      status, subscription_ok, last_incoming_at, last_outgoing_at, action_taken, details)
    values (v_slog, v_sub_ok, v_last_in, v_last_out, v_action,
      jsonb_build_object('phase', st.phase, 'down_strikes', st.down_strikes,
                         'recovery_attempts', st.recovery_attempts, 'http_code', v_code ));
  end if;

  select api_token into v_token from public.whatsapp_config where api_token is not null limit 1;
  if v_token is not null then
    select net.http_get(
      url := 'https://graph.facebook.com/v25.0/886881460645058/subscribed_apps',
      headers := jsonb_build_object('Authorization','Bearer '||v_token ),
      timeout_milliseconds := 8000) into v_probe;
    st.probe_req_id := v_probe; st.probe_sent_at := now();
  end if;

  st.updated_at := now();
  update public.whatsapp_webhook_monitor_state set
    phase = st.phase, down_strikes = st.down_strikes, recovery_attempts = st.recovery_attempts,
    probe_req_id = st.probe_req_id, probe_sent_at = st.probe_sent_at,
    last_recovery_at = st.last_recovery_at, last_healthy_at = st.last_healthy_at, updated_at = st.updated_at
  where id = 1;

  delete from public.whatsapp_health_log where checked_at < now() - interval '30 days';
end $fn$;

-- 4) CRON — a cada 3 min
do $$ begin perform cron.unschedule('whatsapp-webhook-monitor'); exception when others then null; end $$;
select cron.schedule('whatsapp-webhook-monitor', '*/3 * * * *', $$ select public.wa_webhook_monitor(); $$);
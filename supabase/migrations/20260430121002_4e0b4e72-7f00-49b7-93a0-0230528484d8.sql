-- Bug 1: A constraint automation_log_remote_requires_user bloqueia inserts
-- vindos do agente/triggers quando origin='remote' mas user_id é NULL
-- (RX espontâneo, comandos sem created_by, etc).
-- A regra "Sistema vs Usuário" agora é resolvida via coluna actor_label
-- (preenchida pelo trigger set_automation_actor_label), tornando esta
-- constraint redundante e prejudicial à telemetria.

ALTER TABLE public.automation_log
  DROP CONSTRAINT IF EXISTS automation_log_remote_requires_user;
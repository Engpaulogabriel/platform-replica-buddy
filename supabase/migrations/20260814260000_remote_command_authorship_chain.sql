-- ============================================================================
-- CADEIA DE AUTORIA DO COMANDO REMOTO — a raiz do problema.
-- ----------------------------------------------------------------------------
-- Hoje o frontend insere direto em `commands` passando `created_by` que ELE
-- escolheu (src/lib/commandQueue.ts:236). Quem manda o comando decide quem é o
-- autor — é por isso que existe evento remoto sem nome real.
--
-- Esta migration:
--   1. cria a RPC `enqueue_remote_command()`, única porta de entrada, que tira
--      o usuário de auth.uid() e emite um command_id imutável ANTES de o
--      comando existir na fila;
--   2. grava o snapshot do perfil (nome/e-mail no instante do clique) em
--      command_audit, para a autoria não depender de `commands` nem de perfil
--      alterado depois;
--   3. na TRANSIÇÃO, força autoria server-side no caminho legado: o
--      `created_by` mandado pelo frontend é descartado e substituído por
--      auth.uid(), e a trilha é criada pelo próprio trigger. Nenhum comando
--      remoto fica sem autor, e nenhuma autoria vem do cliente.
--      O bloqueio DEFINITIVO do INSERT direto é a migration 20260814260100,
--      aplicada só depois da validação com comandos reais — assim Ligar e
--      Desligar nunca param.
--
-- Não altera relés, protocolo PLC, polling, bridge, rádio, Realtime, PumpCard,
-- manutenção, proteção de comutação, automações, FASE 2/3, OTA, energia,
-- INEMA nem WhatsApp. O frame e a fila continuam exatamente como estão.
-- ============================================================================

-- ── 1) Flag por fazenda, para transição observável e reversível ─────────────
-- ATENÇÃO: a flag NÃO libera comando sem autor. Ela só decide se o INSERT
-- direto ainda é aceito. Autoria completa é exigida nos DOIS caminhos.
-- Nasce FALSE de propósito: esta migration NÃO bloqueia nada. Ela instala a
-- RPC e passa a FORÇAR autoria server-side no caminho legado, para nenhum
-- comando ficar sem autor durante a transição. O bloqueio definitivo é a
-- migration 20260814260100, aplicada só depois da validação com comandos reais.
ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS command_rpc_enforced boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.farms.command_rpc_enforced IS
  'true = comando manual só entra pela RPC enqueue_remote_command (bloqueio definitivo). false = etapa de transição: INSERT direto ainda entra, mas com autoria FORÇADA de auth.uid() e trilha criada no servidor. Nunca aceita autoria vinda do frontend.';

-- ── 2) Idempotência ─────────────────────────────────────────────────────────
ALTER TABLE public.commands
  ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_commands_idempotency
  ON public.commands (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ── 3) A ÚNICA porta de entrada de comando remoto ───────────────────────────
CREATE OR REPLACE FUNCTION public.enqueue_remote_command(
  _equipment_id    uuid,
  _intent          text,           -- 'turn_on' | 'turn_off'
  _frame           text,
  _plc_hw_id       text DEFAULT NULL,
  _idempotency_key text DEFAULT NULL,
  _client_event_id uuid DEFAULT NULL,
  _source_device   text DEFAULT NULL,
  _timeout_ms      int  DEFAULT 120000
)
RETURNS TABLE (command_id uuid, actor_user_id uuid, actor_label text, actor_email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid   uuid := auth.uid();          -- AUTORIA VEM DAQUI. Nunca do frontend.
  v_farm  uuid; v_name text; v_email text; v_cmd uuid; v_existing uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'comando remoto exige usuário autenticado';
  END IF;
  IF _intent NOT IN ('turn_on','turn_off') THEN
    RAISE EXCEPTION 'intenção inválida: %', _intent;
  END IF;

  SELECT e.farm_id INTO v_farm FROM public.equipments e WHERE e.id = _equipment_id;
  IF v_farm IS NULL THEN RAISE EXCEPTION 'equipamento % não existe', _equipment_id; END IF;
  IF NOT public.has_farm_access(v_uid, v_farm) THEN
    RAISE EXCEPTION 'sem acesso a esta fazenda';
  END IF;

  -- Idempotência: repetir a mesma chave devolve o MESMO comando, não cria outro.
  IF _idempotency_key IS NOT NULL THEN
    SELECT c.id INTO v_existing FROM public.commands c
     WHERE c.idempotency_key = _idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN QUERY
        SELECT ca.command_id, ca.user_id, ca.actor_label, ca.user_email
          FROM public.command_audit ca WHERE ca.command_id = v_existing;
      RETURN;
    END IF;
  END IF;

  -- SNAPSHOT do perfil no instante do clique. Se a pessoa mudar de nome ou
  -- sair da plataforma depois, o relatório continua mostrando quem clicou.
  SELECT p.full_name, p.email INTO v_name, v_email
    FROM public.profiles p WHERE p.id = v_uid;
  IF COALESCE(btrim(v_name),'') = '' THEN
    v_name := COALESCE(NULLIF(btrim(v_email),''), NULL);
  END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'usuário % não tem perfil com nome ou e-mail — comando recusado', v_uid;
  END IF;

  v_cmd := gen_random_uuid();          -- command_id IMUTÁVEL, emitido aqui

  -- A trilha de autoria é gravada ANTES do comando entrar na fila. Se a
  -- inserção seguinte falhar, a transação inteira volta — nunca sobra comando
  -- sem autor, nem autor sem comando.
  INSERT INTO public.command_audit
    (command_id, client_event_id, farm_id, equipment_id, equipment_name,
     user_id, user_email, actor_label, origin_kind, intent, frame,
     source_device, status_final, command_created_at, details)
  SELECT v_cmd, _client_event_id, v_farm, _equipment_id, e.name,
         v_uid, v_email, v_name, 'panel', _intent, _frame,
         _source_device, 'pending', now(),
         jsonb_build_object('idempotency_key', _idempotency_key,
                            'authorship_source', 'command_audit',
                            'profile_snapshot', jsonb_build_object('full_name', v_name, 'email', v_email))
    FROM public.equipments e WHERE e.id = _equipment_id;

  -- Marca a transação como vinda da RPC, para o trigger de fecho reconhecer.
  PERFORM set_config('renov.command_rpc', v_cmd::text, true);

  INSERT INTO public.commands
    (id, farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms,
     created_by, client_event_id, source_device, idempotency_key)
  VALUES
    (v_cmd, v_farm, _equipment_id, _plc_hw_id, 'manual'::public.command_type, 1,
     _frame, COALESCE(_timeout_ms,120000), v_uid, _client_event_id,
     _source_device, _idempotency_key);

  RETURN QUERY SELECT v_cmd, v_uid, v_name, v_email;
END; $$;
GRANT EXECUTE ON FUNCTION public.enqueue_remote_command(uuid, text, text, text, text, uuid, text, int)
  TO authenticated, service_role;

-- ── 4) FECHO: comando manual sem autoria não entra, por caminho nenhum ──────
-- Não existe fallback inseguro. Mesmo com a flag desligada, `created_by` e a
-- linha em command_audit continuam obrigatórios.
CREATE OR REPLACE FUNCTION public.enforce_command_authorship()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rpc text; v_enforced boolean; v_src text; v_uid uuid; v_name text; v_email text;
BEGIN
  IF NEW.type <> 'manual'::public.command_type THEN RETURN NEW; END IF;

  -- Caminhos de máquina (agente, proteção, automação) não são comando de
  -- pessoa e seguem com as regras próprias já existentes.
  v_src := lower(COALESCE(NEW.source_device,''));
  IF COALESCE(NEW.priority,5) = 0
     OR v_src LIKE 'backend-reset%' OR v_src LIKE 'forced-shutdown%'
     OR v_src LIKE 'cloud-protective%' OR v_src LIKE 'safety%'
     OR v_src LIKE 'automation%' OR v_src LIKE 'scheduled%' THEN
    RETURN NEW;
  END IF;

  v_rpc := current_setting('renov.command_rpc', true);
  -- Veio da RPC: a autoria já foi gravada lá. Segue.
  IF v_rpc IS NOT NULL AND v_rpc = NEW.id::text THEN RETURN NEW; END IF;

  -- ── NÃO veio da RPC ──────────────────────────────────────────────────────
  SELECT f.command_rpc_enforced INTO v_enforced FROM public.farms f WHERE f.id = NEW.farm_id;

  IF COALESCE(v_enforced, false) THEN
    -- BLOQUEIO DEFINITIVO (ligado pela migration 20260814260100, após validação)
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'comando remoto deve ser criado por enqueue_remote_command (autoria server-side)',
      HINT    = 'command_rpc_required';
  END IF;

  -- ── TRANSIÇÃO: não recusa, mas a autoria NUNCA vem do frontend ───────────
  -- O created_by enviado pelo cliente é DESCARTADO e substituído por auth.uid().
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'comando remoto exige usuário autenticado';
  END IF;
  IF NEW.created_by IS DISTINCT FROM v_uid THEN
    -- silencioso e deliberado: o servidor é a autoridade sobre quem assinou
    NEW.created_by := v_uid;
  END IF;

  SELECT p.full_name, p.email INTO v_name, v_email
    FROM public.profiles p WHERE p.id = v_uid;
  v_name := COALESCE(NULLIF(btrim(v_name),''), NULLIF(btrim(v_email),''));
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'usuário % não tem perfil com nome ou e-mail — comando recusado', v_uid;
  END IF;

  -- Trilha criada no servidor, para o comando legado não ficar sem autoria.
  INSERT INTO public.command_audit
    (command_id, client_event_id, farm_id, equipment_id, equipment_name,
     user_id, user_email, actor_label, origin_kind, intent, frame,
     source_device, status_final, command_created_at, details)
  SELECT NEW.id, NEW.client_event_id, NEW.farm_id, NEW.equipment_id, e.name,
         v_uid, v_email, v_name, 'panel-legacy',
         CASE WHEN NEW.frame ~ '\{0*1\}' THEN 'turn_on' ELSE 'turn_off' END,
         NEW.frame, NEW.source_device, 'pending', now(),
         jsonb_build_object('authorship_source','command_audit',
                            'legacy_direct_insert', true,
                            'profile_snapshot', jsonb_build_object('full_name', v_name, 'email', v_email))
    FROM public.equipments e WHERE e.id = NEW.equipment_id
  ON CONFLICT (command_id) DO NOTHING;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_enforce_command_authorship ON public.commands;
CREATE TRIGGER trg_enforce_command_authorship
BEFORE INSERT ON public.commands
FOR EACH ROW EXECUTE FUNCTION public.enforce_command_authorship();

-- ── 5) command_id e autoria são IMUTÁVEIS depois de criados ─────────────────
CREATE OR REPLACE FUNCTION public.freeze_command_authorship()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'autoria do comando é imutável';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'command_id é imutável';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_freeze_command_authorship ON public.commands;
CREATE TRIGGER trg_freeze_command_authorship
BEFORE UPDATE ON public.commands
FOR EACH ROW EXECUTE FUNCTION public.freeze_command_authorship();

-- ── 6) Observabilidade da transição ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.command_authorship_health()
RETURNS TABLE (
  fazenda text, rpc_obrigatoria boolean,
  manuais_24h bigint, sem_autor bigint, sem_trilha bigint, sem_idempotencia bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT f.name, f.command_rpc_enforced,
         count(c.id),
         count(c.id) FILTER (WHERE c.created_by IS NULL),
         count(c.id) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM public.command_audit ca WHERE ca.command_id = c.id)),
         count(c.id) FILTER (WHERE c.idempotency_key IS NULL)
    FROM public.farms f
    LEFT JOIN public.commands c
      ON c.farm_id = f.id AND c.type = 'manual'::public.command_type
     AND c.created_at > now() - interval '24 hours'
   GROUP BY f.id, f.name, f.command_rpc_enforced
   ORDER BY f.name;
$$;
GRANT EXECUTE ON FUNCTION public.command_authorship_health() TO authenticated, service_role;

-- ============================================================================
-- VALIDAÇÃO
--   SELECT * FROM public.command_authorship_health();   -- sem_autor deve ser 0
--   -- tentativa de INSERT direto (deve FALHAR):
--   INSERT INTO public.commands (farm_id,equipment_id,type,frame)
--   VALUES ('<farm>','<equip>','manual','x');
-- ORDEM SEGURA (ver 20260814260100):
--   1. aplicar ESTA migration junto com o commandQueue já chamando a RPC;
--   2. validar command_id/actor_user_id/confirmação física com comandos reais;
--   3. só então aplicar 20260814260100, que liga o bloqueio definitivo.
-- ROLLBACK sem parar Ligar/Desligar:
--   UPDATE public.farms SET command_rpc_enforced = false;
--   -- volta à transição: INSERT direto entra, mas com autoria FORÇADA
--   -- server-side e trilha criada pelo trigger. Nunca sem autor.
-- ============================================================================

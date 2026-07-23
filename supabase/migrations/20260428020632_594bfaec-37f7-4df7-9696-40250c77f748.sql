
-- ============================================================================
-- FASE 1: SISTEMA DE LICENCIAMENTO ANTICLONE
-- ============================================================================

-- 1) Coluna license_status em farms (derivada)
ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS license_status text NOT NULL DEFAULT 'pending'
    CHECK (license_status IN ('active', 'suspended', 'pending'));

-- Trigger pra manter license_status sincronizado com license_key
CREATE OR REPLACE FUNCTION public.sync_farm_license_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.license_key IS NULL OR length(trim(NEW.license_key)) = 0 THEN
    NEW.license_status := 'suspended';
  ELSE
    -- Active só se já tem dispositivo vinculado, senão pending
    IF EXISTS (
      SELECT 1 FROM public.device_licenses
      WHERE farm_id = NEW.id AND revoked_at IS NULL
    ) THEN
      NEW.license_status := 'active';
    ELSE
      NEW.license_status := 'pending';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 2) Tabela device_licenses
CREATE TABLE IF NOT EXISTS public.device_licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  license_key text NOT NULL,
  machine_id_hash text NOT NULL,
  fingerprint jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_version text,
  ip_address text,
  activated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_reason text,
  current_token_jti uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Anticlone: cada license_key só pode estar ativa em UM hardware
  CONSTRAINT device_licenses_unique_active_key
    EXCLUDE (license_key WITH =) WHERE (revoked_at IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_device_licenses_farm ON public.device_licenses(farm_id);
CREATE INDEX IF NOT EXISTS idx_device_licenses_machine ON public.device_licenses(machine_id_hash);
CREATE INDEX IF NOT EXISTS idx_device_licenses_active
  ON public.device_licenses(farm_id) WHERE revoked_at IS NULL;

-- Trigger updated_at
CREATE TRIGGER trg_device_licenses_updated_at
  BEFORE UPDATE ON public.device_licenses
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Agora que a tabela existe, criar o trigger de sync em farms
DROP TRIGGER IF EXISTS trg_farms_sync_license_status ON public.farms;
CREATE TRIGGER trg_farms_sync_license_status
  BEFORE INSERT OR UPDATE OF license_key ON public.farms
  FOR EACH ROW EXECUTE FUNCTION public.sync_farm_license_status();

-- Trigger inverso: quando vincula/revoga device, atualiza farm.license_status
CREATE OR REPLACE FUNCTION public.refresh_farm_status_on_device_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_farm_id uuid;
  v_has_active boolean;
  v_has_key boolean;
BEGIN
  v_farm_id := COALESCE(NEW.farm_id, OLD.farm_id);
  
  SELECT EXISTS(
    SELECT 1 FROM public.device_licenses
    WHERE farm_id = v_farm_id AND revoked_at IS NULL
  ) INTO v_has_active;
  
  SELECT (license_key IS NOT NULL AND length(trim(license_key)) > 0)
  INTO v_has_key
  FROM public.farms WHERE id = v_farm_id;
  
  UPDATE public.farms
  SET license_status = CASE
    WHEN NOT v_has_key THEN 'suspended'
    WHEN v_has_active THEN 'active'
    ELSE 'pending'
  END,
  updated_at = now()
  WHERE id = v_farm_id;
  
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_device_license_refresh_farm
  AFTER INSERT OR UPDATE OR DELETE ON public.device_licenses
  FOR EACH ROW EXECUTE FUNCTION public.refresh_farm_status_on_device_change();

-- 3) RLS — só Platform Staff vê
ALTER TABLE public.device_licenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY device_licenses_select_platform_staff
  ON public.device_licenses FOR SELECT TO authenticated
  USING (public.is_platform_staff(auth.uid()));

CREATE POLICY device_licenses_select_farm_owner
  ON public.device_licenses FOR SELECT TO authenticated
  USING (public.has_farm_role(auth.uid(), farm_id, 'owner'::app_role));

-- Inserts/updates só via funções SECURITY DEFINER (negar tudo direto)

-- 4) Função pública chamada pela edge function license-activate
-- Implementa o ANTICLONE: rejeita se a chave já está vinculada a outro hardware
CREATE OR REPLACE FUNCTION public.license_register_device(
  _license_key text,
  _machine_id_hash text,
  _fingerprint jsonb DEFAULT '{}'::jsonb,
  _agent_version text DEFAULT NULL,
  _ip_address text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_farm_id uuid;
  v_existing RECORD;
  v_device_id uuid;
  v_token_jti uuid := gen_random_uuid();
BEGIN
  IF _license_key IS NULL OR length(trim(_license_key)) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_license_key');
  END IF;
  IF _machine_id_hash IS NULL OR length(_machine_id_hash) < 16 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_machine_id');
  END IF;

  -- Localiza a fazenda dona da chave
  SELECT id INTO v_farm_id
  FROM public.farms
  WHERE license_key = _license_key
  LIMIT 1;

  IF v_farm_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'license_not_found');
  END IF;

  -- Verifica se já existe device ativo pra essa chave
  SELECT * INTO v_existing
  FROM public.device_licenses
  WHERE license_key = _license_key
    AND revoked_at IS NULL
  LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    -- Mesmo hardware reativando? OK, retorna o existente atualizado
    IF v_existing.machine_id_hash = _machine_id_hash THEN
      UPDATE public.device_licenses
      SET last_seen_at = now(),
          fingerprint = _fingerprint,
          agent_version = COALESCE(_agent_version, agent_version),
          ip_address = COALESCE(_ip_address, ip_address),
          current_token_jti = v_token_jti
      WHERE id = v_existing.id;
      
      RETURN jsonb_build_object(
        'ok', true,
        'device_id', v_existing.id,
        'farm_id', v_farm_id,
        'token_jti', v_token_jti,
        'reactivated', true
      );
    ELSE
      -- ANTICLONE: outro hardware tentando usar a mesma chave
      INSERT INTO public.agent_logs (farm_id, level, category, message)
      VALUES (
        v_farm_id, 'error', 'security',
        format('TENTATIVA DE CLONE BLOQUEADA: chave de licença usada em hardware diferente. Hash original=%s, tentativa=%s',
          left(v_existing.machine_id_hash, 12), left(_machine_id_hash, 12))
      );
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'license_already_bound',
        'message', 'Esta chave já está ativa em outro computador. Entre em contato com a Renov para desvincular.'
      );
    END IF;
  END IF;

  -- Verifica suspensão
  IF EXISTS (SELECT 1 FROM public.farms WHERE id = v_farm_id AND license_status = 'suspended') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'farm_suspended');
  END IF;

  -- Primeira ativação — cria registro
  INSERT INTO public.device_licenses (
    farm_id, license_key, machine_id_hash, fingerprint,
    agent_version, ip_address, current_token_jti
  )
  VALUES (
    v_farm_id, _license_key, _machine_id_hash, _fingerprint,
    _agent_version, _ip_address, v_token_jti
  )
  RETURNING id INTO v_device_id;

  RETURN jsonb_build_object(
    'ok', true,
    'device_id', v_device_id,
    'farm_id', v_farm_id,
    'token_jti', v_token_jti,
    'reactivated', false
  );
END $$;

-- 5) Heartbeat — chamada de hora em hora pelo Electron
CREATE OR REPLACE FUNCTION public.license_touch_heartbeat(
  _device_id uuid,
  _machine_id_hash text,
  _agent_version text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dev RECORD;
  v_farm_status text;
  v_new_jti uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v_dev FROM public.device_licenses WHERE id = _device_id LIMIT 1;
  
  IF v_dev.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'device_not_found', 'action', 'reactivate');
  END IF;
  
  IF v_dev.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'device_revoked',
      'reason', v_dev.revoked_reason, 'action', 'block');
  END IF;
  
  IF v_dev.machine_id_hash <> _machine_id_hash THEN
    -- Tentativa de uso do token em outra máquina
    INSERT INTO public.agent_logs (farm_id, level, category, message)
    VALUES (v_dev.farm_id, 'error', 'security',
      'Heartbeat de hardware diferente do registrado — token rejeitado');
    RETURN jsonb_build_object('ok', false, 'error', 'machine_mismatch', 'action', 'block');
  END IF;
  
  SELECT license_status INTO v_farm_status FROM public.farms WHERE id = v_dev.farm_id;
  IF v_farm_status = 'suspended' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'farm_suspended', 'action', 'block');
  END IF;
  
  UPDATE public.device_licenses
  SET last_seen_at = now(),
      agent_version = COALESCE(_agent_version, agent_version),
      current_token_jti = v_new_jti
  WHERE id = _device_id;
  
  RETURN jsonb_build_object(
    'ok', true,
    'device_id', _device_id,
    'farm_id', v_dev.farm_id,
    'token_jti', v_new_jti
  );
END $$;

-- 6) RPCs administrativas
CREATE OR REPLACE FUNCTION public.platform_unbind_device(_device_id uuid, _reason text DEFAULT 'admin_unbind')
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  UPDATE public.device_licenses
  SET revoked_at = now(), revoked_reason = _reason
  WHERE id = _device_id AND revoked_at IS NULL;
END $$;

CREATE OR REPLACE FUNCTION public.platform_get_devices_overview()
RETURNS TABLE (
  device_id uuid, farm_id uuid, farm_name text,
  machine_id_hash text, agent_version text, ip_address text,
  activated_at timestamptz, last_seen_at timestamptz,
  revoked_at timestamptz, revoked_reason text,
  fingerprint jsonb,
  is_online boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  RETURN QUERY
  SELECT d.id, d.farm_id, f.name,
         d.machine_id_hash, d.agent_version, d.ip_address,
         d.activated_at, d.last_seen_at,
         d.revoked_at, d.revoked_reason, d.fingerprint,
         (d.revoked_at IS NULL AND d.last_seen_at > now() - interval '2 hours')
  FROM public.device_licenses d
  JOIN public.farms f ON f.id = d.farm_id
  ORDER BY d.last_seen_at DESC NULLS LAST;
END $$;

-- Sincroniza license_status atual de todas as farms já existentes
UPDATE public.farms SET license_key = license_key;

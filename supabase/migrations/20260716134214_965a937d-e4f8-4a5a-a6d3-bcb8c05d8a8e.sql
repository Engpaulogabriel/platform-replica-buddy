
ALTER TABLE public.farms ADD COLUMN IF NOT EXISTS max_devices integer DEFAULT NULL;
COMMENT ON COLUMN public.farms.max_devices IS 'Máximo de dispositivos Electron permitidos para esta fazenda. NULL/0 = ilimitado.';

DROP FUNCTION IF EXISTS public.license_register_device(text,text,jsonb,text,text);

CREATE FUNCTION public.license_register_device(
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
  v_max int;
  v_active_count int;
BEGIN
  IF _license_key IS NULL OR length(trim(_license_key)) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_license_key');
  END IF;
  IF _machine_id_hash IS NULL OR length(_machine_id_hash) < 16 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_machine_id');
  END IF;

  SELECT id, max_devices INTO v_farm_id, v_max
  FROM public.farms
  WHERE license_key = _license_key
  LIMIT 1;

  IF v_farm_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'license_not_found');
  END IF;

  SELECT * INTO v_existing
  FROM public.device_licenses
  WHERE license_key = _license_key
    AND revoked_at IS NULL
  LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
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

  IF EXISTS (SELECT 1 FROM public.farms WHERE id = v_farm_id AND license_status = 'suspended') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'farm_suspended');
  END IF;

  IF v_max IS NOT NULL AND v_max > 0 THEN
    SELECT count(*) INTO v_active_count
    FROM public.device_licenses
    WHERE farm_id = v_farm_id AND revoked_at IS NULL;

    IF v_active_count >= v_max THEN
      INSERT INTO public.agent_logs (farm_id, level, category, message)
      VALUES (
        v_farm_id, 'warn', 'security',
        format('Registro de dispositivo bloqueado: limite de %s dispositivo(s) atingido para esta fazenda.', v_max)
      );
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'farm_device_limit_reached',
        'message', format('Limite de dispositivos atingido para esta fazenda (máx %s).', v_max)
      );
    END IF;
  END IF;

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

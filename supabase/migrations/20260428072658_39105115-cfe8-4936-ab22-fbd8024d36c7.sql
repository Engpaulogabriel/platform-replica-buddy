-- Substitui política farms_update_owner para impedir alteração de campos sensíveis.
-- Owner só pode editar: name, city, state, timezone.
-- license_key, license_status, plan, modules, is_demo => apenas platform_admin.

DROP POLICY IF EXISTS farms_update_owner ON public.farms;

-- Trigger que valida que owner não alterou colunas protegidas
CREATE OR REPLACE FUNCTION public.farms_protect_sensitive_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Se é platform_admin OU service_role, libera tudo
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF public.is_platform_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  -- Owner: bloqueia mudanças em campos sensíveis
  IF NEW.license_key IS DISTINCT FROM OLD.license_key THEN
    RAISE EXCEPTION 'forbidden: owner não pode alterar license_key';
  END IF;
  IF NEW.license_status IS DISTINCT FROM OLD.license_status THEN
    RAISE EXCEPTION 'forbidden: owner não pode alterar license_status';
  END IF;
  IF NEW.plan IS DISTINCT FROM OLD.plan THEN
    RAISE EXCEPTION 'forbidden: owner não pode alterar plan';
  END IF;
  IF NEW.modules IS DISTINCT FROM OLD.modules THEN
    RAISE EXCEPTION 'forbidden: owner não pode alterar modules';
  END IF;
  IF NEW.is_demo IS DISTINCT FROM OLD.is_demo THEN
    RAISE EXCEPTION 'forbidden: owner não pode alterar is_demo';
  END IF;
  -- id e timestamps também imutáveis para owner
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'forbidden: id imutável';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_farms_protect_sensitive ON public.farms;
CREATE TRIGGER trg_farms_protect_sensitive
  BEFORE UPDATE ON public.farms
  FOR EACH ROW
  EXECUTE FUNCTION public.farms_protect_sensitive_fields();

-- Recria política do owner com WITH CHECK explícito
CREATE POLICY farms_update_owner ON public.farms
  FOR UPDATE
  TO authenticated
  USING (has_farm_role(auth.uid(), id, 'owner'::app_role))
  WITH CHECK (has_farm_role(auth.uid(), id, 'owner'::app_role));
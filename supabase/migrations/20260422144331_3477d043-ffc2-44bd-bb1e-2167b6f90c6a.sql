-- Trigger que impede alteração de qualquer coluna que não seja telemetria
CREATE OR REPLACE FUNCTION public.equipments_writer_telemetry_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Se o usuário é admin/owner da fazenda, libera alteração total
  IF public.is_farm_admin(auth.uid(), NEW.farm_id) THEN
    RETURN NEW;
  END IF;

  -- Caso contrário (operator), só pode atualizar colunas de telemetria
  IF NEW.farm_id IS DISTINCT FROM OLD.farm_id
     OR NEW.hw_id IS DISTINCT FROM OLD.hw_id
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.latitude IS DISTINCT FROM OLD.latitude
     OR NEW.longitude IS DISTINCT FROM OLD.longitude
     OR NEW.max_height IS DISTINCT FROM OLD.max_height
     OR NEW.alarm_low IS DISTINCT FROM OLD.alarm_low
     OR NEW.alarm_high IS DISTINCT FROM OLD.alarm_high
     OR NEW.sector_id IS DISTINCT FROM OLD.sector_id
     OR NEW.plc_group_id IS DISTINCT FROM OLD.plc_group_id
     OR NEW.active IS DISTINCT FROM OLD.active
     OR NEW.firmware_version IS DISTINCT FROM OLD.firmware_version
     OR NEW.saida IS DISTINCT FROM OLD.saida
     OR NEW.horas_pico IS DISTINCT FROM OLD.horas_pico
     OR NEW.max_horas_dia IS DISTINCT FROM OLD.max_horas_dia
     OR NEW.demanda_kw IS DISTINCT FROM OLD.demanda_kw
     OR NEW.fonte_tipo IS DISTINCT FROM OLD.fonte_tipo
     OR NEW.alimenta_id IS DISTINCT FROM OLD.alimenta_id
     OR NEW.polling_interval_seconds IS DISTINCT FROM OLD.polling_interval_seconds
  THEN
    RAISE EXCEPTION 'operator pode atualizar apenas campos de telemetria do equipamento';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS equipments_writer_telemetry_only_trg ON public.equipments;
CREATE TRIGGER equipments_writer_telemetry_only_trg
BEFORE UPDATE ON public.equipments
FOR EACH ROW
EXECUTE FUNCTION public.equipments_writer_telemetry_only();

-- Policy permitindo UPDATE para qualquer escritor da fazenda (operator/admin/owner).
-- O trigger acima garante que operator só consegue mexer em campos de telemetria.
CREATE POLICY equipments_writer_telemetry_update
ON public.equipments
FOR UPDATE
TO authenticated
USING (public.can_write_farm(auth.uid(), farm_id))
WITH CHECK (public.can_write_farm(auth.uid(), farm_id));
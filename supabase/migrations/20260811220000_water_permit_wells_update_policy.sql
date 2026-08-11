-- Vínculo poço↔equipamento (water_permit_wells.equipment_id) precisa de UPDATE.
-- A tabela foi criada só com SELECT + INSERT — sem policy de UPDATE, a RLS bloqueia
-- o UPDATE mesmo com o GRANT. Adiciona a policy (mesmo estilo permissivo das demais
-- policies desta tabela). GRANT UPDATE já foi concedido na criação.
DROP POLICY IF EXISTS water_permit_wells_update ON public.water_permit_wells;
CREATE POLICY water_permit_wells_update ON public.water_permit_wells
  FOR UPDATE USING (true) WITH CHECK (true);

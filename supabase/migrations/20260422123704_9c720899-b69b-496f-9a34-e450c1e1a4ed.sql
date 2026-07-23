
-- Substitui a política de UPDATE em commands para permitir operadores
DROP POLICY IF EXISTS commands_update_admin ON public.commands;

CREATE POLICY commands_update_writers
  ON public.commands
  FOR UPDATE
  TO authenticated
  USING (can_write_farm(auth.uid(), farm_id))
  WITH CHECK (can_write_farm(auth.uid(), farm_id));

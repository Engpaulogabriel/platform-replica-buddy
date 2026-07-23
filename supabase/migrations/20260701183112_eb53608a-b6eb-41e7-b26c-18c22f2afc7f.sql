
ALTER TABLE public.master_managers
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT true;

-- Gestores já existentes não devem ser bloqueados retroativamente
UPDATE public.master_managers SET must_change_password = false WHERE created_at < now();

-- Permite ao próprio Gestor Master zerar a flag após trocar a senha
DROP POLICY IF EXISTS "Master manager can clear own must_change_password" ON public.master_managers;
CREATE POLICY "Master manager can clear own must_change_password"
  ON public.master_managers
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

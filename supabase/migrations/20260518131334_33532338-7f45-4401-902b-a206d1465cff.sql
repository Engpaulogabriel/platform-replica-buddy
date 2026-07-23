-- Migrar papéis legados conforme decisão do usuário:
-- admin → owner (Administrador)
-- viewer → operator (Operador)
-- Trata conflito de UNIQUE (user_id, farm_id) deletando duplicatas após
UPDATE public.user_roles ur
SET role = 'owner'::app_role
WHERE role = 'admin'::app_role
  AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur2
    WHERE ur2.user_id = ur.user_id
      AND ur2.farm_id = ur.farm_id
      AND ur2.role = 'owner'::app_role
  );

-- Se já existia owner para o mesmo (user, farm), o admin vira redundante e é removido
DELETE FROM public.user_roles WHERE role = 'admin'::app_role;

UPDATE public.user_roles ur
SET role = 'operator'::app_role
WHERE role = 'viewer'::app_role
  AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur2
    WHERE ur2.user_id = ur.user_id
      AND ur2.farm_id = ur.farm_id
      AND ur2.role IN ('owner','supervisor','operator')
  );

DELETE FROM public.user_roles WHERE role = 'viewer'::app_role;
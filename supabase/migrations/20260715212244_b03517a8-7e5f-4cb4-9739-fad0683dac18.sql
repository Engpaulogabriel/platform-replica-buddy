SET LOCAL session_replication_role = replica;
UPDATE public.equipments SET hw_id='121901', updated_at=now() WHERE id='78b60bef-4b0e-419f-a651-2a5f76c53e24';
DELETE FROM public.plc_groups WHERE id='105c6178-d28a-4102-9221-7860097efb12';
SET LOCAL session_replication_role = origin;
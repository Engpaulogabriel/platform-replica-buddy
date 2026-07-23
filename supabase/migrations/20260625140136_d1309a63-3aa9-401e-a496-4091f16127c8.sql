
ALTER TABLE public.farms
  ALTER COLUMN modules SET DEFAULT
    jsonb_build_object(
      'vazao', false,
      'consumo', false,
      'ai_whatsapp', false,
      'energia', false,
      'vazao_consumo', false,
      'niveis', false
    );

ALTER TABLE public.farms DISABLE TRIGGER USER;

UPDATE public.farms
  SET modules = COALESCE(modules, '{}'::jsonb)
                || jsonb_build_object(
                     'energia',       COALESCE(modules->'energia', 'true'::jsonb),
                     'vazao_consumo', COALESCE(modules->'vazao_consumo', 'true'::jsonb),
                     'niveis',        COALESCE(modules->'niveis', 'true'::jsonb)
                   );

ALTER TABLE public.farms ENABLE TRIGGER USER;

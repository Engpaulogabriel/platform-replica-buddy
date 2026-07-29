-- Localização da sede da fazenda (para o mapa Início → Mapa junto com os poços).
-- Aplicar no SQL Editor.
ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS latitude_sede  double precision,
  ADD COLUMN IF NOT EXISTS longitude_sede double precision;

COMMENT ON COLUMN public.farms.latitude_sede  IS 'Latitude da sede da fazenda (marcador no mapa).';
COMMENT ON COLUMN public.farms.longitude_sede IS 'Longitude da sede da fazenda (marcador no mapa).';

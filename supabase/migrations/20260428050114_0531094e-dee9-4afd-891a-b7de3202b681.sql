ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS rf_radio text,
  ADD COLUMN IF NOT EXISTS rf_via_rep boolean;

COMMENT ON COLUMN public.equipments.rf_radio IS 'Override por equipamento do rádio do Servidor (R1/R2/R3). NULL = usa o roteamento global da fazenda (rf_routing).';
COMMENT ON COLUMN public.equipments.rf_via_rep IS 'Override por equipamento de via repetidor. NULL = usa o roteamento global da fazenda (rf_routing).';

ALTER TABLE public.equipments
  ADD CONSTRAINT equipments_rf_radio_chk
  CHECK (rf_radio IS NULL OR rf_radio IN ('R1','R2','R3'));
ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS last_signal_bars smallint
    CHECK (last_signal_bars IS NULL OR (last_signal_bars >= 0 AND last_signal_bars <= 4));
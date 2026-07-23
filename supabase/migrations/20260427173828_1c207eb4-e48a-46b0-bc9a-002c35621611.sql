
UPDATE public.commands
SET status = 'cancelled',
    responded_at = now(),
    error_message = 'Cancelado para regerar no formato correto de payload (poço={X}, PLC={XXXXXX})'
WHERE status IN ('pending', 'sent')
  AND type = 'polling';

-- Força próximo polling imediato
UPDATE public.equipments
SET last_polling_at = NULL
WHERE active = true
  AND type IN ('poco', 'bombeamento');

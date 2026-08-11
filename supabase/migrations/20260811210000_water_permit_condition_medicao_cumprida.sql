-- A condicionante "Não captar até sistema de medição instalado" já foi CUMPRIDA
-- (o sistema de medição está instalado e as fazendas estão operando). Marca como
-- cumprida — deixa de aparecer como pendente/crítica no relatório.
UPDATE public.water_permit_conditions
   SET status = 'cumprida'
 WHERE description ILIKE '%sistema de medição%'
   AND status = 'pendente';

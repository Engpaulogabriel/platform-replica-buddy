-- Vazão dos poços da Semear = 300 m³/h (sem exceção).
-- O relatório Monitoramento (Relatórios → INEMA → Monitoramento, componente
-- InemaReport.tsx) lê a coluna "Vazão" de equipments.estimated_flow_m3h
-- (InemaReport.tsx:78 select + :115 flow = estimated_flow_m3h).
--   • Corrige os poços que mostravam 450.
--   • Preenche os que estavam NULL (09 R4, 10 R4, 11 R4 → apareciam "N/D"/"—").
UPDATE public.equipments
   SET estimated_flow_m3h = 300
 WHERE farm_id IN (SELECT id FROM public.farms WHERE name ILIKE '%semear%')
   AND type = 'poco'
   AND (estimated_flow_m3h IS DISTINCT FROM 300);

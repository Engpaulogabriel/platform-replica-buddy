-- FASE B.3 — TRAVA FUTURA + VALIDAÇÃO GLOBAL DE ACEITE.
CREATE OR REPLACE FUNCTION public.guard_official_report_row()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_intent text;
BEGIN
  IF NEW.noise_reason IS NOT NULL THEN RETURN NEW; END IF;

  IF NEW.action NOT IN ('turn_on','turn_off','pump_on','pump_off') THEN
    NEW.noise_reason := 'technical_not_a_transition'; RETURN NEW;
  END IF;
  IF NEW.origin = 'reading'::public.event_origin THEN
    NEW.noise_reason := 'technical_not_a_transition'; RETURN NEW;
  END IF;

  IF NEW.equipment_id IS NULL THEN
    NEW.noise_reason := 'no_equipment'; RETURN NEW;
  END IF;
  IF NEW.result IS DISTINCT FROM 'success'::public.event_result
     AND COALESCE(NEW.details->>'state_confirmed','') <> 'true' THEN
    NEW.noise_reason := 'command_not_confirmed'; RETURN NEW;
  END IF;

  IF NEW.origin = 'system'::public.event_origin THEN
    NEW.noise_reason := 'pending_authorship_review'; RETURN NEW;
  END IF;

  IF public.is_technical_actor_label(NEW.actor_label)
     OR lower(btrim(COALESCE(NEW.actor_label,''))) IN
        ('autoria histórica em revisão','comando remoto','em apuração',
         'origem em apuração','remoto não identificado','não identificado') THEN
    NEW.noise_reason := 'pending_authorship_review'; RETURN NEW;
  END IF;

  IF NEW.origin = 'remote'::public.event_origin
     AND (NEW.user_id IS NULL OR COALESCE(btrim(NEW.user_email),'') = ''
          OR COALESCE(btrim(NEW.actor_label),'') = '') THEN
    NEW.noise_reason := 'pending_authorship_review'; RETURN NEW;
  END IF;

  IF NEW.origin = 'auto'::public.event_origin
     AND COALESCE(btrim(NEW.actor_label),'') = '' THEN
    NEW.noise_reason := 'pending_authorship_review'; RETURN NEW;
  END IF;

  IF NEW.origin = 'local'::public.event_origin THEN
    v_intent := CASE WHEN NEW.action IN ('turn_on','pump_on') THEN 'turn_on' ELSE 'turn_off' END;
    IF EXISTS (SELECT 1 FROM public.command_audit ca
                WHERE ca.equipment_id = NEW.equipment_id
                  AND ca.user_id IS NOT NULL AND ca.intent = v_intent
                  AND ca.command_created_at BETWEEN NEW.occurred_at - interval '180 seconds'
                                                AND NEW.occurred_at + interval '180 seconds') THEN
      NEW.noise_reason := 'pending_authorship_review'; RETURN NEW;
    END IF;
  END IF;

  RETURN NEW;
END; $fn$;

DROP TRIGGER IF EXISTS trg_z_guard_official_report ON public.automation_log;
CREATE TRIGGER trg_z_guard_official_report
BEFORE INSERT ON public.automation_log
FOR EACH ROW EXECUTE FUNCTION public.guard_official_report_row();

CREATE OR REPLACE FUNCTION public.phase_b_acceptance()
RETURNS TABLE (criterio text, violacoes bigint, situacao text, fazendas text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
WITH k AS (
  SELECT * FROM (VALUES
    ('1. origem indefinida/system',            'A_origem_indefinida'),
    ('2. usuário técnico/genérico',            'B_usuario_tecnico'),
    ('3. remoto sem autoria humana',           'C_remoto_sem_autor'),
    ('4. Local com comando remoto compatível', 'D_local_com_comando'),
    ('5. automação sem regra',                 'E_auto_sem_regra'),
    ('6. técnico/polling/reading no oficial',  'F_tecnico'),
    ('7. sem prova física (falha/timeout)',    'G_sem_prova')
  ) v(nome, cat)
)
SELECT k.nome, count(c.id),
       CASE WHEN count(c.id) = 0 THEN 'PASSOU' ELSE 'REPROVADO' END,
       COALESCE(string_agg(DISTINCT f.name, ', '), '—')
  FROM k
  LEFT JOIN public.automation_row_classified c ON c.issue = k.cat
  LEFT JOIN public.farms f ON f.id = c.farm_id
 GROUP BY k.nome
UNION ALL
SELECT '8. textos proibidos no oficial', count(*),
       CASE WHEN count(*) = 0 THEN 'PASSOU' ELSE 'REPROVADO' END,
       COALESCE(string_agg(DISTINCT f.name, ', '), '—')
  FROM public.automation_log al LEFT JOIN public.farms f ON f.id = al.farm_id
 WHERE al.noise_reason IS NULL
   AND lower(COALESCE(al.actor_label,'')) ~
       '(origem em apuração|autoria histórica em revisão|sistema|comando remoto|telemetria rf|^rf$|bridge|serial)'
 ORDER BY 1;
$fn$;
GRANT EXECUTE ON FUNCTION public.phase_b_acceptance() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.phase_b_impact_report(_run_id uuid DEFAULT NULL)
RETURNS TABLE (
  fazenda text, total_antes bigint, ruido_tecnico bigint, reclassificados bigint,
  enviados_fila bigint, total_final bigint, pendencias_admin bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
SELECT f.name,
  count(al.id) FILTER (WHERE al.action IN ('turn_on','turn_off','pump_on','pump_off')),
  count(DISTINCT a.event_id) FILTER (WHERE a.action = 'noise_marked'),
  count(DISTINCT a.event_id) FILTER (WHERE a.action IN ('origin_changed','authorship_set')),
  count(DISTINCT a.event_id) FILTER (WHERE a.action = 'queued'),
  count(al.id) FILTER (WHERE al.noise_reason IS NULL
                         AND al.action IN ('turn_on','turn_off','pump_on','pump_off')),
  count(DISTINCT pr.id) FILTER (WHERE pr.resolved_at IS NULL)
FROM public.farms f
LEFT JOIN public.automation_log al ON al.farm_id = f.id
LEFT JOIN public.automation_cleanup_audit a
       ON a.farm_id = f.id AND (_run_id IS NULL OR a.run_id = _run_id)
LEFT JOIN public.authorship_pending_review pr ON pr.farm_id = f.id
GROUP BY f.id, f.name ORDER BY f.name;
$fn$;
GRANT EXECUTE ON FUNCTION public.phase_b_impact_report(uuid) TO authenticated, service_role;
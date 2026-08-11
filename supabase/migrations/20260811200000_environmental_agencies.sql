-- Órgão ambiental responsável pela outorga POR ESTADO (INEMA só na Bahia).
-- Referência usada pelo Relatório de Monitoramento para nomear o órgão correto.
CREATE TABLE IF NOT EXISTS public.environmental_agencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_code char(2) NOT NULL UNIQUE,
  state_name text NOT NULL,
  agency_name text NOT NULL,
  agency_acronym text NOT NULL,
  agency_website text,
  report_format text DEFAULT 'padrao',
  notes text
);

ALTER TABLE public.environmental_agencies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS environmental_agencies_select ON public.environmental_agencies;
CREATE POLICY environmental_agencies_select ON public.environmental_agencies
  FOR SELECT TO authenticated USING (true); -- tabela de referência pública (sem PII)
GRANT SELECT ON public.environmental_agencies TO authenticated;

INSERT INTO public.environmental_agencies (state_code, state_name, agency_name, agency_acronym) VALUES
('BA', 'Bahia', 'Instituto do Meio Ambiente e Recursos Hídricos', 'INEMA'),
('GO', 'Goiás', 'Secretaria de Estado de Meio Ambiente e Desenvolvimento Sustentável', 'SEMAD'),
('MG', 'Minas Gerais', 'Instituto Mineiro de Gestão das Águas', 'IGAM'),
('SP', 'São Paulo', 'Departamento de Águas e Energia Elétrica', 'DAEE'),
('MT', 'Mato Grosso', 'Secretaria de Estado de Meio Ambiente', 'SEMA'),
('MS', 'Mato Grosso do Sul', 'Instituto de Meio Ambiente de Mato Grosso do Sul', 'IMASUL'),
('TO', 'Tocantins', 'Instituto Natureza do Tocantins', 'NATURATINS'),
('MA', 'Maranhão', 'Secretaria de Estado de Meio Ambiente e Recursos Naturais', 'SEMA'),
('PI', 'Piauí', 'Secretaria Estadual de Meio Ambiente e Recursos Hídricos', 'SEMAR'),
('PE', 'Pernambuco', 'Agência Pernambucana de Águas e Clima', 'APAC'),
('CE', 'Ceará', 'Companhia de Gestão dos Recursos Hídricos', 'COGERH'),
('PR', 'Paraná', 'Instituto Água e Terra', 'IAT'),
('SC', 'Santa Catarina', 'Secretaria de Estado do Desenvolvimento Econômico Sustentável', 'SDE'),
('RS', 'Rio Grande do Sul', 'Departamento de Recursos Hídricos', 'DRH'),
('DF', 'Distrito Federal', 'Instituto Brasília Ambiental', 'IBRAM'),
('RJ', 'Rio de Janeiro', 'Instituto Estadual do Ambiente', 'INEA'),
('ES', 'Espírito Santo', 'Agência Estadual de Recursos Hídricos', 'AGERH'),
('PA', 'Pará', 'Secretaria de Estado de Meio Ambiente e Sustentabilidade', 'SEMAS'),
('RO', 'Rondônia', 'Secretaria de Estado do Desenvolvimento Ambiental', 'SEDAM'),
('AL', 'Alagoas', 'Instituto do Meio Ambiente do Estado de Alagoas', 'IMA'),
('SE', 'Sergipe', 'Administração Estadual do Meio Ambiente', 'ADEMA'),
('RN', 'Rio Grande do Norte', 'Instituto de Gestão das Águas do Estado do RN', 'IGARN'),
('PB', 'Paraíba', 'Agência Executiva de Gestão das Águas do Estado da Paraíba', 'AESA'),
('AM', 'Amazonas', 'Instituto de Proteção Ambiental do Amazonas', 'IPAAM'),
('AC', 'Acre', 'Instituto de Meio Ambiente do Acre', 'IMAC'),
('AP', 'Amapá', 'Secretaria de Estado do Meio Ambiente', 'SEMA'),
('RR', 'Roraima', 'Fundação Estadual do Meio Ambiente e Recursos Hídricos', 'FEMARH')
ON CONFLICT (state_code) DO NOTHING;

-- state_code na farms (default BA). Backfill a partir de farms.state quando este
-- já for uma UF de 2 letras (ex.: 'BA'); demais ficam no default 'BA' (ajustar
-- manualmente por fazenda quando não for Bahia).
ALTER TABLE public.farms ADD COLUMN IF NOT EXISTS state_code char(2) DEFAULT 'BA';
UPDATE public.farms
  SET state_code = upper(state)
  WHERE state ~ '^[A-Za-z]{2}$' AND (state_code IS NULL OR state_code = 'BA');

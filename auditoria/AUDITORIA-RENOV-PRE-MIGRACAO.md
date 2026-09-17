# Auditoria RENOV — pré-migração (saída do Lovable)

**Data:** 20/08/2026 · **Modo:** somente leitura · **Nada foi alterado, aplicado ou publicado.**
Nenhum valor de credencial aparece neste relatório. Achados de segredo trazem arquivo, linha, tipo e criticidade, com valor redigido.

## Escala do que precisa migrar

| Domínio | Quantidade |
|---|---:|
| Migrations SQL | **553** |
| Edge Functions | **38** |
| Arquivos TS/TSX | 346 |
| Páginas | 33 · **7 não roteadas** |
| Hooks | 44 |
| Componentes | 178 |
| Testes | 30 |
| Buckets Storage | 2 (`agent-logs`, `agent-releases`) |
| Cron jobs declarados em migration | 13 (produção tem ~30 — ver lacuna abaixo) |

## Os cinco achados que mudam o plano de migração

### 1. Dependência viva de um projeto Supabase ANTIGO — bloqueia o corte

`src/components/RestrictedAuth.tsx:11` fixa a URL do projeto `feqyexitblmhyzykttgu`, **diferente** do projeto atual, e em `:163` chama `POST /functions/v1/validate-2fa` nele.

Esse componente **não é legado**: é importado por `Cadastros.tsx`, `Configuracoes.tsx`, `SuporteTecnico.tsx` e `DiagnosticoAuth.tsx` — as telas administrativas. A função `validate-2fa` **não existe neste repositório**, ou seja, vive apenas no projeto antigo.

**Consequência:** se o projeto antigo for desligado durante a migração, o 2FA das telas administrativas para. Migrar o projeto atual sozinho não resolve.

`src/pages/Licencas.tsx:10-11` tem a mesma URL e chave, mas a página **não está roteada** — risco menor, tratamento diferente.

### 2. Anon key e JWTs literais no repositório

- **33 migrations** contêm JWT embutido (anon key usada por `net.http_post` em cron).
- **3 arquivos** em `src/` contêm JWT embutido.

A anon key é pública por design, então isto **não é vazamento de segredo** — é acoplamento: cada migration com a chave literal fixa o projeto de origem e vai quebrar na migração. Também ensina o padrão errado.

### 3. 10 Edge Functions públicas sem guarda alguma

De 23 funções com `verify_jwt = false`, dez não têm nenhuma verificação própria e todas usam `SERVICE_ROLE_KEY`:

| Função | O que um chamador anônimo consegue |
|---|---|
| `whatsapp-alerts` | envia WhatsApp (Graph API) e grava log |
| `offline-daily-report` | envia WhatsApp e grava log |
| `command-verifier` | envia WhatsApp, **insere e atualiza** registros |
| `agent-release-signed-url` | gera **URL assinada** de release do agente |
| `agent-logs-cleanup` | opera sobre Storage |
| `diag-license` | insere e atualiza |
| `validate-diag-pin`, `diag-session` | atualizam registros |
| `api-rate-limiter` | insere registros |
| `bridge-heartbeat` | escrita com service_role |

`agent-release-signed-url` é o mais grave: entrega o binário do agente a quem pedir.

### 4. Higiene de `SECURITY DEFINER`

350 migrations declaram `SECURITY DEFINER`; **468 ocorrências não fixam `search_path`**. Em função que roda com privilégio elevado, isso é vetor clássico de escalonamento. Precisa de varredura dirigida no destino — não de correção às cegas.

### 5. Retenção ausente nas tabelas que mais crescem

Só 4 de 11 tabelas de log têm rotina de purga. **Sem retenção:** `system_logs`, `command_audit`, `farm_notifications`, `whatsapp_message_log`, `automation_tick_logs`, `agent_logs`, `whatsapp_health_log`.

`agent_logs` e `automation_tick_logs` são de altíssima cardinalidade. Migrar isso sem política de arquivo leva o custo e o tempo de restore junto.

## Lacuna de inventário que preciso registrar

**Não tenho acesso de leitura ao banco de produção** — a RLS bloqueia a chave anon do `.env`. Tudo aqui vem de análise estática do repositório. Três coisas não são verificáveis daqui e precisam de consulta sua no destino:

1. **Cron real:** o repositório declara 13 jobs; o inventário que você me passou antes tinha ~30. A diferença foi criada direto no painel e **não está versionada**.
2. **Tabelas órfãs:** classificar tabela como sem uso exige contagem de linhas e `pg_stat_user_tables`, que não consigo ler.
3. **`wa-batch-tick`:** existe job em produção apontando para uma função **inexistente no repositório**.

As consultas estão em `migration-baseline.md`.

## Regra que apliquei

Nada foi classificado como removível sem prova de ausência de consumo estático. Onde a prova é parcial, a categoria é `DESCONHECIDO` — preservar. Nenhum item deste relatório deve ser apagado antes da sua aprovação e de teste em cópia.

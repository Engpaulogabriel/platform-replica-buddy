# Plano de corte — migração reversível, sem parar a operação

Premissa: bomba não pode parar, alerta não pode sumir, agente não pode ficar órfão. Cada fase é reversível sozinha, e a irreversível é a última.

## Fase 0 — Preparação (sem tocar produção)

1. Rodar as três consultas de `migration-baseline.md`. **Sem elas o plano é chute** — o cron real e o tamanho das tabelas não estão no git.
2. Corrigir **S2** (10 Edge Functions sem guarda) no repositório, com testes. Ainda sem publicar.
3. Portar `validate-2fa` para o repositório — hoje ela só existe no projeto antigo.
4. Definir retenção das 7 tabelas sem purga e extrair o arquivo frio.

**Reversível:** nada foi tocado.

## Fase 1 — Novo projeto em paralelo

Extensões → schema + RLS → segredos no Vault → dados quentes → Edge Functions → cron via `cron_invoke()` → Storage.

Os dois projetos coexistem. O antigo continua atendendo produção.

**Reversível:** basta não apontar ninguém para o novo.

## Fase 2 — Leitura sombra

Frontend de **homologação** apontando para o novo, com a mesma base. Compara Relatório de Automação, dashboard, mini relatório e indicadores entre os dois.

Critério: Relatório oficial com **zero** `Sistema`, `Telemetria RF`, `Comando Remoto`, `RF`, `Bridge`, `Serial`; contagem de eventos idêntica; cards com o mesmo estado físico.

**Reversível:** homologação isolada.

## Fase 3 — Agente em piloto

Versão nova do agente com endpoint configurável, em **uma fazenda** — sugiro Semear ou Sykue, onde já há piloto.

Critérios: heartbeat estável 48h · comando ligar/desligar confirmado fisicamente · OTA validando hash · FASE 2/3 aceitando fingerprint e token no projeto novo.

**Reversível:** rollback do agente para a versão anterior; a frota nunca foi tocada.

**Esta é a fase mais longa e a que não deve ser apressada.** O agente é o único componente cuja reversão depende de máquina em campo.

## Fase 4 — Corte de escrita

1. Janela curta de manutenção (fora de horário de irrigação).
2. Pausar cron no projeto antigo.
3. Delta final das tabelas quentes (`command_audit` e `automation_log` na íntegra).
4. Apontar o frontend de produção para o novo.
5. Reapontar o webhook da Meta.
6. Migrar o restante da frota do agente, por lotes.

**Reversível:** apontar env e webhook de volta; o antigo continua íntegro. Pontos de atenção: eventos gravados no novo durante a janela precisam voltar junto no rollback, e o webhook da Meta tem propagação própria.

## Fase 5 — Desligamento do antigo (IRREVERSÍVEL)

**Pré-requisitos, todos obrigatórios:**

- [ ] `validate-2fa` rodando no novo e `RestrictedAuth` repontado
- [ ] frota do agente 100% no novo, com heartbeat verde
- [ ] 30 dias de operação estável
- [ ] backup completo do antigo, restaurado e testado em cópia
- [ ] arquivo frio dos logs conferido

Só então desligar.

## O que NÃO fazer

- Não apagar nada antes da Fase 5. Todo `CANDIDATO_A_REMOÇÃO` fica onde está.
- Não migrar `agent_logs` e `automation_tick_logs` quentes — vão para arquivo frio.
- Não copiar segredo do antigo: recriar no destino.
- Não migrar o conteúdo de `cron_job_backup`.
- Não usar anon key literal em cron no destino, em nenhuma hipótese.
- Não cortar o agente em massa sem o piloto da Fase 3.

## Rollback por fase

| Fase | Como reverter | Custo |
|---|---|---|
| 0–1 | Não usar o novo | Zero |
| 2 | Desligar homologação | Zero |
| 3 | Agente volta à versão anterior | Baixo — uma fazenda |
| 4 | Env + webhook de volta ao antigo | Médio — delta de escrita |
| 5 | **Não há** | — |

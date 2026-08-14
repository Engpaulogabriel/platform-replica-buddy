# Plano de aplicação e rollback — cadeia de autoria

## Ordem de aplicação (obrigatória)

**Passo 1 — mesmo deploy, juntos.** Não separe estes dois:
- migration `20260814260000_remote_command_authorship_chain.sql`
- migration `20260814260200_automation_report_canonical_query.sql`
- frontend: `commandQueue.ts`, `AutomacaoReportTab.tsx`, `reportExport.ts`

Depois deste passo, Ligar/Desligar continua funcionando de duas formas:
pela RPC (caminho novo) e por INSERT direto (caminho legado, caso algo ainda
chame o antigo). **Nos dois, a autoria é do servidor** — o `created_by` enviado
pelo cliente é descartado e trocado por `auth.uid()`, e a trilha em
`command_audit` é criada pelo trigger. Nenhum comando fica sem autor.

**Passo 2 — validação com comandos reais.** Rode:

```sql
SELECT * FROM public.command_authorship_health();
-- exige sem_autor = 0 e sem_trilha = 0 em TODAS as fazendas

SELECT count(*) FROM public.command_audit
 WHERE details->>'legacy_direct_insert' = 'true'
   AND command_created_at > now() - interval '24 hours';
-- exige 0 — nenhum comando novo entrou pelo caminho legado
```

Faça pelo menos 5 comandos reais controlados (Ligar e Desligar em poços
diferentes, por usuários diferentes) e confira:

```sql
SELECT ca.command_id, ca.actor_label, ca.user_email, ca.intent,
       ca.command_created_at, c.status,
       al.id AS evento_confirmado, al.origin, al.actor_label AS nome_no_relatorio
  FROM public.command_audit ca
  LEFT JOIN public.commands c ON c.id = ca.command_id
  LEFT JOIN public.automation_log al
         ON al.equipment_id = ca.equipment_id
        AND al.noise_reason IS NULL
        AND al.occurred_at BETWEEN ca.command_created_at AND ca.command_created_at + interval '3 minutes'
 WHERE ca.command_created_at > now() - interval '2 hours'
 ORDER BY ca.command_created_at DESC;
```

Cada linha deve ter `command_id`, `actor_label` humano e, após a confirmação
física, o mesmo nome em `nome_no_relatorio`.

**Passo 3 — só então** aplique `20260814260100_remote_command_hard_block.sql`.
Ela própria aborta se os contadores acima não estiverem zerados.

## Rollback sem interromper Ligar/Desligar

| Situação | Ação | Efeito |
|---|---|---|
| Bloqueio ligado causou recusa em produção | `UPDATE public.farms SET command_rpc_enforced = false;` | Volta à transição na hora. INSERT direto é aceito de novo, **com autoria forçada server-side**. O painel volta a funcionar sem redeploy. |
| Só uma fazenda com problema | `UPDATE public.farms SET command_rpc_enforced = false WHERE id = '<farm>';` | Isola a fazenda, as demais seguem bloqueadas. |
| Precisa reverter o frontend | Redeploy do `commandQueue.ts` anterior **com a flag em false** | O caminho antigo volta a funcionar e continua gravando autor e trilha pelo trigger. |
| Relatório com problema de exibição | Reverter `AutomacaoReportTab.tsx`/`reportExport.ts` | Não afeta comando nem autoria: são só leitura. |

**O que o rollback nunca faz:** aceitar autoria vinda do frontend, ou deixar
comando remoto sem `actor_user_id`. Isso vale nos dois modos da flag.

## Validações de aceite

```sql
SELECT * FROM public.automation_report_forbidden_text_count();  -- tudo 0
SELECT * FROM public.remote_authorship_inventory();             -- sem_nome = 0
SELECT * FROM public.irrecoverable_authorship_list();           -- Setor Técnico
```

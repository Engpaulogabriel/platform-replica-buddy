# Grafo de dependências — RENOV

```
                    ┌──────────────────────────────┐
   navegador ──────▶│ FRONTEND React/Vite (346 ts) │
                    └───────────┬──────────────────┘
                                │ anon key + JWT de sessão
                                ▼
   ┌────────────────────────────────────────────────────────────┐
   │            SUPABASE (projeto ATUAL)                        │
   │  Postgres + RLS · Auth · Storage · Realtime · Vault        │
   │  pg_cron · pg_net                                          │
   └───┬───────────────┬──────────────┬─────────────────┬───────┘
       │               │              │                 │
       ▼               ▼              ▼                 ▼
  38 Edge Fn      2 buckets      ~30 cron jobs      Realtime
       │          agent-releases   (13 no git)     (equipments)
       │          agent-logs
       ├──────────────▶ Meta WhatsApp Cloud API (graph.facebook.com)
       ├──────────────▶ deno.land/std · deno.land/x/djwt · esm.sh/jose
       └──────────────▶ raw.githubusercontent.com  (via agente)

   ┌──────────────────────────────────────────────┐
   │  AGENTE ELECTRON (electron-agent/main.cjs)   │
   │  bridge serial ─ PLC ─ rádio LoRa            │
   └───┬──────────────────────────────────────────┘
       │ endpoint Supabase HARDCODED  ⚠ ponto de corte
       ▼
   projeto atual: agent-auth · agent-asar-key · license-validate ·
                  bridge-heartbeat · agent-release-signed-url

   ┌──────────────────────────────────────────────┐
   │  PROJETO SUPABASE ANTIGO (feqyexit…)         │  ⚠ AINDA VIVO
   │  função validate-2fa (não existe no repo)    │
   └───▲──────────────────────────────────────────┘
       │ RestrictedAuth.tsx  →  Cadastros · Configuracoes ·
       │                        SuporteTecnico · DiagnosticoAuth
       └── dependência que BLOQUEIA o desligamento do projeto antigo
```

## Arestas críticas para a migração

| # | Aresta | Efeito se cortada sem preparo |
|---|---|---|
| 1 | `RestrictedAuth` → projeto antigo (`validate-2fa`) | **Telas administrativas param.** Porta a função antes. |
| 2 | Agente → endpoint Supabase hardcoded | Frota inteira perde a nuvem. Exige versão nova + piloto. |
| 3 | Cron → Edge com anon key literal (33 migrations) | Jobs quebram. `cron_invoke()` + Vault resolve. |
| 4 | Edge → Meta WhatsApp | Webhook precisa ser reapontado no painel da Meta. |
| 5 | `agent-releases` → OTA | Hash e assinatura precisam revalidar, senão o agente recusa. |
| 6 | Realtime `equipments` → dashboard | Sem publicação no destino, os cards param de atualizar sozinhos. |
| 7 | Edge → deno.land / esm.sh | Indisponibilidade de terceiro derruba função. |

## Ordem de dependência (o que precisa existir antes do quê)

```
extensões → schema+RLS → segredos(Vault) → dados quentes
   → Edge Functions → cron(cron_invoke) → Storage+OTA
   → frontend(env) → validate-2fa portada → desligar projeto antigo
```

O último passo é o único irreversível. Tudo antes dele é reversível apontando o DNS/env de volta.

# ctx-dash — Seção de uso agregado (total, por-modelo, janelas de tempo)

**Data:** 2026-07-23
**Status:** Aprovado (design + 7 emendas adversariais) — pronto para plano de implementação
**Repo:** `dotfiles/claude/` (mesma decisão do spec base de 2026-07-10)
**Spec base:** `docs/superpowers/specs/2026-07-10-ctx-dash-design.md`

## Problema

O `ctx-dash` mostra pressão de contexto **por sessão viva** (grid de cards + drill-down).
Falta a visão **cross-sessão** de consumo: quanto foi usado no total, por modelo, e ao longo
do tempo (dia/semana), além de quando o limite de assinatura foi de fato atingido. Hoje o
dashboard nunca toca o histórico inteiro — só as sessões exibidas.

## Escopo — decisão travada

A seção mostra **uso real medido dos transcripts + eventos reais de rate-limit**. Explicitamente
**não** mostra "% do limite do plano" (estilo `/usage`): esse gauge exige os *valores* dos tetos
de assinatura e um contador de consumo-vs-teto que **não existem em nenhum arquivo local**
(`find ~/.claude` por `usage|limit|quota` retorna vazio; `stats-cache.json` não tem campo de
teto). Os tokens que parseamos **não são a mesma unidade** que a assinatura mede (limites Max são
opacos/ponderados). Cruzar os dois seria **fabricar o denominador** → viola a regra de verdade.
O `/usage` busca isso de um endpoint autenticado da Anthropic em runtime, não persistido.

**Períodos cobertos (todos os quatro, escolha do usuário):**

- **Últimas 5h (móvel)** — proxy de intensidade recente. **Não** é espelho fiel da janela de
  sessão do plano (que é um bloco fixo de 5h ancorado na 1ª mensagem pós-expiração, não deslizante).
  Rotulado como *"últimas 5h (móvel — aproximação)"*. Reconstrução de blocos reais fica fora de escopo.
- **Últimos 7 dias (móvel)** — rotulado *"últimos 7 dias"*, **não** "semana do plano": não sabemos
  o anchor de reset semanal da conta. Fingir saber seria inventar.
- **Série diária 30d** — barras por dia, empilhadas por modelo.
- **Acumulado** — soma de **todos os transcripts retidos**, rotulado *"acumulado (transcripts
  retidos desde \<data do mais antigo visto\>)"*. O Claude Code apaga transcripts antigos
  (`~/.claude/.last-cleanup`; retenção default ~30d), então o all-time verdadeiro **não é
  reconstruível** — o rótulo diz a verdade sobre o que é.

## Colocação — decisão travada

**Aba/visão dedicada "Uso"**, com toggle no cabeçalho: **Sessões ↔ Uso**. O grid de cards
permanece limpo; a aba tem espaço para os 4 períodos + série + eventos.

## Abordagem de dados — decisão travada

**A — Ao vivo dos transcripts + cache em memória por mtime** (estende o padrão existente).

- Cold-start medido: **parse full de 568 MB / 1663 arquivos / ~100k linhas-usage = ~3,0 s**, uma
  vez. Depois, só arquivos com mtime alterado re-parseiam. Aceitável para ferramenta sob demanda.
- **Rejeitado B** (cache persistido em disco): reinícios são raros (ferramenta sob demanda); 3 s
  por lançamento não dói. YAGNI — só fazer se o cold-start incomodar de verdade.
- **Rejeitado C** (híbrido com `stats-cache.json`): defasado (última computação observada 15 dias
  atrás), só-tokens (sem split de cache → não precifica $), duas fontes de verdade com unidades
  diferentes. Uso **apenas como cross-check de sanidade nos testes**, nunca como fonte de exibição.
- Mantém **zero deps** e **somente-leitura** (nenhum arquivo novo escrito).

## Emendas adversariais (revisão Fable, incorporadas)

### E1 — Subagents entram no agregado (evita undercount)

`indexAll()` só varre `<projeto>/*.jsonl`. Subagents vivem em
`<transcript-dir>/subagents/agent-*.jsonl` com `usage` próprio e **modelo possivelmente distinto**
da sessão-mãe. A agregação **deve incluí-los**, senão subconta tokens e $ silenciosamente. O
`subagentsFor()` já lê esses arquivos; a extração por-turno com timestamps deve ser padronizada e
somada nos mesmos buckets.

### E2 — "Acumulado" rotulado como "transcripts retidos"

Ver Escopo. Data do mais antigo derivada do menor timestamp realmente visto, nunca presumida.

### E3 — Janela 5h rotulada como aproximação móvel

Ver Escopo. Não reconstruir blocos reais por heurística (frágil, viola o não-inferir).

### E4 — Filtrar mensagens sintéticas da agregação

Linhas de erro 429 têm `model: "<synthetic>"`, `isApiErrorMessage: true` e usage todo-zero, mas
`input_tokens != null` — entrariam no `byModel` como modelo sem preço e acenderiam "parcial" à
toa. **Pular** linhas com `isApiErrorMessage` OU modelo `<synthetic>` OU usage integralmente zero,
tanto na nova agregação **quanto no `sessionMetrics` existente** (bug latente lá — corrigir junto
com teste que o cobre).

### E5 — Cache de somas pré-bucketadas por arquivo (perf do SSE)

Sessão ativa emite evento por turno → re-fetch de `/api/usage`. Cachear por-arquivo as **somas
pré-bucketadas** (por-dia × por-modelo) + os **eventos crus só das últimas ~48h** (para a janela de
5h). A re-agregação global vira soma de ~1663 registrinhos → sub-milissegundo, memória mínima.
Invalidação por mtime, como o resto da lib.

### E6 — Agregado v1 lê só o home real (não `/mnt`)

Hoje não há sessões Windows em `/mnt` (verificado → custo zero). Se existirem, ler centenas de MB
via 9p do WSL seriam **minutos**, não 3 s. O agregado v1 restringe-se ao `os.homedir()` real;
incluir `/mnt` fica como opt-in consciente futuro. (Difere de `roots()`, que varre `/mnt` para
**descoberta ao vivo** — o agregado tem seu próprio escopo de varredura.)

### E7 — Adicionar preço do Sonnet à `PRICES`

Histórico contém `claude-sonnet-*` (visto em `stats-cache.json`); a `PRICES` só tem Opus/Fable/Haiku
→ badge "parcial" acenderia sempre. **Verificar e adicionar o preço do Sonnet 5** na fonte oficial
(skill `claude-api` / docs Anthropic), com a mesma disciplina de comentário datado da tabela atual.
Modelos antigos/raros restantes continuam marcando "parcial" — correto.

## Arquitetura — novas funções em `ctx-lib.js`

| Função | Papel |
| --- | --- |
| `usageEvents(file)` | Um registro por turno `{ts, model, input, output, cacheRead, cc5m, cc1h}`, cacheado por mtime. Filtra sintéticas (E4). Base comum para sessão-mãe e subagents. |
| `rateLimitEvents(file)` | Detecta os 429 sintéticos. Distingue **session limit** (texto *"hit your session limit · resets HH:MM"* — observado) de **rate_limit_error cru** ("Rate limited" — throttling transiente, ruído, ignorado). Captura texto literal do reset; **weekly limit** previsto mas formato não observado → só captura texto, não codifica estrutura. |
| `aggregateUsage(home, nowMs)` | Varre transcripts do home real (E6) **+ subagents** (E1), soma `usageEvents` nos buckets 5h/7d/30d-diário/acumulado, por-modelo; precifica com `PRICES`/`costOf`; anexa eventos de limite recentes e a data do transcript mais antigo (E2). Usa cache pré-bucketado (E5). |

Reaproveita `indexAll`, `PRICES`, `costOf`, `subagentsFor`, `transcriptDir`.

## Servidor (`ctx-dash.js`)

- `GET /api/usage` → snapshot dos agregados + eventos de limite + `oldestTs`.
- Primeira chamada dispara o parse (~3 s) **assíncrono**, respondendo estado `{ computing: true }`;
  cliente re-tenta ao receber SSE ou por poll curto até o snapshot ficar pronto.
- SSE existente (`/api/events`) dispara re-fetch; re-agregação usa cache pré-bucketado (E5).

## UI — aba "Uso" (`ctx-dash.html`)

- Toggle no header **Sessões ↔ Uso**. SVG desenhado à mão, **sem CDN** (coerente com o resto).
- **Tiles:** últimas 5h · últimos 7d · acumulado — cada um com tokens **e** $ (com rótulos honestos
  de E2/E3). Estado "calculando…" enquanto o cold-start roda.
- **Quebra por-modelo:** barra empilhada por período.
- **Série diária 30d:** barras/dia empilhadas por modelo (tokens; toggle para $). Fuso: dia local
  (America/Cuiaba), rotulado.
- **Faixa de eventos rate-limit:** marcadores "bateu limite de sessão · reset HH:MM (data)".

## Regra de verdade (travas)

- **$ só para modelos com preço verificado**; badge **"parcial"** quando houver modelo sem preço
  (padrão `costOf` existente, agora com Sonnet — E7).
- Rótulos honestos: *"últimas 5h (móvel)"*, *"últimos 7 dias"*, *"acumulado (transcripts retidos
  desde …)"* — nunca fingir a mecânica exata do plano.
- **Nenhum "% de limite do plano"** (fora de escopo, ver Escopo).
- Sintéticas filtradas da agregação (E4).

## Verificação

- **Testes unitários** de `usageEvents`, `aggregateUsage`, `rateLimitEvents` com fixtures (mesmo
  padrão de golden snapshot da suíte atual), cobrindo: subagents somados (E1), sintéticas filtradas
  (E4), preço do Sonnet (E7), buckets de fronteira (turno exatamente em 5h/7d/30d), modelo sem preço
  → parcial.
- **Regressão do `sessionMetrics`:** teste que fixa o bug das sintéticas (E4) antes/depois.
- **Endpoint:** `curl` em `/api/usage` contra o histórico real; conferir totais contra
  `dailyModelTokens` do `stats-cache.json` como **sanidade** (tolerando a defasagem — não é fonte).
- **UI:** abrir a aba contra as sessões reais; conferir que tiles, série e eventos batem.

## Riscos assumidos

1. **Cold-start de 3 s cresce com o histórico** → mitigado por cache mtime + pré-bucketado (E5);
   se doer, upgrade para cache persistido (abordagem B) como otimização dirigida.
2. **Formato do weekly-limit não observado** → captura só texto literal, sem estrutura presumida.

## Fora de escopo (YAGNI)

- Gauge de "% do limite do plano" (sem fonte local confiável).
- Cache persistido em disco (só se o cold-start incomodar).
- Reconstrução dos blocos fixos reais de 5h (heurística frágil).
- Varredura de `/mnt` (sessões Windows) no agregado — opt-in futuro (E6).
- Alertas físicos (Stream Deck) — já previstos como fase 2 no spec base.

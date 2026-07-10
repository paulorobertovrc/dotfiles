# ctx-dash — Dashboard visual de sessões Claude

**Data:** 2026-07-10
**Status:** Aprovado (brainstorming) — pronto para plano de implementação
**Repo:** `dotfiles/claude/` (decisão registrada abaixo; **não** migrar para Homelab)

## Problema

O `ctx-watch.sh` faz triagem ao vivo de pressão de contexto no terminal: uma linha por
sessão Claude viva no sistema, com id, modelo, repo, idade e ocupação de contexto
(barra + tokens/janela/%). O trabalho é responder "qual sessão vai estourar contexto,
pra eu dar `/compact`".

A linha única (~80 cols) limita quanto se pode mostrar. O transcript (`~/.claude/projects/*/*.jsonl`)
expõe muito mais sinal do que cabe ali: título legível da sessão, branch, tendência de
crescimento, cache hit, custo, permission mode, subagents, versão — além da **série temporal
inteira** de cada sessão, hoje totalmente inexplorada.

Um dashboard visual local remove o limite de largura e abre a dimensão histórica.

## Decisões travadas (do brainstorming)

- **Propósito:** "os dois, em camadas" — visão geral ao vivo (grid de cards) + drill-down
  por sessão (linha do tempo detalhada).
- **Métricas:** o máximo de dado útil derivável do transcript, hierarquizado por relevância.
- **Ciclo de vida:** sob demanda (`ctx-watch --web`), **não** serviço em background.
- **Repo:** permanece em `dotfiles/` (já é público; o monitor é ferramenta de estação de
  trabalho, acoplada a `~/.claude/projects` e `/proc` locais — não é serviço hospedável).
- **Modelo/esforço:** spec+plano em Opus/2; parar antes da implementação.

## Arquitetura

O node embutido em string no `ctx-watch.sh` (~225 linhas) não comporta servidor + página.
Extrair para arquivos `.js` reais (refatoração de código compartilhado, autorizada):

| Arquivo | Papel |
|---|---|
| `claude/ctx-lib.js` | Núcleo: descoberta de sessões, processos vivos, leitura de contexto, inferência de janela (tudo que já existe) **+** série temporal e métricas derivadas. Zero dependências. |
| `claude/ctx-watch.sh` | Wrapper fino: chama `node ctx-watch.js`. **Saída do terminal permanece byte-idêntica** à atual. |
| `claude/ctx-watch.js` | CLI atual (single-shot / `--watch` / `--all`) consumindo a lib. |
| `claude/ctx-dash.js` | Servidor HTTP sob demanda (`--web`). |
| `claude/ctx-dash.html` | Página única self-contained: CSS/JS inline, SVG desenhado à mão. **Sem CDN** — funciona offline. |
| `install.sh` | Passa a copiar os novos arquivos para `~/.claude`. |

**Zero dependências externas** mantido em todo o conjunto (coerente com o estado atual).

### Segurança (postura defensiva)

- Bind **exclusivamente em `127.0.0.1`** — transcripts contêm código e dados sensíveis;
  nunca expor na rede. WSL2 encaminha localhost ao browser do Windows automaticamente.
- Página serve apenas dados das sessões locais do próprio usuário; sem escrita, sem
  execução de comando via HTTP (somente leitura).

## Servidor e fluxo de dados

Endpoints:

- `GET /` → `ctx-dash.html`.
- `GET /api/sessions` → snapshot JSON de todas as sessões (ativas + `--all`), com todas as
  métricas do card.
- `GET /api/session/<id>/timeline` → série temporal reconstruída do transcript da sessão.
- `GET /api/events` → **SSE**, reaproveitando o `fs.watch` + debounce 200ms que o `--watch`
  já usa. Cliente re-busca `/api/sessions` ao receber evento; tick de 5s para atualizar
  idades no cliente.

Detalhes:

- Timeline reconstruída sob demanda e **cacheada por mtime** (só re-parseia arquivo que mudou).
- Leitura por stream de linhas — transcripts de ~1M tokens não explodem memória.
- Porta padrão fixa `4791`; `--port` para override; se ocupada, tenta a próxima e avisa na saída.
- CLI sobe o servidor, imprime a URL e tenta abrir o browser (`wslview` → `explorer.exe` →
  fallback: só imprime). Ctrl+C derruba.

## Visão geral — grid de cards

Um card por sessão, ativas primeiro. Toggle na UI para incluir/ocultar sessões inativas
(equivalente ao `--all`). Hierarquia visual: contexto domina; resto em segundo plano.

**Identificação:** `aiTitle` (título legível), repo + `gitBranch`, modelo, id curto,
● indicador de vivo, idade, versão do Claude Code.

**Contexto (dominante):** barra + tokens/janela/% (mesma semântica de cores do terminal:
verde <50%, amarelo 50–80%, vermelho ≥80%), **sparkline** da ocupação ao longo do tempo,
**tendência** (Δ tokens/min) e **ETA até cheio** no ritmo atual, marcador de compacts.

**Custo/eficiência:** cache hit % (`cache_read / total input`), custo $ acumulado da sessão,
output tokens do último turno, contagem de turnos.

**Estado:** badge de `permissionMode` (**vermelho para bypass/auto destravado**),
fast mode (`speed`), `service_tier`, subagents disparados (contagem de tool `Agent` /
`isSidechain`), web search/fetch requests.

## Drill-down — clique no card

- **Gráfico contexto × tempo** da sessão inteira, com penhascos de `/compact` anotados
  (`compactMetadata.preTokens` → queda de ocupação).
- Custo acumulado × tempo.
- Distribuição de uso de ferramentas (contagem de `tool_use` por nome).
- Cadência de turnos (intervalos entre turnos ao longo do tempo).

## Custo — regra de verdade

Tabela `PRICES` embutida em `ctx-lib.js`, **preenchida a partir da fonte oficial** (skill
`claude-api` / docs Anthropic) com comentário datando a verificação. Modelo sem preço
verificado → card mostra tokens agregados, **nunca** $ chutado.

## Sinais do transcript (verificados na fonte)

Campos confirmados em transcript real (`2a9ac356…jsonl`):

- `message.usage`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `cache_creation.{ephemeral_1h,ephemeral_5m}`,
  `server_tool_use.{web_search_requests,web_fetch_requests}`, `service_tier`, `speed`,
  `iterations`.
- Topo: `gitBranch`, `permissionMode`, `aiTitle`, `version`, `cwd`, `timestamp`, `type`,
  `isSidechain`, `sessionId`.
- `compactMetadata.preTokens` (para inferência de janela e anotação de compacts).
- Contagem de `tool_use` por nome no conteúdo das mensagens `assistant`.

## Erros e resiliência

- Linha JSONL corrompida → skip (comportamento atual preservado).
- Sessão ilegível → some do grid sem derrubar o servidor.
- Diretório/transcript inacessível → ignorado silenciosamente (como hoje).
- Porta ocupada → tenta a próxima, avisa.

## Verificação

- **Refactor não regride o terminal:** capturar saída de `ctx-watch`, `ctx-watch --all` e
  `ctx-watch --watch` (primeiro frame) antes e depois da extração; comparar — deve ser
  byte-idêntica.
- **Endpoints:** `curl` contra `/api/sessions`, `/api/session/<id>/timeline`, `/api/events`
  usando as sessões reais vivas no momento.
- **Dashboard:** abrir contra as sessões vivas atuais; conferir que cards batem com o
  terminal e que o drill-down reconstrói a linha do tempo corretamente (incluindo compacts).

## Riscos assumidos

1. **Refactor toca ferramenta que funciona** → mitigado pela comparação byte-a-byte da saída.
2. **Parse de transcripts de 1M tokens é pesado** → mitigado por cache por mtime + stream de linhas.

## Fora de escopo (YAGNI)

- Serviço em background / daemon.
- Exposição na LAN.
- Repo dedicado (`claude-ctx-dash`) — reconsiderar só depois que a ferramenta amadurecer e
  provar valor.
- Escrita/controle de sessões via dashboard (somente leitura).

# Estratégia de Modelos e Effort — Claude Code

> Documento de referência para seleção de modelo e nível de effort (universal, todos os projetos).
> Vive em `dotfiles/docs/`; o CLAUDE.md global (`dotfiles/claude/CLAUDE.md`) contém a rubrica
> operacional que este documento fundamenta.
> Última revisão: 2026-07-11 — claims verificadas nas fontes oficiais nesta data
> (https://code.claude.com/docs/en/model-config e migration guide da Claude Platform).

---

## 1. Princípio central

| Dial | O que controla | Pergunta que responde |
|---|---|---|
| **Modelo** | Capacidade (teto de inteligência) | *Quem* resolve o problema? |
| **Effort** | Rigor (quanto trabalho por turno) | *Quão a fundo* ele vai? |

Regra de diagnóstico após um erro:

- Tinha todo o contexto, **tentou e errou** → suba de **modelo**.
- Errou por **não tentar o suficiente** (pulou arquivo, não rodou testes, não verificou) → suba o **effort**.
- Trabalho rotineiro há vários turnos no modelo caro → **desça de modelo** (mesma qualidade, menor custo).

---

## 2. Papéis dos modelos (com custo real)

| Modelo | $/MTok (in/out) | Contexto | Papel | Usar quando | Evitar quando |
|---|---|---|---|---|---|
| `haiku` (4.5) | $1 / $5 | 200K | Fan-out barato | Exploração de codebase, leitura em massa, grep/mapeamento via subagentes | Qualquer tarefa que exija julgamento; **não suporta effort** |
| `sonnet` (5) | $3 / $15 (intro $2/$10 até 2026-08-31) | 1M | Generalista do dia a dia | Features, refactors comuns, testes, correções, CRUD | Bug travado após 2 tentativas com contexto completo |
| `opus` (4.8) | $5 / $25 | 1M | Especialista interativo | Debugging difícil, design de arquitetura, decisões técnicas com você no loop | Trechos rotineiros longos (custo sem ganho) |
| `fable` (5) | $10 / $50 | 1M | Autonomia e julgamento | Tarefas multi-etapa longas sem supervisão, verificação de resultados de outros agentes, problemas onde Opus travou | Trabalho simples; é o maior custo por token (2× Opus) |

Notas:

- **`/fast` (Opus 4.8/4.7):** mesma inteligência com até ~2,5× mais tokens/s, **a preço premium** —
  não é velocidade grátis; use quando latência importa mais que custo. Research preview.
- **Fable em effort baixo/médio:** o migration guide oficial da Claude Platform afirma, verbatim:
  *"Lower effort settings — including `low` — still perform very well on Claude Fable 5, often
  exceeding the `xhigh` or even `max` performance of previous models."*
  **Interpretação** (nossa, não da fonte): `fable + medium` é candidato a substituir `opus + xhigh`
  em tarefas de julgamento — mas Fable custa 2× por token, então a troca só compensa se o medium
  consumir menos da metade dos tokens; medir por workload, não assumir dominância.
- **Sufixo `[1m]`:** existe para `opus[1m]`/`sonnet[1m]` (janela de 1M). Em `fable` é inócuo —
  1M já é a janela nativa (default e máximo). Sem premium de long context nesses modelos.

---

## 3. Níveis de effort

| Nível | Uso | Persistência |
|---|---|---|
| `low` | Tarefas simples, alto volume, latência mínima | Persiste entre sessões |
| `medium` | Equilíbrio custo/qualidade em trabalho moderado | Persiste |
| `high` | **Padrão** (exceção: Opus 4.7 tem default `xhigh`) | Persiste |
| `xhigh` | Trabalho agêntico pesado, exploração extensa, muitas tool calls | Persiste |
| `max` | Capacidade máxima, sem restrição de gasto | **Somente a sessão atual** — exceto quando vem da env var `CLAUDE_CODE_EFFORT_LEVEL` |
| `ultracode` | Configuração do Claude Code (não é nível da API): envia `xhigh` + orquestra workflows multi-agente | Somente a sessão atual |

Fonte (verbatim, model-config): *"The default effort is `high` on Fable 5, Sonnet 5, Opus 4.8,
Opus 4.6, and Sonnet 4.6, and `xhigh` on Opus 4.7."* · *"Ultracode is a Claude Code setting rather
than a model effort level: it sends `xhigh` to the model and additionally has Claude orchestrate
dynamic workflows for substantive tasks. It applies to the current session only."*

Restrições:

- `xhigh` disponível apenas em **Fable 5, Opus 4.8/4.7 e Sonnet 5** (Opus 4.6/Sonnet 4.6 têm
  low/medium/high/max, sem xhigh). Em modelos sem suporte, o Claude Code cai para o maior nível
  suportado abaixo do configurado (*"`xhigh` runs as `high` on Opus 4.6"*). Haiku não suporta effort.
- A escala é **calibrada por modelo**: o mesmo nome de nível não representa o mesmo valor entre
  modelos. Não transporte configurações sem retestar (o migration guide manda re-tunar effort ao migrar).
- **Trocar effort no meio da tarefa invalida o cache de prompt** — cada nível tem cache próprio;
  mudar recomputa a request inteira (custo equivalente a trocar de modelo). O Claude Code mostra
  diálogo de confirmação antes de aplicar mudança que invalida o cache. Ajuste entre tarefas,
  idealmente junto de `/clear`.

---

## 4. Mapeamento para a escala interna (1–5 + 6)

A rubrica dos CLAUDE.md (global e por projeto) usa "modelo + esforço 1–5, com 6º nível do Fable
para subagents/workflows". Esse é o vínculo com os níveis reais:

| Escala interna | Nível real | Observação |
|---|---|---|
| 1 | `low` | |
| 2 | `medium` | |
| 3 | `high` | Default do produto |
| 4 | `xhigh` | Inexistente em Opus 4.6/Sonnet 4.6 (degrau 4 vira `high`) |
| 5 | `max` | Session-only |
| 6 (só Fable) | `ultracode` | xhigh + orquestração de workflows; session-only |

`Haiku 1–2` da rubrica **não corresponde a nada na API** (Haiku não tem effort) — é escala
conceitual de rigor pedido no prompt, não um parâmetro.

---

## 5. Matriz de cenários (parametrização recomendada)

| # | Cenário | Modelo | Effort | Observação |
|---|---|---|---|---|
| 1 | Explorar codebase / localizar arquivos | `haiku` (subagente) | — | Retornar conclusões, não dumps |
| 2 | Feature rotineira, testes, CRUD | `sonnet` | `high` | Padrão geral |
| 3 | Refactor moderado / correções em série | `sonnet` | `medium` | Reduz custo em lote |
| 4 | Bug difícil, sessão interativa | `opus` | `high` → `xhigh` | `/fast` se precisar de velocidade (custo premium) |
| 5 | Migração/refactor autônomo multi-etapa | `fable` | `high` | Subir para `xhigh` só se não fechar o loop |
| 6 | Verificação/revisão de saída de agentes | `fable` ou `opus` | `high`+ | Nunca economizar aqui |
| 7 | Tarefa "impossível" onde os demais travaram | `fable` | `xhigh`/`max` | `max` só na sessão |
| 8 | Classificação simples, lookups, scripts triviais | `sonnet` | `low` | Ou delegar a `haiku` |

---

## 6. Subagentes (frontmatter)

Explorador permanente barato:

```markdown
---
name: explorer
description: Exploração read-only do codebase. Localiza arquivos, mapeia estrutura, resume.
tools: Read, Grep, Glob
model: haiku
---
Explore amplamente e retorne apenas um resumo das conclusões. Nunca modifique arquivos.
```

Verificador de alto rigor:

```markdown
---
name: verifier
description: Verifica se as conclusões/mudanças propostas se sustentam. Tenta refutá-las.
tools: Read, Grep, Glob, Bash
model: fable
---
Assuma que a conclusão pode estar errada. Rode os testes. Reporte discordâncias com evidência.
```

Ad hoc: o tool `Agent` aceita `model: sonnet | opus | haiku | fable` por spawn, sem registro.
Sem `model` no frontmatter, o subagente herda o modelo da sessão.

---

## 7. Comandos e overrides

```bash
/model                       # trocar modelo interativamente
/effort                      # slider interativo
/effort xhigh                # definir direto
/effort auto                 # voltar ao padrão do modelo
claude --effort low          # por sessão, no launch (única via com -p, além da env var)
CLAUDE_CODE_EFFORT_LEVEL=high  # env var; precede tudo (aceita nível ou "auto")
```

Higiene de custo (ordem de impacto):

1. `/clear` entre tarefas não relacionadas.
2. CLAUDE.md enxuto (regras e estado atual; histórico e detalhe em docs apontados, não inline).
3. Modelo por tarefa, não por sessão — subagentes baratos para fan-out.
4. Effort como ajuste fino, não como muleta para falta de contexto.

---

## 8. Relação com os CLAUDE.md

**Não colar bloco estático de política em projeto que já tem rubrica própria.** O CLAUDE.md
global define a rubrica universal (recomendação de modelo+esforço por passo, PARAR se divergir
do ativo); CLAUDE.md de projeto pode especializá-la (ex.: assessorIA mapeia Fable/Opus/Sonnet/Haiku
a classes de tarefa jurídica). Este documento é a fundamentação técnica de ambos — quando a doc
oficial mudar (novos modelos/níveis), atualizar **aqui** e propagar só o que altera decisão.

---

*Frase-guia: fan-out barato, julgamento caro. O desperdício não é usar modelos caros — é usá-los em trabalho que nunca precisou de julgamento.*

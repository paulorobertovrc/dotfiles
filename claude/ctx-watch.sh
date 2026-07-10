#!/usr/bin/env bash
# ctx-watch.sh — painel das sessões do Claude ATIVAS no sistema (de qualquer diretório).
#
# "Ativa" = existe um processo `claude` rodando para ela agora (mesmo ociosa,
# esperando input). Isso é mais fiel que olhar mtime do transcript.
#
# Varre TODOS os projetos em ~/.claude/projects e, por garantia, qualquer
# /mnt/<letra>/Users/<user>/.claude/projects (store do host Windows, se existir).
# Cruza com os processos `claude` vivos (ps + /proc/<pid>/cwd; lsof no macOS) e,
# para cada um, lê o transcript p/ a ocupação de contexto do último turno.
#
# A janela (denominador do %) é INFERIDA por sessão: o transcript não guarda esse
# dado, então se a sessão já passou de 200k em algum turno (ou tem preTokens>200k num
# compact), assume-se janela de 1M; senão, 200k. Calculado 1x por sessão e cacheado.
#
# Uso:
#   bash ~/.claude/ctx-watch.sh                 # imprime uma vez (sessões ativas agora)
#   bash ~/.claude/ctx-watch.sh --watch         # ao vivo, dirigido a eventos (alias: ctx)
#   bash ~/.claude/ctx-watch.sh --all           # todas as sessões recentes (ativas marcadas com ●)
#   bash ~/.claude/ctx-watch.sh --all --watch   # ao vivo + todas
#
# O modo --watch redesenha no instante em que um transcript muda (fs.watch), com um
# tick de 2s só p/ atualizar idades e detectar processos que entram/saem — não precisa
# do utilitário `watch`. A ocupação só muda quando a sessão grava um turno no transcript.

exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ctx-watch.js" "$@"

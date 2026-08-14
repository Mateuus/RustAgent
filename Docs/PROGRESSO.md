# Progresso

Checklist vivo da Fase 1. Atualizado à medida que as etapas de
[04-PLANO-DE-MIGRACAO.md](04-PLANO-DE-MIGRACAO.md) andam.

Legenda: `[ ]` a fazer · `[~]` em curso · `[x]` pronto e verificado

---

## Etapa 0 — Documentação

- [x] `Docs/README.md` — índice
- [x] `01-VISAO-E-ESCOPO.md`
- [x] `02-ARQUITETURA.md`
- [x] `03-DECISOES.md`
- [x] `04-PLANO-DE-MIGRACAO.md`
- [x] `05-OPERACOES.md`
- [x] `06-API.md`
- [x] `07-PAINEL.md`
- [x] `08-EXECUCAO-E-DEPLOY.md`
- [x] `09-ROADMAP.md`
- [x] `PROGRESSO.md`

## Etapa 1 — Esqueleto do repositório

- [x] `package.json` da raiz (npm workspaces)
- [x] `tsconfig.base.json`
- [x] `.gitignore`
- [x] `.env.example`
- [x] `ecosystem.config.cjs`
- [x] `README.md` da raiz
- [x] `core/` — package.json, tsconfig, eslint, vitest
- [x] `panel/` — package.json, next.config, tailwind, tsconfig
- [x] `Configs/server.example.ini` (reescrito: sem os `.bat`)
- [x] `npm install` (350 pacotes) e `tsc --noEmit` passam

## Etapa 2 — Base do core

- [x] `logger.ts`, `util.ts`
- [x] `config.ts` (enxuto: `.env` + `Configs\*.ini`)
- [x] `db/database.ts`, `schema-version.ts`, `migrations.ts` (001: `servers`, `meta`)
- [x] `db/servers-repository.ts`, `db/backup.ts`
- [x] `auth/operator.ts` (scrypt + sessão) e `auth/csrf.ts`
- [x] `http/server.ts`, `http/auth.ts`, `error-response.ts`, `routes/health.ts`, `routes/auth.ts`
- [x] `index.ts` com desligamento ordenado (IPC do PM2 + sinais)
- [x] `scripts/panel-password.ts`
- [x] **verificado**: sobe, migra o banco, `/health` 200, `/auth/session` 401, `/api/*` 401

## Etapa 3 — Servidores

- [x] `rcon/` (client, frames, socket, url, errors, typed-emitter) — copiado
- [x] `servers/ports.ts`, `registry.ts`, `create-server.ts` (sem os `.bat` nas mensagens)
- [x] `servers/map-levels.ts` (extraído do `map-pool-repository` antigo)
- [x] `servers/context.ts`, `supervisor.ts` (dois cadastros: ligados e desligados)
- [x] `http/routes/servers.ts` (listar, criar, patch, delete, comando de RCON)
- [x] **verificado**: criar pela API escreve `Configs\pvp1.ini` com o bloco de portas 0,
      a lista mostra `installed:false`, e ligar sem o jogo em disco recusa com
      409 `SERVER_NOT_INSTALLED`
- [ ] os testes do `rcon/` vindos do projeto antigo

## Etapa 4 — Instalar (o marco)

- [x] `steam/steamcmd.ts` — garantir o cliente e rodar `app_update`
- [x] `oxide/install.ts` (release do GitHub + URL direta como plano B)
- [x] `ops/run.ts`, `ops/operations.ts` (estado, trava por recurso, log incremental)
- [x] `ops/service.ts` — as sete operações
- [x] `http/routes/operations.ts` (202, log incremental, cancelar)
- [x] **verificado**: `server-install` responde 202, o SteamCMD é **baixado, extraído
      e executado de verdade** (`Steam Console Client (c) Valve Corporation`), e a
      segunda instalação simultânea recusa com `OPERATION_IN_PROGRESS` dizendo quem
      segura a trava
- [ ] um `app_update` completo (~6 GB) numa máquina de verdade

## Etapa 5 — Ciclo de vida

- [x] `ops/server-process.ts` — start destacado, descoberta por linha de comando
      (`wmic`, com PowerShell de reserva)
- [x] `server-start`, `server-stop`, `server-restart`
- [x] espera pelo RCON depois de subir (o "subiu" é o RCON responder)
- [x] conferência de porta ocupada antes de subir
- [ ] exercitar contra um servidor de Rust instalado

## Etapa 6 — Steam

- [ ] `steam/vdf.ts`, `steam/builds.ts`
- [ ] `steam/update-watcher.ts` (15 min, cede a vez ao lock)
- [ ] `server-auto-update` com contagem no chat
- [ ] `http/routes/steam-updates.ts`

## Etapa 7 — Plugins

- [ ] `oxide/plugins.ts` (listar, instalar, remover, reload)
- [ ] `http/routes/plugins.ts` com upload multipart
- [ ] travas: regex do nome, caminho conferido, limite de tamanho

## Etapa 8 — Painel

- [ ] base: layout, tema, `ui/*`, `lib/api/*`, hooks
- [ ] `/entrar` — login de operador + CSRF
- [ ] `/` — cartões dos servidores
- [ ] `/servidores` — lista + criar
- [ ] `/servidor/[id]` — visão, operações (log ao vivo), plugins, configuração
- [ ] `/config`
- [ ] `npm run build -w panel` e o core servindo `panel/out`

## Etapa 9 — Fechamento

- [ ] `README.md` da raiz revisado
- [ ] `.env.example` completo e comentado
- [ ] `git init` + primeiro commit + push para `Mateuus/RustAgent`
- [ ] **critério de aceite da Fase 1, ponta a ponta**

---

## Notas de execução

_(o que foi descoberto no caminho e muda alguma decisão vai aqui, com data)_

- **2026-08-14** — projeto iniciado. O projeto antigo
  (`F:\Projects\Rust\RustAgent`) continua intocado e rodando; ele é a fonte da
  migração, não o destino de nenhuma mudança.

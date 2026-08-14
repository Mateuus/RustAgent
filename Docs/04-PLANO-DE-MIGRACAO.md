# 04 — Plano de migração

Origem: `F:\Projects\Rust\RustAgent` (o projeto antigo, que continua rodando).
Destino: `F:\Projects\RustAgent` (este).

Nada é movido. Tudo é **copiado e adaptado** — o antigo permanece de pé até a
Fase 1 passar no critério de aceite de [01-VISAO-E-ESCOPO.md](01-VISAO-E-ESCOPO.md).

---

## As três categorias

| Marca | Significa |
|---|---|
| **COPIA** | vem quase intacto; ajustes de import e de nomenclatura |
| **REESCREVE** | a ideia vem, o código não — é onde mora a simplificação |
| **NÃO VEM** | fica no projeto antigo (Fase 1); pode voltar numa fase seguinte |

---

## Raiz do repositório

| Arquivo | O quê |
|---|---|
| `package.json` | **REESCREVE** — npm workspaces (D1) |
| `tsconfig.base.json` | **COPIA** |
| `ecosystem.config.cjs` | **REESCREVE** — aponta para `core/dist/index.js`, sem launcher |
| `.gitignore` | **REESCREVE** — inclui `Servers/`, `SteamCMD/`, `Logs/`, `Backups/`, `data/`, `Configs/*.ini` |
| `.env.example` | **REESCREVE** — só as variáveis da Fase 1 |
| `README.md` | **REESCREVE** — curto, aponta para `Docs/` |
| `pnpm-workspace.yaml`, `pnpm-lock.yaml` | **NÃO VEM** |
| `launcher.mjs`, `openapi.yaml` | **NÃO VEM** (o OpenAPI volta quando a API estabilizar) |
| `installer/`, `service/`, `deploy/`, `dist-release/`, `scripts/`, `test/launcher.test.mjs` | **NÃO VEM** (D2) |

---

## `core/src` — arquivo por arquivo

### Base

| Origem | Destino | |
|---|---|---|
| `logger.ts` | igual | **COPIA** |
| `util.ts` | igual | **COPIA** |
| `version.ts` | igual | **COPIA** — enxugar: sai a parte que lia release instalada |
| `config.ts` (64 KB) | `config.ts` | **REESCREVE** — ver abaixo |
| `index.ts` (68 KB) | `index.ts` | **REESCREVE** — ver abaixo |

**`config.ts`.** O arquivo antigo carrega ~50 variáveis de ambiente (loja,
webhooks, VIP, ads, GitHub, updates) e resolve caminhos em quatro camadas
(`RUSTAGENT_HOME`, `PROJECT_ROOT`, layout de release, layout antigo). O novo:

- raiz é a pasta do repositório, ponto. Sem `RUSTAGENT_HOME`, sem `releases\`;
- variáveis da Fase 1 apenas (ver [08-EXECUCAO-E-DEPLOY.md](08-EXECUCAO-E-DEPLOY.md));
- **preserva integralmente**: `discoverServerIds`, `readServerConfig`,
  `resolveServerPaths`, o parser de `.ini` e a validação da senha de RCON. Essas
  partes são o miolo do multi-servidor e estão certas.

**`index.ts`.** O antigo monta 15 serviços por servidor. O novo monta: banco →
config → registry → supervisor → contextos → HTTP → vigia da Steam. O
desligamento ordenado (`SHUTDOWN_TIMEOUT_MS`, fechar RCON, parar relógios,
fechar banco) **COPIA**.

### `rcon/` — **COPIA inteiro**

`client.ts`, `frames.ts`, `socket.ts`, `url.ts`, `errors.ts`,
`typed-emitter.ts`. É a peça mais testada do projeto e não tem nada de
multi-servidor específico. Vem com os testes.

### `db/`

| Origem | |
|---|---|
| `database.ts`, `schema-version.ts` | **COPIA** |
| `migrations.ts` (148 KB, ~30 migrações) | **REESCREVE** — começa na 001 com as tabelas da Fase 1 |
| `servers-repository.ts` | **COPIA** |
| `backup.ts` | **COPIA** (backup do próprio banco) |
| os outros 18 repositórios (players, vips, store, ads, ui, wipe, admins, webhooks…) | **NÃO VEM** |

### `servers/` — o coração, quase intacto

| Origem | |
|---|---|
| `ports.ts` | **COPIA** |
| `registry.ts` | **COPIA** |
| `create-server.ts` | **COPIA** — tirar a menção a `UpdateServer.bat` nas mensagens |
| `context.ts` | **REESCREVE** — o contexto novo tem RCON + operações + relógio da Steam; os outros sete serviços saem |
| `supervisor.ts` | **COPIA** com poda — a montagem do contexto encolhe junto |

Uma mudança de nomenclatura vale a pena aqui: `LEGACY_SERVER_ID = 'devserver'`
e o fallback para o layout antigo (`Server\`, `Logs\`) **NÃO VÊM**. Numa árvore
nova não existe instalação anterior para acomodar. O servidor padrão passa a
ser "o primeiro cadastrado", e isso simplifica quatro funções.

### `steam/`

| Origem | |
|---|---|
| `vdf.ts` | **COPIA** |
| `builds.ts` | **COPIA** — a leitura de AppID/login/branch continua saindo do `.ini` |
| `update-watcher.ts` | **COPIA** com poda — sai a integração com o `.bat` |
| `openid.ts` (login Steam) | **NÃO VEM** (Fase 3) |
| — | `steamcmd.ts` **NOVO**: garantir instalação, rodar `app_update`, transcrever saída |

### `ops/`

`operations.ts` tem 102 KB e 2800 linhas. O que **COPIA** como ideia (e boa
parte como código):

- a máquina de estados de uma operação (`running/succeeded/failed/cancelled`);
- o **log incremental** com `droppedLines`;
- a **trava** com recurso nomeado e mensagem de quem está segurando;
- a **descoberta do processo** por linha de comando (`parseProcessQueryOutput`,
  `readCommandLineValue`, `processMatchesTarget`, `resolveServerProcess`);
- a **contagem regressiva** do update (`clampCountdown`, `countdownMarks`,
  `formatRemaining`, `sanitizeChatText`, `isMonthlyUpdateWindow`).

O que **REESCREVE**: tudo que chama `.bat`. `#spawnBat` vira `run.ts` (spawn
direto com transcrição), e as operações passam a ser:

| Fase 1 | O que faz |
|---|---|
| `server-install` | SteamCMD (instala se preciso) + `app_update` + Oxide |
| `server-update` | o mesmo, com o servidor obrigatoriamente parado |
| `server-start` | sobe o `RustDedicated.exe` destacado |
| `server-stop` | `quit` pelo RCON (com `force` opcional) |
| `server-restart` | stop + start |
| `server-auto-update` | avisa no chat → conta → salva → para → atualiza → sobe |
| `oxide-install` | só o Oxide, sem tocar no jogo |

**NÃO VEM**: `plugins-build` (compilar `.cs` com MSBuild) — volta quando os
plugins voltarem, e aí como "compilar o repositório de plugins", não `Build.bat`.

### `oxide/` — **NOVO**

- `install.ts` — baixa `Oxide.Rust.zip` do GitHub
  (`OxideMod/Oxide.Rust/releases/latest`), com fallback para a URL direta,
  extrai por cima de `Servers\<id>\`, confere os quatro assemblies
  (`Oxide.Core.dll`, `Oxide.Rust.dll`, `Oxide.CSharp.dll`, `Oxide.Common.dll`)
  e cria a árvore `oxide\{plugins,config,data,lang,logs}`. Backup do `oxide\`
  antes, em `Backups\<id>\oxide-<carimbo>\`. Recusa com o servidor no ar.
- `plugins.ts` — listar, instalar (upload ou caminho), remover, e
  `oxide.reload <Nome>` pelo RCON.

Vem da lógica do `Tools\InstallOxide.ps1`, agora em TypeScript e por servidor.

### `auth/`

| Origem | |
|---|---|
| `csrf.ts` | **COPIA** |
| `pin.ts` | **NÃO VEM** — mas o desenho do scrypt e do bloqueio progressivo é a base do `operator.ts` |
| `panel-auth-service.ts` | **NÃO VEM** (D5) |
| — | `operator.ts` **NOVO**: usuário + senha do `.env`, sessão em memória, CSRF |

### `http/`

| Origem | |
|---|---|
| `server.ts` | **REESCREVE** — mesma montagem, menos rotas |
| `auth.ts` | **COPIA** com poda — bearer em tempo constante fica; escopos de cliente de API saem |
| `error-response.ts`, `network-guard.ts`, `ip-allowlist.ts` | **COPIA** |
| `server-scope.ts` | **COPIA** com poda |
| `schemas.ts` | **REESCREVE** — só os schemas da Fase 1 |
| `idempotency.ts`, `player-view.ts` | **NÃO VEM** |
| `routes/health.ts`, `servers.ts`, `server.ts`, `operations.ts`, `steam-updates.ts` | **COPIA** com poda |
| `routes/auth.ts` | **REESCREVE** — login de operador |
| `routes/plugins.ts` | **NOVO** |
| as outras 15 rotas | **NÃO VEM** |

### `game/`, `wipe/`, `updates/`, `types/`

**NÃO VÊM** na Fase 1. A lista de jogadores online que o painel mostra sai do
`playerlist` **nativo** do Rust pelo RCON — e não do plugin. É o que mantém a
Fase 1 sem depender de plugin nenhum.

---

## `panel/src`

Do painel antigo aproveitamos a base e as telas do escopo. O resto fica.

**COPIA:** `app/layout.tsx`, `globals.css`, `components/ui/*` (button, dialog,
input, label, toast, action-menu, confirm-button), `components/app-shell.tsx`,
`sidebar.tsx`, `header-bar.tsx`, `page-header.tsx`, `section.tsx`,
`state-block.tsx`, `list-states.tsx`, `search-field.tsx`,
`connection-badge.tsx`, `freshness.tsx`, `kpi-row.tsx`,
`lib/api/*`, `lib/hooks/*`, `lib/utils.ts`, `lib/format.ts`, `lib/toast.ts`,
`lib/nav.ts`, `session-provider.tsx`, `access-gate.tsx`, `server-provider.tsx`,
`server-switcher.tsx`, `servers-list.tsx`, `server-create-dialog.tsx`,
`operations-page.tsx`.

**REESCREVE:** `dashboard.tsx` (vira a visão dos servidores),
`server-page.tsx` (as abas da Fase 1), `login-page.tsx` (usuário/senha),
`sidebar.tsx` (menos itens).

**NOVO:** `plugins-page.tsx`.

**NÃO VEM:** tudo de jogadores, VIP, admins, loja, ads, editor de UI, wipe,
integrações, itens, entregas — cerca de 60 componentes.

---

## Ordem de execução

Cada etapa termina com algo que roda. Nada de "monta tudo e testa no fim".

| # | Etapa | Termina quando |
|---|---|---|
| 1 | Esqueleto: raiz, `core`, `panel`, tsconfig, lint, vitest | `npm install` e `npm run typecheck` passam |
| 2 | Base do core: config, logger, db, migração 001, `/health` | `npm run dev` sobe e `/health` responde |
| 3 | `rcon/` + `servers/` + supervisor + rotas de servidores | criar servidor pela API, `.ini` escrito, listar |
| 4 | `steam/steamcmd.ts` + `oxide/install.ts` + `ops/` | **instalar um servidor pela API, do zero** |
| 5 | start/stop/restart + descoberta de processo | subir e derrubar pela API |
| 6 | vigia da Steam + `server-auto-update` | detectar build novo e atualizar |
| 7 | `oxide/plugins.ts` + rota | instalar `.cs` pela API |
| 8 | Painel: login, lista, criar, página do servidor, operações, plugins | o critério de aceite inteiro, pela tela |
| 9 | `README.md`, `.env.example`, PM2, git push | `git clone` numa máquina limpa funciona |

A etapa 4 é o marco: é ela que entrega a frase "um botão instala o servidor".

---

## O que **não** copiar por engano

Lista curta do que parece útil e não é, na Fase 1:

- `core/src/updates/*` — auto-update do agente (D2);
- `launcher.mjs` e `current.json` — idem;
- `openapi.yaml` e o teste que compara rotas com o YAML — o custo por rota nova
  não se paga enquanto a API está mudando de forma. Volta na Fase 2;
- `.githooks/`, `.github/` — sem CI, por decisão;
- `data/rustagent.db` — o banco antigo tem ~30 migrações de coisas que não
  existem aqui. O novo nasce vazio.

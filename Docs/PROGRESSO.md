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

- [x] `steam/vdf.ts`, `steam/builds.ts` (copiados)
- [x] `steam/update-watcher.ts` (15 min, cede a vez ao lock, três tentativas por
      build com uma hora entre elas)
- [x] `server-auto-update` com contagem no chat (em `ops/service.ts`)
- [x] `http/routes/steam-updates.ts`
- [x] **verificado**: o `POST .../steam-update/check` consultou o catálogo da Steam
      de verdade e trouxe o build publicado (24613624); com nada instalado,
      `updateAvailable` fica `false` — a trava 2, que impede o agente de "atualizar"
      uma instalação que não existe

## Etapa 7 — Plugins

- [x] `oxide/plugins.ts` (listar, instalar, remover, reload)
- [x] `http/routes/plugins.ts` com upload multipart
- [x] travas: regex do nome, caminho conferido, limite de tamanho, conteúdo que
      precisa parecer C#
- [x] **verificado**: enviar um `.cs` grava em `Servers\<id>\oxide\plugins` e diz
      que o servidor parado carrega no próximo start; um arquivo que não é C# é
      recusado com a frase que ensina; `core/test/plugins.test.ts` cobre a
      travessia de caminho (10 testes, todos passando)

## Etapa 8 — Painel

- [x] base: layout, tema e `ui/*` trazidos do painel antigo; `lib/api.ts` novo
      (cliente único, com o CSRF em memória)
- [x] `/entrar` — login de operador + CSRF
- [x] `/` — cartões dos servidores + criar (a lista e a visão geral viraram **uma
      tela só**: duas telas com o mesmo conteúdo é manutenção dobrada)
- [x] `/servidor?id=<id>` — visão, operações (log ao vivo com barra de progresso),
      plugins. **Query string, e não rota dinâmica**: o export estático exigiria
      saber os ids em tempo de build, e eles nascem em tempo de execução
- [x] `/config` — o agente (versão, tempo de pé) e como mudar a configuração
- [x] `npm run build -w panel` gera 9 páginas estáticas e o core serve `panel/out`
- [x] **verificado**: `GET /` devolve o painel; senha errada recusa com
      `INVALID_CREDENTIALS`; o POST **sem** o header de CSRF é barrado com 403 e
      **com** ele cria o servidor (201)

## Etapa 10 — O acervo de plugins (Fase Administração, bloco 1)

Ver [10-FASE-ADMINISTRACAO.md](10-FASE-ADMINISTRACAO.md), seção 1.

- [x] migração **002**: `plugins` (a biblioteca) e `server_plugins` (o que cada
      servidor ativou), com os dois `sha256` que respondem "há atualização?"
- [x] migração **003**: o plugin **custom** de um servidor. `plugins` ganha
      `server_id` (NULL = biblioteca) e passa a ter chave sintética — o nome
      deixou de ser único, porque dois servidores podem ter customs homônimos
      com conteúdos diferentes
- [x] `db/plugins-repository.ts` — as duas tabelas, sem tocar em disco
- [x] `oxide/plugin-metadata.ts` — `[Info(...)]`/`[Description(...)]` lidos do
      próprio `.cs`, mais o sha256. **Sem formulário de metadados**: seria a
      segunda fonte para o mesmo fato
- [x] `oxide/library.ts` — enviar (rede e custom), remover, ligar, desligar,
      aplicar e **adotar**, mais a trava do homônimo já ligado
- [x] rotas: `/api/plugins` (biblioteca), `POST /api/servers/:id/plugins`
      (custom) e `PUT /api/servers/:id/plugins/:pluginId`
- [x] painel: `/plugins` (a biblioteca, tabela) e a aba do servidor em **duas
      colunas** — disponíveis (com arrastar-e-soltar) e ativos
- [x] migração **004**: `requires` e `plugin_refs` — de quem cada plugin
      depende, lido do próprio `.cs`
- [x] **a pasta manda no acervo**: o agente varre `Plugins\` e `Plugins\<id>\` no
      boot e a cada abertura de tela. Copiar trinta `.cs` de uma vez vale tanto
      quanto trinta uploads. Arquivo removido da pasta **não** apaga a linha
- [x] **dependências**: `missingRequires` avisa o que falta ao ligar (sem
      impedir — o Oxide segura o plugin até a dependência entrar), e tirar um
      plugin do qual outros dependem é recusado com os nomes de quem cai
- [x] os seis `OrigemZ*` copiados de `F:\Projects\Rust\Plugins` para `Plugins\`
- [x] **verificado**: 53 testes passando. `plugin-library.test.ts` (36) — ligar
      copia e grava o `applied_sha`; desligar apaga o `.cs` e **preserva**
      `oxide\config\<Nome>.json`; o custom não vaza para outro servidor; o
      homônimo é recusado; a adoção traz o que já estava lá sem apagar nada; a
      pasta alimenta o acervo; tirar o `OrigemZAgent` avisa quem cai junto.
      `migrations.test.ts` (7) — a 003 preserva plugin e ligações da 002.
      `tsc`, `build -w panel` e os dois `lint` limpos
- [ ] **na máquina**: reiniciar o agente e ligar o `OrigemZAgent` no `server01`

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

- **2026-08-14** — o `devserver` e o fallback para o layout antigo **não vieram**:
  numa árvore nova não existe instalação anterior a acomodar, e isso simplificou
  quatro funções de `config.ts`.

- **2026-08-14** — a lista de jogadores online sai do `playerlist` **nativo** do
  Rust, e não de um plugin. É o que mantém a Fase 1 sem depender de plugin
  nenhum — inclusive na contagem regressiva do `server-auto-update`, que usa
  "servidor vazio" para encurtar o aviso.

- **2026-08-14** — **enviar um plugin não o aplica nos servidores.** O briefing
  não decidia isso, e o caminho automático era tentador: subir o `.cs` e
  recarregar em todo mundo que já o usa. Ficou manual, servidor a servidor. Cinco
  servidores no ar recarregando um plugin porque alguém arrastou um arquivo é um
  efeito que ninguém pede — e um plugin que não compila derrubaria os cinco de
  uma vez, em vez de um só, com alguém olhando. A API devolve `pendingServers` e
  a tela do servidor mostra o aviso de atualização pendente.

- **2026-08-14** — a **adoção nunca sobrescreve o acervo**. Um `.cs` que já
  estava em `oxide\plugins` e cujo nome já existe no acervo não substitui o
  arquivo de lá: a linha nasce com o `applied_sha` do disco, e a divergência
  aparece na tela como "há versão nova para aplicar". Escolher um lado
  sozinho — qualquer um dos dois — sobrescreveria trabalho de alguém em silêncio.

- **2026-08-14** — **o plugin custom existe, e é de um servidor só** (migração
  003, decidida depois do briefing). O desenho original tinha um lugar só, a
  biblioteca de rede, e faltava o caso comum: o `.cs` que só faz sentido naquele
  servidor. O custo foi trocar a chave de `plugins` — o nome deixou de ser único,
  porque `pvp1` e `pvp2` podem ter cada um o seu `MeuEvento.cs` com conteúdo
  diferente, que é justamente o que "custom" quer dizer. Daí a chave sintética e
  os dois índices parciais: um `UNIQUE(name, server_id)` comum não serviria,
  porque no SQLite dois NULL são distintos entre si e a biblioteca aceitaria dois
  "Kits".

- **2026-08-14** — **`// Requires:` não é comentário.** É diretiva do Oxide: ele
  não carrega o plugin enquanto a dependência não estiver carregada. Três dos
  `OrigemZ*` dependem do `OrigemZAgent`, e sem ler isso o agente deixaria alguém
  tirar o agente do ar derrubando os outros três em silêncio — com o sintoma
  aparecendo no jogo, sem nada ligando uma coisa à outra. Daí a migração 004 e a
  recusa com confirmação.

- **2026-08-14** — a leitura de `[PluginReference]` **casava dentro de
  comentários**. Os nossos plugins explicam o mecanismo em prosa
  (`// Consumida por outro plugin com [PluginReference] + Call(...)`), e a
  primeira versão da regex saía dali com `memoria`, `mapa` e `System` como se
  fossem dependências. Exigir o tipo `Plugin` logo após o `]` resolveu. Metadado
  errado é pior que ausente: a tela avisaria que tirar um plugin quebra outro que
  nem existe, e quem lesse isso duas vezes pararia de ler os avisos.

- **2026-08-14** — a **pasta é um caminho de entrada de primeira classe**. O
  upload pelo painel não pode ser o único jeito de um `.cs` entrar: quem tem
  trinta plugins num repositório os copia de uma vez. O agente varre `Plugins\` e
  `Plugins\<id>\` no boot e a cada abertura de tela. O inverso NÃO vale — arquivo
  que sumiu da pasta não apaga a linha, porque a cascata levaria junto o registro
  de quem ativou o quê.

- **2026-08-14** — a **adoção liga por NOME, não por id**, e respeita quem já
  está ligado. O teste pegou isto: com a biblioteca e um custom homônimos, a
  varredura adotava o desligado por cima do arquivo em disco, e a tela passava a
  mostrar DOIS plugins ligados para um `.cs` só — com o Oxide rodando um e sem
  dizer qual. O arquivo em disco pertence a quem está ligado ali.

- **2026-08-14** — descoberto num teste: uma linha em `servers` sem o
  `Configs\<id>.ini` correspondente (um `.ini` apagado à mão) deixa o id
  **reservado** — `POST /api/servers` recusa com 409 por causa de um servidor que
  não aparece em lista nenhuma. O supervisor passou a **avisar no boot**, com o
  que fazer. Apagar a linha sozinho seria pior: nas fases seguintes ela leva
  junto, em cascata, o histórico daquele servidor.

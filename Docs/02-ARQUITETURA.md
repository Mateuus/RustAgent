# 02 — Arquitetura

## A árvore, inteira

Tudo mora dentro de `F:\Projects\RustAgent`. Não há pasta irmã, não há `.bat`
na raiz do disco, não há `Tools\` do lado de fora. Copiar esta pasta para o
dedicado copia o projeto.

```
RustAgent/
├── package.json            workspaces: core + panel  (npm, não pnpm)
├── package-lock.json       versionado
├── tsconfig.base.json      strict + noUncheckedIndexedAccess
├── ecosystem.config.cjs    PM2: um processo, modo fork
├── .env.example            configuração do AGENTE, comentada
├── .env                    (não versionado)
├── .gitignore
├── README.md
│
├── Docs/                   estes documentos
│
├── core/                   o serviço (Node + TypeScript)
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── index.ts            bootstrap e desligamento limpo
│   │   ├── config.ts           .env + Configs\*.ini -> config validada
│   │   ├── logger.ts           pino
│   │   ├── util.ts
│   │   ├── db/                 SQLite
│   │   │   ├── database.ts
│   │   │   ├── migrations.ts
│   │   │   ├── schema-version.ts
│   │   │   ├── servers-repository.ts
│   │   │   └── plugins-repository.ts   a biblioteca e o que cada um ativou
│   │   ├── rcon/               cliente WebRCON
│   │   │   ├── client.ts  frames.ts  socket.ts  url.ts  errors.ts
│   │   │   └── typed-emitter.ts
│   │   ├── servers/            multi-servidor
│   │   │   ├── ports.ts        a grade de portas
│   │   │   ├── registry.ts     quem existe, em memória
│   │   │   ├── create-server.ts   POST /api/servers
│   │   │   ├── context.ts      o que um servidor ligado tem
│   │   │   └── supervisor.ts   ligar/desligar com o agente no ar
│   │   ├── steam/              SteamCMD e builds
│   │   │   ├── steamcmd.ts     ####  NOVO: instala e roda o SteamCMD
│   │   │   ├── builds.ts       instalado (.acf) vs publicado
│   │   │   ├── vdf.ts          o parser do formato da Valve
│   │   │   └── update-watcher.ts
│   │   ├── oxide/              ####  NOVO
│   │   │   ├── install.ts      baixa e aplica o Oxide.Rust.zip
│   │   │   ├── plugins.ts      o .cs de UM servidor, em disco
│   │   │   ├── plugin-metadata.ts  [Info(...)] e sha256 do .cs
│   │   │   └── library.ts      o acervo: enviar, ligar, adotar
│   │   ├── ops/                as operações
│   │   │   ├── operations.ts   a máquina de estados + trava + log
│   │   │   ├── server-process.ts   subir/derrubar o RustDedicated
│   │   │   └── run.ts          spawn com transcrição de saída
│   │   ├── auth/
│   │   │   ├── operator.ts     ####  NOVO: login do operador (scrypt)
│   │   │   └── csrf.ts
│   │   └── http/
│   │       ├── server.ts  auth.ts  schemas.ts  error-response.ts
│   │       ├── server-scope.ts     resolve :serverId nas rotas
│   │       └── routes/
│   │           ├── health.ts  auth.ts  servers.ts  server.ts
│   │           ├── operations.ts  plugins.ts  steam-updates.ts
│   └── test/
│
├── panel/                  o painel (Next.js, export estático)
│   ├── package.json  next.config.mjs  tailwind.config.ts
│   ├── src/app/            rotas: /entrar /servidores /servidor /plugins /config
│   ├── src/components/
│   └── src/lib/
│
└── (em runtime, não versionado)
    ├── Configs/            <id>.ini, um por servidor + server.example.ini
    ├── Servers/<id>/       a instalação do jogo (dezenas de GB)
    ├── SteamCMD/           o cliente, UM para a máquina inteira
    ├── Logs/<id>/          o log do RustDedicated e o do SteamCMD
    ├── Backups/<id>/       cópias do oxide\ antes de reinstalar
    ├── Plugins/            a BIBLIOTECA: um .cs, uma vez, para todos
    │   └── <id>/           os plugins CUSTOM daquele servidor
    └── data/rustagent.db   o SQLite
```

`Configs\server.example.ini` **é versionado** — é o modelo de onde todo `.ini`
novo nasce. Todo o resto de runtime está no `.gitignore`.

---

## As camadas, e a direção das setas

```
   http/routes  ──►  ops/ · servers/ · steam/ · oxide/  ──►  rcon/ · db/ · config
        │                        │
        └────────────────────────┴──►  nada volta. Camada de baixo não
                                       importa camada de cima.
```

Três regras que valem para sempre:

1. **Rota não decide regra.** `http/routes/*` traduz HTTP: lê o corpo, chama
   quem sabe, formata a resposta. A mensagem de erro em português nasce no
   módulo da regra, não na rota — assim ela é a mesma pela API e pelo painel.
2. **Quem escreve em disco é um só.** O `.ini` de um servidor tem um dono
   (`servers/create-server.ts` e `servers/supervisor.ts`, pela mesma função
   `applyIniValues`). Duas implementações de "trocar uma chave do .ini" é como
   se perde um comentário ou uma senha.
3. **Nada de estado global.** O que um servidor tem vive no `ServerContext`
   dele. Um `Map` de contextos, e não sete variáveis de módulo.

---

## Fonte da verdade — quem manda em quê

Esta tabela é a que resolve discussão:

| Informação | Fonte da verdade | Quem espelha |
|---|---|---|
| existe um servidor `<id>`? | `Configs\<id>.ini` (o arquivo) | tabela `servers` |
| senha do RCON, portas, mapa, seed, hostname | o `.ini` daquele servidor | — |
| ligado/desligado | `SERVER_ENABLED` no `.ini` | coluna `enabled` |
| o jogo está instalado? | `Servers\<id>\RustDedicated.exe` em disco | — |
| build instalado | `Servers\<id>\steamapps\appmanifest_258550.acf` | cache em memória |
| build publicado | `steamcmd +app_info_print 258550` | cache em memória |
| o servidor está no ar? | o RCON responde | não o processo existir |
| histórico de operações | memória (as 20 últimas) | — |

**Por que o `.ini` continua sendo a fonte, e não o banco.** Ele é editável à
mão, sobrevive a um banco corrompido, e é o formato que a pessoa que administra
o servidor já entende. O banco é o **espelho** que o painel lê rápido: uma
consulta em vez de N leituras de arquivo. Quando os dois divergem, o `.ini`
ganha — a reconciliação acontece no boot e a cada mudança pelo painel.

---

## O ciclo de vida de um servidor

```
   (nada)
     │  POST /api/servers
     ▼
  CADASTRADO            Configs\<id>.ini + linha em `servers`
     │                  enabled=0, jogo ausente
     │  operação server-install
     ▼
  INSTALADO             Servers\<id>\RustDedicated.exe + oxide\
     │                  ainda enabled=0
     │  PATCH /api/servers/<id> {enabled:true}
     ▼
  OPERADO               o agente montou o contexto: RCON, relógios,
     │                  operações completas. O jogo pode estar parado.
     │  operação server-start
     ▼
  NO AR                 RustDedicated rodando, RCON conectado
```

Cada seta é um clique no painel, e cada estado responde uma pergunta diferente
na tela. A separação entre **INSTALADO** e **OPERADO** existe porque montar o
contexto de um servidor sem jogo em disco produz um cliente RCON reconectando
para sempre numa porta onde nunca haverá processo — e um painel que mostra
"fora do ar" um servidor que nunca esteve no ar.

---

## A grade de portas

Cada servidor abre **quatro** portas, e elas andam em blocos espaçados de 100:

| Bloco | game (UDP) | rcon (TCP) | query (UDP) | app (TCP) |
|---|---|---|---|---|
| 0 | 28015 | 28016 | 28017 | 28082 |
| 1 | 28115 | 28116 | 28117 | 28182 |
| 2 | 28215 | 28216 | 28217 | 28282 |
| … | … | … | … | … |

`PORT_BLOCK_STRIDE = 100`, `MAX_PORT_BLOCK = 374`. Um servidor novo recebe o
**primeiro bloco livre**; quem quiser escolhe. O agente recusa cadastrar duas
vezes a mesma porta, e recusa **iniciar** quando a porta já está ocupada na
máquina por outro processo.

A `app` (Rust+/companion) não é opcional com vários servidores: sem ela, o
segundo servidor tenta o 28082 padrão e o companion dele simplesmente não
funciona, sem dizer por quê.

---

## O que cada servidor "operado" tem

O `ServerContext` é o que nasce quando um servidor é ligado, e o que morre
quando é desligado:

- **um `RconClient`** — conexão WebSocket persistente com aquele servidor, fila
  de comandos, reconexão com backoff e correlação por `Identifier`;
- **um `OperationsService`** — as operações **daquele** servidor, com o log e a
  trava;
- **os relógios** — hoje só o do vigia da Steam e o do cache de jogadores. Na
  Fase 1 são poucos de propósito: cada relógio é uma coisa que continua batendo
  depois que alguém desligou o servidor, se o `stop()` esquecer dele.

Servidor **desligado** não tem contexto — tem cadastro e um serviço de
operações **restrito** (só instalar). É o que permite instalar o jogo de um
servidor que ainda não pode ser operado.

---

## Windows, dito em voz alta

O projeto é declaradamente Windows: `steamcmd.exe`, `RustDedicated.exe`,
`taskkill`, caminhos com `\`. Fingir portabilidade custaria abstrações que
ninguém testaria em Linux.

Três consequências que aparecem no código:

- **sinal não é sinal** — `process.kill(pid, 'SIGINT')` no Windows chama
  `TerminateProcess`; o handler do processo alvo não roda. Desligamento
  ordenado do servidor de jogo é pelo **RCON** (`quit`), nunca por sinal;
- **o servidor não é filho do agente** — ele sobe destacado (`detached`), para
  que reiniciar o agente (ou o PM2) não derrube quem está jogando;
- **arquivo em uso não se sobrescreve** — o SteamCMD é recusado com o servidor
  no ar, e o Oxide também.

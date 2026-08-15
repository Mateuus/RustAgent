# 14 — Briefing: o catálogo de itens e o editor de interfaces

> **Este documento é um briefing de execução.** Ele existe para ser entregue
> inteiro a quem vai construir — humano ou agente — sem precisar de mais
> contexto do que os arquivos que ele mesmo aponta.

Projeto: `F:\Projects\RustAgent` (Windows, Node 20+, npm workspaces —
`core` = Fastify/TypeScript, `panel` = Next.js em export estático servido pelo
próprio core).

Esta fase entrega **duas fundações que o resto vai consumir**:

```
  o CATÁLOGO DE ITENS    ~1250 itens do jogo, no agente, sobrevivendo ao
                         servidor desligado
  o EDITOR DE INTERFACE  o menu do jogo desenhado no painel, e o Menu
                         Principal já pronto
```

As duas são pré-requisito da loja, dos kits e do VIP — que estão sendo
construídos **em paralelo**, por outra frente, a partir do
[15-BRIEFING-VIP-LOADOUTS-KITS.md](15-BRIEFING-VIP-LOADOUTS-KITS.md). A seção
final deste documento diz exatamente o que é seu e o que não é.

---

## Antes de escrever qualquer linha

Leia, nesta ordem:

| Arquivo | O que você tira dele |
|---|---|
| [02-ARQUITETURA.md](02-ARQUITETURA.md) | camadas, fonte da verdade, ciclo de vida |
| [03-DECISOES.md](03-DECISOES.md) | D1–D11: o porquê de cada escolha já feita |
| [06-API.md](06-API.md) | o formato de erro e o padrão das rotas |
| [07-PAINEL.md](07-PAINEL.md) | o que a tela pode e não pode fazer |
| `core/src/db/migrations.ts` | o mecanismo, e **onde a sua numeração começa** |
| `core/src/db/players-repository.ts` | o padrão de repositório a copiar |
| `core/src/players/presence.ts` | como um relógio de sincronização é escrito aqui |
| `core/src/game/plugin-contract.ts` | **o contrato com o plugin, e o formato dele** |
| `core/src/game/monuments.ts` | o padrão de "leio uma vez e guardo" |
| `core/src/oxide/permissions.ts` | como se fala com o console e se lê a resposta |
| `core/src/servers/context.ts` | o gancho `onRconConnected` |
| `panel/src/app/plugins/page.tsx` | o padrão de tela de REDE |

E **estude o projeto anterior**, em `F:\Projects\Rust\RustAgent`. Ele já
construiu as duas coisas desta fase, e o plugin que está em `Plugins\` **é a
ponta daquele trabalho** — o cabeçalho do `OrigemZUI.cs` aponta para arquivos
que ainda não existem aqui:

| Lá | O que é |
|---|---|
| `core/src/game/item-catalog.ts` | o catálogo, com a invalidação por protocolo |
| `core/src/game/item-catalog-sqlite.ts` | a persistência dele |
| `core/src/db/item-catalog-repository.ts` | a tabela |
| `core/src/http/routes/items.ts` | as rotas |
| `core/src/types/ui-document.ts` | o modelo de interface, em zod |
| `core/src/types/ui-transport.ts` | **o contrato com o OrigemZUI** |
| `core/src/game/ui-cui.ts` | modelo → CuiElement (é aqui que mora a armadilha) |
| `core/src/game/ui-images.ts` | as imagens do CUI |
| `core/src/game/ui-sync.ts` | empurrar a carga inicial, servir tela sob demanda |
| `core/src/db/ui-documents-repository.ts` | onde os documentos moram |
| `core/src/http/routes/ui-documents.ts` | as rotas |
| `panel/src/lib/ui-doc/` | `model.ts`, `factory.ts`, `geometry.ts`, `to-cui.ts`, `validate.ts`, `tree.ts`, `color.ts`, `sprites.ts` |
| `panel/src/lib/ui-doc/presets/main-menu.ts` | **o Menu Principal, pronto** (1319 linhas) |
| `panel/src/components/ui-editor/` | o editor |
| `panel/src/app/interface/page.tsx` | a tela |

> **O `Docs\OrigemZUI\PLANO.md` que o plugin cita NÃO existe mais** — a pasta
> `Docs` do projeto anterior está vazia. O código é a única fonte, e é por isso
> que ele precisa ser lido de verdade, e não copiado no escuro.

**Portar não é copiar.** As convenções mudaram: datas são `INTEGER` epoch ms
(o projeto anterior usava TEXT ISO), o erro é `ApiError(code, message, status)`
com mensagem em português, e o comentário de cabeçalho explica **por que o
arquivo existe e o que dá errado sem ele**. Ver qualquer arquivo do `core/src`
de hoje.

**Confira antes de começar:** `npm test -w core` deve estar verde (189 testes).

---

## O que já existe, e que muda suas premissas

- **o `OrigemZAgent` já sabe listar os itens.** MEDIDO no `server01`:

  ```
  origemz.items [offset] [limit]

  {"ok":true,"count":1252,"offset":0,"limit":250,"items":[
    {"shortname":"hat.wolf","displayName":"Wolf Headdress",
     "itemId":-1478212975,"category":"Attire","maxStack":1,
     "hasCondition":false}, …]}
  ```

  Ele monta de `ItemManager.itemList` e guarda em memória — não existe comando
  NATIVO que liste itens (procuramos: `find item` só devolve `spawnitem`,
  `dropworlditems` e afins, todos por shortname);

- **o `serverinfo` devolve `Protocol`** (`"2632.287.1"` hoje, com
  `"Version": 2632`). É a versão do protocolo do jogo, e é a chave certa para
  saber se o catálogo envelheceu;

- **o `OrigemZUI` já existe e não sabe desenhar.** Ele recebe do agente uma
  lista de `CuiElement` PRONTA e chama `CuiHelper.AddUi`. A conversão mora no
  agente de propósito — as armadilhas do CUI falham em SILÊNCIO no cliente
  (nome de campo minúsculo, botão que são dois elementos, cor em float), e no
  agente elas têm teste;

- **o gancho `onRconConnected`** já existe em `servers/context.ts` e é onde a
  BanList reconcilia, o mapa é desenhado e a presença é conferida;

- **a aba Configurações → Oxide** já mostra grupos e permissões daquele
  servidor (`/api/servers/:id/oxide/*`).

---

## PARTE 1 — O catálogo de itens

### O problema, dito por quem administra

Hoje, para montar um kit ou uma entrega, é preciso decorar `rifle.ak`. A tela
precisa oferecer busca por "Assault Rifle" — e precisa oferecer isso **com o
servidor desligado**, que é quando ninguém está jogando e dá para trabalhar em
paz.

Hoje a lista só existe enquanto um servidor está no ar. É esse o defeito.

### A tabela (migração 007)

> **Sua faixa de migrações é 007 a 009.** A 006 é a de jogadores; a outra frente
> usa da 010 em diante. Nunca edite uma migração já aplicada.

```sql
CREATE TABLE items (
  -- A CHAVE É O SHORTNAME: é ele que todo comando do jogo recebe
  -- (`inventory.give`, o kit, a entrega), e é ele que não muda
  -- entre wipes.
  shortname     TEXT PRIMARY KEY,

  -- "Assault Rifle". É por ele que a tela busca.
  display_name  TEXT NOT NULL,

  -- O id numérico do jogo. Guardado porque alguns comandos o
  -- pedem, e porque ele é o que muda quando a Facepunch renomeia
  -- um item mantendo o shortname.
  item_id       INTEGER NOT NULL,
  category      TEXT NOT NULL,
  max_stack     INTEGER NOT NULL,
  has_condition INTEGER NOT NULL CHECK (has_condition IN (0, 1)),

  -- De qual leitura esta linha veio. Ver a varredura, adiante.
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);

CREATE INDEX idx_items_name ON items (display_name COLLATE NOCASE);
CREATE INDEX idx_items_category ON items (category);
```

Mais uma linha em `meta` (a tabela de pares chave/valor da migração 001) com o
**protocolo** que gerou o catálogo. Ela é o que responde "preciso refazer?".

### A varredura: quando o catálogo é refeito

**Não é por TTL.** Catálogo de item não envelhece com o tempo: ele muda quando o
JOGO muda, e só então. Um TTL de dez minutos refaria o trabalho 144 vezes por
dia para descobrir 143 vezes que nada mudou — e ainda ficaria dez minutos errado
depois de um update.

A pergunta tem resposta exata: guarde o `Protocol` do `serverinfo` junto do
catálogo. Diferente → releia. Igual → não faça nada.

E o gatilho vem de graça: quando a Facepunch publica um update, o servidor
reinicia, o RCON cai e reconecta — **`onRconConnected`**, o mesmo lugar em que a
lista de banidos reconcilia hoje.

**As três coisas que a releitura precisa fazer:**

| Situação | O que acontece |
|---|---|
| item novo no jogo | entra, com `first_seen` de agora |
| item que continua | `last_seen` atualizado, nada mais |
| item que **sumiu** do jogo | **fica na tabela**, e a resposta o marca |

O item que sumiu não é apagado, e isso não é preguiça: um kit montado no mês
passado aponta para ele, e apagar a linha faria o kit ficar com um shortname
órfão que ninguém consegue explicar. Marcado, a tela do kit consegue dizer
"este item não existe mais nesta versão do jogo".

**Nunca aja sobre um palpite.** Se a leitura falhar no meio (RCON caiu, resposta
truncada, plugin fora do contrato), **descarte a rodada inteira** e mantenha o
catálogo anterior. Um catálogo pela metade é pior que um catálogo velho: o kit
que usa o item faltante quebraria sem motivo aparente. A resposta paginada tem
`count` — use-o para saber se você recebeu tudo.

### As rotas

```
GET  /api/items?q=<busca>&category=&limit=&offset=
GET  /api/items/:shortname
GET  /api/items/categories
POST /api/items/refresh          força a releitura (precisa de um servidor no ar)
```

- **paginada**, com `total`, como toda listagem deste projeto;
- a resposta diz **de quando é o catálogo**: `protocol`, `updatedAt`, `total` e
  `source` (`"servidor"` ou `"banco"`). Uma tela que mostra 1252 itens sem dizer
  que eles são de três versões atrás é uma tela que mente;
- com o banco vazio e nenhum servidor no ar, responda **200 com lista vazia e
  uma frase** dizendo que o catálogo é preenchido quando o primeiro servidor
  subir. Não é erro — é o estado de uma instalação nova.

### A tela

**Sidebar → Itens**, ícone lucide `Package`, entre *Jogadores* e *Banidos*.
Tabela (é tela de comparação): shortname, nome, categoria, empilhamento,
"tem condição". Busca por nome ou shortname, filtro por categoria, paginação de
verdade.

No topo, de onde veio e de quando é, com o botão *Atualizar agora* — desabilitado
com nenhum servidor no ar, e com o motivo no `title`.

---

## PARTE 2 — O editor de interfaces

### O que se quer, dito pelo dono

> *"A interface do menu é configurável totalmente dentro do servidor. No Agent
> vamos ter o criador de Interface, e já deixamos pronta a Interface do Menu
> Principal. Os servidores só vão usar e determinar o que aparece ou não."*

Isso define a divisão, e ela é a decisão mais importante desta parte:

```
  O DESENHO é da REDE          um documento no agente, editado uma vez
  O QUE APARECE é do SERVIDOR  cada servidor liga e desliga pedaços
```

Uma interface por servidor faria seis cópias do mesmo menu, e a sétima mudança
seria feita em cinco delas. Um documento só, sem escolha por servidor, faria o
PVE anunciar a loja que ele não tem.

### As tabelas (migração 008)

```sql
CREATE TABLE ui_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- "menu-principal". Estável, porque o servidor aponta para ele.
  slug     TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL,
  -- O documento inteiro, como JSON. Ver a nota abaixo.
  document TEXT NOT NULL,
  -- Sobe a cada gravação. É o que diz ao servidor que ele está
  -- com uma versão velha na memória do plugin.
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE server_ui (
  server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES ui_documents(id) ON DELETE CASCADE,
  enabled     INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  -- O que ESTE servidor esconde: os ids dos elementos/telas
  -- desligados, como JSON. Vazio = mostra tudo.
  hidden      TEXT NOT NULL DEFAULT '[]',
  applied_revision INTEGER,
  applied_at  INTEGER,
  PRIMARY KEY (server_id, document_id)
);
```

**Por que o documento é uma coluna JSON, e não vinte tabelas.** A pergunta que
se faz é sempre "me dá o documento inteiro" — o editor carrega tudo, o
transporte manda tudo. Normalizar elemento, âncora, cor e ação em tabelas daria
junções para responder o que já cabe numa leitura, e um esquema para migrar a
cada campo novo do editor. O que **precisa** ser normalizado é o que se consulta
de fora: `slug`, `revision` e quem usa.

### O transporte até o jogo

Está resolvido, e o número que manda é este — **MEDIDO no projeto anterior**:

> o menu principal (7 telas, 142 elementos) dá **52.280 bytes**, ou 69.708 em
> base64. O teto do WebRCON é **~50.000**. O primeiro menu real já não cabe.

A causa está na forma: trocar de tela no CUI redesenha tudo, então cada tela
carrega sua cópia do cabeçalho. Sete telas, sete cabeçalhos.

Por isso o contrato é **carga inicial leve, telas sob demanda**:

```
  agente -> plugin   comando de console (a carga inicial: metadados
                     + a tela de ENTRADA), ~8 KB
  plugin -> agente   linha marcada no console, lida no stream do RCON
                     — o mesmo mecanismo de core/src/servers/console-buffer.ts
  agente -> plugin   UMA tela, ~7,5 KB, quando o jogador navega
```

Os comandos que o plugin já expõe (leia o `.cs` para o formato exato):
`origemz.ui.doc`, `origemz.ui.screen`, `origemz.ui.image`, `origemz.ui.open`,
`origemz.ui.close`, `origemz.ui.act`, `origemz.ui.reask`, `origemz.ui.debug`.

**As duas regras da metade puxada**, que valem código:

1. **nada ali pode lançar.** O pedido chega no handler que recebe TODA linha do
   servidor; uma exceção subiria por um caminho que ninguém trata e levaria
   junto o resto do stream;
2. **falha PRECISA virar resposta de erro.** O jogador está com um spinner na
   tela — silêncio o deixa girando para sempre.

**O botão é um comando do CLIENTE.** `origemz.ui.act <token> <actionId>` pode
ser digitado no F1 por qualquer jogador, com os argumentos que ele quiser. Por
isso ele carrega só um ENDEREÇO, e quem decide o que fazer é o plugin, olhando a
tela em que aquele jogador está. **Não invente uma ação que receba dado do
cliente.**

### O Menu Principal já vem pronto

`panel/src/lib/ui-doc/presets/main-menu.ts` do projeto anterior é o menu
completo. Traga-o como **preset**: um documento que nasce no primeiro boot (ou
por um botão *Criar a partir do modelo*), e que dali em diante é editável como
qualquer outro.

Traga junto o que ele usa: `model.ts` (o modelo e os limites), `factory.ts`,
`geometry.ts`, `color.ts`, `sprites.ts`, `tree.ts`, `validate.ts`, `to-cui.ts`.

**O modelo vive nos dois lados, e isso é deliberado**: o painel tem o dele
(TypeScript, para o editor) e o core tem o schema zod (`ui-document.ts`), porque
o core RECEBE — e "o cliente já validou" nunca foi garantia de nada. Mudar o
modelo exige mudar os dois arquivos, e o comentário precisa dizer isso.

### As rotas

```
GET    /api/ui/documents                 a lista (id, slug, nome, revisão, quem usa)
POST   /api/ui/documents                 cria (em branco ou a partir do preset)
GET    /api/ui/documents/:id             o documento inteiro
PUT    /api/ui/documents/:id             grava (sobe a revisão)
DELETE /api/ui/documents/:id             remove
POST   /api/ui/documents/:id/preview     modelo -> CuiElement, sem tocar em servidor

GET    /api/servers/:id/ui               o que este servidor usa e o que esconde
PUT    /api/servers/:id/ui               { documentId, enabled, hidden[] }
POST   /api/servers/:id/ui/push          empurra agora
```

O `preview` existe para o editor conferir a conversão sem servidor de jogo
nenhum — e é ele que dá teste à parte que falha em silêncio.

### A tela

**Sidebar → Interface**, ícone lucide `LayoutTemplate`, depois de *Plugins*.

O editor do projeto anterior (`panel/src/components/ui-editor/`) é o ponto de
partida. O mínimo desta fase:

- a lista de documentos, com quem usa cada um;
- o editor: árvore de telas e elementos à esquerda, a tela desenhada no meio,
  as propriedades do elemento selecionado à direita;
- **o desenho precisa parecer o jogo**: proporção 16:9 e as âncoras do CUI, não
  um `<div>` solto que engana;
- na página de um servidor, em **Configurações → Interface**: qual documento ele
  usa, o que ele esconde, e *Aplicar agora* — com a revisão aplicada ao lado, e
  o aviso quando ela está atrás da atual.

---

## Regras que não se negociam

1. **Rota nova entra no escopo `/api`** de `core/src/http/server.ts`. O guarda de
   autenticação está lá; rota fora dele nasce sem autenticação.
2. **Mensagem de erro em português, nascida no módulo que conhece a regra** —
   nunca reescrita na tela. `ApiError(code, message, status)`.
3. **Ausente vira travessão, nunca zero** (`panel/src/lib/format.ts`).
4. **O que a tela mostra sai do agente.** A conversão para CUI mora no core,
   onde ela tem teste.
5. **Não duplique o que já existe.** Os itens vêm de `origemz.items`; os grupos
   vêm de `/api/servers/:id/oxide/*`; quem está online vem do `PlayersReader`.
6. **Migração nova vai no fim de `MIGRATIONS`**, e a sua faixa é **007–009**.
7. **A listagem é paginada desde a primeira versão.**
8. **Nada de `confirm()` do navegador**: `ConfirmButton` e `toast`.
9. **O catálogo nunca é atualizado pela metade.** Falhou no meio, descarta a
   rodada.
10. **Nada acima de C# 6 nos plugins** — o compilador do Oxide para nesse teto,
    e o erro aparece longe da causa. (Só se você mexer no `.cs`, o que esta fase
    não exige.)

---

## Como verificar

```powershell
npx tsc --noEmit -p core/tsconfig.json
npm run typecheck -w core
npm test -w core
npm run lint -w core
npm run build -w panel
npm run lint -w panel
```

Testes que valem a pena existir (vitest, em `core/test/`):

- o catálogo com o MESMO protocolo não é relido — e com protocolo diferente, é;
- um item que sumiu do jogo **continua na tabela**, marcado;
- uma leitura que falha no meio **não** apaga nem corrompe o catálogo anterior;
- a resposta de `origemz.items` paginada é montada inteira (use `count`);
- o mesmo documento de interface convertido para CUI duas vezes dá o mesmo
  resultado, e um documento inválido é recusado ANTES de virar comando;
- a carga inicial cabe no teto do RCON — meça o preset do Menu Principal e
  falhe o teste se passar de 50.000 bytes.

Na máquina, com o `server01`:

1. subir o servidor e ver o catálogo aparecer sozinho;
2. desligar o servidor e conferir que a tela de itens **continua** respondendo;
3. abrir o menu no jogo e navegar entre telas.

---

## A fronteira com a outra frente

Outra pessoa está construindo, **ao mesmo tempo**, o VIP, os loadouts por grupo
e a loja de kits ([15-BRIEFING-VIP-LOADOUTS-KITS.md](15-BRIEFING-VIP-LOADOUTS-KITS.md)).
As duas frentes partem do mesmo commit de `main`.

**O que é SEU, e ninguém mais toca:**

```
  core/src/game/item-catalog*.ts        core/src/db/items-repository.ts
  core/src/game/ui-*.ts                 core/src/db/ui-documents-repository.ts
  core/src/types/ui-*.ts                core/src/http/routes/items.ts
  core/src/http/routes/ui.ts            panel/src/lib/ui-doc/**
  panel/src/components/ui-editor/**     panel/src/app/itens/**
  panel/src/app/interface/**            migrações 007, 008, 009
```

**O que é DELE, e você não toca:**

```
  core/src/vip/**                       core/src/kits/**
  core/src/db/vips-repository.ts        core/src/db/kits-repository.ts
  core/src/http/routes/vips.ts          core/src/http/routes/kits.ts
  core/src/http/routes/loadouts.ts      panel/src/app/vips/**
  panel/src/app/loja/**                 migrações 010 em diante
```

**Os quatro arquivos que os dois editam** — e como não brigar:

| Arquivo | Regra |
|---|---|
| `core/src/http/server.ts` | acrescente **um** `register…Routes` no fim do bloco, com comentário. Não reordene o que já está lá |
| `core/src/index.ts` | monte o seu **depois** do que existe, num bloco próprio |
| `panel/src/lib/api.ts` | um bloco de tipos e um bloco de métodos, no fim de cada seção. Nunca reescreva o que existe |
| `panel/src/components/sidebar.tsx` | acrescente só os SEUS itens (`Itens`, `Interface`) |

Se ainda assim der conflito no merge, ele será dessas quatro linhas — resolve-se
mantendo os dois lados.

**O que ele espera de você, e como pedir:** ele monta kits com itens, e vai
precisar do catálogo. O contrato é a **rota** `GET /api/items` — ele consome por
HTTP, na tela dele. Não crie função compartilhada, não exporte repositório para
ele: uma dependência de código entre duas branches em paralelo é o que impede as
duas de compilar sozinhas.

Commits em português, explicando o **porquê** da mudança e o que dava errado
antes — leia o `git log` para pegar o tom. Trabalhe numa branch própria
(`itens-interface`). **Não faça `git push` sem pedir.**

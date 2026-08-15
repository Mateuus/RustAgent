# 15 — Briefing: o VIP, os loadouts por grupo e a loja de kits

> **Este documento é um briefing de execução.** Ele existe para ser entregue
> inteiro a quem vai construir — humano ou agente — sem precisar de mais
> contexto do que os arquivos que ele mesmo aponta.

Projeto: `F:\Projects\RustAgent` (Windows, Node 20+, npm workspaces —
`core` = Fastify/TypeScript, `panel` = Next.js em export estático servido pelo
próprio core).

Esta fase constrói **o que o jogador ganha, e por quanto tempo**:

```
  VIP        comprado na loja ou dado por um admin, com prazo
  LOADOUT    o que cada GRUPO recebe ao nascer
  KITS       venda e resgate — compra, uma vez só, ou a cada N horas
```

O catálogo de itens e o editor de interfaces estão sendo construídos **em
paralelo**, por outra frente, a partir do
[14-BRIEFING-ITENS-E-INTERFACE.md](14-BRIEFING-ITENS-E-INTERFACE.md). A seção
final deste documento diz exatamente o que é seu e o que não é.

---

## Antes de escrever qualquer linha

Leia, nesta ordem:

| Arquivo | O que você tira dele |
|---|---|
| [02-ARQUITETURA.md](02-ARQUITETURA.md) | camadas, fonte da verdade, ciclo de vida |
| [03-DECISOES.md](03-DECISOES.md) | D1–D11: o porquê de cada escolha já feita |
| [06-API.md](06-API.md) | o formato de erro, o padrão das rotas e a seção **Oxide** |
| [07-PAINEL.md](07-PAINEL.md) | o que a tela pode e não pode fazer |
| `core/src/db/migrations.ts` | o mecanismo, e **onde a sua numeração começa** |
| `core/src/db/players-repository.ts` | o padrão de repositório a copiar |
| `core/src/db/bans-repository.ts` | o outro padrão: revogar não apaga |
| `core/src/bans/service.ts` | regra aqui, RCON ali |
| `core/src/bans/expiry-watcher.ts` | **o relógio que cumpre prazo** — o VIP tem o mesmo |
| `core/src/players/presence.ts` | o relógio de sincronização, e as armadilhas dele |
| `core/src/oxide/permissions.ts` | os grupos do Oxide, e como se fala com eles |
| `core/src/http/routes/oxide.ts` | as rotas de grupo que **já existem** |
| `core/src/game/plugin-contract.ts` | o contrato com o plugin, e o formato dele |
| `panel/src/components/oxide-panel.tsx` | a sub-aba Oxide, que você vai complementar |
| `panel/src/app/banidos/page.tsx` | o padrão de tela de REDE |

E **estude o projeto anterior**, em `F:\Projects\Rust\RustAgent`:

| Lá | O que é |
|---|---|
| `core/src/db/vips-repository.ts` | a tabela de VIP e as consultas |
| `core/src/http/routes/vips.ts` | as rotas |
| `core/src/game/loadout-sync.ts` | **como o loadout chega ao jogo** |
| `core/src/http/routes/loadouts.ts` | as rotas |
| `core/src/db/deliveries-repository.ts` | o histórico de entrega, com idempotência |
| `panel/src/app/vips/` | a tela de VIPs |
| `panel/src/components/loadout-editor.tsx` | o editor de loadout |

**Portar não é copiar.** As convenções mudaram: datas são `INTEGER` epoch ms
(o projeto anterior usava TEXT ISO), o erro é `ApiError(code, message, status)`
com mensagem em português, e o comentário de cabeçalho explica **por que o
arquivo existe e o que dá errado sem ele**.

**Confira antes de começar:** `npm test -w core` deve estar verde (189 testes).

---

## O que já existe, e que muda suas premissas

Você **não** começa do zero, e a maior parte do que parece faltar já tem dono:

- **os grupos do Oxide já são lidos e alterados pelo agente.** Configurações →
  Oxide mostra a hierarquia, quem está dentro e o que cada um concede, com
  `GET /api/servers/:id/oxide/permissions` e as rotas de `POST`/`DELETE`. **Não
  reimplemente isso**;

- **a hierarquia de VIP já existe no `server01`**, criada pelo próprio
  `OrigemZVip` ao carregar, a partir do `OrigemZVip.json`:

  ```
  origemz.vip.bronze  →  origemz.vip.silver  →  origemz.vip.gold
        (rank 10)              (rank 20)              (rank 30)
  ```

  MEDIDO: os três existem, **nenhum concede permissão nenhuma** e **ninguém
  está dentro**. Quem cria o grupo é o plugin; quem põe gente nele é você;

- **os plugins já esperam um agente que empurre o estado.** Estes três comandos
  existem hoje, e o cabeçalho deles diz o desenho inteiro:

  | Comando | O que é |
  |---|---|
  | `origemz.vip.sync <base64>` | o agente manda o VIP de TODO mundo |
  | `origemz.loadout.sync <base64>` | o agente manda os KITS de todos os níveis |
  | `origemz.player.loadout <steamId>` | aplica o loadout agora |

  E o cabeçalho do `OrigemZAgent.cs` diz, em voz alta: *"o payload é o estado
  COMPLETO, nunca um delta. Nível que sumiu fica sem kit, e é assim que 'apaguei
  o kit' chega ao jogo"*, e *"a fonte da verdade é o RustAgent"*. O plugin é um
  **hub**: guarda o cache e responde a quem perguntar (quem consome o loadout é
  o `OrigemZPlayer`, pelo hook `GetLoadout`);

- **base64 não é capricho:** o parser de console do Rust **come as aspas** de um
  JSON cru, e o `shortname` chegaria sem elas. Ver `DecodeBase64Payload` no
  plugin;

- **o `skinId` viaja como string** pelo mesmo motivo do SteamID: skin do
  workshop passa de 2^53;

- **a ficha do jogador já existe** (`/jogador?id=`, com abas Identidade,
  Servidores e Histórico) e a base de jogadores é `players`/`player_servers`;

- **o histórico do jogador tem uma tabela** (`player_events`, migração 006) com
  `kind` limitado por `CHECK` a `join|leave|kick|teleport`. Se você quiser
  registrar "ganhou VIP" ali, **isso exige uma migração sua** que amplie o
  `CHECK`.

---

## PARTE 1 — O VIP

### A decisão que estrutura tudo

> *"VIP será comprado pela loja ou setado ao jogador."*

Duas portas, um estado só. E o estado é do **agente**, não do plugin: o plugin
guarda um cache descartável e o repovoa a cada `origemz.vip.sync`. Se a fonte
fosse o jogo, um wipe ou um `oxide.reload` apagaria VIP comprado com dinheiro.

**O VIP é de REDE, e não de servidor.** Quem compra compra da rede — e a
alternativa produziria a pergunta "comprei no PVP e não tenho no PVE?" com a
resposta errada. O que é por servidor é o **grupo do Oxide**, que é como o VIP
vira efeito dentro do jogo.

### A tabela (migração 010)

> **Sua faixa de migrações é 010 a 014.** A 006 é a de jogadores; a outra frente
> usa 007–009. Nunca edite uma migração já aplicada.

```sql
CREATE TABLE vips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- TEXT, como em toda parte: 17 dígitos passam de 2^53.
  steam_id   TEXT NOT NULL,

  -- 'bronze' | 'silver' | 'gold' — o `Tier` do OrigemZVip.json.
  -- TEXT e não um enum fechado: o nível é configurável no plugin,
  -- e um CHECK aqui obrigaria migração a cada nível novo.
  tier       TEXT NOT NULL,

  -- Epoch ms. NULL = permanente (o VIP vitalício existe e é
  -- vendido).
  expires_at INTEGER,

  -- De onde ele veio: 'loja' | 'painel' | 'adotado'.
  origin     TEXT NOT NULL CHECK (origin IN ('loja', 'painel', 'adotado')),
  created_at INTEGER NOT NULL,
  created_by TEXT,

  -- NULL = vale. Revogar NÃO apaga a linha: a segunda discussão
  -- sobre o mesmo jogador precisa da primeira. Mesma regra dos
  -- banimentos (migração 005).
  revoked_at INTEGER,
  revoked_by TEXT
);

-- UM VIP ativo por (jogador, nível). Dois seriam duas datas de
-- vencimento para o mesmo benefício, e nenhuma resposta para "qual
-- vale?".
CREATE UNIQUE INDEX idx_vips_active ON vips (steam_id, tier) WHERE revoked_at IS NULL;
CREATE INDEX idx_vips_expires ON vips (expires_at) WHERE revoked_at IS NULL;
```

**Renovar é estender a linha que existe, e não criar outra.** Quem compra 30
dias em cima de 20 que faltam fica com 50 — e a data nova é
`max(agora, vencimento) + prazo`. Somar a partir de "agora" faria a renovação
antecipada tirar dias de quem pagou, que é o pior jeito de tratar quem paga.

### O relógio, e o que ele faz quando vence

Igual ao `BanExpiryWatcher` — leia aquele arquivo antes: intervalo configurável,
`unref()` no timer, uma rodada por vez, e a primeira rodada no boot (prazos
venceram enquanto o agente esteve parado).

Ao vencer: revoga a linha (`revoked_by` nulo = foi o relógio), **tira o jogador
do grupo do Oxide** em cada servidor e reempurra o `origemz.vip.sync`.

**Um VIP vencido que ninguém tirou é pior que não ter prazo**: o jogador parou
de pagar e continua com o benefício, e quem administra descobre pelo Discord.

### Como o VIP vira efeito no jogo

Dois caminhos, e os dois precisam existir:

1. **o grupo do Oxide** — é o que faz a fila, o chat e os plugins de terceiros
   enxergarem o VIP. Use as rotas que já existem
   (`POST /api/servers/:id/oxide/groups/:group/members`), não fale com o console
   por fora;
2. **o `origemz.vip.sync`** — é o que o `OrigemZAgent` guarda para responder ao
   `GetVipInfo` de quem perguntar (o `OrigemZVip`, o `OrigemZQueue`).

**Os dois são o mesmo estado, empurrado para dois consumidores.** Isso não é
duplicar fonte: a fonte é a tabela `vips`, e ela é reempurrada inteira. Deixar
só um dos dois faria metade dos plugins não enxergar o VIP.

**A reconciliação acontece nos mesmos três momentos da BanList**: boot, servidor
ligado e `onRconConnected`. Um servidor que ficou fora do ar durante a compra
precisa receber o estado quando voltar.

### O nome do grupo não é adivinhado

O grupo de cada nível está no `OrigemZVip.json` daquele servidor
(`Niveis[].Grupo`), que o agente já sabe ler pela rota de configuração de plugin
(`GET /api/servers/:id/plugin-configs/OrigemZVip`). **Leia de lá.** Montar
`origemz.vip.${tier}` na mão é inventar um contrato que o dono do servidor pode
mudar num arquivo — e o sintoma seria o VIP comprado sem efeito nenhum, sem erro
em lugar nenhum.

### As rotas

```
GET    /api/vips?active=1&q=&limit=&offset=    a lista, PAGINADA
POST   /api/vips                               concede/renova
DELETE /api/vips/:steamId/:tier                revoga (a linha fica)
GET    /api/players/:steamId/vips              o que este jogador tem
POST   /api/servers/:id/vips/sync              reempurra agora
```

Na ficha do jogador (`/jogador?id=`), uma aba ou bloco **VIP**: o nível, desde
quando, até quando, de onde veio, e os botões de conceder/revogar.

---

## PARTE 2 — Os loadouts por grupo

### O que se quer, dito pelo dono

> *"O loadout é por grupo: criou um novo grupo, aparece o loadout. Apagou o
> loadout da config, some daquele lugar."*

Ou seja: a lista de loadouts **é derivada dos grupos do Oxide daquele servidor**,
e não uma lista própria que alguém mantém em dia. Grupo novo aparece vazio;
loadout apagado some do jogo na próxima sincronização.

Isso casa com o que o plugin já faz: o `origemz.loadout.sync` recebe o estado
COMPLETO, e *"nível que sumiu fica sem kit"*.

### A tabela (migração 011)

```sql
CREATE TABLE loadouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  -- O NOME DO GRUPO do Oxide (`origemz.vip.gold`, `default`).
  -- Não há chave estrangeira: o grupo vive dentro do servidor, e
  -- não numa tabela nossa. Um grupo apagado no Oxide deixa um
  -- loadout órfão — e a TELA mostra isso, em vez de o banco
  -- apagar sozinho o trabalho de alguém.
  group_name TEXT NOT NULL,

  -- Os itens, como JSON, no formato que o plugin já espera:
  -- [{ slot, shortname, amount, skinId, position }]
  items TEXT NOT NULL DEFAULT '[]',

  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT,

  UNIQUE (server_id, group_name)
);
```

**`slot`, `skinId` e `position` não são invenção sua** — é o
`LoadoutItemPayload` do `OrigemZAgent.cs`. Leia a classe antes de escolher os
nomes, e mantenha `skinId` como **string**.

### O sincronismo

Empurre o estado completo com `origemz.loadout.sync <base64>`:

```json
{ "tiers": { "origemz.vip.gold": [ { "slot": "belt", "shortname": "rifle.ak",
                                     "amount": 1, "skinId": "0", "position": 0 } ] } }
```

Quando: ao gravar um loadout, ao ligar/desligar, no boot e em
`onRconConnected`. **Estado completo, nunca delta** — é o que faz "apaguei"
chegar ao jogo.

**O payload tem teto.** O WebRCON para em ~50 KB, e base64 infla 33%. Meça antes
de mandar e recuse com uma frase clara, em vez de mandar um comando truncado que
o plugin devolve como `INVALID_ARGS` — erro longe da causa.

### A tela

Na página do servidor, em **Configurações → Loadouts** (sub-aba nova, ao lado de
Oxide): a lista **vem dos grupos daquele servidor**
(`GET /api/servers/:id/oxide/permissions`), cada um com o loadout dele ou o
convite para criar.

O editor de itens usa `GET /api/items` — a rota que a outra frente está
construindo. **Se ela ainda não existir, a tela mostra o campo de shortname com
uma frase dizendo que a busca por nome chega junto com o catálogo.** Não invente
uma segunda lista de itens.

---

## PARTE 3 — A loja de kits

### O que é um kit

Um loadout com regras de entrega. E as regras são estas, ditas pelo dono:

```
  COMPRA          o jogador paga e leva
  RESGATE ÚNICO   uma vez por jogador, para sempre
  COOLDOWN        de N em N horas
```

Um kit pode ser exclusivo de um nível de VIP (o resgate do VIP Ouro), ou aberto
a todos.

### As tabelas (migrações 012 e 013)

```sql
CREATE TABLE kits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Um kit é da REDE, e cada servidor decide se o oferece — mesma
  -- razão da biblioteca de plugins: um kit por servidor faria
  -- cinco cópias do mesmo kit, e a sexta mudança entraria em
  -- quatro delas.
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,

  --  'compra' | 'resgate' | 'cooldown'
  kind TEXT NOT NULL CHECK (kind IN ('compra', 'resgate', 'cooldown')),

  -- Só em 'compra'. Em CENTAVOS, inteiro: dinheiro em float é o
  -- erro que aparece no extrato do cliente.
  price_cents INTEGER,

  -- Só em 'cooldown'. Em segundos.
  cooldown_seconds INTEGER,

  -- NULL = qualquer um. Preenchido = só quem tem aquele nível.
  required_tier TEXT,

  items   TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE kit_servers (
  kit_id    INTEGER NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  PRIMARY KEY (kit_id, server_id)
);

-- Uma linha por entrega. É ela que responde "ele já pegou?" e
-- "quando ele pode pegar de novo?".
CREATE TABLE kit_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_id     INTEGER NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
  steam_id   TEXT NOT NULL,
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  claimed_at INTEGER NOT NULL,
  -- 'entregue' | 'falhou'. A falha FICA: uma entrega que não
  -- aconteceu é a pergunta que o suporte recebe.
  status TEXT NOT NULL CHECK (status IN ('entregue', 'falhou')),
  detail TEXT
);

CREATE INDEX idx_kit_claims_player ON kit_claims (steam_id, kit_id, claimed_at DESC);
```

**O cooldown é calculado, e não guardado.** "Pode pegar de novo?" é
`agora - último claim >= cooldown`, e um campo `next_at` seria um segundo lugar
para a mesma verdade — que erraria no dia em que alguém mudasse o cooldown do
kit.

### A entrega

**Ela precisa do jogador ONLINE**, e isso não é limitação nossa: item entra em
inventário, e inventário só existe para quem está conectado (o Rust descarrega o
`BasePlayer` de quem saiu). A recusa precisa dizer isso — "entre no servidor
para resgatar" é acionável; "falha na entrega" não é.

**A linha do claim é aberta ANTES do comando e fechada com o desfecho.** Se o
comando falhar no meio, a linha fica com `falhou` e o motivo. O contrário —
gravar só depois do sucesso — faz a entrega que travou desaparecer do histórico,
e ela é justamente a que gera reclamação.

**Não invente idempotência agora**, mas leia `deliveries-repository.ts` do
projeto anterior antes de decidir: ele resolve o caso do timeout de RCON, em que
"não sei se entregou" é a resposta certa, e liberar a repetição entregaria duas
vezes.

### As rotas

```
GET    /api/kits                       a lista da rede
POST   /api/kits                       cria
PUT    /api/kits/:id                   edita
DELETE /api/kits/:id                   remove
GET    /api/kits/:id/claims            quem já pegou

GET    /api/servers/:id/kits           os kits daquele servidor
POST   /api/servers/:id/kits/:kitId/claim   { steamId } — entrega agora
```

### A tela

**Sidebar → Loja**, ícone lucide `ShoppingBag`. Tabela dos kits: nome, tipo,
preço ou cooldown, nível exigido, em quais servidores, e quantas vezes já foi
resgatado.

O editor do kit é o mesmo componente do loadout — um kit **é** um loadout com
regras. Não escreva dois editores de item.

---

## Regras que não se negociam

1. **Rota nova entra no escopo `/api`** de `core/src/http/server.ts`.
2. **Mensagem de erro em português, nascida no módulo que conhece a regra.**
   `ApiError(code, message, status)`.
3. **`steamId` é string em toda parte.** Banco, zod, rota, JSON e tela.
4. **`skinId` também é string** — skin do workshop passa de 2^53.
5. **Dinheiro em centavos, inteiro.** Nunca float.
6. **Ausente vira travessão, nunca zero.**
7. **Não duplique o que já existe.** Os grupos vêm das rotas do Oxide; os itens
   vêm de `GET /api/items`; quem está online vem do `PlayersReader`; o jogador
   vem de `players`.
8. **O estado empurrado ao plugin é COMPLETO, nunca delta.**
9. **Revogar não apaga a linha.** Nem no VIP, nem no claim.
10. **Migração nova vai no fim de `MIGRATIONS`**, e a sua faixa é **010–014**.
11. **A listagem é paginada desde a primeira versão.**
12. **Nada de `confirm()` do navegador**: `ConfirmButton` e `toast`.

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

- renovar um VIP que ainda tem 20 dias soma sobre o VENCIMENTO, e não sobre
  hoje;
- um VIP vencido é revogado pelo relógio, sai do grupo do Oxide e some do
  payload de sincronização — e rodar o relógio duas vezes não faz nada demais;
- dois VIPs ativos do mesmo nível para o mesmo jogador são recusados pelo índice;
- o payload de loadout é o estado COMPLETO: apagar um loadout faz o grupo sumir
  do JSON empurrado;
- o `skinId` sobrevive à ida e volta pela API sem perder dígito (use um de
  verdade, com dígitos até o fim);
- kit de resgate único recusa a segunda vez; kit de cooldown recusa antes da
  hora e aceita depois — com o relógio injetado, sem `sleep` no teste;
- um claim que falha fica gravado como `falhou`, com o motivo.

Na máquina, com o `server01`:

1. conceder VIP a um SteamID pelo painel e conferir, em Configurações → Oxide,
   que ele entrou no grupo;
2. gravar um loadout para `origemz.vip.gold` e ver o `origemz.loadout.sync`
   responder `{"ok":true,…}`;
3. apagar o loadout e conferir que o grupo some do payload seguinte;
4. resgatar um kit com o jogador dentro do servidor.

---

## A fronteira com a outra frente

Outra pessoa está construindo, **ao mesmo tempo**, o catálogo de itens e o
editor de interfaces
([14-BRIEFING-ITENS-E-INTERFACE.md](14-BRIEFING-ITENS-E-INTERFACE.md)). As duas
frentes partem do mesmo commit de `main`.

**O que é SEU, e ninguém mais toca:**

```
  core/src/vip/**                       core/src/kits/**
  core/src/db/vips-repository.ts        core/src/db/kits-repository.ts
  core/src/db/loadouts-repository.ts    core/src/http/routes/vips.ts
  core/src/http/routes/kits.ts          core/src/http/routes/loadouts.ts
  panel/src/app/vips/**                 panel/src/app/loja/**
  panel/src/components/loadout-*.tsx    migrações 010 a 014
```

**O que é DELE, e você não toca:**

```
  core/src/game/item-catalog*.ts        core/src/db/items-repository.ts
  core/src/game/ui-*.ts                 core/src/db/ui-documents-repository.ts
  core/src/types/ui-*.ts                core/src/http/routes/items.ts
  core/src/http/routes/ui.ts            panel/src/lib/ui-doc/**
  panel/src/components/ui-editor/**     panel/src/app/itens/**
  panel/src/app/interface/**            migrações 007, 008, 009
```

**Os quatro arquivos que os dois editam** — e como não brigar:

| Arquivo | Regra |
|---|---|
| `core/src/http/server.ts` | acrescente **um** `register…Routes` no fim do bloco, com comentário. Não reordene o que já está lá |
| `core/src/index.ts` | monte o seu **depois** do que existe, num bloco próprio |
| `panel/src/lib/api.ts` | um bloco de tipos e um bloco de métodos, no fim de cada seção. Nunca reescreva o que existe |
| `panel/src/components/sidebar.tsx` | acrescente só os SEUS itens (`VIPs`, `Loja`) |

Se ainda assim der conflito no merge, ele será dessas quatro linhas — resolve-se
mantendo os dois lados.

**O que você espera dele, e como pedir:** o seletor de itens do editor de kits
quer `GET /api/items`. Consuma **por HTTP, na tela**. Não importe repositório
dele, não crie função compartilhada: uma dependência de código entre duas
branches em paralelo é o que impede as duas de compilar sozinhas. Enquanto a
rota não existir, o campo aceita o shortname digitado e a tela diz por quê.

**Uma coisa que é dele e você pode querer:** a **interface do jogo** que mostra a
loja. Ela é do editor de interfaces — você entrega os DADOS (kits, preço,
cooldown, o que o jogador já pegou) pelas suas rotas, e a tela dentro do jogo
vem depois, montada no editor. Não desenhe CUI.

Commits em português, explicando o **porquê** da mudança e o que dava errado
antes — leia o `git log` para pegar o tom. Trabalhe numa branch própria
(`vip-kits`). **Não faça `git push` sem pedir.**

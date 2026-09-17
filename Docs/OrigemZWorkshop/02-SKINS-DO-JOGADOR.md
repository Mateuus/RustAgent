# OrigemZWorkshop — skins do jogador (a reformulação)

**Substitui as partes de [01-CAIXA-E-COLECOES.md](01-CAIXA-E-COLECOES.md) listadas no §2.** O
que o 01 diz sobre cadastro, consulta à Steam, modo streamer e sincronia em pedaços continua
valendo onde este documento não disser o contrário.

Quem lê isto: quem vai implementar as frentes do [05-PLANO-E-FRENTES.md](05-PLANO-E-FRENTES.md).
A tela está em [03-MENU-DE-SKINS.md](03-MENU-DE-SKINS.md) e o contrato com o site em
[04-ENTREGA-PELO-SITE.md](04-ENTREGA-PELO-SITE.md).

Tudo que está marcado como **MEDIDO** tem data e procedência. O que está marcado como
**A MEDIR** entra na fase 0 do plano, antes de o código depender disso.

---

## 1. O que o dono pediu (17/09/2026)

Resumo do pedido:

- O **site vende skins** e as **dá como prêmio na caixa do site**.
- Os admins cadastram várias skins para o mesmo item (várias AK, por exemplo), e elas formam
  uma lista.
- No jogo existe um **menu próprio de skins**, em tela cheia, no visual dos nossos menus. Ele
  abre por `/skins` ou por um botão no inventário, e já chega sabendo qual item o jogador tem
  na mão.
- O menu tem uma **barra lateral por categoria**; a categoria se abre em itens. No centro fica
  a grade de skins do item escolhido, **paginada**. Skin que o jogador não tem aparece **com
  cadeado**. Há um campo de **pesquisa** pelo nome da skin.
- À direita ficam os **detalhes da skin**. Embaixo, o jogador escolhe **em qual das armas dele**
  aplicar. **Aplicar não mexe em mais nada**: durabilidade, munição, acessórios e o conteúdo de
  uma mochila continuam iguais.
- No **painel**, a ficha do jogador mostra as skins que ele tem, e o admin libera e remove por
  ali.
- **A pedra** com skin que "nasce padrão" precisa ser resolvida (§8).

As imagens que o dono mandou (a tela de crafting do Rust e um protótipo) são **referência de
layout**, não especificação ("essas imagens são só um exemplo mesmo").

### As decisões (17/09/2026)

| Pergunta | Decisão do dono |
|---|---|
| O que dá direito a uma skin? | **Posse do jogador + skins da casa.** Quem libera: a posse (site, caixa do site, painel) ou a marca "liberada para todos". Permissão do Oxide, grupo e VIP **deixam de liberar** skin. |
| A posse tem prazo? | **Permanente por padrão, prazo opcional.** O site e o painel podem mandar dias. |
| E as coleções (`/skin neve`)? | **Removidas.** Tudo passa a ser skin individual. |
| E a pedra ao nascer? | **Pedra da OrigemZ no kit.** É configuração de loadout, não código (§8). |

---

## 2. O que muda em relação ao 01

| Peça do 01 | Destino |
|---|---|
| Cadastro pelo painel e por `/skin add` | **fica** — tira os campos de permissão e coleção, ganha descrição, raridade e ordem (§4.1) |
| Consulta à Steam (`steam-workshop.ts`) | **fica** |
| Caixa de 1 slot (`/skin` sem argumento) | **sai** — o menu (03) substitui |
| Coleções e `/skin <coleção>` | **saem** — tabela, rotas, aba do painel e código do plugin |
| Permissão por skin | **sai** |
| Acesso por grupo do Oxide | **sai** |
| Acesso por jogador (`workshop_grants`) | **vira posse** (`workshop_owned_skins`, §4.2) |
| "Liberada para todos" | **fica** — é a skin da casa |
| `origemzworkshop.admin` | **fica** — o admin vê e aplica tudo, para testar; e cadastra pelo jogo |
| Modo streamer (`hideInStreamer`, `HideFrom`/`RestoreTo`) | **fica, sem mudança de regra** |
| Registro (`workshop_audit`) | **fica** — ganha as ações de posse e as entregas do site |
| Carga única com catálogo e acessos | **vira duas**: catálogo global e posse por jogador (§5) |

---

## 3. Quem pode aplicar uma skin

Qualquer um destes libera — é um **OU**:

1. a skin está **liberada para todos** (skin da casa);
2. o jogador tem uma **posse viva** dela: sem prazo, ou com prazo no futuro;
3. o jogador tem `origemzworkshop.admin`.

E, em todos os casos, a skin precisa estar **ligada** e **vinculada ao servidor** (a junção
`workshop_skin_servers` continua valendo).

**Aplicar a skin original ("Padrão", skin 0) é sempre permitido.**

**Posse removida ou vencida não despinta o item.** A regra do 01 §4 continua: o item pode estar
numa caixa do outro lado do mapa, e seguir item pelo mundo não cabe nesta feature. A partir
daí, o jogador só não consegue aplicar de novo.

**Aplicar não consome a skin.** Uma posse serve para quantos itens o jogador quiser, quantas
vezes quiser.

---

## 4. Os dados — migração **097**

A 097 foi reservada para esta frente, conforme o comentário em `core/src/db/migrations.ts`
antes da 98. **Confira que ninguém a usou antes de escrever.** Se alguém usou, pule para um id
livre e deixe o porquê escrito (memória: *id de migração colide entre branches*).

As regras da casa continuam valendo: datas em epoch ms; booleano como `INTEGER 0/1` com CHECK;
comentário de SQL em **ASCII sem acento e sem crase**; nunca editar uma migração que já rodou.

### 4.1 `workshop_skins` — reconstruída

Colunas que **saem**: `permission` e `collection_id`.

Colunas que **entram**:

| Coluna | Tipo | Para quê |
|---|---|---|
| `description` | `TEXT NULL`, até 280 caracteres (limite no zod) | o texto do painel de detalhe no menu |
| `rarity` | `TEXT NULL`, CHECK em `common`, `uncommon`, `rare`, `epic`, `legendary` | a cor da borda e o rótulo no menu |
| `sort_order` | `INTEGER NOT NULL DEFAULT 0` | a ordem na grade (menor primeiro; empate pelo nome) |

Todas as outras colunas continuam: `id`, `label`, `shortname`, `skin_id` (TEXT), `open_to_all`,
`hide_in_streamer`, `enabled`, `source`, `created_by`, `workshop_title`, `preview_url`, datas.
Os índices também: o único em `(shortname, skin_id)` continua. **O único em
`(collection_id, shortname)` sai junto com a coluna.**

**A categoria não vira coluna.** Ela é `ItemDefinition.category` e é o plugin que sabe (§5.1). O
painel, se precisar, lê do espelho `items` (migração 07).

### 4.2 `workshop_owned_skins` — nova

```text
workshop_owned_skins
  id           INTEGER PK
  steam_id     TEXT NOT NULL      CHECK (steam_id GLOB '7656[0-9]*' AND length(steam_id) = 17)
  skin_ref     INTEGER NOT NULL   REFERENCES workshop_skins(id) ON DELETE CASCADE
  expires_at   INTEGER NULL       -- NULL = permanente
  source       TEXT NOT NULL      CHECK (source IN ('site','panel','game','system','migration'))
  source_ref   TEXT NULL          -- o DLV-... da entrega do site; nulo nas outras origens
  note         TEXT NULL
  created_by   TEXT NOT NULL
  created_at   INTEGER NOT NULL
  updated_at   INTEGER NOT NULL
  UNIQUE (steam_id, skin_ref)
  INDEX  (steam_id)
```

**Não existe `server_id`.** A posse vale na rede inteira, assim como o catálogo (00 §8). Em que
servidor a skin aparece continua sendo decisão da junção `workshop_skin_servers`.

**Dar a mesma skin de novo não cria uma segunda linha; mexe no prazo da que existe:**

| O que existe | O que chega | Resultado |
|---|---|---|
| nada | qualquer coisa | cria |
| permanente | permanente ou com prazo | continua permanente (**nunca encurta**) |
| com prazo | permanente | vira permanente |
| com prazo | `days` | `expires_at = max(agora, expires_at) + days` — **soma**, não substitui |
| vencida (linha ainda lá) | qualquer coisa | é tratada como "nada": o prazo conta a partir de agora |

Quem implementa isso é **o repositório**, numa função só (`grantOwnership`), usada pelo painel,
pelo site e pelo `/skin` de admin. **Duas implementações dessa tabela divergem no primeiro
bug.**

`source` e `source_ref` guardam **a última escrita** e servem de rastro. A idempotência da
entrega do site **não depende deles**: ela é da reserva em `site_deliveries`, que já existe
(04 §3).

### 4.3 O que a 097 faz com os dados que existem

A 097 roda **também no banco de produção, que está em outra máquina** (memória: *o agente de
produção roda em outra máquina*). Ela não pode perder posse de ninguém em silêncio.

| Dado de hoje | Vai para |
|---|---|
| acesso de **jogador** a **skin** | uma linha em `workshop_owned_skins`, com o mesmo `expires_at` e `source = 'migration'` |
| acesso de **jogador** a **coleção** | **uma linha por skin da coleção**, com o mesmo prazo. Se o mesmo par já existir, vale a regra do §4.2 (permanente vence; entre dois prazos, o maior) |
| acesso de **grupo** (a skin ou coleção) | **descartado**, com uma linha em `workshop_audit` para cada um (`action = 'migration.group-grant-dropped'`, alvo e detalhe preenchidos) |
| coleção **liberada para todos** | as skins dela ganham `open_to_all = 1` — o que era grátis continua grátis |
| permissão de skin ou de coleção | **descartada**, com uma linha de auditoria por permissão distinta (`migration.permission-dropped`) |
| `workshop_collections`, `workshop_grants` | `DROP` depois das cópias |

A auditoria da migração é o que permite ao dono, no dia seguinte, perguntar "quem tinha acesso
pelo grupo vip?" e ter resposta.

**Antes de aplicar em produção**, rode as contagens (quantos acessos de grupo, de coleção e
quantas permissões) e mostre ao dono. O comando está no plano (05, frente A).

### 4.4 `site_deliveries` — o CHECK do `kind`

Ganha `'skin'` e `'skin_revoke'`. Como o SQLite não altera CHECK, é reconstrução de tabela, e
**entra na mesma 097**: uma migração só para as duas frentes, para que nenhuma delas crie a
própria e as duas colidam no merge. Detalhe no 04.

---

## 5. O que desce para o plugin — duas cargas

Hoje a carga única leva os acessos de todo mundo. Medido em 16/09/2026: **1502 acessos
ocuparam 211 KB em 6 pedaços.** Com posse, o volume cresce com jogadores × skins; mandar a rede
inteira para cada servidor a cada mudança não escala.

### 5.1 O catálogo — `origemz.workshop.sync` (continua, com outros campos)

O mesmo transporte de hoje (pedaços base64, lote, `OUT_OF_ORDER`, cache em disco sem o segredo).

```jsonc
{
  "secret": "…",
  "skins": [
    {
      "id": 12,                     // id do agente
      "label": "AK Brasa",
      "shortname": "rifle.ak",
      "skinId": "3802433262",       // texto: UInt64
      "description": "…",           // pode faltar
      "rarity": "epic",             // pode faltar
      "sort": 0,
      "openToAll": false,
      "hideInStreamer": true
    }
  ],
  "streamers": ["7656…"],
  "storeUrl": "origemz.com.br/skins" // texto do cadeado (03 §5); pode faltar
}
```

- **Saem**: `collections`, `grants`, `permission`, `collectionId`.
- **Só vão as skins ligadas e vinculadas àquele servidor** (como hoje).
- **A categoria e o nome do item** são resolvidos pelo plugin: `ItemDefinition.category` e
  `displayName`. O agente não os manda.

### 5.2 A posse — `origemz.workshop.owned` (novo)

```text
origemz.workshop.owned <steamId> <base64 de {"secret":"…","skins":[{"id":12,"expiresAt":0}]}>
```

- `expiresAt` em epoch ms; **0 = permanente** (o mesmo sentido do `GrantEntry` de hoje).
- A carga é **inteira por jogador**, nunca delta: o plugin troca o conjunto dele de uma vez.
- Só vão as posses **vivas** de skins que **estão no catálogo daquele servidor**.
- Uma lista vazia é informação válida ("não tem nada") e **precisa** ser mandada. O plugin
  distingue "não tem nada" de "ainda não sei" (memória: *a digital de envio cega o agente* —
  resposta vazia é "não sei" só quando ninguém mandou).

**Quando o agente manda:**

| Evento | Para quem |
|---|---|
| o jogador entrou (`PresenceWatcher.onJoined`, `core/src/index.ts:738`) | ele |
| a posse dele mudou (painel, site, `/skin` de admin, vencimento) e ele está online **em algum** servidor | ele, em cada servidor em que estiver |
| o plugin avisou `ready` | todos os online daquele servidor |
| o RCON reconectou | todos os online daquele servidor |

Um jogador com carga grande (centenas de skins) passa do frame de console: use o **mesmo
corte em pedaços** do catálogo, com o `steamId` antes do lote. O limite de 40 KB por pedaço
continua valendo.

**O vencimento** continua como no 01 §4: o plugin confere o prazo na hora de aplicar; o agente
agenda o próximo vencimento (`scheduleExpiry`) e reenvia a posse do jogador afetado, se ele
estiver online, além de registrar o vencimento na auditoria.

### 5.3 A cópia da posse no plugin

- Fica em memória, por `steamId`, e é gravada em `oxide/data/OrigemZWorkshop/owned.json`, **sem o
  segredo**, para o servidor que reinicia com o agente fora do ar continuar sabendo o que cada
  um tem.
- Entradas de quem não entra há **30 dias** saem do arquivo na próxima gravação.
- Estado "não sei" (jogador sem carga e sem cache): o menu abre, mostra só as skins da casa e
  as "Padrão", e diz *"Carregando suas skins…"*. **Nunca mostra cadeado numa skin que talvez
  seja dele.** Em vez disso, cadeado cinza com o texto "sincronizando".

---

## 6. Aplicar a skin

### 6.1 Troca no lugar — a regra que torna duplicação impossível

O plugin **não recria o item**. Ele troca `item.skin` no mesmo objeto, com as quatro linhas do
`RepairBench.ApplySkinToItem` da vanilla, que já estão em
`Plugins/OrigemZWorkshop.cs:1968-1981`.

MEDIDO em 17/09/2026, no decompilado do `RepairBench.ChangeSkin` (Assembly-CSharp do server01):

- quando o item **não muda de definição**, a vanilla só chama `ApplySkinToItem` — as mesmas
  quatro linhas;
- a recriação (novo `Item`, cópia de condição, munição, acessórios e conteúdo) existe **só**
  para skin de loja da Facepunch que **redireciona para outro item** (`ItemSkin.Redirect` /
  `isRedirectOf`).

**Skin do Workshop nunca redireciona**, e o cadastro já recusa item de redirect (01 §2). Logo
este sistema **só faz troca no lugar**. Quantidade, condição, condição máxima, munição no pente,
tipo de munição, acessórios, conteúdo de mochila e `ownershipShares` ficam onde estavam,
porque o objeto é o mesmo.

**Por que não copiar o `Skins.cs` de referência** (`Docs/Skins/Skins.cs`): ele cria uma cópia
do item por skin num contêiner, zera o pente da cópia, guarda o conteúdo numa lista à parte e
remonta tudo quando o jogador arrasta. Isso existe porque a interface dele é arrastar. É daí
que vêm as dez armadilhas de duplicação que ele precisa tratar. Este desenho não tem nenhuma.

### 6.2 O que o plugin confere antes de aplicar

Na ordem, e recusando com uma mensagem na própria tela:

1. o jogador está vivo, acordado e não ferido;
2. o item existe (`uid`) e **é dele**. Isso inclui os contêineres principal, barra e roupa, e o
   conteúdo de uma mochila **vestida**. A subida por `item.parent` precisa terminar em
   `player.inventory`; nunca vale uma caixa do mundo;
3. o `shortname` do item é o `shortname` da skin;
4. a skin está no catálogo deste servidor e o jogador pode usá-la (§3). A skin 0 sempre passa;
5. o item não é de redirect (`info.isRedirectOf == null`);
6. o item já não está com essa skin (se estiver, a tela diz "já aplicada" e não faz nada);
7. trava de frequência: **uma aplicação a cada 0,5 s** por jogador.

**Aplicar não vai para a auditoria** (01 §5): é uso, não configuração.

### 6.3 A MEDIR na fase 0

- **Roupa vestida:** o `MarkDirty` do item basta para **os outros jogadores** verem a roupa
  nova, ou é preciso `player.SendNetworkUpdate()`? O código de hoje só atualiza a `heldEntity`.
- **Mochila vestida:** a aparência muda nas costas? O conteúdo continua acessível sem reabrir?
- **Item na mão durante a troca:** o modelo na mão troca sem o jogador guardar a arma?
- **Modo streamer:** aplicar uma skin com `hideInStreamer` enquanto o `/streamer` está ligado.
  Leia `HideFrom`/`RestoreTo` (`OrigemZWorkshop.cs:1772-1880`) e decida:
  - o que o menu deve fazer é **guardar a escolha e deixar o item com skin 0 até o streamer
    desligar**, que é o que o mecanismo de hoje faz com o que já estava pintado;
  - se o mecanismo não guarda escolhas feitas **durante** o modo, isso vira trabalho da frente
    D. **Não invente um segundo mecanismo.**

> **Decidido na v0.3.0 (frente D, 17/09/2026), antes da medição:**
> - **Roupa vestida.** Depois do `MarkDirty`, o `ApplySkinToItem` também chama
>   `player.SendNetworkUpdate()` quando o item está em `containerWear`, o que inclui a mochila
>   vestida. É barato e cobre o caso que não foi medido. A 0.3 diz se ele fica, sai ou não
>   basta.
> - **Modo streamer.** O mecanismo de hoje **não** guardava escolhas feitas durante o modo, e
>   agora guarda, pelo mesmo `_strippedByPlayer` do `HideFrom`. Aplicar uma skin com
>   `hideInStreamer` durante o `/streamer`:
>   1. grava `uid → skin` nessa lista;
>   2. deixa o item com skin 0;
>   3. responde *"Skin guardada: ela aparece quando você desligar o modo streamer."*
>
>   O `RestoreTo` a veste na saída do ar. Qualquer outra escolha feita no ar (Padrão ou uma
>   skin sem logo) tira o item da lista, para a saída do ar não desfazê-la. O menu mostra a
>   escolha guardada como "Aplicada".

---

## 7. Os comandos no jogo

| Comando | O que faz | Quem |
|---|---|---|
| `/skins` | abre o menu (03), com o item da mão pré-selecionado | todos |
| `/skin` | o mesmo que `/skins` (a caixa de 1 slot deixa de existir) | todos |
| `/skin add "<shortname>" "<workshopId>"` | cadastro pelo jogo, **como hoje** (01 §2) | `origemzworkshop.admin` |
| `/skin give <steamId\|nome> "<shortname>" "<workshopId>" [dias]` | dá a posse, pelo mesmo `grantOwnership` do agente, via `#OZWORKSHOP#{"kind":"give",…}` | `origemzworkshop.admin` |
| `/skin ajuda` | explica o menu e, para admin, os dois comandos acima | todos |

`/skin <qualquer outra palavra>` deixa de aplicar coleção. Passa a **abrir o menu já com a
pesquisa preenchida** com aquela palavra.

O `give` é opcional (frente D, prioridade baixa): o painel já cobre o caso. Ele existe porque
admin em jogo costuma premiar em jogo.

**O push do `give`, como a v0.3.0 do plugin o manda:**

```jsonc
#OZWORKSHOP#{
  "kind": "give",
  "secret": "…",                 // o do último sync
  "requestId": "a1b2c3d4e5f60718", // 16 caracteres hexadecimais
  "steamId": "7656…",            // QUEM RECEBE; o plugin já resolveu o nome
  "shortname": "rifle.ak",
  "workshopId": "3802433262",    // texto
  "days": 30,                    // ou null = permanente
  "adminSteamId": "7656…",
  "adminName": "Fulano"
}
```

- A resposta vem pelo mesmo `origemz.workshop.reply` do `add`, com o mesmo `requestId`. O
  plugin entrega a frase ao **admin** que pediu, porque guarda quem foi pelo `requestId`. Sem
  resposta em 20 s, ele avisa o admin.
- O nome é resolvido entre os jogadores **online e dormindo**: o nome exato vence, e senão vale
  "contém", desde que só um jogador case. Um SteamID64 vale mesmo com o jogador offline.
- **Decisão da frente D:** a skin precisa estar no catálogo **deste** servidor. Se não estiver,
  o plugin manda o admin cadastrá-la antes com `/skin add`.
- `days` aceita de 1 a 3650. `perm`, `permanente`, `0` ou nada viram `null`.

---

## 8. A pedra

### O que acontece hoje — MEDIDO em 17/09/2026

- **O nosso código não carimba nada ao nascer.** O carimbo existiu na v0.1.0 do
  `OrigemZWorkshop` (commit `3bf89f2`, `OnDefaultItemsReceived`) e saiu na v0.2.0 (`49a0b8f`).
  A cópia instalada no server01 é idêntica à do repositório.
- **A pedra com skin é do próprio Rust.** `PlayerInventory.GiveDefaultItems` (decompilado,
  linha 1684) entrega `GiveDefaultItemWithSkin("client.rockskin", "rock")`: a skin que **o
  jogador** escolheu no cliente, se ele a possui no Steam. A tocha vem do mesmo jeito
  (`client.torchskin`).
- Isso só acontece com quem **não recebe kit**. O `OrigemZPlayer.OnDefaultItemsReceive`
  (`Plugins/OrigemZPlayer.cs:262-307`) cancela a entrega de fábrica quando o nível tem kit.
- No banco de desenvolvimento só existe o loadout `default` (nível `normal`), com `rifle.ak` e
  `pilot.hazmat.box.wooden`. O nível **`admin`** (`ResolveTier`, `:816`, com
  `AdminTemKitProprio: true`) **não tem kit**, e por isso o admin nasce com a pedra e a tocha
  vanilla, na skin dele.

### A decisão: a pedra da OrigemZ vai no kit

É configuração, não código:

1. Publicar a pedra da OrigemZ no Workshop e cadastrá-la (painel ou `/skin add "rock" "<id>"`).
   MEDIDO em 16/09/2026: `rock` aceita skin do Workshop (`Skinnable.All`).
2. Em cada loadout de nível (painel → jogador → loadouts), adicionar `rock` com esse `skinId`
   no slot da barra. O campo "Skin" já existe (`panel/src/components/loadout-editor.tsx:224`), e o
   `GiveLoadoutItem` já cria o item com a skin (`OrigemZPlayer.cs:693-703`).
3. Criar o loadout do nível **`admin`**, ou desligar o `AdminTemKitProprio`, para o admin
   também nascer com ela.
4. Se a tocha também deve vir, ela entra no kit do mesmo jeito. Hoje o kit `default` **não tem
   tocha**: quem tem kit nasce sem ela. **Confirmar com o dono** se isso é intencional.

**Efeito colateral a avisar:** quem recebe kit **perde a pedra com a skin pessoal do Steam**. É
consequência direta da decisão, e não um bug.

**A pedra do kit não passa pela posse.** Ela é dada pelo kit, e o jogador a recebe mesmo sem
possuir a skin. Para que ele possa **reaplicá-la** pelo menu depois de trocar, a skin da pedra
deve ser cadastrada como **liberada para todos**.

---

## 9. O painel

### `/workshop`

| Aba | Destino |
|---|---|
| Skins | fica. O formulário perde permissão e coleção e ganha descrição, raridade e ordem. A tabela ganha a coluna "donos" (contagem) |
| Coleções | **sai** |
| Acessos | **vira "Posse"**: busca por jogador ou por skin, lista quem tem o quê, dá e remove em lote (útil para prêmio de evento). O seletor de grupo sai |
| Registro | fica, com as ações novas (`owned.grant`, `owned.revoke`, `owned.expired`, `site.delivered`, `migration.*`) |

### Ficha do jogador — aba nova **Skins**

Em `panel/src/app/jogador/page.tsx`, entre `vip` e `carteira`, no molde de `VipDoJogador`
(`:856-1007`):

- **"O que ele tem"**: ícone, nome, item, origem (site, painel, jogo, migração), prazo, e o botão
  Remover;
- **"Dar skin"**: busca no catálogo, prazo (permanente, 1, 7, 30, 90 dias ou data livre) e nota;
- **"Histórico"**: `workshop_audit` filtrado pelo SteamID.

Lembrete (memória: *o tipo do painel não valida a resposta*): toda resposta passa por um
`safeX` em `panel/src/components/workshop/normalize.ts` antes do render.

---

## 10. Rotas

| Rota | Muda? |
|---|---|
| `/workshop/skins*`, `/workshop/lookup/:id` | ficam; o corpo perde `permission`/`collectionId` e ganha `description`/`rarity`/`sort` |
| `/workshop/collections*` | **saem** |
| `/workshop/grants*` | **saem** |
| `GET /workshop/owned?steamId=&skinId=&cursor=` | **nova** — lista a posse (uma das duas chaves é obrigatória) |
| `POST /workshop/owned` `{ steamId, skinId, days?, expiresAt?, note? }` | **nova** — `grantOwnership` |
| `DELETE /workshop/owned/:id` | **nova** |
| `GET /players/:steamId/skins` | **nova** — a aba da ficha: posse viva e vencida, com o catálogo resolvido |
| `/workshop/audit`, `/servers/:id/workshop/*` | ficam |

Zod na borda **e** no repositório, como no resto do projeto.

---

## 11. Em aberto

1. **As skins de verdade.** O catálogo hoje tem uma skin (`metal.facemask`). A lista do que a
   OrigemZ vai publicar é do dono.
2. **A tocha no kit** (§8, passo 4).
3. **O endereço da loja** que o cadeado mostra (`storeUrl`, §5.1).
4. As medições da fase 0 (§6.3 e 03 §8).

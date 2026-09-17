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
3. o jogador é admin: tem `origemzworkshop.admin` **ou** é admin nativo do servidor (`player.IsAdmin`). É o mesmo critério do `/skin add` e do `/skin give`.

E, em todos os casos, a skin precisa estar **ligada** e **vinculada ao servidor** (a junção
`workshop_skin_servers` continua valendo).

**Aplicar a skin original ("Padrão", skin 0) é sempre permitido.**

**Posse removida ou vencida não despinta o item.** A regra do 01 §4 continua: o item pode estar
numa caixa do outro lado do mapa, e seguir item pelo mundo não cabe nesta feature. A partir
daí, o jogador só não consegue aplicar de novo.

**Aplicar não consome a skin.** Uma posse serve para quantos itens o jogador quiser, quantas
vezes quiser.

---

## 4. Os dados — migrações **097** e **100**

> A **097** é a reformulação de 17/09/2026 (§4.1 a §4.4). A **100**, do mesmo dia, é a favorita
> da rede (§4.5) e a marca "Skin de temporada" (§4.6). As duas mexem no mesmo canto do schema, e
> a 100 **depende da forma que a 097 deixa**: num banco parado antes da 097 ela não roda.

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

**Implementado (frente A, 17/09/2026):**

- A tabela está em `renewedExpiry`, em `core/src/db/workshop-owned-repository.ts`.
- O painel também pode mandar uma **data** (`expiresAt`) em vez de dias. Essa linha não estava
  acima, e a decisão foi aplicar a mesma régua de "nunca encurta":

  | O que existe | O que chega | Resultado |
  |---|---|---|
  | nada ou vencida | `expiresAt` | `expires_at = expiresAt` |
  | permanente | `expiresAt` | continua permanente |
  | com prazo | `expiresAt` | `max(expires_at, expiresAt)` |

  Quem quer **encurtar** remove a posse e dá de novo.
- Mandar `days` **e** `expiresAt` juntos é recusado.
- Uma data no passado é recusada com `OWNED_ALREADY_EXPIRED`.
- Quem é de fora chama `WorkshopCatalog.grantOwnership` / `revokeOwnership`
  (`core/src/game/workshop-catalog.ts`), que envolvem a função do repositório. Além dela, esse
  método faz três coisas:
  1. confere que a skin existe;
  2. grava `owned.grant` / `owned.revoke` no registro;
  3. avisa o serviço para reenviar a posse do jogador onde ele estiver online.

  A skin **não precisa estar ligada nem em algum servidor** (04 §3).
- Com a posse viva, a nota nova só substitui a antiga quando vem preenchida. `created_by` e
  `created_at` ficam os da primeira vez. Com a posse vencida, a linha é tratada como nova, e os
  quatro campos são trocados.

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
quantas permissões) e mostre ao dono. O comando está no fim desta seção.

#### Como a 097 foi implementada (frente A, 17/09/2026)

- É uma migração em função (`migrateWorkshopOwnedSkins`, em `core/src/db/migrations.ts`), e
  não SQL puro: a expansão de coleção funde origens pela regra do §4.2, e o descarte é
  registrado com detalhe em JSON. A regra de fusão está **copiada** na migração, e não importada
  do repositório: o repositório pode mudar, a migração não.
- Na lista, ela fica entre a 096 e a 098. O runner aplica todo id **ausente**, então num banco
  que já tem a 098 e a 099 ela roda sozinha. Isso foi testado.
- Além do que a tabela acima pede, ela também:
  - registra `migration.collection-dropped` para **cada** coleção, com o que ela era;
  - registra `migration.collection-grant-expanded` para cada acesso de coleção expandido, com a
    lista de skins (inclusive a lista vazia);
  - registra `migration.invalid-grant-dropped` para acesso de "jogador" com SteamID torto (só
    edição à mão produz isso; sem o descarte, o CHECK novo derrubaria a migração);
  - grava um resumo `migration.097` com as contagens;
  - **reconstrói `workshop_audit`** com a origem `site` no CHECK, porque a entrega do site grava
    no registro e a frente C não pode criar migração.
- **Coleção desligada não propaga o "liberada para todos"**: o push da 096 só levava as
  coleções ligadas, então ela não liberava nada no jogo. O fato fica no detalhe do
  `migration.collection-dropped` (`openToAllPropagated`).
- A posse migrada guarda o `created_by` e o `created_at` do acesso mais antigo, e a nota do
  primeiro que tinha nota.
- Acesso **vencido** também vira posse, com o mesmo prazo: a ficha mostra "venceu em".

**Voltar o binário.** Até 17/09/2026 a trava de schema (`db/schema-version.ts`) nem era chamada no
boot, e só comparava o **maior** id aplicado: um agente que conhecia até a 099 abria sem reclamar
um banco com a 097 e quebrava na primeira consulta a `workshop_grants`. A partir desta branch o
boot chama a trava, e ela **recusa** qualquer migração aplicada que o binário não conheça, com a
instrução de restaurar o instantâneo (`backups`, também passou a ser gravado no boot). O agente
antigo, sem esta correção, continua sem recusar — ele precisa receber a `main` antes de subir
contra um banco com a 097.

**MEDIDO em 17/09/2026**, numa cópia do banco de desenvolvimento, sem tocar no original:

| Cópia | Antes | Depois |
|---|---|---|
| real | 2 acessos (1 de grupo `vip`, 1 de jogador a coleção), 1 coleção, 1 skin | 1 posse; 4 linhas `migration.*` no registro; `foreign_key_check` vazio; `integrity_check` ok |
| real + fabricados (50 jogadores numa coleção aberta com 2 skins, metade permanente; 10 acessos diretos; 2 de grupo; 1 permissão) | 64 acessos, 3 de grupo, 51 de coleção, 2 coleções | 101 posses (50 permanentes); 2 skins viraram "liberada para todos"; 3 `group-grant-dropped`, 1 `permission-dropped`, 51 `collection-grant-expanded`, 2 `collection-dropped` |

#### O comando de contagem, para produção

O `sqlite3` de linha de comando não está instalado nas máquinas da casa, então a contagem é um
script. Ele abre o banco **só para leitura**, e pode rodar com o agente de pé:

```bash
# da raiz do repositório, na máquina de produção, ANTES de subir o agente com a 097.
# O caminho é o AGENT_DB_PATH do .env de lá (padrão: <raiz>/data/rustagent.db).
npx tsx core/scripts/workshop-097-counts.ts C:/OrigemZ/RustAgent/data/rustagent.db
```

Ele mostra:

- os acessos: no total, de grupo, de jogador a skin e de jogador a coleção;
- quantas posses a expansão gera e quantas sobram depois da fusão;
- as permissões distintas que serão descartadas;
- as coleções;
- as skins que viram "liberada para todos";
- os acessos de grupo, por grupo.

Se a 097 já tiver rodado naquele banco, ele mostra o resumo que ela gravou.

### 4.4 `site_deliveries` — o CHECK do `kind`

Ganha `'skin'` e `'skin_revoke'`. Como o SQLite não altera CHECK, é reconstrução de tabela, e
**entra na mesma 097**: uma migração só para as duas frentes, para que nenhuma delas crie a
própria e as duas colidam no merge. Detalhe no 04.

### 4.5 `workshop_favorites` — a favorita da rede (migração **100**)

**Pedido do dono, 17/09/2026.** Na v0.3.0 do plugin a favorita morava só em
`oxide/data/OrigemZWorkshop/favorites.json`, **por servidor**: quem marcava no server01 abria o
server02 sem nenhuma. A posse já é da rede (§4.2), e a preferência de tela não tem motivo para
ser diferente.

```text
workshop_favorites
  id          INTEGER PK
  steam_id    TEXT NOT NULL      CHECK (steam_id GLOB '7656[0-9]*' AND length(steam_id) = 17)
  skin_ref    INTEGER NOT NULL   REFERENCES workshop_skins(id) ON DELETE CASCADE
  created_at  INTEGER NOT NULL
  UNIQUE (steam_id, skin_ref)
  INDEX  (steam_id)
```

- **Sem `server_id`**, como a posse: a favorita vale na rede inteira.
- **Sem prazo, sem origem e sem nota**: favoritar é preferência, não direito. **Favoritar não é
  possuir**, e nunca libera nada.
- **Não vai para o registro.** Seria uma linha por clique; o §6.2 já deixou "aplicar" de fora
  pelo mesmo motivo.
- **Teto de 200 por jogador**, o mesmo número do `MaxFavoritesPerPlayer` do plugin. Quem chama:
  `WorkshopCatalog.setFavorite` / `toggleFavorite`, que devolvem `ApiError`
  `FAVORITES_FULL` (409). **Desfavoritar nunca é recusado** — senão quem bateu no teto não teria
  como sair dele.

**Onde mora o código (decisão desta frente):** em `WorkshopOwnedRepository`
(`core/src/db/workshop-owned-repository.ts`), e não num arquivo próprio. É a mesma pergunta ("o
que é deste jogador?"), desce na mesma carga (§5.2), tem a mesma forma de chave, e um segundo
repositório seria um parâmetro a mais em toda a fiação (`index.ts`, rotas, serviço, testes) por
três métodos. Essa classe já não é só posse: ela guarda o registro, que também não é.

Os métodos:

| Método | O que faz |
|---|---|
| `listFavorites(steamId)` | os ids, em ordem crescente — a ordem da carga |
| `isFavorite(steamId, skinRef)` / `countFavorites(steamId)` | leitura |
| `setFavorite(steamId, skinRef, on, now?)` | põe no estado pedido. **Idempotente** |
| `toggleFavorite(steamId, skinRef, now?)` | inverte e devolve o estado novo |
| `removeFavorite(steamId, skinRef)` | `true` quando havia o que tirar |

**`setFavorite` e não "alterne", no caminho do plugin:** o console repete linha em reconexão
(§5.4), e um "alterne" repetido desfaria o clique do jogador em silêncio. `toggleFavorite`
existe para quem só sabe "clicaram na estrela".

### 4.6 `workshop_skins.season` — a **Skin de temporada** (migração **100**)

**Pedido do dono, 17/09/2026:** skins que saem da posse num wipe, mas **só quando o wipe
mandar** — "por padrão não é removida".

Decisão de nome, para os dois lados usarem o mesmo: o campo é **`season`**, e o rótulo em
português é **"Skin de temporada"**.

```sql
season INTEGER NOT NULL DEFAULT 0 CHECK (season IN (0, 1))
```

- `season = 1` quer dizer **"a posse desta skin PODE sair num wipe"**. É uma **marca**, e só:
  nada no jogo muda por causa dela. O menu apenas informa (03 §3.5).
- O padrão é 0, e **toda skin que já existia nasceu 0** (MEDIDO abaixo).
- `ALTER TABLE ADD COLUMN` não serviria: o CHECK `season IN (0,1)` não se altera no SQLite, e a
  régua da casa é que booleano tem CHECK. Então é **reconstrução de tabela, no molde da 097** —
  com a mesma ordem e pelo mesmo motivo (`foreign_keys = ON`: o DROP da tabela velha de skins
  levaria em cascata a junção de servidor e a posse de todo mundo).

**Quem apaga é o wipe, e por uma porta só:**

```ts
WorkshopCatalog.removeSeasonOwnership(serverId?: string | null, now?: number): SeasonCleared
// SeasonCleared = { removed: number; players: readonly string[] }
```

- Apaga **toda** posse cuja skin tem `season = 1` — vivas **e vencidas** (uma vencida que
  sobrasse voltaria a valer se alguém a renovasse).
- Grava **UMA** linha de auditoria, `owned.season-cleared`, com a contagem
  (`detail: { removed, players, skins }`). **Não** uma por jogador: um wipe com milhares de
  posses encheria a tela do registro e esconderia todo o resto daquele dia. Quem tinha o quê
  continua em cada `owned.grant`.
- **Reenvia a posse** de cada jogador afetado que esteja online, em cada servidor em que ele
  esteja. Quem está fora recebe ao entrar.
- **`serverId` só entra no registro**, como no `grantOwnership`: a posse é da rede e sai
  inteira. Passar o servidor do wipe é o que deixa o registro dizer de onde veio a ordem.
- No repositório, o que sustenta isso é `seasonOwned()` (lê) e `deleteSeasonOwned()` (apaga e
  devolve as linhas). **A porta pública é a do `WorkshopCatalog`**, porque o registro e o
  reenvio não cabem no repositório — é a mesma divisão do `grantOwnership` (§4.2).

**MEDIDO em 17/09/2026**, na cópia do banco de desenvolvimento que a trava de schema guardou
antes de aplicar a 100 (`data/backups/rustagent-schema-099-to-100-*.db`):

| | Antes | Depois |
|---|---|---|
| skins | 90 | 90, **todas com `season = 0`** |
| posses | 45 | 45, **byte a byte iguais** (o `id` de cada uma preservado) |
| junção de servidor | 90 | 90, byte a byte iguais |
| registro | 148 linhas | 148 linhas (a 100 não escreve nele) |
| `workshop_favorites` | não existia | existe, vazia |
| `foreign_key_check` / `integrity_check` | — | vazio / `ok` |

O agente de desenvolvimento aplicou a 100 sozinho no boot, e o banco de dev está no mesmo
estado.

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
      "hideInStreamer": true,
      "season": false           // "Skin de temporada" (§4.6); vai SEMPRE
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
- **Implementado (frente A):**
  - `description` e `rarity` **faltam** quando não têm valor; nunca vêm como `null`;
  - `storeUrl` vem da variável `WORKSHOP_STORE_URL` do `.env` do agente, e falta quando ela
    está vazia ou ausente;
  - as skins vêm na ordem da grade: `sort`, depois o nome;
  - o comando continua `origemz.workshop.sync <lote> <i> <n> <pedaço>`, e a resposta
    esperada a cada pedaço continua `{"ok":true}` (ou `{"ok":false,"error":"…"}`).
- **`season` (migração 100) vai SEMPRE**, como `openToAll` e `hideInStreamer` — e não "pode
  faltar" como a descrição. Um campo ausente viraria "não é de temporada" num plugin velho, e
  essa é justamente a leitura errada que custa caro.
- **`origemz.workshop.status`** (plugin 0.3.0) deve responder
  `{"ok":true,"skins":N,"ownedPlayers":N,"streamers":N}`. `ownedPlayers` é quantos jogadores
  têm posse carregada na memória. `collections`, `grants` e `openBoxes` saem.

### 5.2 A posse — `origemz.workshop.owned` (novo)

```text
origemz.workshop.owned <steamId> <base64 de {"secret":"…","skins":[{"id":12,"expiresAt":0}],"favorites":[12]}>
```

- `expiresAt` em epoch ms; **0 = permanente** (o mesmo sentido do `GrantEntry` de hoje).
- A carga é **inteira por jogador**, nunca delta: o plugin troca o conjunto dele de uma vez.
- **`favorites` (migração 100)** são os ids das favoritas dele (§4.5), na mesma carga — é a
  mesma pergunta ("o que é deste jogador?"), e o plugin troca os **dois** conjuntos de uma vez.
  Uma carga separada abriria a janela em que a posse é nova e a favorita é velha.
- Só vão as posses **vivas** de skins que **estão no catálogo daquele servidor**.
- Uma lista vazia é informação válida ("não tem nada") e **precisa** ser mandada. O plugin
  distingue "não tem nada" de "ainda não sei" (memória: *a digital de envio cega o agente* —
  resposta vazia é "não sei" só quando ninguém mandou).

**Quando o agente manda:**

| Evento | Para quem |
|---|---|
| o jogador entrou (`PresenceWatcher.onJoined`, `core/src/index.ts:738`) | ele |
| a posse dele mudou (painel, site, `/skin` de admin, vencimento) e ele está online **em algum** servidor | ele, em cada servidor em que estiver |
| ele **favoritou** ou desfavoritou no menu (§5.4) | ele, em cada servidor em que estiver |
| o wipe apagou as posses de temporada (§4.6) | cada afetado, onde estiver |
| o plugin avisou `ready` | todos os online daquele servidor |
| o RCON reconectou | todos os online daquele servidor |

Um jogador com carga grande (centenas de skins) passa do frame de console: use o **mesmo
corte em pedaços** do catálogo, com o `steamId` antes do lote. O limite de 40 KB por pedaço
continua valendo.

**O vencimento** continua como no 01 §4: o plugin confere o prazo na hora de aplicar; o agente
agenda o próximo vencimento (`scheduleExpiry`) e reenvia a posse do jogador afetado, se ele
estiver online, além de registrar o vencimento na auditoria.

#### O formato exato (implementado pela frente A, 17/09/2026) — é o que a frente D lê

**O comando é sempre cortado**, mesmo quando cabe num pedaço só:

```text
origemz.workshop.owned <steamId> <lote> <i> <n> <pedaço>
```

| Argumento | O que é |
|---|---|
| `steamId` | SteamID64 do dono da posse, 17 dígitos. `arg.GetString(0)` |
| `lote` | 12 caracteres hexadecimais minúsculos, novos a cada carga. `arg.GetString(1)` |
| `i` | índice do pedaço, de `0` a `n-1`, em ordem. `arg.GetInt(2)` |
| `n` | total de pedaços do lote, `>= 1`. `arg.GetInt(3)` |
| `pedaço` | uma fatia do base64, com no máximo **40.000** caracteres. `arg.GetString(4)` |

- **A carga** é o texto base64, em UTF-8, do JSON abaixo. Ela é **cortada em fatias de
  caracteres**, e não em blocos de base64 válidos: junte as fatias do mesmo lote, na ordem de
  `i`, e só então decodifique. É o mesmo `encodePushPayload` do `sync`.

  ```json
  {"secret":"…","steamId":"76561198000000000","skins":[{"id":12,"expiresAt":0},{"id":40,"expiresAt":1790000000000}],"favorites":[12,40]}
  ```

  - `secret` é o mesmo do `sync`. Carga com segredo errado é recusada.
  - `steamId` repete o argumento. Se não bater, o plugin recusa o lote.
  - `id` é o `id` da skin no catálogo, o mesmo do `sync`.
  - `expiresAt` vem em epoch ms, e **0 = permanente**.
  - A lista vem ordenada por `id`, e **pode vir vazia**.
  - **`favorites`** (migração 100) é a lista de ids das favoritas dele, **ordenada por `id`** e
    **filtrada pelo catálogo daquele servidor**, como `skins`: favorita de skin que não existe
    ali não tem célula para marcar. **Pode vir vazia, e a lista vazia é mandada** — ela é a
    informação "ele não tem nenhuma". **Favoritar não é possuir:** um id pode estar em
    `favorites` e não estar em `skins`.
  - **Do lado do plugin (v0.4.0):** `favorites` **ausente** não mexe no que ele tem (agente
    anterior à 100: apagar a estrela de todo mundo por um campo que faltou seria pior que ficar
    com a lista velha). `favorites` **vazia** apaga.
- **A resposta a cada pedaço** é a mesma do `sync`, numa linha JSON:
  - `{"ok":true}` quando aceitou, inclusive os pedaços intermediários;
  - `{"ok":false,"error":"…"}` quando recusou. Por exemplo: `BAD_SECRET`, `BAD_STEAMID`,
    `OUT_OF_ORDER` ou `INVALID_ARGS`.

  O agente para no primeiro pedaço recusado e registra o aviso. Ele manda de novo no próximo
  gatilho, porque não marca como entregue o que não entrou.
- **Troca atômica.** O conjunto daquele `steamId` só é trocado quando o pedaço `n-1` chega e o
  JSON remontado passa na conferência. Lote incompleto, ou atropelado por um lote novo do
  mesmo jogador, é descartado, e o conjunto anterior fica inteiro.
- **O plugin guarda a posse inteira como veio.** O agente já filtrou pelo catálogo daquele
  servidor. Se o plugin receber a posse antes de um catálogo novo, ele não deve jogar fora ids
  que ainda não conhece: o agente manda o catálogo **antes** da posse em todo gatilho que mexe
  nos dois, mas uma corrida com um `oxide.reload` não é impossível.
- **Ordem dos envios.** No `ready` do plugin e na reconexão do RCON vai primeiro o `sync` e
  depois um `owned` para cada jogador online. Uma mudança de catálogo manda o `sync` e depois a
  posse de quem está online, mas só se ela mudou.
- **"Online" para o agente** é quem tem sessão aberta em `player_servers`. Essa lista é mantida
  pela varredura de presença, a cada 15 s. Quem acabou de entrar recebe a posse pelo
  `onJoined` dessa varredura, forçada, ou seja, mesmo que igual à última. **Até lá, o plugin
  fica no estado "não sei"** (§5.3) para esse jogador, a menos que o `owned.json` já o conheça.

### 5.3 A cópia da posse no plugin

- Fica em memória, por `steamId`, e é gravada em `oxide/data/OrigemZWorkshop/owned.json`, **sem o
  segredo**, para o servidor que reinicia com o agente fora do ar continuar sabendo o que cada
  um tem.
- Entradas de quem não entra há **30 dias** saem do arquivo na próxima gravação.
- Estado "não sei" (jogador sem carga e sem cache): o menu abre, mostra só as skins da casa e
  as "Padrão", e diz *"Carregando suas skins…"*. **Nunca mostra cadeado numa skin que talvez
  seja dele.** Em vez disso, cadeado cinza com o texto "sincronizando".

**O `favorites.json` (v0.4.0):** continua existindo, e virou **cache de leitura**. Ele é lido no
boot, para o servidor que sobe com o agente fora do ar mostrar as favoritas da última carga, e
só é **reescrito quando uma carga chega** (pelo mesmo relógio de 5 s do `owned.json`: os dois
são o cache da mesma carga). **A estrela nunca mais o edita** — está escrito no cabeçalho do
plugin. Id que saiu do catálogo continua sendo podado na gravação.

### 5.4 A estrela do menu — o aviso `fav` (novo, migração 100)

O plugin **desenha na hora** (otimista, porque a tela tem de responder no mesmo frame) e grita:

```text
#OZWORKSHOP#{"kind":"fav","secret":"…","steamId":"7656…","skinId":12,"on":true}
```

| Campo | O que é |
|---|---|
| `secret` | o mesmo do `sync`. Sem ele, um jogador digita o marcador no chat e mexe na lista de outro |
| `steamId` | o SteamID64 de quem clicou |
| `skinId` | o `id` da skin **no agente** (o mesmo do `sync`) |
| `on` | o estado que ele quer: `true` favorita, `false` desfavorita |

- **É `on`, e não "alterne".** O console repete linha em reconexão, e um "alterne" repetido
  desfaria o clique em silêncio. Com `on`, mandar duas vezes é o mesmo que mandar uma — e por
  isso **este aviso não tem `requestId` nem dedup**, ao contrário do `add` e do `give`.
- **Não tem resposta.** A confirmação é a própria carga da posse, que volta com `favorites`
  dentro: o agente grava e reenvia a posse+favoritas daquele jogador. **O agente é a verdade.**
- **Recusado** (o teto de 200, uma skin que não existe), o agente **reenvia forçado**: sem isso
  a digital de envio diria "não mudou nada" e o plugin ficaria com o otimismo dele para sempre.
  A recusa vai para o log do agente, não para a auditoria.
- O plugin tem a **mesma régua de 200** localmente, só para não desenhar o que o agente
  recusaria; ao bater nela ele mostra a frase na faixa de "Aplicar em" e **não** grita.
- Segredo vazio (catálogo ainda não chegou): o `Push` não sai, e a favorita é local até a
  próxima carga — que é quem manda.

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
7. trava de frequência: **uma aplicação a cada 0,5 s** por jogador. O relógio é **do jogador**, e não da sessão do menu: fechar e reabrir o menu não o zera.

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

**O aviso do `give`, como o agente o lê (frente A, 17/09/2026):**

```text
#OZWORKSHOP#{"kind":"give","secret":"…","requestId":"g-1a2b","steamId":"<admin>","playerName":"<admin>",
             "targetSteamId":"7656…","targetName":"Fulano","shortname":"rifle.ak","skinId":"3802433262","days":30}
```

- O plugin resolve `<steamId|nome>` para um SteamID64 **antes** de gritar. `targetSteamId` é
  sempre o SteamID64, e `targetName` é só para a frase.
- `days` vale de 1 a 3650. `null`, ou o campo ausente, quer dizer permanente.
- `requestId` segue a mesma régua do `add`: `[A-Za-z0-9-]{1,40}`. O agente ignora um
  `requestId` repetido, separado por `kind`.
- O agente procura a skin por `(shortname, skinId)`. Se não achar, responde
  `ok:false` com "Cadastre antes com /skin add".
- A resposta volta pelo mesmo `origemz.workshop.reply`, no mesmo formato do `add`:
  `{requestId, steamId, ok, message}`, e o `steamId` ali é o do **admin**.
- Recusas vão para o registro como `game.give-refused`.
- A posse dada grava `owned.grant` com `source: "game"` e o `serverId`.

**Do lado do plugin (v0.3.0, frente D):**

- `requestId` tem 16 caracteres hexadecimais. O plugin guarda quem pediu, entrega a resposta ao
  admin e, sem resposta em 20 s, avisa.
- O nome é resolvido entre os jogadores **online e dormindo**: o nome exato vence, e senão vale
  "contém", desde que só um jogador case. Um SteamID64 vale mesmo com o jogador offline.
- A skin precisa estar no catálogo **deste** servidor. Se não estiver, o plugin manda o admin
  cadastrá-la antes com `/skin add`.
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
| Skins | fica. O formulário perde permissão e coleção e ganha descrição, raridade, ordem e **"Skin de temporada"** (§4.6). A tabela ganha a coluna "donos" (contagem) |
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

**O que a migração 100 acrescentou para o painel (17/09/2026):**

- o formulário de skin ganha **"Skin de temporada"** — caixa de seleção, `season` no corpo do
  POST/PUT e na resposta do GET. O PUT é o formulário **inteiro**: sem o campo, a marca volta ao
  padrão (`false`);
- `GET /players/:steamId/skins` passa a trazer **`favorites: number[]`** — os ids que ELE marcou
  no menu do jogo. Sem filtro de servidor (a favorita é da rede), e **pode apontar para uma
  skin que ele não possui**: favoritar é "quero achar rápido", não "tenho". A ficha pode mostrar
  a estrela na lista, mas **a lista de posse não muda por causa dela**;
- a ação nova do registro é **`owned.season-cleared`** (uma linha por wipe, com a contagem em
  `detail`). **Favoritar não gera linha de registro nenhuma** — não procure por ela;
- não há rota para o painel mexer em favorita. Ela é do jogador, marcada no jogo.

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
| `GET /players/:steamId/skins` | **nova** — a aba da ficha: posse viva e vencida, com o catálogo resolvido, e as favoritas (§4.5) |
| `/workshop/audit`, `/servers/:id/workshop/*` | ficam |

Zod na borda **e** no repositório, como no resto do projeto.

### Como ficaram (frente A, 17/09/2026) — é o que a frente E consome

`skinId` nas rotas de posse é o **id do agente** (o mesmo do `:skinId` das rotas de skin). O
id do Workshop, quando aparece junto, se chama `workshopId`. As datas vêm em ISO.

- **Skin**, em `GET/POST/PUT /workshop/skins*`. Os campos de sempre, com três mudanças:
  - saem `permission` e `collectionId`;
  - entram `description` (`string | null`, até 280), `rarity` (`common | uncommon | rare |
    epic | legendary | null`) e `sort` (inteiro, padrão 0);
  - entra `owners`, a quantidade de posses **vivas**. Só vem na resposta;
  - **entra `season`** (booleano, padrão `false`; migração 100) — no corpo do POST/PUT e na
    resposta do GET. Ver §4.6.
- **`GET /workshop/owned`**:
  - parâmetros: `steamId`, `skinId`, `cursor`, `limit` (1 a 500, padrão 100) e
    `includeExpired` (`true`/`false`, padrão `true`);
  - sem `steamId` **e** sem `skinId`, responde 400;
  - resposta: `{ ok, count, owned: Owned[], nextCursor: number | null }`, do mais novo para o
    mais velho;
  - para a página seguinte, passe o `nextCursor` como `cursor`.
- **`POST /workshop/owned`**:
  - corpo: `{ steamId, skinId, days?, expiresAt?, note? }`;
  - `days` vai de 1 a 3650;
  - `expiresAt` é ISO ou epoch ms;
  - mandar `days` **e** `expiresAt` dá 400; sem nenhum dos dois, a posse é permanente;
  - resposta **201**: `{ ok, created, owned: Owned }`. `created` é `false` quando só o prazo
    mudou;
  - erros: `WORKSHOP_SKIN_NOT_FOUND` (404) e `OWNED_ALREADY_EXPIRED` (400, data no passado).
- **`DELETE /workshop/owned/:ownedId`** responde `{ ok }`, ou 404 `OWNED_NOT_FOUND`.
- **`GET /players/:steamId/skins`** responde
  `{ ok, steamId, live: Owned[], expired: Owned[], favorites: number[] }`:
  - listas vazias quando ele não tem nada;
  - 400 `INVALID_STEAM_ID` quando o SteamID é inválido;
  - `favorites` (migração 100) são ids de skin, sem filtro de servidor, e podem apontar para uma
    skin que ele **não** possui. Ver §4.5 e §9.
- **`Owned`** tem estes campos:

  ```ts
  {
    id, steamId, skinId, expiresAt: string | null, expired: boolean,
    source: 'site' | 'panel' | 'game' | 'system' | 'migration',
    sourceRef, note, createdBy, createdAt, updatedAt,
    skin: { id, label, shortname, workshopId, description, rarity, previewUrl,
            openToAll, enabled, season, servers } | null
  }
  ```

- **`/workshop/audit`**: `source` agora pode ser `site`. As ações novas são `owned.grant`,
  `owned.revoke`, `owned.expired`, `owned.season-cleared` (§4.6), `game.give-refused` e
  `migration.*`. `site.delivered` é da frente C. `grant.*` e `collection.*` só aparecem em
  linhas antigas. **Favoritar não gera linha nenhuma** (§4.5).
- **`GET /servers/:id/workshop/status`** traz `status: { skins, ownedPlayers, streamers }`.
- **`POST /servers/:id/workshop/sync`** manda também a posse de todos os online, forçada.
- **`/workshop/collections*` e `/workshop/grants*`** respondem 404.

---

## 11. Em aberto

1. **As skins de verdade.** O catálogo hoje tem uma skin (`metal.facemask`). A lista do que a
   OrigemZ vai publicar é do dono.
2. **A tocha no kit** (§8, passo 4).
3. **O endereço da loja** que o cadeado mostra (`storeUrl`, §5.1).
4. As medições da fase 0 (§6.3 e 03 §8).
5. **Quem chama o `removeSeasonOwnership`** (§4.6). O método existe e está testado; ligá-lo ao
   wipe é da outra frente. Até ela chegar, **nenhuma skin de temporada sai da posse** — que é
   exatamente o "por padrão não é removida" que o dono pediu.
6. **A estrela na ficha do painel** (§9): a rota já entrega `favorites`; mostrar é do painel.

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

**Cuidado ao voltar o binário.** O guarda de schema (`db/schema-version.ts`) compara o **maior**
id aplicado. Um agente antigo, que conhece até a 099, abre sem reclamar um banco com a 097, e
quebra na primeira consulta a `workshop_grants`. Quem volta o binário depois da 097 precisa
voltar o banco junto: o instantâneo de antes da migração fica em `backups`. Isso vale também
para as outras worktrees que usam o banco de desenvolvimento.

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
- **Implementado (frente A):**
  - `description` e `rarity` **faltam** quando não têm valor; nunca vêm como `null`;
  - `storeUrl` vem da variável `WORKSHOP_STORE_URL` do `.env` do agente, e falta quando ela
    está vazia ou ausente;
  - as skins vêm na ordem da grade: `sort`, depois o nome;
  - o comando continua `origemz.workshop.sync <lote> <i> <n> <pedaço>`, e a resposta
    esperada a cada pedaço continua `{"ok":true}` (ou `{"ok":false,"error":"…"}`).
- **`origemz.workshop.status`** (plugin 0.3.0) deve responder
  `{"ok":true,"skins":N,"ownedPlayers":N,"streamers":N}`. `ownedPlayers` é quantos jogadores
  têm posse carregada na memória. `collections`, `grants` e `openBoxes` saem.

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
  {"secret":"…","steamId":"76561198000000000","skins":[{"id":12,"expiresAt":0},{"id":40,"expiresAt":1790000000000}]}
  ```

  - `secret` é o mesmo do `sync`. Carga com segredo errado é recusada.
  - `steamId` repete o argumento. Se não bater, o plugin recusa o lote.
  - `id` é o `id` da skin no catálogo, o mesmo do `sync`.
  - `expiresAt` vem em epoch ms, e **0 = permanente**.
  - A lista vem ordenada por `id`, e **pode vir vazia**.
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

### Como ficaram (frente A, 17/09/2026) — é o que a frente E consome

`skinId` nas rotas de posse é o **id do agente** (o mesmo do `:skinId` das rotas de skin). O
id do Workshop, quando aparece junto, se chama `workshopId`. As datas vêm em ISO.

- **Skin**, em `GET/POST/PUT /workshop/skins*`. Os campos de sempre, com três mudanças:
  - saem `permission` e `collectionId`;
  - entram `description` (`string | null`, até 280), `rarity` (`common | uncommon | rare |
    epic | legendary | null`) e `sort` (inteiro, padrão 0);
  - entra `owners`, a quantidade de posses **vivas**. Só vem na resposta.
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
- **`GET /players/:steamId/skins`** responde `{ ok, steamId, live: Owned[], expired: Owned[] }`:
  - listas vazias quando ele não tem nada;
  - 400 `INVALID_STEAM_ID` quando o SteamID é inválido.
- **`Owned`** tem estes campos:

  ```ts
  {
    id, steamId, skinId, expiresAt: string | null, expired: boolean,
    source: 'site' | 'panel' | 'game' | 'system' | 'migration',
    sourceRef, note, createdBy, createdAt, updatedAt,
    skin: { id, label, shortname, workshopId, description, rarity, previewUrl,
            openToAll, enabled, servers } | null
  }
  ```

- **`/workshop/audit`**: `source` agora pode ser `site`. As ações novas são `owned.grant`,
  `owned.revoke`, `owned.expired`, `game.give-refused` e `migration.*`. `site.delivered` é da
  frente C. `grant.*` e `collection.*` só aparecem em linhas antigas.
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

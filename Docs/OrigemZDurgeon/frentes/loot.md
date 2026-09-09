# frentes/loot.md — O QUE O JOGADOR LEVA EMBORA

**Frente:** `event-loot` · **Data:** 09/09/2026 · **Estado:** **aplicado**, compilado, não jogado.

> **Onde isto está.** O §7 foi aplicado em `Plugins/OrigemZDungeon.cs` em
> 09/09/2026, sobre o commit `c72263b` (com `event-ia` e `event-portas` dentro):
> sete patches cirúrgicos e um bloco novo de 706 linhas, +827 −43. O arquivo
> compila: `0 Erro(s)`, 84 avisos contra 69 do baseline, todos `CS0649` nas
> classes de spec (§8.6).
>
> **Não foi commitado, e não foi copiado para `Servers/`** — quem faz isso, e quem
> testa no jogo com o dono, é o coordenador. O §9 é o roteiro dele.
>
> Os patches do §7.1 ficam aqui como registro do que entrou e por quê: eles são a
> explicação de cada costura, e os números de linha são os de antes da aplicação.

---

## 0 — O resumo, em dez linhas

Hoje `Populate` cria caixas e o Rust as enche pela tabela de loot do servidor. É
tudo. Esta frente acrescenta quatro coisas, e nenhuma delas tira a primeira:

1. **Tabela própria e opcional**, por cor de sala, para o corredor e para o corpo
   do inimigo. `mode: "server"` é o padrão, e é ele que faz o BetterLoot continuar
   valendo aqui dentro. **Escrevemos a nossa** — o `SimpleLootTable` não está
   instalado neste servidor e falha em silêncio quando ausente (§2);
2. **O drop do inimigo.** A entrega do código da porta trancada é da frente
   `event-portas`, que publicou primeiro e projetou a máquina inteira; o que é meu
   é o corpo — e duas medições no IL do jogo que respondem às perguntas que ela
   deixou em aberto, uma delas evitando que o código seja **apagado** (§5);
3. **Contêiner que não é caixa**: armário, barril e mochila. O construtor pergunta
   à peça o que ela é e trata cada uma como ela pede — inclusive a descoberta que
   mais custaria caro: **o barril, dentro da masmorra de hoje, seria decoração**
   (§4);
4. **Respawn** para a masmorra permanente: o cronômetro nativo para a caixa de
   radtown, um relógio nosso para o resto, e reposição do que foi destruído (§6).

---

## 1 — Diagnóstico: o que a base 1.3.4 faz

Arquivo: `Docs/OrigemZDurgeon/DungeonBases-1.3.4.cs`, 3.883 linhas.

### 1.1 A "tabela de loot" por cor é uma lista de PREFABS, não de itens

```
197   greenLootPrefabs  = { crate_normal, crate_normal_2 }
203   blueLootPrefabs   = { crate_normal }
209   redLootPrefabs    = { crate_normal, crate_elite }
215   corridorLootPrefabs = { crate_normal, crate_tools, crate_basic, crate_normal_2 }
211   corridorNpcDensity  = 0
213   corridorLootDensity = 20
```

Quem enche essas caixas é o Rust: elas são `LootContainer` e se populam sozinhas
no `Spawn()`. A base **não escolhe um item sequer** para a caixa de uma sala. O
que ela escolhe é qual caixa nasce — e é exatamente o que o nosso plugin já faz
hoje, com o mesmo desenho.

O laço que usa isso está em **3.411–3.441** (o `switch` por cor) e **3.492–3.527**
(as caixas da sala). O do corredor, em **3.579–3.617**.

> **Um número da base que não faz o que o nome diz.** Linha 3.587:
>
> ```csharp
> int spawns = currentTier.corridorLootDensity >= 50
>     ? (currentTier.corridorLootDensity >= 100 ? 2 : 1)
>     : (lootRng.Next(50) < currentTier.corridorLootDensity ? 1 : 0);
> ```
>
> Uma "densidade 0-100" comparada contra `Next(50)`: densidade 25 já dá 50 % de
> chance, e 50 dá 100 %. O nosso `Populate` usa `rng.Next(100) < lootDensity`, que
> é o que o nome promete. **Não copie a linha 3.587.**

### 1.2 A tabela de ITENS existe na base — e é de outro plugin

```
132   [PluginReference] Plugin CopyPaste, SimpleLootTable, SuperCard, Kits, Notify;
124   public string tableName { get; set; }
125   public int tableMinItems { get; set; }
500   if (!SimpleLootTable)
501       PrintWarning("SimpleLootTable plugin not found, ...");
778   SimpleLootTable?.Call("GetSetItems", entity, slabNPC.tableName, min, max, 1f);
1829  SimpleLootTable?.Call("GetSetItems", item,   tableName, min, max, 1f, false);
1851  SimpleLootTable?.Call("GetSetItems", entity, tableName, min, max, 1f);
```

Três coisas a reparar:

- a tabela é **por NPC e por entidade colada da planta** (linhas 1.755–1.873, o
  parser da nota de spawn), **nunca por cor de sala**. A cor de sala só escolhe o
  prefab da caixa;
- o aviso da linha 501 sai **uma vez no boot**, e depois o `?.` engole todas as
  chamadas em silêncio;
- as tabelas moram no `oxide/data/` do SimpleLootTable, editadas fora do painel.

### 1.3 O drop do inimigo, e a nota do código

`OnCorpsePopulate`, linhas **767–802** — é o modelo, e funciona:

```
775   if (slabNPC.tableName != "")
776       timer.Once(2f, () => SimpleLootTable?.Call("GetSetItems", entity, ...));
781   if (slabNPC.code != "")
784       additem.text = slabNPC.code;              // uma "note" com o código
787       if (Configuration.codeInsideBody)         // 306: bool codeInsideBody = true
788           additem.MoveToContainer(corpseContainer);
793       else  // nasce um small_stash_deployed, recebe a nota e MORRE na hora:
794            //   o Rust derruba o conteúdo no chão, e o papel fica ao lado do corpo
```

O código do NPC é gravado em `InitNPC` (**822–853**, campo `code` na linha 837) e
vem da planta ou do comando de spawn. **A base nunca decide sozinha quem carrega o
código**: quem escolhe é quem desenhou a planta. Numa masmorra sorteada isso não
existe — e é o buraco que a frente `event-portas` fechou (§5).

> **O `timer.Once(2f, …)` da linha 776 não é superstição, e a razão eu medi:** o
> hook roda **antes** do `ApplyLoot` do jogo (§8.3). Aplicar a tabela ali seria
> aplicá-la antes do loot nativo, e o adiamento é o que faz a dela valer. O nosso
> bloco resolve o mesmo problema com `NextTick`, que é exato em vez de aproximado.

### 1.4 O que a base não tem, e nós precisamos

| falta | consequência |
|---|---|
| tabela de itens por cor de sala | "sala vermelha cai isto" não é dizível |
| tabela sem plugin de terceiro | configurar loot fora do painel |
| contêiner que não seja caixa | sem armário, barril ou mochila |
| respawn próprio | a permanente esvazia e fica vazia |

### 1.5 E o que o nosso plugin faz hoje

`Plugins/OrigemZDungeon.cs` (4.059 linhas, depois de `c0b4d00`):

- **1.587–1.697 `Populate`** — sorteia por SALA (a receita fala do cômodo) e por
  CÉLULA no corredor; embaralha e consome as células, para não empilhar três
  caixas no mesmo quadrado de 3 m;
- **1.765–1.789 `SpawnCrate`** — cria, `EnableSaving(false)`, `Spawn()`, `Adopt`.
  O comentário final é honesto: *"a caixa de radtown se enche sozinha ao nascer"*;
- **1.806–1.857 `SpawnNpc`** — cria o cientista, desliga o NavMesh, aplica vida,
  dano, nome, arma e (desde `c0b4d00`) a IA;
- **2.801–2.824 `FillContainer`** — enche um contêiner da PLANTA com os itens do
  JSON do CopyPaste. É o modelo de "encher à mão", e o `GiveItem` do §7 herda dele
  a lição: item cujo id o Rust não conhece mais é **pulado**, nunca deixado `null`
  dentro do inventário;
- **2.326–2.332 `OnEntityTakeDamage`** — a masmorra inteira é indestrutível.
  Guarde esta linha: ela reaparece no §4.2 como o defeito mais caro desta frente.

---

## 2 — A decisão: `SimpleLootTable` ou o nosso?

**Escrevemos o nosso.** Três razões, em ordem de peso.

**1. O plugin não existe aqui, e a falha é silenciosa.** Ele não está em
`Plugins/`, não está em `Servers/server01/oxide/plugins/` (18 plugins, nenhum
deles), e não é citado em nenhum arquivo do projeto fora da definição desta
frente. Instalado, o `?.Call(...)` funciona; ausente, ele **engole a chamada e
devolve `null`**. O admin configuraria a tabela no painel, salvaria, construiria —
e encontraria a caixa com o loot do servidor. Sem uma linha de aviso.

Este projeto já pagou exatamente essa conta: `door.hinged.wood/...` escrito de
cabeça, `CreateEntity` devolvendo `null`, o `return` engolindo, e a masmorra
subindo com os vãos abertos. Quem descobriu foi o dono, jogando.

**2. Seriam dois lugares para configurar loot.** As tabelas do SimpleLootTable
moram em `oxide/data/SimpleLootTable/*.json`, editadas à mão no servidor. A regra
do dono é que tudo se configura no painel. Uma tabela que o painel não vê é uma
tabela que o painel não pode validar, versionar nem mostrar.

**3. O transporte já existe e já foi medido.** O `sync` leva o estado inteiro em
base64 (`core/src/game/dungeon-contract.ts`), e a tabela cabe nele — com um custo
real, medido no §3.7, que muda o teto de masmorras por servidor. Um formato nosso
é um formato que podemos enxugar; o de terceiro, não.

**O que perdemos:** as tabelas que um admin já tenha escrito para o
SimpleLootTable não são importadas. Como ele não está instalado, não há nenhuma.

---

## 3 — O contrato de configuração

Tudo em inglês no código; tudo com padrão sensato para quem não mexer em nada.

### 3.1 `LootEntry` — uma linha da tabela

| campo | tipo | faixa | padrão | o que é |
|---|---|---|---|---|
| `shortname` | string | 2–64 | — (obrigatório) | `rifle.ak`, `scrap`, `sulfur` |
| `amount` | `{min,max}` int | 0–10000 | `{1,1}` | quantos. O plugin força mínimo 1 |
| `weight` | int | 1–1000 | `10` | peso no sorteio, relativo às outras linhas |
| `guaranteed` | bool | — | `false` | cai **sempre**, e não gasta sorteio |
| `skin` | int | 0–2^53 | `0` | skin do item |
| `blueprint` | bool | — | `false` | cai o **projeto**, não o item |
| `condition` | float | 0–1 | `0` | fração da durabilidade. `0` = a do jogo |

**Por que peso E `guaranteed`.** São as duas maneiras de um item cair, e a mesa
mais comum que existe precisa das duas: *"toda caixa vermelha tem 100 de scrap"*
(garantido) *"e mais dois itens desta lista"* (sorteio por peso). Com só uma
delas, essa frase não é escrevível.

**Por que `blueprint` é um campo, e não um shortname.** No Rust um projeto é um
`blueprintbase` **apontando** para o item; "criar o item e marcar como blueprint"
não existe. Um `CreateByName("rifle.ak")` com uma flag imaginária devolveria o
rifle de verdade — o erro cairia no colo do jogador, não no do admin.

### 3.2 `LootTable` — a tabela

| campo | tipo | faixa | padrão |
|---|---|---|---|
| `mode` | `'server' \| 'add' \| 'replace'` | — | `'server'` |
| `rolls` | `{min,max}` int | 0–30 | `{1,2}` |
| `entries` | `LootEntry[]` | 0–60 | `[]` |

```
server    o Rust enche a caixa, e o BetterLoot vale.  É o de hoje.
add       o Rust enche, e a nossa tabela ACRESCENTA por cima.
replace   limpamos e só a nossa tabela vale.
```

**`replace` com zero entradas não esvazia a caixa.** É quase sempre um campo que o
admin ainda não preencheu; obedecer ao pé da letra produziria uma masmorra inteira
de caixas vazias e nada no jogo diria por quê. A régua da rota (§3.5) recusa a
combinação; o plugin, se ela chegar assim mesmo, cai para o caminho `server`.

**`replace` nunca apaga um papel.** A frente `event-portas` põe a nota do código
dentro do inventário do NPC e de uma caixa. Um `Clear()` cru apagaria o código de
uma sala trancada, e ela ficaria fechada para sempre. `Wipe` (§7.2) preserva todo
item `note` — nada mais põe `note` num contêiner de masmorra, então a regra não
tem falso positivo.

### 3.3 Onde a tabela entra

| lugar | campo | vale para |
|---|---|---|
| `rooms[].table` | por cor (receita) ou por sala (planta) | todo contêiner daquela sala |
| `corridor.table` | uma só | todo contêiner do corredor |
| `npc.loot` | uma só | o corpo de todo inimigo da masmorra |

Uma tabela por cor cobre o pedido do dono ("nesta sala vermelha cai isto"). Tabela
**por prefab** ficou de fora de propósito — ver §10.

### 3.4 `respawn` — o ciclo do loot (por masmorra)

| campo | tipo | faixa | padrão |
|---|---|---|---|
| `enabled` | bool | — | `false` |
| `minutes` | int | 1–1440 | `30` |
| `onlyWhenEmpty` | bool | — | `true` |
| `rebuildDestroyed` | bool | — | `true` |

`enabled: false` é o certo no modo evento: a masmorra dura menos que qualquer
ciclo, e o loot que volta num evento de 40 minutos é loot dobrado.

### 3.5 O que muda em `core/src/types/dungeons.ts`

> **O `code`/`lock` não é meu.** A entrega do código da porta é da frente
> `event-portas` (§5), e o contrato dela — `lock.enabled`, `lock.carrier`,
> `lock.carrierScope`, `lock.onUndelivered`, `lock.noteTitle` — está no
> `portas.md` §B.4. Nada aqui o duplica.

Acrescentar ao **§1 VOCABULÁRIO**:

```ts
/** O que a tabela faz com o que o Rust já pôs na caixa. */
export const LOOT_MODES = ['server', 'add', 'replace'] as const;
export type LootMode = (typeof LOOT_MODES)[number];
```

Acrescentar ao **§2 A RÉGUA DA ESCRITA**, logo depois de `cratePrefabSchema`:

```ts
/**
 * Uma linha da tabela de loot.
 *
 * ####  O SHORTNAME NÃO É VALIDADO CONTRA UMA LISTA  ####
 *
 * É a mesma decisão do `cratePrefabSchema`: o Rust acrescenta e
 * renomeia item a cada wipe, e uma lista fechada aqui viraria uma
 * migração a cada update do jogo. Item desconhecido é PULADO pelo
 * plugin, com aviso no console — e uma tabela de vinte linhas não
 * cai inteira por causa de um nome que mudou.
 */
export const lootEntrySchema = z.object({
  shortname: z.string().min(2).max(64),
  amount: countRange('quantidade', 10000).default({ min: 1, max: 1 }),
  /** Peso no sorteio, relativo às outras linhas. */
  weight: z.number().int().min(1).max(1000).default(10),
  /** Cai sempre, e não gasta sorteio. */
  guaranteed: z.boolean().default(false),
  skin: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  /** Cai o projeto, e não o item: no Rust são coisas diferentes. */
  blueprint: z.boolean().default(false),
  /** 0 a 1 da durabilidade cheia. 0 = a do jogo. */
  condition: z.number().min(0).max(1).default(0),
});

export type LootEntryInput = z.infer<typeof lootEntrySchema>;

/**
 * A tabela de uma cor de sala, do corredor ou do corpo do inimigo.
 *
 * ####  'server' É O PADRÃO, E ISSO É O DESENHO INTEIRO  ####
 *
 * Sem tabela, a caixa de radtown se enche sozinha pela tabela de loot
 * do servidor — e é assim que o BetterLoot continua valendo dentro da
 * masmorra. Quem não mexer em nada não perde isso.
 */
export const lootTableSchema = z
  .object({
    mode: z.enum(LOOT_MODES).default('server'),
    rolls: countRange('sorteios', 30).default({ min: 1, max: 2 }),
    entries: z.array(lootEntrySchema).max(60).default([]),
  })
  .superRefine((value, ctx) => {
    // Tabela sem itens em 'add' não faz nada, e em 'replace' pediria
    // uma caixa vazia. Os dois são quase sempre um campo que ficou
    // pela metade — e nenhum dos dois dá erro no jogo.
    if (value.mode !== 'server' && value.entries.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['entries'],
        message: 'uma tabela sem itens não muda nada: use "server" ou acrescente pelo menos um item',
      });
    }
  });

export type LootTableInput = z.infer<typeof lootTableSchema>;
```

Acrescentar **um campo** a `dungeonRoomInputSchema`:

```ts
  table: lootTableSchema.prefault({}),
```

E ao corpo (`dungeonBodySchema`): `corridor.table`, `npc.loot` e o `respawn`:

```ts
    corridor: z
      .object({
        npcDensity: z.number().int().min(0).max(100).default(20),
        lootDensity: z.number().int().min(0).max(100).default(10),
        crates: z.array(cratePrefabSchema).max(20).default([]),
        table: lootTableSchema.prefault({}),          // <-- novo
      })
      .prefault({}),

    npc: z
      .object({
        health: countRange('vida', 5000).default({ min: 100, max: 150 }),
        damageScale: z.number().min(0).max(10).default(1),
        weapons: z.array(z.string().min(2).max(64)).max(20).default([]),
        names: z.array(z.string().min(1).max(40)).max(20).default([]),
        loot: lootTableSchema.prefault({}),           // <-- novo
      })
      .prefault({}),

    /**
     * O ciclo do loot.
     *
     * Desligado é o certo no modo evento: a masmorra dura menos que
     * qualquer ciclo, e loot que volta num evento de 40 minutos é loot
     * dobrado.
     */
    respawn: z
      .object({
        enabled: z.boolean().default(false),
        minutes: z.number().int().min(1).max(1440).default(30),
        onlyWhenEmpty: z.boolean().default(true),
        rebuildDestroyed: z.boolean().default(true),
      })
      .prefault({}),
```

Nas **receitas de fábrica** (`FACTORY_RECIPES`) nada muda de obrigatório: os
`prefault({})` dão `mode: 'server'` a todas, e as quatro continuam idênticas ao que
são hoje no jogo.

### 3.6 O que muda no banco, no repositório e no sync

**Migração.** A frente `event-portas` já reivindicou a **062**; esta usa a
seguinte livre. Tudo com `DEFAULT`, para que a migração não precise reescrever
linha nenhuma:

```sql
ALTER TABLE dungeon_rooms ADD COLUMN loot_table TEXT NOT NULL DEFAULT '{}';

ALTER TABLE dungeons ADD COLUMN corridor_loot_table TEXT NOT NULL DEFAULT '{}';
ALTER TABLE dungeons ADD COLUMN npc_loot_table      TEXT NOT NULL DEFAULT '{}';

ALTER TABLE dungeons ADD COLUMN respawn_enabled           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dungeons ADD COLUMN respawn_minutes           INTEGER NOT NULL DEFAULT 30;
ALTER TABLE dungeons ADD COLUMN respawn_only_when_empty   INTEGER NOT NULL DEFAULT 1;
ALTER TABLE dungeons ADD COLUMN respawn_rebuild_destroyed INTEGER NOT NULL DEFAULT 1;
```

> Antes de editar a migração: `schema_migrations`. O `tsx watch` aplica migração
> nova enquanto você escreve, e a partir daí o arquivo não é mais editável.

**`core/src/db/dungeons-repository.ts`.** A tabela é JSON numa coluna, como
`crates`/`weapons`/`names` já são (o cabeçalho do arquivo explica por quê). A
leitura usa o **mesmo tratamento do `#jsonArray`**: `lootTableSchema.safeParse` e,
se falhar, a tabela padrão com aviso — linha ilegível é descartada, nunca derruba
a masmorra inteira.

**`core/src/game/dungeon-contract.ts`.** `DungeonPayload` ganha os campos novos.

**`core/src/dungeons/sync.ts`, `#dungeonPayload` (linha 206).** Acrescentar
`table` a cada sala, `corridor.table`, `npc.loot` e `respawn`.

> **O `leanTable` abaixo NÃO foi implementado, e é de propósito.** Ele muda o
> formato do payload, e isso é decisão de arquitetura do agente — não do plugin.
> Está escrito aqui para quando o dono decidir, e o lugar exato onde ele entra é
> **este método**, entre a leitura do repositório e a montagem do
> `DungeonPayload`. Nada no C# precisa mudar junto: o plugin lê campo ausente
> como o padrão dele (os inicializadores das classes de spec), que é justamente o
> que torna o enxugamento seguro.

```ts
/**
 * A tabela, sem o que está no padrão.
 *
 * ####  O TETO DO SYNC É 50 KB, E A TABELA COME ISSO  ####
 *
 * MEDIDO em 09/09/2026: uma tabela de 8 entradas com todos os campos
 * escritos pesa 1.069 B de JSON; sem os campos em valor padrão, 589 B.
 * Numa masmorra de três salas isso é a diferença entre caber 7 e caber
 * 12 masmorras no comando.
 *
 * O plugin lê campo ausente como o padrão dele (os inicializadores das
 * classes de spec), então enxugar aqui não muda o que o jogo faz.
 */
function leanTable(table: LootTableInput) {
  if (table.mode === 'server') return undefined;   // o padrão não precisa viajar

  return {
    mode: table.mode,
    rolls: table.rolls,
    entries: table.entries.map((entry) => ({
      shortname: entry.shortname,
      amount: entry.amount,
      ...(entry.weight === 10 ? {} : { weight: entry.weight }),
      ...(entry.guaranteed ? { guaranteed: true } : {}),
      ...(entry.skin === 0 ? {} : { skin: entry.skin }),
      ...(entry.blueprint ? { blueprint: true } : {}),
      ...(entry.condition === 0 ? {} : { condition: entry.condition }),
    })),
  };
}
```

### 3.7 O peso no payload — medido

Uma masmorra de 3 salas + corredor + NPC, serializada como o `sync` a manda
(`JSON.stringify` compacto, depois base64), com o teto de
`DUNGEON_SYNC_MAX_BYTES = 50_000`:

| entradas por tabela | JSON | base64 | masmorras que cabem |
|---:|---:|---:|---:|
| 0 (só `mode: server`) | 1.875 B | 2.500 B | 20 |
| 4 | 3.381 B | 4.508 B | 11 |
| 8 | 4.920 B | 6.560 B | **7** |
| 12 | 6.429 B | 8.572 B | 5 |

O comentário do `dungeon-contract.ts` diz "cerca de 40" masmorras. **Com tabelas
de 8 itens por cor, são 7.** Com `leanTable` (§3.6) e as tabelas em `server`
omitidas, quem não usa tabela nenhuma continua nos 20+, e só quem usa paga.

O conserto óbvio, quando apertar, já está escrito no `dungeon-contract.ts`: mandar
a cada servidor só as masmorras dos eventos **ligados nele**. Esta frente não o
antecipa — só registra que ela é quem vai fazer isso apertar primeiro.

---

## 4 — Os contêineres, e o comportamento de cada um

### 4.1 As três famílias

O Rust tem três coisas bem diferentes atrás da mesma palavra "loot". O prefab
decide, e o construtor **pergunta à peça** em vez de consultar uma lista:

| família | quem é | enche sozinho? | repopula? |
|---|---|---|---|
| `LootContainer` | `crate_*`, `loot_barrel_*`, `oil_barrel`, `foodbox` | **sim**, no `Spawn()` | sim, cronômetro próprio |
| `StorageContainer` | `locker.deployed`, `woodbox_deployed`, `small_stash_deployed`, `box.wooden.large` | não — nasce **vazio** | não |
| `DroppedItemContainer` | `item_drop_backpack` | não | não, e **some sozinho** |

Consequência direta para o painel: **pôr um armário na lista de `crates` sem uma
tabela dá um armário vazio.** Não é bug, é o que o Rust faz — e o §9 pede ao dono
que confira exatamente isso.

Prefabs confirmados no `Bundles/AssetSceneManifest.json` do server01 (16.256
prefabs; §8.1):

```
assets/bundled/prefabs/radtown/crate_normal.prefab          caixa comum
assets/bundled/prefabs/radtown/crate_normal_2.prefab        caixa comum
assets/bundled/prefabs/radtown/crate_elite.prefab           caixa de elite
assets/bundled/prefabs/radtown/crate_tools.prefab           ferramentas
assets/bundled/prefabs/radtown/crate_basic.prefab           básica
assets/bundled/prefabs/radtown/crate_normal_2_food.prefab   comida
assets/bundled/prefabs/radtown/crate_normal_2_medical.prefab  remédio
assets/bundled/prefabs/radtown/foodbox.prefab               caixa de comida
assets/bundled/prefabs/radtown/loot_barrel_1.prefab         barril
assets/bundled/prefabs/radtown/loot_barrel_2.prefab         barril
assets/bundled/prefabs/radtown/oil_barrel.prefab            barril de óleo
assets/prefabs/deployable/locker/locker.deployed.prefab     armário
assets/prefabs/deployable/woodenbox/woodbox_deployed.prefab caixa de madeira
assets/prefabs/deployable/large wood storage/box.wooden.large.prefab  caixa grande
assets/prefabs/deployable/small stash/small_stash_deployed.prefab     esconderijo
assets/prefabs/misc/item drop/item_drop_backpack.prefab     mochila
```

### 4.2 O barril seria decoração — e esta é a descoberta que mais custava caro

`OnEntityTakeDamage` (linha 2.326) recusa **todo** dano em qualquer peça da
masmorra. Para uma parede, é o desenho. Para um barril, é fatal:

> **O barril não abre com E.** O loot dele só sai quando ele se parte. Blindado,
> o jogador bate nele até desistir — e nada no jogo diz por quê.

O mesmo vale para `oil_barrel`. O conserto está no patch 6 do §7.1: uma segunda
consulta, **depois** da comparação de `_name` que já descartou o servidor inteiro,
num `HashSet` de netIDs.

Quem entra nesse conjunto não é uma lista de prefabs escrita à mão: é
`StorageContainer.isLootable == false` — o campo que o **próprio prefab** declara,
e que é false exatamente nos contêineres que só entregam quebrando. O código
descobre; nós não chutamos.

### 4.3 O armário filtra o que entra

`Locker` sobrescreve `ItemFilter(BasePlayer, Item, int)`: cada linha dele só
aceita a peça daquela linha (torso, pernas, cinto…). Um `MoveToContainer` com
scrap devolve `false`, e o item fica **boiando** — item sem contêiner é vazamento,
e ele reaparece em lugar estranho.

`GiveItem` (§7.2) tenta pela porta da frente, insere à força com
`ItemContainer.Insert` se o filtro recusar, e destrói o item se nem isso couber.
O armário continua sendo o lugar certo para roupa e arma; o que o dono precisa
saber é que o resto entra torto (§9).

### 4.4 A mochila tem prazo de validade

`DroppedItemContainer` é o saco que cai quando alguém morre, e o Rust os apaga por
relógio. Numa masmorra ela vira *"o que alguém deixou para trás"* — e some se
ninguém vier. `PrepareDrop` monta o inventário (o `ServerInit` do prefab não
garante um) e chama `ResetRemovalTime` com o ciclo do respawn, ou 60 min quando
não há respawn.

---

## 5 — A fronteira com a frente `event-portas`

Ela publicou primeiro, e projetou a máquina inteira do código: sorteio, regra de
quem pode carregar (`lock.carrier`, `lock.carrierScope`), o texto do papel, o
gancho do código digitado e o `SettleLocks`, que **destranca** a sala cujo código
não achou portador. O contrato dela é melhor detalhado que o meu rascunho inicial,
e **duas máquinas para a mesma coisa é a pior saída possível**. Então:

```
   PORTAS (dona da entrega)                LOOT (esta frente)
   ────────────────────────                ──────────────────
   sorteia o código (4 dígitos)
   escolhe quem pode carregar
   monta o papel
        │  TakeCodeNote(dungeon, layout, cell, "npc"|"crate")
        │  → Item pronto, ou null
        │
        ├── SpawnNpc:  papel -> npc.inventory.containerMain
        ├── SpawnCrate: papel -> storage.inventory
        │
        ▼                                  ► que o papel CHEGUE ao corpo  (§5.1)
   SettleLocks: destranca o que             ► que o papel NÃO seja apagado (§5.2)
   ficou sem portador                       ► o que mais vem no corpo (npc.loot)
                                            ► o respawn
```

**Nenhuma linha do meu bloco cria, sorteia ou entrega código.** O que ele faz é
garantir que o que a outra frente entregou sobreviva — e as duas garantias saíram
de medições no IL do jogo, não de suposição.

### 5.1 A pergunta que ela deixou: "o corpo leva o `containerMain` junto?"

Ela escreveu que esse é *"o pior desfecho possível desta frente"* se a resposta for
não. **É sim**, e está medido no IL do `Assembly-CSharp.dll` deste servidor:

```
NPCPlayer.get_CopyInventoryToCorpse
  IL: 2 bytes  [17 2a]        ldc.i4.1 ; ret        ← true, cravado
  (HumanNPC e ScientistNPC não sobrescrevem)

NPCPlayer.CreateCorpse
  ...
  callvirt NPCPlayer.get_CopyInventoryToCorpse
  → BasePlayer.get_inventory / PlayerInventory.containerMain
    BasePlayer.get_inventory / PlayerInventory.containerWear
    BasePlayer.get_inventory / PlayerInventory.containerBelt
    callvirt LootableCorpse.TakeFrom            ← os três vão para o corpo
  ...
  call     Interface.CallHook                   ← "OnCorpsePopulate"
  ret                                            (retorno se o hook cancelar)
  callvirt NPCPlayer.ApplyLoot                  ← o loot do prefab, DEPOIS
```

Ou seja: o papel posto no `containerMain` do cientista **chega ao corpo**, e
chega **antes** do hook. Não é preciso mudar nada do lado dela.

### 5.2 O defeito que eu ia causar nela, e que essa mesma leitura pegou

O papel está no corpo **antes** do meu `OnCorpsePopulate`. Um `npc.loot` em
`mode: "replace"` faria `inventory.Clear()` — e **apagaria o código da sala
trancada**. O mesmo vale para uma caixa que recebeu o papel e cujo `replace` é
reaplicado a cada refresh, e para o tique do respawn.

Conserto, no §7.2: **`Wipe` preserva todo item `note`**, e é o único caminho de
limpeza do bloco. Nada mais põe `note` num contêiner de masmorra, então a regra
não tem falso positivo.

### 5.3 O que muda no C# dela: nada — e o meu já está casado

Ela pede duas linhas, uma no `SpawnNpc` e outra no `SpawnCrate` (C.8, itens 6 e
7). Enquanto eu escrevia, o coordenador **integrou a frente dela**: o `SpawnCrate`
do arquivo agora recebe `Layout layout` e chama `TakeCodeNote` logo depois do
`Adopt`.

O bloco do §7.2 já está casado com esse arquivo:

- `SpawnContainer` recebe o `Layout` na mesma posição que o `SpawnCrate` dela;
- a chamada de `TakeCodeNote(dungeon, layout, cell, "crate")` está lá, com o
  mesmo tratamento de `null` — só que atrás do `InventoryOf`, porque uma mochila
  também pode carregar o papel e ela **não** é `StorageContainer`.

### 5.4 E onde a chamada mora, que é o detalhe que ela avisou

Ela escreve: *"`TakeCodeNote` é idempotente por FECHADURA, não por chamada […]
chame uma vez por entidade"*. Isso decide **em qual dos meus dois métodos** a
linha entra:

| método | quando roda | serve? |
|---|---|---|
| `Furnish` | no nascimento **e a cada reposição do respawn** | **não** |
| `SpawnContainer` | uma vez por ponto de loot, no nascimento | **sim** |

No `Furnish`, cada volta do relógio do respawn pediria mais um papel — e apareceria
numa caixa qualquer o código da *próxima* sala trancada, até acabarem as
fechaduras. É o tipo de defeito que só se vê depois de uma hora de jogo.

Por isso a linha está no `SpawnContainer`, **depois** do `Furnish`: assim o papel
também não é visto pelo `replace` do nascimento, e daí em diante o `Wipe` o
protege.

---

## 6 — O respawn

### 6.1 Quem já sabe voltar sozinho

A caixa de radtown tem cronômetro próprio (`minSecondsBetweenRefresh`,
`maxSecondsBetweenRefresh`), e o `SpawnLoot` o arma sozinho. `Furnish` ajusta esses
dois campos **antes do `Spawn()`** — é o `SpawnLoot` que lê os valores para armar,
e mexer neles depois só teria efeito uma ou duas horas mais tarde.

Quando o cronômetro vence, o Rust repopula pela tabela do servidor — e o
`OnLootSpawn` devolve a nossa tabela por cima. É assim que `replace` sobrevive ao
refresh sem nenhum relógio nosso.

### 6.2 Por que nunca cancelamos o `OnLootSpawn`

Está medido neste repositório, em `Plugins/OrigemZLootRefresh.cs`. O `SpawnLoot`
nativo é:

```
inventory.Clear();
ItemManager.DoRemoves(false);
if (Interface.CallHook("OnLootSpawn", this) != null) return;   <-- aqui
PopulateLoot();
CancelLootRefreshCountdown();
if (shouldRefreshContents) StartLootRefreshCountdown(null);
```

Devolver não-nulo pula o `PopulateLoot` **e as duas linhas seguintes**: o
cronômetro não é rearmado, a marca `HasBeenLooted` fica presa em `true` e o
`FirstLooterId` nunca zera. Medido no server01 com o BetterLoot ativo:
**469 de 469 populações** perdiam o cronômetro, e 47 % dos containers do mundo
sumiram em 6 minutos porque os junkpiles leem essa marca.

Então este bloco faz como o LootRefresh faz: **devolve `null` sempre**, e conserta
o conteúdo no `NextTick`, quando o `SpawnLoot` já terminou — cancelado por outro
plugin ou não. Nesse ponto "o que tem dentro?" tem uma resposta só, e a ordem de
carga dos plugins deixa de importar.

O mesmo raciocínio vale para o `OnCorpsePopulate`, e ali o preço de cancelar é
outro: o `ApplyLoot` vem **depois** do hook (§5.1), então um retorno não-nulo faria
o corpo do cientista nascer sem nada do jogo dentro.

### 6.3 O relógio nosso, e o que ele faz

`timer.Every(minutes * 60)`, por masmorra, morto junto com ela no `Demolish`:

| situação | o que o tique faz |
|---|---|
| peça destruída (barril quebrado, mochila expirada) | recria no mesmo ponto, se `rebuildDestroyed` |
| alguém está com ela aberta (`Flags.Open`) | **pula** — trocar o conteúdo na mão do jogador parece bug |
| é `LootContainer` | **pula** — ela tem cronômetro próprio; repopular por fora dobraria o loot no mesmo minuto |
| `mode: "server"` | **pula** — não há tabela nossa para repor |
| armário / caixa de madeira / esconderijo / mochila | esvazia (preservando o papel do código) e reescreve pela tabela |

**O tique repõe, e não acumula.** Nestes contêineres não existe "o Rust já encheu":
eles nascem vazios. Deixar o `add` acrescentar por cima encheria a caixa até o
teto em algumas voltas do relógio, então o tique escreve o conteúdo inteiro,
qualquer que seja o modo.

É por isso que o `LootSpot` guarda a **posição**, e não só a entidade: sem ela, um
barril quebrado seria um buraco permanente na masmorra permanente.

---

## 7 — O C#, pronto para colar

Alvo: `Plugins/OrigemZDungeon.cs` **no commit `c72263b`** — 4.928 linhas, com
`event-ia` e `event-portas` dentro. Os números de linha são desse arquivo, e
envelhecem depressa: cada patch traz também o **texto** a casar.

### 7.1 Os sete patches cirúrgicos

---

**Patch 1 — `ActiveDungeon` (depois da linha 479, `public Timer watchdog;`).** Aditivo.

```csharp
            public Timer watchdog;

            // ####  O QUE TEM DENTRO  ####  (frente do loot)

            /// <summary>Todo ponto de loot, vivo ou à espera de respawn.</summary>
            public readonly List<LootSpot> spots = new List<LootSpot>();

            /// <summary>netID -> ponto. É como o `OnLootSpawn` nos reconhece em O(1).</summary>
            public readonly Dictionary<ulong, LootSpot> spotByEntity = new Dictionary<ulong, LootSpot>();

            /// <summary>
            /// As peças que PODEM levar dano.
            ///
            /// O barril não abre com E: o loot dele só sai quando ele se
            /// parte. Sem esta lista, a blindagem da masmorra o
            /// transformaria em decoração.
            /// </summary>
            public readonly HashSet<ulong> breakable = new HashSet<ulong>();

            /// <summary>Os inimigos, para o `OnCorpsePopulate` decidir rápido.</summary>
            public readonly HashSet<ulong> npcIds = new HashSet<ulong>();

            /// <summary>O relógio do respawn, no modo permanente.</summary>
            public Timer respawn;
        }
```

---

**Patch 2 — `Demolish` (linha 1.193), logo depois do `watchdog = null`.** Aditivo.

```csharp
            dungeon.watchdog?.Destroy();
            dungeon.watchdog = null;

            // O relógio do respawn é da masmorra, e morre com ela: vivo,
            // ele tentaria repor caixa numa masmorra derrubada.
            dungeon.respawn?.Destroy();
            dungeon.respawn = null;
```

---

**Patch 3 — `Populate` (linha 1.883): as duas chamadas de `SpawnCrate` e o fim do método.**

*Antes* (linha 1.957):

```csharp
                    if (SpawnCrate(dungeon, layout, floors, forCrates[i], prefabs[rng.Next(prefabs.Count)], rng))
                        crates++;
```

*Depois*:

```csharp
                    var table = spec == null ? null : spec.table;

                    if (SpawnContainer(dungeon, layout, floors, forCrates[i], prefabs[rng.Next(prefabs.Count)], table, rng) != null)
                        crates++;
```

*Antes* (linha 1.983):

```csharp
                    if (SpawnCrate(dungeon, layout, floors, cell, corridorCrates[rng.Next(corridorCrates.Count)], rng))
                        crates++;
```

*Depois*:

```csharp
                    var table = corridorSpec == null ? null : corridorSpec.table;

                    if (SpawnContainer(dungeon, layout, floors, cell, corridorCrates[rng.Next(corridorCrates.Count)], table, rng) != null)
                        crates++;
```

*Antes* (linha 1.998, logo depois do `SettleLocks` da frente das portas):

```csharp
            SettleLocks(dungeon);

            Debug("conteudo: " + crates + " caixas, " + npcs + " inimigos");
        }
```

*Depois*:

```csharp
            SettleLocks(dungeon);

            Debug("conteudo: " + crates + " caixas, " + npcs + " inimigos");

            // O relógio do respawn é a última coisa: antes dele, não há
            // o que repor.
            StartRespawn(dungeon);
        }
```

---

**Patch 4 — apagar `SpawnCrate` (linhas 2.067–2.106).** Ele virou o
`SpawnContainer` do bloco novo, **com a chamada de `TakeCodeNote` junto**. No
lugar, para quem for procurar:

```csharp
        // O antigo `SpawnCrate` virou o `SpawnContainer` da seção "O QUE
        // O JOGADOR LEVA EMBORA": o nome mudou porque agora nasce
        // armário, barril e mochila por ali, e cada um deles tem
        // comportamento próprio no Rust. A entrega do papel do código
        // continua igual, e mudou de linha, não de dono.
```

---

**Patch 5 — `SpawnNpc`, logo depois do `AttachAi` da linha 2.188.** Uma linha.

```csharp
            AttachAi(npc, AiProfileFor(dungeon, color));

            // ####  UMA LINHA DA FRENTE DO LOOT  ####
            //
            // É por ela que o `OnCorpsePopulate` sabe, em O(1), que
            // aquele corpo é de um inimigo NOSSO — o hook roda para
            // todo NPC do servidor.
            if (npc.net != null) dungeon.npcIds.Add(npc.net.ID.Value);

            return true;
        }
```

---

**Patch 6 — `OnEntityTakeDamage` (linha 3.095). É o que salva o barril.**

*Antes*:

```csharp
            if (entity == null || entity._name != MarkIndestructible) return null;
            if (entity is BasePlayer) return null;

            return true;
        }
```

*Depois*:

```csharp
            if (entity == null || entity._name != MarkIndestructible) return null;
            if (entity is BasePlayer) return null;

            // ####  O BARRIL É A EXCEÇÃO, E ELA É OBRIGATÓRIA  ####
            //
            // Barril não abre com E: o loot só sai quando ele se parte.
            // Blindado, ele vira decoração — o jogador bate até
            // desistir. A lista é preenchida no `Remember`, e só entra
            // nela contêiner que o próprio prefab declara como não
            // saqueável (`isLootable == false`).
            //
            // A consulta é a SEGUNDA: a comparação de `_name` acima já
            // descartou o servidor inteiro, e só o que é nosso paga
            // este hash.
            var dungeon = active;

            if (dungeon != null && entity.net != null
                && dungeon.breakable.Contains(entity.net.ID.Value)) return null;

            return true;
        }
```

> Não colide com o `OnEntityTakeDamage(ScientistNPC, HitInfo)` da frente de IA:
> são **sobrecargas**, e o Oxide chama as duas por assinatura.

---

**Patch 7 — as classes de spec.** Aditivo: quatro campos em classes existentes
(`DungeonSpec` 3.862, `CorridorSpec` 3.886, `NpcSpec` 3.895, `RoomSpec` 3.905) e
três classes novas, que podem ir logo antes de `private class ZoneSpec` (3.924).

```csharp
        // em DungeonSpec, depois de `public List<RoomSpec> rooms;`
            /// <summary>O ciclo do loot. `null` = nada volta (o certo no modo evento).</summary>
            public RespawnSpec respawn;

        // em CorridorSpec, depois de `public List<string> crates;`
            /// <summary>`null` = a tabela do servidor. Ver a seção do loot.</summary>
            public LootTableSpec table;

        // em NpcSpec, depois de `public List<string> names;`
            /// <summary>O que o corpo carrega. `null` = só o que o jogo põe.</summary>
            public LootTableSpec loot;

        // em RoomSpec, depois de `public bool locked;`
            /// <summary>`null` = a tabela do servidor. Ver a seção do loot.</summary>
            public LootTableSpec table;
```

```csharp
        /// <summary>
        /// A tabela de loot de uma cor de sala, do corredor ou do corpo.
        ///
        ///   `server`   o Rust enche a caixa, e o BetterLoot vale (padrão)
        ///   `add`      o Rust enche, e a nossa tabela acrescenta
        ///   `replace`  só a nossa tabela
        /// </summary>
        private class LootTableSpec
        {
            public string mode;
            public Range rolls;
            public List<LootEntrySpec> entries;
        }

        private class LootEntrySpec
        {
            public string shortname;
            public Range amount;
            public int weight;
            /// <summary>Cai sempre, e não gasta sorteio.</summary>
            public bool guaranteed;
            public ulong skin;
            /// <summary>Cai como projeto, e não como o item.</summary>
            public bool blueprint;
            /// <summary>0 a 1 da durabilidade cheia. 0 = a do jogo.</summary>
            public float condition;
        }

        /// <summary>
        /// O ciclo do loot numa masmorra permanente.
        ///
        /// ####  OS PADRÕES MORAM AQUI, E NÃO SÓ NO PAINEL  ####
        ///
        /// Campo ausente no JSON deixa o inicializador de pé — é o
        /// Newtonsoft só escrever o que veio. Sem isto, um payload
        /// antigo faria `onlyWhenEmpty` virar false em silêncio, e a
        /// masmorra dobraria o loot a cada ciclo.
        /// </summary>
        private class RespawnSpec
        {
            public bool enabled;
            public int minutes = 30;
            public bool onlyWhenEmpty = true;
            public bool rebuildDestroyed = true;
        }
```

### 7.2 O bloco novo

Vai inteiro, como está, em qualquer ponto dentro da classe — o rascunho que
compilou o pôs logo antes de `private class SyncPayload`. Ele usa seis coisas que
já existem no arquivo e não são redefinidas aqui: `Roll(rng, Range)`,
`SpotIn(floor, rng)`, `Adopt(dungeon, entity)`, `Debug(mensagem)`, o campo
`active` e o `TakeCodeNote(…)` da frente `event-portas`.

```csharp
        // ============================================================
        //  O QUE O JOGADOR LEVA EMBORA
        //
        //  ####  A TABELA É OPCIONAL, E ESSA É A DECISÃO INTEIRA  ####
        //
        //  Sem tabela, a caixa de radtown se enche sozinha ao nascer,
        //  pela tabela de loot do servidor — e é assim que o BetterLoot
        //  continua valendo aqui dentro. `mode: "server"` é o padrão
        //  justamente para que quem não mexer em nada não perca isso.
        //
        //  ####  A TABELA É NOSSA, E NÃO DO SimpleLootTable  ####
        //
        //  A base 1.3.4 chama `SimpleLootTable?.Call("GetSetItems", …)`
        //  nas linhas 778, 1829 e 1851. O `?.` engole a chamada quando o
        //  plugin não está instalado: o admin configura a tabela, salva,
        //  constrói — e encontra o loot do servidor, sem UMA linha de
        //  aviso. É o mesmo modo de falha do prefab errado que já custou
        //  uma masmorra inteira neste projeto.
        //
        //  E o SimpleLootTable guarda as tabelas dele em `oxide/data/`,
        //  editadas à mão. Depender dele seria pedir ao dono que
        //  configurasse loot em DOIS lugares.
        //
        //  ####  NUNCA CANCELAMOS UM HOOK DE POPULAÇÃO  ####
        //
        //  MEDIDO neste projeto (`Plugins/OrigemZLootRefresh.cs`): quem
        //  devolve não-nulo em `OnLootSpawn` pula o `PopulateLoot` e as
        //  duas linhas seguintes do `SpawnLoot` — o cronômetro de
        //  refresh não é rearmado, a marca de saqueado fica presa e o
        //  primeiro saqueador nunca é zerado. Foram 469 de 469
        //  populações perdendo o cronômetro com o BetterLoot ativo.
        //
        //  E MEDIDO no IL do `NPCPlayer.CreateCorpse` deste servidor: o
        //  `OnCorpsePopulate` é chamado ANTES do `ApplyLoot`, e um
        //  retorno não-nulo o pula — o corpo do cientista nasceria sem
        //  nada do jogo dentro.
        //
        //  Então os dois hooks daqui devolvem `null` SEMPRE, e o
        //  trabalho acontece no tique seguinte.
        // ============================================================

        /// <summary>
        /// O sorteio de fora da construção.
        ///
        /// O `rng` do `GenerateRooms` morre quando a masmorra termina de
        /// subir; o refresh e o corpo do inimigo acontecem depois dele.
        /// </summary>
        private readonly System.Random lootRng = new System.Random();

        /// <summary>
        /// Um ponto de loot da masmorra, e o que nasce nele.
        ///
        /// ####  O PONTO SOBREVIVE À PEÇA  ####
        ///
        /// Guardar a POSIÇÃO, e não só a entidade, é o que faz o
        /// respawn poder repor um barril depois de ele ter sido
        /// quebrado — que é o fim normal de um barril.
        /// </summary>
        private class LootSpot
        {
            public string prefab;
            public (int, int) cell;
            public Vector3 position;
            public Quaternion rotation;
            public LootTableSpec table;
            public BaseEntity entity;
        }

        // ------------------------------------------------------------
        //  NASCER
        // ------------------------------------------------------------

        /// <summary>
        /// Um contêiner no chão da célula.
        ///
        /// ####  NEM TODO CONTÊINER É UMA CAIXA  ####
        ///
        /// O prefab decide o comportamento, e o Rust tem três famílias
        /// bem diferentes atrás da mesma palavra "loot":
        ///
        ///   `LootContainer`         a caixa de radtown e o barril: se
        ///                           enchem sozinhos ao nascer e têm
        ///                           cronômetro de refresh próprio;
        ///   `StorageContainer`      o armário, a caixa de madeira e o
        ///                           esconderijo: nascem VAZIOS, e sem
        ///                           tabela ficam vazios para sempre;
        ///   `DroppedItemContainer`  a mochila: nasce vazia, não
        ///                           repopula e some sozinha com o
        ///                           tempo.
        ///
        /// Por isso não há lista de prefabs cravada aqui: o construtor
        /// pergunta à peça o que ela é, e trata cada uma como ela pede.
        /// </summary>
        private LootSpot SpawnContainer(
            ActiveDungeon dungeon,
            Layout layout,
            Dictionary<(int, int), BuildingBlock> floors,
            (int, int) cell,
            string prefab,
            LootTableSpec table,
            System.Random rng)
        {
            BuildingBlock floor;
            if (!floors.TryGetValue(cell, out floor) || floor == null) return null;

            var spot = new LootSpot
            {
                prefab = prefab,
                cell = cell,
                position = SpotIn(floor, rng),
                rotation = Quaternion.Euler(0f, rng.Next(360), 0f),
                table = table,
            };

            if (!Furnish(dungeon, spot)) return null;

            dungeon.spots.Add(spot);

            // ####  UMA LINHA DA FRENTE DAS PORTAS  ####
            //
            // Ver `TakeCodeNote`: ela devolve o papel do codigo de uma
            // sala trancada, ja marcado como entregue, ou `null`.
            //
            // ####  AQUI, E NAO NO `Furnish`  ####
            //
            // `TakeCodeNote` e idempotente por FECHADURA, e nao por
            // chamada: cada chamada consome a proxima sala trancada
            // ainda sem portador. O `Furnish` roda de novo a cada
            // reposicao do respawn - e o papel da sala seguinte
            // apareceria numa caixa a cada volta do relogio.
            //
            // Este metodo roda uma vez por ponto, no nascimento. E o
            // lugar certo.
            var note = TakeCodeNote(dungeon, layout, cell, "crate");

            if (note != null)
            {
                var inventory = InventoryOf(spot.entity);

                if (inventory == null || !note.MoveToContainer(inventory)) note.Remove();
            }

            return spot;
        }

        /// <summary>
        /// Põe de pé a peça de um ponto de loot — no nascimento e no
        /// respawn.
        /// </summary>
        private bool Furnish(ActiveDungeon dungeon, LootSpot spot)
        {
            // O ponto pode estar reocupando o lugar de uma peça morta:
            // sem tirar o registro velho, o `OnLootSpawn` continuaria
            // consertando um fantasma.
            Forget(dungeon, spot);

            var entity = GameManager.server.CreateEntity(spot.prefab, spot.position, spot.rotation);

            if (entity == null)
            {
                // Prefab que o Rust não conhece mais é PULADO, com
                // aviso. O `CreateEntity` devolve null EM SILÊNCIO — foi
                // assim que a masmorra subiu uma vez com os vãos
                // abertos, e o preço de repetir isso é uma sala sem
                // nada dentro que ninguém explica.
                PrintWarning("contêiner desconhecido, pulado: " + spot.prefab);
                return false;
            }

            entity.OwnerID = 0UL;
            entity.EnableSaving(false);

            // ####  O CRONÔMETRO É AJUSTADO ANTES DO Spawn  ####
            //
            // `Spawn()` chama `ServerInit` -> `SpawnLoot`, e é o
            // `SpawnLoot` que arma o cronômetro com os valores que
            // encontrar. Mexer neles depois só teria efeito no ciclo
            // seguinte — ou seja, uma ou duas horas mais tarde.
            var loot = entity.GetComponent<LootContainer>();
            var respawn = dungeon.spec == null ? null : dungeon.spec.respawn;

            if (loot != null && respawn != null)
            {
                var seconds = respawn.enabled ? Mathf.Clamp(respawn.minutes, 1, 1440) * 60f : 0f;

                loot.minSecondsBetweenRefresh = seconds;
                loot.maxSecondsBetweenRefresh = seconds <= 0f ? 0f : seconds * 1.5f;
            }

            var drop = entity as DroppedItemContainer;

            if (drop != null)
            {
                drop.playerSteamID = 0UL;
                drop.playerName = "";
            }

            entity.Spawn();
            Adopt(dungeon, entity);

            if (drop != null) PrepareDrop(dungeon, drop);

            spot.entity = entity;
            Remember(dungeon, entity, spot);

            ApplyTable(entity, spot.table, lootRng);
            return true;
        }

        /// <summary>
        /// A mochila: inventário e prazo de validade.
        ///
        /// ####  ELA SOME SOZINHA, E ISSO É DO JOGO  ####
        ///
        /// `DroppedItemContainer` é o saco que cai quando alguém morre,
        /// e o Rust apaga esses sacos por relógio. Numa masmorra ela
        /// vira "o que alguém deixou para trás" — e some se ninguém
        /// vier. Por isso o prazo acompanha o ciclo do respawn, e o
        /// respawn a repõe no modo permanente.
        /// </summary>
        private void PrepareDrop(ActiveDungeon dungeon, DroppedItemContainer drop)
        {
            if (drop.inventory == null)
            {
                drop.inventory = new ItemContainer();
                drop.inventory.ServerInitialize(null, Mathf.Max(6, drop.maxItemCount));
                drop.inventory.GiveUID();
                drop.inventory.entityOwner = drop;
            }

            var respawn = dungeon.spec == null ? null : dungeon.spec.respawn;
            var minutes = respawn != null && respawn.enabled ? Mathf.Clamp(respawn.minutes, 1, 1440) : 60;

            drop.ResetRemovalTime(minutes * 60f);
        }

        /// <summary>Liga o netID da peça ao ponto, para o hook achá-la em O(1).</summary>
        private void Remember(ActiveDungeon dungeon, BaseEntity entity, LootSpot spot)
        {
            if (entity == null || entity.net == null) return;

            var id = entity.net.ID.Value;
            dungeon.spotByEntity[id] = spot;

            // ####  O BARRIL PRECISA PODER QUEBRAR  ####
            //
            // `OnEntityTakeDamage` recusa todo dano na masmorra, e num
            // barril isso é fatal: ele não abre com E — o loot só sai
            // quando ele se parte. O jogador bateria nele até desistir,
            // e nada no jogo diria por quê.
            //
            // Quem responde qual é qual é o próprio prefab: `isLootable`
            // é false exatamente nos contêineres que só entregam
            // quebrando.
            var storage = entity as StorageContainer;

            if (storage != null && !storage.isLootable) dungeon.breakable.Add(id);
        }

        /// <summary>Desfaz o registro da peça anterior do ponto.</summary>
        private void Forget(ActiveDungeon dungeon, LootSpot spot)
        {
            var old = spot.entity;
            spot.entity = null;

            if (old == null) return;

            if (old.net != null)
            {
                var id = old.net.ID.Value;
                dungeon.spotByEntity.Remove(id);
                dungeon.breakable.Remove(id);
            }

            dungeon.entities.Remove(old);

            if (!old.IsDestroyed) old.Kill();
        }

        // ------------------------------------------------------------
        //  A TABELA
        // ------------------------------------------------------------

        /// <summary>Aplica a tabela ao inventário de uma peça.</summary>
        private void ApplyTable(BaseEntity entity, LootTableSpec table, System.Random rng)
        {
            if (entity == null || entity.IsDestroyed) return;

            // A pergunta do modo vem ANTES da do inventário: no caminho
            // padrão não há por que procurar contêiner nenhum, e o
            // aviso abaixo sairia à toa em cada peça da masmorra.
            var mode = ModeOf(table);
            if (mode == "server") return;

            var inventory = InventoryOf(entity);

            if (inventory == null)
            {
                PrintWarning("tabela aplicada a algo sem inventário: " + entity.ShortPrefabName);
                return;
            }

            ApplyTable(inventory, table, rng);
        }

        /// <summary>
        /// Aplica a tabela a um inventário.
        ///
        /// ####  O CORPO NÃO TEM `inventory`  ####
        ///
        /// `LootableCorpse` guarda `containers[]`, e não é
        /// `StorageContainer` nem `DroppedItemContainer` — a versão
        /// acima devolveria "sem inventário" e o loot do inimigo
        /// simplesmente não cairia. Por isso a sobrecarga existe: o
        /// `OnCorpsePopulate` já tem em mãos o contêiner certo.
        ///
        /// ####  TABELA VAZIA NÃO ESVAZIA CAIXA  ####
        ///
        /// `replace` com zero entradas é quase sempre um campo que o
        /// admin ainda não preencheu, e não um pedido de caixa vazia.
        /// Obedecer ao pé da letra produziria uma masmorra inteira de
        /// caixas vazias, e nada no jogo diria por quê.
        /// </summary>
        private void ApplyTable(ItemContainer inventory, LootTableSpec table, System.Random rng)
        {
            if (inventory == null) return;

            var mode = ModeOf(table);
            if (mode == "server") return;

            // O sorteio vem ANTES de qualquer limpeza: é o que faz
            // "tabela vazia não esvazia caixa" valer.
            var items = RollItems(table, rng);
            if (items.Count == 0) return;

            if (mode == "replace") Wipe(inventory);

            foreach (var item in items) GiveItem(inventory, item);
        }

        /// <summary>
        /// Esvazia o contêiner — menos os papéis.
        ///
        /// ####  UM `Clear()` CRU APAGARIA O CÓDIGO DA PORTA  ####
        ///
        /// A frente das portas põe a nota do código no inventário do NPC
        /// (que o corpo herda) e dentro de uma caixa. Apagá-la aqui
        /// deixaria a sala trancada fechada para sempre, sem nada no
        /// jogo dizendo por quê — é o pior desfecho que esta frente pode
        /// causar na outra.
        ///
        /// Nada mais põe `note` num contêiner de masmorra, então a regra
        /// não tem falso positivo.
        /// </summary>
        private void Wipe(ItemContainer inventory)
        {
            var saved = new List<Item>();

            // De trás para frente: `RemoveFromContainer` mexe na mesma
            // lista que estamos percorrendo.
            for (var i = inventory.itemList.Count - 1; i >= 0; i--)
            {
                var item = inventory.itemList[i];

                if (item == null || item.info == null) continue;
                if (item.info.shortname != "note") continue;

                item.RemoveFromContainer();
                saved.Add(item);
            }

            inventory.Clear();
            ItemManager.DoRemoves();

            foreach (var note in saved) GiveItem(inventory, note);
        }

        private static string ModeOf(LootTableSpec table) =>
            table == null || string.IsNullOrEmpty(table.mode) ? "server" : table.mode;

        /// <summary>
        /// Sorteia os itens de uma tabela.
        ///
        /// ####  DUAS MANEIRAS DE CAIR, E AS DUAS SÃO NECESSÁRIAS  ####
        ///
        /// `guaranteed` cai SEMPRE e não gasta sorteio — é o "toda caixa
        /// vermelha tem 100 de scrap". O resto disputa `rolls` vagas por
        /// peso — é o "e mais dois itens desta lista".
        ///
        /// Sem as duas, o admin não consegue escrever a mesa mais comum
        /// que existe: um piso garantido mais um prêmio incerto.
        /// </summary>
        private List<Item> RollItems(LootTableSpec table, System.Random rng)
        {
            var made = new List<Item>();

            if (table == null || table.entries == null || table.entries.Count == 0) return made;

            var pool = new List<LootEntrySpec>();
            var total = 0;

            foreach (var entry in table.entries)
            {
                if (entry == null || string.IsNullOrEmpty(entry.shortname)) continue;

                if (entry.guaranteed)
                {
                    Mint(made, entry, rng);
                    continue;
                }

                pool.Add(entry);
                total += Mathf.Max(1, entry.weight);
            }

            var rolls = Mathf.Clamp(Roll(rng, table.rolls), 0, 30);

            for (var i = 0; i < rolls && total > 0; i++)
            {
                var pick = rng.Next(total);

                foreach (var entry in pool)
                {
                    pick -= Mathf.Max(1, entry.weight);
                    if (pick >= 0) continue;

                    Mint(made, entry, rng);
                    break;
                }
            }

            return made;
        }

        /// <summary>Cria um item da entrada, ou avisa e desiste.</summary>
        private void Mint(List<Item> into, LootEntrySpec entry, System.Random rng)
        {
            var amount = Mathf.Max(1, Roll(rng, entry.amount));
            Item item;

            if (entry.blueprint)
            {
                // ####  O BP NÃO É O ITEM  ####
                //
                // Blueprint no Rust é um `blueprintbase` APONTANDO para
                // o item. "Criar o item e marcar como blueprint" não
                // existe — e um `CreateByName("rifle.ak")` com a flag
                // sonhada devolveria o rifle de verdade.
                var target = ItemManager.FindItemDefinition(entry.shortname);

                if (target == null)
                {
                    PrintWarning("item desconhecido na tabela: " + entry.shortname);
                    return;
                }

                item = ItemManager.CreateByName("blueprintbase", 1, 0UL);
                if (item == null) return;

                item.blueprintTarget = target.itemid;
            }
            else
            {
                item = ItemManager.CreateByName(entry.shortname, amount, entry.skin);

                if (item == null)
                {
                    // Um shortname que o Rust não conhece mais é
                    // PULADO, com aviso: uma tabela de vinte linhas não
                    // pode cair inteira porque um item foi renomeado
                    // num update.
                    PrintWarning("item desconhecido na tabela: " + entry.shortname);
                    return;
                }
            }

            if (entry.condition > 0f && entry.condition <= 1f && item.hasCondition)
                item.conditionNormalized = entry.condition;

            into.Add(item);
        }

        /// <summary>O inventário de qualquer uma das três famílias.</summary>
        private static ItemContainer InventoryOf(BaseEntity entity)
        {
            var storage = entity as StorageContainer;
            if (storage != null) return storage.inventory;

            var drop = entity as DroppedItemContainer;
            if (drop != null) return drop.inventory;

            return null;
        }

        /// <summary>
        /// Põe o item dentro, ou o destrói.
        ///
        /// ####  O ARMÁRIO RECUSA O QUE NÃO É ROUPA  ####
        ///
        /// `Locker` tem filtro próprio (`ItemFilter`): cada linha só
        /// aceita a peça daquela linha. Um item recusado voltaria como
        /// `false` e ficaria BOIANDO na memória — item sem contêiner é
        /// vazamento, e ele reaparece em lugares estranhos.
        ///
        /// Então: tenta pela porta da frente, insere à força se o filtro
        /// recusar, e destrói se nem isso couber.
        /// </summary>
        private void GiveItem(ItemContainer container, Item item)
        {
            if (item.MoveToContainer(container)) return;
            if (container.Insert(item)) return;

            item.Remove();
        }

        // ------------------------------------------------------------
        //  O REFRESH
        // ------------------------------------------------------------

        /// <summary>
        /// O Rust repopulou uma caixa nossa — a tabela volta por cima.
        ///
        /// ####  DEVOLVER NÃO-NULO AQUI É O DEFEITO, NÃO O CONSERTO  ####
        ///
        /// Ver o cabeçalho da seção: cancelar este hook pula o
        /// `PopulateLoot`, deixa a caixa sem cronômetro e a marca de
        /// saqueado presa em true. Foi medido em 469 de 469 populações
        /// neste servidor.
        /// </summary>
        private object OnLootSpawn(LootContainer container)
        {
            // A primeira comparação é o que torna isto barato: este
            // método roda em TODA população do servidor, centenas por
            // minuto.
            var dungeon = active;

            if (dungeon == null || container == null || container.IsDestroyed) return null;
            if (container.net == null) return null;

            LootSpot spot;
            if (!dungeon.spotByEntity.TryGetValue(container.net.ID.Value, out spot)) return null;
            if (ModeOf(spot.table) == "server") return null;

            // O conserto é no tique seguinte, quando o `SpawnLoot`
            // terminou — cancelado por outro plugin ou não. É nesse
            // ponto que "o que tem dentro?" tem uma resposta só, e a
            // ordem de carga dos plugins deixa de importar.
            NextTick(() =>
            {
                if (active != dungeon) return;
                if (container == null || container.IsDestroyed) return;

                ApplyTable(container, spot.table, lootRng);
            });

            return null;
        }

        /// <summary>
        /// O relógio do respawn, no modo permanente.
        ///
        /// ####  A CAIXA DE RADTOWN NÃO PRECISA DE NÓS  ####
        ///
        /// Ela tem cronômetro próprio, já ajustado no `Furnish`, e o
        /// `OnLootSpawn` devolve a tabela por cima. Este relógio existe
        /// para as outras duas famílias — a caixa de madeira, o armário
        /// e a mochila, que nascem vazias e nunca mais se enchem — e
        /// para repor o que foi destruído.
        /// </summary>
        private void StartRespawn(ActiveDungeon dungeon)
        {
            var spec = dungeon.spec == null ? null : dungeon.spec.respawn;
            if (spec == null || !spec.enabled) return;

            var minutes = Mathf.Clamp(spec.minutes, 1, 1440);

            dungeon.respawn = timer.Every(minutes * 60f, () => RespawnTick(dungeon));
        }

        private void RespawnTick(ActiveDungeon dungeon)
        {
            if (dungeon != active)
            {
                // A masmorra caiu e o relógio sobreviveu: ele se
                // desliga sozinho, em vez de mexer numa masmorra que já
                // não é.
                dungeon.respawn?.Destroy();
                dungeon.respawn = null;
                return;
            }

            var spec = dungeon.spec == null ? null : dungeon.spec.respawn;
            if (spec == null) return;

            var rebuilt = 0;
            var refilled = 0;

            foreach (var spot in dungeon.spots)
            {
                if (spot.entity == null || spot.entity.IsDestroyed)
                {
                    if (!spec.rebuildDestroyed) continue;
                    if (Furnish(dungeon, spot)) rebuilt++;
                    continue;
                }

                // Trocar o conteúdo debaixo da mão de quem está com a
                // caixa aberta parece bug, e não desenho.
                if (spot.entity.HasFlag(BaseEntity.Flags.Open)) continue;

                // Esta tem cronômetro próprio. Repopular por fora
                // dobraria o loot no mesmo minuto.
                if (spot.entity is LootContainer) continue;

                // Sem tabela nossa não há o que repor: um contêiner que
                // não se enche sozinho e não tem receita fica vazio, e
                // isso é o que o admin pediu ao não escrever nada.
                if (ModeOf(spot.table) == "server") continue;

                var inventory = InventoryOf(spot.entity);
                if (inventory == null) continue;
                if (spec.onlyWhenEmpty && inventory.itemList.Count > 0) continue;

                var items = RollItems(spot.table, lootRng);
                if (items.Count == 0) continue;

                // ####  O CICLO REPÕE, E NÃO ACUMULA  ####
                //
                // Aqui não existe "o Rust já encheu": estes contêineres
                // nascem vazios. Então o tique escreve o conteúdo
                // inteiro, seja o modo `add` ou `replace` — deixar o
                // `add` acrescentar por cima encheria a caixa até o
                // teto em algumas voltas do relógio.
                //
                // `Wipe` preserva o papel do código; ver o comentário
                // dele.
                Wipe(inventory);

                foreach (var item in items) GiveItem(inventory, item);
                refilled++;
            }

            if (rebuilt + refilled > 0)
                Debug("respawn: " + rebuilt + " recolocado(s), " + refilled + " reabastecido(s)");
        }

        // ------------------------------------------------------------
        //  O CORPO DO INIMIGO
        // ------------------------------------------------------------

        /// <summary>
        /// O que o cientista da masmorra leva no corpo.
        ///
        /// ####  O HOOK ACONTECE ANTES DO ApplyLoot  ####
        ///
        /// MEDIDO no IL do `NPCPlayer.CreateCorpse` deste servidor. A
        /// ordem é:
        ///
        ///   TakeFrom(containerMain, containerWear, containerBelt)
        ///   Spawn()
        ///   Interface.CallHook("OnCorpsePopulate", …)   <-- aqui
        ///   ApplyLoot(corpse)                            <-- o loot do prefab
        ///
        /// Duas consequências, e as duas mudam o código:
        ///
        ///   1. devolver não-nulo PULA o `ApplyLoot`, e o corpo nasce
        ///      sem o loot do jogo. Devolvemos `null` sempre;
        ///   2. aplicar a nossa tabela AQUI seria aplicá-la antes do
        ///      loot nativo — e `replace` não substituiria nada, porque
        ///      o jogo põe o dele depois. Por isso o trabalho vai para o
        ///      `NextTick`.
        ///
        /// E é por causa do `TakeFrom` da primeira linha que o papel do
        /// código, posto no `containerMain` do cientista pela frente das
        /// portas, CHEGA ao corpo. `NPCPlayer.CopyInventoryToCorpse` é
        /// `true` cravado no IL (`ldc.i4.1; ret`), e nem o `HumanNPC`
        /// nem o `ScientistNPC` o sobrescrevem.
        /// </summary>
        private object OnCorpsePopulate(BasePlayer npcPlayer, BaseCorpse corpse)
        {
            var dungeon = active;

            if (dungeon == null || npcPlayer == null || corpse == null) return null;
            if (npcPlayer.net == null) return null;
            if (!dungeon.npcIds.Contains(npcPlayer.net.ID.Value)) return null;

            var npcSpec = dungeon.spec == null ? null : dungeon.spec.npc;
            var table = npcSpec == null ? null : npcSpec.loot;

            if (ModeOf(table) == "server") return null;

            var lootable = corpse as LootableCorpse;
            if (lootable == null) lootable = corpse.GetComponentInParent<LootableCorpse>();
            if (lootable == null) return null;

            NextTick(() =>
            {
                if (active != dungeon) return;
                if (lootable == null || lootable.IsDestroyed) return;
                if (lootable.containers == null || lootable.containers.Length == 0) return;

                ApplyTable(lootable.containers[0], table, lootRng);
            });

            return null;
        }
```

---

## 8 — O que foi medido

Tudo abaixo foi medido nesta máquina, em 09/09/2026, contra o `Servers/server01`.
Nada foi jogado — ver o §8.6.

### 8.1 Os prefabs vieram de um arquivo do jogo, não da memória

`Servers/server01/Bundles/AssetSceneManifest.json`, 1,3 MB, **16.256 prefabs**
distintos. É a lista de assets empacotados deste servidor, e é dela que saíram
todos os caminhos do §4.1 — inclusive os quatro que eu teria escrito errado de
cabeça:

```
assets/prefabs/deployable/locker/locker.deployed.prefab        (e não .../locker/locker.prefab)
assets/prefabs/misc/item drop/item_drop_backpack.prefab        (com espaço em "item drop")
assets/prefabs/deployable/small stash/small_stash_deployed.prefab   (com espaço em "small stash")
assets/prefabs/deployable/large wood storage/box.wooden.large.prefab
```

```bash
grep -oi '"Assets/[a-z0-9_./ -]*\.prefab"' Servers/server01/Bundles/AssetSceneManifest.json \
  | tr -d '"' | tr 'A-Z' 'a-z' | sort -u
```

### 8.2 As APIs vieram do `Assembly-CSharp.dll`, não de um fórum

O `ReflectionOnlyLoad` do .NET Framework **não abre** este assembly ("método
non-abstract, non-.cctor em uma interface": ele usa métodos de interface com
implementação, de C# 8). O que funciona é ler os metadados sem carregar nada —
`System.Reflection.Metadata`, num utilitário de 60 linhas.

O que isso confirmou, e que mudou o código:

| medido | consequência |
|---|---|
| `LootContainer : StorageContainer`, com `minSecondsBetweenRefresh`, `maxSecondsBetweenRefresh`, `HasBeenLooted`, `FirstLooterId`, `SpawnLoot`, `PopulateLoot` | §6.1 e §6.2 |
| `Locker : StorageContainer`, e ele **sobrescreve `ItemFilter`** | §4.3 — o armário recusa o que não é roupa |
| `StorageContainer.isLootable` é campo do prefab | §4.2 — é o que distingue barril de caixa em runtime |
| `DroppedItemContainer : BaseCombatEntity` (**não** é StorageContainer), com `inventory`, `ResetRemovalTime(float)`, `maxItemCount` | §4.4 — o `InventoryOf` precisa das duas famílias |
| `NPCPlayerCorpse : PlayerCorpse : LootableCorpse`, com `containers[]` e **sem** `inventory` | a sobrecarga de `ApplyTable` |
| `ItemManager.CreateByName(string, int, ulong)` e `FindItemDefinition(string)` | `Mint` |
| `Item.blueprintTarget`, `hasCondition`, `conditionNormalized`, `RemoveFromContainer()`, `info.shortname` | `Mint` e `Wipe` |
| `ItemContainer.Insert(Item)`, `Clear()`, `ServerInitialize(Item, int)`, `GiveUID()` | `GiveItem` e `PrepareDrop` |

### 8.3 O IL do `NPCPlayer.CreateCorpse` — a medição que mudou o desenho

Duas coisas saíram daqui, e as duas eram suposição antes:

```
NPCPlayer.get_CopyInventoryToCorpse
  IL: 2 bytes  [17 2a]   =   ldc.i4.1 ; ret      → true, cravado
  (HumanNPC e ScientistNPC não sobrescrevem)

NPCPlayer.CreateCorpse  (405 bytes de IL)
  ...
  callvirt NPCPlayer.get_CopyInventoryToCorpse
      ldfld PlayerInventory.containerMain
      ldfld PlayerInventory.containerWear
      ldfld PlayerInventory.containerBelt
      callvirt LootableCorpse.TakeFrom      ← o inventário do NPC vai para o corpo
  ...
  call     Interface.CallHook               ← "OnCorpsePopulate"
  ret                                        (se o hook devolver não-nulo)
  callvirt NPCPlayer.ApplyLoot              ← o loot do prefab, DEPOIS do hook
```

1. **o corpo leva o `containerMain` junto** — é a resposta à pergunta que o
   `portas.md` deixou em aberto, e o papel do código chega ao corpo (§5.1);
2. **o hook roda antes do `ApplyLoot`** — então a nossa tabela do NPC não pode ser
   aplicada dentro do hook (o loot nativo entraria depois e o `replace` não
   substituiria nada), e cancelar o hook faria o corpo nascer sem nada do jogo.
   O bloco aplica no `NextTick` e devolve `null` sempre (§5.2).

O `HumanNPC.ApplyLoot` confirma de onde vem o loot nativo do cientista:
`LootSpawnSlots` → `LootSpawn.SpawnIntoContainer(corpse.containers[0], …)`.

### 8.4 Os hooks existem neste servidor

As user strings do `Assembly-CSharp.dll` são UTF-16, e metade delas cai em offset
ímpar — um `grep` ingênuo não as vê (foi o que aconteceu na primeira tentativa, e
`OnLootSpawn` "não existia"). Lendo o arquivo inteiro nas duas paridades:

```
OnCorpsePopulate ✔    OnLootSpawn ✔    OnEntityDeath ✔    OnCodeEntered ✔
CanLootEntity ✔       OnLootEntity ✔   OnItemAddedToContainer ✔   OnNpcTarget ✔
```

Os dois que este bloco usa — `OnCorpsePopulate` e `OnLootSpawn` — estão lá, no
assembly já emendado pelo Oxide deste servidor.

### 8.5 O custo no `sync`, e o teto que ele encosta

§3.7, com a tabela completa: **uma masmorra com 8 itens por cor pesa 6.560 B em
base64**, e o teto de 50 KB comporta 7. O `dungeon-contract.ts` diz "cerca de 40" —
esse número passa a valer só para quem deixar tudo em `mode: "server"`.

Enxugar os campos em valor padrão corta a tabela quase pela metade:

```
tabela completa (8 entradas): 1.069 B json -> 1.428 B base64
tabela enxuta   (8 entradas):   589 B json ->   788 B base64
```

### 8.6 O plugin compila

```
$ dotnet build core/scripts/pluginlint/pluginlint.csproj -t:Rebuild \
    -p:PluginFile="<rascunho: o arquivo de hoje + os 7 patches + o bloco>" -v q --nologo
    84 Aviso(s)
     0 Erro(s)
```

Baseline do arquivo de hoje (com `event-ia` e `event-portas` dentro): **69 avisos,
0 erros**. Os 15 avisos novos são **todos `CS0649`** ("campo nunca atribuído") nas
classes de spec — a mesma família que as specs existentes já produzem, porque quem
os preenche é o Newtonsoft, por reflexão. Nenhum aviso novo de outra natureza.

O mesmo conjunto compilou também contra o arquivo **antes** da frente das portas
(`c0b4d00`: 59 avisos de base, 74 com o bloco). A única diferença entre as duas
versões é o `Layout layout` e a chamada de `TakeCodeNote` do `SpawnContainer`.

O rascunho foi apagado; o `Plugins/OrigemZDungeon.cs` **não foi tocado**.

### 8.7 O que NÃO foi medido, e por quê

- **nada foi jogado.** O `server01` está com a instalação incompleta (falta um
  bundle; o boot morre antes do RCON), e o agente de produção roda em outra
  máquina. O Oxide ainda compila os plugins nesse estado — daí o `pluginlint`
  valer —, mas ninguém abriu uma caixa;
- **`isLootable` de cada prefab**: o valor mora dentro do `content.bundle`, e não
  há como lê-lo daqui. O código **não depende** de eu saber: ele pergunta à peça em
  runtime. O §9 pede ao dono a confirmação que falta;
- **se o `Locker.ItemFilter` recusa mesmo um item comum**, e como ele fica na
  tela: o filtro existe (medido), o comportamento visual não.

---

## 9 — O que o dono deve olhar no jogo

Em ordem de "quanto custa se estiver errado".

**1. O barril quebra?** Ponha `loot_barrel_1` na lista de caixas de uma cor,
construa, e bata no barril. Ele **tem** de se partir e derramar o loot. Se ele
absorver as pancadas, o `isLootable` do prefab não é o que este documento supõe, e
a lista `breakable` (§4.2) precisa de outro critério. *É o único ponto do desenho
que depende de um campo que não consegui ler daqui.*

**2. O código da porta sobrevive à tabela?** Só vale depois que as duas frentes
estiverem no arquivo. Uma sala vermelha `locked`, e o `npc.loot` em
`mode: "replace"`. Mate o cientista: o corpo tem de trazer **o papel do código
E** os itens da tabela. Se o papel sumir, o `Wipe` não está preservando as notas —
e a sala fica lacrada para sempre, que é o pior desfecho das duas frentes juntas.

**3. O armário fica vazio?** Ponha `locker.deployed` numa cor **sem** tabela.
Ele vai nascer vazio — e isso é o Rust, não um bug. Depois ponha uma tabela com
`mode: "add"` e confira: roupa e arma entram bonito; scrap e madeira entram
tortos, no primeiro slot livre (§4.3). Se ficar feio, a decisão é do dono: ou o
painel avisa, ou o armário só aceita vestuário.

**4. O BetterLoot continua valendo?** Uma masmorra inteira em `mode: "server"` —
o padrão. As caixas têm de vir com o mesmo loot das caixas do mundo. Se vierem
diferentes, algo neste bloco está mexendo onde não devia.

**5. O respawn, e o relógio.** `respawn.enabled: true`, `minutes: 1`, uma masmorra
permanente. Esvazie tudo, espere dois minutos: caixa de radtown volta pelo
cronômetro do jogo, armário e caixa de madeira voltam pelo nosso, e o barril
quebrado **renasce**. O console diz `respawn: N recolocado(s), M reabastecido(s)`.

**6. A mochila some?** `item_drop_backpack` numa sala. Sem respawn, ela dura 60
minutos e some. Com respawn, ela volta. Se ela sumir em segundos, o
`ItemBasedDespawn` do prefab está ligado e ela some ao esvaziar — o que talvez
seja até melhor, mas o dono decide.

**7. Peso do comando.** Com tabelas grandes em muitas masmorras, o `sync` pode
passar de 50 KB e ser **recusado inteiro** (o cache antigo continua de pé, que é o
certo). O sintoma no painel é "salvei e o jogo não mudou". O §3.7 tem os números.

**8. O caso raro: o papel dentro de uma peça que o respawn repõe.** Com
`lock.carrier: "crate"` **e** `respawn.enabled`, o papel do código pode estar
dentro de um barril. Quebrado, o barril derrama o conteúdo no chão — e o papel
fica lá, que é o certo. Mas se o portador for uma **mochila** e ela expirar antes
de alguém chegar, o papel some com ela, e o `SettleLocks` já rodou lá atrás: a
sala fica trancada com um código que não existe mais em lugar nenhum. Não é
provável (o padrão é `carrier: "npc"`), e não tem conserto barato — o conserto
seria o respawn saber repor papel, o que faria `TakeCodeNote` deixar de ser
idempotente. **Se acontecer, a saída é `lock.onUndelivered` e o comando
`ozdungeon status`, que mostra os códigos ao admin.**

---

## 10 — O que ficou de fora, e por quê

| ideia | por que não agora |
|---|---|
| tabela **por prefab** (a caixa de elite cai coisa melhor que a comum, na mesma sala) | dobra a superfície de configuração para resolver um caso que a cor da sala já resolve. Se aparecer, o lugar é uma tabela nomeada e reusável, não mais um campo |
| tabelas **nomeadas e compartilhadas** entre masmorras | é a resposta certa para o peso do §3.7, e é uma tabela nova no banco + uma tela nova no painel. Vale a pena quando a segunda masmorra repetir a primeira |
| loot **por jogador** (cada um vê a sua caixa) | o Rust não tem isso de graça; é um plugin inteiro |
| a máquina do código da porta | é da frente `event-portas`, que a projetou melhor e primeiro (§5). Duas máquinas para a mesma coisa é a pior saída possível |
| `Locker` só aceitando vestuário na régua do painel | precisa da lista de categorias de item no painel, e ela não existe ainda |
| importar tabelas do `SimpleLootTable` | ele não está instalado; não há nada para importar |
| **loot do corpo do JOGADOR** que morre lá dentro | é regra de evento (o que se perde ao morrer), e mora na frente do ciclo de vida, não aqui |

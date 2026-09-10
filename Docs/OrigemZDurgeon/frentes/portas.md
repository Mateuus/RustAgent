# Frente PORTAS — abrir, trancar e resistir

**APLICADO em 09/09/2026, ainda sem commit.** Este documento nasceu
como proposta — enquanto duas outras frentes escreviam no mesmo
arquivo — e foi aplicado a `Plugins/OrigemZDungeon.cs` depois que a
frente de IA entrou (`c0b4d00`) e a de loot foi tirada do `.cs`.

O que está no arquivo hoje é **exatamente** o C# da seção (c): a
aplicação foi feita por um script que extrai os blocos ` ```csharp `
daqui e os cola nas âncoras. O plugin passou de 4.059 para 4.928
linhas, com **908 inserções e 39 remoções**, e compila com 0 erros.

A costura com a frente de loot (a nota do código dentro do NPC)
**entrou junto**: ela não dependia de código da outra frente — ver "A
fronteira com a frente `event-loot`", mais abaixo.

Nada foi copiado para `Servers/`, e nada foi commitado.

Quatro coisas entram:

| | o que muda | onde |
|---|---|---|
| **1** | a fechadura de código, o sorteio e a entrega por NPC | (c) C.4, C.5, C.7 |
| **2** | o nível de construção por **tipo de peça** e por **cor de sala** | (c) C.2, C.5, C.8 |
| **3** | a porta do painel chegando ao jogo — **dois defeitos achados** | (a) §3, (c) C.5 |
| **4** | porta dupla, grade, portão e vão aberto para a sala grande | (c) C.2, C.5 |

E um achado colateral, fora desta frente, no fim de (d): **a rotação
das plantas do CopyPaste está em radianos e o leitor a trata como
graus.**

---

## (a) Diagnóstico

### 1. O que a base 1.3.4 faz

`Docs/OrigemZDurgeon/DungeonBases-1.3.4.cs`, 3.883 linhas.

**As portas.** `DoorTypes` (linhas 37-41) são as três de construção —
madeira, metal, blindada. O gerador as sorteia **ao acaso**:

```csharp
// 3095 e 3130
var dp = DoorTypes[rngDoor.Next(DoorTypes.Length)];
```

E então a cor da sala é **derivada da porta que caiu** (`SetRoomColor`,
3794-3800): `toptier → red`, `metal → blue`, o resto `green`. Na base a
cor é consequência do sorteio; no nosso painel ela é a intenção do
admin, e a porta é que decorre dela. Os dois sentidos são opostos, e é
por isso que quase nada do fluxo de porta da 1.3.4 se aproveita.

Além dessas, a base pendura uma `door.hinged.industrial.d.prefab` no
lobby da entrada (2918-2921) e na antecâmara (3072) — uma porta de
fábrica **num `wall.doorway` comum**, o que confirma que ela é de um
metro como as outras três.

**A fechadura.** `PlaceDoorLockAndBranch` (3757-3792) põe um `CodeLock`
em **toda** porta, sempre, e sempre com o mesmo código:

```csharp
doorCodeLock.code = "0707";
doorCodeLock.SetFlagLocal(BaseEntity.Flags.Locked, true);
dr.SetSlot(BaseEntity.Slot.Lock, doorCodeLock);
```

Só que, na mesma função, ela também pendura um `ElectricalBranch` com
`branchAmount = 1234569`, e dois segundos depois esse ramo vira um
**leitor de cartão** (`ReplaceCardReader`, disparado em 1544-1549). Ou
seja: **na base 1.3.4 a porta trancada abre com CARTÃO, não com
código.** O `"0707"` ali é uma *marca de propriedade*, não um segredo
de jogo — tanto que o `BaseInit` (1520-1533) troca o `"0707"` do
alçapão de planta por `"18549"` justamente para que ele **nunca** seja
digitado, e troca um `"1818"` de planta por `"0"`.

`OnCodeEntered` (1922-1927) confirma: acertar o código só marca
`codeLock.skinID = 1`, e quem lê isso é o `CollisionListener`
(1897-1918) — para deixar **o NPC** atravessar a porta.

> **Conclusão que importa:** a base **não** tem código caindo de NPC. O
> §4/§6.2 do plano pede uma coisa que não existe em lugar nenhum para
> copiar. O que a base dá de aproveitável é a **receita mecânica** de
> pendurar um `CodeLock` numa `Door`, e essa receita é boa: osso do
> encaixe, pose zero, `Spawn`, e só então código, flag e `SetSlot`.

**O nível de construção.** `InitBlock(BuildingBlock b, BuildingGrade.Enum g)`
(3810-3822) recebe o grau como parâmetro — e as **seis** chamadas
passam `Stone` (2848, 3053, 3168, 3210, 3699, 3706). A base 1.3.4
também é inteira de pedra. Não há nada a copiar aqui: é a mesma dívida.

**As portas largas.** O gerador da base não ergue nenhuma. O
`doorNameList` (65-77) lista doze prefabs, incluindo as três duplas e
as três de quadro — mas ele alimenta o `InitDoorList` (747+), que
**reconhece** portas vindas de planta. Quem põe grade e portão são as
plantas herdadas, não o código.

### 2. O que o plugin faz hoje

`Plugins/OrigemZDungeon.cs` — 3.166 linhas quando comecei, 4.059 no
fim (outra frente escreveu no meio; ver o aviso no topo de (c)). Os
números abaixo são os das 01:40 de 09/09/2026.

| | onde | o que é |
|---|---|---|
| `DoorByColor` | 143-148 | três prefabs, um por cor |
| `DoorOf` | 1951-1969 | lê `spec.rooms`, traduz `wood\|metal\|toptier` → cor |
| `HangDoor` | 1971-2001 | cria a folha e pendura. **Sem fechadura** |
| `PrepareBlock` | 2866-2884 | aceita o grau — e ninguém varia o argumento |
| `locked` | 3098 | chega no `RoomSpec` e **nenhuma linha o lê** |

`BuildingGrade.Enum.Stone` aparece **seis vezes**: cinco cravadas no
construtor (1442 fundação, 1502 parede, 1547 teto, 2031 e 2048 na
entrada mínima) e uma como padrão do leitor de planta (2559) — essa
sexta é legítima, porque ali o grau vem do arquivo.

O único `CodeLock` do arquivo é o do leitor de planta (2624), que
copia o código gravado no JSON. O construtor não cria nenhum.

### 3. Os dois defeitos do caminho painel → jogo

Este era o item "conferir de ponta a ponta", e ele rendeu.

O caminho é: painel (`dungeon-dialog.tsx`) → `dungeonRoomInputSchema`
→ `dungeon_rooms` → `dungeons-repository` → `sync.ts#dungeonPayload`
→ `origemz.dungeon.sync` → `RoomSpec` → `DoorOf` → `HangDoor`. Os sete
primeiros passos carregam `door` e `locked` fielmente. **O oitavo os
perde de dois jeitos:**

**Defeito 1 — `DoorOf` casa pela chave errada.**

```csharp
// 1955-1957, hoje
foreach (var room in dungeon.spec.rooms)
    if (room != null && room.key == color && !string.IsNullOrEmpty(room.door))
```

Ele compara `room.key` com a **cor**. Isso funciona por coincidência: o
painel grava `key === color` nas três salas que oferece. Mas o contrato
**permite** outra coisa, em três lugares que dizem a mesma frase:

- `core/src/types/dungeons.ts`: `key: z.string().min(1).max(16)`, com o
  comentário *"'green'|'blue'|'red' no modo receita; 'A','B','C'… no
  modo planta"*;
- a migração 058 (`core/src/db/migrations.ts`), coluna `room_key`, o
  mesmo comentário;
- o §4.2 do plano, cujo exemplo de modo planta é literalmente
  `"rooms": { "A": {...}, "B": {...} }`.

Com uma chave assim — que a API aceita hoje, sem o painel —, o `DoorOf`
**não acha a sala** e devolve a cor: o admin escolhe porta blindada,
salva, constrói, e recebe madeira. Sem uma linha no log.

E três funções acima, `RoomSpecOf` (1728-1736) — que decide NPCs e
caixas da mesma sala — já casa por `room.color`. **Duas regras
diferentes para a mesma pergunta, no mesmo arquivo.** A correção é uma
só: `DoorOf` passa a usar `RoomSpecOf`.

**Defeito 2 — traduzir porta para cor é um beco.**

```csharp
if (room.door == "wood") return "green";   // 1963-1966
```

O `DoorOf` devolve uma **cor**, e o `HangDoor` reconverte cor → prefab.
Isso só fecha enquanto houver exatamente uma porta por cor. `cell_gate`
não tem cor nenhuma. Qualquer porta nova quebra o esquema — e é
exatamente o que o item 4 desta frente pede. Daqui para frente o que
viaja é o **tipo**, que é o vocabulário do painel.

**E um valor desconhecido some calado.** Se `room.door` vier com algo
que o plugin não conhece (um enum ampliado no painel e não no plugin, o
caso mais provável de todos), o `DoorOf` cai no `return color` final
sem avisar. Na proposta isso vira um `PrintWarning` com a lista dos
tipos aceitos.

---

## (b) Contrato de configuração

Tudo em inglês, tudo com padrão que reproduz o comportamento de hoje —
uma masmorra existente que não seja reeditada nasce idêntica.

### B.1 O nível de construção

Cinco valores, os mesmos do jogo:

```
twigs · wood · stone · metal · toptier
```

Aplicados a **três tipos de peça**, e em **dois níveis**:

| campo | onde vive | tipo | padrão | o que é |
|---|---|---|---|---|
| `structure.foundation` | masmorra | enum de grau | `stone` | o piso de toda célula sem dono de sala |
| `structure.wall` | masmorra | enum de grau | `stone` | parede, vão de porta e quadro |
| `structure.ceiling` | masmorra | enum de grau | `stone` | o teto |
| `rooms[].grade` | sala (cor) | objeto ou `null` | `null` | `null` = herda o `structure` |
| `rooms[].grade.foundation` | sala | enum de grau | `stone` | o piso daquele cômodo |
| `rooms[].grade.wall` | sala | enum de grau | `stone` | as paredes daquele cômodo |
| `rooms[].grade.ceiling` | sala | enum de grau | `stone` | o teto daquele cômodo |

**A parede tem dois donos, e vence o mais forte.** Ela fica entre duas
células; se elas discordarem, prevalece o grau mais alto. Uma sala
blindada encostada numa de madeira não pode ganhar parede de madeira —
o invasor entraria pelo lado barato e a escolha do admin viraria
decoração. É `WallGradeOf`, em C.5.

**O vão de porta e o quadro seguem a parede**, porque é a parede que
eles substituem.

**O que a planta traz continua vindo da planta.** `PasteOne` (2559) lê
o `grade` de cada peça do JSON, e isso não muda: uma planta é o desenho
de outra pessoa, com os materiais dela.

### B.2 A porta

O enum `ROOM_DOORS` cresce de 3 para 11:

| valor | folha | bloco | passagem |
|---|---|---|---|
| `wood` | porta de madeira | `wall.doorway` | 1 m |
| `metal` | porta de metal | `wall.doorway` | 1 m |
| `toptier` | porta blindada | `wall.doorway` | 1 m |
| `industrial` | porta de fábrica | `wall.doorway` | 1 m |
| `double_wood` | porta dupla de madeira | `wall.frame` | 2 m |
| `double_metal` | porta dupla de metal | `wall.frame` | 2 m |
| `double_toptier` | porta dupla blindada | `wall.frame` | 2 m |
| `cell_gate` | grade de cela | `wall.frame` | 2 m |
| `fence_gate` | portão de tela | `wall.frame` | 2 m |
| `garage` | portão de garagem | `wall.frame` | 2 m |
| `none` | — | `wall.doorway` | vão aberto |

Mais dois campos por sala:

| campo | tipo | faixa | padrão | o que é |
|---|---|---|---|---|
| `door` | `ROOM_DOORS` | — | `wood` | a porta normal daquela cor |
| `wideDoor` | `ROOM_DOORS` ou `null` | — | `null` | a porta da sala grande. `null` = usa `door` sempre |
| `wideDoorCellsPerDoor` | inteiro | 1-64 | 4 | a partir de quantas **células por porta** o `wideDoor` entra |

**Por que células POR PORTA, e não células.** Um salão de nove células
com quatro entradas não afunila ninguém — quatro grupos entram por
quatro lados. O funil é nove células com **uma** entrada. A conta é
`células ÷ portas`, e com o padrão 4 uma sala de 3×3 com uma porta
recebe a folha larga, enquanto a mesma sala com três portas fica com a
normal.

### B.3 A fechadura

`locked` continua sendo o booleano por sala. O que ele significa passa
a viver num bloco `lock`, da masmorra inteira:

| campo | tipo | valores | padrão | o que é |
|---|---|---|---|---|
| `lock.enabled` | booleano | — | `true` | desliga o sistema inteiro sem reeditar as salas |
| `lock.sharedCode` | booleano | — | `false` | um código para a masmorra inteira, em vez de um por sala |
| `lock.carrier` | enum | `npc` · `crate` · `none` | `npc` | de onde o código sai |
| `lock.carrierScope` | enum | `corridor` · `anywhere` | `corridor` | onde o portador pode estar |
| `lock.onUndelivered` | enum | `unlock` · `keep` | `unlock` | o que fazer com o código que não achou portador |
| `lock.noteTitle` | texto | ≤ 40 | `Código da porta` | o nome do papel no inventário |
| `lock.announceOpen` | booleano | — | `true` | avisar quem está dentro quando uma porta abre |
| `lock.warnOnWrongCode` | booleano | — | `true` | dizer a quem errou que errou |

**Quatro dígitos, e isso não é configurável.** O `CodeLock.code` do
servidor é uma string livre — a 1.3.4 põe `"18549"` e `"0"` nela. Mas o
teclado do **cliente** tem quatro casas: um código de cinco dígitos não
pode ser digitado, e a sala fica lacrada sem nada na tela explicando
por quê. Não há faixa útil do outro lado desse número, só masmorra
quebrada — por isso o sorteio é de quatro, sempre, com zeros à
esquerda, e `"0707"` fica de fora (é a marca de alçapão das plantas
herdadas — ver `IsEntranceHatchMarker`).

**Um código por SALA, não por porta.** Um cômodo com três entradas tem
um código só. O contrário faria o jogador achar o papel da porta norte
e continuar trancado do lado sul, sem nada na tela dizendo por que
aquele número não serve.

**O portador nunca está dentro da sala que ele abre.** Isso não é
campo, é invariante do código: o código da sala vermelha guardado
dentro da sala vermelha é uma porta que só abre para quem já entrou.

**O que sobrou sem portador é destrancado, e o log grita.** A porta
nasce trancada antes de o conteúdo existir; o portador só aparece no
`Populate`. Se a receita não tiver NPC de corredor — ou se
`carrier: "none"` —, a sala ficaria lacrada para sempre, a masmorra
subiria, a contagem de peças fecharia, e ninguém descobriria até um
jogador desistir de procurar. `onUndelivered: "keep"` existe para quem
quer mesmo a sala fechada (um evento em que o admin abre).

### B.4 O que muda em `core/src/types/dungeons.ts`

```ts
// §1  VOCABULÁRIO — o enum cresce, e ganha um vizinho

/** A porta que a sala tem. É o que a cor significa no jogo. */
export const ROOM_DOORS = [
  // um metro de passagem, penduradas num `wall.doorway`
  'wood', 'metal', 'toptier', 'industrial',
  // dois metros, penduradas num `wall.frame`
  'double_wood', 'double_metal', 'double_toptier',
  'cell_gate', 'fence_gate', 'garage',
  // sem folha nenhuma
  'none',
] as const;
export type RoomDoor = (typeof ROOM_DOORS)[number];

/** O nível de construção de uma peça. São os cinco do jogo. */
export const BUILD_GRADES = ['twigs', 'wood', 'stone', 'metal', 'toptier'] as const;
export type BuildGrade = (typeof BUILD_GRADES)[number];

/**
 * O nível de cada tipo de peça.
 *
 * `stone` em tudo é o que o construtor cravava até aqui — então uma
 * masmorra que ninguém reeditar nasce exatamente igual.
 */
const gradeSetSchema = z.object({
  foundation: z.enum(BUILD_GRADES).default('stone'),
  wall: z.enum(BUILD_GRADES).default('stone'),
  ceiling: z.enum(BUILD_GRADES).default('stone'),
});

// §2  A RÉGUA — a sala ganha três campos

export const dungeonRoomInputSchema = z.object({
  key: z.string().min(1).max(16),
  color: z.enum(ROOM_COLORS).default('green'),
  npc: countRange('NPCs', 20).default({ min: 0, max: 1 }),
  loot: countRange('caixas', 20).default({ min: 1, max: 1 }),
  crates: z.array(cratePrefabSchema).max(20).default([]),
  door: z.enum(ROOM_DOORS).default('wood'),
  locked: z.boolean().default(false),

  /** A porta da sala grande. `null` = usa `door` sempre. */
  wideDoor: z.enum(ROOM_DOORS).nullable().default(null),
  /** Células POR PORTA a partir das quais `wideDoor` entra. */
  wideDoorCellsPerDoor: z.number().int().min(1).max(64).default(4),
  /** O nível das peças desta cor. `null` = herda de `structure`. */
  grade: gradeSetSchema.nullable().default(null),
});

// …e o corpo da masmorra ganha dois blocos

    /** O nível padrão: corredor, entrada e tudo que não é sala. */
    structure: gradeSetSchema.prefault({}),

    /** Como a masmorra tranca, e como o código chega ao jogador. */
    lock: z
      .object({
        enabled: z.boolean().default(true),
        sharedCode: z.boolean().default(false),
        carrier: z.enum(['npc', 'crate', 'none']).default('npc'),
        carrierScope: z.enum(['corridor', 'anywhere']).default('corridor'),
        onUndelivered: z.enum(['unlock', 'keep']).default('unlock'),
        noteTitle: z.string().max(40).default('Código da porta'),
        announceOpen: z.boolean().default(true),
        warnOnWrongCode: z.boolean().default(true),
      })
      .prefault({}),
```

**Uma régua nova, no `superRefine` do corpo.** Ela existe porque o
sintoma do erro é mudo:

```ts
    // Sala trancada sem quem entregue o código é uma sala que ninguém
    // abre. O plugin destranca e grita no log — mas o admin não lê o
    // log do servidor, e lê esta frase enquanto ainda pode consertar.
    const anyLocked = value.rooms.some((room) => room.locked);

    if (anyLocked && value.lock.enabled && value.lock.carrier === 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['lock', 'carrier'],
        message:
          'há sala trancada e ninguém para carregar o código: escolha NPC ou caixa, ou destranque as salas',
      });
    }

    if (anyLocked && value.lock.enabled
        && value.lock.carrier === 'npc'
        && value.lock.carrierScope === 'corridor'
        && value.corridor.npcDensity === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['corridor', 'npcDensity'],
        message:
          'o código sai de um NPC de corredor e o corredor não tem nenhum: suba a densidade ou use "em qualquer lugar"',
      });
    }
```

**O `FACTORY_RECIPES` não precisa mudar** — todos os campos novos têm
padrão. As quatro receitas de fábrica continuam nascendo iguais, agora
com pedra explícita em vez de pedra implícita.

### B.5 O que muda no banco — migração 062

Duas partes. A segunda é chata porque o SQLite não altera um `CHECK`.

```sql
-- ============================================================
--  062  o nível de construção e a fechadura saem do código.
--
--  ####  A COLUNA door TEM UM CHECK, E ELE ENVELHECEU  ####
--
--  A 058 escreveu CHECK (door IN ('wood','metal','toptier')). O
--  SQLite não altera restrição: a tabela é recriada, copiada e
--  trocada. É a única maneira, e por isso ela vem primeiro —
--  se algo falhar aqui, nada mais foi escrito.
-- ============================================================

PRAGMA foreign_keys = OFF;

CREATE TABLE dungeon_rooms_new (
  dungeon_id TEXT NOT NULL REFERENCES dungeons(id) ON DELETE CASCADE,
  room_key TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'green' CHECK (color IN ('green','blue','red')),
  npc_min  INTEGER NOT NULL DEFAULT 0,
  npc_max  INTEGER NOT NULL DEFAULT 1,
  loot_min INTEGER NOT NULL DEFAULT 1,
  loot_max INTEGER NOT NULL DEFAULT 1,
  crates TEXT NOT NULL DEFAULT '[]',

  -- Onze valores. Os quatro primeiros são de um metro e moram num
  -- wall.doorway; os seis seguintes são de dois e moram num
  -- wall.frame; 'none' é o vão aberto de propósito.
  door TEXT NOT NULL DEFAULT 'wood' CHECK (door IN (
    'wood','metal','toptier','industrial',
    'double_wood','double_metal','double_toptier',
    'cell_gate','fence_gate','garage','none')),

  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),

  -- NULL = a sala grande usa a mesma porta das outras.
  wide_door TEXT CHECK (wide_door IS NULL OR wide_door IN (
    'wood','metal','toptier','industrial',
    'double_wood','double_metal','double_toptier',
    'cell_gate','fence_gate','garage','none')),
  wide_door_cells_per_door INTEGER NOT NULL DEFAULT 4,

  -- NULL nos três = herda o structure_* da masmorra.
  grade_foundation TEXT CHECK (grade_foundation IS NULL OR grade_foundation IN ('twigs','wood','stone','metal','toptier')),
  grade_wall       TEXT CHECK (grade_wall       IS NULL OR grade_wall       IN ('twigs','wood','stone','metal','toptier')),
  grade_ceiling    TEXT CHECK (grade_ceiling    IS NULL OR grade_ceiling    IN ('twigs','wood','stone','metal','toptier')),

  PRIMARY KEY (dungeon_id, room_key)
);

INSERT INTO dungeon_rooms_new
  (dungeon_id, room_key, color, npc_min, npc_max, loot_min, loot_max, crates, door, locked)
SELECT dungeon_id, room_key, color, npc_min, npc_max, loot_min, loot_max, crates, door, locked
FROM dungeon_rooms;

DROP TABLE dungeon_rooms;
ALTER TABLE dungeon_rooms_new RENAME TO dungeon_rooms;

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
--  E o resto é ALTER TABLE, que o SQLite faz.
--
--  Todo padrão aqui reproduz o que o construtor cravava: 'stone'
--  em tudo, fechadura ligada com o código saindo de um NPC de
--  corredor. Masmorra existente nasce igual.
-- ------------------------------------------------------------
ALTER TABLE dungeons ADD COLUMN structure_foundation TEXT NOT NULL DEFAULT 'stone';
ALTER TABLE dungeons ADD COLUMN structure_wall       TEXT NOT NULL DEFAULT 'stone';
ALTER TABLE dungeons ADD COLUMN structure_ceiling    TEXT NOT NULL DEFAULT 'stone';

ALTER TABLE dungeons ADD COLUMN lock_enabled          INTEGER NOT NULL DEFAULT 1;
ALTER TABLE dungeons ADD COLUMN lock_shared_code      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dungeons ADD COLUMN lock_carrier          TEXT NOT NULL DEFAULT 'npc';
ALTER TABLE dungeons ADD COLUMN lock_carrier_scope    TEXT NOT NULL DEFAULT 'corridor';
ALTER TABLE dungeons ADD COLUMN lock_on_undelivered   TEXT NOT NULL DEFAULT 'unlock';
ALTER TABLE dungeons ADD COLUMN lock_note_title       TEXT;
ALTER TABLE dungeons ADD COLUMN lock_announce_open    INTEGER NOT NULL DEFAULT 1;
ALTER TABLE dungeons ADD COLUMN lock_warn_wrong_code  INTEGER NOT NULL DEFAULT 1;
```

### B.6 O que muda no `sync.ts`

`#dungeonPayload` (em `core/src/dungeons/sync.ts`) copia campo a campo
— então os novos precisam entrar lá, ou eles chegam ao banco e param
antes do jogo, que é exatamente o que aconteceu com `locked`:

```ts
      grid: dungeon.grid,
      npc: dungeon.npc,
      timeOfDay: dungeon.timeOfDay,
      structure: dungeon.structure,
      lock: dungeon.lock,
      rooms: dungeon.rooms.map((room) => ({
        key: room.key,
        color: room.color,
        npc: room.npc,
        loot: room.loot,
        crates: room.crates,
        door: room.door,
        locked: room.locked,
        wideDoor: room.wideDoor,
        wideDoorCellsPerDoor: room.wideDoorCellsPerDoor,
        grade: room.grade,
      })),
```

**O teto do RCON.** O `push` já recusa payload acima de
`DUNGEON_SYNC_MAX_BYTES` e mantém o cache anterior de pé. Os campos
novos somam ~180 bytes por masmorra com todos preenchidos (~90 no caso
comum, com `grade: null` e `wideDoor: null`) — cabe, mas é mais um
motivo para o painel não criar cem masmorras.

### B.7 O que muda no painel

Não é meu trabalho, mas o contrato exige três coisas de lá:

1. **O aviso de porta que não bate com a cor** (`dungeon-dialog.tsx`,
   linha 852) compara `room.door !== DOOR_OF_COLOR[room.color]`. Com
   onze portas, ele passaria a gritar em quase toda escolha. A regra
   nova: avisar só quando a porta escolhida é de **material** diferente
   do da cor — `cell_gate` numa sala vermelha não é um erro, é um
   desenho;
2. **`wideDoor` precisa da prévia**: "esta sala tem 9 células e 1
   porta; com o limite em 4, ela nasce com porta dupla";
3. **O `structure` é da masmorra**, então ele pertence ao passo ②
   ("Como nasce"), não ao ③ ("Salas e loot").

---

## (c) O C# — pronto para colar

Nada aqui toca o bloco das paredes: a condição `mine == theirs` — a
que impede o corredor de virar cubículos lacrados de 3×3 — sai deste
trabalho byte a byte igual ao que entrou.

> ####  O NÚMERO DE LINHA APODRECE EM MINUTOS  ####
>
> Três frentes escrevem em `Plugins/OrigemZDungeon.cs` ao mesmo tempo.
> **Durante este trabalho** o arquivo passou de 3.166 para 4.059
> linhas: a frente de IA acrescentou um campo `ai` ao `RoomSpec` e um
> parâmetro `color` ao `SpawnNpc` enquanto eu escrevia.
>
> Então **a referência de cada bloco é a âncora de texto**, e o número
> de linha (conferido às 01:40 de 09/09/2026) é só auxílio. E, onde
> outra frente já mexeu, o bloco diz **acrescente**, nunca
> *substitua* — colar um `RoomSpec` inteiro por cima apagaria o `ai`
> de quem chegou antes.

> ####  E ELE FOI COMPILADO A PARTIR DESTE DOCUMENTO  ####
>
> Não de um rascunho paralelo que pudesse ter divergido: um script
> extraiu **os blocos ` ```csharp ` desta seção**, aplicou-os ao
> `Plugins/OrigemZDungeon.cs` como ele estava às 01:40 — já com o
> `ai` e o `color` da frente de IA dentro —, e o resultado foi ao
> `pluginlint`:
>
> ```
> dotnet build core/scripts/pluginlint/pluginlint.csproj \
>   -p:PluginFile="<plugin atual + os blocos abaixo>" -v q --nologo
>
>     0 Erro(s)
> ```
>
> Ou seja: se um bloco daqui estivesse errado, incompleto ou com uma
> chave a mais, isto teria quebrado. O rascunho foi apagado.

### C.1 Duas constantes de prefab

Âncora: `private const string PrefabCeilingLight` (linha 96) — entram
logo depois dela.

```csharp
        /// <summary>
        /// O quadro de parede: o bloco das portas largas.
        ///
        /// É um `BuildingBlock` como a parede e o vão, entra na MESMA
        /// pose deles (a 1.3.4 já faz isso com o `wall.window`, na
        /// mesma `Lp()` das paredes) e tem dois metros de passagem.
        /// </summary>
        private const string PrefabWallFrame = "assets/prefabs/building core/wall.frame/wall.frame.prefab";

        /// <summary>
        /// A fechadura de código. É a mesma da 1.3.4 (`CodeLock`).
        /// </summary>
        private const string PrefabCodeLock = "assets/prefabs/locks/keypad/lock.code.prefab";
```

### C.2 O catálogo de portas, a tabela de graus e o enum de peça

Âncora: `private static readonly Dictionary<string, string> DoorByColor`
(linha 143). **Substitui** o comentário `///` logo acima dela e o
dicionário inteiro, até o `};`. O dicionário continua com o mesmo
nome, mas agora mapeia cor → *tipo de porta*, e não cor → prefab: o
que viaja do painel é o tipo.

```csharp
        /// <summary>
        /// A porta de cada cor.
        ///
        /// ####  PORTAS DE CONSTRUÇÃO, E NÃO AS DE MONUMENTO  ####
        ///
        /// Elas eram as `door.hinged.security.{green,blue,red}` — as
        /// coloridas dos monumentos, que combinavam com as cores das
        /// salas e eram lindas.
        ///
        /// E não abriam. MEDIDO em 09/09/2026, pelo dono, de dentro da
        /// masmorra: o jogo só oferecia "TOC... TOC...". Aquelas portas
        /// são acionadas por CARTÃO E ENERGIA — um leitor de cartão, um
        /// botão, um fio. A masmorra não tem elétrica nenhuma, então
        /// nenhuma delas abriria jamais: a masmorra inteira era um
        /// corredor com salas lacradas.
        ///
        /// Estas três abrem com a mão, e são exatamente o que o painel
        /// promete ao admin em cada cor: madeira na verde, metal na
        /// azul, blindada na vermelha. A cor deixa de estar na porta e
        /// passa a estar no MATERIAL dela — que é o que o jogador de
        /// Rust já lê sem pensar.
        /// </summary>
        private static readonly Dictionary<string, string> DoorByColor = new Dictionary<string, string>
        {
            ["green"] = "wood",
            ["blue"] = "metal",
            ["red"] = "toptier",
        };

        /// <summary>
        /// Uma porta: o bloco que a segura e a folha que fica nele.
        ///
        /// ####  A FOLHA LARGA NÃO CABE NUM `wall.doorway`  ####
        ///
        /// O vão de porta do Rust tem UM metro; porta dupla, grade de
        /// cela, portão de tela e porta de garagem têm DOIS, e o bloco
        /// delas é o `wall.frame` — o quadro de parede.
        ///
        /// MEDIDO em 09/09/2026 nas sete plantas herdadas: as seis
        /// grades que existem nelas (`base3`, `entrance1`, `entrance4`)
        /// estão TODAS na posição exata de um `wall.frame`, com a mesma
        /// rotação ou 180 graus dela — o lado para onde a folha abre.
        /// A pose local é zero, igual à da porta no vão.
        /// </summary>
        private sealed class DoorKind
        {
            /// <summary>O BuildingBlock que entra no lugar da parede.</summary>
            public string frame;
            /// <summary>A folha pendurada nele. `null` = passagem vazia.</summary>
            public string leaf;
            /// <summary>Cabe mais de um jogador de cada vez?</summary>
            public bool wide;
            /// <summary>O que o admin vê quando a porta não pode trancar.</summary>
            public string label;
        }

        /// <summary>
        /// As portas que o painel oferece.
        ///
        /// ####  TODO CAMINHO AQUI FOI CONFERIDO CONTRA O JOGO  ####
        ///
        /// Não contra a memória: os onze prefabs abaixo foram casados,
        /// em 09/09/2026, com o `Bundles/AssetSceneManifest.json` do
        /// Rust instalado em `Servers/server01` — 16.358 assets, e os
        /// onze estão lá. Um caminho errado devolve `null` no
        /// `CreateEntity`, o `return` engole, e a masmorra sobe com o
        /// vão aberto: foi assim que a versão anterior desta tabela
        /// (`door.hinged.wood/...`) chegou ao jogo, e quem descobriu
        /// foi o dono, lá dentro.
        /// </summary>
        private static readonly Dictionary<string, DoorKind> DoorCatalog = new Dictionary<string, DoorKind>
        {
            // ####  AS TRÊS DE CONSTRUÇÃO ABREM COM A MÃO  ####
            //
            // Elas eram as `door.hinged.security.{green,blue,red}` — as
            // coloridas dos monumentos, que combinavam com as cores das
            // salas e eram lindas.
            //
            // E não abriam. MEDIDO em 09/09/2026, pelo dono, de dentro
            // da masmorra: o jogo só oferecia "TOC... TOC...". Aquelas
            // portas são acionadas por CARTÃO E ENERGIA, e a masmorra
            // não tem elétrica nenhuma — a masmorra inteira era um
            // corredor com salas lacradas.
            //
            // A cor deixou de estar na porta e passou a estar no
            // MATERIAL dela, que é o que o jogador de Rust já lê sem
            // pensar.
            ["wood"] = new DoorKind
            {
                frame = PrefabDoorway,
                leaf = "assets/prefabs/building/door.hinged/door.hinged.wood.prefab",
                label = "porta de madeira",
            },
            ["metal"] = new DoorKind
            {
                frame = PrefabDoorway,
                leaf = "assets/prefabs/building/door.hinged/door.hinged.metal.prefab",
                label = "porta de metal",
            },
            ["toptier"] = new DoorKind
            {
                frame = PrefabDoorway,
                leaf = "assets/prefabs/building/door.hinged/door.hinged.toptier.prefab",
                label = "porta blindada",
            },

            // A de fábrica: um metro, como as três, e é a que a 1.3.4
            // usa no lobby da entrada dela.
            ["industrial"] = new DoorKind
            {
                frame = PrefabDoorway,
                leaf = "assets/prefabs/misc/permstore/factorydoor/door.hinged.industrial.d.prefab",
                label = "porta de fábrica",
            },

            // ####  AS LARGAS, PARA A SALA QUE VIROU FUNIL  ####
            //
            // Nove células com uma porta de um metro são uma fila
            // indiana debaixo de fogo. Estas cinco têm dois metros de
            // passagem, e todas moram no `wall.frame`.
            ["double_wood"] = new DoorKind
            {
                frame = PrefabWallFrame,
                leaf = "assets/prefabs/building/door.double.hinged/door.double.hinged.wood.prefab",
                wide = true,
                label = "porta dupla de madeira",
            },
            ["double_metal"] = new DoorKind
            {
                frame = PrefabWallFrame,
                leaf = "assets/prefabs/building/door.double.hinged/door.double.hinged.metal.prefab",
                wide = true,
                label = "porta dupla de metal",
            },
            ["double_toptier"] = new DoorKind
            {
                frame = PrefabWallFrame,
                leaf = "assets/prefabs/building/door.double.hinged/door.double.hinged.toptier.prefab",
                wide = true,
                label = "porta dupla blindada",
            },
            // A grade de cela deixa VER o que tem dentro sem deixar
            // entrar — e uma sala vermelha vista de fora é um convite.
            ["cell_gate"] = new DoorKind
            {
                frame = PrefabWallFrame,
                leaf = "assets/prefabs/building/wall.frame.cell/wall.frame.cell.gate.prefab",
                wide = true,
                label = "grade de cela",
            },
            ["fence_gate"] = new DoorKind
            {
                frame = PrefabWallFrame,
                leaf = "assets/prefabs/building/wall.frame.fence/wall.frame.fence.gate.prefab",
                wide = true,
                label = "portão de tela",
            },
            ["garage"] = new DoorKind
            {
                frame = PrefabWallFrame,
                leaf = "assets/prefabs/building/wall.frame.garagedoor/wall.frame.garagedoor.prefab",
                wide = true,
                label = "portão de garagem",
            },

            // Sem folha: o vão fica aberto de propósito. Serve para a
            // sala verde de uma masmorra que quer ser corrida, e para
            // depurar "a porta não abre" separando os dois casos.
            ["none"] = new DoorKind
            {
                frame = PrefabDoorway,
                leaf = null,
                label = "vão aberto",
            },
        };

        /// <summary>
        /// Os graus, do nome que o painel manda ao enum do jogo.
        ///
        /// MEDIDO por reflexão sobre o `Assembly-CSharp.dll` do
        /// `Servers/server01` em 09/09/2026: `None = -1`, `Twigs = 0`,
        /// `Wood = 1`, `Stone = 2`, `Metal = 3`, `TopTier = 4`. O
        /// `None` fica de fora de propósito — um bloco sem grau não
        /// tem malha, e a masmorra nasceria invisível.
        /// </summary>
        private static readonly Dictionary<string, BuildingGrade.Enum> GradeByName =
            new Dictionary<string, BuildingGrade.Enum>
            {
                ["twigs"] = BuildingGrade.Enum.Twigs,
                ["wood"] = BuildingGrade.Enum.Wood,
                ["stone"] = BuildingGrade.Enum.Stone,
                ["metal"] = BuildingGrade.Enum.Metal,
                ["toptier"] = BuildingGrade.Enum.TopTier,
            };

        /// <summary>O grau de quem não escolheu nenhum. Era o único.</summary>
        private const BuildingGrade.Enum DefaultGrade = BuildingGrade.Enum.Stone;

        /// <summary>As três peças que ganham grau próprio.</summary>
        private enum Piece { Foundation, Wall, Ceiling }
```

### C.3 O estado: as fechaduras da masmorra viva

Dentro de `ActiveDungeon`, logo depois de `roomColors` (linha 273).

```csharp
            // ####  AS FECHADURAS, POR SALA  ####
            //
            // O código é sorteado quando a PORTA nasce e o portador só
            // é escolhido quando o CONTEÚDO nasce — duas fases, e entre
            // elas a masmorra tem sala trancada sem ninguém que a abra.
            // É por isso que existe o `SettleLocks`: no fim de tudo,
            // fechadura sem portador vira porta destrancada, com grito
            // no log. Uma sala que ninguém abre é um pedaço de masmorra
            // que o jogador vê e não usa — e ele nunca saberia por que.
            /// <summary>A fechadura de cada sala trancada, por id de sala.</summary>
            public readonly Dictionary<int, RoomLock> locks = new Dictionary<int, RoomLock>();
            /// <summary>Os códigos já sorteados, para não repetir.</summary>
            public readonly HashSet<string> usedCodes = new HashSet<string>();
            /// <summary>O código único, quando a receita pede um só.</summary>
            public string sharedCode;
```

### C.4 A classe `RoomLock`

Depois de `HatchLink` (linhas 286-291).

```csharp

        /// <summary>
        /// A tranca de uma sala: o código, as portas dela e quem o leva.
        ///
        /// É por SALA, e não por porta: um cômodo com três entradas tem
        /// UM código. Um código por folha faria o jogador achar o papel
        /// da porta norte e continuar trancado do lado sul, sem nada na
        /// tela explicando por que aquele número não serve.
        /// </summary>
        private sealed class RoomLock
        {
            public int roomId;
            public string color;
            public string code;
            /// <summary>As folhas daquela sala. Todas com a mesma fechadura.</summary>
            public readonly List<CodeLock> locks = new List<CodeLock>();
            /// <summary>As células do cômodo. O portador nunca está numa delas.</summary>
            public readonly HashSet<(int, int)> cells = new HashSet<(int, int)>();
            /// <summary>Já existe alguém no mundo carregando este código?</summary>
            public bool delivered;
        }
```

### C.5 O miolo: porta, fechadura, código e grau

Âncoras: `private string DoorOf(ActiveDungeon dungeon, string color)`
(linha 1951) e `private void HangDoor(ActiveDungeon dungeon,
BuildingBlock frame, string color)` (linha 1971). **Substitui as duas
funções inteiras**, do `/// <summary>A porta daquela cor…` até o `}` que
fecha o `HangDoor` (linha 2001), e acrescenta o resto. É o bloco
grande, e ele é autocontido.

```csharp
        // ============================================================
        //  A PORTA QUE O PAINEL ESCOLHEU
        //
        //  ####  DOIS DEFEITOS QUE SÓ APARECEM DEPOIS  ####
        //
        //  O `DoorOf` antigo devolvia uma COR e casava `room.key` com
        //  ela. Isso funcionava por coincidência: o painel grava
        //  `key == color` nas três salas, e havia exatamente três
        //  portas para três cores. Duas coisas quebravam:
        //
        //    1. o contrato PERMITE `key = "A"` — o `dungeons.ts` diz
        //       `key: z.string().min(1).max(16)` e o `dungeon_rooms`
        //       do plano diz "'A','B','C'... no modo planta". Com uma
        //       chave dessas, o `DoorOf` NÃO ACHA a sala e devolve a
        //       cor: o admin escolhe porta blindada, salva, constroi,
        //       e recebe madeira sem uma linha no log. O `RoomSpecOf`,
        //       três funções acima, já casava por `room.color` — duas
        //       regras diferentes para a mesma pergunta, no mesmo
        //       arquivo;
        //
        //    2. traduzir para cor só funciona enquanto houver uma
        //       porta por cor. `cell_gate` não tem cor nenhuma.
        //
        //  Agora há UMA regra (`RoomSpecOf`, por cor) e o que viaja é
        //  o TIPO da porta, que é o vocabulário do painel.
        // ============================================================

        /// <summary>Quantas células por porta antes de o cômodo virar funil.</summary>
        private const int DefaultWideDoorCellsPerDoor = 4;

        /// <summary>O tipo de porta que o painel pediu para aquela cor.</summary>
        private string DoorTypeOf(ActiveDungeon dungeon, string color, int cells, int doors)
        {
            string fallback;
            if (!DoorByColor.TryGetValue(color, out fallback)) fallback = DoorByColor["green"];

            var room = RoomSpecOf(dungeon, color);
            if (room == null) return fallback;

            var wanted = string.IsNullOrEmpty(room.door) ? fallback : room.door;

            // ####  A SALA GRANDE COM UMA PORTA E UM FUNIL  ####
            //
            // Nove células e uma folha de um metro põem três jogadores
            // em fila indiana debaixo de fogo, e o cômodo que devia ser
            // o prêmio vira o lugar onde eles morrem um por vez. A
            // conta é CÉLULAS POR PORTA, e não células: um salão com
            // quatro entradas já não afunila ninguém.
            if (!string.IsNullOrEmpty(room.wideDoor))
            {
                var perDoor = cells / Mathf.Max(1, doors);
                var threshold = room.wideDoorCellsPerDoor > 0
                    ? room.wideDoorCellsPerDoor
                    : DefaultWideDoorCellsPerDoor;

                if (perDoor >= threshold) wanted = room.wideDoor;
            }

            return wanted;
        }

        /// <summary>O tipo, já resolvido em bloco e folha.</summary>
        private DoorKind DoorKindOf(ActiveDungeon dungeon, string color, int cells, int doors)
        {
            var wanted = DoorTypeOf(dungeon, color, cells, doors);

            DoorKind kind;
            if (DoorCatalog.TryGetValue(wanted, out kind)) return kind;

            // Um tipo que este plugin não conhece GRITA e cai na porta
            // da cor. Silenciar aqui é como o `DoorOf` antigo fazia — e
            // é assim que o admin passa uma semana achando que o painel
            // não salva.
            PrintWarning("porta desconhecida '" + wanted + "' na sala " + color
                         + ": usando a porta padrão da cor. Tipos: "
                         + string.Join(", ", DoorCatalog.Keys.ToArray()));

            string fallback;
            if (!DoorByColor.TryGetValue(color, out fallback)) fallback = DoorByColor["green"];

            return DoorCatalog[fallback];
        }

        private void HangDoor(
            ActiveDungeon dungeon,
            BuildingBlock frame,
            DoorKind kind,
            Layout layout,
            (int, int) roomCell,
            string color,
            System.Random rng)
        {
            // Vão aberto é uma escolha do admin (`door: "none"`), e não
            // um erro: sem folha não há o que pendurar.
            if (kind == null || string.IsNullOrEmpty(kind.leaf)) return;

            var door = GameManager.server.CreateEntity(kind.leaf, frame.transform.position);

            if (door == null)
            {
                // ####  O VÃO SEM PORTA E MUDO  ####
                //
                // MEDIDO em 09/09/2026: eu troquei os prefabs e escrevi
                // o caminho de cabeça — `door.hinged.wood/...` em vez de
                // `door.hinged/...`. O `CreateEntity` devolveu null, o
                // `return` engoliu, e a masmorra subiu inteira com os
                // vãos abertos. Quem viu foi o dono, lá dentro.
                //
                // Um prefab que não existe agora GRITA no log, com o
                // caminho — que é a única informação que resolve.
                PrintWarning("porta não criada: o prefab '" + kind.leaf + "' não existe");
                return;
            }

            door.SetParent(frame);
            door.transform.localPosition = Vector3.zero;
            door.transform.localRotation = Quaternion.identity;
            door.OwnerID = 0UL;
            door.EnableSaving(false);
            door.Spawn();
            Adopt(dungeon, door);

            if (IsLocked(dungeon, color)) LockDoor(dungeon, door, kind, layout, roomCell, color, rng);
        }

        // ============================================================
        //  A FECHADURA E O CÓDIGO
        //
        //  ####  CINCO DÍGITOS TRANCAM PARA SEMPRE  ####
        //
        //  O `CodeLock.code` do servidor é uma STRING livre: a 1.3.4
        //  põe "18549" no alçapão dela justamente para que ninguém o
        //  abra, e "0" numa fechadura de planta. Mas o teclado do
        //  CLIENTE tem quatro casas — um código de cinco dígitos não
        //  pode ser digitado, e a sala fica lacrada sem nada na tela
        //  dizendo por que.
        //
        //  Então o sorteio é de QUATRO, sempre, com zeros à esquerda.
        //  Isso não é configurável de propósito: não há faixa útil do
        //  outro lado, só uma masmorra quebrada.
        // ============================================================

        /// <summary>A config de fechadura de quem não mandou nenhuma.</summary>
        private static readonly LockSpec DefaultLockSpec = new LockSpec();

        private LockSpec LockConfigOf(ActiveDungeon dungeon) =>
            dungeon.spec == null || dungeon.spec.doorLock == null
                ? DefaultLockSpec
                : dungeon.spec.doorLock;

        /// <summary>Aquela cor tranca?</summary>
        private bool IsLocked(ActiveDungeon dungeon, string color)
        {
            if (!LockConfigOf(dungeon).enabled) return false;

            var room = RoomSpecOf(dungeon, color);
            return room != null && room.locked;
        }

        /// <summary>Quatro dígitos que ninguém mais tem nesta masmorra.</summary>
        private string NewCode(ActiveDungeon dungeon, System.Random rng)
        {
            var settings = LockConfigOf(dungeon);

            if (settings.sharedCode && !string.IsNullOrEmpty(dungeon.sharedCode))
                return dungeon.sharedCode;

            string code = null;

            for (var attempt = 0; attempt < 64 && code == null; attempt++)
            {
                var candidate = rng.Next(0, 10000).ToString("0000", CultureInfo.InvariantCulture);

                // "0707" é a marca de alçapão das plantas herdadas (ver
                // `IsEntranceHatchMarker`). Sorteá-lo não quebra nada
                // hoje — a marca é lida do JSON, não do mundo —, mas
                // poria o mesmo número em dois significados, e a
                // próxima pessoa a depurar isso perderia uma tarde.
                if (candidate == HatchMarkerCode) continue;
                if (dungeon.usedCodes.Contains(candidate)) continue;

                code = candidate;
            }

            // Trinta e duas salas trancadas na mesma masmorra é mais do
            // que o teto do painel; se ainda assim o sorteio não achou
            // um livre, repetir é melhor que não trancar.
            if (code == null) code = rng.Next(0, 10000).ToString("0000", CultureInfo.InvariantCulture);

            dungeon.usedCodes.Add(code);
            if (settings.sharedCode) dungeon.sharedCode = code;

            return code;
        }

        /// <summary>
        /// Pendura o cadeado e tranca.
        ///
        /// ####  A ORDEM E A DA 1.3.4, E ELA FUNCIONA  ####
        ///
        /// `SetParent` no OSSO do encaixe (`GetSlotAnchorName`), pose
        /// local zero, `Spawn`, e SÓ ENTÃO o código, a flag e o
        /// `SetSlot`. Sem o osso, a fechadura nasce no centro da porta,
        /// atravessada nela — e o jogador vê um teclado dentro da
        /// madeira.
        /// </summary>
        private void LockDoor(
            ActiveDungeon dungeon,
            BaseEntity leaf,
            DoorKind kind,
            Layout layout,
            (int, int) roomCell,
            string color,
            System.Random rng)
        {
            var door = leaf as Door;

            if (door == null)
            {
                // ####  SALA TRANCADA SEM FECHADURA E PIOR QUE ABERTA  ####
                //
                // Nem toda folha do catálogo é uma `Door` com encaixe de
                // cadeado. Se esta não for, a sala fica ABERTA e o log
                // diz qual — em vez de o admin ver "trancada" no painel
                // é uma porta que abre sozinha no jogo.
                PrintWarning("a " + kind.label + " não aceita fechadura: a sala "
                             + ColorLabel(color) + " fica destrancada");
                return;
            }

            int roomId;
            if (!layout.owner.TryGetValue(roomCell, out roomId) || roomId < 0) return;

            RoomLock entry;
            if (!dungeon.locks.TryGetValue(roomId, out entry))
            {
                entry = new RoomLock { roomId = roomId, color = color, code = NewCode(dungeon, rng) };

                foreach (var pair in layout.owner)
                    if (pair.Value == roomId) entry.cells.Add(pair.Key);

                dungeon.locks[roomId] = entry;
            }

            var padlock = GameManager.server.CreateEntity(PrefabCodeLock, door.transform.position) as CodeLock;

            if (padlock == null)
            {
                PrintWarning("fechadura não criada: o prefab '" + PrefabCodeLock + "' não existe");
                return;
            }

            padlock.SetParent(door, door.GetSlotAnchorName(BaseEntity.Slot.Lock));
            padlock.transform.localPosition = Vector3.zero;
            padlock.transform.localRotation = Quaternion.identity;
            padlock.OwnerID = 0UL;
            padlock.EnableSaving(false);
            padlock.Spawn();

            padlock.code = entry.code;
            padlock.hasCode = true;
            padlock.SetFlagLocal(BaseEntity.Flags.Locked, true);
            door.SetSlot(BaseEntity.Slot.Lock, padlock);
            door.SetOpen(false);
            padlock.SendNetworkUpdate();

            // `Adopt` põe a marca que o `OnEntityTakeDamage` lê: sem
            // ela, dois tiros de espingarda na fechadura resolvem o
            // enigma inteiro.
            Adopt(dungeon, padlock);
            entry.locks.Add(padlock);
        }

        /// <summary>A cor, como o jogador a lê.</summary>
        private static string ColorLabel(string color)
        {
            if (color == "blue") return "azul";
            if (color == "red") return "vermelha";
            return "verde";
        }

        // ============================================================
        //  A FRONTEIRA COM A FRENTE DO LOOT
        //
        //  ####  DUAS METADES, E ELAS SE ENCONTRAM AQUI  ####
        //
        //  PORTAS (este arquivo, daqui para cima): a fechadura existe,
        //  o código é sorteado, e há uma regra dizendo QUEM pode
        //  carrega-lo.
        //
        //  LOOT (a outra frente): em que corpo o papel entra, se ele
        //  sobrevive à morte do NPC, o que mais vem junto e o respawn.
        //
        //  O contrato entre as duas é este método mais UMA LINHA em
        //  `SpawnNpc` e outra em `SpawnCrate`. `TakeCodeNote` devolve um
        //  `Item` pronto — quem chama só precisa achar container para
        //  ele — e já marcou a fechadura como entregue, então chamar
        //  duas vezes não produz dois papeis do mesmo código.
        //
        //  ####  O PORTADOR NUNCA ESTA DENTRO DA SALA QUE ELE ABRE  ####
        //
        //  Isso NÃO é configurável, e não é capricho: o código da sala
        //  vermelha guardado dentro da sala vermelha é uma porta que só
        //  abre para quem já entrou. O jogador daria a volta na masmorra
        //  inteira procurando um papel que estava do outro lado da porta
        //  trancada.
        // ============================================================

        private Item TakeCodeNote(ActiveDungeon dungeon, Layout layout, (int, int) cell, string carrier)
        {
            if (dungeon.locks.Count == 0) return null;

            var settings = LockConfigOf(dungeon);
            if (settings.carrier != carrier) return null;

            // `corridor` é o padrão porque é o que se lê sozinho: o
            // guarda do corredor tem a chave da sala. `anywhere` deixa
            // o papel cair em qualquer cômodo que não seja o trancado —
            // útil quando a receita quase não tem NPC de corredor.
            var scope = string.IsNullOrEmpty(settings.carrierScope) ? "corridor" : settings.carrierScope;

            int owner;
            var inCorridor = layout.owner.TryGetValue(cell, out owner) && owner < 0;

            if (scope == "corridor" && !inCorridor) return null;

            foreach (var entry in dungeon.locks.Values)
            {
                if (entry.delivered) continue;
                if (entry.cells.Contains(cell)) continue;

                var note = ItemManager.CreateByName("note", 1);

                if (note == null)
                {
                    // O `note` existe no Rust de 09/09/2026 (conferido no
                    // `Bundles/items/note.json` do server01, itemid
                    // 1414245162). Se um update o renomear, a sala fica
                    // trancada sem código — e o `SettleLocks` a abre.
                    PrintWarning("o item 'note' não existe mais: o código da sala "
                                 + ColorLabel(entry.color) + " não pode ser entregue");
                    return null;
                }

                note.name = string.IsNullOrEmpty(settings.noteTitle)
                    ? "Código da porta"
                    : settings.noteTitle;

                note.text = "A porta da sala " + ColorLabel(entry.color)
                            + " abre com o código " + entry.code + ".";

                entry.delivered = true;
                return note;
            }

            return null;
        }

        /// <summary>
        /// O acerto de contas das fechaduras, no fim da construção.
        ///
        /// ####  UMA SALA QUE NINGUÉM ABRE E UM DEFEITO MUDO  ####
        ///
        /// A porta nasce trancada antes de o conteúdo existir, e o
        /// portador só aparece no `Populate`. Se a receita não tiver NPC
        /// nenhum no corredor — ou se o admin puser `carrier: "none"` —
        /// a sala fica lacrada para sempre, a masmorra sobe, a contagem
        /// de peças fecha e ninguém descobre até um jogador desistir de
        /// procurar o papel.
        ///
        /// Então o padrão é DESTRANCAR o que ficou sem portador, e
        /// gritar qual foi. `onUndelivered: "keep"` existe para quem
        /// quer mesmo a sala fechada (um evento em que o admin abre).
        /// </summary>
        private void SettleLocks(ActiveDungeon dungeon)
        {
            if (dungeon.locks.Count == 0) return;

            var settings = LockConfigOf(dungeon);
            var stranded = 0;

            foreach (var entry in dungeon.locks.Values)
            {
                if (entry.delivered) continue;
                stranded++;

                if (settings.onUndelivered == "keep")
                {
                    PrintWarning("a sala " + ColorLabel(entry.color) + " ficou trancada com o código "
                                 + entry.code + " e ninguém para entregá-lo (onUndelivered=keep)");
                    continue;
                }

                foreach (var padlock in entry.locks)
                {
                    if (padlock == null || padlock.IsDestroyed) continue;

                    padlock.SetFlagLocal(BaseEntity.Flags.Locked, false);
                    padlock.SendNetworkUpdate();
                }

                PrintWarning("a sala " + ColorLabel(entry.color) + " foi DESTRANCADA: não havia onde pôr "
                             + "o código " + entry.code + " fora dela. Ponha NPC no corredor, "
                             + "troque `lock.carrier` ou ponha `lock.carrierScope` em 'anywhere'.");
            }

            Debug("fechaduras: " + dungeon.locks.Count + " sala(s), " + stranded + " sem portador");
        }

        /// <summary>Uma linha no chat de quem está lá dentro.</summary>
        private void Announce(ActiveDungeon dungeon, string message)
        {
            foreach (var id in dungeon.inside)
            {
                var player = BasePlayer.FindByID(id);
                if (player != null && player.IsConnected) player.ChatMessage(message);
            }
        }

        // ============================================================
        //  O GRAU DE CADA PEÇA
        //
        //  ####  ERA `Stone` CRAVADO EM SEIS LUGARES  ####
        //
        //  O painel prometia nível de construção e o construtor punha
        //  pedra em tudo: fundação, parede, teto, corredor e entrada.
        //  Agora o grau vem da receita, e vale POR TIPO DE PEÇA e POR
        //  COR DE SALA — a sala vermelha pode ser blindada com o
        //  corredor de madeira.
        // ============================================================

        private static BuildingGrade.Enum ParseGrade(string name, BuildingGrade.Enum fallback)
        {
            if (string.IsNullOrEmpty(name)) return fallback;

            BuildingGrade.Enum grade;
            return GradeByName.TryGetValue(name.ToLowerInvariant(), out grade) ? grade : fallback;
        }

        /// <summary>
        /// O grau daquela peça naquela célula.
        ///
        /// A célula sem dono de sala — corredor, entrada, o que a planta
        /// colou — usa o `structure` da masmorra. A célula de uma sala
        /// usa o `grade` da COR dela, e cai no `structure` quando a cor
        /// não definiu nenhum.
        /// </summary>
        private BuildingGrade.Enum GradeOf(ActiveDungeon dungeon, Layout layout, (int, int) cell, Piece piece)
        {
            var set = dungeon.spec == null ? null : dungeon.spec.structure;

            int owner;
            if (layout != null && layout.owner.TryGetValue(cell, out owner) && owner >= 0)
            {
                string color;
                if (dungeon.roomColors.TryGetValue(owner, out color))
                {
                    var room = RoomSpecOf(dungeon, color);
                    if (room != null && room.grade != null) set = room.grade;
                }
            }

            if (set == null) return DefaultGrade;

            if (piece == Piece.Foundation) return ParseGrade(set.foundation, DefaultGrade);
            if (piece == Piece.Ceiling) return ParseGrade(set.ceiling, DefaultGrade);

            return ParseGrade(set.wall, DefaultGrade);
        }

        /// <summary>
        /// O grau de uma parede, que tem DOIS donos.
        ///
        /// Vence o lado mais forte. Uma sala blindada encostada numa de
        /// madeira não pode ganhar parede de madeira: o admin escolheu
        /// blindado para aquele cômodo, e uma única parede fraca torna a
        /// escolha inteira decorativa — o invasor entra pelo lado barato.
        /// </summary>
        private BuildingGrade.Enum WallGradeOf(ActiveDungeon dungeon, Layout layout, (int, int) a, (int, int) b)
        {
            var mine = GradeOf(dungeon, layout, a, Piece.Wall);

            if (!layout.cells.Contains(b)) return mine;

            var theirs = GradeOf(dungeon, layout, b, Piece.Wall);
            return theirs > mine ? theirs : mine;
        }
```

### C.6 Os campos novos do contrato

Âncora: `private class RoomSpec` (linha 3088).

**Acrescente** os três campos ao `RoomSpec` — não substitua a classe:
a frente de IA já lhe pôs um `public AiSpec ai;` no topo, e colar a
versão de baixo por cima o apagaria. Depois da chave que fecha o
`RoomSpec`, acrescente o `GradeSpec` e o `LockSpec` inteiros.

```csharp
        private class RoomSpec
        {
            // … o que já estiver aqui (`ai`, `key`, `color`, `npc`,
            //   `loot`, `crates`, `door`, `locked`) fica como está …

            /// <summary>A porta da sala grande. Vazio = usa `door` sempre.</summary>
            public string wideDoor;
            /// <summary>Células por porta a partir das quais `wideDoor` vale. 0 = o padrão.</summary>
            public int wideDoorCellsPerDoor;
            /// <summary>O nível das peças desta cor. `null` = herda de `structure`.</summary>
            public GradeSpec grade;
        }

        /// <summary>
        /// O nível de construção, por tipo de peça.
        ///
        /// Os nomes são os do painel (`twigs`|`wood`|`stone`|`metal`|
        /// `toptier`) e não os do enum do jogo: o contrato é escrito uma
        /// vez, em `core/src/types/dungeons.ts`, e o plugin traduz —
        /// ver `GradeByName`.
        /// </summary>
        private class GradeSpec
        {
            public string foundation;
            public string wall;
            public string ceiling;
        }

        /// <summary>
        /// Como a masmorra tranca, e como o código chega ao jogador.
        ///
        /// ####  `lock` E PALAVRA RESERVADA EM C#  ####
        ///
        /// O campo do JSON se chama `lock`, e um `public LockSpec lock;`
        /// não compila. O `[JsonProperty]` resolve num lugar só — ver o
        /// `DungeonSpec`. Renomear o campo do contrato seria mais
        /// simples e mais errado: quem lê o JSON é o painel, e lá a
        /// palavra certa é essa.
        /// </summary>
        private class LockSpec
        {
            public bool enabled = true;
            /// <summary>Um código para a masmorra inteira, em vez de um por sala.</summary>
            public bool sharedCode;
            /// <summary>`npc` | `crate` | `none`.</summary>
            public string carrier = "npc";
            /// <summary>`corridor` | `anywhere`. Nunca dentro da sala trancada.</summary>
            public string carrierScope = "corridor";
            /// <summary>`unlock` | `keep`, quando ninguém recebeu o código.</summary>
            public string onUndelivered = "unlock";
            /// <summary>O nome do papel no inventário.</summary>
            public string noteTitle;
            /// <summary>Avisar quem está dentro quando uma porta abre.</summary>
            public bool announceOpen = true;
            /// <summary>Dizer a quem errou que ele errou.</summary>
            public bool warnOnWrongCode = true;
        }
```

E no `DungeonSpec`, depois de `public List<RoomSpec> rooms;` (linha
3063):

```csharp
            /// <summary>O nível padrão das peças: corredor, entrada e o resto.</summary>
            public GradeSpec structure;

            /// <summary>A fechadura. Ver `LockSpec` sobre o nome.</summary>
            [JsonProperty("lock")]
            public LockSpec doorLock;
```

### C.7 O gancho do código digitado

Âncora: `private void OnPlayerDisconnected(BasePlayer player, string
reason)` (linha 2345) — entra logo depois dela.

```csharp
        /// <summary>
        /// Alguém digitou um código.
        ///
        /// ####  ESTE GANCHO RECEBE O SERVIDOR INTEIRO  ####
        ///
        /// Toda fechadura de todo jogador passa por aqui. A marca no
        /// `_name` — a mesma que o `OnEntityTakeDamage` usa — responde
        /// "é nossa?" em uma comparação de string, antes de qualquer
        /// outra coisa.
        ///
        /// Trancar é do plugin; PUNIR quem erra é do jogo: o `CodeLock`
        /// do Rust já conta os erros (`wrongCodes`) e bloqueia o teclado
        /// sozinho. Reimplementar isso aqui daria duas punições para o
        /// mesmo engano, e a nossa não apareceria na interface.
        /// </summary>
        private void OnCodeEntered(CodeLock codeLock, BasePlayer player, string code)
        {
            if (active == null || codeLock == null || player == null) return;
            if (codeLock._name != MarkIndestructible) return;

            var settings = LockConfigOf(active);

            if (code != codeLock.code)
            {
                if (settings.warnOnWrongCode)
                    player.ChatMessage("Código errado. O papel com ele está com alguém aqui dentro.");

                return;
            }

            if (!settings.announceOpen) return;

            foreach (var entry in active.locks.Values)
            {
                if (!entry.locks.Contains(codeLock)) continue;

                Announce(active, "A porta da sala " + ColorLabel(entry.color) + " foi aberta.");
                return;
            }
        }
```

### C.8 As mudanças pontuais no construtor

São pequenas e estão espalhadas. Na ordem em que aparecem hoje:

**1) `GenerateRooms`, logo depois de `var floors = new Dictionary…`**
(linha 1431, sem mudança). A cor de toda sala tem de existir antes da primeira
peça, e as duas contagens alimentam a decisão da porta larga:

```csharp
            // ####  A COR VEM ANTES DA PRIMEIRA PEÇA  ####
            //
            // O grau de cada peça depende da cor da sala dona dela, e o
            // CHÃO nasce antes das paredes — que era onde `RoomColor`
            // sorteava pela primeira vez. Sem esta volta, a fundação e o
            // teto da sala vermelha sairiam com o grau do corredor e só
            // as paredes obedeceriam a receita: metade do cômodo
            // blindada, metade de pedra, e nada no log.
            //
            // `RoomColor` cacheia por sala, então isto não sorteia duas
            // vezes nem repinta o que a planta já pintou.
            foreach (var pair in layout.owner)
                if (pair.Value >= 0) RoomColor(dungeon, layout, pair.Key, rng);

            // Quantas células e quantas portas cada sala tem. É disso
            // que sai a decisão "esta sala virou funil" — ver
            // `DoorTypeOf`.
            var roomCells = new Dictionary<int, int>();
            var roomDoors = new Dictionary<int, int>();

            foreach (var pair in layout.owner)
            {
                if (pair.Value < 0) continue;

                int seen;
                roomCells[pair.Value] = roomCells.TryGetValue(pair.Value, out seen) ? seen + 1 : 1;
            }

            foreach (var pair in layout.doors)
            {
                int owner;
                if (!layout.owner.TryGetValue(pair.room, out owner) || owner < 0) continue;

                int seen;
                roomDoors[owner] = roomDoors.TryGetValue(owner, out seen) ? seen + 1 : 1;
            }
```

**2) A fundação** (linha 1442):

```csharp
// antes
PrepareBlock(dungeon, block, BuildingGrade.Enum.Stone);

// depois
PrepareBlock(dungeon, block, GradeOf(dungeon, layout, cell, Piece.Foundation));
```

**3) A parede e a porta** — **substitui as linhas 1492-1512**, do
`var isDoor = …` até o fim do `if (isDoor) { … }`. O bloco
`mine == theirs`, logo acima, **não é tocado**:

```csharp
                    var isDoor = doorPairs.Contains(key);

                    // ####  O BLOCO DEPENDE DA PORTA, E NÃO O CONTRÁRIO  ####
                    //
                    // A folha de um metro mora num `wall.doorway`; a de
                    // dois, num `wall.frame`. Erguer o vão primeiro e
                    // decidir a porta depois — como era — deixava a
                    // porta dupla sem onde nascer.
                    var roomCell = layout.owner.ContainsKey(cell) && layout.owner[cell] >= 0 ? cell : neighbour;
                    string color = null;
                    DoorKind kind = null;

                    if (isDoor)
                    {
                        color = RoomColor(dungeon, layout, roomCell, rng);

                        int room;
                        layout.owner.TryGetValue(roomCell, out room);

                        int cellsInRoom;
                        int doorsInRoom;
                        if (!roomCells.TryGetValue(room, out cellsInRoom)) cellsInRoom = 1;
                        if (!roomDoors.TryGetValue(room, out doorsInRoom)) doorsInRoom = 1;

                        kind = DoorKindOf(dungeon, color, cellsInRoom, doorsInRoom);
                    }

                    var prefab = isDoor ? kind.frame : PrefabWall;
                    var (localPos, localRot) = WallPlacement(cell, neighbour);

                    var wall = GameManager.server.CreateEntity(prefab, parent.transform.position) as BuildingBlock;
                    if (wall == null) continue;

                    wall.SetParent(parent);
                    wall.transform.localPosition = localPos;
                    wall.transform.localRotation = localRot;
                    PrepareBlock(dungeon, wall, WallGradeOf(dungeon, layout, cell, neighbour));
                    Adopt(dungeon, wall);
                    walls[key] = wall;

                    if (isDoor) HangDoor(dungeon, wall, kind, layout, roomCell, color, rng);
```

**4) O teto** (linha 1547):

```csharp
// antes
PrepareBlock(dungeon, ceiling, BuildingGrade.Enum.Stone);

// depois
PrepareBlock(dungeon, ceiling, GradeOf(dungeon, layout, pair.Key, Piece.Ceiling));
```

**5) `Populate`** — as quatro chamadas ganham `layout` como **segundo
argumento**, e a última linha antes do `Debug` fecha as contas das
fechaduras.

> A frente de IA já acrescentou um `color` ao `SpawnNpc` (hoje na linha
> 1667: `SpawnNpc(dungeon, floors, forNpcs[i], color, rng)`). O
> `layout` entra **antes** de tudo o que já estiver lá, logo depois do
> `dungeon` — os outros argumentos não se mexem.

```csharp
// as quatro chamadas (linhas 1661, 1667, 1687, 1693)
SpawnCrate(dungeon, layout, floors, …o resto como está…)
SpawnNpc(dungeon, layout, floors, …o resto como está…)

// e depois do laço do corredor, antes do Debug:

            // ####  O ACERTO DE CONTAS DAS FECHADURAS  ####
            //
            // Depois desta linha não nasce mais nada, então é aqui que
            // se sabe se todo código achou um portador. Ver `SettleLocks`.
            SettleLocks(dungeon);
```

**6) `SpawnCrate`** — a assinatura ganha `Layout layout` depois de
`dungeon`, e o corpo ganha a entrega, logo depois do `Adopt`:

```csharp
        private bool SpawnCrate(
            ActiveDungeon dungeon,
            Layout layout,
            Dictionary<(int, int), BuildingBlock> floors,
            (int, int) cell,
            string prefab,
            System.Random rng)
        {

            // …

            Adopt(dungeon, crate);

            // ####  UMA LINHA DA FRENTE DAS PORTAS  ####
            //
            // Ver `TakeCodeNote`: ela devolve o papel do código de uma
            // sala trancada, já marcado como entregue, ou `null`. A
            // caixa é o portador só quando a receita pede
            // (`lock.carrier: "crate"`).
            var crateNote = TakeCodeNote(dungeon, layout, cell, "crate");
            var crateBox = crate as StorageContainer;

            if (crateNote != null)
            {
                if (crateBox == null || !crateNote.MoveToContainer(crateBox.inventory))
                    crateNote.Remove();
            }

```

**7) `SpawnNpc`** — o mesmo, e o papel entra no inventário principal.
A assinatura abaixo é a de antes da frente de IA; hoje há um `string
color` entre `cell` e `rng`, e ele **fica onde está** — o `layout`
entra depois do `dungeon`, e só:

```csharp
        private bool SpawnNpc(
            ActiveDungeon dungeon,
            Layout layout,
            Dictionary<(int, int), BuildingBlock> floors,
            (int, int) cell,
            /* string color, ← da frente de IA, se já estiver lá */
            System.Random rng)
        {

            // …

            npc.EnableSaving(false);
            npc.Spawn();
            Adopt(dungeon, npc);

            // ####  UMA LINHA DA FRENTE DAS PORTAS  ####
            //
            // Ver `TakeCodeNote`. O papel entra no inventário principal
            // do cientista; QUE ELE CAIA quando o NPC morre é da frente
            // do loot — o corpo do `ScientistNPC` leva o `containerMain`
            // junto por padrão, mas quem confirma isso no jogo, e trata
            // o caso de não levar, é ela.
            var npcNote = TakeCodeNote(dungeon, layout, cell, "npc");

            if (npcNote != null)
            {
                if (npc.inventory == null || !npcNote.MoveToContainer(npc.inventory.containerMain))
                    npcNote.Remove();
            }

```

**8) `BuildMinimalEntrance`** (linhas 2031 e 2048) — a entrada também
obedece ao `structure`:

```csharp
PrepareBlock(dungeon, foundation, GradeOf(dungeon, null, (0, 0), Piece.Foundation));
// …
PrepareBlock(dungeon, frame, GradeOf(dungeon, null, (0, 0), Piece.Ceiling));
```

**9) `ReplyStatus`** (linhas 532-540) — o admin precisa ver os códigos sem
jogar a masmorra inteira:

```csharp
            // ####  O ADMIN PRECISA DOS CÓDIGOS  ####
            //
            // Sem isto, a única maneira de saber o código de uma sala é
            // matar o NPC certo — e o admin que quer CONFERIR se a
            // fechadura funcionou teria de jogar a masmorra inteira.
            // O comando já é só de admin (ver `IsAllowed`).
            foreach (var entry in active.locks.Values)
            {
                player.Reply("  sala " + ColorLabel(entry.color)
                             + " · código " + entry.code
                             + " · " + (entry.delivered ? "entregue a alguém" : "SEM PORTADOR")
                             + " · " + entry.locks.Count + " porta(s)");
            }
```

---

## A fronteira com a frente `event-loot`

O código cai de um NPC, e isso são **duas metades**. Elas se encontram
em `TakeCodeNote` (C.5) e em **duas linhas** — uma no `SpawnNpc`, outra
no `SpawnCrate` (C.8, itens 6 e 7).

```
   PORTAS (esta frente)                    LOOT (a outra)
   ─────────────────────                   ──────────────
   a porta nasce trancada
   o código é sorteado (4 dígitos)
   a regra de QUEM pode carregar
        │
        │   TakeCodeNote(dungeon, layout, cell, "npc")
        │   → Item pronto, ou null
        ├──────────────────────────────────►  em que container ele entra
        │                                     se ele CAI quando o NPC morre
        │                                     o que mais vem junto no corpo
        │                                     o respawn
        ▼
   SettleLocks: o que sobrou sem
   portador é destrancado, com grito
```

**O que é meu, e a outra frente não precisa saber:** o prefab do
cadeado, o osso do encaixe, o sorteio sem repetição, a regra "nunca
dentro da sala que o código abre", `corridor` vs `anywhere`, o texto do
papel, o gancho do código digitado, e o acerto de contas no fim.

**O que é da outra frente, e eu não toco:** `TakeCodeNote` devolve um
`Item` e nada mais. Quem escolhe o container, quem garante que o papel
sobrevive à morte do NPC, e quem decide se o corpo carrega mais coisa é
o loot.

**A costura entrou junto com o resto, e a razão é simples:** ela não
precisa de uma linha da outra frente. `TakeCodeNote` fabrica o `Item`,
e quem o põe no container é o próprio `SpawnNpc` — o papel já nasce
dentro do cientista. O que continua **dependendo de medição da outra
frente** é uma coisa só, a primeira da lista abaixo.

**Duas coisas que a outra frente precisa confirmar:**

1. **o corpo do `ScientistNPC` leva o `containerMain` junto?** Eu ponho
   o papel lá porque é onde um cientista guarda o que carrega, mas quem
   mede isso no jogo — e trata o caso de não levar — é ela. Se não
   levar, o papel some com o NPC e a sala fica trancada para sempre, e
   esse é o pior desfecho possível desta frente;
2. **`TakeCodeNote` é idempotente por fechadura, não por chamada.** Ela
   marca `delivered = true` e devolve `null` na vez seguinte. Chamar
   duas vezes no mesmo NPC não produz dois papéis do mesmo código —
   mas produz o papel da **próxima** sala trancada, se houver. Chame
   uma vez por entidade.

Se a frente de loot preferir montar o corpo do NPC por conta própria
(uma tabela de drop, por exemplo), a assinatura serve igual: ela chama
`TakeCodeNote` e insere o `Item` onde quiser.

---

## (d) O que eu medi

Nada aqui veio de memória. Onze prefabs foram escritos de cabeça uma
vez nesta masmorra, `CreateEntity` devolveu `null`, o `return` engoliu,
e o dono encontrou os vãos abertos jogando. Não outra vez.

### D.1 Os 21 caminhos de prefab, contra o jogo instalado

Fonte: `Servers/server01/Bundles/AssetSceneManifest.json` — o manifesto
de cena do Rust **instalado**, 16.358 assets únicos, lido em 09/09/2026.

```
21 de 21 encontrados (comparação em minúsculas; o Rust normaliza)

  assets/prefabs/building/door.hinged/door.hinged.wood.prefab            OK
  assets/prefabs/building/door.hinged/door.hinged.metal.prefab           OK
  assets/prefabs/building/door.hinged/door.hinged.toptier.prefab         OK
  assets/prefabs/building/door.double.hinged/door.double.hinged.wood.prefab      OK
  assets/prefabs/building/door.double.hinged/door.double.hinged.metal.prefab     OK
  assets/prefabs/building/door.double.hinged/door.double.hinged.toptier.prefab   OK
  assets/prefabs/building/wall.frame.cell/wall.frame.cell.gate.prefab    OK
  assets/prefabs/building/wall.frame.fence/wall.frame.fence.gate.prefab  OK
  assets/prefabs/building/wall.frame.garagedoor/wall.frame.garagedoor.prefab     OK
  assets/prefabs/misc/permstore/factorydoor/door.hinged.industrial.d.prefab      OK
  assets/prefabs/building core/wall.frame/wall.frame.prefab              OK
  assets/prefabs/locks/keypad/lock.code.prefab                           OK
  … e os 9 que o plugin já usa (foundation, wall, wall.doorway, floor,
    floor.ladder.hatch, bunker_hatch, ceilinglight, lock.key, shopfront)
```

### D.2 O enum do grau, por reflexão sobre o assembly do jogo

Fonte: `Servers/server01/RustDedicated_Data/Managed/Assembly-CSharp.dll`,
carregado em `ReflectionOnly` com as dependências resolvidas do mesmo
diretório.

```
BuildingGrade.Enum          BaseEntity.Slot
  None    = -1                Lock = 0
  Twigs   =  0                FireMod = 1
  Wood    =  1                UpperModifier = 2
  Stone   =  2                MiddleModifier = 3
  Metal   =  3                LowerModifier = 4
  TopTier =  4                CenterDecoration = 5
  Count   =  5                LowerCenterDecoration = 6
                              StorageMonitor = 7
                              Count = 8
```

`None = -1` fica fora da tabela `GradeByName` de propósito: um bloco
sem grau não tem malha, e a masmorra nasceria invisível. E confirma que
o `Mathf.Clamp(grade, 0, 4)` do leitor de planta (2559) está certo.

Do `CodeLock`, no mesmo assembly: `code`, `guestCode`, `hasCode`,
`hasGuestCode`, `whitelistPlayers`, `guestPlayers`, `wrongCodes`,
`lastWrongTime`, `IsCodeEntryBlocked()`, `ClearCodeEntryBlocked()`. É
por causa dos quatro últimos que a proposta **não** implementa punição
por erro: o jogo já conta os erros e bloqueia o teclado sozinho, e uma
segunda punição nossa não apareceria na interface do jogador.

### D.3 A porta larga mora no `wall.frame` — medido nas plantas

As plantas herdadas (`Assets/dungeons/*.json`) são o que a base 1.3.4
cola de verdade. Elas têm **seis** folhas de dois metros, e **as seis**
estão na posição exata de um `wall.frame`:

| planta | folha | posição | rotação |
|---|---|---|---|
| `base3` | `wall.frame.cell.gate` | `(0.901, 8.901, 6.085)` | igual à do quadro |
| `base3` | `wall.frame.fence.gate` | `(-0.714, -0.099, 4.710)` | quadro + π |
| `entrance1` | `wall.frame.fence.gate` | `(-2.948, -0.099, -6.921)` | quadro + π |
| `entrance1` | `wall.frame.fence.gate` | `(-6.640, -0.099, 5.443)` | quadro + π |
| `entrance1` | `wall.frame.fence.gate` | `(10.992, -0.099, 1.245)` | igual |
| `entrance4` | `wall.frame.garagedoor` | `(7.323, -0.099, -1.350)` | igual |

Ou seja: **pose local zero**, igual à porta no vão — que é o que o
`HangDoor` já faz. A diferença de π nas rotações é o lado para onde a
folha abre.

E que um bloco `building core/wall.*` diferente entra na mesma pose de
parede já estava provado na própria 1.3.4: ela põe um
`wall.window` nas coordenadas devolvidas pela mesma `Lp()` das paredes
(linhas 3139 e 3168).

### D.4 O papel

`Servers/server01/Bundles/items/note.json`: `shortname` `note`,
`itemid` `1414245162`, `stackable: 1`. `Item.text` é o corpo que o
jogador lê ao abrir — a própria 1.3.4 lê `boxItem.text` de uma caixa de
planta (linha 1556), então o campo é o mesmo em uso hoje.

### D.5 O `Stone` cravado

```
Plugins/OrigemZDungeon.cs          6 ocorrências (5 cravadas + 1 padrão de planta)
Docs/…/DungeonBases-1.3.4.cs       6 ocorrências (todas cravadas)
```

### D.6 A compilação — duas vezes, e a segunda vale mais

A primeira foi o rascunho escrito à mão, sobre o plugin das 01:06.

A segunda foi **a partir deste documento**: um script extraiu os blocos
` ```csharp ` da seção (c), aplicou-os ao plugin como ele estava às
01:40 — já com o `ai` no `RoomSpec` e o `color` no `SpawnNpc`, escritos
pela frente de IA no meio deste trabalho — e mandou o resultado ao
lint.

```
dotnet build core/scripts/pluginlint/pluginlint.csproj \
  -p:PluginFile="<plugin atual + os blocos de (c)>" -v q --nologo

    0 Erro(s)
```

É essa segunda que prova o que interessa: **o C# que está escrito aqui
compila, e ainda se aplica depois do que a outra frente escreveu.** Ela
achou três defeitos de transcrição do próprio documento — um `}` a mais
em dois blocos e uma linha duplicada num terceiro —, todos corrigidos
antes desta entrega.

Os avisos são os `CS0649` de campo preenchido por JSON, que o arquivo
já tinha antes. Os dois rascunhos foram apagados.


### D.7 Achado colateral — **fora desta frente**

**A rotação das plantas do CopyPaste está em radianos, e `PasteOne` a
trata como graus.**

`PasteOne` (linha 2545) faz:

```csharp
var worldRot = spin * Quaternion.Euler(ReadVector(node["rot"]));
```

`Quaternion.Euler` recebe **graus**. Mas nas 1.321 entidades das sete
plantas herdadas, **nenhum** componente de rotação passa de 2π
(6,2832), e os máximos caem exatamente em π/2 (1,5705), 3π/2 (4,7124) e
2π (6,2763). Na `entrance1`, os quatro valores mais frequentes de
`rot.y` são:

```
  -2,481  ×129        0,660 + π/2 = 2,231
   0,660  ×112        2,231 + π/2 = 3,802 → −2,481
   2,231  ×107       −2,481 + π/2 = −0,910
  −0,910  × 93
```

São as quatro direções cardeais de uma casa girada 37,8° — em
**radianos**. Zero das 584 entidades é múltiplo de π/2, o que seria
esperado numa casa alinhada se o campo estivesse em graus. E o
`default.rotationy` da mesma planta é `221.5436`, ou seja **graus**: os
dois campos têm unidades diferentes, e é fácil não ver.

Efeito: toda peça colada de planta nasce com a rotação errada — 4,79
radianos (274°) viram 4,79°. Uma parede que devia estar de lado nasce
quase alinhada.

**Não mexi.** É o leitor de plantas, que é de outra frente, e a
correção (`* Mathf.Rad2Deg` no `rot`, e só nele) muda a pose de todas as
sete plantas de uma vez — precisa ser vista no jogo antes de entrar.

---

## (e) O que o dono deve olhar no jogo

Na ordem: os dois primeiros são os que podem estar errados; do terceiro
em diante é conferência.

### 1. A porta larga cabe? — **o risco desta entrega**

Erga uma masmorra com `wideDoor: "double_metal"` (ou
`door: "cell_gate"` direto, que é mais fácil de ver).

- **A folha aparece no vão de dois metros, alinhada com o quadro?**
  Medi que as seis grades das plantas herdadas ficam na pose local zero
  do `wall.frame`, mas **nenhuma delas foi erguida por código** — elas
  foram coladas de um JSON. Se a folha nascer torta, flutuando ou
  metade dentro da parede, é aqui;
- **dá para atravessar em dois?** É o ponto inteiro do item 4;
- **e o `wall.frame` fecha o vão quando não tem folha?** Ele é um
  QUADRO. Se `door: "none"` num `wall.frame` deixar buraco vendo o
  vazio a −90 metros, é o mesmo defeito do `floor.frame` que o dono já
  encontrou no teto — por isso o `none` da proposta usa
  `wall.doorway`, e não `wall.frame`.

### 2. A grade aceita cadeado?

Ponha `door: "cell_gate"` **com** `locked: true` na sala vermelha.

- se o log disser `a grade de cela não aceita fechadura: a sala
  vermelha fica destrancada`, então a folha não é uma `Door` no Rust, e
  a tabela do catálogo precisa de uma coluna `lockable` de verdade;
- se não disser nada, olhe a grade: **o teclado aparece nela?**

O mesmo vale para `fence_gate` e `garage`.

### 3. O código chega mesmo ao jogador

```
/ozdungeon status
```

deve listar cada sala trancada com o código e `entregue a alguém` ou
`SEM PORTADOR`.

Depois: mate NPCs do corredor até achar o papel, abra-o e leia. O texto
é `A porta da sala vermelha abre com o código 4712.` Digite na porta.

- **acertou?** Quem estiver dentro recebe *"A porta da sala vermelha foi
  aberta."* no chat;
- **errou de propósito?** Deve vir *"Código errado. O papel com ele está
  com alguém aqui dentro."*

### 4. O caso que destranca sozinho

Construa com `corridor.npcDensity: 0` e a sala vermelha trancada. O log
tem de dizer:

```
a sala vermelha foi DESTRANCADA: não havia onde pôr o código 4712
fora dela. Ponha NPC no corredor, troque `lock.carrier` ou ponha
`lock.carrierScope` em 'anywhere'.
```

e a porta tem de **abrir na mão**. Uma sala trancada sem código é o
defeito mais caro desta frente, porque ele parece funcionamento normal.

### 5. O grau, e a parede entre duas salas

Ponha `structure: { foundation: "wood", wall: "wood", ceiling: "wood" }`
e, na sala vermelha, `grade: { foundation: "toptier", wall: "toptier",
ceiling: "toptier" }`.

- o corredor tem de ficar de **madeira** e a sala vermelha de
  **blindado** — dá para ver pela textura, sem bater em nada;
- **a parede entre a sala vermelha e o corredor tem de ser blindada**,
  não de madeira. É a regra "vence o lado mais forte";
- o **vão da porta** também segue a parede.

### 6. A invariante do corredor — a que já custou uma masmorra

Depois de qualquer mudança aqui, **desça o alçapão e ande o corredor
inteiro.**

O bloco `mine == theirs` não foi tocado, e a mudança que fiz é logo
abaixo dele. Se o corredor voltar a nascer como fileira de cubículos de
3×3 lacrados — com você preso dentro do primeiro —, foi essa linha, e
não a fechadura.

### 7. E o de sempre

- a masmorra **inteira** ainda sobe: peças contadas, alçapão nos dois
  sentidos, nenhum vão aberto;
- nenhuma porta ficou **sem folha** — o log agora grita o caminho
  quando isso acontece, e não deve haver nenhum grito;
- `PrintWarning("porta desconhecida …")` não deve aparecer nunca: se
  aparecer, o painel mandou um tipo que o plugin não conhece, e o
  enum das duas pontas está fora de sincronia.

---

## Riscos que ficam

1. **A pose da folha larga erguida por código** — medida em planta,
   nunca em construção. É o item 1 de (e), e é onde eu apostaria um
   defeito;
2. **`garage` é uma `Door`?** O portão de garagem sobe em vez de girar.
   Se ele não for `Door`, o código avisa e a sala fica destrancada —
   sem vão aberto, mas sem tranca também;
3. **o corpo do NPC leva o papel?** É da frente de loot, e está escrito
   lá em cima como a primeira coisa a confirmar;
4. **o CHECK da coluna `door`** obriga a migração 062 a recriar
   `dungeon_rooms`. É a única parte da proposta que mexe em tabela
   existente com dado dentro.

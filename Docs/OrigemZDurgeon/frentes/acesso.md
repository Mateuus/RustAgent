# Quem entra, e o que ninguém tira do lugar

**Aplicada direto em `Plugins/OrigemZDungeon.cs` em 09/09/2026**, com o arquivo
livre e as outras quatro frentes do dia já integradas. 404 linhas inseridas,
nenhuma removida. Compila com 0 erros no `pluginlint`.

Os dois pedidos do dono, verbatim:

> *"A Dungeon todo o servidor pode entrar nela, não só um player que faz
> claimer."*
>
> *"Impedir que jogadores com martelo remover objetos da entrada."*
>
> *"E essas configurações ficam no painel."*

---

## 1. O diagnóstico

### Não existia claim — e não existia decisão

Nenhuma posse, nenhum dono, nenhuma permissão de entrada. O alçapão levava
quem o abrisse. **A masmorra já era do servidor inteiro** — mas por acaso,
porque ninguém tinha escrito o contrário.

Isso não é a mesma coisa que o dono pediu. O que ele pediu é que aquilo seja
**verdade declarada**: no dia em que alguém acrescentar posse sem saber que
estava combinado o contrário, essa pessoa vai ter de apagar uma linha que diz o
combinado — e não só acrescentar a dele num arquivo que não opinava.

### `owner_steam_id` é uma coluna morta — e a medição corrige o enunciado

O briefing dizia *"gravado e nunca lido"*. **Medido, é o oposto**:

| onde | o que acontece |
|---|---|
| `core/src/db/migrations.ts:5754` | a coluna é declarada, `TEXT` sem `NOT NULL` |
| `core/src/db/world-events-repository.ts:87` | aparece na interface da linha |
| `core/src/db/world-events-repository.ts:607` | é **lida** e vira `ownerSteamId` |
| `core/src/types/world-events.ts:275` | atravessa o tipo público |
| `panel/src/lib/api.ts:5265` | chega ao painel |

**Nenhum `INSERT` e nenhum `UPDATE` a escrevem.** Ela nasce `NULL`, viaja
`NULL` até a tela e morre `NULL`. Não é dono de nada.

**Decisão desta frente:** ela não é porta, e o plugin não a consulta. Se um dia
ganhar sentido, que seja *"quem apertou o botão de construir"*, para auditoria.
Nunca controle de entrada — foi exatamente isso que o dono recusou.

### Blindar contra dano não blinda contra remoção

`OnEntityTakeDamage` recusa todo dano na masmorra desde sempre. **E a entrada
continuava saindo do lugar**, porque remover não é dano: o martelo, a
ferramenta de remoção e o pickup destroem a entidade por caminhos que nunca
passam por `Hurt`.

Não havia `CanPickupEntity`, `OnHammerHit` nem `canRemove` no arquivo. Eram
**quatro famílias de caminho abertas**, e cada uma perde a entrada sozinha.

---

## 2. O que foi medido, e como

### Os ganchos, lidos no IL do jogo

Nenhum plugin do repositório usa esses ganchos, então não havia de onde
copiar. Eles foram lidos **do `Assembly-CSharp.dll` do server01** — o binário
patchado pelo Oxide, em `Servers/server01/RustDedicated_Data/Managed/` —
decodificando o IL de cada método até o `Interface.CallHook`.

| gancho | método do jogo que o chama | argumentos, na ordem |
|---|---|---|
| `OnHammerHit` | `Hammer.DoAttackShared` | `BasePlayer`, `HitInfo` |
| `OnStructureRepair` | `BaseCombatEntity.DoRepair` | `BaseCombatEntity`, `BasePlayer` |
| `OnStructureUpgrade` | `BuildingBlock.DoUpgradeToGrade` | `BuildingBlock`, `BasePlayer`, `BuildingGrade.Enum`, `ulong` |
| `OnStructureRotate` | `BuildingBlock.DoRotation` | `BuildingBlock`, `BasePlayer` |
| `OnStructureDemolish` | `DecayEntity.DoDemolish` **e** `DoImmediateDemolish` | `DecayEntity`, `BasePlayer`, `bool` |
| `CanPickupEntity` | `BaseCombatEntity.CanCompletePickup` | `BasePlayer`, `BaseCombatEntity` |
| `CanPickupLock` | `BaseLock.RPC_TakeLock` | `BasePlayer`, `BaseLock` |
| `OnDecayDamage` | `DecayEntity.OnDecay` | `DecayEntity` |

### Três medições que mudaram o código

**`OnEntityDecay` NÃO EXISTE.** Zero ocorrências no binário. O gancho de decay
do Rust chama-se `OnDecayDamage`, mora em `DecayEntity.OnDecay` e recebe só a
entidade. Escrever `OnEntityDecay` teria compilado, carregado e nunca sido
chamado — o defeito mais caro possível, porque parece que funciona.

**`CanPickupEntity` devolve `false`, e não `true`.** O IL de
`CanCompletePickup` é:

```
CallHook | stloc | isinst Boolean | ... | unbox.any
```

O retorno passa por `isinst bool` e, **se for bool, vira a resposta** — não é
um "cancela ou não". Devolver `true`, que é o reflexo de quem vem do
`OnEntityTakeDamage`, **autorizaria** o pickup em vez de barrá-lo. Os outros
sete seguem o padrão `CallHook | ldnull | beq | ret`: qualquer não-nulo
cancela.

**O `OnHammerHit` sozinho não basta.** Ele roda na batida, e só nela. O menu
radial do martelo é do cliente: abre sem perguntar ao servidor, e o que chega
ao servidor depois é o RPC de melhorar, girar ou demolir. Quem fecha essas três
portas são os outros ganchos, um para cada.

### Os dois ganchos do RemoverTool, lidos no fonte dele

`Docs/RemoverTools Plugin/RemoverTool.cs`, o plugin que o dono vai instalar:

- **linha 1490** — `canRemove(BasePlayer, BaseEntity)`, dentro de
  `CanRemoveEntity`;
- **linha 1360** — `CanAdminRemove(BasePlayer, BaseEntity, string)`, dentro de
  `TryRemove`.

**São dois porque ele tem dois caminhos.** O `CanRemoveEntity` devolve cedo
quando o modo não é `Normal` (linha 1457) — os modos `Admin`, `All`,
`Structure` e `External` **nunca chegam ao `canRemove`**. Blindar só um deixaria
a masmorra inteira removível para quem tem a ferramenta de admin, que é
exatamente quem a apaga por engano.

Nos dois, devolver **string** faz a razão aparecer na tela do jogador; qualquer
outra coisa mostra o "bloqueado" genérico do plugin dele.

`canRemove` começa com minúscula e **tem de começar**: é o nome exato que o
`Interface.CallHook` procura. É a exceção de contrato de terceiro da regra do
dono, e está comentada no arquivo.

### O que não foi medido

- **Nada disto foi visto rodando no jogo.** O server01 tem a instalação
  incompleta e o RCON não responde; a validação foi compilação e leitura de
  binário. O teste de campo é do dono — ver a seção 5.
- **O RemoverTool ainda não está instalado.** Os dois ganchos são de um plugin
  que não existe no servidor hoje. Quando ele não existe, os métodos ficam
  parados e não custam nada.

---

## 3. O contrato de configuração

Dois blocos novos na receita, ao lado de `lock`, `structure` e `respawn`. Os
dois são opcionais: ausente é o padrão, e o padrão é o que o dono pediu.

### `access` — quem desce

| campo | tipo | valores | padrão |
|---|---|---|---|
| `whoEnters` | string | `everyone` \| `permission` | **`everyone`** |
| `enterPermission` | string | nome de permissão do Oxide, ≤ 64 caracteres | vazio → `origemzdungeon.enter` |

`whoEnters` **nasce `everyone`**, que é o pedido literal do dono: o servidor
inteiro entra. Qualquer valor que não seja exatamente `permission` também é
tratado como `everyone` — um modo escrito errado no painel não pode trancar a
masmorra.

`enterPermission` só é lido no modo `permission`. Pode apontar para a permissão
de outro plugin (uma de VIP, por exemplo), desde que **aquele plugin a
registre**.

**Permissão que não existe deixa entrar.** Se a receita aponta para uma
permissão que plugin nenhum registrou — erro de digitação, plugin de VIP que
saiu do servidor —, `UserHasPermission` devolveria `false` para todo mundo: a
masmorra ficaria lacrada, o alçapão abriria sem levar ninguém e não haveria
nada na tela dizendo por quê. Então o engano **cai para o padrão do dono** e
grita no log do servidor. Abrir por engano devolve a masmorra ao que ela já
era; trancar por engano é um defeito que ninguém diagnostica de dentro do jogo.

Quem tem `origemzdungeon.admin` nunca fica de fora da própria masmorra.

### `protection` — o que ninguém tira do lugar

| campo | tipo | padrão |
|---|---|---|
| `enabled` | bool | **`true`** |
| `allowAdmin` | bool | **`true`** |
| `warnOnAttempt` | bool | **`true`** |

`allowAdmin` existe para que uma masmorra emperrada não vire lixo permanente no
mapa: sem ele, nem quem administra o servidor a tira de lá, e o `ozdungeon
stop` é justamente o que não funciona quando alguma coisa já deu errado.

`warnOnAttempt` avisa **no máximo uma vez a cada 3 segundos por jogador**.
Segurar o botão do martelo dispara `OnHammerHit` várias vezes por segundo, e
uma linha de chat por batida encheria a tela em dois segundos — escondendo
inclusive o aviso da porta que acabou de abrir.

### `protection.enabled` não desliga o decay

Decay não é alguém tirando coisa do lugar: é a masmorra apodrecendo sozinha. O
`OnDecayDamage` obedece só à marca `#ozdung#`, nunca à config. Desligar a
proteção contra martelo e ver a entrada cair sozinha três horas depois seria
uma surpresa que ninguém liga ao botão que apertou.

Isso também **fecha um buraco que já existia**: o `PrepareBlock` empurra o
`lastDecayTick` de cada **bloco** para 999999, mas deployable não passa por lá.
Caixa, luz e armário longe de um armário de ferramentas apodreciam sozinhos, e
a masmorra ia perdendo o miolo durante o próprio evento.

### A marca continua sendo uma só

O critério de "é nosso" é o `_name = "#ozdung#"` que o `Adopt` já põe — bloco,
parede, teto, porta, fechadura, alçapão, luz e caixa de loot. Nenhuma segunda
marca foi inventada. `BasePlayer` continua fora dela, pela razão que já está
comentada no `Adopt`: em jogador, `_name` é o nome de exibição.

**Saquear continua funcionando.** `CanLootEntity` não é tocado: o jogador abre
a caixa e leva o conteúdo; o que ele não faz é levar a caixa.

---

## 4. O que precisa da frente do painel

Nada disto foi feito por esta frente. É o degrau que falta para o campo existir
na tela — ver `.claude/agents/event-painel.md`.

1. **Régua Zod** — `core/src/types/dungeons.ts`, ao lado do bloco `lock` (linha
   ~400):
   ```
   access:     { whoEnters: enum['everyone','permission'] default 'everyone',
                 enterPermission: string max 64 default '' }
   protection: { enabled: bool default true,
                 allowAdmin: bool default true,
                 warnOnAttempt: bool default true }
   ```
   Ambos com `.prefault({})`, como o `lock`.

2. **Contrato** — `core/src/game/dungeon-contract.ts`, dois blocos opcionais em
   `DungeonPayload` ao lado de `lock?` (linha ~310), com o mesmo comentário de
   "ausente = o padrão do plugin".

3. **Migração + repositório** — as colunas da tabela de masmorras.

4. **Enxugamento do sync** — `core/src/dungeons/sync.ts`, no padrão do
   `leanAi`/`leanGrade`: `leanAccess` devolve `undefined` quando `whoEnters` é
   `everyone`; `leanProtection` devolve `undefined` quando os três booleanos são
   `true`.

   **Os padrões dos dois lados têm de ser idênticos.** Omitir só é seguro
   porque `new AccessSpec()` e `new ProtectionSpec()` no C# valem exatamente o
   que o `sync.ts` deixou de mandar. Mudar um padrão de um lado só é o jeito de
   quebrar isto em silêncio.

5. **Painel** — dois campos com `(?)`: *"quem pode descer"* e *"proteger a
   construção"*.

### O orçamento do sync

Teto de **50.000 bytes** (`DUNGEON_SYNC_MAX_BYTES`). Medido em base64:

| caso | custo por masmorra |
|---|---|
| tudo no padrão | **0 bytes** — nada viaja |
| só `whoEnters: 'permission'` | ~52 bytes |
| os dois blocos inteiros, fora do padrão | ~192 bytes |

Com o corte pelo padrão, **a masmorra típica não paga nada** e o teto de ~29
sem tabela de loot / ~8 com continua onde estava. Sem o corte, os ~145 bytes de
cada masmorra tirariam uma das 29.

---

## 5. O que o dono testa no jogo — com o martelo na mão

Este defeito não aparece em typecheck, em lint nem em contagem de peças. Ele
aparece com o martelo na mão.

**Antes:** o `Servers/server01/oxide/plugins/OrigemZDungeon.cs` **não foi
atualizado** por esta frente, e nada foi commitado. Copiar o plugin é do
coordenador.

### O martelo (é o pedido literal)

1. **Bater no alçapão da entrada com o martelo.** Nada acontece, e o chat diz
   *"Isto é da masmorra: não sai do lugar."* — uma vez, não vinte.
2. **Abrir o menu radial do martelo em cima da casinha da entrada e escolher
   "Demolir".** O menu abre (é do cliente, não dá para impedir) e **a peça
   continua lá**. É o teste que separa esta frente do `OnHammerHit`.
3. **Escolher "Melhorar para pedra/metal" no mesmo menu.** Idem.
4. **Girar uma parede** pelo menu. Idem.

### O E segurado

5. **Segurar E na luz do poço da entrada**, e na caixa de uma sala. Nenhuma das
   duas sai. **A caixa ainda abre e o loot ainda sai** — é o que separa
   proteger de estragar.
6. **Segurar E na fechadura da porta da sala vermelha.** Ela não sai da porta.

### Quem entra

7. **Com a receita como está (`whoEnters` ausente): dois jogadores quaisquer
   descem pelo alçapão.** É o pedido do dono, e é o padrão.
8. Depois que o painel tiver o campo, com `whoEnters: permission` e ninguém
   com a permissão: **ninguém desce, e cada um recebe uma linha explicando** —
   menos quem tem `origemzdungeon.admin`.
9. **Descer, e subir de volta.** Subir nunca é barrado: um jogador que perdeu a
   permissão enquanto estava lá embaixo ficaria preso a -90 metros.

### O decay

10. **Uma masmorra de pé por três horas**, sem ninguém dentro. A luz da
    entrada, as caixas e o armário continuam lá. Antes desta frente, os
    deployables apodreciam.

### Se o RemoverTool for instalado

11. **Ferramenta de remoção no modo normal, apontada para a parede da
    entrada.** A caixa da ferramenta fica **vermelha** e mostra *"Isto é da
    masmorra: não sai do lugar."*
12. **O mesmo no modo admin** (`/remove admin`). Também recusa — é o caminho que
    não passa pelo `canRemove` e que só o `CanAdminRemove` fecha.
13. **Com `origemzdungeon.admin` e `allowAdmin: true`**, os dois modos
    funcionam normalmente.

---

## 6. O que ficou de fora, e por quê

**`CanBuild` não foi tocado.** Ele impediria construir dentro da masmorra —
inclusive uma cama ou um saco de dormir, que o jogador legitimamente pode
querer. E não fecha nenhum dos caminhos de remoção.

**Risco conhecido que ele deixa aberto:** um jogador pode construir uma parede
**colada** no alçapão da superfície e emparedar a entrada, sem remover nada. A
masmorra fica inacessível com todas as peças intactas. Isso é *impedir a
entrada*, não *remover objetos* — fora do pedido do dono, e caro de resolver
sem estragar outra coisa. Se aparecer no jogo, é uma frente própria.

**O building privilege deixou de importar.** Um jogador que planta um armário
de ferramentas ao lado ganha autoridade sobre o que está no raio — mas
autoridade sozinha não remove nada: os cinco caminhos que ela destravaria
(melhorar, girar, demolir, reparar, remover) estão todos vetados antes de
chegar à checagem de autoridade.

**Não há `Report` por tentativa recusada.** Uma linha de console por batida de
martelo afogaria o stream que o agente lê — o mesmo motivo pelo qual o aviso ao
jogador tem freio.

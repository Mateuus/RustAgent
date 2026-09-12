# 09 — ADOTAR A CAIXA, E TRAZER O LOOT DO JOGO

> Entregue em 12/09/2026. Complementa o `06 — A integração com o BetterLoot`,
> que já descrevia os dois arquivos e o `Watched Container Prefabs` (§2.2 e a
> tabela de §4): o que faltava era o painel USAR o que aquele documento mediu.

---

## 0 — O que chegou como reclamação

Quatro sintomas, na voz de quem administra:

1. a `crate_elite` aparece com a marca **JOGO** e não há como adotá-la pelo
   painel;
2. caixa marcada "JOGO", ou montada só com perfis, não mostra os itens padrões
   individualmente — não dá para manter, editar nem remover cada um;
3. a `crate_normal` aparece **só com perfis**, sem a lista de itens do
   contêiner;
4. e não há como escolher entre loot original, perfis, itens da casa, ou a
   combinação dos três.

Os quatro têm duas causas, e nenhuma delas é a tela de itens (que funcionava).

---

## 1 — Primeira causa: "JOGO" são DOIS interruptores

O plugin exige os dois ligados para tocar numa caixa. Eles moram em arquivos
diferentes:

| interruptor | arquivo | o que decide |
| --- | --- | --- |
| `Is Prefab Enabled?` | `oxide/data/BetterLoot/LootTables.json` | se o plugin **preenche** a caixa (`PopulateContainer`, `:2342`) |
| `Watched Container Prefabs (true = ...)` | `oxide/config/BetterLoot.json` | se o plugin chega a **olhar** para ela (`OnLootSpawn`, `:1620-1622`) |

O painel lia e editava **só o primeiro**. Com o segundo em `false`, o
`OnLootSpawn` sai com `null` e o jogo entrega o loot nativo — enquanto a tela
afirmava "BetterLoot" e o admin editava uma tabela que o servidor não usava.

### 1.1 E o plugin cadastra caixa nova DESLIGADA

`CheckWatchedPrefabs` (`:216-272`) roda a cada carregamento e acrescenta o que
faltar com:

```csharp
_config.Generic.WatchedPrefabs.TryAdd(name,
    NewConfigGenerated || (NewSave && _config.Generic.AutoEnableNewContainers));
```

Ou seja: **`false` sempre que a configuração já existia e não é dia de wipe**.
Caixa que entrou num update do Rust depois da instalação fica em "jogo" para
sempre, até alguém editar o JSON à mão. É a origem mais provável da
`crate_elite` presa.

### 1.2 O que a tela faz agora

- a marca **JOGO** na lista olha os dois (`isAdopted`);
- o toggle *Esta caixa é do BetterLoot* mexe nos dois de uma vez — um controle
  só, porque a pergunta do admin é uma só;
- quando os dois **discordam** no disco, a tela diz qual arquivo liga e qual
  desliga, e que gravar alinha os dois;
- gravar faz merge de **uma chave** no `BetterLoot.json` e preserva as outras
  110 e todos os blocos de configuração (medido byte a byte no teste).

`watched: null` é um terceiro estado, e não um `false` disfarçado: significa
"aquele servidor não tem `BetterLoot.json`". Tratá-lo como desligado faria a
gravação de uma caixa **criar** a configuração do plugin e desligar o prefab.

---

## 2 — Segunda causa: o loot padrão não está em arquivo nenhum

O BetterLoot lê a tabela nativa do jogo **uma vez**: quando cria a entrada
daquele prefab no `LootTables.json` (`LoadAllContainers`, `:1833-2040`, lendo
`LootContainer.LootSpawnSlots` / `lootDefinition`). Dali em diante o arquivo é a
única verdade que ele conhece, e ele **nunca regenera**.

Por isso:

- caixa que alguém montou só com perfis perdeu a lista, e ela não volta;
- caixa "jogo" não tem como ser adotada com o que ela de fato entrega;
- e, em qualquer caixa, não havia como dizer o que é item do jogo e o que
  alguém acrescentou — o `Ungrouped Items` guarda os dois no mesmo dicionário,
  sem marca nenhuma.

### 2.1 `origemz.loot.native` — o comando novo

No `OrigemZAgent` **0.6.0**. Leitura pura: não escreve nada.

```
origemz.loot.native <offset> <limit> <prefab>

{"ok":true,
 "prefab":"assets/bundled/prefabs/radtown/crate_elite.prefab",
 "source":"container","slotsMin":8,"slotsMax":8,"scrap":25,
 "count":145,"offset":0,"limit":500,
 "items":[{"shortname":"riflebody","min":1,"max":1}],
 "guaranteed":[]}
```

**Os números vêm antes do prefab**, e é de propósito: o caminho tem espaço em
dezessete casos medidos (`dmloot/dm ammo.prefab`) e o console do Rust quebra
argumento no espaço. Com o prefab na frente, nada distinguiria o último pedaço
dele de um offset.

`source` é `container`, `npc`, `lootfill` ou `unwrap`, e vai até a tela porque
muda o que os números significam: corpo de cientista não tem scrap, e presente
conta **tentativas de abrir**, não itens por caixa.

Erros: `PREFAB_NOT_FOUND` (não existe neste build — vira 404 no agente) e
`PREFAB_NOT_LOOT` (existe e não é caixa — 409). Nenhum dos dois é erro de
plugin: o plugin respondeu certo, quem errou foi a pergunta.

### 2.2 Ele repete o BetterLoot de propósito

A leitura é o `GetLootSpawn` do BetterLoot 4.4.0 (`:1701-1760`) portado. Não é
preguiça: se o agente resolvesse a árvore de `LootSpawn` com regra própria, a
lista "padrão" do painel divergiria da que o plugin gerou no primeiro boot — e a
comparação entre as duas **é o produto**.

Os três cuidados que a árvore exige, todos medidos lá:

1. `subSpawn` é recursivo e cada galho tem **peso**. Galho com peso zero nunca
   sai; na lista, ele mente.
2. `restrictedEras` / `eras`: o mesmo prefab entrega coisas diferentes conforme
   `ConVar.Server.Era`.
3. o item que aparece em **todos** os galhos é garantido, e não sorteado — por
   isso sai da lista de itens e vai para a de garantidos.

### 2.3 A medição que fecha a conta

Lido ao vivo do `server01` e comparado, chave a chave, com o `LootTables.json`
que o próprio BetterLoot gerou:

| prefab | fonte | itens (arquivo × vivo) | garantidos | slots | scrap |
| --- | --- | --- | --- | --- | --- |
| `crate_elite` | container | 145 × 145, zero diferença | 0 × 0 | 8 × 8 | 25 × 25 |
| `crate_normal` | container | 111 × 111 | 0 × 0 | 8 × 8 | 8 × 8 |
| `loot-barrel-1` | container | 43 × 43 | 0 × 0 | 1 × 1 | 2 × 2 |
| `scientistnpc_roam` | npc | 211 × 211 | 0 × 0 | 6 × 6 | 0 × 0 |
| `dm construction resources` | container | 0 × 0 | **6 × 6**, min/max iguais | 1 × 1 | — |
| `unwrap/easter.bronzeegg` | unwrap | 9 × 9 | 0 × 0 | 1 × 1 | — |

---

## 3 — O que a tela passou a fazer

### 3.1 Cada linha diz de onde veio

O cruzamento é **por chave exata**, e isso importa mais do que parece: a chave
nativa nunca tem sufixo (`rifle.ak`), e a segunda AK com skin da casa nasce
`rifle.ak{1}`. Casar pelo shortname base marcaria as duas como "do jogo" — o
troféu da casa apareceria como item original do Rust.

O sufixo `.blueprint` é o oposto: faz parte da chave **dos dois lados**, porque
o jogo distingue o item do projeto dele.

A marca visível é a do que a casa acrescentou (`da casa`); "do jogo" fica
discreto, porque numa caixa recém-adotada são 145 linhas iguais e o que se
procura é o que destoa. Com o servidor parado a origem é `unknown` e **nenhuma**
marca aparece — a tela não afirma o que não sabe.

### 3.2 Dois modos de trazer o padrão

| modo | o que faz | o que NÃO faz |
| --- | --- | --- |
| **Trazer os N que faltam** | acrescenta os itens do jogo que a caixa não tem | não tira nada, não muda quantidade de ninguém, não mexe no "quanto sai" |
| **Voltar ao loot do jogo** | remove o que o jogo não põe ali e traz o que falta; devolve o "quanto sai" ao do jogo | **não** reescreve a quantidade de quem fica |

Os dois mostram por extenso o que vai acontecer **antes** de mexer no rascunho —
mesma regra do multiplicador em massa, e pelo mesmo motivo: mexem em dezenas de
linhas de uma vez, e o segundo apaga.

**Nenhum dos dois toca nos perfis.** Eles são do outro arquivo e continuam
valendo: combinar o padrão com perfis é o caso normal, e não uma exceção.

### 3.3 Por que "voltar ao padrão" não devolve as quantidades

Porque um servidor 10x viraria 1x sem ninguém pedir, em silêncio, no meio de 145
linhas. "Voltar ao padrão" devolve a **lista**; quem quiser a quantidade do jogo
de volta tira o item e traz de novo. A tela escreve isso na confirmação.

O scrap tem a mesma proteção ao contrário: o plugin responde `scrap: 0` para
corpo de cientista e para presente, e gravar esse zero apagaria um valor que
alguém pôs ali de propósito. Só `source: container` traz scrap.

---

## 4 — A única parte do editor que precisa do jogo NO AR

Todo o resto é arquivo no disco e funciona com tudo parado — que é justamente
quando se configura loot. A tabela nativa não: ela vive na memória do servidor.

Por isso servidor parado **não é falha da tela**. A seção diz o que se perde (a
separação e o "trazer") e oferece tentar de novo; o resto do editor continua
inteiro. E a resposta vazia tem mensagem própria, porque o console do Rust não
reclama de comando que não conhece — ele simplesmente não responde, e sem essa
frase o admin caçaria um defeito que não existe.

---

## 5 — A armadilha que custou uma sessão

`arg.Args` **não é `string[]`** nesta build: é `Facepunch.StringView[]`.

E isso não dá erro de compilação. `string.Join(" ", arg.Args, 2, 1)` casa com o
overload `Join(string, params object[])` e devolve a string
`"Facepunch.StringView[] 2 1"` — o array impresso pelo `ToString` junto dos dois
números. Compila, roda, e monta um caminho de prefab que não existe.

**Leia sempre pelo `arg.GetString(index, "")`.** Indexar `arg.Args` direto é a
armadilha, e ela é silenciosa.

---

## 6 — Onde está cada coisa

| arquivo | o que mora nele |
| --- | --- |
| `Plugins/OrigemZAgent.cs` | `origemz.loot.native` e a árvore de `LootSpawn` portada |
| `core/src/game/loot-native.ts` | o contrato, o schema e a leitura tudo-ou-nada |
| `core/src/oxide/betterloot.ts` | `toWatched` / `applyWatched` e o `watched` de cada caixa |
| `core/src/http/routes/betterloot.ts` | `GET /servers/:id/betterloot/native` |
| `panel/src/components/loot/betterloot-native.ts` | o cruzamento e os dois modos de importar |
| `panel/src/components/loot/betterloot-table-editor.tsx` | a seção *Loot do jogo* e a marca por linha |

Testes: `core/test/betterloot.test.ts` (a lista de vigia e o loot do jogo) e
`panel/test/betterloot-native.test.ts` (o cruzamento e a importação).

---

## 7 — O que NÃO foi feito, e por quê

- **Adoção em massa** ("adotar todas as caixas de uma vez"). Ligar 111 prefabs
  num clique muda o loot do servidor inteiro, e a conta de quanto muda não cabe
  numa confirmação. Caixa por caixa, com a prévia, é o que o pedido descreve.
- **Guardar a linha de base num banco nosso.** Uma marca gravada envelheceria no
  primeiro update do Rust que mexesse no loot de uma caixa, e passaria a mentir
  sem nenhum sintoma. O cruzamento é sempre contra o servidor de agora.
- **Regenerar a tabela apagando a entrada e recarregando o plugin.** Traz os
  itens do jogo de volta sem plugin novo, mas apaga junto tudo o que o admin
  tinha posto ali, e nunca permite comparar as duas listas.

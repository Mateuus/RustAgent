# 10 — REFAZER A BASE DO LOOT, PELO PRÓPRIO PLUGIN

> Entregue em 13/09/2026. Continua o `09 — Adotar a caixa`, que
> resolveu o mesmo problema **uma caixa por vez**. Este resolve as 111
> de uma vez, e acrescenta o "voltar tudo ao padrão do jogo".

---

## 0 — O que chegou como reclamação

Cinco sintomas, com print de cada um:

1. caixa aparece bloqueada com a marca **JOGO** e não há como adotá-la;
2. caixa montada **só com perfis**, sem nenhum item padrão — a
   `crate_normal` do print tem oito perfis e zero itens;
3. perfis, itens e vínculos ausentes ou órfãos (o painel mostra
   "Ligado" desmarcado em nove dos treze perfis da `crate_elite`);
4. nem toda caixa se administra do mesmo jeito;
5. e consertar caixa a caixa é retrabalho que ainda deixa coisa para
   trás.

O pedido, em uma frase: **refazer a base da aba Caixas a partir de uma
configuração limpa e completa do BetterLoot**, em vez de remendar
contêiner por contêiner.

---

## 1 — A base nova não vem de um arquivo. Vem do plugin.

A tentação era importar o `LootTables.json` limpo que o dono anexou ao
pedido. Ele foi medido contra o `server01`: **111 prefabs, 109
ligados, 15 com `Ungrouped Items` vazio — idêntico, chave a chave**.
Ou seja, é uma config recém-gerada, e não um acervo curado.

E é justamente por isso que ela não serve como fonte: um arquivo
guardado no repositório envelhece no primeiro update do Rust que mexer
em loot, e passa a mentir sem nenhum sintoma — a mesma razão pela qual
o `09 §7` recusou guardar linha de base em banco nosso.

O único gerador que nunca diverge do que o servidor entrega é o
**próprio BetterLoot**, lendo o jogo daquele build. Ele faz isso
sozinho, e há exatamente um jeito de pedir:

> `LoadFile` (`BetterLoot.cs:767`) lê o `LootTables.json`; **se ele não
> existe**, o Oxide devolve estrutura vazia e o `LoadAllContainers`
> (`:1834`) gera tudo do mundo e salva.

Não existe comando de "regenerar". O arquivo sai da frente, ou nada
acontece.

### 1.1 Os passos, e por que nesta ordem

1. lê o que está no disco — é o que vai ser preservado;
2. copia os **três** arquivos para `Backups\<id>\`;
3. **liga a lista de vigia**, quando for para adotar;
4. apaga o `LootTables.json` (e o `LootGroups.json`, no reset);
5. recarrega o plugin, que gera a base do jogo de agora;
6. devolve por cima o que era da casa;
7. grava, completa a vigia e recarrega outra vez, para o plugin
   validar o que foi escrito.

---

## 2 — A descoberta que mudou o desenho: o passo 3 vem ANTES

O `LoadAllContainers` **não varre o mundo**. Ele percorre
`_config.Generic.WatchedPrefabs` — a lista de vigia do
`BetterLoot.json` — e gera a entrada de cada prefab que estiver lá.

E dentro do laço, `:1934-1941`:

```csharp
if (basePrefab.GetComponent<global::HumanNPC>() is global::HumanNPC npc)
{
    if (shouldBeEnabled)          // <- o valor da lista de vigia
        PopulateNPCType(npc.LootSpawnSlots);
}
```

Ou seja: **corpo de cientista com a vigia em `false` não é gerado**. E
só ele — contêiner, `LootFill` e presente são gerados de qualquer
jeito.

A primeira versão desta entrega adotava as caixas **depois** de gerar,
como o `save` de uma caixa faz. O resultado seria a base nova nascer
sem exatamente aquilo que se foi buscar: os 31 corpos de cientista
medidos no `server01`, todos em "JOGO", continuariam sem lista.

O passo 7 continua existindo porque o `CheckWatchedPrefabs` (`:216`)
roda a cada load e **acrescenta prefab novo desligado** sempre que a
configuração já existia e não é dia de wipe. Sem ele, a caixa que
entrou no update de ontem seria gerada e continuaria fora do painel.

### 2.1 E por isso existe "preservado"

Prefab que estava na tabela e que o plugin não gerou tem duas causas
diferentes, e tratá-las igual perderia configuração:

| causa | como se sabe | o que acontece |
| --- | --- | --- |
| o jogo não tem mais aquele prefab | o plugin o **removeu** da lista de vigia (`:2040-2046`) | sai da base nova, e vai para `dropped` |
| é NPC e estava fora da vigia | continua na lista | a entrada fica **como estava** |

Adotar tudo — o caminho recomendado — esvazia a segunda coluna.

---

## 3 — O que sobrevive ao "refazer a base"

Decisão do dono, em 13/09/2026:

| sobrevive | volta ao do jogo |
| --- | --- |
| item da casa (chave que o jogo não tem) | a lista de itens de cada caixa |
| garantido da casa | a quantidade editada de um item **do jogo** |
| os perfis ligados à caixa, com chance e teto | o "quanto sai" (itens, scrap, blueprints) |
| o travamento de pool e o "ignorar raridade" | |

**"Item da casa" é por CHAVE EXATA**, e isso é a mesma regra do
cruzamento do `09 §3.1`: a chave nativa nunca tem sufixo (`rifle.ak`),
e a segunda AK com skin da casa nasce `rifle.ak{1}`. Casar pelo
shortname base faria o Troféu Bleik Store passar por item original do
Rust — e sumir no primeiro rebuild.

As duas listas do jogo entram na conta (itens **e** garantidos) porque
o plugin move entradas entre elas sozinho: o item que sai de todos os
galhos vira garantido. Olhar só uma faria o mesmo item ser devolvido
como "da casa" e aparecer duas vezes na caixa.

### 3.1 Por que a quantidade editada não sobrevive

Porque preservar cada mín./máx. faria o "refazer a base" devolver a
mesma tabela torta de onde se veio — que é o contrário do pedido. Um
servidor que multiplicou 145 linhas à mão volta ao 1x e reaplica o
multiplicador, que é um clique na faixa de cima.

É a decisão oposta à do `09 §3.3`, e de propósito: lá o admin pedia
**uma caixa** de volta ao padrão, e o 10x dele não podia virar 1x sem
ele pedir. Aqui ele está pedindo a base inteira de novo, e a tela
escreve isso antes.

### 3.2 Nada duplica, por construção

Caixa, item e perfil são **chave de dicionário** nos dois lados. O que
a base nova já tem não é devolvido; o que ela não tem entra uma vez
só. Rodar duas vezes seguidas dá o **mesmo arquivo, byte a byte** — e
é assim que o teste confere, porque "não duplica" só se prova
repetindo.

---

## 4 — O reset geral

`factory`, no mesmo botão. Ele apaga o `LootTables.json` **e o
`LootGroups.json`**, e deixa o plugin recriar os dois: a base do jogo e
o arquivo de perfis com o `example_group` que ele mesmo escreve.

É o "zerar e editar do zero" que o dono pediu. Nada da casa volta —
nem item, nem perfil, nem vínculo. Tudo isso fica no backup.

Três travas, e não uma:

1. **a palavra é diferente por modo** — `REFAZER` e `RESETAR`. Quem
   digita a do merge não apaga os perfis por engano, e o agente
   recusa antes de tocar em disco. O bearer do `.env` abre a API
   inteira: um `POST` sem corpo não pode zerar o loot de um servidor;
2. os três arquivos são copiados **antes** de qualquer escrita, e os
   caminhos voltam na resposta;
3. se o plugin não gerar a base, **tudo volta ao lugar** — inclusive a
   adoção do passo 3 — e a rota responde 503 sem ter mudado nada.

A `Blacklist.json` **não** é tocada em nenhum dos dois modos. Ela é
lista de itens banidos do servidor, montada à mão, e não tem relação
com o conteúdo das caixas. A tela diz isso.

---

## 5 — O que a tela mostra depois

O relatório é parte da operação, e não um extra: sem ele o admin
abriria 111 caixas para descobrir o que aconteceu — que é o retrabalho
que este botão existe para acabar.

- caixas na base, itens do jogo, itens da casa preservados e vínculos
  preservados, em número;
- quantas caixas saíram da marca **JOGO** e quantas entraram na vigia;
- as caixas que o painel não conhecia (`fresh`);
- as que ficaram de fora (`dropped`) e as que ficaram como estavam
  (`preserved`), com o motivo de cada uma;
- **os perfis órfãos** — nome citado por alguma caixa que não existe no
  `LootGroups.json`. O BetterLoot ignora o vínculo órfão em silêncio, e
  era parte do sintoma 3 do pedido;
- a tabela por caixa, e os caminhos dos três backups.

---

## 6 — Onde está cada coisa

| arquivo | o que mora nele |
| --- | --- |
| `core/src/oxide/betterloot.ts` | `mergeRebuiltTables`, `BetterLootEditor.rebuild`, `applyWatchedAll`, `waitForBirth` |
| `core/src/oxide/data-files.ts` | `deletePluginDataFile` — apagar é pedir ao plugin que refaça |
| `core/src/http/routes/betterloot.ts` | `POST /servers/:id/betterloot/rebuild` e a palavra de confirmação |
| `panel/src/components/loot/betterloot-rebuild-dialog.tsx` | os dois modos, o que se perde em cada um, e o relatório |
| `panel/src/components/loot/betterloot-panel.tsx` | o botão, no cabeçalho — a operação é do servidor, não da caixa |

Testes: `core/test/betterloot-rebuild.test.ts` — 16, e o último roda o
merge contra os 111 prefabs e 6.824 entradas do arquivo real do
`server01`.

---

## 7 — O que NÃO foi feito, e por quê

- **Importar o arquivo enviado pelo admin.** Ver §1: o plugin é uma
  fonte melhor, e o caminho de upload existiria só para o caso de o
  servidor estar parado — que é o único caso em que esta operação não
  pode acontecer de qualquer forma.
- **Prévia antes de aplicar.** Ela exigiria a base nova para ser
  calculada, e gerar a base nova é a parte destrutiva. A confirmação
  diz o que vai acontecer, o backup é feito antes, e o relatório diz o
  que aconteceu.
- **Mexer na `Blacklist.json`.** Ver §4.
---

## 8 — A medição ao vivo

Rodado no `server01` em 13/09/2026, com o jogo no ar e o BetterLoot
4.4.0 carregado. A configuração foi estropiada de propósito antes,
com os três estragos dos prints.

| o que foi medido | resultado |
| --- | --- |
| tempo da operação inteira | **8 s** (dois reloads do plugin inclusos) |
| caixas na base nova | 111, com 6.824 itens do jogo |
| `crate_tools`, esvaziada à mão | voltou com os **39 itens**, e com os dois perfis ligados nela |
| troféu da casa na `crate_elite` (`trophy{1}`) | preservado, com a skin |
| `smgbody`, que eu tinha posto em 50-99 | voltou a **1-1**, o do jogo (§3.1) |
| `Enable Loot Pool Locking` que eu liguei | preservado |
| perfil órfão (`PerfilQueNaoExiste`) | denunciado no relatório |
| segunda passada | **arquivo idêntico, byte a byte** |
| reset (`factory`) | 111 caixas do jogo, zero da casa, `LootGroups` com só o `example_group` |

O console do servidor fecha a conta:

```
[BetterLoot] Using '109' active of '111' supported container types   <- antes
[BetterLoot] Using '111' active of '111' supported container types   <- depois
[BetterLoot] Populated (6355) supported loot containers.
```

Nenhum erro, e o plugin repovoou os 6.355 contêineres do mundo com a
base nova.

### 8.1 As duas caixas que o teste revelou

As únicas duas adotadas de 111 foram `bradley_crate` e `heli_crate` —
e não por acaso: o plugin as gera **sempre** desligadas.

```csharp
container.Enabled = !lootPrefab.Contains(bradleyCrate, ...) &&
                    !lootPrefab.Contains(heliCrate, ...);
```

"Adotar todas" as liga junto, que é o que o pedido descreve — nada
pode ficar preso em "JOGO". Mas é uma mudança de comportamento no loot
de evento, e por isso a tela avisa em amarelo, ao lado do
interruptor: quem quiser o loot do jogo no Bradley e no heli desliga as
duas na lista depois.

---

## 9 — O que NÃO foi feito, e por quê (continuação)

- **Adoção seletiva por natureza de caixa** ("adotar tudo menos as de
  evento"). São duas caixas em 111, e um interruptor a mais na
  confirmação para um caso que se resolve com dois cliques na lista.

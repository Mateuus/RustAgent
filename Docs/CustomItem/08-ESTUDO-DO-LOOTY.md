# 08 — O ESTUDO DO LOOTY

> **O que este documento é.** A **medição do `looty.cc`** — o editor de
> BetterLoot que roda por fora do servidor — feita **navegando o editor ao
> vivo** em 09/09/2026, com o navegador, mexendo no loot de verdade: criei um
> profile, associei a uma caixa, apaguei o profile, joguei um item na lista de
> junk e rodei o `Remove Junk`. Cada comportamento descrito abaixo foi
> **observado**, não lido em documentação.
>
> **Por que ele existe.** O dono pediu três coisas para a nossa aba de Loot —
> Loot Profiles, Junk/Remove Junk, e o conserto do erro de conflito depois de
> gravar. As duas primeiras são features que o Looty tem e nós não; a terceira é
> um bug nosso. Este documento mede o Looty para as duas primeiras e **fecha o
> diagnóstico da terceira** (§6), que não tem nada a ver com o Looty.
>
> **O §1 ao §6 são medição; o §7 é relato.** Os seis primeiros foram escritos
> antes de qualquer linha de código, e nada do projeto tinha sido alterado
> quando eles ficaram prontos. O dono então mandou fazer as três frentes de uma
> vez, e o §7 conta o que foi construído — inclusive o que foi visto funcionando
> no `server01` de verdade.
>
> **De onde ele parte.** O [`06-INTEGRACAO-BETTERLOOT.md`](06-INTEGRACAO-BETTERLOOT.md)
> mediu o plugin e decidiu que o painel edita os JSONs dele — referências como
> **[I§n]**. O [`07-INSTALAR-BETTERLOOT.md`](07-INSTALAR-BETTERLOOT.md) é a
> instalação revertida. A documentação oficial do Looty (`looty.cc/docs`, 5
> artigos publicados de 36 anunciados) é **rasa demais para servir de fonte**:
> ela diz "profiles group items with weights" e para por aí. Tudo abaixo veio do
> editor rodando.

**Escrito em 09/09/2026.** Fontes cruzadas: o editor em
`editor.looty.cc/betterloot-v4` (que redireciona para `looty.cc/betterloot`),
navegado sem login; o fonte `BetterLoot.cs` v4.4.0 (3.405 linhas) e os JSONs
reais em `Backups/server01/oxide-2026-09-08_23-30-03/`; e o nosso código em
`core/src/oxide/betterloot.ts` (1.284 linhas) e `panel/src/components/loot/`.

---

## §1 — O QUE O LOOTY É, E O QUE ELE NÃO É

O Looty é um **editor de arquivo**, não um agente. Ele não fala com servidor
nenhum: você sobe o `LootTables.json` (`Upload`), edita na tela, e baixa o
resultado (`Download`) para colocar no servidor com as próprias mãos. O `Save`
guarda no perfil da conta dele, na nuvem dele — não no seu servidor.

Isso é a diferença estrutural entre ele e nós, e ela decide tudo o que vem
abaixo:

| | Looty | RustAgent |
|---|---|---|
| Onde o arquivo mora | no navegador / na conta Looty | no disco do servidor |
| Como chega ao jogo | download manual + upload por FTP | escrita direta + `oxide.reload` |
| Quem sabe a raridade do item | uma cópia do catálogo dele | o servidor, depois de salvar |
| Conflito de duas telas | não existe (é um arquivo local) | **existe** — e é o §6 |
| Login | Steam, com times e papéis | o do painel |

Ele tem 7 editores (BetterLoot, AlphaLoot em beta, Raidable Bases, Raidable
Boats, Server.cfg, Converter, Rust Database). **Só o de BetterLoot interessa
aqui**; os outros são de plugins que não usamos.

O editor abre **sem login**, com a tabela padrão do plugin carregada. Foi assim
que ele foi medido.

---

## §2 — LOOT PROFILES: O QUE O LOOTY CHAMA ASSIM

### 2.1 — É o `LootGroups.json`, com outro nome

Isto é o achado que mais economiza trabalho: **"Loot Profile" no Looty é uma
entrada do `LootGroups.json` do BetterLoot.** Não é conceito do editor, não é
abstração nova. O profile `example_group` que a tela mostra é exatamente o
`example_group` que está no nosso disco:

```json
{
  "Loot Groups": {
    "example_group": {
      "Enabled?": false,
      "Guaranteed Items": {},
      "Item List": {
        "lmg.m249": {
          "Item Probability (1-100)": 100.0,
          "Item Amount": { "Allow Duplicates": true, "Skin ID (0 = default)": 0, ... }
        }
      }
    }
  }
}
```

No plugin é a classe `LootProfile` (`BetterLoot.cs:1137`), com três campos:
`Enabled?`, `Guaranteed Items`, `Item List`. **Nada mais.** O que a tela do
Looty mostra além disso (a barra de "Complete 100.0% / 100%", o "Auto Balance",
os botões de multiplicador) é ferramenta de edição, não campo de arquivo.

### 2.2 — A associação é do outro lado, dentro da caixa

O profile em si não sabe em que caixa entra. Quem sabe é a **caixa**, no
`LootTables.json`, no campo `Loot Profiles` de cada prefab — a classe
`LootProfileImport` (`BetterLoot.cs:902`):

| Campo no arquivo | O que é | Padrão medido |
|---|---|---|
| `Group Enabled?` | liga/desliga esta associação | `true` |
| `Loot Profile Name` | o nome no `LootGroups.json` | — |
| `Loot Profile Probability (1% - 100%)` | a chance de a caixa sortear DESTE profile | **30** |
| `Max Items From Profile (0 = unlimited)` | teto de itens vindos dele por caixa | `0` |

Medido ao vivo: cliquei em `Add to Crate` no profile `teste_origemz` dentro da
`Crate Cannons` e o editor criou a associação com **30%** e limite `∞` — o mesmo
30 que o plugin usa como exemplo em `BetterLoot.cs:647`.

### 2.3 — A barra que explica o sorteio

Assim que a associação existe, a tela mostra uma barra de proporção:

```
Guaranteed Items | Profiles 30.0% | Ungrouped 70.0%
```

Ou seja: **profiles e "itens soltos" disputam o mesmo sorteio**. Cada slot de
item da caixa primeiro decide *de onde* vem (de um profile, pela probabilidade
dele; ou da lista solta, com o resto), e só depois sorteia o item. Antes de
associar qualquer profile a barra dizia `Profiles 0.0% / Ungrouped 100.0%` — é
o estado das nossas 111 caixas hoje.

### 2.4 — A tela do profile, campo a campo

| Controle | O que faz | Onde grava |
|---|---|---|
| `Profile Enabled` (toggle) | liga o profile inteiro | `Enabled?` |
| `Rename` | renomeia | a chave do dicionário |
| `Delete` | apaga | idem |
| `Default Profile Probability (1-100%)` | a probabilidade sugerida ao associar | **em lugar nenhum do arquivo** — é conveniência da tela |
| `✓ Complete — 100.0% / 100%` | soma das probabilidades dos itens | leitura |
| `⚠️ Incomplete` + `Auto Balance` | soma ≠ 100; o botão redistribui | reescreve as probabilidades |
| `2x` `5x` `10x` `Custom` + `Min`/`Max` + `Apply Multiplier to All Items` | multiplica quantidades | `Item Minimum` / `Item Maximum` |

O `Auto Balance` é o irmão de tela do `"Enable auto profile probability
balancing?"` do `BetterLoot.json` (que está `true` no nosso servidor): o plugin
faz a mesma conta ao carregar, avisando no log `Profile probability sum (x) !=
100. Balancing profile!` (`BetterLoot.cs:600`).

**Cada item do profile** tem: `Guaranteed Item`, `Allow duplicates`,
`Can convert to blueprint`, `Create Blueprint Copy`, `Probability (%)`, `Min`,
`Max`, `Display Name`, `Skin`, `Advanced Properties`, `Remove`.

Note o `Probability (%)`: **dentro de um profile o item tem peso próprio**. Fora
dele, na lista solta, não tem — lá quem manda é a raridade do jogo. É a
diferença que a nossa tela já explica ("Esta caixa sorteia por raridade").

### 2.5 — Criar, e o que acontece ao apagar

`Create Profile` abre um modal com **um** campo: `Profile Name`. Nada mais. O
profile nasce vazio, `enabled`, e marcado `⚠️ Incomplete — 0.0% / 100%`.

Itens entram **clicando** no card da barra lateral direita (não é arrastar); o
card ganha um selo `ADDED` depois disso. Detalhe de UX que vale copiar.

**Apagar um profile em uso — medido.** O aviso do Looty é genérico:

> Are you sure you want to delete the profile "teste_origemz"? This action cannot
> be undone.

**Ele não diz que o profile está associado a uma caixa.** Eu tinha acabado de
associá-lo à `Crate Cannons`, e o texto não mudou. Confirmei em seguida: apaguei,
voltei à caixa, e a associação **sumiu junto** — a barra voltou para
`Ungrouped 100.0%`. Ou seja, o Looty faz cascade silencioso.

Isto é uma **lacuna do Looty**, e é exatamente o que o dono pediu que a nossa
tela faça melhor: *avisar antes*, dizendo em quais caixas o profile está.
Sem o aviso, o plugin ainda se defende — ele loga
`WARNING: prefab "x" requested a loot group import with name "y". Group does not
exist` (`BetterLoot.cs:1031`) e ignora —, mas o admin perde o ajuste sem saber.

---

## §3 — JUNK / REMOVE JUNK: NÃO É DO PLUGIN

### 3.1 — O plugin não conhece a palavra

`grep -i junk BetterLoot.cs` → **zero ocorrências** (fora
`scientistnpc_junkpile_pistol`, que é nome de prefab de NPC). O
`BetterLoot.json` também não tem campo nenhum de junk.

**Conclusão: junk é uma ferramenta de curadoria do editor.** É uma lista de
shortnames que o editor considera lixo, e um botão que os remove da caixa
aberta. O que chega ao servidor é o resultado — a caixa sem aqueles itens —, e
não a lista.

Isso é uma decisão de desenho para nós, e é grande: **onde a nossa lista de junk
mora?** Não pode ser no `LootTables.json` (o plugin apagaria, e o `scanEntry`
reescreve o arquivo). Tem que ser dado do agente — banco, por servidor ou global.

### 3.2 — O que a tela do Looty tem

Três superfícies, todas medidas:

**a) O menu de contexto do item** (botão direito num item da caixa):

```
Add to junk list (this container)
Restore Default (Min/Max)
Copy item
```

O primeiro mostra o toast `added to this container's junk list` — mas o texto
mente um pouco: o item foi para a lista **global** `Your Custom Junk`, e não
para uma lista daquela caixa. Confirmei abrindo o modal logo depois. O item
**não** é removido nesse momento; só entra na lista.

**b) O modal `Configure Junk Items`** (a engrenagem ao lado de `Remove Junk`):

- `Add Custom Junk Item or Category` — um campo que aceita **shortname, nome ou
  categoria**, com botão `Add`;
- `Your Custom Junk (n)` — o que o admin acrescentou;
- `Default Junk (31 Active / 31 Total)` — os 31 embutidos, cada um com uma
  lixeira que o desativa.

**Os 31 padrões, capturados da tela:**

```
barricade.stone      barricade.wood       barricade.wood.cover  bucket.water
burlap.gloves        electric.igniter     fireplace.stone       fun.guitar
hat.beenie           hat.boonie           hat.cap               mailbox
mask.balaclava       mask.bandana         paddle                pants.shorts
planter.large        planter.triangle     rug                   rug.bear
shelves              shirt.tanktop        shutter.wood.a        sign.wooden.huge
sign.wooden.large    spikes.floor         spinner.wheel         table
tool.binoculars      tunalight            water.barrel
```

É uma lista boa e vale adotar como nosso padrão: são os itens de decoração e
construção barata que enchem caixa sem valor de progressão.

**c) O botão `Remove Junk`** — remove da caixa aberta **todos** os itens que
estejam na lista (custom + defaults ativos). Medido: adicionei `bandage` à lista,
cliquei, e o `bandage` sumiu da `Crate Cannons` com o toast
`Junk items removed from selected crate!`. **Sem confirmação e sem desfazer.**
Para nós isso é imprudente — a nossa tela grava no disco de um servidor de
verdade. Um "vou remover N itens desta caixa: …" antes do golpe é barato.

**d) O global.** No menu `Editor Actions` existe `Clear Junk — Remove junk
everywhere`, que roda o mesmo em todas as caixas de uma vez.

---

## §4 — O QUE MAIS O LOOTY TEM E NÓS NÃO

Levantado no mesmo passeio; nenhum item aqui foi pedido pelo dono, e a lista
existe para que a decisão de escopo seja informada.

**Ferramentas de caixa**

| Recurso | O que faz |
|---|---|
| `Selection mode` | seleciona vários itens e aplica em lote `Guaranteed Item`, `Allow duplicates`, `Can convert to blueprint`, `Create Blueprint Copy`; tem `Select all in crate` |
| `Import selected to profile` | **move os itens selecionados da caixa para um profile** — o caminho natural de quem quer começar a usar profiles sem redigitar tudo |
| `Copy Loot` / `Paste` | copia a caixa inteira para outra |
| `Found at` | onde aquela caixa aparece no mundo |
| `Preview Loot` | o simulador — nós já temos, é o "ABRINDO 100 CAIXAS" |
| `Restore Default (Min/Max)` | volta um item ao padrão do jogo |
| `Prefab Enabled` | liga/desliga a caixa |

**Campos de caixa que a nossa tela não mostra** (e que existem no arquivo):

- `Enable Loot Pool Locking` — "escolhe **um** pool (um profile ou o solto) por
  abertura e usa só ele para todos os slots". Depende do interruptor global
  `Enable Loot Pool Locking System` no `BetterLoot.json`;
- `Select ungrouped items ignoring rarity bias` — sorteia os itens soltos
  **uniformemente**, em vez de usar a raridade do jogo (Comum → Muito Raro).
  Este muda o significado da coluna de porcentagem da nossa tela;
- `Bonus items count toward the container item limit` e `Guaranteed items count
  toward the container item limit` — **estes dois nós já temos** (os pares
  CONTAM/SOMAM da IMG3).

**Ações globais** (`Editor Actions`): `Multiplier` (multiplica todo o loot),
`Apply Skin` (skin em todas as caixas), `Clear Junk`, `Global Actions`
(`Clear All Containers`, `Remove All Blueprints`, `Remove All Duplicates`),
`Reset` (restaura padrões), `Search Item` (**acha em quais caixas um item cai** —
o mais útil da lista, e o mais fácil para nós, porque já lemos o arquivo
inteiro).

**Catálogo**: barra lateral com 15 categorias (Misc, Weapon, Fun, Items,
Component, Food, Ammunition, Medical, Attire, Electrical, Tool, Construction,
Resources, Traps, DLC), abas `Main`/`Staging`, selos `NEW` e `DLC` por item, e
ícones vindos de um CDN próprio (`looty-cdn.magicservices.co/Items/<shortname>.png`).
Nós servimos os nossos de `panel/public/item-icons/`.

---

## §5 — ONDE NÓS ESTAMOS HOJE

Medido no código, não no discurso.

**O que já temos** — e que o Looty também tem: leitura e escrita do
`LootTables.json` por caixa, `Min/Max Items`, `Blueprints`, `Scrap`, os dois
"contam no total", itens garantidos, itens soltos com min/max, bonus items,
skin, display name, o simulador de 100/1000/10000 caixas, os multiplicadores
globais do `BetterLoot.json`, e o backup antes de cada escrita. Além disso temos
o que o Looty **não** tem: escrita direta no servidor e `oxide.reload`.

**O buraco, medido por `grep`:**

```
core/src/oxide/betterloot.ts:92:  export const LOOT_GROUPS_FILE = 'LootGroups';
```

A constante existe. **Nenhuma linha a usa.** O `LootGroups.json` não é lido nem
escrito pelo agente, e o campo `Loot Profiles` de cada prefab não aparece em
lugar nenhum da API nem da tela. O que salva a situação é que o `applyTable`
(`betterloot.ts`) **preserva a entrada crua** do que não edita — então as
associações que existirem no arquivo sobrevivem às nossas gravações. Elas apenas
são invisíveis.

Junk: **não existe** em lugar nenhum, nem tabela, nem rota, nem tela.

---

## §6 — O ERRO DEPOIS DE GRAVAR E RECARREGAR

Este é o item mais urgente dos três, e **não tem relação com o Looty** — é bug
nosso. O diagnóstico está fechado.

### 6.1 — O sintoma

Primeira gravação: funciona. Segunda gravação **da mesma caixa, sem tocar em
mais nada**:

> O LootTables.json mudou no disco depois que esta tela o abriu — outra pessoa
> gravou, ou o próprio BetterLoot reescreveu o arquivo ao recarregar. Nada foi
> alterado: recarregue a caixa e refaça a edição em cima do que está lá.

### 6.2 — A causa: uma corrida entre o RCON e o Oxide

A sequência do `save` (`core/src/oxide/betterloot.ts:1037`) é:

1. lê o arquivo e confere o `baseRevision` contra o sha256 do disco;
2. faz backup;
3. grava o arquivo inteiro;
4. **`oxide.reload BetterLoot`** — e espera o *Reply* do RCON;
5. **relê o disco imediatamente** e devolve o sha desse texto como `revision`.

O passo 4 é o problema. `rcon.send('oxide.reload BetterLoot')`
(`core/src/oxide/plugins.ts:322`) volta assim que o comando é **despachado**. O
Oxide então descarrega o plugin, recompila, chama `Init`, e é aí que o
`scanEntry` valida as 6.824 entradas e **reescreve o arquivo** (`BetterLoot.cs:780`,
incondicional) — tudo isso **depois** que o nosso `await` já retornou.

Então o passo 5 lê o arquivo **antes** de o plugin reescrevê-lo. Devolvemos à
tela o sha do texto que *nós* gravamos; um instante depois o plugin grava outro
texto, com outro sha. Na próxima gravação o `baseRevision` que a tela guarda já
não bate — e o agente, corretamente pelo que ele sabe, responde 409.

O `loadStatus()` que o painel dispara logo após o save
(`panel/src/components/loot/betterloot-panel.tsx:245`) **não conserta**: ele
corre na mesma janela e lê o mesmo arquivo ainda-não-reescrito.

Nada disso é hipótese: o cabeçalho do nosso próprio `betterloot.ts` já
descrevia a reescrita (§"O QUE SE ESCREVE NÃO É O QUE FICA NO DISCO") e o
comentário do `saveGlobals` já dizia, em 06/09, que "recarregar o plugin
reescreve o `LootTables.json` sozinho". O que faltou foi **esperar** por ela.

### 6.3 — Um segundo defeito, mais fundo: a revisão é grossa demais

Mesmo consertada a corrida, a proteção continua errada por outro motivo.

A revisão hoje é o **sha256 do arquivo inteiro**. Mas o `save` faz *merge por
prefab*: ele lê o disco no momento da gravação e troca **só** a caixa editada,
preservando as outras 110. Ou seja, duas telas em **caixas diferentes** não se
atropelam — e mesmo assim a segunda leva 409, porque o arquivo inteiro mudou.

O conflito real é: *alguém mudou **esta caixa** entre a hora em que eu a abri e a
hora em que gravei*. A revisão certa é, portanto, **por caixa** — o sha da
entrada daquele prefab —, e não do arquivo.

Isso também deixa a corrida do §6.2 quase inofensiva: quando o plugin reescreve
o arquivo, ele mexe em campos de muitas caixas, mas se ele não mexeu na **minha**,
a minha revisão continua válida.

### 6.4 — O conserto proposto

Três peças, e vale fazer as três:

1. **Esperar o arquivo estabilizar depois do reload.** Entre o passo 4 e o 5,
   observar o arquivo (mtime + tamanho, ou o sha) até ele ficar parado por uma
   janela curta, com teto de alguns segundos. Se estourar o teto, seguir com o
   que houver — nunca travar a gravação por causa disso. É o que torna a
   `revision` devolvida *a de verdade*.
2. **Trocar a revisão de arquivo por revisão de caixa.** `baseRevision` passa a
   ser o sha da entrada do prefab. A mensagem de conflito fica verdadeira
   ("**esta caixa** mudou"), e conflitos falsos entre caixas diferentes somem.
3. **Manter uma revisão de arquivo, mas só para o que é do arquivo inteiro** (a
   contagem da lista, os globais) — já é assim para o `BetterLoot.json`, que tem
   `configRevision` separado justamente por este motivo.

Com isso, o comportamento que o dono pediu — "após o recarregamento, o Agent
deve reler o `LootTables.json` e atualizar seu estado interno, permitindo novas
edições sem atualizar a página" — passa a valer, e a proteção contra edição
externa continua de pé.

---

## §7 — O QUE FOI CONSTRUÍDO

> **Construído em 09/09/2026**, na mesma sessão deste estudo, por decisão do
> dono ("tudo de uma vez", e a lista de lixo "por servidor"). O que segue é
> relato do que existe na árvore, e não mais proposta.
>
> **Verificado contra o `server01` de verdade**: uma instância do agente subiu
> numa porta separada, com o `.env` real, e o painel foi operado no navegador
> contra o `LootTables.json` e o `LootGroups.json` daquele disco. O que os
> testes não alcançam — a tela — foi visto funcionando. As duas coisas que o
> teste mexeu no arquivo real (o scrap da caixa de canhões, um item na lista de
> lixo) foram desfeitas ao fim, e conferidas no disco.

### 7.1 — Loot Profiles

**Agente** (`core/src/oxide/betterloot.ts`). O `LootGroups.json` passou a ser
lido e escrito com o mesmo cuidado do `LootTables.json`: backup antes,
releitura depois, revisão própria **por perfil** (`profileRevisionOf`), e espera
pela reescrita do plugin. O `applyProfile` preserva o que a tela não edita — o
`Item Properties` de uma arma dentro de um perfil sobrevive, e há teste para
isso.

**Rotas** (`core/src/http/routes/betterloot.ts`):

| Rota | O que faz |
|---|---|
| `GET  /servers/:id/betterloot/profiles` | a lista, com `usedBy` e a soma dos pesos |
| `GET  /servers/:id/betterloot/profile?name=` | um perfil inteiro |
| `PUT  /servers/:id/betterloot/profile` | cria (`baseRevision: null`) ou grava |
| `DELETE /servers/:id/betterloot/profile?name=` | apaga; `detach` tira das caixas |

A associação com a caixa já viajava no `PUT` da tabela — o campo `profiles` do
prefab existia no agente e na rota desde 06/09; o que faltava era a tela.

**Tela.** Uma aba **Perfis** ao lado de **Caixas**
(`panel/src/components/loot/betterloot-profiles.tsx`): lista com "n itens · soma
x% · em n caixas", criar, ligar/desligar, editar peso/mín/máx de cada item,
**Repartir igual** (o "Auto Balance"), e apagar. E, dentro do editor de caixa, o
bloco **Perfis desta caixa**
(`panel/src/components/loot/betterloot-table-profiles.tsx`) com a barra
"x% dos sorteios vêm de perfil · y% dos itens soltos", chance, teto e o
liga/desliga por associação.

**Onde ficamos melhores que o Looty — e está em pé.** Apagar um perfil em uso
mostra:

> Ele está sendo sorteado por 1 caixa(s): `loot-barrel-1`. Apagar tira o perfil
> dessas caixas junto — elas voltam a sortear só os itens soltos. Sem isso o
> BetterLoot as ignoraria em silêncio.

E o agente **recusa** o apagamento (409 `BETTERLOOT_PROFILE_IN_USE`) enquanto a
tela não autorizar o `detach`. O Looty não pergunta nada.

**A conta da soma 100** está na barra do editor, e o agente NÃO recusa uma soma
diferente — recusar obrigaria a acertar tudo antes de poder salvar qualquer
coisa. Quem avisa é a tela; quem reparte, se ninguém repartir, é o plugin.

### 7.2 — Junk / Remover lixo

**Onde mora.** No banco do agente, **por servidor** (migração **073**,
`core/src/db/betterloot-junk-repository.ts`). Decisão do dono em 09/09/2026.

A tabela guarda a **divergência**, e não a lista: os 31 padrões do §3.2 vivem no
código, e uma linha diz ou "o admin desligou este padrão" (`active = 0`) ou "o
admin acrescentou este item" (`active = 1`). A lista que vale é
`(padrões − desligados) + acrescentados`. Semear 31 linhas por servidor teria um
custo específico: no dia em que a lista de fábrica ganhasse um item novo, nenhum
servidor já cadastrado o receberia.

**Rotas.** `GET`, `POST` e `DELETE /servers/:id/betterloot/junk`. Nenhuma delas
toca o disco do servidor.

**Tela.** O diálogo **O que é lixo neste servidor**
(`panel/src/components/loot/betterloot-junk-dialog.tsx`), que separa "marcados
como lixo" de "padrões desligados" — porque religar um padrão e acrescentar um
item são a mesma ação, e tirar um padrão e tirar um item do admin não são. Na
linha de cada item da caixa, um botão marca aquele item como lixo **sem tirá-lo
dali** (marcar é opinião; tirar é edição). E, na barra da caixa, o botão
**Remover lixo (n)**.

**Onde ficamos melhores que o Looty.** O `Remove Junk` dele apaga na hora, sem
confirmar. O nosso mexe **no rascunho**: o admin vê a caixa sem os itens, lê
"n item(ns) tirado(s) da caixa. Grave para valer no servidor", e ainda tem
**Descartar** e **Gravar** na frente dele. O botão fica inerte, com o motivo no
título, quando nenhum item daquela caixa está marcado.

### 7.3 — O erro de conflito

As três peças do §6.4 estão em pé:

1. **`waitForRewrite`** espera o plugin reescrever o arquivo e parar, por sinal
   do disco (mtime + tamanho) e não por tempo fixo — com paciência de 2 s para
   ver a primeira mudança e teto de 8 s. Ela só corre quando o reload foi
   enviado e o plugin compilou: servidor parado não reescreve nada. Os tempos
   são injetáveis (`RewriteWait`) porque, no teste, não há Oxide do outro lado e
   a espera cobraria dois segundos de cada gravação para não descobrir nada.
2. **A revisão passou a ser por caixa** (`tableRevisionOf`, `tableRevision` na
   API). O `revision` do arquivo inteiro continua no `GET /betterloot`, para a
   lista — nunca para gravar.
3. O `saveGlobals` ganhou a mesma espera: o `MaybeUpdateConfigDict` reescreve o
   `BetterLoot.json` depois do reload, pela mesma corrida.

**A prova.** O teste `deixa gravar a mesma caixa duas vezes depois de o plugin
reescrever o arquivo` (`core/test/betterloot.test.ts`) imita o Oxide: reescreve
o arquivo **30 ms depois** de o `oxide.reload` já ter respondido — que é o que
acontece em produção —, e espera 80 ms antes da segunda gravação, porque um
admin não clica duas vezes no mesmo instante. Sem a espera (`timeoutMs: 0`), ele
falha com o 409 que o dono relatou. Com ela, passa. Os outros dois guardam que
gravar caixas diferentes deixou de ser conflito e que o conflito de verdade —
duas telas na MESMA caixa — continua sendo pego.

E no painel de verdade: duas gravações seguidas da caixa de canhões do
`server01`, sem F5, as duas com "Caixa gravada e plugin recarregado".

---

## §8 — O QUE FICOU DE FORA E POR QUÊ

- **A conta Looty, times e papéis** — não medi: exige login com Steam, e não há
  motivo para criar conta lá para este estudo.
- **`Save`/`Share` do Looty** — dependem da conta.
- **Os outros 6 editores** (AlphaLoot, Raidable Bases, Raidable Boats,
  Server.cfg, Converter, Database) — são de plugins que não usamos.
- **O `Download`** — o formato de saída é o do próprio plugin, e nós já temos os
  arquivos reais do `server01` para conferir contra. Baixar o dele não
  acrescentaria.
- **Medir a corrida do §6.2 com o Oxide de verdade** — o BetterLoot está
  desligado no `server01` [I§7] e a instalação de lá está incompleta, então ela
  foi estabelecida pelo fonte dos dois lados e reproduzida em teste (§7.3), não
  capturada ao vivo. O que foi confirmado no servidor real é o resto: as duas
  gravações seguidas, a lista de perfis lida do `LootGroups.json` de lá, o
  `usedBy` apontando a `loot-barrel-1`, e o aviso antes de apagar.

- **As ferramentas do §4** — `Import selected to profile`, `Copy Loot`,
  `Search Item`, seleção em lote, `Loot Pool Locking` na tela. Nenhuma foi
  pedida; ficam levantadas para quando forem.

# 01 — Telas desenhadas, em vez de programadas

> **O que este documento é.** O contrato de como uma tela COM DADO VIVO deixa de
> nascer em TypeScript e passa a nascer no editor do painel, com o agente só
> preenchendo o que é dele. É plano e contrato ao mesmo tempo: o mecanismo já
> existe e está em produção num canto do projeto — o que falta é generalizá-lo.
>
> **Regra de leitura:** onde este documento e o código discordarem, **o código
> vale** e este documento está vencido. Referências são por nome de arquivo e de
> símbolo, nunca por número de linha ou de seção de outro documento — os dois
> apodrecem sozinhos.

**Escrito em 06/09/2026.** Pedido do dono, na mesma data: *"na parte de interface
tem que ter a opção de criar outra interface; a saída tem que ser um json e o
plugin monta ele — fazer handcode não faz sentido."*

---

## §0 — O que já era verdade antes deste documento

Vale registrar, porque metade do pedido já estava de pé e trabalho refeito é
trabalho perdido:

| Peça | Estado |
| --- | --- |
| O documento de interface é JSON | `core/src/types/ui-document.ts` (zod) e `panel/src/lib/ui-doc/model.ts` (o mesmo modelo, do lado do editor) |
| O plugin não desenha | `Plugins/OrigemZUI.cs` abre dizendo `ESTE PLUGIN NAO SABE DESENHAR`: ele recebe CUI pronto e chama `CuiHelper.AddUi` |
| A conversão mora no agente | `core/src/game/ui-cui.ts`, com teste — em C# não teria, porque não há servidor de Rust no CI |
| Criar interface pela API | `POST /api/ui/documents` aceita documento inteiro **ou** modelo |
| Criar interface pelo painel | **Feito em 06/09/2026**: `panel/src/components/ui-editor/create-ui-dialog.tsx` — em branco, de um modelo, ou copiando uma existente |

Nenhuma tela do jogo está escrita em C#. O `handcode` do pedido não está no
plugin: está no **TypeScript do agente**, e é sobre ele que este documento trata.

---

## §1 — O problema, em números

As telas que mostram dado vivo são montadas em código:

| Tela | Arquivo | Linhas |
| --- | --- | --- |
| Loja | `core/src/game/ui-store-screens.ts` | 1.697 |
| Ranking | `core/src/game/ui-ranking-screen.ts` | 1.516 |
| Calendário | `core/src/game/ui-calendar-screen.ts` | 1.296 |
| Kits | `core/src/game/ui-kits-screen.ts` | 995 |
| Missões | `core/src/game/ui-quests-screen.ts` | 782 |
| | **total** | **6.286** |

O custo não é o tamanho: é o que ele significa. **Mover um botão exige editar
TypeScript, e trocar uma cor exige um deploy.** O admin tem um editor visual
completo no painel e não alcança nenhuma dessas telas — justamente as cinco que
o jogador mais abre.

E cada tela nova nasce com o mesmo preço.

---

## §2 — A saída já existe, e está em produção

`core/src/game/ui-store-template.ts` — 231 linhas — resolveu isto para os três
modais da loja. A divisão é esta:

```
 do ADMIN     posição, tamanho, cor, fonte, o que é escrito nos rótulos
              fixos, quais elementos existem

 do AGENTE    o nome do item, o ícone, a quantidade, o total, o saldo,
              as N linhas de uma lista, e TODAS as ações
```

Como o agente sabe qual elemento é qual: **pelo FIM do id**. O desenho traz
`…mcnome` e `…mctotal`; o preenchedor procura esses sufixos e troca o conteúdo.

```ts
fillTemplate(template, screenId, {
  [SLOTS.nome]:  { text: offer.name },
  [SLOTS.icone]: { item: { itemId, skinId } },
  [SLOTS.total]: { text: formatNumber(total), color: canBuy ? C.amber : C.rust },
  [SLOTS.saldo]: balance === null ? { hide: true } : { text: '…' },
})
```

E o `SlotValue` já cobre os cinco casos que uma tela de dados precisa:

| Campo | O que faz |
| --- | --- |
| `text` | troca o rótulo |
| `action` | troca o que o botão faz |
| `item` | troca o ícone (itemId + skinId) |
| `color` | troca a cor |
| `hide` | some com o elemento **e a subárvore dele** |
| `children` | **derrama conteúdo dentro**: é o que permite um desenho fixo hospedar uma lista de tamanho desconhecido |

`children` é a peça que faz a coisa toda funcionar. O admin desenha um elemento
vazio dizendo *"a lista mora aqui, com este tamanho"*; o agente decide o que vai
dentro.

---

## §3 — Duas regras que NÃO mudam

### §3.1 — A ação é sempre do agente

O `SlotValue.action` existe para o agente **sobrescrever** a ação do desenho, e
isso é segurança, não conveniência:

> As ações carregam o `offerId` e a quantidade que serão COBRADOS — se viessem do
> documento, um admin distraído (ou um documento adulterado) mudaria o preço de
> uma compra.
>
> — `ui-store-template.ts`

Vale igual para o resto: o botão que resgata um kit, o que entrega a recompensa
de uma missão, o que navega para a página 3 do ranking. **O desenho diz onde o
botão fica; o agente diz o que ele faz.**

### §3.2 — Navegação com parâmetro NÃO cabe no documento

O `uiDocumentSchema` recusa `:` em `screenId` de ação. Um documento com um botão
apontando para `tela-quest:disponiveis` **seria recusado na gravação**, e o menu
sumiria do jogo.

A tela que o agente monta a cada clique não passa pelo schema — é por isso que
ela pode ter abas e paginação. Consequência prática para o contrato:

> **Todo botão que navega com parâmetro (aba, página, detalhe) nasce sem ação
> utilizável no desenho e recebe a ação no preenchimento.** O admin desenha o
> botão; o endereço é do agente.

Isso já está documentado em `buildQuestsScreen` (o parâmetro `withTabs`) e foi
pego por teste uma vez. É a armadilha mais cara desta frente.

---

## §4 — O que falta construir

Três peças, nesta ordem.

### §4.1 — O mecanismo genérico sai de dentro da loja

`fillTemplate`, `SlotValue` e `slotOf` são genéricos hoje, mas moram no arquivo
dos modais da loja, junto com `BUY_TEMPLATE_ID` e os sufixos dela. Enquanto
estiverem ali, a segunda tela a usá-los importa "o template da loja" para
desenhar ranking.

**Entrega:** `core/src/game/ui-template.ts` com o mecanismo puro.
`ui-store-template.ts` fica com o que é da loja e passa a importar dali. Nenhuma
mudança de comportamento — é movimentação, e o teste existente da loja é quem
garante isso.

### §4.2 — O agente precisa MEDIR o slot

Aqui está a peça que a loja não precisou e o ranking não dispensa.

O modal de compra tem tamanho fixo, então o agente injeta as linhas sem
perguntar nada. Uma lista paginada, não: para saber **quantas linhas cabem**, o
agente precisa da ALTURA do elemento que o admin desenhou. Hoje ele não tem como
saber — a conta de âncora + offset para pixels existe só no painel
(`panel/src/lib/ui-doc/geometry.ts`).

**Entrega:** a mesma conta no core, com teste próprio, e o preenchedor passando
a medida do slot para quem monta as linhas.

> **A conta, para não a reinventar errado.** A âncora é normalizada e relativa
> ao PAI; o offset é em pixels a partir da âncora já resolvida. Y cresce para
> CIMA no Unity, então a distância do topo do pai é `alturaPai - yMax`, e não
> `yMin` — que é o engano natural. Base 1280x720.

Sem esta peça, o admin pode mover e recolorir a lista, mas não redimensioná-la
sem que a paginação minta.

### §4.3 — Um contrato de slots por tela

Um por tela, com os sufixos publicados. O do ranking, como primeiro:

| Slot | Tipo | O que o agente põe |
| --- | --- | --- |
| `title` | `text` | `RANKING` ou o nome do ranking aberto |
| `subtitle` | `text` | de onde os números vêm e de quando são |
| `notice` | `text` + `color` + `hide` | o aviso de coleta atrasada; some quando não há |
| `column` | `children` | um item por ranking, o ativo destacado, com o pager |
| `list` | `children` | as linhas da página — **precisa de §4.2** |
| `self` | `children` + `hide` | a faixa "você está em Nº" |

**O fallback é obrigatório e não é temporário.** Sem a tela no documento, o
layout embutido continua valendo — é o que mantém o jogo de pé em todo documento
gravado antes desta frente, e é o que a loja já faz.

---

## §4.4 — O que a primeira conversão ensinou

Escrito depois de o ranking entrar, em 06/09/2026. As três coisas que o plano
acima não previa:

### O modelo é a tela que JÁ estava gravada

Não é preciso inventar um id novo (`tela-ranking-modelo`). A `tela-ranking` do
documento sempre existiu — é a de **repouso**, que o plugin desenha no instante
do clique, antes de a resposta chegar (`OpenScreen`, em `Plugins/OrigemZUI.cs`).
Ela deixa de ser só isso e passa a ser também o modelo. O admin edita uma tela,
não duas.

### `fillTemplate` preenche o que existe; não cria o que falta

E isso quase virou uma regressão silenciosa. A tela de repouso nasce de
`emptyRankingView()`, que **não tem ranking nenhum** — e sem rankings o layout
não desenha coluna. Usá-la como modelo apagaria a coluna do jogo em todo
documento gravado antes desta frente.

Duas peças resolveram:

1. **`skeleton`** — o preset grava a tela com a coluna presente, **transparente
   e vazia**. Invisível no repouso (que é quando essa tela é vista) e pintada
   pelo agente ao preencher.
2. **A regra de aceitação** — o desenho só vale como modelo se tiver os dois
   elementos que estruturam a tela: a coluna e a caixa da lista. Quem não tem cai
   no layout embutido **inteiro**, que é exatamente o que ele já fazia. Zero
   regressão para quem não restaurar o menu.

O preço é conhecido e está registrado no código: apagar a coluna no editor não a
remove — devolve o layout de código. Distinguir "apagou de propósito" de
"documento antigo" exigiria um marcador explícito no documento, e isso não foi
pedido.

### O desenho é fixo, e a adaptação de layout se perde

No layout embutido, sem coluna a lista escorrega para a esquerda e ocupa a
largura toda. Na tela desenhada ela fica onde o admin a pôs. **Essa perda é da
natureza da coisa** — quem escolhe a posição é quem desenhou —, e o que dá para
fazer é esconder a coluna, que é o que o preenchimento faz.

---

## §5 — A ordem do trabalho

1. ~~**§4.1** — extrair o mecanismo. Sem mudança de comportamento.~~ **Feito**:
   `core/src/game/ui-template.ts`.
2. ~~**§4.2** — a medida do slot, com teste.~~ **Feito**:
   `core/src/game/ui-geometry.ts`, com `core/test/ui-geometry.test.ts`.
3. ~~**Ranking** — a primeira tela convertida.~~ **Feito**: `RANKING_SLOTS` em
   `ui-ranking-screen.ts`, e o §7 de `core/test/ui-ranking-screen.test.ts`.
4. ~~**Home** — a tela de ENTRADA, que não tinha dado nenhum.~~ **Feito**
   (07/09/2026): `HOME_SLOTS` em `core/src/game/ui-home-screen.ts`, com
   `core/test/ui-home-screen.test.ts`. Ela deixou de ser um cartaz de três
   frases e virou quatro cartões — pódio do ranking, oferta em destaque, próximo
   wipe e as missões de quem abriu.
5. **Missões**, **Kits**, **Calendário** — na mesma forma, uma por vez.
6. A loja por último: ela já tem metade do caminho andado e é a que mais dói se
   quebrar.

**O que a home ensinou, e vale para qualquer tela de entrada.** Ela é a única
que viaja na carga inicial (`toDocumentPayload` manda o shell, a tela de entrada
e o índice), então o modelo dela é pago por TODO servidor, em TODA carga. Os
quatro cartões levaram a carga de 29 KB para 37 KB dos 50 KB do frame — e o
primeiro corte foi a moldura de 1px, que custava dois elementos por cartão. A
folga virou teste (`a carga inicial fica com folga confortável`), porque uma
carga estourada não dá erro: o menu não abre.

E ela precisa da marca `generated: true` no documento, como as missões: sem
isso o plugin desenha o repouso e nunca pede a de verdade — na tela de entrada,
isso é o menu abrindo em "Carregando…" para sempre.

**O que o ranking ainda NÃO faz.** A altura da LINHA acompanha a caixa
desenhada; quantas linhas a página traz (`RANKING_PAGE_SIZE`, 10) e quantos
rankings cabem na coluna (`RANKING_COLUMN_PAGE_SIZE`) continuam vindo da régua
estimada de §3. Torná-los medidos exige que a contagem chegue ao **recorte**
(`readRankingView`), que roda antes do desenho — e recortar pelo tamanho do slot
é uma mudança que atravessa o caminho todo. Fica para depois de as outras telas
entrarem, quando a forma do problema estiver clara nas cinco.

Cada passo entra com o fallback ligado, o que significa que **nenhum deles é
irreversível**: apagar a tela do documento devolve o layout embutido.

---

## §6 — As armadilhas medidas que valem aqui

Todas já custaram caro neste projeto uma vez. Repetidas aqui porque esta frente
passa por cima das cinco:

1. **O recorte acontece ANTES do desenho.** O que o jogador não pode ver não
   atravessa o RCON. Preencher um slot com a lista inteira e deixar o desenho
   "mostrar só dez" manda os outros mil pelo fio.
2. **O teto do comando é 50.000 bytes de base64.** Uma tela estourada NÃO DÁ
   ERRO no jogo: ela simplesmente não abre. Toda tela convertida precisa do teste
   de pior caso, como `core/test/quests-screen.test.ts` já faz.
3. **A convenção de sufixo quebra em silêncio.** Renomear o elemento no editor
   faz aquele campo parar de ser preenchido, e o rótulo fica com o texto de
   exemplo. É o preço de o admin poder mover tudo sem que o agente saiba — e o
   editor precisa avisar quando um slot conhecido some do desenho.
4. **Um botão são DOIS elementos no CUI**, e a cor vai em floats. Quem monta
   `children` monta CUI de verdade, não HTML.
5. **Nada guarda estado: tudo é endereço.** Aba e página são o id da tela, não
   memória do plugin.
6. **O que o servidor esconde tem de sumir INTEIRO.** Uma tela com um cartão por
   assunto (a home) transforma `hidden` num problema visível: esconder
   `tela-loja` sem esconder o botão deixava um cartão prometendo uma seção que
   aquele servidor não tem. Desde 07/09/2026 a poda é transitiva — `applyHidden`
   leva junto o botão cuja ação aponta para a tela escondida —, e o gerador
   pergunta ao documento PODADO quais cartões existem (`cardsOf`).

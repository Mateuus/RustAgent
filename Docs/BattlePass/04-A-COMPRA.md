# Passe de Batalha — a compra

Como o jogador compra o passe pago: na loja dentro do jogo com OzCoin, e no
site. O que já existe, o que nasce, e os quatro lugares onde isto pode dar
errado em silêncio.

Medido em 17/09/2026 contra o código da `main`.

> **Revisão do mesmo dia.** Este documento foi escrito quando a trilha era por
> dia de calendário. O dono corrigiu no meio do levantamento: a trilha é por
> **nível de XP**. Nada aqui mudou de mecânica — a compra, o débito, o plano
> congelado e a ativação do mês são os mesmos —; o que mudou é que o retroativo
> entrega os **níveis alcançados**, e não os dias passados.

---

## 1. O caminho já está construído — o passe é mais um formato de oferta

A loja do jogo não sabe preço, não sabe saldo e não entrega nada. O plugin manda
`offerId`, `quantity`, `steamId` e o segredo; **quem cobra e quem entrega é o
agente**. A consequência boa: o passe não precisa de caminho próprio de compra.
Ele precisa de um `kind` novo no catálogo e de um ramo na entrega.

```text
OrigemZUI.RequestBuy ──#OZBUY#──▶ UiSync.#handleBuy ──▶ StoreService.buy
                                                              │
   1. pareamento ativo?              (recusa sem tocar em dinheiro)
   2. oferta existe e está ligada?
   3. já há compra em voo? (5 min)
   4. passa do teto de OZ?
   5. congela o PLANO  ◀── é aqui que o passe grava de que MÊS ele é
   6. debita no site
   7. entrega  ──▶ deliverPlan()  ◀── é aqui que o passe é ativado
   8. marca entregue
      └─ falhou? estorna. estorno falhou? vira `failed` e chama gente.
```

`deliverPlan` (`core/src/store/service.ts:773`) é **o único ponto por onde a
compra in-game e a fila do site passam**. O ramo do passe entra ali, logo
depois do bloco do VIP (`:811`). Em nenhum outro lugar.

---

## 2. O molde é o VIP, e ele já resolveu o problema difícil

O VIP é uma assinatura com prazo comprada por OzCoin. É exatamente a forma do
passe, e a loja **não reimplementa VIP**: ela declara a interface mínima
`VipGranter` (`core/src/store/service.ts:139`) e recebe a lista de VIPs por
injeção. O comentário ao lado diz por que — um segundo lugar onde VIP nasce
produziria "um VIP comprado que nunca expira".

O passe segue a mesma disciplina: uma interface `PassGranter` ao lado da
`VipGranter`, e o serviço do passe injetado em `core/src/index.ts`.

E há uma trava do VIP para copiar letra por letra: o índice único parcial

```sql
CREATE UNIQUE INDEX idx_vips_active ON vips (steam_id, tier) WHERE revoked_at IS NULL
```

(`core/src/db/migrations.ts:929`). No passe ele vira
`(server_id, steam_id, period)` — é o banco recusando dois direitos vivos para o
mesmo jogador, **no mesmo servidor**, no mesmo mês, em vez de o código lembrar de
conferir.

O `server_id` está ali porque o dono decidiu que **o passe vale só naquele
servidor** (17/09/2026), como o XP. E é uma diferença real em relação ao VIP,
apesar de o VIP ter sido a referência citada: a tabela `vips` **não** tem
`server_id`, e o serviço empurra o VIP para todos os servidores
(`core/src/vip/service.ts:442`). O passe não copia isso.

---

## 3. O problema que o molde do VIP NÃO resolve

**Comprar o mesmo mês duas vezes.**

A `reference` de uma compra é derivada do `purchaseId`, que é novo a cada
clique. Ela protege *aquela tentativa* de cobrar duas vezes; ela **não** impede
o jogador de comprar o mesmo produto de novo. O próprio repositório diz isso por
escrito (`core/src/db/store-repository.ts:816`).

O VIP não sofre com isso porque comprar de novo **soma prazo** sobre o
vencimento (`vips-repository.ts:478`). O passe do mês não tem o que somar: o mês
de outubro já é do jogador, e um segundo outubro não existe.

Então a regra precisa ser escrita, e ela tem um lugar certo:

> **A compra é recusada antes do débito**, com a frase "você já tem o passe
> deste mês".

Antes, e não dentro do `deliverPlan`. Lá dentro, "já tem" viraria exceção →
estorno → ruído de suporte para um caso que é normal. A `buy` já tem dois
precedentes de recusa sem cobrar — a compra em voo e o veículo sem espaço
(`service.ts:534` e `:510`) —; o passe é o terceiro.

A recusa é por `(servidor, jogador, mês)`. Comprar o passe de outubro no `pvp1`
**não** impede comprá-lo no `pvp2` — são duas trilhas, e é o comportamento
pretendido.

> **Em aberto:** e comprar o passe do mês **seguinte** antecipadamente? Comprar
> novembro em outubro passaria pela recusa acima. Isso é uma venda a mais e um
> pedido previsível — mas exige que a oferta diga de que mês ela é, e que a tela
> mostre isso. Recomendo **não** abrir na primeira versão: o produto vende "o
> passe do mês corrente", e o mês corrente é o que o plano congela.

---

## 4. O mês vem da COMPRA, nunca da entrega

Esta é a armadilha mais cara do documento, e ela só aparece quando o site cai.

Quando o débito volta **desconhecido** — timeout, 5xx, resposta ilegível —, a
compra fica aberta e ninguém entrega nada. Quem resolve é o reconciliador, que
roda a cada 60 s e tem teto de **6 horas** (`core/src/store/settle.ts:48`). Entre
a cobrança e a ativação podem passar horas.

Se essas horas atravessarem a meia-noite do dia 1, um passe pago em setembro
seria ativado como sendo de outubro — ou, pior, no dia 30 às 23h, ativado já
para um mês que acabou.

A saída já existe e é de graça: **o plano congelado**. `planOf`
(`core/src/store/service.ts:306`) existe justamente para gravar o que foi
prometido no instante da compra. O passe grava ali `period: "2026-09"`, e o
`deliverPlan` ativa **aquele** mês, não o mês de hoje.

Com uma consequência a dizer em voz alta: um passe comprado às 23h58 do dia 30 e
ativado às 00h05 do dia 1 é um passe **de setembro, que já acabou**. É o preço
honesto de cobrar por um mês nominal — e é o motivo de a tela de compra precisar
dizer quantos dias restam **antes** de cobrar (§7).

---

## 5. O que nasce, em ordem

Nove passos, na ordem em que as peças precisam existir. Os números de linha são
o lugar exato onde cada coisa entra.

### No catálogo — a oferta passa a existir

1. `OFFER_KINDS` ganha `'pass'` — `core/src/db/store-repository.ts:77`.
2. **Migração 101**: colunas `pass_*` em `store_offers`, no molde de
   `vip_tier`/`vip_days` (`migrations.ts:1193`; gravação em
   `store-repository.ts:585`, leitura em `toOffer` `:327`).
3. `storeOfferBody` ganha o campo e o ramo do `superRefine` —
   `core/src/http/routes/store.ts:227` e `:287`. Este schema é **um só** e o
   canal de config do site o importa (`core/src/site/appliers/store.ts:34`), então
   o formato novo vale nos dois caminhos de uma vez.
4. `panel/src/components/store-offer-dialog.tsx` — o formato novo no seletor.

### No plano — a compra promete

5. `DeliveryPlan` ganha `pass` (`core/src/store/service.ts:291`), `planOf` o
   preenche (`:306`) **e o zod `deliveryPlanSchema` o aceita** (`:358`).

   > Sem o passo do zod, `planFromJson` devolve `null` e **toda compra
   > reconciliada vira conferência humana**. O campo novo entra com
   > `.default()`, ou as compras em voo no momento do deploy viram
   > `PLAN_MISSING`.

### Na concessão — o direito nasce

6. Migração: `battlepass_entitlements`, com o índice único parcial do §2.
7. `core/src/battlepass/service.ts` — `grant({steamId, period, origin, sourceRef})`
   **idempotente por mês** e `activeOf(steamId, now)`.
8. Interface `PassGranter` em `core/src/store/service.ts` ao lado da `VipGranter`
   (`:139`), injetada em `core/src/index.ts`.
9. O ramo no `deliverPlan` — `core/src/store/service.ts:811`.

---

## 6. A compra pelo site

O dono pediu os dois canais. O de dentro do jogo está pronto depois dos nove
passos; o do site **precisa de acordo com o outro lado**.

A fila de entregas hoje conhece sete tipos: `item`, `kit`, `vip`, `vip_revoke`,
`vehicle`, `skin`, `skin_revoke` (`core/src/site/deliveries.ts:183`). O passe é o
oitavo, e ele não existe em nenhuma das duas pontas — nem aqui, nem lá.

O que fazer deste lado: `payloadSchemas.pass`, o `kind` no `DeliveredKind`
(`:283`) e no `planOfPayload` (`:329`).

E uma regra herdada, que já foi paga com dinheiro de jogador: **o passe pula o
portão de presença**, como o VIP (`deliveries.ts:673`). O comentário ao lado
conta o que aconteceu quando o VIP não pulava — o VIP comprado ficava parado,
invisível, até o jogador entrar; passando de 30 dias, o site devolvia ao
inventário um VIP que tinha sido pago. O direito do passe é uma linha de tabela:
ele não precisa do jogador online.

**As recompensas do passe são o contrário** — elas tocam o inventário, e aí a
presença vale, com os motivos adiáveis que já existem (`PLAYER_SLEEPING`,
`INVENTORY_FULL`, `DROP_FAILED`, em `deliveries.ts:106`). Direito e recompensa
viajam por caminhos diferentes, de propósito.

Pedir ao agente do site é um documento no molde do 24 e do 26 — o `Docs/37`. O
que ele precisa conter: o `kind` novo na fila, um tipo de produto do lado de lá,
e a régua do mês (§8).

---

## 7. O que a tela de compra precisa dizer

Não é enfeite; cada linha aqui evita uma reclamação previsível.

- **De que mês é o passe** — "Passe de outubro de 2026", não "Passe de Batalha".
- **De qual servidor ele é** — o passe vale só ali. Quem joga em dois servidores
  e compra no errado vai abrir suporte, e vai ter razão.
- **Quantos dias restam** — comprar no dia 30 é comprar um dia. Quem não vê isso
  antes de pagar vai abrir suporte, e vai ter razão.
- **O que o retroativo dá** — "resgate os 17 níveis que você já alcançou" é o
  principal argumento de venda do passe comprado tarde, e ele desaparece se
  ninguém disser. O número é do jogador que está olhando, não um genérico.
- **Que já tem** — quem comprou não vê um botão que vai recusar (§3).

A vitrine sai de graça: a tela da loja é **gerada do catálogo**, não escrita no
documento de UI. Dois ajustes pequenos: o passe entra na lista de formatos **sem
quantidade** (`core/src/game/ui-store-screens.ts:782`, junto de kit, VIP e
veículo), e o espelho manda o `kind` cru ao painel do site
(`catalog-mirror.ts:134`), que pode ainda não saber pintá-lo.

---

## 8. A régua do mês, e de quem ela é

O mês de calendário já está resolvido no projeto, em funções puras e testadas:
`isSeasonDue`, `nextSeasonTurnAt` e `periodLabel` — que já produz
*"Temporada de outubro de 2026"* — em `core/src/rankings/periods.ts` (`:168`,
`:250`, `:292`). O passe **reusa essas funções** em vez de escrever a terceira
aritmética de calendário do repositório.

O que ele **não** reusa é a tabela `stat_periods`: ela é por servidor e tem
`wipe_id`. O passe é mensal, e a régua dele é o calendário — não o wipe.

E a decisão que precisa estar escrita antes de o site entrar: **o fuso é o local
da máquina do agente** (`periods.ts:30`), a mesma régua do agendador de wipe. Se
o site calcular o mês em UTC, no dia 1 às 00h30 os dois discordam sobre qual
passe foi comprado. A régua fica de um lado só — deste — e o site recebe o
`period` já resolvido, como texto `YYYY-MM`.

---

## 9. As armadilhas, em uma lista

| O quê | Onde bate | O que fazer |
|---|---|---|
| Comprar o mesmo mês duas vezes | `buy` cobra e o `grant` não tem o que somar | recusar **antes do débito** (§3) |
| Site fora do ar, débito `unknown` | ativação atrasa até 6 h, ou nunca | mês vem do plano congelado (§4) |
| Campo novo fora do zod do plano | `planFromJson` → `null` → conferência humana | `.default()` no `deliveryPlanSchema` |
| Estorno de passe já resgatado | devolve o valor inteiro, o jogador fica com os itens | decidir: revoga o direito, ou não estorna depois do 1º resgate |
| Teto de OZ por compra | recusa antes de cobrar, default 100.000 | o preço do passe tem de caber |
| Escopo da `reference` | `buildReference` conta com escopo curto | usar `'loja'`; `'battlepass'` muda a conta do pior caso |
| Dois caminhos de ativação | duas entregas para uma cobrança | todo caminho novo passa por `StoreService.settle` |
| `Puts` no comando de console | rouba o lugar da resposta no `Reply` do RCON | não gritar marcador dentro do frame da resposta |

A última linha da tabela e a primeira são de naturezas diferentes: a primeira é
uma decisão de produto que ainda não foi tomada; a última é um fato do RCON que
já custou uma investigação neste repositório.

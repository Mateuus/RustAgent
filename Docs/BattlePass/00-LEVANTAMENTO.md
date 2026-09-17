# Passe de Batalha — levantamento

O que o dono pediu, o que o projeto já tem para atender, e o que precisa nascer.

Este documento é o **ponto de partida** da feature. Ele não decide como o código
fica — isso é dos documentos seguintes. Ele responde três coisas: *o que é o
passe*, *o que dele já existe em outra forma neste repositório* e *o que ainda é
pergunta*.

Levantado em **17/09/2026**, por seis frentes de medição rodando em paralelo
sobre a `main`.

---

## 1. O que o dono pediu

- Existe um **Passe de Batalha**. O jogador abre o painel do passe e vê a trilha
  do mês.
- **A progressão é por XP.** O jogador sobe de nível ganhando XP; cada nível tem
  recompensa.
- **O administrador decide o que dá XP** e quanto vale cada coisa. Missões são a
  fonte prioritária, mas há várias outras, e **cada fonte tem um teto diário**.
- A tela do passe **copia o menu de Skins** e se adapta. O padrão visual do menu
  é para ser mantido.
- Existe um **comando** que abre o passe, e na **home do menu** existe um **card
  "Battle Pass"**.
- Existe uma **configuração por servidor** que liga e desliga o passe inteiro, e
  chaves separadas para desligar a faixa grátis ou a paga.
- O passe pago **se compra com OzCoin na loja dentro do jogo**, como o VIP, e a
  compra **ativa o mês** na hora. Também é vendável **no site**.
- A compra é **daquele mês**, e quem compra no meio do mês tem direito de
  resgatar o que já passou.
- Cada nível é um **card com duas faixas**:

  ```text
             NÍVEL X
  [           GRÁTIS           ]
  ──────────────────────────────
  [            PAGO            ]
  ```

- O administrador **cria os passes com antecedência**: os meses 10, 11 e 12
  podem já estar prontos e programados.
- No painel nasce um item **Battle Pass** na barra lateral, com **várias abas**
  dentro.
- O desenho tem de ser **bom e fácil de usar**, com pesquisa de referência em
  jogos que já têm passe.

### 1.1 As decisões de 17/09/2026

| Pergunta | Decisão |
|---|---|
| Como o jogador destrava o nível? | **Por XP.** Alcançou o nível, a recompensa abre. |
| A faixa grátis exige jogar X minutos por dia? | **Não.** O XP já exige jogar; um segundo requisito em cima disso é punição dupla. |
| O que dá XP? | **O admin decide**, a partir do que o agente sabe medir. **Missões são a prioridade.** |
| Teto de XP? | **Por fonte, diário.** "Farm teto de 100 XP por dia, caçar teto de 100 XP por dia." |
| O que pode ser recompensa? | **Item do jogo, kit, skin do Workshop e OzCoin.** |
| A temporada fecha como? | **Mês do calendário.** Dia 1 abre, último dia do mês fecha. |
| Onde se compra o passe pago? | **Loja in-game e site.** Os dois canais. |

E duas exigências que vieram junto e valem como requisito:

1. **Resgate em lote com proteção de inventário cheio.** Quem compra no nível 17
   pede 17 recompensas de uma vez. Nada pode sumir nesse caminho.
2. **A faixa grátis vale igual para todo mundo** — inclusive para quem comprou.
   A grátis se ganha jogando; a paga se compra.

> **A virada do dia 17.** A primeira versão deste levantamento tinha a trilha por
> **dia de calendário**, com a faixa grátis exigindo minutos jogados. O dono
> corrigiu no meio do trabalho: *"o passe de batalha ele é por XP"*. O que
> sobreviveu inteiro: a temporada é o mês, as duas faixas, o retroativo da
> compra, o teto por fonte e a proteção de inventário. O que caiu: a trilha por
> dia, o requisito de presença e a necessidade de medir minutos por dia — que
> **não existe** no projeto e teria de ser construída.

### 1.2 O que ainda é pergunta

As três que bloqueavam o trabalho foram **respondidas pelo dono em 17/09/2026**:

| Pergunta | Resposta |
|---|---|
| O XP é da conta ou por servidor? | **Por servidor.** Cada servidor tem a sua trilha — [02](02-O-PASSE-DO-JOGADOR.md) §5.1 |
| A tela nasce no agente ou no plugin? | **No plugin**, como o menu de skins — [03](03-MENU-DO-PASSE.md) §1 |
| O não resgatado na virada? | **Entregue no próximo login**, e visível numa **caixa** com aviso — [01](01-A-TEMPORADA-E-AS-REGRAS.md) §7 |
| O direito comprado vale na rede? | **Não. Só naquele servidor** — [02](02-O-PASSE-DO-JOGADOR.md) §5.1 |
| Skin de DLC pode ser recompensa? | **Pode, e só quem tem a DLC usa** — [03](03-MENU-DO-PASSE.md) §9 |

O que continua aberto:

1. **O estorno de um passe já usado.** O estorno devolve o valor inteiro. Revoga
   o direito? E o que já foi resgatado?
2. **Vender o passe do mês seguinte antecipadamente?** Recomendo não abrir na
   primeira versão.
3. **Consultar posse de DLC funciona do lado do servidor?** É uma sonda de
   plugin descartável, e ela vem antes da primeira skin de DLC numa trilha.

---

## 2. O que o projeto dá — medido, não suposto

### 2.1 O XP: existe matéria-prima, mas não existe evento

**O agente não recebe um aviso quando alguém mata ou coleta.** Ele recebe, a
cada 60 s, um **delta acumulado por jogador e por métrica**. Chega
`{"pvp.kills": 3}`, não chegam três mortes: perde-se o instante, a ordem e a
identidade — e, sobretudo, **não há identificador** para dizer "este kill já
rendeu XP".

Só três coisas chegam como evento de verdade: **conclusão de missão**, conversão
de item custom e o recorde de tiro longo. É o que torna a decisão do dono de
priorizar missões mais que preferência de produto.

**De graça hoje**, sem escrever C#: `pvp.*`, `pve.*`, `env.deaths`, `suicides`,
`team.*`, `sleeper.*`, `trap.*`, `ore.*` (total, sulfur, metal, stone, hqm),
`explosive.seq`, `gather.<shortname>`.

**Não existe**: saquear caixa por jogador, matar animal/heli/Bradley, craft
genérico, headshot, distância, construir, raid. `ore.*` não conta quarry.

### 2.2 A compra já está construída

A loja do jogo não sabe preço nem entrega nada: o plugin manda `offerId` e
`steamId`, e quem cobra e entrega é o agente. O passe não precisa de caminho
próprio de compra — precisa de um `kind` novo no catálogo e de um ramo em
`deliverPlan`, que é **o único ponto por onde a compra in-game e a fila do site
passam**.

O molde da assinatura com prazo é o **VIP**, inclusive a trava de banco
(`idx_vips_active`, um índice único parcial) que impede dois direitos vivos.

### 2.3 As telas nascem no agente

`OrigemZUI` não desenha: o agente manda a tela pronta como lista de `CuiElement`.
Há um kit de widgets completo (`ui-widgets.ts`), uma régua de custo (~390 bytes
por elemento, frame de 50.000) e um molde de tela quase idêntico ao que o passe
precisa (`ui-quests-screen.ts`). O menu de skins é a exceção — feito em C#, com
ScrollView.

### 2.4 O inventário cheio: hoje o item cai no chão

A proteção que existe é **derramamento controlado** (`GIVE_MODE = 'auto'`): nada
some, mas 17 recompensas com a mochila cheia viram uma pilha de sacolas no chão.
A proteção que o dono quer — **não derramar** — já está escrita numa branch
paralela (`resgate-com-inventario-cheio`), com a regra certa: *não saber nunca
vira "cabe"*.

### 2.5 O limite legal, e como o passe fica dentro dele

Desde 07/08/2025 as diretrizes da Facepunch proíbem **conceder DLC a quem não
comprou** e **burlar a checagem de posse**, sob pena de delistagem do servidor.

A decisão do dono mantém o passe do lado certo: **skin de DLC entra na trilha, e
só quem tem a DLC a usa.** A checagem é respeitada, não contornada — que é o que
a regra pede. Falta medir se ela é consultável no servidor, e marcar no cadastro
quais skins são DLC.

---

## 3. O molde que esta feature segue

O projeto tem um jeito de fazer feature, e ele está inteiro no OrigemZWorkshop:

| Camada | O molde |
|---|---|
| contrato | `core/src/types/workshop.ts` — Zod, e os payloads de console marcados como protocolo |
| banco | migração numerada **na reserva**, repositório com Zod dentro, auditoria sem FK |
| regras | `workshop-catalog.ts` — **porta única**: painel, jogo e site entram por ela |
| carga | segredo por processo, base64, pedaços, dedup por digital, debounce |
| rotas | `http/routes/workshop.ts`, dentro do escopo autenticado |
| tela | `core/src/game/ui-*-screen.ts`, com widgets prontos |
| painel | `normalize.ts` obrigatório, tipos copiados à mão, abas em estado local |
| entrega | por PR único, de uma branch de integração |

E o padrão de documentação é esta pasta: `00` levantamento, `01`..`05`
especificações, `06` o plano das frentes.

---

## 4. As camadas a criar

| # | Camada | Onde |
|---|---|---|
| 1 | contrato e tipos | `core/src/types/battlepass.ts` |
| 2 | **migração 101** | `core/src/db/migrations.ts` — 10 tabelas |
| 3 | repositórios | `core/src/db/battlepass-repository.ts` |
| 4 | regras (porta única) | `core/src/battlepass/service.ts` |
| 5 | o XP de ação | dentro da transação do lote, em `rankings/collector.ts` |
| 6 | o XP de missão | novo `kind: 'xp'` em `QuestReward` |
| 7 | recompensa de skin | novo `kind: 'skin'` em `QuestReward` |
| 8 | compra | `kind: 'pass'` no catálogo + ramo em `deliverPlan` |
| 9 | rotas | `core/src/http/routes/battlepass.ts` |
| 10 | **tela e caixa** | `Plugins/OrigemZBattlePass.cs` — plugin novo, molde do Workshop |
| 11 | card na home | `core/src/game/ui-home-screen.ts` |
| 12 | painel | `panel/src/app/battlepass/` + sidebar + `normalize.ts` |
| 13 | venda pelo site | acordo novo com o agente do site — um `Docs/37` |

A **13** é a única que depende de terceiro, e por isso não entra no caminho
crítico.

---

## 5. Onde está cada coisa

| Documento | O que responde |
|---|---|
| [01 — A temporada, o XP e as regras](01-A-TEMPORADA-E-AS-REGRAS.md) | o modelo de domínio: temporada, níveis, XP, teto, estados de resgate, o que liga e desliga |
| [02 — O passe do jogador](02-O-PASSE-DO-JOGADOR.md) | o agente: de onde vem o XP, as tabelas, o resgate em lote, o inventário cheio |
| [03 — O menu do passe](03-MENU-DO-PASSE.md) | a tela no CUI: onde nasce, o desenho, o orçamento de bytes, o card na home |
| [04 — A compra](04-A-COMPRA.md) | loja in-game e site: os nove passos, e as quatro coisas que dão errado em silêncio |
| [05 — O painel](05-O-PAINEL.md) | a seção na barra lateral e as sete abas |
| [06 — Plano e frentes](06-PLANO-E-FRENTES.md) | como dividir isto entre agentes sem que um pise no outro |

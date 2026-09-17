# Passe de Batalha — o XP, o progresso e o resgate

O lado do agente: de onde vem o XP, onde ele é guardado, como o jogador sobe de
nível e como a recompensa sai dali até a mochila dele.

Medido em 17/09/2026 contra a `main`. O que não foi medido está marcado.

---

## 1. O fato que manda em tudo: não existe evento de "matou" nem de "farmou"

Esta é a descoberta que decide a arquitetura, e ela contraria a intuição.

O agente **não recebe um aviso quando alguém mata ou coleta**. O que ele recebe,
a cada **60 segundos**, é um **delta acumulado por jogador e por métrica**: o
plugin soma num buffer em memória, o agente pede `origemz.stats.flush`, o plugin
congela o buffer e entrega. Chega `{"pvp.kills": 3}` — **não** chegam três
mortes.

O que isso significa para o passe:

- **perde-se o instante, a ordem e a identidade** de cada acontecimento;
- a latência do XP por ação é de **até 60 s** (média 30 s);
- e, o mais importante: **o delta não tem identificador**. Não há `eventId` para
  dizer "este kill já rendeu XP".

Só três coisas chegam como evento de verdade, com identificador e idempotência:
conclusão/resgate de **missão**, conversão de **item custom**, e o recorde de
tiro longo.

> É por isso que a decisão do dono de **priorizar as missões** como fonte de XP
> não é só preferência de produto: missão é a única fonte que já nasce discreta,
> auditável e idempotente. As outras são torneiras lidas por amostragem.

### 1.1 A consequência: onde o XP é calculado

Como o delta não tem identificador, a proteção contra contar duas vezes é
**outra**: o lote tem um `batchId`, e `applyBatch` devolve `applied: false`
quando aquele lote já entrou (`core/src/db/rankings-repository.ts:1209`).

Daí a regra:

> **O XP de ação é calculado dentro da mesma transação que aplica o lote**, ao
> lado de onde o `time.played` já é costurado (`core/src/rankings/collector.ts:499`).

Calcular depois, lendo `player_stats` por fora, é o caminho que parece mais
simples e é o que duplica: uma rodada repetida, ou um recálculo, dobra o XP sem
nada acusar.

---

## 2. O cardápio de fontes de XP

O dono decidiu que **o admin administra o que dá XP**. O código não traz uma
lista fixa — traz o cardápio do que o agente sabe medir, e o admin liga, desliga
e precifica cada item.

### 2.1 O que já existe, de graça

Sem escrever uma linha de C#, só somando do delta que já chega:

| Grupo | Chaves literais |
|---|---|
| PvP | `pvp.kills`, `pvp.deaths` |
| PvE | `pve.kills`, `pve.deaths` |
| Morte | `env.deaths`, `suicides` |
| Fora do K/D | `team.kills`, `team.deaths`, `sleeper.kills`, `sleeper.deaths`, `trap.kills`, `trap.deaths` |
| Minério | `ore.total`, `ore.sulfur`, `ore.metal`, `ore.stone`, `ore.hqm` |
| Craft | `explosive.seq` |
| Coleta nomeada | `gather.<shortname>` — ver a armadilha em §2.3 |

E como **evento**: conclusão de missão, e conversão de item custom.

### 2.2 O que o cardápio NÃO tem

Vale escrever, porque são exatamente as coisas que alguém vai pedir:

- **saquear caixa** por jogador — o hook existe, mas só alimenta missões;
- **matar animal, helicóptero, Bradley ou o cientista da geração nova** —
  `pve.kills` só conta quem herda de `BasePlayer`. Lobo e urso **não contam**;
- **craft genérico**, **headshot**, **distância percorrida**, **construir**,
  **raid** — nenhum existe como métrica;
- **`ore.*` não conta quarry.**

Cada um desses é trabalho de C# novo no `OrigemZAgent`. Nenhum é impossível;
nenhum é de graça.

### 2.3 Duas armadilhas do cardápio

**`gather.<shortname>` depende de um ranking ligado.** O plugin só vigia os
shortnames que o agente mandar, e essa lista sai dos **rankings habilitados**
(`core/src/rankings/plugin-metrics.ts:140`). Se o XP de farm usar `gather.wood`,
ele morre em silêncio no dia em que o admin desligar o ranking "Madeira". Teto
de 32 shortnames.

> **Decisão recomendada:** o passe **não** se apoia em `gather.*` na primeira
> versão. Use `ore.*`, que não depende de ranking nenhum. Se o farm de madeira
> precisar valer XP, a saída certa é o passe declarar a sua própria lista de
> vigia — não pegar carona na do ranking.

**`sleeper.kills` é farm, não PvP.** A matriz de morte do plugin separa
`sleeper.*`, `team.*` e `trap.*` justamente para ficarem **fora** do K/D. Dar XP
por matar dorminhoco é pagar quem anda de machado por base vazia. O cardápio
oferece; a configuração padrão **não liga**.

---

## 3. O teto diário por fonte

> *"Cada forma vai ter um teto por dia. Exemplo: farm teto de 100 XP por dia,
> caçar teto de 100 XP por dia."* — o dono, 17/09/2026.

Uma regra de XP é `{ fonte, ligada, valor, tetoDiário }`. O teto é **por
fonte**, não um teto único somando tudo — é o que permite deixar a missão
generosa e o farm contido sem escolher entre as duas coisas.

Isso exige um acumulador por **(jogador, temporada, fonte, dia)**. É uma tabela
pequena e de escrita frequente, e é o preço do teto.

A virada do dia **não é inventada aqui**: o projeto já decidiu isso uma vez,
para as missões diárias, com `reset_at_minute` e uma aritmética que conta **dias
de calendário e não 24 horas** (`core/src/quests/service.ts:2140`). O passe reusa
essa régua. Um segundo relógio de virada no mesmo repositório é dívida garantida.

**XP que estoura o teto não é guardado para amanhã.** Ele simplesmente não
acontece. Guardar seria uma segunda contabilidade, e transformaria o teto numa
fila — que é exatamente o que ele existe para evitar.

---

## 4. Onde o XP mora — e onde ele não pode morar

### 4.1 `player_stats` está fora de questão

Parece o lugar óbvio e é uma armadilha, por três motivos com linha:

1. **O painel tem um botão que zera métricas** (`rankings-repository.ts:1851`,
   rota em `http/routes/rankings.ts:787`). Um admin corrigindo um ranking
   apagaria níveis já comprados.
2. **A linha é por período de ranking**, e o período `season` fecha pela régua
   do ranking — que é configurável e pode ser `wipe`. A temporada do passe é o
   mês, e as duas viradas não coincidem.
3. `value` só cresce por soma: não guarda nível, nem o que já foi gasto.

O passe precisa de **acumulador próprio**, com a temporada dele como janela.

### 4.2 O que se reusa

| Peça | Onde | Por quê |
|---|---|---|
| o canal e o relógio de 60 s | `core/src/rankings/collector.ts:436` | lote congelado, paginação, `ack` pós-commit, idempotência por `batchId`, tudo em produção |
| o ponto de costura | `collector.ts:499` | é onde o `time.played` já é pendurado, dentro da transação |
| `applyEvent` para XP **concedido** | `rankings-repository.ts:1302` | idempotência por `eventId` |
| o molde do `eventId` | `core/src/quests/rewards.ts:527` | `"<escopo>:<quest>:<tentativa>:<posição>"` — chave estável que faz o retry cair no `INSERT OR IGNORE` |
| a aritmética de mês | `core/src/rankings/periods.ts` | `periodLabel` já produz *"Temporada de outubro de 2026"* |

---

## 5. As tabelas

**Migração 101.** A `main` está na 100, e o maior id entre todas as branches
vivas também é 100 — conferido em 17/09/2026. A regra do projeto está escrita em
`migrations.ts:9060`: *"pular numero nao custa nada; REPETIR um custa caro: no
merge, a migracao que chegasse depois seria PULADA em silencio"*.

```text
battlepass_seasons        a temporada: período 'YYYY-MM', nome, nº de níveis,
                          curva de XP, estado (draft/scheduled/active/closed)

battlepass_season_servers junção (season_id, server_id) — em quais servidores
                          aquela temporada vale

battlepass_rewards        (season_id, level, lane) -> a recompensa
                          lane = 'free' | 'paid'

battlepass_xp_rules       (season_id, source) -> ligada, valor, teto diário

battlepass_progress       (server_id, steam_id, season_id) -> xp, level
                          o acumulador. NÃO é player_stats.

battlepass_xp_daily       (server_id, steam_id, season_id, source, local_day)
                          só existe para o teto do §3

battlepass_entitlements   (server_id, steam_id, period) -> quem comprou o mês
                          UNIQUE parcial WHERE revoked_at IS NULL

battlepass_claims         (server_id, steam_id, season_id, level, lane)
                          o estado da entrega, e a recompensa congelada

battlepass_pending        o que foi prometido e ainda não chegou — a caixa
                          (§6.4). Dedupe por (claim, posição).

battlepass_audit          quem mexeu em quê. SEM chave estrangeira.
```

Cinco decisões de schema que vale justificar:

1. **O índice único parcial dos entitlements** é cópia do
   `idx_vips_active` (`migrations.ts:929`): é o banco recusando dois direitos
   vivos para o mesmo jogador no mesmo mês, em vez de o código lembrar de
   conferir.
2. **`battlepass_audit` não tem FK**, pelo mesmo motivo que
   `workshop_audit` não tem: *"apaguei a temporada de setembro"* precisa
   sobreviver à temporada de setembro.
3. **A recompensa guarda um `QuestReward` inteiro**, não colunas por tipo — é o
   contrato que missões e KOTH já usam, e que o `RewardList` do painel já edita.
4. **A trilha é congelada no resgate.** Quando o jogador leva o nível 3, o que
   ele levou vai gravado na linha de `battlepass_claims`. É o mesmo princípio do
   `player_quests.snapshot` (`quests-repository.ts:29`): editar a trilha no dia
   20 não pode mudar o que o nível 3 prometia.
5. **Booleano é `INTEGER 0/1` com CHECK**, epoch em ms, comentário de SQL em
   ASCII sem acento e sem crase — o SQL mora num template literal.

### 5.1 O catálogo é da rede; o XP é por servidor

**Decisão do dono, 17/09/2026: o XP é por servidor.**

O catálogo — temporada, trilha, regras de XP — é **global**, como o catálogo de
skins, com uma junção dizendo em que servidores vale. O admin cria "outubro de
2026" uma vez, e escolhe onde ela roda.

O **progresso** é por servidor. `battlepass_progress` e `battlepass_xp_daily`
têm `server_id` na chave, e é isso que faz o XP casar com a fonte dele: as
estatísticas nascem por servidor, e agora não há tradução no meio.

O que isso significa na prática, e precisa estar visível na tela: **o jogador
tem uma trilha em cada servidor.** Matar alguém no `pvp1` não adianta nível no
`pvp2`. A tela do passe é sempre a do servidor em que ele está, e o cabeçalho
diz de qual servidor ela é — senão a primeira reclamação será "meu nível sumiu".

**O direito comprado também é por servidor** — decisão do dono, 17/09/2026:
*"o passe só vale naquele servidor"*. `battlepass_entitlements` tem `server_id`
na chave, e o índice único parcial é `(server_id, steam_id, period)`.

Assim a trilha é uma coisa só: um lugar onde o XP, o nível e o direito
concordam. Comprar o passe no `pvp1` não destrava a faixa paga no `pvp2`, pela
mesma razão que matar no `pvp1` não dá nível no `pvp2`.

E a tela de compra precisa dizer **de qual servidor** é o passe que está sendo
vendido. É o tipo de coisa que parece óbvia para quem construiu e não é para
quem paga.

> **Uma divergência a registrar, porque o dono a citou como referência.** O
> dono disse que o passe segue o VIP, *"o VIP é só daquele servidor"*. **O VIP
> hoje não é.** A tabela `vips` não tem `server_id` (`migrations.ts:886`) e o
> serviço empurra o estado para **todos** os servidores —
> `for (const serverId of this.#deps.servers.ids())` em
> `core/src/vip/service.ts:442`.
>
> O que cria a impressão de "por servidor" é outra coisa: o VIP só se aplica
> onde o **nível existe**, porque os grupos saem do `OrigemZVip.json` **daquele**
> servidor (`#levelsOf`). Um servidor que não declara "ouro" não tem VIP ouro —
> mas um que declara, tem, sem ninguém ter concedido ali.
>
> Isto **não muda o passe**: ele nasce por servidor, como pedido. Fica anotado
> porque é um comportamento do VIP que provavelmente surpreende, e que não é
> deste trabalho corrigir.

---

## 6. O resgate

### 6.1 A ordem das operações não é livre

O projeto já tem as duas ordens, cada uma num lugar, e o motivo de serem
diferentes importa:

- **Missão**: marca `claimed`, comita, **e só então entrega**
  (`quests-repository.ts:1136`). O inverso dá jogador que recebe duas vezes numa
  queda.
- **Loja**: entrega e só então marca — porque lá o jogador **pagou**, e na dúvida
  preserva-se o dinheiro dele.

O passe tem as duas naturezas, e por isso segue as duas regras:

| Faixa | Ordem | Porquê |
|---|---|---|
| grátis | marca antes | não houve pagamento; o risco é entregar duas vezes |
| paga | preserva o direito | houve pagamento; o risco é o jogador perder o que comprou |

### 6.2 O inventário cheio — o que existe hoje e o que falta

O dono exigiu proteção. O estado atual do projeto, medido:

**Hoje, o item cai no chão.** A constante é `GIVE_MODE = 'auto'`
(`core/src/store/service.ts:120`), e o comentário ao lado explica: com o modo
`inventory`, quem estivesse de mochila cheia receberia `INVENTORY_FULL` e *"o
item comprado sumiria"*. O plugin insere o que cabe e larga o resto aos pés
(`Plugins/OrigemZAgent.cs:2703`).

Ou seja: **a proteção que existe é derramamento controlado.** Nada some — mas 17
recompensas resgatadas de uma vez com a mochila cheia viram uma pilha de sacolas
no chão, numa base com gente em volta.

Se "proteção" significa **não derramar** — e é o que o dono quis dizer —, faltam
duas peças, e uma delas **já está pronta em outra branch**:

1. **Perguntar antes.** A branch `resgate-com-inventario-cheio` já criou
   `core/src/quests/inventory-room.ts`, que pergunta ao plugin
   (`origemz.give.check`) se os itens cabem, somando pilhas existentes, limite de
   pilha e slots livres. A regra que ela estabeleceu — *"não saber (RCON fora,
   plugin velho, jogador morto) nunca vira 'cabe'"* — é a regra certa. **O passe
   reusa esse arquivo**; ele não é do módulo de missões por acaso de nome.
2. **Pendência por posição.** O lote não é atômico: cabendo 6 de 17, entregam-se
   as 6 e as 11 continuam devendo. O molde é `koth_deliveries`, com dedupe por
   `(run, jogador, posição)` e `alreadyPaid` contando **só os sucessos** — de
   modo que `INVENTORY_FULL` possa sair de novo.

E duas coisas que o agente já sabe e hoje **joga fora**:

- o plugin responde quanto caiu no chão (`delivered: 'inventory'|'drop'|'mixed'`,
  `given`, `dropped`), e `deliverPlan` só testa se deu erro
  (`store/service.ts:782`). **Ninguém lê o `dropped`.** É o gancho pronto;
- há teto de **100 pilhas por chamada** (`TOO_MANY_STACKS`). Uma recompensa de
  10.000 flechas passa; uma de 200 AKs não.

### 6.3 Uma falha não derruba as outras

`core/src/quests/rewards.ts:20` já estabelece isto e o passe herda: as
recompensas são tentadas **uma a uma**, com resultado separado. O item falha por
espaço, os 500 OZCoin da mesma linha são creditados.

Para 17 recompensas em lote, é a diferença entre *"faltou espaço para a AK"* e
*"não recebi nada"*.

E o retry é **por posição**, com o índice compondo a referência da carteira
(`rewards.ts:260`). Renumerar quebraria a proteção contra pagar duas vezes
exatamente no caminho do retry.

### 6.4 A caixa: onde a promessa fica visível

O dono pediu, em 17/09/2026, um **ícone de caixa no menu do passe, com tooltip
do que não foi recebido e um ponto de notificação** enquanto o jogador não
olhar. A tabela `battlepass_pending` é o que alimenta esse ícone.

Ela guarda **duas origens de pendência**, e elas precisam ficar distinguíveis:

1. **não coube na mochila** — o jogador resgatou e a entrega ficou devendo;
2. **sobrou da temporada anterior** — o dono decidiu que o não resgatado **é
   entregue no próximo login**, e não confiscado (ver
   [01](01-A-TEMPORADA-E-AS-REGRAS.md) §7).

A segunda é a que justifica o pedido. Uma entrega silenciosa no login seria um
punhado de itens aparecendo do nada, sem nada explicando de onde vieram — e o
jogador que não estivesse olhando a mochila naquele segundo nunca saberia.

Três regras da caixa:

- **o ponto de notificação some quando ele abre a caixa**, não quando recebe os
  itens. *Ter pendência* e *saber que tem* são coisas diferentes;
- **a pendência não tem prazo.** Ela já é o resultado de uma promessa feita; um
  segundo prazo em cima dela seria confiscar duas vezes;
- **a entrega da caixa passa pelo mesmo caminho do resgate** — inclusive a
  pergunta de espaço. Não adianta trocar "some na mochila cheia" por "some ao
  sair da caixa".

---

## 7. A skin como recompensa

O dono quer skin do Workshop entre as recompensas. Hoje `QuestReward` tem cinco
tipos — `item`, `coins`, `kit`, `points`, `vip` — e **`skin` não é um deles**.

O caminho de entregar skin existe (a fila do site tem `skin` e `skin_revoke`),
e a posse tem prazo e renovação resolvidos em `workshop-owned-repository.ts`.

**A recomendação é criar `kind: 'skin'` no contrato compartilhado**, não um tipo
só do passe. O argumento está escrito no próprio editor de recompensas
(`panel/src/components/rewards/reward-list.tsx:6`): duas telas para a mesma
pergunta divergiriam no primeiro tipo novo, e *"a que ficasse para trás
ofereceria menos, sem avisar ninguém"*. Missões e KOTH ganham de graça.

### 7.1 A skin de DLC: só para quem tem a DLC

Decisão do dono, 17/09/2026: **skin de DLC pode entrar na trilha, e só quem tem
a DLC vai poder usá-la.**

É a leitura correta da regra da Facepunch. O que as diretrizes proíbem é
*conceder acesso* a quem não comprou e *burlar a checagem de posse* — não é dar
uma recompensa cuja posse continua sendo verificada. Respeitar a checagem é
exatamente o que elas pedem.

O que isso exige do código, e o que ainda não se sabe:

- **a trilha precisa saber quais skins são DLC.** Hoje o catálogo do Workshop
  não distingue arte nossa de item da Facepunch. É uma marca nova no cadastro da
  skin, e ela **não pode ser opcional** — sem ela, ninguém sabe o que verificar;
- **o jogador sem a DLC precisa ver a recompensa e entender por que não a leva.**
  O `deadButton` do projeto existe para isso: um botão que não é botão e **diz o
  motivo**. Esconder seria pior — o jogador acharia que o passe engoliu o prêmio;
- **o que acontece com o nível dele.** O nível foi alcançado; a recompensa é que
  não se aplica. Recomendo que o nível **conte como resgatado**, e não fique
  eternamente em aberto numa trilha que ele nunca vai fechar.

> **PENDENTE — a medição que falta.**
> `PlayerBlueprints.CheckSkinOwnership(int skinItemId, BasePlayer player)` existe
> e recebe um `BasePlayer`, então **parece** consultável do lado do servidor
> (`Docs/OrigemZWorkshop/00-LEVANTAMENTO.md` §2.4). Mas o que aquela seção mediu
> foi o caminho oposto — *liberar* skins, que é developer-only. **Ninguém testou
> consultar a posse.** Isso é uma sonda de plugin descartável, e ela vem **antes**
> de a primeira skin de DLC entrar numa trilha.
>
> Se a consulta não funcionar, a regra volta a ser a conservadora: só skin nossa
> do Workshop. Ver [03](03-MENU-DO-PASSE.md) §9.

---

## 8. Como o plugin e o agente conversam

Não há HTTP entre eles. O canal é o console do RCON, e o contrato tem quatro
regras que já custaram investigação neste repositório:

1. **Base64 obrigatório** — o parser de console do Rust come as aspas do JSON.
2. **Segredo por subida** em todo marcador novo. Sem isso, o jogador digita o XP
   dele no chat: o `onConsoleLine` recebe o chat junto com o resto.
3. **Nenhum `Puts` no frame do comando** — ele entra na resposta casada do RCON e
   a quebra. O Workshop adia o push em 0,1 s por causa disso.
4. **Nenhum comando de RCON de dentro do gancho de console** — laço garantido.
   Tudo por relógio.

---

## 9. As armadilhas, em uma lista

| O quê | Consequência |
|---|---|
| calcular XP lendo `player_stats` por fora da transação | rodada repetida dobra o XP, sem nada acusar |
| usar `player_stats` como saldo | o botão de reset do painel apaga níveis comprados |
| apoiar XP de farm em `gather.*` | admin desliga o ranking e o XP morre em silêncio |
| dar XP por `sleeper.kills` | paga quem anda de machado por base vazia |
| usar `time.played` para XP por tempo | só cresce quando a sessão fecha; quem está online há 3 h tem o número de ontem |
| agente reiniciado | a marca-d'água do tempo vive em memória: a 1ª rodada após o boot soma zero, de propósito |
| plugin não carregado | a rodada é pulada com `not-loaded` — e **"sem dados" não é "zero"** |
| agente fora por muito tempo | o buffer do plugin tem teto de 5.000 jogadores; o jogador novo fica de fora |
| marcador novo sem segredo | forja pelo chat |
| id de migração repetido | no merge, a migração vira **pulada em silêncio** |
| renumerar posição de recompensa no retry | quebra o dedupe de pagamento |

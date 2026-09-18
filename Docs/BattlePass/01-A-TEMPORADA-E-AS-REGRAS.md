# Passe de Batalha — a temporada, o XP e as regras

O modelo de domínio. O que é uma temporada, como o jogador sobe de nível, e
quando uma recompensa pode ser levada.

Este documento não fala de tabela, de rota nem de tela. Ele existe para que as
três coisas concordem sobre o mesmo significado — e para que a resposta a
"posso resgatar isto?" seja **uma função**, escrita uma vez, e não três
opiniões espalhadas pelo agente, pelo plugin e pelo painel.

> **Revisão de 17/09/2026.** A primeira versão deste documento tinha a trilha
> por **dia de calendário**. O dono corrigiu no meio do levantamento: *"o passe
> de batalha ele é por XP"*. A trilha passou a ser de **níveis**, e o requisito
> de "jogar X minutos por dia" da faixa grátis **caiu** — o XP já exige jogar.
> O que sobreviveu inteiro: a temporada é o mês, as duas faixas, o retroativo
> da compra e a proteção de inventário cheio.

---

## 1. A temporada é o mês

A temporada é o **mês do calendário**. Ela abre no dia 1 e fecha no fim do
último dia do mês.

1. **A temporada é identificada por ano e mês**, nunca por "a atual". `2026-10`
   é um nome estável; "a atual" muda de significado à meia-noite do dia 1 e
   transformaria qualquer registro histórico em mentira.
2. **O fuso é o do servidor.** O agente já tem um; o passe usa o mesmo, e não o
   do jogador. Dois relógios dariam dois "dia 1" diferentes na mesma tela.
3. **O XP zera na virada.** Cada temporada começa do zero para todo mundo. XP
   que atravessasse o mês faria o veterano nascer no nível 40 e a trilha perder
   a graça no segundo mês.
4. **A trilha é de cada servidor.** Decisão do dono, 17/09/2026: o admin monta a
   temporada uma vez para a rede, mas **o XP e o nível são por servidor**. Quem
   joga no `pvp1` e no `pvp2` tem duas trilhas. É o que faz o XP casar com a
   fonte dele — as estatísticas já nascem por servidor. A tela precisa dizer de
   qual servidor é a trilha que está mostrando, senão a primeira reclamação será
   *"meu nível sumiu"*.

### 1.1 Criada com antecedência

O dono pediu que os passes dos meses 10, 11 e 12 possam já estar criados e
programados. Então uma temporada tem um **estado**, derivado da data mais uma
escolha:

| Estado | Quando | O que o jogador vê |
|---|---|---|
| `draft` | o admin ainda está montando | nada |
| `scheduled` | pronta e publicada, mas o mês não chegou | nada |
| `active` | é o mês corrente e a temporada está publicada | a trilha |
| `closed` | o mês passou | nada, ou só o histórico |

Publicar é **botão**, não efeito do calendário: uma temporada esquecida em
`draft` no dia 1 não deve entrar no ar meio montada. E **só uma fica `active`
por vez**, por servidor — duas seriam duas trilhas na mesma tela sem nada que
diga qual vale.

---

## 2. A trilha é de níveis

A temporada tem **N níveis** (quantos o admin quiser). Cada nível tem duas
recompensas independentes — uma grátis e uma paga —, que é o card que o dono
desenhou:

```text
            NÍVEL 17
   ████████████░░░░░  2.400 / 3.000 XP
 [           GRÁTIS           ]
 ───────────────────────────────
 [            PAGO            ]
```

O jogador sobe de nível acumulando **XP**. O XP exigido por nível é uma curva
que o admin configura — nem que seja "todo nível custa 1.000".

Duas regras que precisam estar escritas antes de virar código:

1. **O nível nunca desce.** XP é acumulado da temporada; nada o subtrai. Um
   estorno de compra não rebaixa ninguém.
2. **Passar do último nível não é erro.** Quem termina a trilha continua
   ganhando XP e o excedente simplesmente não compra nada. A tela diz
   "trilha concluída" em vez de fingir um nível 41 que não existe.

---

## 3. O XP: o admin decide o que dá, e quanto

> *"O que vai dar XP o administrador vai administrar isso."* — o dono,
> 17/09/2026.

O passe **não tem uma lista fixa de fontes de XP escrita no código**. Ele tem
um cardápio do que o agente sabe medir, e o admin liga, desliga e precifica cada
item no painel.

Uma **regra de XP** é:

| Campo | O que é |
|---|---|
| fonte | o que aconteceu (completar missão, matar jogador, farmar, caçar…) |
| ligada | se vale nesta temporada |
| valor | quanto XP rende cada ocorrência |
| **teto diário** | o máximo de XP que **essa fonte** rende por dia |

O teto é **por fonte**, e foi pedido assim com exemplo: *"farm teto de 100 XP
por dia, caçar teto de 100 XP por dia"*. Não é um teto único somando tudo —
cada fonte tem o seu, e é justamente isso que permite ao admin deixar a missão
generosa e o farm contido sem escolher entre uma coisa e outra.

**As missões são a fonte prioritária.** É a decisão do dono, e ela tem
consequência de desenho: a missão é a única fonte que já nasce discreta ("esta
missão, uma vez, vale 800 XP"), enquanto matar e farmar são torneiras que
precisam de teto para não virar moedor.

### 3.1 O teto precisa de um "dia", e ele já tem dono

"100 XP por dia" exige saber quando o dia vira. O projeto **já decidiu isso uma
vez**: as missões diárias usam `reset_at_minute`, e a aritmética conta **dias de
calendário, e não 24 horas** — de propósito, com o horário de verão explicado no
comentário (`core/src/quests/service.ts:2140`).

O passe **reusa essa régua**. Uma segunda virada de dia no mesmo repositório é
dívida garantida: dois relógios que discordam duas vezes por ano, e ninguém
lembrando por quê.

### 3.2 XP concedido não se desfaz

Quando o teto de uma fonte estoura, o XP **excedente não é guardado para
amanhã**. Ele simplesmente não acontece. Guardar seria uma segunda contabilidade
— e transformaria o teto numa fila, que é exatamente o que ele existe para
evitar.

E o contrário também vale: XP já creditado não é revisto. Se o admin baixar o
valor da fonte "matar jogador" no dia 20, quem subiu de nível antes disso
continua no nível. A trilha é histórico, não saldo.

---

## 4. Os estados de uma recompensa

Cada nível tem duas faixas, e **cada uma tem o seu estado**. O card mostra os
dois ao mesmo tempo.

| Estado | Significado | O que a tela mostra |
|---|---|---|
| `locked` | o nível não foi alcançado, ou o passe não foi comprado | cadeado, apagado |
| `available` | pode levar agora | destacado, botão de resgatar |
| `claimed` | já levou | marca de conferido |
| `pending` | resgatou, mas a entrega não terminou | "esperando espaço" |

Note o que **não** existe aqui: não há `unavailable`. Na trilha por XP nada se
perde por ter deixado passar — o nível 3 continua lá quando o jogador chegar no
30. Era um estado da trilha por dia, e ele morreu com ela.

O `pending` não é enfeite: é a consequência direta da exigência de inventário
cheio (§6).

### 4.1 A regra inteira, em uma tabela

| | nível alcançado | nível não alcançado |
|---|---|---|
| **GRÁTIS** | `available` → `claimed` | `locked` |
| **PAGO**, comprou | `available` → `claimed` | `locked` |
| **PAGO**, não comprou | `locked` (e a tela diz por quê) | `locked` |

A diferença entre as duas linhas de baixo é o que vende o passe, e por isso a
tela precisa **mostrar** a recompensa paga que o jogador está deixando na mesa —
apagada, mas legível. Cadeado sem conteúdo não vende nada.

---

## 5. A compra olha para trás

Comprado o passe, **toda recompensa paga de todo nível já alcançado fica
`available` de uma vez**.

É o retroativo que o dono descreveu quando a trilha ainda era por dia — quem
compra no dia 17 leva os 17. Traduzido para níveis: quem compra no nível 17 leva
os 17 níveis. O argumento de venda é o mesmo, e continua sendo o principal
motivo de alguém comprar um passe no meio do mês.

**O retroativo é uma chave do admin, e ela nasce ligada.** Desligada, a compra
vale só do nível seguinte em diante — uma venda pior e uma frustração
previsível, mas uma escolha legítima de quem opera o servidor, e que não pode
exigir código novo.

> **Em aberto:** vender o passe do mês **seguinte** antecipadamente. A recusa de
> compra duplicada é por `(jogador, mês)`, então comprar novembro em outubro
> passaria — mas exige que a oferta diga de que mês ela é. Recomendo não abrir
> na primeira versão.

---

## 6. O resgate em lote, e a mochila cheia

Quem compra no nível 17 vai clicar em "resgatar tudo" e pedir 17 recompensas de
uma vez. O dono exigiu proteção para o inventário cheio, e a exigência tem um
motivo medido: em 17/09/2026 um resgate de missão com a mochila cheia marcou a
missão como paga e **não entregou nada**.

As regras que decorrem disso:

1. **Pergunta-se antes.** O agente pergunta se cabe, e só então resgata. Não
   saber nunca vale por "cabe".
2. **A marca de `claimed` vem depois da entrega, nunca antes.** Enquanto faltar
   qualquer parte, a recompensa continua devendo.
3. **O lote é parcial por natureza.** Cabendo 6 de 17, entregam-se as 6 e as 11
   continuam esperando. O jogador lê quantos slots faltam e volta.
4. **Clicar duas vezes não entrega duas vezes.**
5. **O que não ocupa slot não é obstáculo.** OZCoin e direito de skin não
   disputam espaço na mochila — não faz sentido travá-los porque um item não
   coube.

A regra 5 tem uma consequência de desenho: **o lote não é atômico**. Ele é uma
lista de entregas independentes, cada uma com o seu estado. Tratar as 17 como um
bloco só faria o passe inteiro parar por causa de uma espingarda que não coube.

---

## 7. A virada do mês

No primeiro instante do dia 1:

- a temporada anterior vira `closed`;
- **o XP zera**;
- **o que estava disponível e não foi resgatado é entregue**, não confiscado —
  decisão do dono, 17/09/2026. Ele já alcançou o nível; o que faltou foi o
  clique. A entrega acontece no **próximo login**, e aparece na **caixa** do
  menu do passe, com o ponto de notificação (§6.1);
- a temporada `scheduled` daquele mês, se estiver publicada, vira `active`;
- se não houver nenhuma, o passe não aparece — e esse silêncio é ruim, então o
  painel avisa o admin **antes** de acontecer.

O que **não** é entregue é o que nunca ficou disponível: o nível 25 de quem
parou no 18 não vira presente de fim de mês. A regra é *"cumpriu e não clicou"*
ganha; *"não cumpriu"* não ganha.

E a faixa paga de quem não comprou também não entra — ela nunca esteve
disponível para ele.

### 7.1 A caixa

O jogador precisa saber de onde vieram esses itens. Por isso o menu do passe tem
um **ícone de caixa** com tooltip do que está esperando, e um **ponto de
notificação** enquanto ele não abrir.

O ponto some quando ele **abre a caixa**, não quando recebe os itens — *ter
pendência* e *saber que tem* são coisas diferentes. E a caixa serve às duas
origens de pendência: o que sobrou da temporada e o que não coube na mochila
num resgate (§6).

O direito de quem comprou **não atravessa o mês**. Comprar no dia 30 é comprar
um dia de XP — o que é uma armadilha comercial óbvia, e o motivo de a tela de
compra precisar dizer quantos dias restam antes de cobrar.

---

## 8. O que liga e desliga

Três chaves independentes, todas por servidor, todas pedidas pelo dono:

| Chave | O que faz quando desligada |
|---|---|
| passe ligado | o card some da home, o comando responde que não há passe, nenhum XP é contado |
| faixa grátis ligada | a trilha mostra só a faixa paga |
| faixa paga ligada | a trilha mostra só a grátis, e o produto some da loja |

Mais as regras de XP, que se ligam e desligam uma a uma (§3).

Desligar o passe **não apaga nada**: o XP e o resgatado continuam gravados. Quem
desliga por um mês e religa no outro não destruiu o histórico de ninguém — e
quem quer destruir tem um botão que diz isso com todas as letras.

E a pergunta que vai aparecer: **desligar a faixa paga no meio do mês, depois de
alguém ter comprado.** Não pode simplesmente sumir com o que foi pago. O mínimo
honesto é a tela do admin avisar quantos jogadores compraram naquele mês antes
de deixar desligar.

---

## 9. O vocabulário

Para o código e os documentos não divergirem. Identificador em inglês, texto em
português — regra global do dono.

| Termo | No código | O que é |
|---|---|---|
| Temporada | `season` | um mês de passe, num servidor |
| Trilha | `track` | a sequência de níveis da temporada |
| Nível | `level` | uma casa da trilha, numerada de 1 a N |
| Faixa | `lane` | `free` ou `paid` |
| Recompensa | `reward` | o que uma faixa dá num nível |
| XP | `xp` | o que faz subir de nível |
| Regra de XP | `xpRule` | fonte + valor + teto diário |
| Direito | `entitlement` | o registro de que o jogador comprou aquele mês |
| Resgate | `claim` | o ato de levar; e a linha que prova que levou |
| Progresso | `progress` | o XP e o nível do jogador na temporada |

> **Duas palavras já ocupadas neste repositório.** `tier` é do VIP
> (`bronze`/`prata`/`ouro`, em `core/src/vip/tiers.ts`) — por isso a faixa do
> passe é `lane`, e não `tier`. E `points` já é a recompensa de ranking das
> missões (`QuestReward` com `kind: 'points'`) — o do passe é `xp`, e os dois
> não se misturam.

# KOTH — decisões do dono

**15/09/2026.** Estas decisões **têm precedência** sobre a especificação
`KOTH-OrigemZ-Especificacao.md` onde as duas divergirem. A especificação é o levantamento
funcional; isto é o que o servidor vai fazer.

Quem lê isto: quem for implementar o KOTH.

---

## 1. Ele roda sozinho, nos lugares que o admin marcou

O admin cadastra os **territórios** — os lugares do mapa onde o evento pode acontecer. A
partir daí é **automático**: o agendador sorteia a hora e o lugar entre os cadastrados,
como já faz com a masmorra.

Não é um evento de botão. O botão continua existindo para o admin forçar, mas não é o
modo de operação.

A agenda é a que já existe, em `/eventos` — ela é do guarda-chuva (`world_events`), não da
masmorra, e aceita qualquer família. O agendador hoje **recusa em voz alta** um evento de
família que ele ainda não sabe erguer, em vez de pulá-lo em silêncio.

## 2. Só participa quem está em equipe

**Esta decisão muda a §8.1 da especificação**, que previa a modalidade individual ("cada
SteamID representa um lado"). Não haverá modalidade individual na primeira versão.

- Quem entra na área **sem equipe** recebe um aviso na tela dizendo que precisa estar num
  time para participar.
- A barra de captura **não enche** para quem está sozinho. Ele ocupa o espaço, apanha e
  atira como qualquer um — mas não pontua.

Em aberto: um jogador em equipe de um membro só conta como lado? (A decisão acima diz
"estar em equipe", e uma equipe de um é uma equipe. Confirmar antes de implementar, porque
é a brecha óbvia.)

## 3. O placar é por nome de equipe

Quem está ganhando aparece **pelo nome da equipe**, não pelo SteamID nem pelo nome do
líder. Isso torna o `OrigemZTeam` uma **dependência de entrega**, e não um acessório:
sem equipe nomeada não há placar.

Ver `Docs/OrigemZTeam/00-LEVANTAMENTO.md`. O campo `teamName` já existe no jogo, nasce
vazio e persiste no save — medido em 15/09/2026.

## 4. A barra na tela do jogador

O jogador dentro da área precisa **ver o progresso** — a barra enchendo, quanto falta,
quem está na frente. Sem isso ele não sabe que está capturando, e o evento vira gente
parada num círculo sem retorno nenhum.

Vai pelo CUI, junto do que o `OrigemZUI` já desenha na tela. Lembrar do orçamento do
frame (~390 bytes por elemento) antes de desenhar a tela inteira.

## 5. A bandeira do território

Uma **`Large_Banner_on_pole`** no centro do território — é o que um KOTH tem, e é o que
diz de longe onde ele é.

Ideia registrada, **não decidida**: trocar a **textura** da bandeira para representar a
equipe que está dominando. Depende de:

1. a equipe ter identidade (§3);
2. saber se dá para trocar a textura de um banner plantado sem recriá-lo, e a que custo
   de rede.

Enquanto isso não for medido, a bandeira é decoração e marcação — já vale por isso.

---

## O que ficou pronto na noite de 15/09/2026

Medido no server01, com o ciclo inteiro rodando:

| Peça | Estado |
|---|---|
| Territórios (cadastro + mapa no painel) | pronto — migração 089 |
| Bandeira e círculo no mapa do jogo | pronto — `sign.pole.banner.large`, conferido no manifesto |
| Captura por equipe, com contestação e decaimento | pronto — tick de 1 s no plugin |
| Barra na tela de quem está dentro | pronto — avisa quem está sem equipe |
| Placar pelo nome da equipe | pronto — vem do OrigemZTeam |
| Run no histórico do guarda-chuva | pronto — a mesma tabela da masmorra |
| **Nascer sozinho** | pronto — relógio próprio (`game/koth-scheduler.ts`) |
| Recompensa | **falta** — o agente registra quem venceu e não paga nada |
| Perfis reutilizáveis | falta — hoje cada território carrega os próprios números |
| Textura da bandeira por equipe | falta — §5, ainda não medido |

O teste do nascimento automático, ao vivo: o relógio marcou o compromisso, adiou duas vezes com a
razão certa (uma por não saber quantos estavam online, com o RCON caído; outra por haver menos gente
que o mínimo), e depois ergueu sozinho — `KOTH agendado erguido`, território "Colina do Norte", em
N14.

**Um evento por servidor:** se há qualquer run aberta naquele servidor — masmorra inclusive — o KOTH
adia. Dois eventos ao mesmo tempo dividem a população e os dois ficam vazios. É a "regra de conflito
com masmorras" da spec, aplicada no lugar mais barato.

---

## O marcador no mapa — o que o cliente do Rust permite

Medido no server01 em 15/09/2026, com prints do mapa:

**A escala do círculo.** O servidor manda o raio cru e quem desenha é o cliente — a escala não
está no assembly do servidor. Comparando o círculo com a grade do mapa (146,3 m por célula):
**1.0 = uma célula**. Então o raio em metros divide por 146,3, e o círculo passa a ser a área de
verdade. A grade do Rust é sempre 146,3 m, em qualquer tamanho de mundo.

**O texto custa um carrinho de compras.** O único marcador do Rust que carrega texto é o
`VendingMachineMapMarker`, e o cliente desenha junto: o ícone de loja, o título "LOJA" e a caixa
"Este fornecedor não tem anúncios". Nada disso vem do servidor — não há campo para mudar.

A alternativa seria o pin que o jogador cria no mapa (`State.pointsOfInterest`), e ela não serve:
`MaxMapNoteLabelLength = 10` no jogo (caberia "Colina do"), o pin ocupa um dos slots do próprio
jogador (`maximumMapMarkers`) e teria de ser empurrado e removido um por jogador.

**Decisão do dono, 15/09/2026:** fica o `VendingMachineMapMarker`, com o carrinho. O texto dele é
o estado do evento — `Colina do Norte — Alcateia do Norte 45%`, ou `— DISPUTADO 45%`, ou
`— sem dono` — e só é reenviado quando muda, para não gastar um update de rede por segundo.

---

## Ordem de dependência

1. `OrigemZTeam` — equipe com nome, líder e cargo.
2. Territórios cadastrados (centro + volume de captura).
3. A captura no plugin (quem está dentro, quem contesta, progresso e decaimento).
4. A barra na tela.
5. A bandeira, e depois a textura por equipe.
6. Recompensas e entrega.

A tela `/eventos/koth` do painel mostra esta mesma lista, para quem chegar por lá.

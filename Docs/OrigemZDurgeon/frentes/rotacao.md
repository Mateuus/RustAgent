# A rotação das plantas está em radianos, e o leitor a trata como graus

**Medido em 09/09/2026**, nas sete plantas herdadas. Achado de passagem pela
frente `event-portas`; confirmado aqui com as contas abaixo.

## O defeito

`PasteOne` monta a pose de cada peça assim:

```csharp
var worldRot = spin * Quaternion.Euler(ReadVector(node["rot"]));
```

`Quaternion.Euler` espera **graus**. O `rot` do CopyPaste está em
**radianos**.

## A prova, em três medições

**1. Nenhum valor passa de 2π.** Nas 1.321 entidades das sete plantas há 3.963
componentes de rotação. O maior em módulo é **6.2830** — e 2π é 6.2832.
Nenhum passa disso.

Se fosse grau, os valores iriam a 360. Aqui, o que se vê é o intervalo fechado
de uma volta em radianos.

**2. Os valores dominantes diferem por π/2.** Na `entrance1`, os quatro `rot.y`
mais comuns cobrem 441 das 584 peças:

| rot.y | peças |
|---|---|
| −2.481 | 129 |
| −0.910 | 93 |
| 0.660 | 112 |
| 2.231 | 107 |

As diferenças entre eles, em ordem: **1.5710, 1.5670, 1.5640**. π/2 é 1.5708.

São as **quatro orientações cardeais** de uma construção — norte, sul, leste,
oeste —, giradas pelo ângulo em que o prédio foi erguido. Em radianos.

**3. O `default.rotationy` da mesma planta é `221.5436`.** Esse está em graus,
e é a rotação do jogador no instante em que copiou. **O mesmo arquivo carrega
as duas unidades**, e é isso que faz o erro passar despercebido: quem confere o
`default` acha que está tudo em graus.

## O que isso produz no jogo

Uma parede que devia nascer virada −142,2° (−2,481 rad) nasce virada **−2,48°**
— praticamente reta. O erro é de ~140 graus, e vale para **toda peça de toda
planta**, desde sempre.

Que as casinhas ainda pareçam casinhas é o que torna isto traiçoeiro: fundações
e pisos são quadrados e quase não denunciam o giro; quem denuncia são as
paredes, as portas e os móveis.

## A correção

```csharp
var worldRot = spin * Quaternion.Euler(ReadVector(node["rot"]) * Mathf.Rad2Deg);
```

E o mesmo no `children[]` — a fechadura de uma porta tem rotação própria.

## Por que ela não entrou junto com as outras

**Ela muda a pose das sete plantas de uma vez.** É a única mudança desta
semana que altera algo que o dono já viu funcionando: a casinha da `entrance2`
que ele atravessou está construída com a rotação errada, e vai ficar diferente.

Isso merece um teste isolado — construir antes, olhar; construir depois, olhar
—, e não vir escondida num lote com IA, loot e fechadura. Quem confere é o
dono, dentro do jogo.

## O que olhar

1. **A `entrance2` de fora.** É a casinha que ele já conhece: as paredes têm de
   fechar o retângulo, e não formar um moinho;
2. **As portas da `entrance1`** (584 peças, a maior). Uma porta virada 140° fica
   atravessada no vão;
3. **Os móveis das `base*`** — sofá, mesa, estante. São as peças em que o giro
   errado é impossível de não ver.

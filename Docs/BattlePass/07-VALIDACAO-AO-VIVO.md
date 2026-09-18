# Passe de Batalha — validação ao vivo

O que só se descobre com o servidor no ar e alguém no jogo. Duas coisas, nesta
ordem: a **sonda de DLC**, que decide uma regra de produto, e a **tela do
passe**, que são 3.611 linhas de C# que nenhum teste alcança.

---

## 0. Antes de subir: o aviso do banco

**Subir o agente da worktree do passe aplica as migrações 101, 102 e 103 no
banco de desenvolvimento.** A partir daí, qualquer agente com código anterior a
elas é **recusado no boot** pela trava de schema — que passou a ser chamada em
17/09/2026 e recusa id desconhecido.

Em 17/09/2026 havia nove worktrees vivas, entre elas a do VIP e a das missões
diárias. Todas param de subir depois desta validação.

Três saídas, em ordem de preferência:

1. **Validar por último**, quando as outras frentes já tiverem voltado;
2. **Apontar o `.env` da worktree do passe para um banco próprio** antes de
   subir — é uma linha, e é reversível;
3. Aceitar o efeito e avisar quem mais estiver trabalhando.

A escolha é de quem opera. O que não pode é descobrir isso depois.

---

## 1. A sonda de DLC

### Por que ela existe

O dono decidiu (17/09/2026) que **skin de DLC pode ser prêmio do passe, desde
que só quem tem a DLC a use**. Isso respeita a checagem de posse em vez de
burlá-la, que é exatamente o que as diretrizes da Facepunch pedem — ver
[03](03-MENU-DO-PASSE.md) §9.

Falta saber se **o servidor consegue fazer essa checagem**. O projeto mediu o
caminho oposto — *liberar* skins, que é developer-only — e ninguém mediu este.

### O que o decompilado já respondeu

`PlayerBlueprints.CheckSkinOwnership(int skinItemId, BasePlayer player)` existe,
é público, e termina em `steamInventory.HasItem(skinItemId)`. O `HasItem` é:

```csharp
if (!DefaultSkinAccess) return AllSkinsUnlocked;   // curto-circuito
if (Items == null) return false;                    // <-- a pergunta
...percorre Items procurando DefinitionId...
```

Então **a resposta inteira depende de `steamInventory.Items` estar preenchido no
servidor**. Se ele for `null` aqui, `HasItem` devolve `false` para todo mundo — e
a feature não bloquearia só quem não tem a DLC: bloquearia **todos, inclusive
quem comprou**. Um falso negativo silencioso, que só apareceria como "comprei a
DLC e o passe não me dá a skin".

> **E uma armadilha de número:** o `skinItemId` daqui é a **definição de
> inventário Steam**, e **não** o Workshop ID que o nosso catálogo guarda. O
> Workshop ID passa de 2³¹ e nem cabe no `int` do parâmetro. São dois números
> diferentes para a mesma skin, e confundi-los faz a checagem responder sobre
> outra coisa.

### Como rodar

O plugin é `Plugins/OrigemZDlcProbe.cs`, **descartável** — ele só lê, não dá,
não tira e não altera nada. Compila limpo no `pluginlint`.

```powershell
# 1. subir o servidor (pela API do agente, ~20 s)
POST /api/servers/server01/start

# 2. pôr a sonda em Plugins\server01\ e ligá-la pelo painel,
#    ou copiar direto para oxide\plugins\ do servidor

# 3. com VOCÊ dentro do jogo, pelo RCON:
origemz.dlcprobe <seu steamId>

# 4. e, se souber a definição Steam de uma skin que você POSSUI:
origemz.dlcprobe <seu steamId> <skinItemId>
```

### Como ler a resposta

A sonda devolve um JSON com um campo `verdict` em português. Os quatro desfechos:

| `verdict` | O que significa | O que fazer |
|---|---|---|
| **DA: o servidor enxerga N itens...** | `Items` está preenchido. A checagem funciona. | a skin de DLC entra na trilha, como o dono decidiu |
| **NAO DA: Items e null no servidor** | `HasItem` responde `false` para todos | **a regra volta a ser a conservadora**: só skin nossa do Workshop |
| **SUSPEITO: Items existe mas veio vazio** | pode ser sessão sem inventário carregado | repita com alguém que **tenha** skin comprada |
| **INCONCLUSIVO: DefaultSkinAccess falso** | o curto-circuito entrou; a posse real nem foi consultada | investigue por que esse jogador tem o acesso alterado |

Os campos `itemsNull`, `itemCount` e `sample` mostram o dado cru, para o caso de
o veredito não bastar.

### O que fazer com a resposta

**Se der:** falta ainda uma marca no cadastro da skin dizendo **se ela é DLC** —
sem isso ninguém sabe o que verificar. É uma coluna e uma migração (a 104, que
precisa ser conferida em todas as branches vivas antes de usar).

**Se não der:** a decisão do dono permanece válida em intenção, mas
inexequível — e o passe fica com skin nossa do Workshop, que é o que o catálogo
tem hoje de qualquer forma.

**Em qualquer caso, apague a sonda depois.** Ela é um plugin descartável, não
uma feature.

---

## 2. A tela do passe

3.611 linhas de C# que o `pluginlint` compila e nenhum teste exercita. O que
segue é o que precisa ser olhado, em ordem, e por quê.

### 2.1 Antes de abrir o jogo

```powershell
# os bytes cabem?  (ja medido: 3.065 por nivel, 30 niveis em 5 AddUI)
origemz.passe.bytes 30

# a carga chegou?
origemz.passe.status
```

O `status` responde `{"ok":true,"period":…,"levels":N,"players":N}`. Se ele
responder `NO_SEASON`, o agente ainda não mandou o catálogo — e **progresso que
chega antes do catálogo é recusado de propósito**, mesma regra do `owned` do
menu de skins.

### 2.2 No jogo, em ordem

| # | O quê | O que olhar |
|---|---|---|
| 1 | abrir pelo comando e pelo card da home | os dois caminhos levam à mesma tela |
| 2 | **a trilha nasce rolada no nível atual** | **é o ponto não-medido** — ver §2.3 |
| 3 | rolar a trilha até o fim e voltar | a barra não cobre a borda; o conteúdo não é recortado |
| 4 | um nível alcançado e não resgatado | moldura acesa, botão primário, só nele |
| 5 | um nível bloqueado | cadeado **e** apagado — nunca só a cor |
| 6 | a faixa paga sem ter o passe | **aparece**, apagada, com selo e o motivo. Esconder faria o jogador achar que o passe engoliu o prêmio |
| 7 | resgatar um nível | a tela reflete; o item chega |
| 8 | **resgatar tudo com a mochila cheia** | o lote é parcial: entrega o que cabe, o resto fica devendo e diz quantos slots faltam |
| 9 | a caixa de pendências | ícone com o ponto de notificação; o ponto some ao **abrir**, não ao receber |
| 10 | comprar o passe | o modal diz o mês, o servidor, os dias restantes e o retroativo |
| 11 | comprar de novo | recusa com "você já tem", **sem cobrar** |
| 12 | abrir com o agente derrubado | "sincronizando", nunca cadeado — *ausente não é vazio* |

O passo 8 é o que o dono exigiu em primeiro lugar, e o 12 é o que separa "não
tem" de "não sei".

### 2.3 O ponto que não foi medido

**A trilha nascer já rolada no nível atual.** O deslocamento é feito na âncora do
conteúdo do `ScrollView`, e o JSON gerado foi conferido — mas isso é leitura do
comportamento do `ScrollRect`, não medição no jogo.

Se nascer no lugar errado, há duas chaves que desligam sem recarregar o plugin:

```
OpenAtCurrentLevel      desliga so o deslocamento inicial
origemz.passe.scroll 0  desliga a rolagem inteira
```

### 2.4 Quando um clique não faz nada

O porteiro do menu **recusa em silêncio** — é de propósito: token errado ou
cooldown não devem virar mensagem. Para ver o que ele está recusando:

```
origemz.ui.debug 1
```

E a armadilha de sempre: **a resposta de um comando volta casada no POST /rcon**
e some do buffer. Procurar no console faz o comando parecer mudo.

---

## 3. O que sobra depois disto

- **A frente G** (venda pelo site) depende de acordo com o agente do site — o
  `Docs/37` é o pedido, e a resposta é deles.
- **A marca de DLC no cadastro da skin**, se a sonda der positivo.
- **A dívida herdada**: 48 erros de typecheck em `core/tsconfig.test.json`, em
  oito arquivos de teste de outras frentes. Estavam lá antes do passe e
  continuam — medido na `main` pura e com o passe inteiro integrado.

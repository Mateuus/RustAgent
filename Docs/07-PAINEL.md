# 07 — O painel (Fase 1)

Next.js com **export estático**: `npm run build -w panel` gera `panel/out`, e o
core serve esses arquivos com `@fastify/static`. Um processo só, uma porta só,
e nada de servidor Node do Next em produção.

Em desenvolvimento o painel roda em `localhost:3100` e fala com o core em
`127.0.0.1:8787`.

---

## As telas

```
  /entrar             login do operador
  /                   os servidores, lado a lado, + criar
  /servidor?id=<id>   a página de um servidor  (abas)
  /plugins            a biblioteca de plugins do agente
  /banidos            a BanList do agente
  /config             o agente
```

As duas telas de REDE — plugins e banidos — existem pelo mesmo motivo: as duas
guardam estado que vale para todos os servidores, e espalhá-lo por servidor foi
justamente o problema que elas resolveram.

Duas decisões tomadas na implementação, e o porquê de cada uma:

**A lista e a visão geral são a MESMA tela.** O plano previa `/` e `/servidores`
separadas; construindo, as duas mostravam o mesmo conteúdo com títulos
diferentes. Duas telas iguais é manutenção dobrada para nada — o botão *Criar
servidor* mora na de cima.

**`/servidor` usa query string, e não `/servidor/[id]`.** O painel é export
estático: uma rota dinâmica exigiria `generateStaticParams`, ou seja, saber em
tempo de **build** quais servidores existem. Eles nascem em tempo de execução,
pelo próprio painel. Query string resolve sem subir um servidor Next só para
isso.

---

## `/` — a visão geral

Um cartão por servidor, e o cartão responde de longe:

```
┌──────────────────────────────────────────────┐
│  PVP 1                              ● no ar  │
│  OrigemZ | PVP x5                            │
│                                              │
│  42/200 jogadores      mapa Procedural 4000  │
│  28015 · 28016 · 28017 · 28082               │
│  build 24253458                    em dia ✓  │
│                                              │
│  [ Abrir ]   [ Parar ]                       │
└──────────────────────────────────────────────┘
```

Os estados possíveis do ponto, e o que cada um quer dizer:

| | Estado | Significa |
|---|---|---|
| ● cinza | **não instalado** | cadastrado, sem jogo em disco. Botão: *Instalar* |
| ● cinza | **parado** | instalado, processo fora do ar. Botão: *Iniciar* |
| ● amarelo | **iniciando** | processo no ar, RCON ainda não respondeu (mapa gerando) — com o tempo decorrido |
| ● verde | **no ar** | RCON conectado |
| ● laranja | **atualização disponível** | build publicado ≠ instalado |
| ● vermelho | **sem RCON** | processo no ar e RCON não responde há mais de 2 min |

O "iniciando" com cronômetro não é enfeite: um mapa procedural de 4000 leva
minutos, e sem essa informação a tela parece travada e alguém clica em Iniciar
de novo.

---

## `/servidores` — a lista e o botão de criar

Tabela com id, nome, estado, portas, build, jogadores. E o **Criar servidor**.

### O formulário

| Campo | Detalhe |
|---|---|
| id | minúsculas, dígitos e hífen; vira o nome do `.ini` e das pastas. Não muda depois |
| nome | o rótulo no painel |
| hostname | o que o jogador lê na lista do Rust |
| mapa | `Procedural Map`, `Barren`, `HapisIsland`, … |
| worldSize / seed | seed em branco = a do modelo |
| maxPlayers | |
| senha do RCON | gerada por padrão; sem `/ \ ? #` nem espaço |
| bloco de portas | pré-preenchido com o primeiro livre, e as quatro portas aparecem ao lado |

Ao salvar, o servidor aparece na lista como **não instalado**, e a tela já
oferece *Instalar* — que é o passo seguinte de verdade.

---

## `/servidor/[id]` — a página do servidor

Cabeçalho com o estado e os botões que **aquele estado** permite (vindos de
`kinds` na resposta de `GET .../operations` — a tela não adivinha).

Abas:

### Visão

Estado, portas, build instalado × publicado, caminho da instalação, tamanho em
disco, últimas linhas do log do servidor.

### Operações

Os botões grandes, e o **log ao vivo**:

```
  [ Instalar / Atualizar ]   [ Iniciar ]   [ Parar ]   [ Reiniciar ]

  ┌── server-install ─────────────────────── 42% ──┐
  │ [SteamCMD] Baixando/validando o servidor...    │
  │ Update state (0x61) downloading, progress: 42  │
  │ …                                              │
  └────────────────────────────────────────────────┘
                              [ Cancelar operação ]
```

O log rola sozinho enquanto está no fim, e para de rolar quando a pessoa sobe —
senão não dá para ler a linha de erro que passou.

**Parar** abre confirmação; **Parar à força** é um segundo botão, vermelho,
dentro dessa confirmação, com o texto dizendo o que se perde.

### Plugins

**Duas colunas, porque são duas perguntas.**

```
┌─ DISPONÍVEIS ──────────┐  ┌─ ATIVOS NESTE SERVIDOR ─┐
│ ┐ arraste o .cs aqui ┌ │  │ OrigemZPlayer    v1.2.3 │
│ └──────────────────┘   │  │  ⚠ versão nova [Aplicar]│
│                        │  │                 [Tirar] │
│ Kits          [Ligar]  │  │                         │
│ MeuEvento     [Ligar]  │  │ ServerRewards    v2.1.0 │
│  (custom deste server) │  │                 [Tirar] │
└────────────────────────┘  └─────────────────────────┘
```

À esquerda, o que dá para ligar: a **biblioteca do agente** (ver `/plugins`,
adiante) mais os **plugins custom deste servidor**. À direita, o que está
rodando. Numa lista só com interruptor por linha, "o que está no ar?" exigia
varrer trinta linhas lendo o estado de cada uma; separado, a resposta é uma
coluna — e ligar/tirar vira mover de lado, que é o gesto que a cabeça já faz.

Cada linha diz de onde o plugin vem: *biblioteca* ou *custom deste servidor*.

**A área de arrastar-e-soltar envia um plugin custom.** O `.cs` largado ali é
deste servidor e de mais ninguém: não aparece na tela de rede nem no acervo dos
outros. É o evento de um fim de semana, o teste que não vai para os demais. Para
valer em todos, o lugar é `/plugins`. A área também é um botão — arrastar não é
descobrível sozinho.

Quando a biblioteca tem um `Kits` e este servidor tem um `Kits` custom, ligar o
segundo é **recusado**: os dois gravam o mesmo arquivo e o Oxide carrega um só.
O botão nasce desabilitado, com a frase dizendo qual está no caminho — um botão
inerte sem explicação é um mistério, e a pessoa clica de novo achando que
travou.

### Os plugins que dependem uns dos outros

Três dos `OrigemZ*` começam com `// Requires: OrigemZAgent` — diretiva do
próprio Oxide, que não carrega o plugin enquanto a dependência não estiver
carregada. A tela trata os dois lados disso:

**Ao ligar**, se falta uma dependência, a linha diz de quem ele depende e que o
Oxide só vai carregá-lo quando ela entrar. Ligar continua permitido: é o
comportamento real do jogo, e impedir seria inventar uma regra que o servidor
não tem. O que não pode é a tela dizer "ativo" e nada acontecer, sem explicação.

**Ao tirar**, se outros dependem dele, o botão vira confirmação em dois passos e
escreve os nomes: quem *sai do ar junto* (`// Requires:`) e quem *continua no ar
sem a parte que usava este* (`[PluginReference]`). Os dependentes também
aparecem na linha o tempo todo, antes de alguém pensar em tirar — descobrir a
dependência no meio da confirmação é tarde para quem estava só olhando a lista.

Sem isso, tirar o `OrigemZAgent` derrubaria três plugins em silêncio, e o
sintoma apareceria no jogo — kit que não vem, fila que não ordena — sem nada
ligando uma coisa à outra.

Quando o `sha256` do que está em disco difere do do acervo, a linha ativa ganha
o aviso **"há versão nova para aplicar"** com o botão ao lado — sem ele, a única
pista seria a versão da tela de rede não bater com a de cá, e ninguém compara
duas telas.

*Tirar* descarrega o plugin e apaga o `.cs` daquele servidor, mas **preserva a
configuração** (`oxide\config\<Nome>.json` e `oxide\data\`). A tela diz isso: se
tirar parecesse caro, ninguém usaria o botão.

**Ligar junto.** Quando falta dependência, ao lado do aviso há o botão *"Ligar
junto com X, Y"*: uma chamada só, e o agente liga na ordem topológica —
dependência primeiro. Avisar e deixar a pessoa ligar três plugins na mão, na
ordem certa, é passar a regra para quem não a conhece.

**O custom sai por aqui.** Ele é deste servidor, e nenhuma outra tela o enxerga:
sem o botão de remover na linha dele, um custom que ninguém mais usa ficaria na
coluna de disponíveis para sempre. O plugin da **biblioteca** não tem esse botão
aqui, de propósito — removê-lo tira de todos os servidores, e essa decisão é da
tela de rede, onde se vê quem usa o quê.

**"Ativo" não é o mesmo que "rodando".** Se o Oxide recusou compilar o plugin, a
linha diz isso em vermelho — *"está no servidor, mas não está rodando"* — com a
frase do compilador junto, que é a que diz a linha do erro e é o que se manda
para quem escreveu o plugin. Antes, isso voltava só dentro da resposta de quem
clicou, num bloco que rolava para fora da tela: quem clicou ia embora achando
que aplicou, e o sintoma aparecia no jogo horas depois.

**Copiar de outro servidor.** No rodapé da aba, uma faixa liga aqui o mesmo
conjunto que outro servidor usa — um servidor novo deixa de ser seis plugins
ligados na mão. O que não pôde vir (o custom do outro servidor) fica na tela com
o motivo, porque é a lista de `.cs` que ainda precisam ser enviados aqui. A
configuração de cada plugin **não** é copiada: ela é daquele servidor, e trazê-la
faria este anunciar o nome do outro no chat.

Depois de ligar ou aplicar, a resposta do Oxide aparece na tela — inclusive o
erro de compilação, se houver. Gravar e carregar são coisas diferentes.

### Administração

Entre **Visão** e **Console**, porque é a ordem do uso: quem abre a página de um
servidor quer primeiro saber como ele está, e logo em seguida quem está dentro
dele. Cinco sub-abas, no mesmo desenho de *Configurações* — pílulas com divisória
de 1px.

```
  Jogadores | Chat | Admins | Banidos | Comandos
```

**Jogadores.** Quem está online, com vida, ping, tempo de conexão e posição. Por
linha: *Copiar SteamID*, *Expulsar* (confirmação em dois passos) e *Banir* (abre
o diálogo).

A **fonte não é escolha de quem olha**. Com o `OrigemZAgent` ligado, a lista vem
do plugin e tem posição; sem ele vem do `playerlist` nativo, que não tem. A tela
diz qual está em uso e — quando o plugin está no acervo e desligado — oferece
*Ligar* ali mesmo. Um seletor de fonte transferiria para quem administra uma
decisão que o agente já sabe tomar.

O que a fonte atual não dá vira **travessão**, nunca zero e nunca "morto". A
faixa acima da tabela explica o travessão antes de alguém concluir que a posição
sumiu — caçar um defeito que não existe é o pior desfecho desta tela.

**Chat.** As mensagens dos jogadores com o horário, a **tag do grupo**
(`[VIP OURO]`, `[ADMIN]`) e o nome **na cor daquele grupo** — a mesma conversa
que os jogadores estão vendo no jogo. Sem a tag, quem administra não sabe se está
falando com um VIP ou com um novato. Mais um campo para falar (`say`).

A conversa vem do **histórico do servidor**, e não de um buffer do agente. A
primeira versão lia as linhas de chat do RCON e ficava vazia com o servidor cheio
de gente conversando: um plugin de chat cancela a mensagem original para
reenviá-la formatada, e com ela some o frame de chat do WebRCON. O histórico do
jogo é alimentado nos dois caminhos — e sobrevive ao reinício do agente, coisa
que um buffer em memória não faz.

Canal diferente de global ganha etiqueta: uma mensagem de **equipe** lida como
global faz quem administra achar que o combinado foi dito para todo mundo. A
rolagem para quando a pessoa sobe, igual ao console.

**Admins.** Quem é owner e quem é moderador, lidos do `users.cfg`, com promover e
rebaixar. A tela diz, em voz alta, que **o arquivo é lido e nunca escrito**:
editá-lo à mão com o servidor no ar perde a mudança no próximo `server.writecfg`,
sem erro nenhum. Quem muda o estado é o comando pelo RCON.

**Banidos.** O que vale naquele servidor, com a origem de cada linha — *rede*,
*específico* ou *adotado do bans.cfg* — e o botão de *Sincronizar agora*. Ele
fica desabilitado com o RCON fora do ar, com o motivo no `title`: um botão que
falha sempre é pior que um botão inerte que se explica.

**Comandos.** Os atalhos da semana (`server.save`, `server.writecfg`,
`oxide.reload *`, `weather.rain 0`, `env.time 12`), cada um com **o que ele faz
de verdade** escrito ao lado — `oxide.reload *` derruba todos os plugins por
alguns segundos, e isso precisa estar escrito antes do clique. Mais um campo
livre, com a resposta do servidor na tela.

### Configuração

Os campos do `.ini` que dá para mudar pelo painel, com aviso claro do que só
vale depois de reiniciar o servidor. Sete sub-abas: *Geral*, *Mundo*, *Rede*,
*RCON*, *SteamCMD*, **Plugins** e *Avançado*.

#### A sub-aba Plugins

`Servers\<id>\oxide\config\<Nome>.json` — a configuração de cada plugin, sem
abrir editor de texto na máquina onde o servidor mora.

Ela mora **aqui**, e não na aba Plugins, porque são duas perguntas diferentes: a
aba Plugins responde *o que este servidor usa* — liga, desliga, aplica versão —,
e isto é ajuste, que é o assunto de Configurações. O arquivo do plugin fica ao
lado do mundo, das portas e do SteamCMD, que é onde se procura por ajuste.

A lista da esquerda vem da **pasta**, e não do acervo: a config sobrevive ao
plugin, e a órfã — o `.json` de um que saiu — é justamente a que alguém vai
procurar para recuperar horas de trabalho. Ela aparece marcada como *fora do
acervo*; a de um plugin desligado, como *desligado*, com o aviso de que o que
for gravado vale quando ele for ligado.

À direita, um **editor de texto monoespaçado** — e não um formulário gerado a
partir do JSON. A estrutura muda por plugin, e um formulário erra em qualquer
coisa aninhada: a lista de itens da loja, o mapa de permissões por nível. O que
ele mostraria seria uma versão empobrecida do arquivo, e o que gravasse de volta
seria pior.

O que a tela **deve** fazer é não deixar gravar lixo: o `JSON.parse` roda a cada
tecla, a mensagem dele fica à vista (é ela que diz a posição do erro) e o botão
de gravar só vale enquanto o texto for válido. JSON quebrado não derruba a tela
— derruba o plugin, no servidor, com os jogadores dentro.

*Gravar e recarregar* é um botão só: mexer no arquivo com o plugin carregado não
tem efeito nenhum até o `oxide.reload`. Depois de gravar, a tela adota o texto
que o **agente** devolveu, e não o que a pessoa digitou — vários plugins chamam
`SaveConfig()` ao carregar e reescrevem a própria config. E mostra o que o Oxide
respondeu, que é onde aparece o campo que o plugin esperava e não veio.

*Voltar ao padrão* apaga o arquivo para o plugin recriá-lo. É confirmação em
dois passos, e há cópia em `Backups\<id>\oxide-config\` — de toda escrita, não
só desta.

---

## `/plugins` — a biblioteca

A tela de **rede**, e não de servidor: um `.cs` entra aqui uma vez e fica
disponível para todos. Tabela, pelo mesmo motivo da lista de servidores — é uma
tela de comparação, e o que se quer é varrer a coluna de versão de cima a baixo.

Os plugins **custom** não aparecem aqui: eles são de um servidor só, e listá-los
encheria esta tela de coisas que mais ninguém pode usar. Eles moram na aba
Plugins do servidor deles.

Por linha: o título e o arquivo, o autor, a versão, **em quais servidores está
ativo** (os nomes, não a contagem — "2 servidores" obriga a ir procurar quem
são), o tamanho e *Remover*.

Abaixo do nome, **quem depende dele**: "OrigemZVip não carrega sem este". Quem
remove daqui remove de todos os servidores de uma vez, e leva junto, em cada um,
quem o exigia — ler isso só na confirmação é tarde para quem ainda está
decidindo o que remover. Quem calcula é o agente, sobre a biblioteca inteira; no
navegador seria adivinhação sem teste.

Nome, autor e versão saem do `[Info(...)]` do próprio `.cs`. Não há formulário
de metadados: seria a segunda fonte para o mesmo fato, e a segunda é a que
diverge no dia em que alguém sobe a versão nova sem reabrir o formulário.

**Enviar não é aplicar.** Subir uma versão nova atualiza a biblioteca e não mexe
em servidor nenhum — cinco servidores no ar recarregando um plugin porque alguém
arrastou um arquivo é susto que ninguém pediu. A tela diz quem ficou para trás;
aplicar é na aba daquele servidor.

Remover com servidores usando não mostra "tem certeza?": mostra **quais**
servidores perdem o plugin, com a frase que veio do agente.

---

## `/banidos` — a BanList

A tela de **rede**. Antes, cada servidor tinha a lista dele no `bans.cfg`: um
jogador expulso do `pvp1` entrava no `pvp2` no minuto seguinte, e quem administra
descobria pelo Discord. Aqui o banimento é estado do **agente**, e cada servidor
é espelho.

Tabela, pelo mesmo motivo da lista de servidores e da de plugins: é uma tela de
comparação — varrer a coluna de vencimento de cima a baixo e achar quem já devia
ter saído.

Por linha: o nome e o SteamID, o motivo, **onde vale** (os nomes dos servidores,
ou *toda a rede*), quem aplicou, a situação e *Revogar*.

O filtro nasce em **Ativos**. Sem ele a lista viraria um histórico onde ninguém
acha quem está banido agora — e o histórico é justamente o que não se apaga:
revogar preenche `revokedAt` e `revokedBy`, e a linha fica. É o que responde à
segunda discussão sobre o mesmo jogador.

### O diálogo de banir

Três decisões, e por isso um diálogo e não um `ConfirmButton`: o **motivo** (vai
para o `bans.cfg` e para o histórico), o **alcance** e o **prazo**.

O alcance é a decisão que envelhece, e o texto ao lado de cada opção diz isso:
*toda a rede* vale nos servidores que ainda vão ser criados; *servidores
escolhidos* vale só nos marcados, e um servidor criado depois **não** herda o
banimento.

O prazo oferece Permanente, 1, 3, 7 e 30 dias — e a tela avisa que **o jogo não
tem banimento com prazo**: quem solta na data é um relógio do agente, e só
enquanto ele estiver no ar. Um "vence em 7 dias" sem essa frase é uma promessa
que o Rust não faz.

---

## `/config` — o agente

Porta e host da API, `OPS_ENABLED`, auto-update da Steam ligado/desligado,
intervalo de verificação, caminho das pastas, versão do agente, e o botão de
trocar a senha do operador.

---

## Como o painel conversa com o core

- **sessão em cookie** `HttpOnly`; o `csrfToken` vem no login e vai em todo
  POST/PATCH/DELETE;
- **polling**, não websocket: a lista de servidores a cada 5 s, o log de
  operação a cada 1 s enquanto há operação rodando. Um websocket a mais é uma
  reconexão a mais para tratar, e o volume aqui não justifica;
- **erro sempre com a frase do core**. O painel não reescreve mensagem: quem
  conhece a regra é quem a escreveu. O que a tela acrescenta é o botão que
  resolve — "o SteamCMD está ocupado com o `pve`" vem com *Ver operação*.

---

## O que a tela nunca faz

- **não esconde botão porque "não deve dar certo"** — ela mostra o que o estado
  permite e deixa o core recusar com o motivo. Botão sumido não ensina nada;
- **não afirma "em dia" quando a consulta falhou** — `lastError` vira um aviso
  em vermelho. Falhar em perguntar não é estar em dia;
- **não guarda segredo em `localStorage`** — a sessão é o cookie, e o token de
  API nunca chega ao navegador.

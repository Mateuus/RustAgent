# 01 — O overlay de propagandas voltou do agente antigo

> **O que este documento é.** O registro do port do overlay de propagandas de
> `F:\Projects\Rust\RustAgent` (o agente antigo) para este agente, e o mapa de
> onde cada peça foi parar. É registro, e não plano: o trabalho está feito.
>
> **Regra de leitura:** onde este documento e o código discordarem, **o código
> vale** e este documento está vencido. Referências são por nome de arquivo e de
> símbolo, nunca por número de linha — esse apodrece sozinho.

**Escrito em 07/09/2026.** Pedido do dono, na véspera: *"verifique para onde foi
o sistema de propaganda que nós fizemos, talvez esteja no agent antigo"* e *"em
interface vamos criar a do logo que fica no topo da tela centralizado, que é a
logo do OrigemZ"*.

---

## §1 — O que se descobriu antes de mexer em qualquer coisa

Três achados, e o segundo mudou o plano inteiro.

### §1.1 — O sistema estava todo no agente antigo

Nada dele havia sido migrado. Nem um `.ts` deste repositório mencionava `ads`.

### §1.2 — Mas metade do trabalho já estava DESTE lado

`Plugins/OrigemZUI.cs` deste repositório **já tinha o overlay inteiro** — os
comandos `origemz.ads.config`, `.show`, `.hide`, `.test`, o envio de imagem em
pedaços, o toca-discos de quadros. Ele estava órfão: apontava, nos comentários,
para `core/src/game/ads-timeline.ts` e `ads-sync.ts`, que não existiam aqui.

O plugin daqui é **maior** que o do repositório antigo (4.052 linhas contra
3.917) e expõe exatamente os mesmos comandos de propaganda. Ou seja: ele nunca
foi a peça que faltava.

### §1.3 — A logo no alto e ao centro NÃO era peça nova

O pedido do dono descrevia um recurso que já existia — e o próprio plugin deste
repositório o explica, no comentário de `AdsLogoName`:

> Com "logo em lugar proprio" ligado, o agente o pendura direto na CAMADA do
> jogo: a raiz e o retangulo do painel, no canto, e **um logo no alto e ao
> centro** nao cabe dentro dela.

No ajuste isso é `logoDetached: true` + `logoAnchor: 'top-center'`, e
`ADS_LOGO_ANCHORS` traz os nove pontos da tela justamente porque *"no alto e ao
centro é um pedido comum"*.

**Consequência para o plano:** a logo não era um documento a desenhar no editor
de `/interface`. Ela é a peça `logo` do overlay — e trazer o overlay traz a logo
junto. O caminho alternativo (desenhá-la como documento de interface) **não
entregaria o pedido**: todo documento do editor abre por comando de chat, com
cursor liberado e sessão. Ele não fica na tela.

---

## §2 — O que mudou no caminho, e por quê

O port não foi cópia. Três coisas divergiram entre os dois agentes, e cada uma
custou uma decisão.

### §2.1 — zod 3 → zod 4

O agente antigo está em `zod@3`; este, em `zod@4`. Custo real: **zero**. Os
schemas de `types/ads.ts` e `types/ads-transport.ts` compilaram sem uma linha de
mudança.

### §2.2 — O sync deixou de ser um por servidor

No agente antigo, `AdsSyncService` nascia **dentro** do contexto de cada
servidor, com `#serverId` fixo e um `rcon.on('connected')` próprio. Aqui o
contexto de servidor guarda config, RCON e operações, e nada mais — quem fala
com o jogo é um serviço único que recebe o `serverId` em cada chamada.

`AdsSync` foi reescrito nesse molde, que é o do `UiSync` ao lado:

| Antes (um por servidor) | Agora (um só) |
| --- | --- |
| `sync.push('manual')` | `sync.push(serverId, 'manual')` |
| `sync.clearCache()` | `sync.clearCache(serverId)` |
| `rcon.on('connected', …)` no construtor | `handleRconConnected(serverId)`, chamado pelo `index.ts` |
| `createAdsRequestHandler({ pushAds })` | `handleLine(serverId, line)` |

**O que NÃO virou global foi o estado.** Bytes enviados, última carga e cache de
imagem moram num `#stateOf(serverId)`, e isso é obrigatório: o mapa chave→CRC
vive na memória de **cada** plugin. Um cache comum faria o segundo servidor pular
o envio dos bytes que só o primeiro recebeu — e o defeito apareceria como
propaganda em branco, num servidor só, sem erro nenhum no log.

### §2.3 — As rotas ganharam o servidor no caminho

O agente antigo resolvia o servidor num hook de escopo (`serverOf(request)`, em
`http/server-scope.ts`), que este agente não tem. Aqui ele é parâmetro de
caminho, como em `/api/servers/:id/ui`:

```
/api/ads          ->  /api/servers/:serverId/ads
```

E uma escolha que vale registrar: `assertServer` consulta o
**`ServersRepository`**, e não o supervisor.

> **Configurar propaganda não exige o jogo de pé.** O supervisor conhece os
> servidores MONTADOS; usá-lo faria a tela responder 404 para um servidor
> parado — e cadastrar campanha é exatamente o trabalho que se faz com tudo
> desligado, como as regras de loot ao lado. Quem fala com o jogo (`show`,
> `hide`, `test`, `sync`) já recusa sozinho, com 503 e a frase certa.

---

## §3 — Onde cada peça foi parar

### Core

| Arquivo | Estado |
| --- | --- |
| `core/src/types/ads.ts` | cópia, sem mudança |
| `core/src/types/ads-transport.ts` | cópia, sem mudança |
| `core/src/db/ads-repository.ts` | cópia, sem mudança |
| `core/src/game/ads-timeline.ts` | cópia, sem mudança |
| `core/src/game/ads-images.ts` | cópia, sem mudança |
| `core/src/game/ads-sync.ts` | **reescrito** — ver §2.2 |
| `core/src/http/routes/ads.ts` | **reescrito** — ver §2.3 |
| `core/src/db/migrations.ts` | migração **050**, `ads` |
| `core/src/http/server.ts` | as opções `ads` e `adsSync`, e o registro |
| `core/src/index.ts` | instancia, liga ao console e à reconexão, `start`/`stop` |

### Painel

| Arquivo | Estado |
| --- | --- |
| `panel/src/lib/api.ts` | os tipos e quinze chamadas, no objeto `agent` |
| `panel/src/components/ads-page.tsx` | cópia + `serverId` como prop |
| `panel/src/components/ads-preview.tsx` | cópia, só o import mudou |
| `panel/src/lib/ui-doc/presets/ads-overlay.ts` | cópia + o campo `shortcuts` |
| `panel/src/lib/hooks/use-debounced-value.ts` | cópia |
| `panel/src/app/propaganda/page.tsx` | **novo** — a página e o seletor |
| `panel/src/components/sidebar.tsx` | o item, ao lado de Interface |

### Testes

`ads-timeline` e `ads-images` passaram sem tocar em nada. `ads-sync` teve os
construtores adaptados. `ads-routes` ganhou harness novo — um Fastify com as
rotas de propaganda e nada mais, no desenho do `betterloot.test.ts`; subir o
`buildServer` inteiro obrigaria cada teste de propaganda a montar as trinta
dependências do agente para exercitar quinze rotas.

O teste `sem token, 401` saiu junto com o `buildServer`: auth é dele, tem teste
próprio, e repeti-lo aqui não diria nada sobre propaganda. No lugar entrou o que
o harness novo **pode** provar — que um `:serverId` que não existe é 404 com
`UNKNOWN_SERVER`, e não uma violação de chave estrangeira em 500.

**Contagem:** 97 testes de propaganda no core, 11 do preset no painel.

---

## §4 — A migração 050 nasce no estado final

No agente antigo foram **três** migrações até esta forma: a tabela (020), o logo
com lugar próprio (021) e a reconstrução que pôs `server_id` em tudo. Aqui
nenhuma das duas tabelas existiu um dia, então elas nascem prontas.

**A armadilha que isso reproduziu — e o conserto.** A primeira versão desta
migração foi escrita a partir do `ADS_SCHEMA` da 020, sem `server_id`. O
`ads-repository.ts`, que veio da versão final, consulta
`WHERE server_id = ? AND id = 1`.

O erro foi visto e corrigido no arquivo em minutos. **Só que o agente de
desenvolvimento roda em `tsx watch`**, e ele reiniciou sozinho no intervalo: a
migração 050 foi aplicada ao banco local com o SQL errado, e o runner aplica cada
id UMA vez, para sempre. O banco ficou com duas tabelas que o repositório não
sabe ler — e nada acusou, porque ninguém tinha cadastrado propaganda ainda.

O conserto foi possível porque a 050 **ainda não tinha saído desta máquina**:
com o agente parado e um backup do banco em `Backups/`, as duas tabelas foram
apagadas e a linha 50 saiu de `schema_migrations`; o boot seguinte aplicou a
migração de novo, desta vez com o schema do código.

> **Se a 050 já tivesse ido a produção, esse caminho estaria fechado** e o
> conserto teria de ser uma migração 051 reconstruindo as tabelas — que é
> exatamente o que o agente antigo pagou. A lição que fica: um agente em
> `tsx watch` aplica migrações enquanto você escreve, e uma migração recém-criada
> só é editável enquanto nenhum banco a viu.

Não há linha semeada em `ads_settings`, e isso é de propósito: o ajuste é por
servidor, e semeá-lo exigiria saber quais servidores existem no instante da
migração — e teria de acontecer de novo a cada servidor criado depois. Quem
responde por servidor sem linha é o repositório, com o padrão **desligado**;
quem grava usa UPSERT.

---

## §5 — Como pôr a logo do OrigemZ no topo, na prática

Quatro campos na tela **Propaganda**, aba de ajuste:

| Campo | Valor |
| --- | --- |
| Logo — endereço da imagem | a URL da logo do OrigemZ |
| Logo em lugar próprio | **ligado** (`logoDetached`) |
| Âncora da logo | **no alto, ao centro** (`top-center`) |
| Deslocamento X / Y | `0` e `24` (24 px abaixo do topo) |

E o overlay precisa estar **ligado** — ele nasce desligado, de propósito: um
agente recém-instalado não deveria pôr um painel na tela de ninguém.

O que o agente faz com isso está medido em
`core/test/ads-timeline.test.ts`, no caso *"no alto e ao centro, fica centrado na
horizontal"*: a âncora vira `0.5 1` (topo-centro do Unity), a logo ocupa metade
da largura para cada lado do centro, e desce pela margem vertical.

> **O deslocamento no centro NÃO é margem.** Num canto, `24` é a distância até a
> borda. No centro não há borda de onde medir, e o mesmo número passa a
> significar "24 px para o lado" — inclusive negativo. É por isso que
> `logoMarginX`/`logoMarginY` não reaproveitam `marginTop`/`marginRight`.

---

## §6 — O que este port NÃO trouxe

Uma coisa só, e ela é de propósito.

**A logo não é servida por este agente.** O campo é uma URL, e quem a baixa
depende do modo de imagem:

- `stored` (padrão) — o **agente** baixa, valida e manda os bytes ao plugin, que
  os guarda no `FileStorage` do servidor. O cliente pede pelo canal do jogo. Não
  depende de o jogador alcançar a nossa rede;
- `url` — o **cliente** baixa direto do endereço.

Em `stored` a configuração continua sendo por URL. Ou seja: a logo do OrigemZ
precisa estar em algum endereço público **no momento em que o agente a baixa** —
depois disso, não mais.

---

## §7 — As armadilhas que o código já carrega, e que valem repetir

Todas custaram caro no agente antigo. Estão nos comentários dos arquivos, e
estão aqui porque quem for mexer nesta frente passa por elas.

1. **Desligado precisa ser DITO.** Parar de mandar deixa o overlay congelado na
   tela de quem já estava vendo, e nada o tira até o servidor reiniciar. Por isso
   `push` com `enabled: false` manda uma carga vazia em vez de não mandar nada.

2. **Os bytes vêm antes da carga.** Invertido, o primeiro ciclo desenha um
   retângulo vazio no lugar da propaganda.

3. **Carga igual não é reenviada — e isto aconteceu de verdade.** O relógio
   periódico (5 min) e o ciclo do plugin (5 min por padrão) ficaram em cadências
   parecidas, e cada reenvio reiniciava a contagem do lado de lá: a propaganda
   nunca aparecia sozinha. O dedup de `push` é metade do conserto; a outra metade
   é o plugin RETOMAR a contagem em vez de zerá-la.

   `rcon-connected` e `plugin-requested` passam **sempre** — nos dois, o outro
   lado perdeu o que tinha. É por isso que `pushSoon` guarda o motivo mais forte:
   um `periodic` que chega no meio do debounce não pode apagar o
   `rcon-connected` que o abriu.

4. **Recusa, nunca corta.** Passando do teto de 50.000 bytes em base64, o envio é
   recusado inteiro. Meia carga substituiria uma configuração boa por uma
   incompleta, e o defeito apareceria como um overlay travado no meio da
   animação.

5. **O teto de tamanho depende de quem baixa.** 420 KB em `stored` (é por RCON
   que os bytes viajam), 2 MB em `url`. Aplicar o teto do duto a quem não passa
   por ele produzia um erro FALSO na tela: *"a imagem tem 953 KB e o limite é
   420 KB"* numa configuração em que 953 KB está perfeitamente bem.

6. **Uma permissão digitada errado não dá erro nenhum.** `vips` em vez de `vip`
   faz a propaganda não aparecer para ninguém — e isso é indistinguível de
   "ainda não chegou a hora dela". Por isso `GET /ads/audience` busca os nomes no
   Oxide; sem RCON a tela cai no campo livre.

---

## §8 — O que foi provado no ar, e o que não foi

Medido em 07/09/2026, com o agente de pé em `127.0.0.1:8787` e um
`RustDedicated` rodando.

**Provado:**

- a migração 050 aplica e produz o schema do código — `server_id` nas duas
  tabelas, PK composta em `ads_settings`, nenhuma linha semeada;
- o `AdsRepository` grava e lê contra esse banco: o UPSERT do ajuste funciona
  para um servidor que ainda não tinha linha;
- **a logo no alto e ao centro chega ao formato que o jogo entende.** Com
  `logoDetached: true` e `logoAnchor: 'top-center'`, o `buildTimeline` produz
  âncora `0.5 1 → 0.5 1` e offsets `-45 -114` / `45 -24` — 45 px para cada lado
  do centro (a logo tem 90) e 24 px abaixo do topo;
- as rotas estão registradas: `/api/servers/server01/ads` responde 401 (exige
  sessão), e não 404;
- **o agente falou com o plugin.** No boot, o log traz
  `ads overlay is off; plugin told to clear it` — o `AdsSync` montou a carga de
  "desligado" e a mandou pelo RCON. O caminho agente → RCON → plugin está de pé.

**Não provado:**

- **nada foi visto na tela do jogo.** O overlay está desligado (é como ele
  nasce), então o que trafegou foi a carga vazia. Ligar e olhar exige uma URL de
  logo alcançável pelo agente;
- **a maquete no editor de Interface não foi clicada.** O preset
  `ads-overlay.ts` tem os 11 testes dele passando, e os botões "Mandar para o
  editor" / "Trazer do editor" foram religados ao novo par slug ↔ id numérico —
  mas ninguém apertou nenhum dos dois.

---

## §9 — A separação entre o logo e a propaganda

**Escrito em 07/09/2026**, depois do port. Pedido do dono: *"preciso separar o
Logo do servidor da propaganda, um não faz parte do outro"*, *"um painel igual
para ver onde está ficando o logo"* e *"uma configuração que a propaganda só
mostra quando o inventário está aberto e fica ali estática"*.

### §9.1 — Duas perguntas diferentes, e elas não andavam juntas

O pedido do inventário parecia uma coisa só e são duas:

| Pergunta | Onde ela mora |
| --- | --- |
| **Onde** aparece | `layer` — já existia |
| **Como** se comporta | `staticMode` — **novo** |

`Hud.Menu` é a camada em que o Rust põe o inventário: pendurar o overlay ali o
faz aparecer só com o menu aberto, **sem hook nenhum**. O campo `layer` já
aceitava esse valor desde o port; o que faltava era a tela dizer isso em
português em vez de mostrar o nome técnico.

Os dois ficaram **independentes** por escolha do dono, e isso dá as quatro
combinações — inclusive um banner parado sempre visível e o rodízio animado só
dentro do inventário.

### §9.2 — Por que UMA propaganda, e não um rodízio sem animação

Decisão delegada, e a razão fica registrada: **uma sessão de inventário dura
segundos.** Um rodízio de oito segundos dentro dela quase nunca chegaria à
segunda imagem — e custaria um comando de RCON por troca e por grupo de
jogadores, para nada. O giro entre campanhas acontece de uma abertura de
inventário para a seguinte.

No modo estático o painel é desenhado **uma vez**, com a propaganda de maior
prioridade entre as que aquele jogador pode ver, e fica. Depois do primeiro
desenho: zero tráfego.

### §9.3 — O campo que faz a separação valer no jogo

Aqui estava a armadilha, e ela só apareceu ao desenhar a tela.

O logo e o painel eram pendurados na **mesma** camada — `parent:
settings.logoDetached ? settings.layer : ADS_ROOT`, em `ads-timeline.ts`. Pôr a
propaganda em `Hud.Menu` levaria o logo junto, e o servidor ficaria **sem marca
na tela fora do menu** — o oposto do que o dono pediu.

Sem `logoLayer`, as abas seriam cosméticas: as duas coisas continuariam amarradas
por baixo.

`null` = herda a do painel, que é o que sempre aconteceu. Um default concreto
congelaria a escolha de quem já tinha overlay configurado.

### §9.4 — O que mudou, por camada

| Onde | O quê |
| --- | --- |
| migração **051** | `ads_static` e `logo_layer` |
| `types/ads.ts` | `staticMode`, `logoLayer`, e `ADS_LAYERS` escrito uma vez |
| `ads-timeline.ts` | o logo solto usa `logoLayer ?? layer` |
| `ads-transport.ts` | `staticMode` viaja; `logoLayer` **não** — o agente já resolve o `parent` nos quadros |
| `OrigemZUI.cs` | `_adsStatic`, `AdsDrawStatic`, `AdsApplyLastFrame`, e o ciclo que não agenda |
| `ads-page.tsx` | duas abas, cada uma com o seu preview |

**No plugin, o modo estático usa o ÚLTIMO quadro** de `opening` (o painel já
aberto) e o de `adEnter` (a imagem já dentro) — o estado final, sem tocar um
quadro intermediário. É exatamente o que "fica parada" quer dizer, e não exigiu
o agente gerar nada de novo.

Quem obedece o modo é o **plugin**, e não o agente: a fila depende da permissão
de cada jogador, e só o outro lado a conhece.

### §9.5 — A migração 051 foi editada depois de escrita, e isso foi de propósito

`logo_layer` entrou na **mesma** 051 que o `ads_static`, e não numa 052. Foi
possível porque o agente estava **parado** — a 051 não tinha sido aplicada a
banco nenhum. Ver §4: a regra continua valendo, e a exceção é exatamente essa.

O agente foi parado de propósito antes de mexer em migração, pela lição da 050.

### §9.6 — O que foi medido

- o plugin **compila** contra as DLLs reais do `server01` (Roslyn, sem
  Newtonsoft, `-langversion:6`), e o validador foi conferido antes: com um
  método inexistente ele acusa, então o "0 erros" vale alguma coisa;
- as 113 linhas novas do plugin são **ASCII puro** — há três arquivos de teste
  que quebram com um acento sequer;
- 1.858 testes no core, 276 no painel, lint limpo nos dois, build do painel;
- a migração 051 aplicou no banco real e as duas colunas estão lá.

**Não medido:** ninguém abriu o inventário no jogo para ver o painel estático
aparecer. É o mesmo buraco do §8.

### §9.7 — A logo do dono é maior que o teto, e o agente avisa

Encontrado no boot, com a configuração que o dono fez enquanto isto era escrito:

```
WARN: could not prepare the overlay logo; falling back to the client downloading it
      AdImageError: a imagem tem 4048x1735 e o limite é 1920x1080
```

**Ela aparece assim mesmo** — medido: âncora `0.5 1`, camada `Hud`, no alto e ao
centro, como pedido. O que muda é de onde ela vem: recusada pelo `stored`, o
agente cai para a URL e é o **cliente** que baixa.

O preço é real: cada jogador baixa uma imagem de 4048×1735 do
`origemznetwork.com` para desenhá-la em 90×90, e isso depende de ele alcançar
aquele endereço. Redimensionar a logo para algo perto do tamanho de exibição faz
os bytes voltarem a passar pelo canal do jogo.

O teto de 1920×1080 (`ADS_MAX_WIDTH`/`ADS_MAX_HEIGHT`) não tem comentário
dizendo de onde saiu — é um dos poucos números deste módulo sem razão escrita.

---

## §10 — O quadro sem `destroy`, e a cena que fica parada

**07/09/2026.** Reportado pelo dono: clicar em qualquer cena da prévia — *Ciclo
completo*, *Abertura*, *Troca*, *Fechamento* — trocava a tela por **"This page
couldn't load"**.

### §10.1 — A causa: um tipo que mentia

O agente **omite** `destroy` quando não há nada a destruir. É deliberado: são
bytes que não precisam atravessar o RCON, o campo é `destroy?:` em
`ads-timeline.ts`, e o plugin já trata (`destroy != null`).

O painel declarou o campo **obrigatório** e iterou direto:

```ts
for (const name of frame.destroy) {   //  TypeError quando ele nao vem
```

`for...of` sobre `undefined` lança **dentro do render**, e o React derruba a
árvore inteira. A tela não dizia nada; o erro real ficava só no console.

**A decisão que criou isto foi minha, no port.** O painel antigo normalizava a
resposta num `lib/api/parse.ts`; este não tem parsers, e eu segui o estilo local
— *"tipos + chamadas diretas"*. Só que **um tipo não valida nada em tempo de
execução**. Onde os dois lados discordam, quem ganha é o dado.

O conserto foi em três lugares, e o terceiro é o que importa:

1. `applyFrame` tolera `destroy` e `cui` ausentes;
2. `AdsFrame` passa a declará-los opcionais — o tipo diz a verdade;
3. **a cópia local do tipo do quadro, dentro do `ads-preview.tsx`, foi apagada.**
   Era ela que discordava do contrato. Duas declarações do mesmo dado divergem; o
   preview passou a usar `AdsFrame`.

Só o item 3 impede a próxima divergência — e foi ele que, ao ser feito, revelou
os outros dois pontos que assumiam o campo presente.

### §10.2 — O teste guarda a FORMA, não a chamada

`panel/test/ads-preview-frame.test.ts`, e `applyFrame` foi exportada só para ele.

O defeito não aparecia em nenhuma chamada de API, nenhuma rota e nenhum tipo:
dependia da **forma** de um quadro. Antes de confiar no teste, o conserto foi
revertido de propósito e ele falhou com a frase certa — `TypeError:
frame.destroy is not iterable` —, que é exatamente o que derrubava a página.

### §10.3 — A cena "Parado"

Pedido do dono, na mesma mensagem: *"eu preciso que fique para eu encaixar na
posição certa, eu vou vendo a prévia e vou encaixando no lugar certo"*.

As cenas existentes **tocam e voltam ao repouso**. Para conferir uma animação
está certo; para ajustar uma margem é inútil — o painel some antes de a pessoa
terminar de olhar, e cada tentativa exige clicar de novo.

`parado` desenha o **estado final e fica**: só o último quadro de `opening` mais
o último de `adEnter`, com o `at` zerado. É o mesmo atalho que o plugin usa no
modo estático (`AdsApplyLastFrame`), então a prévia mostra literalmente o que o
jogo desenha.

Ela é o **primeiro** botão da lista, e a aba da Propaganda **abre nela** quando o
modo estático está ligado — não faz sentido abrir numa animação que o servidor
não toca.

> **Uma hora, e não "para sempre".** `setTimeout` não tem infinito, e um número
> grande demais transborda para 1 ms em alguns navegadores. Ao fim da hora a
> prévia volta ao repouso, e nada quebra.

---

## §11 — Arrastar o painel na prévia

**07/09/2026.** Pedido do dono: *"no menu pré-visualização eu tenho que conseguir
arrastar o painel"*.

Digitar número para encaixar uma margem é um laço de tentativa e erro: escreve
220, olha, apaga, escreve 180. Arrastar fecha o laço — a pessoa vê onde está
pondo enquanto põe.

### §11.1 — A alça não move nada

O elemento continua sendo posicionado pelo caminho de sempre: **ajuste → agente →
quadros → prévia**. A alça só traduz o arrasto em MARGEM e devolve pela `onMove`;
quem redesenha é o ciclo inteiro.

É por isso que o que se vê arrastando é exatamente o que vai ao jogo. A
alternativa — mover o `div` localmente e "sincronizar depois" — daria uma prévia
que mente enquanto o dedo está na tela.

E o arrasto grava no **rascunho**, como qualquer campo: o botão *Salvar* continua
sendo quem manda ao servidor.

### §11.2 — Só a raiz e o logo se arrastam

São os dois que têm margem própria no ajuste. Os filhos (painel, borda, slot) são
desenhados em relação à raiz — arrastar um deles não teria onde ser gravado. O
logo só quando estiver **solto**: preso ao painel ele acompanha o canto.

### §11.3 — O sinal da margem, e por que ele tem teste

`panPanel` e `panLogo` são funções puras, e há 19 casos sobre elas.

> **Um sinal trocado não quebra nada — e esse é o problema.** Não dá erro, não
> aparece em teste de tipo, não derruba página nenhuma: o elemento só anda para o
> lado **contrário** do dedo. Quem está ajustando acha que errou a mão, corrige na
> direção errada, e o defeito vira "essa tela é estranha" em vez de um bug que
> alguém relata.

O mesmo campo muda de significado conforme o canto: `marginRight` mede até a
borda **direita** em `bottom-right` e até a **esquerda** em `bottom-left`. E
`marginTop`, num canto de baixo, mede até o **fundo** — enquanto `dy` do CSS
cresce para baixo. São quatro chances de inverter um sinal.

O último bloco do teste é o que vale: para os quatro cantos, ele converte a
margem de volta em posição de tela e exige que **arrastar para um lado leve o
elemento para aquele lado**. Onde a margem cresce ou encolhe para isso acontecer
é detalhe da geometria; o que o teste guarda é o que a pessoa sente.

`MARGIN_SIGNS` e `logoSigns` espelham `cornerOf` e `detachedOffsets` do agente.
Se aqueles mudarem, é este arquivo de teste que avisa.

### §11.4 — A dica aparece só sob o cursor

Uma alça invisível é uma alça que ninguém descobre; um contorno permanente
mentiria sobre o que o jogo desenha. O meio-termo é o tracejado no hover: quem
passa o mouse vê que aquilo se move, e a captura de tela continua limpa.

O arrasto também **não passa do teto** que o agente aceita (400 px para o painel).
Sem o limite, um arrasto longo gravaria um ajuste que volta 400 do agente — e o
erro apareceria num toast, sem ligação com o arrasto que o causou.

---

## §12 — `Hud.Menu` não é a camada do inventário

**07/09/2026, medido no jogo pelo dono:** com `layer: 'Hud.Menu'`, a propaganda
aparecia **com o inventário fechado**.

### §12.1 — A premissa errada, e de onde ela veio

O §9.1 deste documento afirmava que `Hud.Menu` era a camada do inventário. Veio
de duas coisas que se reforçaram: o **nome** da camada, e uma busca na web que
respondeu *"Hud.Menu is the layer where Rust positions menus like your
inventory"*. As duas descrevem a ORDEM DE DESENHO — onde o menu é posicionado na
pilha —, e não o CICLO DE VIDA do container.

`Hud.Menu` está sempre na tela. Ela é o HUD, um degrau acima.

### §12.2 — A resposta já estava escrita neste repositório

`UI_LAYERS`, em `core/src/types/ui-document.ts`:

> O jogo tem outras (**Inventory**, Crafting, Map…), mas elas só existem enquanto
> aquela tela está aberta — pendurar um menu nelas o faria sumir quando o jogador
> fechasse o inventário, **que não é comportamento que alguém queira por engano**.

Esse comentário foi lido no início desta frente e não foi conectado ao pedido.
Ele descreve exatamente o recurso desejado — listado como armadilha, porque para
um **menu** é armadilha. Para o overlay é o mecanismo.

> **A lição:** ao procurar como o jogo se comporta, ler primeiro o que este
> repositório já mediu. O comentário de um `const` valeu mais que a busca.

### §12.3 — Dois enums, e por quê

`ADS_LAYERS` deixou de espelhar `UI_LAYERS` e passou a ter dois grupos:

| Grupo | Camadas | Ciclo de vida |
| --- | --- | --- |
| `ADS_ALWAYS_LAYERS` | Overall, Overlay, Hud.Menu, Hud, Under | ficam na tela |
| `ADS_SCREEN_LAYERS` | Inventory, Crafting, Map | só enquanto aquela tela está aberta |

Os documentos de `/interface` continuam com as cinco: lá a armadilha continua
sendo armadilha, e um menu que some ao fechar o inventário não é o que alguém
quer por engano.

### §12.4 — Elas falham em SILÊNCIO, e isso muda o que a tela precisa dizer

Quem resolve o `parent` é o **CLIENTE**, por nome, na hierarquia de UI do jogo.

Isso tem uma consequência que atrapalhou o diagnóstico: **o servidor nunca vê
esses objetos.** Nenhum comando de plugin consegue listá-los — a UI existe na
máquina de quem joga. Procurar os nomes no `Assembly-CSharp.dll` também não
resolve: `Hud.Menu` não aparece lá, porque a hierarquia vem dos *bundles*.

**A única fonte é abrir o jogo e olhar.**

E um nome que o Rust renomeie num update não dá erro nenhum: o overlay
simplesmente não desenha. Por isso a tela avisa quando uma dessas camadas está
escolhida, e diz como voltar para `Hud` em um clique.

### §12.5 — O teste que guardava a regra antiga

`ads-routes.test.ts` recusava `layer: 'Inventory'` — e estava certo enquanto a
regra era a do menu. Ele foi atualizado, e ganhou o caso oposto: as três camadas
de tela agora são aceitas, e o que continua recusado é um nome que o jogo não
conhece.

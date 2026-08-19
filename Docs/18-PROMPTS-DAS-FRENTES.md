# 18 — Os prompts, um por frente

Dez blocos prontos para copiar e colar, um por agente. O contexto de cada um está
nos documentos [16](16-PLANO-WIPE-CALENDARIO-MENSAGENS.md) e
[17](17-FRENTES-WIPE-E-MENSAGENS.md), e cada prompt manda o agente lê-los.

**A Frente 0 vai sozinha, primeiro.** As outras nove podem começar assim que ela
estiver na branch base — respeitando as dependências do grafo do doc 17.

| Onda | Frentes que rodam em paralelo |
|---|---|
| 1ª | **0** (sozinha) |
| 2ª | **A**, **B**, **C**, **E** |
| 3ª | **G**, **H** (depois de A e C) |
| 4ª | **D** (depois de A e C) |
| 5ª | **F** (depois de A e E), **I** (depois de A e D) |

---

## FRENTE 0 — Os tipos compartilhados

```
Você vai abrir a fase de WIPE, CALENDÁRIO e MENSAGENS do RustAgent
(F:\Projects\RustAgent — Windows, Node 20+, npm workspaces: `core` =
Fastify/TypeScript, `panel` = Next.js em export estático).

Leia primeiro, inteiros:
  Docs/16-PLANO-WIPE-CALENDARIO-MENSAGENS.md
  Docs/17-FRENTES-WIPE-E-MENSAGENS.md
  Docs/02-ARQUITETURA.md e Docs/03-DECISOES.md

Sua tarefa é o COMMIT ZERO: os contratos que as outras nove frentes vão compilar
contra. NADA de implementação, banco, rota ou tela.

Crie:
  core/src/types/wipe.ts       BpPolicy, CollisionPolicy, WipeCadenceSettings,
                               WipeSettings, PlannedWipe, WipePlan, WipeRunStep,
                               WipeRunStatus, MapPoolEntry, MapSource
  core/src/types/messages.ts   ScheduleKind, MessageView, MessageInput,
                               MessageTarget, BroadcastInput, BroadcastResult
  core/src/game/broadcast.ts   SÓ a interface `Broadcaster` e o tipo do resultado
                               ({ sent: number; via: 'plugin' | 'say' }).
                               A implementação é da Frente E.

Regras:
- os campos e os nomes saem do Docs/16 §7 (modelo de dados) e §10 (mensagens);
- datas são epoch ms (number). Horário local é string 'HH:MM' MAIS a zona IANA,
  nunca um instante com fuso embutido;
- tudo `readonly`, no estilo de core/src/types/ui-document.ts;
- cada tipo com um comentário de UMA linha dizendo o que ele significa no
  produto, não o que ele é em TypeScript;
- estas interfaces NÃO MUDAM depois de publicadas. Se algo estiver ambíguo,
  escreva a dúvida no resumo em vez de escolher em silêncio.

Termine com `npm run typecheck` verde e um resumo com: os tipos criados, e
qualquer decisão que você teve de tomar sozinho.
```

---

## FRENTE A — A agenda do wipe (núcleo)

```
Projeto: F:\Projects\RustAgent (Node 20+, npm workspaces: core = Fastify/TS,
panel = Next.js estático). Você é a FRENTE A da fase de wipe.

Leia, nesta ordem:
  Docs/16-PLANO-WIPE-CALENDARIO-MENSAGENS.md   (inteiro — especialmente §5 e §7)
  Docs/17-FRENTES-WIPE-E-MENSAGENS.md          (§0, §10 e a "Frente A")
  Docs/03-DECISOES.md e Docs/06-API.md
No código: core/src/db/migrations.ts (o mecanismo), core/src/db/kits-repository.ts
(o padrão de repositório), core/src/http/routes/kits.ts (o padrão de rota e erro).

E ESTUDE o projeto anterior, em F:\Projects\Rust:
  Docs/OrigemZWipe/PLANO.md                       §2 e §14 (a pesquisa)
  RustAgent/core/src/wipe/schedule.ts             PORTE quase inteiro
  RustAgent/core/src/db/wipe-schedule-repository.ts
  RustAgent/core/src/http/routes/wipe.ts
Portar NÃO é copiar: aqui as datas são epoch ms INTEGER, todo repositório recebe
`serverId` na assinatura, e erro é ApiError com código.

CONSTRUA:
  core/src/wipe/schedule.ts               cálculo puro: forçado (1ª quinta,
                                          19:00 UTC), cadência com fuso IANA,
                                          e as 3 políticas de colisão
  core/src/db/wipe-schedule-repository.ts a agenda MATERIALIZADA + reconciliação
  core/src/http/routes/wipe.ts            settings, plans, upcoming
  core/test/wipe-schedule.test.ts e core/test/wipe-plans.test.ts

TOQUE, só por anexação no fim do bloco:
  core/src/db/migrations.ts   -> migração 23, nome 'wipe-schedule'  (É SUA. NÃO
                                 use outro número, mesmo que 23 pareça ocupado)
  core/src/http/server.ts     -> registrar as rotas
  core/src/index.ts           -> materializar a agenda no boot

REGRAS QUE NÃO SE NEGOCIAM:
1. O wipe forçado NUNCA é pulado: DELETE num plano 'forced' responde 409 com
   explicação, e não 204 silencioso.
2. NADA de tabela de datas de force wipe. A regra é derivada em ~10 linhas.
3. `generated_for` é obrigatório em linha gerada — sem ela, adiar um wipe cria um
   SEGUNDO wipe na próxima reconciliação.
4. A reconciliação nunca toca no passado e nunca reescreve linha `pinned`.
5. A cadência nasce DESLIGADA.
6. Tudo gravado em epoch ms UTC; o fuso é da exibição e do agendamento.
7. Esta frente NÃO EXECUTA NADA: não para servidor, não apaga arquivo, não manda
   RCON.

ACEITE: GET /api/servers/server01/wipe/plans lista forçados e cadência na ordem,
com o absorvido MARCADO (não sumido); trocar everyDays reescreve o gerado e
preserva o adiado à mão; teste de fuso atravessando mudança de offset; teste do
forçado em dezembro. `npm test -w core` e `npm run typecheck` verdes.
```

---

## FRENTE B — A aba WIPE no painel (Geral + Agenda)

```
Projeto: F:\Projects\RustAgent. Você é a FRENTE B da fase de wipe: a TELA.

Leia:
  Docs/16-PLANO-WIPE-CALENDARIO-MENSAGENS.md   (inteiro; os mockups estão em §9.1)
  Docs/17-FRENTES-WIPE-E-MENSAGENS.md          (§0, §10 e a "Frente B")
  Docs/07-PAINEL.md
No código: panel/src/app/servidor/page.tsx (o padrão de abas),
panel/src/components/server-settings.tsx, panel/src/components/state-block.tsx,
panel/src/components/section.tsx, panel/src/app/kits/page.tsx.
No projeto anterior: F:\Projects\Rust\RustAgent\panel\src\components\wipe-page.tsx
(1.350 linhas — o DESENHO se aproveita; os componentes e o CSS são outros).

Você compila contra core/src/types/wipe.ts (Frente 0). Se a API ainda não
responder, trabalhe contra os tipos e um mock local — NÃO invente campos.

CONSTRUA:
  panel/src/components/wipe/wipe-panel.tsx      a casca e as sub-abas
  panel/src/components/wipe/tab-geral.tsx
  panel/src/components/wipe/tab-agenda.tsx
  panel/src/components/wipe/calendar-month.tsx  O COMPONENTE DE CALENDÁRIO
  panel/src/components/wipe/use-agent-clock.ts

TOQUE, por anexação:
  panel/src/app/servidor/page.tsx   -> uma entrada em TABS: 'wipe', rótulo
                                       "WIPE", ícone CalendarClock, ENTRE 'menu'
                                       e 'config' + a linha de render
  panel/src/lib/api.ts              -> os métodos novos, no fim

AS SUB-ABAS SÃO SEIS — Geral, Agenda, Mapas, Blueprints, Configuração, Execução.
VOCÊ CRIA A CASCA COM AS SEIS, e monta só Geral e Agenda. As outras quatro são de
outras frentes (C, I, D): deixe o ponto de montagem pronto e, enquanto vazio,
mostre um StateBlock dizendo que aquela parte ainda está sendo construída.

REGRAS:
1. A contagem regressiva sai do RELÓGIO DO AGENTE (a resposta traz `now`),
   corrigido pela diferença para o relógio local.
2. ENQUANTO A FRENTE D NÃO ENTRAR: uma faixa no topo da Geral dizendo que esta
   tela ainda não executa wipe, e o botão "WIPAR AGORA" NÃO EXISTE.
3. calendar-month.tsx NÃO conhece wipe. Ele recebe
   `{ at: number; kind: string; label: string; tone: 'rust'|'amber'|'olive'|'muted' }[]`.
   É o mesmo componente que a tela de eventos vai usar depois.
4. A tela abre sem quebrar com: servidor parado, RCON caído, agenda vazia. Cada
   caso tem o seu StateBlock com uma frase que diz o que fazer.
5. Nada de biblioteca de calendário nova — o painel não tem uma, e não vai ter.

ACEITE: a aba abre nos três estados ruins; salvar a cadência reflete na grade sem
recarregar; a grade navega ‹ › e volta com "hoje". `npm run typecheck -w panel` e
`npm run lint -w panel` verdes.
```

---

## FRENTE C — A fila de mapas e o SERVER_LEVELURL

```
Projeto: F:\Projects\RustAgent. Você é a FRENTE C da fase de wipe.

Leia:
  Docs/16-PLANO-WIPE-CALENDARIO-MENSAGENS.md   (inteiro; §9.1 sub-aba Mapas)
  Docs/17-FRENTES-WIPE-E-MENSAGENS.md          (§0, §10 e a "Frente C")
No código: core/src/db/kits-repository.ts (padrão de repositório),
core/src/servers/supervisor.ts (updateSettings e KEY_OF),
core/src/ops/server-process.ts (buildArgs), core/src/config.ts (ServerConfig),
Configs/server.example.ini.
No projeto anterior: F:\Projects\Rust\RustAgent\core\src\db\map-pool-repository.ts
e Docs/OrigemZWipe/PLANO.md §5.

CONSTRUA:
  core/src/wipe/map-pool.ts             sorteio e validação (seed, tamanho, URL)
  core/src/db/map-pool-repository.ts
  core/src/http/routes/wipe-maps.ts
  core/test/wipe-map-pool.test.ts
  panel/src/components/wipe/tab-mapas.tsx

TOQUE, por anexação:
  core/src/db/migrations.ts   -> migração 24, nome 'wipe-map-pool'  (É SUA)
  core/src/http/server.ts, panel/src/lib/api.ts
  panel/src/components/wipe/wipe-panel.tsx  -> montar a sub-aba Mapas
        (se o arquivo ainda não existir, CRIE-O com as seis sub-abas e avise no
         resumo — a Frente B faz o mesmo, e quem chegar primeiro cria)

E A ÚNICA MUDANÇA FORA DO WIPE, que é só sua — a chave SERVER_LEVELURL:
  Configs/server.example.ini        SERVER_LEVELURL= (com o comentário)
  core/src/config.ts                levelUrl no ServerConfig (vazio = procedural)
  core/src/servers/supervisor.ts    levelUrl: 'SERVER_LEVELURL' no KEY_OF, e em
                                    RESTART_KEYS
  core/src/ops/server-process.ts    +server.levelurl no buildArgs, SÓ quando não
                                    vazio (o jogo ignora convar sem sentido em
                                    silêncio — veja o comentário da "senha de
                                    servidor" em config.ts)

CRIE TAMBÉM, na migração 24, as colunas que a Frente H (RustMaps) vai preencher e
que você NÃO usa: rustmaps_id, staging, preview_url, thumb_url, monuments,
last_error, e o status 'generating'. Ela não pode escrever migração.

REGRAS:
1. `reorder` recebe A FILA INTEIRA, nunca "mova para cima".
2. Índice único PARCIAL (server_id, seed, world_size) WHERE status <> 'used'.
3. Seed jogada nos últimos 6 wipes: AVISO, não recusa.
4. Fila vazia nunca bloqueia wipe: o agente sorteia, e registra que sorteou.
5. O sorteio evita o que está na fila E o que os últimos 6 wipes usaram.
6. Mapa custom é aceito COM TRAVA: HEAD na URL (responde? é .map? tamanho?) antes
   de entrar na fila, e entrada `custom` não pode ser consumida por wipe FORÇADO
   sem a marca explícita "compatível com a versão nova".
7. worldSize 1000..6000; level em Procedural Map, Barren, HapisIsland,
   Craggy Island.

ACEITE: seed repetida na fila é recusada, e a mesma seed depois de 'used' é
aceita; fila vazia responde uma seed sorteada e diz que sorteou; reorder com duas
abas termina inteiro; um servidor com SERVER_LEVELURL vazio sobe exatamente com
os mesmos argumentos de hoje. `npm test -w core` e `npm run typecheck` verdes.
```

---

## FRENTE D — A execução do wipe (a que apaga arquivo)

```
Projeto: F:\Projects\RustAgent. Você é a FRENTE D: a que APAGA ARQUIVO. Entre com
cuidado — esta é a operação que zera o trabalho de todos os jogadores.

Leia:
  Docs/16-PLANO-WIPE-CALENDARIO-MENSAGENS.md   (inteiro; §4, §6, §9.1 e §13)
  Docs/17-FRENTES-WIPE-E-MENSAGENS.md          (§0, §10 e a "Frente D")
  Docs/05-OPERACOES.md
No código: core/src/ops/operations.ts, core/src/ops/service.ts (o #countdown, o
#say, o #stop e o #start), core/src/ops/server-process.ts,
core/src/servers/supervisor.ts (updateSettings), core/src/game/wipe.ts
(WipeClock), core/src/util/zip.ts.
No projeto anterior: F:\Projects\Rust\RustAgent\core\src\wipe\save-files.ts e
preview.ts, e Docs/OrigemZWipe/PLANO.md §1, §4 e §13.

E CONFIRA COM OS PRÓPRIOS OLHOS o que existe em
Servers\server01\server\server01\ antes de escrever um glob.

CONSTRUA:
  core/src/wipe/save-files.ts       quais arquivos, por política (map/BP/full)
  core/src/wipe/plugin-data.ts      o full wipe: o que existe em oxide\data
  core/src/wipe/preview.ts          "o que este wipe vai apagar", lendo o disco
  core/src/wipe/backup.ts           zip do save, poda dos antigos, checagem de espaço
  core/src/wipe/run.ts              A MÁQUINA DE PASSOS
  core/src/wipe/scheduler.ts        o relógio que dispara o plano vencido
  core/src/db/wipe-runs-repository.ts, core/src/db/wipes-repository.ts
  core/src/http/routes/wipe-runs.ts
  core/test/wipe-save-files.test.ts, wipe-plugin-data.test.ts, wipe-run.test.ts
  panel/src/components/wipe/tab-execucao.tsx
  panel/src/components/wipe/tab-configuracao.tsx

TOQUE, por anexação:
  core/src/db/migrations.ts   -> migração 25, nome 'wipe-runs'  (É SUA)
  core/src/ops/operations.ts  -> UMA entrada em OPERATION_KINDS: 'wipe-run'
  core/src/ops/service.ts     -> o case no #execute e as pré-condições
  core/src/game/wipe.ts       -> UMA linha: forget() ao terminar o wipe
  core/src/http/server.ts, core/src/index.ts, panel/src/lib/api.ts,
  panel/src/components/wipe/wipe-panel.tsx

OS PASSOS: avisar > esvaziar > parar > backup > apagar > configurar > subir >
pós-wipe. Cada um grava started/finished/status/mensagem em wipe_run_steps.

REGRAS QUE NÃO SE NEGOCIAM:
1. TODO PASSO É IDEMPOTENTE. Apagar num diretório já limpo é sucesso, não erro —
   é isso que torna `resume` seguro.
2. O glob é por PREFIXO, nunca nome fixo: o número no nome é a versão do FORMATO
   (em server01 convivem `16` e `287`), e o `-wal` some junto com o `.db`.
3. O espaço em disco é conferido ANTES de parar o servidor. Falhar o backup com o
   servidor já parado é o pior desfecho.
4. `parar` usa `quit` pelo RCON (que salva antes de sair). `force` só quando o
   operador pediu, e com o aviso na tela.
5. `configurar` chama supervisor.updateSettings — NUNCA escreva o .ini direto.
6. FULL WIPE: nada vem marcado por padrão; a lista é montada do que existe DE
   VERDADE em disco (GET /wipe/plugin-data) e o admin escolhe item a item. Nunca
   `del *.json` — o OrigemZVip.json é o VIP que alguém pagou.
7. POST /wipe/runs exige Idempotency-Key E o `identity` do servidor digitado no
   corpo. Um duplo-clique não pode zerar o servidor duas vezes.
8. No boot, wipe_run 'running' sem operação viva vira 'failed' com "o agente
   reiniciou no meio desta execução", e a tela oferece retomar.
9. Um aviso perdido NÃO derruba o wipe; um backup perdido derruba.

ACEITE (num servidor de teste, nunca em produção): wipe com política 'keep' troca
o mundo e mantém player.blueprints.*; com 'wipe' eles e os -wal somem; matar o
agente no passo `apagar` e subir de novo mostra 'failed' e o resume conclui sem
apagar um mundo NOVO; o zip do backup abre com o .sav dentro; a sub-aba Execução
mostra os passos ao vivo e o log com cursor. `npm test -w core` verde.
```

---

## FRENTE E — Mensagens (o agendador de falas)

```
Projeto: F:\Projects\RustAgent. Você é a FRENTE E: o item MENSAGENS da barra
lateral, e o motor que faz o servidor falar sozinho.

Leia:
  Docs/16-PLANO-WIPE-CALENDARIO-MENSAGENS.md   (inteiro; §9.2 e §10 são seus)
  Docs/17-FRENTES-WIPE-E-MENSAGENS.md          (§0, §10 e a "Frente E")
No código: Plugins/OrigemZChat.cs (o comando origemz.chat.broadcast e o JSON que
ele aceita — leia o bloco de comentário inteiro), core/src/game/chat.ts,
core/src/players/presence.ts, core/src/db/kits-repository.ts (padrão de
repositório), panel/src/app/kits/page.tsx e panel/src/components/kit-dialog.tsx
(padrão de tela de rede e de diálogo), panel/src/components/sidebar.tsx.
No projeto anterior: F:\Projects\Rust\RustAgent\core\src\game\announcements.ts e
core/src/db/announcements-repository.ts — INSPIRAÇÃO, não porte: lá era um rodízio
com um intervalo só; aqui cada mensagem tem o seu ritmo.

CONSTRUA:
  core/src/game/broadcast.ts        A IMPLEMENTAÇÃO do Broadcaster (a interface
                                    veio da Frente 0). É contrato público: as
                                    Frentes D e F dependem dela
  core/src/messages/schedule.ts     quando é a próxima (interval/daily/weekly/once)
  core/src/messages/variables.ts    {servidor} {online} {max} … + o REGISTRO de
                                    provedores (a Frente F registra o {wipe.*})
  core/src/messages/service.ts      o relógio de 30 s
  core/src/db/messages-repository.ts
  core/src/http/routes/messages.ts
  core/test/messages-schedule.test.ts, core/test/messages-service.test.ts
  panel/src/app/mensagens/page.tsx
  panel/src/components/message-dialog.tsx

TOQUE, por anexação:
  core/src/db/migrations.ts   -> migração 26, nome 'messages'  (É SUA)
  core/src/http/server.ts, core/src/index.ts, panel/src/lib/api.ts
  panel/src/components/sidebar.tsx -> uma entrada em NAV: '/mensagens/',
                                      "Mensagens", ícone Megaphone, ENTRE Loja e
                                      Interface

REGRAS QUE NÃO SE NEGOCIAM:
1. O tick NUNCA LANÇA. Rodando num setInterval, uma exceção sem dono mata o laço e
   as mensagens param EM SILÊNCIO.
2. RCON offline e servidor vazio NÃO consomem o horário: next_at fica como está, e
   a próxima volta tenta de novo.
3. last_sent_at só é gravado DEPOIS da entrega confirmada.
4. A janela pode virar a meia-noite ("das 22:00 às 02:00"). A comparação ingênua
   `de <= agora && agora <= ate` faria a mensagem nunca sair, sem dizer por quê.
5. "A cada 7 dias" conta DIAS DE CALENDÁRIO, não 604800 s. Use as funções de fuso
   de core/src/wipe/schedule.ts (Frente A) — não escreva as suas.
6. Variável desconhecida fica LITERAL no texto. Nunca vira string vazia.
7. origemz.chat.broadcast leva BASE64: JSON cru pelo RCON chega ao plugin com as
   aspas comidas.
8. Fallback para `say` quando o OrigemZChat não responde, e o campo `via` da
   resposta diz qual caminho foi usado.

ACEITE: "a cada 30 min" anda de 30 em 30 sem deriva; "toda quinta às 16:00"
atravessa a virada de mês; "uma vez em <data>" sai uma vez e se desliga; com o
RCON desligado nada é marcado como enviado e ao voltar a mensagem sai; o botão
"testar agora" sai no chat SEM mexer no next_at; o message_log responde "essa
mensagem está mesmo aparecendo?". `npm test -w core` e `npm run typecheck` verdes.
```

---

## FRENTE F — Os avisos de wipe (a ponte)

```
Projeto: F:\Projects\RustAgent. Você é a FRENTE F: a ponte entre o wipe e as
mensagens. Frente pequena, e ela só faz sentido com as Frentes A e E já na árvore.

Leia:
  Docs/16-PLANO-WIPE-CALENDARIO-MENSAGENS.md   (§10 e §11 são seus)
  Docs/17-FRENTES-WIPE-E-MENSAGENS.md          (§0, §10 e a "Frente F")
No código: core/src/game/broadcast.ts e core/src/messages/variables.ts (Frente E),
core/src/wipe/schedule.ts (Frente A), core/src/wipe/run.ts (Frente D),
core/src/ops/service.ts (o #countdown do server-auto-update — o padrão de contagem
regressiva que já existe e funciona).

CONSTRUA:
  core/src/wipe/announce.ts             os offsets viram falas, pelo Broadcaster
  core/src/messages/providers/wipe.ts   o provedor das variáveis {wipe.*}
  core/test/wipe-announce.test.ts

TOQUE:
  core/src/index.ts                  -> registrar o provedor
  core/src/wipe/run.ts               -> o passo `avisar` chama o announce
  panel/.../tab-configuracao.tsx     -> os offsets e o texto do aviso

AS VARIÁVEIS: {wipe.faltam} {wipe.quando} {wipe.mapa} {wipe.bp}

REGRAS:
1. Um aviso perdido NÃO derruba o wipe. Avisar é melhor-esforço; apagar não é.
2. O aviso não é reenviado se o agente reiniciar entre dois offsets — a marca fica
   em wipe_run_steps.
3. {wipe.faltam} num servidor SEM agenda devolve "sem wipe agendado", nunca string
   vazia.
4. O texto é template do admin e a FORMATAÇÃO É DO PLUGIN: o agente manda o texto
   cru mais a aparência. Formatar dos dois lados cria duas verdades sobre como um
   aviso se parece.
5. Você NÃO cria migração, NÃO cria rota e NÃO inventa um segundo caminho de
   envio: o Broadcaster da Frente E é o único.

ACEITE: um wipe manual daqui a 3 minutos com offsets [2 min, 1 min] produz as duas
falas no chat, na hora; uma mensagem do admin com {wipe.faltam} mostra o mesmo
número que a aba Geral. `npm test -w core` verde.
```

---

## FRENTE G — O calendário dentro do jogo

```
Projeto: F:\Projects\RustAgent. Você é a FRENTE G: a página CALENDÁRIO do menu
in-game, que hoje diz "Wipes e eventos programados entram aqui".

Leia:
  Docs/16-PLANO-WIPE-CALENDARIO-MENSAGENS.md   (inteiro; §9.3 e §12 são seus)
  Docs/17-FRENTES-WIPE-E-MENSAGENS.md          (§0, §10 e a "Frente G")
  Docs/14-BRIEFING-ITENS-E-INTERFACE.md
No código, e leia os CABEÇALHOS deles inteiros:
  core/src/game/ui-kits-screen.ts        O PADRÃO A COPIAR, linha por linha
  core/src/game/ui-sync.ts               generatedScreens
  core/src/game/ui-widgets.ts            os construtores compartilhados
  core/src/game/ui-preset-main-menu.ts   onde a nav 'calendario' já existe
  core/src/db/vips-repository.ts         os tiers
  core/src/index.ts                      como a tela de kits foi registrada

CONSTRUA:
  core/src/game/ui-calendar-screen.ts
  core/test/ui-calendar.test.ts

TOQUE, por anexação:
  core/src/index.ts            -> registrar em generatedScreens, ao lado dos kits
  core/src/db/migrations.ts    -> migração 27, nome 'events'  (É SUA — SÓ A
                                  TABELA, sem rota e sem tela: ela existe agora
                                  para o calendário não precisar ser refeito
                                  quando eventos entrarem)
  core/src/http/routes/wipe.ts -> GET /wipe/upcoming/me, recortado pelo tier

REGRAS:
1. `volatile: true` no pacote. A tela mostra "faltam 6d 04h" — em cache ela
   mostraria as mesmas seis horas para sempre, e o jogador confiaria naquilo.
2. Os construtores vêm de ui-widgets.ts. NÃO copie widget: duas cópias divergem no
   primeiro ajuste.
3. A RÉGUA DO VIP: sem VIP/bronze vê a data e a política de BP; silver vê também o
   mapa #1 (tamanho e imagem, SEM a seed); gold vê os três próximos.
4. O que o jogador não pode ver NÃO ATRAVESSA O RCON. Recortar só na hora de
   desenhar deixaria a seed viajar na payload.
5. Servidor sem agenda: a tela diz "sem wipe agendado". Ela nunca abre vazia.
6. NÃO desenhe a tela de EVENTOS — só a tabela dela entra nesta frente.

ACEITE: /menu -> CALENDÁRIO abre com a agenda real e reabre com o número
atualizado; sem agenda mostra a frase certa; um jogador sem VIP não recebe a seed
na payload (confira o comando enviado, não só a tela). `npm test -w core` verde.
```

---

## FRENTE H — RustMaps

```
Projeto: F:\Projects\RustAgent. Você é a FRENTE H: a prévia do mapa. Depende da
Frente C (a fila de mapas e as colunas), que já deve estar na árvore.

Leia:
  Docs/16-PLANO-WIPE-CALENDARIO-MENSAGENS.md   (§9.1, sub-aba Mapas, e o bloco do
                                                STAGING)
  Docs/17-FRENTES-WIPE-E-MENSAGENS.md          (§0, §10 e a "Frente H")
  F:\Projects\Rust\Docs\OrigemZWipe\PLANO.md   §5.3 (a pesquisa sobre a API, os
                                                códigos e a pegadinha do staging)
No código: core/src/db/map-pool-repository.ts (Frente C),
core/src/steam/update-watcher.ts (o padrão de relógio que consulta um serviço de
fora e nunca derruba nada), core/src/http/error-response.ts.

CONSTRUA:
  core/src/wipe/rustmaps.ts        o cliente: pedir, guardar o mapId, ler as URLs
  core/src/wipe/rustmaps-poll.ts   o relógio que acompanha o que está 'generating'
  core/src/http/routes/rustmaps.ts status da chave + gerar sob demanda
  core/test/rustmaps.test.ts       contra respostas GRAVADAS em fixtures

TOQUE, por anexação:
  core/src/http/server.ts, core/src/index.ts, panel/src/lib/api.ts
  panel/.../tab-mapas.tsx   -> o cartão com a imagem e o bloco RUSTMAPS
  .env.example              -> RUSTMAPS_API_KEY, documentada

VOCÊ NÃO ESCREVE MIGRAÇÃO. As colunas (rustmaps_id, staging, preview_url,
thumb_url, monuments, last_error, status 'generating') já vieram na 24.

OS CÓDIGOS DA API, e o que fazer com cada um:
  200  o mapa já existe, com as URLs           -> grava, marca 'ready'
  201  entrou na fila (mapId, queuePosition)   -> marca 'generating', entra no poll
  409  existe, ainda não pronto                -> mesmo caminho do 201
  401/403 chave inválida ou plano insuficiente -> 'failed' com a frase certa, e
          DESLIGA a geração automática até trocarem a chave
  429/5xx                                      -> backoff, e nunca derruba a fila

REGRAS QUE NÃO SE NEGOCIAM:
1. A PRÉVIA É ENFEITE. Nenhum caminho desta frente pode bloquear um wipe. Um
   servidor que não zerou de madrugada porque um site estava fora do ar é o
   defeito que esta regra existe para impedir.
2. `staging` liga SOZINHO quando a entrada da fila é para um plano 'forced', e a
   tela diz por quê. Mapa gerado na versão de hoje pode não servir amanhã.
3. A chave vive no .env. A rota de status devolve só válida/inválida, plano e cota
   — nunca a chave.
4. O TESTE NÃO FALA COM A INTERNET. Grave as respostas em core/test/fixtures/.
5. O poll tem teto: 'generating' há mais de N minutos vira 'failed' com o motivo.
6. O limite de requisições ("60/min") NÃO ESTÁ CONFIRMADO — veio de um CLI
   não-oficial. Meça com a chave em mãos e deixe o número numa constante nomeada,
   com um comentário dizendo que foi medido (ou que não foi).

ACEITE: colar uma seed nova gera a prévia sozinho; SEM REDE, a fila continua
funcionando, o cartão mostra "sem prévia" e o wipe usa a seed; chave inválida
produz uma frase que diz o que fazer. `npm test -w core` verde SEM rede.
```

---

## FRENTE I — Blueprints por VIP (a única com C#)

```
Projeto: F:\Projects\RustAgent. Você é a FRENTE I: fazer o `wipe_except_vip`
funcionar de verdade. É a ÚNICA frente que mexe em código que roda dentro do jogo.
Depende das Frentes A e D, que já devem estar na árvore.

Leia:
  Docs/16-PLANO-WIPE-CALENDARIO-MENSAGENS.md   (§7 migração 28, §9.1 sub-aba
                                                Blueprints, e §13)
  Docs/17-FRENTES-WIPE-E-MENSAGENS.md          (§0, §10 e a "Frente I")
  F:\Projects\Rust\Docs\OrigemZWipe\PLANO.md   §6 INTEIRO — a pesquisa, as APIs do
                                                Oxide e as quatro decisões
  Docs/11-BRIEFING-PLUGINS.md
No código:
  Plugins/OrigemZAgent.cs   -> LEIA AS CINCO REGRAS DO CABEÇALHO ANTES DE TUDO.
                               Nada acima de C# 6 (o compilador do Oxide para
                               nesse teto), fonte ASCII PURO, texto do jogador
                               vindo do lang. Copie a paginação do origemz.players
                               e do origemz.items, e a disciplina de payload do
                               origemz.vip.sync
  core/src/db/vips-repository.ts, core/src/vip/, core/src/wipe/run.ts,
  core/src/kits/service.ts (o padrão de entrega e de idempotência)

CONSTRUA:
  Plugins/OrigemZAgent.cs               +2 comandos, NO FIM do arquivo:
      origemz.bp.export <offset> <limit>   lê persistance.GetPlayerInfo(steamId)
                                           .unlockedItems — funciona OFFLINE
      origemz.bp.restore <base64>          guarda a lista e aplica com
                                           blueprints.Learn(...) no
                                           OnPlayerConnected (e já, para quem
                                           está online)
  core/src/wipe/blueprints.ts           snapshot, régua por tier, devolução
  core/src/db/bp-repository.ts
  core/src/http/routes/wipe-blueprints.ts
  core/test/wipe-blueprints.test.ts
  panel/src/components/wipe/tab-blueprints.tsx

TOQUE, por anexação:
  core/src/db/migrations.ts   -> migração 28, nome 'bp-snapshots'  (É SUA)
  core/src/wipe/run.ts        -> DOIS pontos: tirar o snapshot ANTES de `apagar`,
                                 e enfileirar a devolução no `pós-wipe`
  core/src/http/server.ts, core/src/index.ts, panel/src/lib/api.ts,
  panel/src/components/wipe/wipe-panel.tsx

REGRAS QUE NÃO SE NEGOCIAM:
1. O snapshot é DE TODO MUNDO; quem recebe de volta é decidido NA DEVOLUÇÃO,
   contra o VIP vigente naquele instante. Salvar só de VIP quebraria quem compra
   VIP no dia seguinte ao wipe.
2. O snapshot vale para O WIPE SEGUINTE, E SÓ ELE. Depois expira.
3. A devolução é NO LOGIN: Learn() exige o BasePlayer carregado.
4. O export é PAGINADO, e a carga de volta é RECUSADA INTEIRA em vez de cortada.
   Um BP pela metade PARECE ter funcionado — é o pior desfecho possível.
5. Devolução idempotente por (steam_id, snapshot_id): quem entra e sai três vezes
   não recebe três vezes, e não recebe zero.
6. FALHAR O SNAPSHOT NÃO CANCELA O WIPE: vira um passo com aviso, a política cai
   para 'wipe' naquele run, e a linha do log diz isso.
7. O PLUGIN NÃO DECIDE NADA. Tier, régua e atraso são do agente; o plugin recebe
   lista pronta e aplica.
8. Base64 nos comandos, como no resto do ecossistema.

A RÉGUA (padrão, editável na tela): bronze = até a bancada 1; silver = até a
bancada 2; gold = tudo. Mais `delayHours`, padrão 0.

ACEITE (servidor de teste, com dois jogadores — um gold, um sem VIP): wipe com
'wipe_except_vip' devolve tudo ao gold e nada ao outro; com delayHours=1 o gold
entra sem nada e recebe uma hora depois, ao reentrar; origemz.bp.export 0 50
responde JSON de uma linha com count; desligar o plugin no meio deixa o wipe
terminar e a tela mostrar a devolução pendente. `npm test -w core` verde e o .cs
compilando.
```

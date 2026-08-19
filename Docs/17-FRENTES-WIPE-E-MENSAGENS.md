# 17 — As frentes: como vários agentes constroem isto ao mesmo tempo

> **Este é o documento de EXECUÇÃO.** O *porquê* de cada decisão está em
> [16-PLANO-WIPE-CALENDARIO-MENSAGENS.md](16-PLANO-WIPE-CALENDARIO-MENSAGENS.md),
> e ele é **leitura obrigatória** antes de qualquer frente. Aqui está só o
> recorte: o que cada frente cria, o que ela não toca, e como saber que
> terminou.

Cada seção **Frente X** é auto-contida o bastante para ser entregue inteira a um
agente, junto com o doc 16.

---

## 0. As quatro regras do trabalho paralelo

Sete frentes numa árvore só quebram sempre pelos mesmos quatro motivos. As
regras abaixo existem para cada um deles.

### 1. A migração é numerada na reserva, nunca no "próximo livre"

A última migração aplicada é a **22** (`spawn-status`). Duas frentes que olham
`core/src/db/migrations.ts` e escrevem "23" dão **merge limpo e banco quebrado**:
o SQLite aplica a primeira e ignora a segunda para sempre, porque o número já
consta em `schema_migrations`.

| Número | Nome | Dona |
|---|---|---|
| 23 | `wipe-schedule` | **A** |
| 24 | `wipe-map-pool` | **C** |
| 25 | `wipe-runs` | **D** |
| 26 | `messages` | **E** |
| 27 | `events` | **G** (só a tabela; a tela é depois) |
| 28 | `bp-snapshots` | **I** |

Ninguém usa um número que não é seu, mesmo que o vizinho ainda não tenha
começado. A Frente **H** (RustMaps) não tem número: ela **preenche colunas que a
24 já criou** — e é a Frente C quem as cria, mesmo sem usá-las.

### 2. Arquivo compartilhado se toca por ANEXAÇÃO, no fim do bloco

Estes arquivos vão ser tocados por quase todas as frentes. Em todos eles a regra
é a mesma: **acrescente no fim da lista/bloco existente, não reordene, não
reformate**. Um `import` novo entra no fim do grupo de imports, não na ordem
alfabética "certa" — a reordenação é o que transforma duas linhas somadas num
conflito de trinta.

| Arquivo | Quem toca | O que se acrescenta |
|---|---|---|
| `core/src/db/migrations.ts` | A C D E G I | uma constante SQL + uma linha no array `MIGRATIONS` |
| `core/src/http/server.ts` | A C D E H I | um `import` + uma chamada `registerXRoutes(api, …)` |
| `core/src/index.ts` | A D E G H I | a construção do serviço e o `start()` dele |
| `core/src/ops/operations.ts` | D | **uma** entrada em `OPERATION_KINDS` |
| `panel/src/lib/api.ts` | B C D E G H I | tipos e métodos novos, no fim |
| `panel/src/app/servidor/page.tsx` | B | uma entrada em `TABS` + uma linha de render |
| `panel/src/components/sidebar.tsx` | E | uma entrada em `NAV` |
| `panel/src/components/wipe/wipe-panel.tsx` | B C D I | uma entrada na lista de sub-abas |
| `core/src/config.ts`, `ops/server-process.ts`, `servers/supervisor.ts`, `Configs/server.example.ini` | **C, e só ela** | a chave `SERVER_LEVELURL` |
| `Plugins/OrigemZAgent.cs` | **I, e só ela** | dois `[ConsoleCommand]` no fim |

### 3. O contrato vem antes do código — e ele é o "commit zero"

Antes de qualquer frente começar, **um** agente cria os arquivos de tipos abaixo,
com as interfaces e nada mais (sem implementação, sem banco, sem rota). Eles são
publicados na branch base, e todas as frentes compilam contra eles.

```
core/src/types/wipe.ts        BpPolicy, CollisionPolicy, WipeSettings,
                              PlannedWipe, WipePlan, WipeRunStep, MapPoolEntry
core/src/types/messages.ts    ScheduleKind, MessageView, MessageInput,
                              BroadcastInput, BroadcastResult
core/src/game/broadcast.ts    interface Broadcaster (SÓ a interface aqui; a
                              implementação é da Frente E)
```

Sem isso, a Frente B escreve a tela contra um tipo que a Frente A ainda vai
inventar, e as duas se encontram no merge.

### 4. Teste junto, no mesmo commit

`core/test/` é por assunto (`wipe-schedule.test.ts`, `messages.test.ts`) — um
arquivo por frente, sem arquivo compartilhado. `npm test` e `npm run typecheck`
verdes **na sua frente** antes de pedir merge; a integração é conferida na ordem
de merge da §9.

---

## Mapa das frentes

```
        ┌─────────────────────────────────────────────────┐
        │  FRENTE 0 — os tipos compartilhados (§0.3)       │
        └───┬──────────────┬──────────────┬───────────────┘
            │              │              │
   ┌────────▼─────┐  ┌─────▼────────┐  ┌──▼───────────┐
   │  A  agenda   │  │  E mensagens │  │  C  mapas    │
   │  (núcleo)    │  │  (completa)  │  │  + LEVELURL  │
   └──┬────┬──────┘  └─────┬────────┘  └──┬────────┬──┘
      │    │               │              │        │
 ┌────▼──┐ └─┬────────┐    │              │   ┌────▼──────┐
 │ B tela│   │ G jogo │    │              │   │ H RustMaps│
 └───────┘   └────────┘    │              │   └───────────┘
                           │              │
        ┌──────────────────▼──────────────▼───┐
        │  D  execução + full wipe            │
        │     (a que apaga arquivo)           │
        └────────┬──────────────────┬─────────┘
                 │                  │
          ┌──────▼──────┐    ┌──────▼──────────┐
          │ F  avisos   │    │ I  blueprints   │
          │ (ponte A+E) │    │ (o único C#)    │
          └─────────────┘    └─────────────────┘
```

| Frente | Título | Pode começar | Tamanho |
|---|---|---|---|
| **0** | Os tipos compartilhados | **primeiro, sozinha** | pequena |
| **A** | Agenda do wipe (núcleo, sem UI) | logo após o commit zero | grande |
| **B** | Aba WIPE no painel: Geral + Agenda | junto com A (contra os tipos) | grande |
| **C** | Fila de mapas + `SERVER_LEVELURL` | junto com A | média |
| **D** | Execução do wipe: `wipe-run` + full wipe + 2 sub-abas | depois de A e C | **a maior** |
| **E** | Mensagens: motor + rotas + tela | logo após o commit zero | grande |
| **F** | Avisos de wipe (a ponte) | depois de A e E | pequena |
| **G** | Calendário dentro do jogo | depois de A | média |
| **H** | RustMaps: prévia, geração, poll, staging | depois de C | média |
| **I** | Blueprints por VIP (a única com C#) | depois de A e D | grande |

---

## Frente A — A agenda do wipe

**Objetivo:** o agente sabe dizer, para qualquer servidor, quando é o próximo
wipe, de que tipo, e o que ele leva. **Nada aqui executa nada.**

### O que ela cria

```
core/src/wipe/schedule.ts              cálculo puro (PORTE de F:\Projects\Rust)
core/src/db/wipe-schedule-repository.ts
core/src/http/routes/wipe.ts           settings, plans, upcoming
core/test/wipe-schedule.test.ts
core/test/wipe-plans.test.ts
```

### O que ela toca (por anexação)

`migrations.ts` (**23** `wipe-schedule`) · `http/server.ts` · `index.ts`
(materializar a agenda no boot).

### O porte, e o que muda no caminho

`F:\Projects\Rust\RustAgent\core\src\wipe\schedule.ts` vem quase inteiro — é
cálculo puro, sem banco e sem relógio próprio (`now` sempre por parâmetro). O que
**precisa mudar**:

- `serverId` abre a assinatura de tudo o que vira repositório — esta árvore não
  tem servidor implícito;
- datas em epoch ms `INTEGER`;
- erros com código (`ApiError`), no padrão de `core/src/http/error-response.ts`.

### As regras que não se negociam

1. **O forçado nunca é pulado.** `DELETE` num plano `forced` responde `409` com
   explicação — não um `204` silencioso.
2. **A reconciliação nunca toca no passado**, e nunca reescreve linha `pinned`.
3. **`generated_for` é obrigatório** em linha gerada. Sem ela, adiar cria um
   segundo wipe na volta seguinte.
4. **Sem tabela de datas.** A primeira quinta é derivada; um array de datas
   chumbadas é motivo de recusa na revisão.
5. **A cadência nasce DESLIGADA.** Um agente recém-instalado não tem opinião
   sobre quando zerar o servidor de ninguém.

### Como saber que terminou

- `GET /api/servers/server01/wipe/plans?from&to` lista forçados e cadência na
  ordem, com o absorvido **marcado** (e não sumido);
- mudar `everyDays` de 7 para 3 **reescreve** as linhas geradas futuras e
  **preserva** a que foi adiada à mão;
- teste com fuso: cadência às 16:00 em `America/Sao_Paulo` atravessando uma
  mudança de offset continua às 16:00 locais;
- teste do forçado em dezembro (o `month + 1` que vira janeiro do ano seguinte);
- `npm test -w core` verde.

---

## Frente B — A aba WIPE no painel (Geral + Agenda)

**Objetivo:** o admin abre o servidor, clica em WIPE e vê a contagem regressiva,
o que o próximo wipe leva, e a configuração da cadência. **A tela não executa
wipe** — e precisa dizer isso.

### O que ela cria

```
panel/src/components/wipe/wipe-panel.tsx        a casca e as sub-abas
panel/src/components/wipe/tab-geral.tsx
panel/src/components/wipe/tab-agenda.tsx
panel/src/components/wipe/calendar-month.tsx    O COMPONENTE DE CALENDÁRIO
panel/src/components/wipe/use-agent-clock.ts    a contagem contra o relógio do agente
```

### O que ela toca

`panel/src/app/servidor/page.tsx` (uma entrada em `TABS`, ícone `CalendarClock`,
entre `menu` e `config`) · `panel/src/lib/api.ts`.

### O desenho

Está em [16 §9.1](16-PLANO-WIPE-CALENDARIO-MENSAGENS.md#91-a-aba-wipe-na-página-do-servidor),
com os mockups. As sub-abas seguem o padrão de `TABS` que a página do servidor já
usa: estado local, `role="tablist"`, sem rota por aba.

### O que precisa ficar visível na tela

- **enquanto a Frente D não entrar**, uma faixa no topo da Geral dizendo que
  *esta tela ainda não executa wipe* — e o botão "WIPAR AGORA" **não existe**.
  Um painel que mostra "próximo wipe em 3 h" com um botão de salvar ao lado dá a
  impressão de que o agente vai executá-lo;
- a contagem sai do relógio do **agente**, corrigido pela diferença para o local
  (`use-agent-clock.ts`). Um navegador adiantado em dez minutos mentiria em cima
  da única informação que a tela existe para dar.

### `calendar-month.tsx` é da casa, não do wipe

Ele recebe marcações genéricas e **não conhece wipe**:

```ts
interface CalendarMark {
  readonly at: number;                      // epoch ms
  readonly kind: string;                    // 'cadence' | 'forced' | 'event' | …
  readonly label: string;
  readonly tone: 'rust' | 'amber' | 'olive' | 'muted';
}
```

É o mesmo componente que a tela de eventos vai usar. Um calendário que importa
`WipePlan` é um calendário que precisa ser reescrito quando eventos entrarem.

### Como saber que terminou

- a aba abre com o servidor parado, com o RCON caído e com a agenda vazia — e em
  nenhum dos três casos ela quebra: cada um tem o seu `StateBlock`;
- trocar a cadência e salvar reflete na grade do mês sem recarregar a página;
- a grade do mês navega `‹ ›` e volta com "hoje";
- `npm run typecheck -w panel` e `npm run lint -w panel` verdes.

---

## Frente C — A fila de mapas

**Objetivo:** o admin decide qual mundo entra no próximo wipe; o agente sorteia
quando ninguém decidiu.

### O que ela cria

```
core/src/wipe/map-pool.ts               sorteio, validação de seed/tamanho
core/src/db/map-pool-repository.ts
core/src/http/routes/wipe-maps.ts
core/test/wipe-map-pool.test.ts
panel/src/components/wipe/tab-mapas.tsx
```

### O que ela toca

`migrations.ts` (**24** `wipe-map-pool`) · `http/server.ts` ·
`panel/src/lib/api.ts` · `wipe-panel.tsx` (a sub-aba Mapas — **combine com a
Frente B qual das duas cria o arquivo da casca**; a regra: quem chegar primeiro
cria, a outra só acrescenta a entrada).

### As regras

1. **`reorder` recebe a fila inteira**, e não "mova para cima". Com movimento
   relativo, duas telas abertas produzem uma ordem que nenhuma das duas pediu.
2. **Índice único parcial** (`WHERE status <> 'used'`): a mesma seed não pode
   estar duas vezes esperando; pode ser reprisada meses depois.
3. **Seed já jogada nos últimos seis wipes → aviso, não recusa.** O objetivo é o
   admin não descobrir a repetição no dia do wipe.
4. **O sorteio evita** o que está na fila **e** o que os últimos seis wipes
   usaram.
5. **Mapa custom (`levelUrl`) é aceito com trava.** Antes de entrar na fila, o
   agente confere a URL (`HEAD`: responde? termina em `.map`? qual o tamanho?), e
   uma entrada `custom` **não pode ser consumida por wipe forçado** sem a marca
   `compatível com a versão nova`. Aceitar sem isso faria o admin achar que o
   próximo wipe está resolvido, e o servidor não subiria na madrugada.
6. `worldSize` entre 1000 e 6000; `level` em `Procedural Map`, `Barren`,
   `HapisIsland`, `Craggy Island`.

### `SERVER_LEVELURL` — a única mudança fora do wipe, e ela é sua

Mapa custom exige uma chave que não existe. **Só a Frente C toca nestes quatro
arquivos**, e a mudança é uma linha em cada:

| Arquivo | O que entra |
|---|---|
| `Configs/server.example.ini` | `SERVER_LEVELURL=` com o comentário explicando quando usar |
| `core/src/config.ts` | `levelUrl: string` no `ServerConfig`, lido como opcional (vazio = procedural) |
| `core/src/servers/supervisor.ts` | `levelUrl: 'SERVER_LEVELURL'` no `KEY_OF`, e a chave em `RESTART_KEYS` |
| `core/src/ops/server-process.ts` | `+server.levelurl` no `buildArgs`, **só quando não vazio** |

> **Vazio não vira `+server.levelurl ""`.** O jogo aceita qualquer `+x.y` na
> linha de comando sem reclamar, e o que não faz sentido ele ignora em silêncio —
> foi assim que a "senha de servidor" viveu meses neste projeto sem funcionar
> (ver o comentário em `config.ts`).

### As colunas do RustMaps você cria, mas não usa

`rustmaps_id`, `staging`, `preview_url`, `thumb_url`, `monuments`, `last_error` e
o status `generating` entram na **migração 24**, que é sua. Quem os preenche é a
**Frente H**. Criá-los agora evita uma migração 29 só para acrescentar coluna — e
a Frente H não pode escrever migração, porque não tem número reservado.

### Como saber que terminou

- colar a mesma seed duas vezes é recusado com a mensagem certa; a mesma seed
  depois de `used` é aceita;
- fila vazia + "qual é o próximo mapa?" responde uma seed sorteada, e **diz que
  sorteou**;
- reordenar com duas abas abertas termina na ordem que a última salvou, inteira;
- `npm test -w core` verde.

---

## Frente D — A execução

> **####  ESTA É A FRENTE QUE APAGA ARQUIVO  ####**
>
> Ela entra com o backup pronto **no mesmo commit**. Não existe "backup depois".

**Objetivo:** o wipe acontece sozinho, na hora marcada, e o admin acompanha passo
a passo — e retoma o que falhou.

### O que ela cria

```
core/src/wipe/save-files.ts          quais arquivos, por política (PORTE)
core/src/wipe/plugin-data.ts         O FULL WIPE: o que existe em oxide\data
core/src/wipe/preview.ts             o que este wipe vai apagar (PORTE)
core/src/wipe/backup.ts              zipar a pasta do save, podar os antigos
core/src/wipe/run.ts                 A MÁQUINA DE PASSOS
core/src/wipe/scheduler.ts           o relógio que dispara o plano vencido
core/src/db/wipe-runs-repository.ts
core/src/db/wipes-repository.ts      o histórico de mundos detectados
core/src/http/routes/wipe-runs.ts
core/test/wipe-save-files.test.ts
core/test/wipe-plugin-data.test.ts
core/test/wipe-run.test.ts
panel/src/components/wipe/tab-execucao.tsx
panel/src/components/wipe/tab-configuracao.tsx
```

### O full wipe, e por que ele é uma lista lida do disco

`GET /api/servers/:id/wipe/plugin-data` varre dois lugares e devolve o que
**existe**, com tamanho e data de alteração:

```
Servers\<id>\server\<identity>\*.db      os que NÃO são do jogo (clans, etc.)
Servers\<id>\oxide\data\**\*.json        o estado dos plugins
```

Regras:

1. **Nada vem marcado.** O admin escolhe, item a item, e a escolha fica em
   `wipe_settings` como uma lista de globs.
2. **Nunca `del *.json`.** O `OrigemZVip.json` é o VIP que alguém pagou; o
   `OrigemZStore.json` é a carteira. Um full wipe indiscriminado devolve
   chargeback, não servidor novo.
3. **O que sumiu do disco continua na lista salva**, marcado como "não existe
   mais" — apagar a escolha do admin porque o arquivo não estava lá naquele dia é
   como se perde uma configuração em silêncio.
4. **O purge só apaga o que casa com a lista**, e `apagar` num arquivo ausente é
   sucesso.

### O que ela toca

`migrations.ts` (**25** `wipe-runs`) · `ops/operations.ts` (**uma** entrada:
`'wipe-run'`) · `ops/service.ts` (o `case` no `#execute` e as pré-condições) ·
`http/server.ts` · `index.ts` · `game/wipe.ts` (chamar `forget()` ao final —
**uma linha**) · `panel/src/lib/api.ts`.

### Os passos, e o que cada um garante

```
 planejado → avisar → esvaziar → parar → backup → apagar
                                                     │
   feito ← pós-wipe ← subir ← configurar ←───────────┘
```

| Passo | O que faz | O que ele NÃO pode fazer |
|---|---|---|
| `avisar` | os offsets de `wipe_settings`, pelo `Broadcaster` | falhar o wipe porque o RCON caiu — aviso é melhor-esforço |
| `esvaziar` | anuncia e espera a saída, com teto em minutos | esperar para sempre |
| `parar` | `quit` pelo RCON (que salva antes de sair) | usar `force` sem o operador ter pedido |
| `backup` | zip da pasta do save → `Backups\<id>\wipe-<data>.zip`, podando os antigos | começar sem **conferir espaço em disco antes de parar o servidor** |
| `apagar` | os globs da política (map / BP / full) | usar nome de arquivo fixo — é sempre prefixo, e o `-wal` vai junto |
| `configurar` | `supervisor.updateSettings({ map, seed, worldSize })` | escrever no `.ini` por conta própria |
| `subir` | `server-start`, esperando o RCON responder | subir antes de o Oxide ter build compatível, quando a opção estiver ligada |
| `pós-wipe` | `wipeClock.forget()`, ressincronizar VIP/loadout/kits, anunciar o mundo novo, gravar o `wipes` detectado | derrubar o wipe se uma ressincronização falhar |

**Todo passo é idempotente**, e é isso que torna `resume` seguro: `apagar` num
diretório já limpo é `done`, não `failed`.

### As pré-condições, e por que elas são recusas antes do 202

- servidor em outra operação → a trava por recurso do `OperationsService` já
  recusa;
- `POST /wipe/runs` sem o `identity` digitado no corpo → `400`;
- sem `Idempotency-Key` → `400`. Um duplo-clique não pode zerar o servidor duas
  vezes;
- espaço em disco menor que o tamanho da pasta do save + folga → `409`, **com o
  servidor ainda no ar**.

### O caso do `pm2 restart` no meio

No boot, todo `wipe_run` com status `running` cuja operação não existe mais vira
`failed` com a mensagem *"o agente reiniciou no meio desta execução"*, e a tela
oferece **retomar**. Deixá-lo `running` para sempre é a única saída pior que
falhar.

### Como saber que terminou

- num servidor de teste, `POST /wipe/runs` com política `keep`: o mundo muda, os
  `player.blueprints.*` **continuam lá**, e o `SaveCreatedTime` novo aparece em
  `wipes`;
- com política `wipe`, os `player.blueprints.*` e os `-wal` deles somem;
- matar o agente no passo `apagar` e subir de novo: o run aparece `failed`, e
  `resume` conclui **sem apagar um mundo novo**;
- o zip do backup abre e tem o `.sav` dentro;
- a sub-aba Execução mostra os passos ao vivo e o log com cursor, como a tela de
  Operações.

---

## Frente E — Mensagens

**Objetivo:** o item **Mensagens** na barra lateral, com o motor que faz o
servidor falar sozinho no ritmo de cada mensagem.

### O que ela cria

```
core/src/game/broadcast.ts             O TRANSPORTE (a interface vem do commit zero)
core/src/messages/schedule.ts          quando é a próxima (interval/daily/weekly/once)
core/src/messages/variables.ts         {servidor} {online} … e o registro de provedores
core/src/messages/service.ts           o relógio de 30 s
core/src/db/messages-repository.ts
core/src/http/routes/messages.ts
core/test/messages-schedule.test.ts
core/test/messages-service.test.ts
panel/src/app/mensagens/page.tsx
panel/src/components/message-dialog.tsx
```

### O que ela toca

`migrations.ts` (**26** `messages`) · `http/server.ts` · `index.ts` ·
`panel/src/components/sidebar.tsx` (uma entrada em `NAV`, ícone `Megaphone`,
entre Loja e Interface) · `panel/src/lib/api.ts`.

### O desenho

Está em [16 §9.2](16-PLANO-WIPE-CALENDARIO-MENSAGENS.md#92-mensagens-na-barra-lateral),
e as regras do motor em
[16 §10](16-PLANO-WIPE-CALENDARIO-MENSAGENS.md#10-mensagens-o-motor-de-agendamento).

### As regras que não se negociam

1. **O `tick` nunca lança.** Ele devolve o que aconteceu; o log lê isso.
2. **RCON offline e servidor vazio não consomem o horário.** `next_at` fica como
   está.
3. **`last_sent_at` só depois da entrega confirmada.**
4. **A janela pode virar a meia-noite** (`22:00`–`02:00`).
5. **"A cada 7 dias" conta dias de calendário**, não `604800` s. Use as funções
   de fuso de `core/src/wipe/schedule.ts` — não escreva as suas.
6. **Variável desconhecida fica literal.** Nunca vira string vazia.
7. **Base64 no `origemz.chat.broadcast`.** JSON cru chega ao plugin com as aspas
   comidas.
8. **Fallback para `say`** quando o `OrigemZChat` não responde — mensagem sem cor
   é melhor que silêncio, e o `via` da resposta diz qual caminho foi usado.

### O `Broadcaster` é contrato público

A Frente D e a Frente F dependem dele. A interface **não muda** depois de
publicada no commit zero:

```ts
export interface Broadcaster {
  send(input: BroadcastInput): Promise<BroadcastResult>;  // { sent, via }
}
```

### Como saber que terminou

- criar "a cada 30 minutos" e ver `next_at` andar de 30 em 30, sem deriva
  acumulada;
- criar "toda quinta às 16:00" e conferir a próxima ocorrência atravessando uma
  virada de mês;
- criar "uma vez em 25/08 02:00" e ver a mensagem sair uma vez só, e depois
  `enabled` cair sozinho;
- desligar o RCON: nada é marcado como enviado, e ao voltar a mensagem sai;
- `POST /api/messages/:id/test` sai no chat na hora, **sem mexer no `next_at`**;
- o `message_log` responde "essa mensagem está mesmo aparecendo?".

---

## Frente F — Os avisos de wipe (a ponte)

**Objetivo:** o jogador fica sabendo do wipe, e a mensagem que o admin escreveu
com `{wipe.faltam}` funciona.

Frente pequena, e ela **só existe depois de A e E**. É deliberadamente separada:
enquanto ela não entra, nem o wipe nem as mensagens ficam esperando nada.

### O que ela cria

```
core/src/wipe/announce.ts               os offsets viram falas, pelo Broadcaster
core/src/messages/providers/wipe.ts     o provedor das variáveis {wipe.*}
core/test/wipe-announce.test.ts
```

### O que ela toca

`index.ts` (registrar o provedor) · `tab-configuracao.tsx` (os offsets e o texto)
· `wipe/run.ts` (o passo `avisar` chama o `announce`).

### As regras

- **um aviso perdido não derruba o wipe.** Avisar é melhor-esforço; apagar não é;
- **o aviso não é reenviado** se o agente reiniciar entre dois offsets — a marca
  fica no `wipe_run_steps`;
- `{wipe.faltam}` num servidor sem agenda devolve *"sem wipe agendado"*, nunca
  vazio;
- o texto do aviso é template do admin, e a formatação **é do plugin** — o agente
  manda o texto cru mais a aparência. Formatar dos dois lados cria duas verdades
  sobre como um aviso se parece.

### Como saber que terminou

- agendar um wipe manual para daqui a 3 minutos com offsets `[2 min, 1 min]` e
  ver as duas falas saírem no chat, na hora;
- uma mensagem do admin com `{wipe.faltam}` mostra o mesmo número que a aba
  Geral.

---

## Frente G — O calendário dentro do jogo

**Objetivo:** a página `CALENDÁRIO` do `/menu` deixa de dizer *"entram aqui"* e
passa a mostrar a agenda.

### O que ela cria

```
core/src/game/ui-calendar-screen.ts    a tela gerada
core/test/ui-calendar.test.ts
```

### O que ela toca

`index.ts` (registrar em `generatedScreens`, ao lado da tela de kits) ·
`migrations.ts` (**27** `events` — só a tabela, sem rota e sem tela) ·
`routes/wipe.ts` (`GET /wipe/upcoming/me`, recortado pelo tier).

### O padrão a copiar

[core/src/game/ui-kits-screen.ts](../core/src/game/ui-kits-screen.ts), linha por
linha — inclusive as decisões que o cabeçalho dele explica:

- **`volatile: true`.** A tela mostra "faltam 6d 04h"; em cache ela mostraria as
  mesmas seis horas para sempre, e o jogador confiaria naquilo;
- os construtores vêm de `ui-widgets.ts`, compartilhados com a loja e os kits —
  **duas cópias divergem no primeiro ajuste**;
- o conteúdo depende de **quem está olhando**.

### A régua do VIP

| Nível | Vê |
|---|---|
| sem VIP / bronze | a data e a política de BP do próximo wipe |
| silver | + o mapa #1 (tamanho e imagem, **sem a seed**) |
| gold | + os mapas #2 e #3 |

**Mostrar a seed é uma chave separada da imagem**: com a seed o jogador estuda o
mapa inteiro no RustMaps dias antes.

### Como saber que terminou

- `/menu` → CALENDÁRIO abre com a agenda real, e reabre com o número atualizado;
- num servidor sem agenda, a tela diz *"sem wipe agendado"* — e não abre vazia;
- um jogador sem VIP não recebe a seed **na payload**, e não só na tela: o que
  não deve ser visto não atravessa o RCON.

---

## Frente H — RustMaps

**Objetivo:** a seed deixa de ser um número. O admin vê o mapa antes de ele
entrar, e o VIP também.

### O que ela cria

```
core/src/wipe/rustmaps.ts              o cliente: pedir, esperar, guardar
core/src/wipe/rustmaps-poll.ts         o relógio que acompanha o que está gerando
core/src/http/routes/rustmaps.ts       status da chave + gerar sob demanda
core/test/rustmaps.test.ts             contra respostas GRAVADAS, nunca a API real
```

### O que ela toca

`http/server.ts` · `index.ts` (ligar o poll) · `panel/src/lib/api.ts` ·
`tab-mapas.tsx` (o cartão de prévia e o bloco RUSTMAPS) · `.env.example`
(`RUSTMAPS_API_KEY`).

**Ela não escreve migração.** As colunas (`rustmaps_id`, `staging`,
`preview_url`, `thumb_url`, `monuments`, `last_error`) vêm na 24, da Frente C.

### O contrato da API, e o que fazer com cada resposta

| Código | Significa | O agente faz |
|---|---|---|
| `200` | o mapa **já existe** — vem com as URLs | grava e marca `ready` |
| `201` | entrou na fila (`mapId`, `state`, `queuePosition`) | grava o id, marca `generating`, entra no poll |
| `409` | existe, mas ainda **não está pronto** — só o id | mesmo caminho do `201` |
| `401` / `403` | chave inválida ou plano insuficiente | marca `failed` com a frase certa, e **desliga a geração automática** até o admin trocar a chave |
| `429` / `5xx` | limite ou instabilidade | backoff, e **nunca** derruba a fila |

### As regras que não se negociam

1. **A prévia é ENFEITE.** Sem ela, o wipe usa a seed do mesmo jeito. Nenhum
   caminho desta frente pode bloquear um wipe — quem faz isso vira o defeito de
   madrugada em que o servidor não zerou porque um site estava fora do ar.
2. **`staging` liga sozinho** quando a entrada da fila está apontada para um
   plano `forced`, e a tela **diz por quê**. Mapa gerado na versão de hoje pode
   não servir amanhã.
3. **Nada de chave no banco nem no painel**: `RUSTMAPS_API_KEY` vive no `.env`,
   e a rota de status devolve só *válida/inválida*, o plano e a cota.
4. **O teste não fala com a internet.** Grave as respostas (200/201/409/401) em
   `core/test/fixtures/` e teste contra elas — um teste que depende de rede falha
   no CI por motivo que não é o seu.
5. **O poll tem teto e desiste.** Um mapa `generating` há mais de N minutos vira
   `failed` com o motivo, e não fica girando para sempre.

### O não confirmado, e o que fazer com ele

O limite de requisições ("60/min") veio de um CLI não-oficial, não da
documentação — `api.rustmaps.com/docs` responde 403 sem chave. **Meça com a
chave em mãos antes de escolher o intervalo do poll**, e deixe o número numa
constante nomeada, não espalhado.

Idem para a retenção: mapas do gerador custom expiram depois de ~2 wipes
mensais. Pré-gerar com três meses de antecedência não funciona nem no plano pago
— a tela precisa dizer isso quando alguém tentar.

### Como saber que terminou

- colar uma seed nova gera a prévia sozinho, e a imagem aparece no cartão;
- desligar a internet: a fila continua funcionando, o cartão mostra "sem prévia",
  e o wipe usa a seed;
- uma chave inválida produz uma frase que diz o que fazer, e não um `403` cru;
- `npm test -w core` verde **sem rede**.

---

## Frente I — Blueprints por VIP

> **####  A ÚNICA FRENTE COM C#  ####**
>
> Ela mexe no `Plugins/OrigemZAgent.cs`, que roda dentro do jogo e é recompilado
> pelo Oxide. Leia as **cinco regras** no cabeçalho do arquivo antes da primeira
> linha — nada acima de C# 6, fonte ASCII puro, texto do jogador vindo do lang.

**Objetivo:** `wipe_except_vip` funciona: quem tem direito recomeça o wipe
sabendo o que aprendeu.

### O que ela cria

```
Plugins/OrigemZAgent.cs                 (+2 comandos, no fim do arquivo)
core/src/wipe/blueprints.ts             snapshot, régua por tier, devolução
core/src/db/bp-repository.ts
core/src/http/routes/wipe-blueprints.ts
core/test/wipe-blueprints.test.ts
panel/src/components/wipe/tab-blueprints.tsx
```

### O que ela toca

`migrations.ts` (**28** `bp-snapshots`) · `http/server.ts` · `index.ts` ·
`wipe/run.ts` (dois pontos: tirar o snapshot **antes** de `apagar`, e enfileirar
a devolução no `pós-wipe`) · `panel/src/lib/api.ts` · `wipe-panel.tsx`.

### O mecanismo: snapshot lógico, porque por arquivo é impossível

`player.blueprints.<n>.db` é **um arquivo só, de todos**. Não há como recortar
"os BPs de quem não é VIP". A saída é o jogo, que expõe ao plugin:

```csharp
// ler o que um jogador sabe — funciona OFFLINE, direto do persistence
var info = SingletonComponent<ServerMgr>.Instance.persistance.GetPlayerInfo(steamId);
foreach (var itemId in info.unlockedItems) { /* ... */ }

// devolver — exige o BasePlayer carregado, ou seja, o jogador ONLINE
player.blueprints.Learn(itemDefinition);
```

Daí a sequência:

```
   ANTES do wipe                        DEPOIS do wipe
   ─────────────                        ──────────────
   origemz.bp.export <off> <lim>        o arquivo de BP foi apagado
   ↓  em lotes                          ↓
   { steamId: [itemIds...] }            origemz.bp.restore <base64>
   ↓                                    ↓  o plugin guarda a lista
   agente grava em bp_snapshots         ↓  e aplica no OnPlayerConnected
                                        agente marca `applied`
```

### As quatro decisões que esse desenho força

1. **Devolver no LOGIN, não no boot.** `Learn` precisa do `BasePlayer` carregado.
   Restaurar todo mundo ao subir não é possível — e nem desejável, porque metade
   nunca volta.
2. **O snapshot tem prazo: vale para o wipe seguinte, e só ele.**
3. **O direito é conferido na DEVOLUÇÃO, não no snapshot.** O snapshot é de todo
   mundo (é barato); quem recebe de volta é decidido contra o VIP **vigente
   naquele momento**. Salvar só de VIP criaria o caso de quem compra VIP no dia
   seguinte ao wipe e não tem o que restaurar.
4. **Tamanho.** Centenas de jogadores × centenas de itens não cabe num comando de
   RCON. O export é **paginado** — `origemz.bp.export <offset> <limit>`, o mesmo
   padrão do `origemz.players` e do `origemz.items` que já existem nesse arquivo —
   e a carga de volta **recusa inteira em vez de cortar**, como o
   `origemz.vip.sync`.

### A régua

| Nível | Padrão | O que significa |
|---|---|---|
| bronze | até a bancada 1 | volta com o básico |
| silver | até a bancada 2 | volta sem o topo |
| gold | tudo | volta sabendo tudo |

Mais `delayHours` (padrão 0). Com atraso, a corrida inicial acontece sem a
vantagem — é a manopla que separa "vantagem" de "servidor decidido no primeiro
dia". Tudo editável na sub-aba.

### As regras que não se negociam

1. **Falhar o snapshot NÃO cancela o wipe.** Ele vira um passo com aviso, e a
   política cai para `wipe` naquele run — com a linha no log dizendo isso. Um
   wipe travado porque o export não respondeu é pior que um wipe sem devolução.
2. **Payload recusada inteira, nunca cortada.** Um BP pela metade *parece* ter
   funcionado, e é o pior desfecho possível.
3. **A devolução é idempotente por `(steam_id, snapshot_id)`.** O jogador que
   entra e sai três vezes não recebe três vezes — e não recebe zero.
4. **O plugin não decide nada.** Quem sabe o tier, a régua e o atraso é o agente;
   o plugin recebe uma lista pronta e aplica.

### Como saber que terminou

- num servidor de teste com dois jogadores: um VIP `gold`, um sem VIP. Wipe com
  `wipe_except_vip` → o gold entra sabendo tudo, o outro entra sem nada;
- com `delayHours = 1`, o gold entra sem nada e recebe uma hora depois, ao entrar
  de novo;
- `origemz.bp.export 0 50` responde JSON de uma linha, paginado, com `count`;
- desligar o plugin no meio: o wipe termina, e a tela mostra que a devolução
  ficou pendente;
- `npm test -w core` verde, e o `.cs` compila (`Build.bat OrigemZAgent` ou o
  botão de build do painel).

---

## 9. A ordem de merge

Merge fora de ordem funciona; a ordem abaixo é a que dá **menos conflito**, e
cada linha é conferida com `npm test && npm run typecheck` na raiz.

```
   1. 0  os tipos                 nada depende, tudo depende
   2. A  agenda                   a migração 23 primeiro de todas
   3. C  mapas + SERVER_LEVELURL  24 (com as colunas do RustMaps já criadas)
   4. E  mensagens                26 — independente de A e C
   5. B  aba do painel            só toca painel + api.ts
   6. G  calendário no jogo       27
   7. H  RustMaps                 sem migração — preenche o que a 24 criou
   8. D  execução + full wipe     25 — a maior, e a que mexe em ops/
   9. I  blueprints por VIP       28 — e o único .cs
  10. F  avisos                   duas linhas em dois arquivos já mergeados
```

**D e I por último de propósito**: a D toca `ops/service.ts` e
`ops/operations.ts`, os dois arquivos mais sensíveis do agente; a I é a única que
mexe em código que roda dentro do jogo, e ela **engata na `wipe/run.ts` que a D
acabou de escrever**. Mergear as pequenas antes deixa o revisor olhar para cada
uma dessas duas sozinha.

---

## 10. O que NENHUMA frente pode fazer

Vale para as sete, e é o que o revisor procura primeiro:

| Proibido | Por quê |
|---|---|
| Escrever `Configs\<id>.ini` direto | `supervisor.updateSettings` é o único caminho, e ele preserva comentários |
| Apagar arquivo por nome fixo | o número no nome é a versão do formato, e ele muda sozinho |
| Uma segunda implementação de "mandar texto ao chat" | o `Broadcaster` é a única |
| Uma tabela de datas de force wipe | deriva-se em dez linhas; a tabela envelhece em silêncio |
| Guardar horário local sem fuso | é assim que o wipe desliza uma hora sozinho em novembro |
| `catch {}` vazio num relógio | o laço morre e o recurso para em silêncio |
| Executar wipe sem backup | é a operação que apaga o trabalho de todos os jogadores |
| Aba nova que abre vazia | promete o que não existe — a sub-aba nasce junto com a função |

---

## 11. Os prompts

Os dez prompts prontos, um por frente, estão em
[18-PROMPTS-DAS-FRENTES.md](18-PROMPTS-DAS-FRENTES.md) — é de lá que se copia
para abrir cada agente. O modelo genérico abaixo fica como referência de formato,
para quando uma frente nova precisar de um:

```
Leia, nesta ordem:
  Docs/16-PLANO-WIPE-CALENDARIO-MENSAGENS.md   (inteiro)
  Docs/17-FRENTES-WIPE-E-MENSAGENS.md          (§0, §10 e a sua Frente X)
  Docs/02-ARQUITETURA.md, Docs/03-DECISOES.md, Docs/06-API.md

Depois, no código:
  core/src/db/migrations.ts        o mecanismo e a SUA numeração reservada
  core/src/db/kits-repository.ts   o padrão de repositório a copiar
  core/src/http/routes/kits.ts     o padrão de rota e de erro
  panel/src/app/kits/page.tsx      o padrão de tela de rede
  panel/src/components/kit-dialog.tsx   o padrão de diálogo

E, no projeto ANTERIOR (F:\Projects\Rust\RustAgent), o que a sua frente porta —
a lista está na tabela da §3 do doc 16. Portar não é copiar: as convenções
mudaram.

Construa a Frente X. Não toque no que é de outra frente. Nos arquivos
compartilhados (§0.2), acrescente no fim — não reordene.
Termine com `npm test -w core` e `npm run typecheck` verdes, e escreva no
resumo o que ficou de fora e por quê.
```

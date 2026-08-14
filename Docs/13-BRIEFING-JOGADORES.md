# 13 — Briefing: os Jogadores do RustAgent

> **Este documento é um briefing de execução.** Ele existe para ser entregue
> inteiro a quem vai construir — humano ou agente — sem precisar de mais
> contexto do que os arquivos que ele mesmo aponta.

Projeto: `F:\Projects\RustAgent` (Windows, Node 20+, npm workspaces —
`core` = Fastify/TypeScript, `panel` = Next.js em export estático servido pelo
próprio core).

Esta fase constrói **a identidade de jogador do agente**: uma lista que não
pertence a servidor nenhum, e à qual todo o resto passa a se pendurar — o
banimento que já existe, o histórico, e o ranking e a loja que virão.

---

## Antes de escrever qualquer linha

Leia, nesta ordem:

| Arquivo | O que você tira dele |
|---|---|
| [02-ARQUITETURA.md](02-ARQUITETURA.md) | camadas, fonte da verdade, ciclo de vida |
| [03-DECISOES.md](03-DECISOES.md) | D1–D11: o porquê de cada escolha já feita |
| [06-API.md](06-API.md) | o formato de erro e o padrão das rotas |
| [07-PAINEL.md](07-PAINEL.md) | o que a tela pode e não pode fazer |
| `core/src/db/migrations.ts` | o mecanismo, e as migrações que já existem |
| `core/src/db/bans-repository.ts` | **o padrão de repositório a copiar** |
| `core/src/bans/service.ts` | o padrão de serviço: regra aqui, RCON ali |
| `core/src/game/players.ts` | quem está online AGORA, e a queda plugin→nativo |
| `core/src/game/chat.ts` | a lição de ler do jogo em vez do log |
| `core/src/servers/console-buffer.ts` | o evento `log` do RCON, que é onde os eventos aparecem |
| `panel/src/app/banidos/page.tsx` | o padrão de tela de REDE (tabela + busca) |
| `panel/src/components/admin-panel.tsx` | o padrão de aba, filtros e lista |

E **estude o projeto anterior**, em `F:\Projects\Rust\RustAgent`. Ele resolveu
este problema uma vez, e as duas tabelas dele são o ponto de partida desta fase
(estão citadas adiante, já traduzidas para as convenções de hoje).

O projeto tem um estilo de comentário deliberado: o cabeçalho de cada arquivo
explica **por que ele existe** e **o que dá errado sem ele**, com blocos `####`
marcando as armadilhas. Siga isso — comentário que só repete o código é ruído.

---

## O que já existe, e que muda suas premissas

A fase de Administração está no `main`. Você **não** começa do zero:

- **a BanList já é global** (`bans`, migração 005). Ela guarda `steam_id`,
  motivo, escopo, prazo e quem aplicou, e já sabe reconciliar com o `bans.cfg`
  de cada servidor. **Não crie uma segunda lista de banidos** — a ficha do
  jogador *lê* essa;
- **quem está online já é lido** (`GET /api/servers/:id/players`), com posição e
  célula do mapa quando o `OrigemZAgent` está ligado, e pelo `playerlist` nativo
  quando não está;
- **o chat já é lido do histórico do jogo** (`chat.tail`), com o SteamID de quem
  falou;
- **o mapa já existe**, com a imagem do mundo e os monumentos.

O que **não** existe é o jogador como entidade: hoje ele só existe enquanto está
conectado. Fechou o jogo, sumiu da tela.

**Confira antes de começar:** `npm test -w core` deve estar verde.

---

## 1. A decisão que estrutura tudo: duas tabelas, não uma

Um jogador é da **rede**; o que ele fez é de **cada servidor**. Misturar as duas
coisas numa tabela só é o erro que se paga depois, e o projeto anterior já
tinha chegado a essa separação:

```
  players               QUEM ele é       — um por SteamID, para a rede inteira
  player_servers        O QUE ele fez    — uma linha por (servidor, jogador)
```

**Por que a identidade não pode ser por servidor.** "Quem é este jogador?" tem
UMA resposta: o nome dele, desde quando joga aqui, se está banido. Se essa
resposta morasse por servidor, um jogador com cinco servidores teria cinco
"desde quando", e o banimento de rede não teria a quem se pendurar — que é
exatamente o problema que a BanList resolveu na fase anterior.

**E por que a atividade não pode ser global.** "Desde quando ele joga?" e "desde
quando ele joga NO PVE?" são perguntas diferentes, e as duas são feitas. Quem
joga no `pvp1` desde maio e entrou no `pve` ontem é *jogador desde maio* na rede
e *desde ontem* no `pve`. Uma coluna só apaga essa diferença.

### O modelo (a próxima migração livre)

> **Confira o fim de `MIGRATIONS` antes de numerar.** A 005 é a BanList; a
> numeração seguinte pode ter avançado. Nunca edite uma migração já aplicada: um
> banco que já a rodou não a roda de novo, e a mudança sumiria em silêncio nas
> máquinas que já estão de pé.

```sql
CREATE TABLE players (
  -- A CHAVE É O SteamID, e ele é TEXT.
  -- 17 dígitos passam de 2^53: em INTEGER, o id volta arredondado
  -- e a ficha seria de outra pessoa.
  steam_id    TEXT PRIMARY KEY,

  -- O nome mais recente que vimos. Ele MUDA, e o histórico de
  -- nomes é uma tabela futura — não invente ela agora.
  name        TEXT NOT NULL,

  -- Epoch ms. `first_seen` nunca muda depois da inserção: é o
  -- "jogador desde", e reescrevê-lo apagaria a única informação
  -- que não dá para reconstruir.
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,

  -- O último IP visto. NULLABLE de propósito: o `playerlist` traz,
  -- o `origemz.players` não — e um IP inventado é pior que um
  -- campo vazio.
  last_ip     TEXT,

  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_players_name ON players (name COLLATE NOCASE);
CREATE INDEX idx_players_last_seen ON players (last_seen DESC);

CREATE TABLE player_servers (
  server_id     TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  steam_id      TEXT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,

  -- Primeira e última vez NESTE servidor. Ver acima: as irmãs de
  -- rede moram em `players`, e as duas respostas são diferentes.
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,

  -- A sessão CORRENTE neste servidor. Uma por servidor é o ponto:
  -- é o que permite estar online no pvp1 e ter saído do pve.
  -- `joined_at` preenchido com `left_at` nulo = está online AQUI.
  joined_at     INTEGER,
  left_at       INTEGER,
  leave_reason  TEXT,

  sessions      INTEGER NOT NULL DEFAULT 0,
  -- Tempo somado, em segundos. Contado no FECHAMENTO da sessão —
  -- ver a armadilha do agente reiniciado, adiante.
  played_seconds INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (server_id, steam_id)
);

CREATE INDEX idx_player_servers_player ON player_servers (steam_id);
```

**Convenções do banco, que valem para você:** datas são `INTEGER` com epoch em
**milissegundos** — a borda HTTP formata para ISO na saída. (O projeto anterior
usava TEXT ISO; **não copie isso**, a convenção mudou e está escrita no cabeçalho
de `migrations.ts`.) Booleano é `INTEGER` 0/1 com `CHECK`; toda coluna que aponta
para um servidor referencia `servers(id)` com `ON DELETE CASCADE`.

---

## 2. De onde vêm os dados

Esta é a parte que decide se a fase funciona. **Não invente fonte nova sem
verificar** — a fase anterior queimou uma tarde lendo o log do RCON para achar o
chat, quando o jogo tinha `chat.tail` pronto e estruturado. Antes de escrever o
leitor, pergunte ao servidor:

```
find <assunto>        lista comandos e variáveis com aquele nome
```

O que já se sabe:

| Fonte | Dá | Não dá |
|---|---|---|
| `origemz.players` (plugin) | SteamID, nome, posição, vida, ping, tempo de conexão | IP |
| `playerlist` (nativo) | SteamID, nome, ping, tempo de conexão, vida, **IP** | posição, estado |
| evento `log` do RCON | as linhas de entrada e saída, ao vivo | histórico anterior |

### A presença: quem está online, e quando entrou/saiu

Duas estratégias, e a diferença importa:

**Varredura (polling).** A cada N segundos, compare quem o servidor lista com
quem a tabela diz estar online. Quem apareceu, entrou; quem sumiu, saiu. É
simples, sobrevive a reinício do agente e **não depende de decorar o formato de
uma linha de log** — que foi a lição do chat.

**Evento de log.** Mais imediato, e frágil pelo mesmo motivo de sempre: o texto
da linha muda entre versões e um plugin pode reescrevê-lo.

Comece pela varredura, usando o leitor que já existe (`PlayersReader`). Se um dia
o evento entrar, ele acelera — não substitui.

### As três armadilhas da presença

1. **O agente reinicia com gente online.** As sessões abertas ficam com
   `joined_at` preenchido para sempre, e o tempo jogado explode. No boot,
   RECONCILIE: quem a tabela diz estar online e o servidor não lista, teve a
   sessão fechada com `leave_reason = 'agente reiniciado'` — e some do "online
   agora" da tela. Nunca deixe uma sessão aberta que ninguém consegue fechar.

2. **O servidor cai.** Mesma coisa, pelo gancho que já existe:
   `onRconConnected` em `servers/context.ts` avisa quando a conexão volta. É lá
   que a BanList reconcilia hoje, e é lá que a presença deve reconciliar também.

3. **"Sem posição" não é "offline".** O `playerlist` nativo não diz se o jogador
   está dormindo. Um jogador dormindo continua online no Rust, e tratá-lo como
   saída faria a contagem da rede discordar da do jogo.

---

## 3. As rotas

```
GET    /api/players?q=<busca>&online=1&limit=&offset=
GET    /api/players/:steamId
GET    /api/players/:steamId/servers        onde ele joga, e desde quando
GET    /api/players/:steamId/events?limit=  o histórico dele (ver a seção 5)
```

**`steamId` é string em toda a API** — no parâmetro de rota, no corpo, no zod e
no JSON. Nunca `z.number()`, nunca `Number(steamId)`.

**A listagem é PAGINADA desde a primeira versão.** Uma rede com meses de vida
tem dezenas de milhares de jogadores, e uma rota que devolve tudo é uma rota que
um dia derruba o agente. Devolva `total` junto — sem ele, a tela não sabe se há
página seguinte.

A ficha de um jogador junta o que já existe em vez de duplicar:

```json
{ "ok": true,
  "player": { "steamId": "76561198000000000", "name": "Fulano",
              "firstSeen": "…", "lastSeen": "…", "online": true },
  "ban": { "…": "o ban ATIVO, vindo da BanList. null se não há" },
  "servers": [ { "serverId": "pvp1", "firstSeen": "…", "lastSeen": "…",
                 "sessions": 42, "playedSeconds": 187200, "online": true } ] }
```

O `ban` sai de `bans-repository.ts`, e **não** de uma coluna nova em `players`.
Duas fontes para "ele está banido?" divergem no primeiro ajuste — e a que
divergiria é a cópia.

---

## 4. As telas

**Sidebar → Jogadores.** A lista de rede, ícone lucide `Users`, entre *Plugins* e
*Banidos*. Tabela, pelo mesmo motivo das outras telas de rede: é uma tela de
comparação. Por linha: nome e SteamID, onde está agora (ou o último servidor),
visto pela última vez, e um sinal de banido.

Busca por nome ou SteamID, e um filtro de *online agora*. Paginação de verdade —
"carregar mais" ou páginas, não uma lista infinita que trava o navegador.

**Sidebar → Jogadores → um jogador** (`/jogador?id=<steamId>`, query string pelo
mesmo motivo de `/servidor`: o painel é export estático).

A ficha, em abas ou blocos:

- **Identidade** — nome, SteamID (com *Copiar*), jogador desde, visto por
  último, e o estado de banimento **com o botão de banir/revogar**, reusando o
  `BanDialog` que já existe;
- **Servidores** — onde ele joga, desde quando em cada um, sessões e tempo;
- **Histórico** — a linha do tempo dele (ver adiante).

---

## 5. O histórico: o que é real e o que é mock

Esta fase entrega a **estrutura** do histórico com pouca coisa dentro, e isso é
deliberado — o resto entra quando cada fonte existir.

**Real desde já**, porque o dado já existe:

- entrou e saiu de um servidor (a presença desta fase);
- foi banido / teve o banimento revogado (a tabela `bans`, com `created_by`);
- foi expulso ou teleportado pelo painel (hoje isso vai só para o log do
  processo — passe a gravar).

**Mock, por enquanto:** kills, mortes, itens, tempo por wipe. Os dados não
existem: o jogo não os entrega pelo RCON, e o plugin ainda não os coleta.

> **Um mock que não se anuncia é uma mentira.** Se a aba mostra kills
> inventados, ela precisa DIZER, na própria tela, que aquilo é exemplo e ainda
> não é medido. A regra "ausente vira travessão, nunca zero" existe pelo mesmo
> motivo: quem administra decide com base no que a tela diz.

O caminho para tornar real: um comando novo no `OrigemZPlayer` que reporte
eventos (morte, kill) por hook do Oxide, no mesmo contrato dos que já existem —
`core/src/game/plugin-contract.ts` é onde o formato mora.

**Ranking fica de fora desta fase.** Ele depende de kills e tempo medidos, e
construí-lo sobre mock seria fixar uma regra de pontuação em cima de números
falsos. O que esta fase deve garantir é que os dados que o ranking vai somar
tenham onde ser guardados.

---

## Regras que não se negociam

1. **Rota nova entra no escopo `/api`** de `core/src/http/server.ts`. O guarda de
   autenticação está lá; rota fora dele nasce sem autenticação.
2. **Mensagem de erro em português, nascida no módulo que conhece a regra** —
   nunca reescrita na tela. Use `ApiError(code, message, status)`.
3. **`steamId` é string em toda parte.** No banco, no zod, na rota e no JSON.
4. **Ausente vira travessão, nunca zero** (`panel/src/lib/format.ts`). "0 horas
   jogadas" e "não sei quantas" são respostas diferentes.
5. **O que a tela mostra sai do agente.** Nada de adivinhar no navegador.
6. **Não duplique o que já existe.** O ban vem da BanList; quem está online vem
   do `PlayersReader`; o chat vem do `chat.tail`. Uma segunda fonte para o mesmo
   fato é a que diverge.
7. **Nada de `confirm()` do navegador**: `ConfirmButton` para o que bane ou
   expulsa; `toast` para o desfecho.
8. **Migração nova vai no fim de `MIGRATIONS`**, com o número livre seguinte.
9. **A listagem é paginada desde a primeira versão.**
10. **Mock é rotulado na tela.**

---

## Como verificar

```powershell
npx tsc --noEmit -p core/tsconfig.json
npm run typecheck -w core
npm test -w core
npm run lint -w core
npm run build -w panel
npm run lint -w panel
```

Testes que valem a pena existir (vitest, em `core/test/`):

- o mesmo SteamID entrando em dois servidores tem **uma** linha em `players` e
  **duas** em `player_servers`;
- `first_seen` da rede NÃO muda quando o jogador entra num servidor novo — mas o
  `first_seen` daquele servidor é o de hoje;
- uma sessão aberta é fechada na reconciliação do boot, e o tempo jogado soma
  uma vez só (rodar a reconciliação duas vezes não dobra o número);
- o SteamID sobrevive à ida e volta pela API sem perder dígito — use um de 17
  dígitos com dígitos até o fim, como `76561198123456789` (o
  `76561198000000000` sobrevive a um `Number()` por acidente, porque termina em
  zeros, e não prova nada);
- a ficha de um jogador banido traz o ban da tabela `bans`, e não uma cópia.

Na máquina, com o `server01`:

1. entrar no jogo e ver o jogador aparecer na lista de rede em segundos;
2. sair, e ver a sessão fechar com o tempo somado;
3. reiniciar o agente com o jogador online e conferir que **não** ficou sessão
   aberta duplicada nem tempo inflado;
4. banir pela ficha e ver o `banid` sair no Console daquele servidor.

Commits em português, explicando o **porquê** da mudança e o que dava errado
antes — leia o `git log` para pegar o tom. Não faça `git push` sem pedir.

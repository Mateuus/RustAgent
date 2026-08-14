# 12 — Briefing: a aba Administração e a BanList global

> **Este documento é um briefing de execução.** Ele existe para ser entregue
> inteiro a quem vai construir — humano ou agente — sem precisar de mais
> contexto do que os arquivos que ele mesmo aponta.

Projeto: `F:\Projects\RustAgent` (Windows, Node 20+, npm workspaces —
`core` = Fastify/TypeScript, `panel` = Next.js em export estático servido pelo
próprio core).

Este briefing é o **bloco 2 e o bloco 3** de
[10-FASE-ADMINISTRACAO.md](10-FASE-ADMINISTRACAO.md). O bloco 1 (Plugins) está
pronto e no `main`. O bloco 4 (Map View) fica para depois, e depende do que você
construir aqui.

**Você não trabalha sozinho.** Há outro agente mexendo na área de Plugins ao
mesmo tempo. A seção *Não pise no outro agente*, no fim, diz o que é seu e o que
não é. Leia-a antes de tocar em qualquer arquivo.

---

## Antes de escrever qualquer linha

Leia, nesta ordem:

| Arquivo | O que você tira dele |
|---|---|
| [10-FASE-ADMINISTRACAO.md](10-FASE-ADMINISTRACAO.md), seções **2** e **3** | o desenho que você vai construir. É a fonte |
| [02-ARQUITETURA.md](02-ARQUITETURA.md) | camadas, fonte da verdade, ciclo de vida |
| [03-DECISOES.md](03-DECISOES.md) | D1–D11: o porquê de cada escolha já feita |
| [06-API.md](06-API.md) | o formato de erro e o padrão das rotas |
| [07-PAINEL.md](07-PAINEL.md) | o que a tela pode e não pode fazer |
| `core/src/db/migrations.ts` | o mecanismo, e as 001–004 que já existem |
| `core/src/db/plugins-repository.ts` | **o padrão de repositório a copiar** |
| `core/src/rcon/client.ts` | `send()`, `isConnected`, o evento `log` |
| `core/src/servers/console-buffer.ts` | o buffer de linhas do RCON |
| `core/src/servers/supervisor.ts` | como um servidor entra e sai do ar |
| `core/src/steam/update-watcher.ts` | **o desenho de relógio** que você vai repetir |
| `panel/src/components/server-settings.tsx` | o padrão de sub-abas e de `Card` |
| `panel/src/components/plugins-panel.tsx` | o padrão de painel de aba, recém-feito |

O projeto tem um estilo de comentário deliberado: o cabeçalho de cada arquivo
explica **por que ele existe** e **o que dá errado sem ele**, com blocos `####`
marcando as armadilhas. Siga isso — comentário que só repete o código é ruído.

---

## O que mudou desde o briefing 10

O bloco 1 foi entregue e **mudou uma premissa sua**: o `OrigemZPlayer` já pode
estar ligado no servidor pelo painel, sem ninguém copiar arquivo à mão.

- os seis plugins `OrigemZ*` estão em `Plugins\` (a biblioteca do agente);
- a aba **Plugins** do servidor tem duas colunas — disponíveis e ativos — e o
  administrador liga/desliga em tempo real (`oxide.reload` / `oxide.unload`);
- três deles declaram `// Requires: OrigemZAgent`, e o agente já sabe disso: ele
  avisa o que falta ao ligar e recusa desligar quem tem dependentes;
- migrações **002, 003 e 004** já existem. **A sua é a 005.**

Isso significa que a aba Jogadores pode contar com o `origemz.players` — e que o
caminho de "ligar o plugin" quando ele faltar já existe e é uma tela, não uma
instrução para o operador copiar arquivo.

**Confira antes de começar:** `npm test -w core` deve dar 53 testes passando.

---

## 1. A aba "Administração", na página do servidor

Entre **Visão** e **Console**. Ícone lucide `ShieldCheck`. Sub-abas no mesmo
padrão de `server-settings.tsx` — pílulas com divisória de 1px, condensed 2xs
maiúsculo:

```
  Jogadores | Chat | Admins | Banidos | Comandos
```

A sub-aba **Banidos** depende da seção 2 deste documento. Construa-a por último.

### Jogadores

Quem está online, agora.

**Com o `OrigemZPlayer` ativo**, use `origemz.players`: ele devolve `position`,
`health`, `isAlive`, `isSleeping`, `ping` e `connectedSeconds`. O contrato zod
está em `F:\Projects\Rust\RustAgent\core\src\types\plugin-contract.ts` — **vale
trazê-lo em vez de reescrever**, e ele é a fonte da verdade do outro lado.

**Sem o plugin**, caia para o `playerlist` nativo, que dá SteamID, nome, ping,
tempo conectado e vida — e nada de posição.

- a queda entre um e outro **não é uma escolha do operador**: o agente sabe se o
  plugin está ligado naquele servidor (o acervo já responde isso) e usa o que
  há. A tela diz qual fonte está em uso, e oferece ligar o plugin quando ele
  estiver disponível e desligado;
- **resposta que não bate com o contrato o agente recusa.** O plugin promete um
  JSON de uma linha; se vier outra coisa, é `PLUGIN_INVALID_RESPONSE`, e não um
  `catch` silencioso que devolve lista vazia. "Zero jogadores" e "não consegui
  perguntar" são respostas diferentes, e a segunda não pode se disfarçar da
  primeira;
- por linha: **Expulsar**, **Banir** (abre o diálogo da BanList) e **Copiar
  SteamID**.

### Chat

As mensagens que já passam pelo `ConsoleBuffer` (filtre por `type === 'Chat'` ou
pelo prefixo `[CHAT]`), mais um campo para `say`.

**Não crie um segundo buffer.** Estenda o que existe, ou acrescente um
`ChatBuffer` alimentado pelo **mesmo** evento `log` do `RconClient`. Dois
ouvintes independentes sobre o mesmo socket é o desenho que um dia entrega
metade das linhas para cada um.

### Admins

`ownerid`, `moderatorid`, `removeowner`, `removemoderator`.

Leia `Servers\<id>\server\<identity>\cfg\users.cfg` **só para listar**. Editar
esse arquivo com o servidor no ar perde a mudança no próximo `server.writecfg` —
o jogo reescreve o arquivo inteiro a partir do que ele tem em memória. Quem muda
o estado é o comando pelo RCON, sempre.

### Comandos

Os atalhos da semana, cada um com o que faz escrito ao lado: `server.save`,
`server.writecfg`, `oxide.reload *`, `weather.rain 0`, `env.time 12`. Mais um
campo livre reaproveitando `POST /api/servers/:id/rcon`, que já existe.

---

## 2. A BanList global (migração 005)

Hoje cada servidor tem a sua lista, no `cfg/bans.cfg` dele. Um jogador expulso
do `pvp1` entra no `pvp2` no minuto seguinte, e quem administra descobre pelo
Discord. A BanList global torna o banimento **estado do agente**, com cada
servidor como espelho.

### O modelo

```sql
CREATE TABLE bans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  steam_id    TEXT NOT NULL,
  name        TEXT,                  -- o nome de quando foi banido
  reason      TEXT NOT NULL,
  -- 'network' = vale em TODO servidor, inclusive nos que ainda vão nascer
  -- 'servers' = vale nos listados em ban_servers, e em nenhum outro
  scope       TEXT NOT NULL CHECK (scope IN ('network','servers')),
  created_at  INTEGER NOT NULL,
  created_by  TEXT,
  expires_at  INTEGER,               -- NULL = permanente
  revoked_at  INTEGER,               -- NULL = ativo
  revoked_by  TEXT,
  origin      TEXT NOT NULL DEFAULT 'panel'   -- 'panel' | 'adopted'
);

-- UM banimento ATIVO por SteamID. Dois ativos não têm resposta para
-- "qual motivo vale?" nem para "revogar fecha qual?".
CREATE UNIQUE INDEX idx_bans_active ON bans (steam_id) WHERE revoked_at IS NULL;

CREATE TABLE ban_servers (
  ban_id    INTEGER NOT NULL REFERENCES bans(id) ON DELETE CASCADE,
  server_id TEXT    NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  PRIMARY KEY (ban_id, server_id)
);
```

> **Por que `network` não é uma lista com todos os servidores.** A lista seria a
> de hoje. No dia em que o `pvp3` for cadastrado, todo ban de rede feito antes
> dele deixaria de valer lá — em silêncio, sem erro nenhum, e a descoberta seria
> o banido jogando. `scope = 'network'` não enumera ninguém, e por isso não
> envelhece. É a mesma decisão do escopo de VIP do projeto anterior (migração
> 035, em `F:\Projects\Rust\RustAgent\core\src\db\migrations.ts`).

Convenções do banco, que valem para você: datas são `INTEGER` com epoch em
**milissegundos** (a borda HTTP formata para ISO na saída); booleano é `INTEGER`
0/1 com `CHECK`; toda coluna que aponta para um servidor referencia
`servers(id)` com `ON DELETE CASCADE`.

### A sincronização com o jogo

O Rust não tem banlist remota: existe o `bans.cfg` de cada servidor, e o agente
é quem mantém os dois lados iguais.

- use **`banid <steamid> "<nome>" "<motivo>"`**, nunca `ban`. O `ban` só
  funciona com quem está conectado, e a maioria dos banimentos por sincronização
  é de gente offline;
- depois de um lote, **`server.writecfg`**. Sem ele o `bans.cfg` só é gravado
  quando o servidor decidir, e um crash perde tudo;
- `unban <steamid>` para revogar;
- **reconcilie em três momentos**: quando o agente sobe, quando um servidor é
  ligado, e quando o RCON reconecta.

| Situação | O que fazer |
|---|---|
| na tabela, não no servidor | `banid` |
| no servidor, não na tabela | **adotar** (`origin='adopted'`) — nunca apagar |
| revogado na tabela, ainda no servidor | `unban` |

### A expiração é nossa

O ban do Rust é permanente: não existe "banir por 7 dias" no jogo. Se
`expires_at` for suportado — e deve ser, é o pedido mais comum —, quem desbane é
um relógio no agente, no mesmo desenho do vigia da Steam
(`core/src/steam/update-watcher.ts`): intervalo configurável, `unref()` no
timer, e cede a vez se houver operação em curso.

Um ban vencido que ninguém removeu é pior que não ter prazo: a pessoa cumpriu a
pena e continua fora.

### Rotas

```
GET    /api/bans?active=1&q=<busca>     a lista global
POST   /api/bans                        {steamId, name?, reason, scope,
                                         servers?[], expiresAt?}
DELETE /api/bans/:steamId               revoga (não apaga a linha)
GET    /api/servers/:id/bans            o que vale ali, com a origem
POST   /api/servers/:id/bans/sync       reconcilia agora
```

`steamId` é **string** em toda a API. Em número, um SteamID64 passa de 2^53 e
perde precisão — o ban iria para a conta errada. Isso vale no zod, no
repositório e no JSON: nunca `z.number()`, nunca `Number(steamId)`.

### As telas

**Sidebar → Banidos** (tela de rede): busca por SteamID ou nome, escopo, quem
aplicou, quando vence, botão de revogar. Tabela, pelo mesmo motivo da lista de
servidores e da de plugins — é uma tela de comparação.

**Servidor → Administração → Banidos**: o que vale ali e de onde veio — rede,
específico, ou adotado do `bans.cfg`.

---

## Regras que não se negociam

1. **Rota nova entra no escopo `/api`** de `core/src/http/server.ts`. O guarda
   de autenticação está lá; rota fora dele nasce sem autenticação.
2. **Mensagem de erro em português, nascida no módulo que conhece a regra** —
   nunca reescrita na tela. Use `ApiError(code, message, status)`.
3. **Nada de `confirm()` do navegador**: `ConfirmButton` para o que expulsa,
   bane ou derruba; `toast` para o desfecho.
4. **Ausente vira travessão, nunca zero** (`panel/src/lib/format.ts`).
5. **O processo manda no estado**, o RCON diz se dá para falar com ele
   (`panel/src/components/server-state.tsx`).
6. **O que a tela mostra sai do agente.** Nada de adivinhar no navegador.
7. **Migração nova é a 005**, no fim de `MIGRATIONS`. A 007 em diante é do outro
   agente — ver a seção seguinte. Nunca edite uma migração já aplicada: um banco
   que já a rodou não a roda de novo, e a mudança sumiria em silêncio nas
   máquinas que já estão de pé.
8. **Interruptor é o segmentado** de `panel/src/components/ui/toggle.tsx`
   (Ligado/Desligado escrito), nunca uma pílula deslizante — o design system não
   tem forma orgânica, e cor sozinha não fala com quem não a distingue.
9. **Comando destrutivo pelo RCON é registrado.** Expulsar e banir passam pelo
   log do agente com quem pediu, porque "quem baniu este jogador?" é a primeira
   pergunta de toda discussão sobre banimento.

---

## Não pise no outro agente

Outro agente está construindo a **configuração de plugins pela tela** ao mesmo
tempo que você.

**Trabalhe numa branch própria:**

```powershell
git checkout -b administracao
```

### Seus arquivos (mexa à vontade)

```
core/src/db/bans-repository.ts          (novo)
core/src/bans/*                          (novo)
core/src/game/*                          (novo — a leitura de jogadores)
core/src/http/routes/admin.ts            (novo)
core/src/http/routes/bans.ts             (novo)
core/test/bans*.test.ts                  (novo)
panel/src/components/admin-panel.tsx     (novo)
panel/src/app/banidos/                   (novo)
```

### Arquivos compartilhados (cuidado, os dois mexem)

| Arquivo | Como conviver |
|---|---|
| `core/src/db/migrations.ts` | **você é a 005 e a 006**; ele é a 007+. Acrescente no fim, nunca renumere |
| `core/src/http/server.ts` | uma linha de `registerXRoutes` por rota nova. Acrescente no fim do bloco |
| `panel/src/lib/api.ts` | acrescente os seus métodos **no fim** do objeto `agent`, num bloco com comentário |
| `panel/src/app/servidor/page.tsx` | **é seu**: a aba *Administração* entra entre Visão e Console. Ele não mexe aqui |
| `panel/src/components/sidebar.tsx` | **é seu**: o item *Banidos*. Ele não mexe aqui |
| `Docs/06-API.md`, `Docs/07-PAINEL.md` | escreva só nas suas seções (Administração, Bans) |

**Não toque em** `core/src/oxide/*`, `core/src/http/routes/plugins.ts`,
`panel/src/components/plugins-panel.tsx` nem `panel/src/app/plugins/`. Se
precisar saber se um plugin está ligado num servidor, use o que o
`PluginLibrary` já expõe (`serverList`) — não leia a tabela direto e não mexa no
arquivo dele.

Não faça `git push` na `main`. Não faça merge da branch dele.

---

## Como verificar

```powershell
npx tsc --noEmit -p core/tsconfig.json
npm run typecheck -w core
npm test -w core
npm run build -w panel
npm run lint -w panel
npm run lint -w core
```

Testes que valem a pena existir (vitest, em `core/test/`):

- o índice único recusa dois bans ativos para o mesmo SteamID;
- a reconciliação **adota** o que está no servidor e não na tabela, e não apaga
  nada;
- um ban vencido é revogado pelo relógio e vira `unban`;
- um ban de escopo `network` vale num servidor **cadastrado depois** dele;
- o SteamID sobrevive à ida e volta pela API sem perder dígito (use um de 17
  dígitos de verdade nos testes, como `76561198000000000`).

Na máquina, com o `server01` (existe e está instalado):

1. ligar o `OrigemZAgent` e o `OrigemZPlayer` pela aba Plugins;
2. abrir **Administração → Jogadores** e ver a lista com posição;
3. desligar o `OrigemZPlayer` e ver a tela cair para o `playerlist` nativo,
   dizendo que a posição não está disponível;
4. banir um SteamID pela tela de rede e ver o `banid` sair no Console;
5. parar o servidor, banir outro, subir de novo e ver a reconciliação aplicar o
   que faltava.

Commits em português, explicando o **porquê** da mudança e o que dava errado
antes — leia o `git log` para pegar o tom. Não faça `git push` sem pedir.

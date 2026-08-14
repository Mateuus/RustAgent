# 10 — Fase: Administração, Plugins e Map View

> **Este documento é um briefing de execução.** Ele existe para ser entregue
> inteiro a quem vai construir esta fase — humano ou agente — sem precisar de
> mais contexto do que os arquivos que ele mesmo aponta.

Projeto: `F:\Projects\RustAgent` (Windows, Node 20+, npm workspaces —
`core` = Fastify/TypeScript, `panel` = Next.js em export estático servido pelo
próprio core).

---

## Antes de escrever qualquer linha

Leia, nesta ordem:

| Arquivo | O que você tira dele |
|---|---|
| [02-ARQUITETURA.md](02-ARQUITETURA.md) | camadas, fonte da verdade, ciclo de vida do servidor |
| [03-DECISOES.md](03-DECISOES.md) | D1–D11: o porquê de cada escolha já feita |
| [06-API.md](06-API.md) | o formato de erro e o padrão das rotas |
| [07-PAINEL.md](07-PAINEL.md) | o que a tela pode e não pode fazer |
| `core/src/db/migrations.ts` | o mecanismo de migração (você vai criar a 002) |
| `core/src/servers/supervisor.ts` | como um servidor entra e sai do ar |
| `core/src/servers/context.ts` | o que um servidor "cuidado" tem |
| `core/src/rcon/client.ts` | `send()`, `isConnected`, o evento `log` |
| `core/src/servers/console-buffer.ts` | o buffer de linhas do RCON |
| `core/src/oxide/plugins.ts` | instalar, listar, remover e recarregar `.cs` |
| `panel/src/components/server-settings.tsx` | o padrão de sub-abas e de `Card` |

O projeto tem um estilo de comentário deliberado: o cabeçalho de cada arquivo
explica **por que ele existe** e **o que dá errado sem ele**, com blocos `####`
marcando as armadilhas. Siga isso — comentário que só repete o código é ruído.

---

## 1. Plugins: o agente é o dono, o servidor é quem ativa

Hoje há uma aba **Plugins** dentro do servidor que sobe um `.cs` para
`Servers/<id>/oxide/plugins`. Isso é metade do desenho, e a metade errada de
começar: cada servidor vira uma cópia solta dos mesmos arquivos, e atualizar
um plugin em cinco servidores é subir o mesmo arquivo cinco vezes.

A separação certa são **dois lugares**:

```
  SIDEBAR → Plugins        a BIBLIOTECA do agente. Um lugar para o .cs,
                           com versão, descrição e de onde ele veio.

  SERVIDOR → Plugins       o que ESTE servidor usa. O administrador liga
                           e desliga; o agente copia, remove e recarrega.
```

### A biblioteca (nível de rede)

`Plugins/` na raiz do projeto — a pasta já está no `.gitignore`.

Cada plugin é um `.cs` mais o que o agente sabe sobre ele:

```sql
CREATE TABLE plugins (
  name        TEXT PRIMARY KEY,     -- "OrigemZPlayer" (sem .cs)
  file        TEXT NOT NULL,        -- "OrigemZPlayer.cs"
  title       TEXT,                 -- lido do [Info(...)] do próprio .cs
  author      TEXT,
  version     TEXT,
  description TEXT,
  bytes       INTEGER NOT NULL,
  sha256      TEXT NOT NULL,        -- é o que responde "mudou?"
  added_at    INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE server_plugins (
  server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  plugin_name TEXT NOT NULL REFERENCES plugins(name) ON DELETE CASCADE,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  -- o sha256 do que está EM DISCO naquele servidor. Diferente do da
  -- biblioteca = "há atualização para aplicar".
  applied_sha TEXT,
  applied_at  INTEGER,

  PRIMARY KEY (server_id, plugin_name)
);
```

O `[Info("Nome", "Autor", "1.2.3")]` e o `[Description("…")]` são lidos do
próprio arquivo por regex na hora do upload. Não invente um formulário de
metadados: o dado já está no `.cs`, e um formulário é a segunda fonte que um
dia diverge.

### Ligar e desligar, num servidor

| Ação | O que o agente faz |
|---|---|
| ligar | copia `Plugins/<file>` para `Servers/<id>/oxide/plugins/`, grava `applied_sha`, e `oxide.reload <Nome>` |
| desligar | `oxide.unload <Nome>`, apaga o `.cs` daquele servidor, mantém a linha com `enabled=0` |
| atualizar | quando `applied_sha ≠ plugins.sha256`: recopia e recarrega |

**A configuração do plugin NÃO é apagada.** `oxide/config/<Nome>.json` e
`oxide/data/` ficam onde estão — desligar um plugin para testar e voltar
atrás não pode custar a configuração dele. Diga isso na tela.

### Adoção

Todo servidor que já tem `.cs` em `oxide/plugins` e não está na biblioteca
entra como **adotado**: o arquivo é copiado PARA a biblioteca, e a linha
nasce com `enabled=1`. Nunca apague o que já estava lá — aquele plugin foi
decisão de alguém, e o agente acabou de chegar.

### A tela

**Sidebar → Plugins** — a biblioteca: enviar `.cs`, ver versão e autor, em
quantos servidores está ativo, remover. Remover da biblioteca com servidores
usando pede confirmação e diz **quais**.

**Servidor → Plugins** — a lista da biblioteca com um interruptor por
plugin (o segmentado de `server-settings.tsx`, nunca um switch de pílula),
mais o aviso de "há versão nova para aplicar" quando os `sha256` divergem.

---

## 2. Aba "Administração", na página do servidor

Entre **Visão** e **Console**. Ícone lucide `ShieldCheck`. Sub-abas no mesmo
padrão de `server-settings.tsx` — pílulas com divisória de 1px, condensed 2xs
maiúsculo:

```
  Jogadores | Chat | Admins | Banidos | Comandos
```

**Jogadores.** Quem está online. Com o `OrigemZPlayer` ativo, use
`origemz.players` — ele já devolve `position`, `health`, `isAlive`,
`isSleeping`, `ping` e `connectedSeconds` (o contrato zod está em
`F:\Projects\Rust\RustAgent\core\src\types\plugin-contract.ts`, e vale a pena
trazê-lo em vez de reescrever). Sem o plugin, caia para o `playerlist`
nativo, que dá SteamID, nome, ping, tempo conectado e vida — e nada de
posição. Por linha: Expulsar, Banir (abre o diálogo da BanList), Copiar
SteamID.

**Chat.** As mensagens lidas do `ConsoleBuffer` que já existe (filtre por
`type === 'Chat'` / prefixo `[CHAT]`), mais um campo para `say`. Não crie um
segundo buffer: estenda o que existe, ou acrescente um `ChatBuffer`
alimentado pelo **mesmo** evento `log`.

**Admins.** `ownerid`, `moderatorid`, `removeowner`, `removemoderator`. Leia
`Servers/<id>/server/<identity>/cfg/users.cfg` **só para listar**: editar
esse arquivo com o servidor no ar perde a mudança no próximo
`server.writecfg`.

**Banidos.** A visão daquele servidor sobre a BanList global (adiante).

**Comandos.** Os atalhos da semana, cada um com o que faz escrito ao lado:
`server.save`, `server.writecfg`, `oxide.reload *`, `weather.rain 0`,
`env.time 12`. Mais um campo livre reaproveitando `POST /api/servers/:id/rcon`.

---

## 3. BanList global

Hoje cada servidor tem a sua lista, no `cfg/bans.cfg` dele. Um jogador
expulso do `pvp1` entra no `pvp2` no minuto seguinte, e quem administra
descobre pelo Discord. A BanList global torna o banimento **estado do
agente**, com cada servidor como espelho.

### O modelo (migração 002)

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

> **Por que `network` não é uma lista com todos os servidores.** A lista seria
> a de hoje. No dia em que o `pvp3` for cadastrado, todo ban de rede feito
> antes dele deixaria de valer lá — em silêncio, sem erro nenhum, e a
> descoberta seria o banido jogando. `scope = 'network'` não enumera ninguém,
> e por isso não envelhece. É a mesma decisão do escopo de VIP do projeto
> anterior (migração 035, em
> `F:\Projects\Rust\RustAgent\core\src\db\migrations.ts`).

### A sincronização com o jogo

O Rust não tem banlist remota: existe o `bans.cfg` de cada servidor, e o
agente é quem mantém os dois lados iguais.

- use **`banid <steamid> "<nome>" "<motivo>"`**, nunca `ban`. O `ban` só
  funciona com quem está conectado, e a maioria dos banimentos por
  sincronização é de gente offline;
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
`expires_at` for suportado — e deve ser, é o pedido mais comum —, quem
desbane é um relógio no agente, no mesmo desenho do vigia da Steam
(`core/src/steam/update-watcher.ts`): intervalo configurável, `unref()` no
timer, e cede a vez se houver operação em curso.

Um ban vencido que ninguém removeu é pior que não ter prazo: a pessoa cumpriu
a pena e continua fora.

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
perde precisão — o ban iria para a conta errada.

### A tela

**Sidebar → Banidos** (tela de rede): busca por SteamID ou nome, escopo, quem
aplicou, quando vence, botão de revogar. E a sub-aba **Banidos** dentro do
servidor mostra o que vale ali e de onde veio: rede, específico, ou adotado do
`bans.cfg`.

---

## 4. Aba "Map View"

O mapa em tempo real, com a posição de quem está online.

### A fonte da posição

**O `OrigemZPlayer` já fornece.** `origemz.players` devolve `position` com
`x`, `y`, `z` — não escreva plugin novo. O que falta é o outro lado:

- se o plugin **não estiver ativo** naquele servidor, a aba diz isso e oferece
  ligá-lo, usando a biblioteca de plugins da seção 1. Não invente um terceiro
  caminho;
- o `playerlist` nativo **não serve** aqui: ele não tem posição.

### A projeção (isto poupa horas)

O mundo do Rust é centrado na origem: `X` e `Z` vão de `-worldSize/2` a
`+worldSize/2`. **`Y` é altura** — ele não entra no mapa 2D, e usar `(x, y)` é
o erro clássico: funciona até alguém subir num prédio.

```
px = ((x + worldSize / 2) / worldSize) * largura
py = ((worldSize / 2 - z) / worldSize) * altura   // Z invertido: cresce para
                                                  // o norte no jogo, para
                                                  // baixo na tela
```

### O desenho

Comece **sem imagem de fundo**: grid com as coordenadas do Rust (A1, B2…, como
o mapa do jogo), pontos dos jogadores, nome no hover. Já é útil e não depende
de serviço externo. A imagem (RustMaps, que exige chave e `seed`+`size`) fica
como melhoria opcional atrás de configuração — e a tela precisa funcionar
inteira sem ela.

`<canvas>` ou SVG, atualizando a cada 2 s. **Não interpole o movimento** na
primeira versão: animação contínua custa FPS no navegador, e essa lição já foi
paga uma vez (ver [09-ROADMAP.md](09-ROADMAP.md), o overlay de propagandas).

Clicar num jogador abre as ações da aba Jogadores — expulsar, banir — sem sair
do mapa.

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
7. **Migração nova é 002**, no fim de `MIGRATIONS`. Nunca edite a 001: um
   banco que já a aplicou não a roda de novo, e a mudança sumiria em silêncio
   nas máquinas que já estão de pé.
8. **Interruptor é o segmentado** de `server-settings.tsx` (Ligado/Desligado
   escrito), nunca uma pílula deslizante — o design system não tem forma
   orgânica, e cor sozinha não fala com quem não a distingue.

---

## Como verificar

```powershell
npx tsc --noEmit -p core/tsconfig.json
npm run build -w panel
npm run lint -w panel
npm test -w core
```

Testes que valem a pena existir (vitest, em `core/test/`):

- o índice único recusa dois bans ativos para o mesmo SteamID;
- a reconciliação **adota** o que está no servidor e não na tabela, e não
  apaga nada;
- um ban vencido é revogado pelo relógio e vira `unban`;
- ligar um plugin copia o arquivo e grava o `applied_sha`; desligar apaga o
  `.cs` e **preserva** `oxide/config/<Nome>.json`.

Na máquina, com o servidor `server01` (existe e está instalado):

1. enviar o `OrigemZPlayer.cs` para a biblioteca e ligá-lo no `server01`;
2. abrir **Administração → Jogadores** e ver a lista com posição;
3. banir um SteamID pela tela de rede e ver o `banid` sair no Console;
4. abrir o **Map View** e ver os pontos se moverem.

Commits em português, explicando o **porquê** da mudança e o que dava errado
antes — leia o `git log` para pegar o tom. Não faça `git push` sem pedir.

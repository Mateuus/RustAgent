# 11 — Briefing: Plugins, a partir daqui

> **Este documento é um briefing de execução.** Ele existe para ser entregue
> inteiro a quem vai construir — humano ou agente — sem precisar de mais
> contexto do que os arquivos que ele mesmo aponta.

Projeto: `F:\Projects\RustAgent` (Windows, Node 20+, npm workspaces —
`core` = Fastify/TypeScript, `panel` = Next.js em export estático servido pelo
próprio core).

**Você trabalha sozinho nesta área.** Há outro agente construindo a fase de
Administração ao mesmo tempo. A seção *Não pise no outro agente*, no fim, diz o
que é seu e o que não é. Leia-a antes de tocar em qualquer arquivo.

---

## Antes de escrever qualquer linha

Leia, nesta ordem:

| Arquivo | O que você tira dele |
|---|---|
| [02-ARQUITETURA.md](02-ARQUITETURA.md) | camadas, fonte da verdade, ciclo de vida |
| [03-DECISOES.md](03-DECISOES.md) | D1–D11: o porquê de cada escolha já feita |
| [06-API.md](06-API.md), seção **Plugins** | o contrato que você vai estender |
| [07-PAINEL.md](07-PAINEL.md) | o que a tela pode e não pode fazer |
| `core/src/oxide/library.ts` | **o coração do que existe.** Leia inteiro |
| `core/src/db/plugins-repository.ts` | as duas tabelas |
| `core/src/oxide/plugin-metadata.ts` | o que se lê do próprio `.cs` |
| `core/test/plugin-library.test.ts` | as regras que já estão travadas |
| `panel/src/components/plugins-panel.tsx` | a aba do servidor, em duas colunas |
| `panel/src/app/plugins/page.tsx` | a tela de rede |

O projeto tem um estilo de comentário deliberado: o cabeçalho de cada arquivo
explica **por que ele existe** e **o que dá errado sem ele**, com blocos `####`
marcando as armadilhas. Siga isso — comentário que só repete o código é ruído.

---

## O que JÁ existe (não refaça)

O acervo de plugins está construído e testado. Em uma tela:

```
  Plugins\                       a BIBLIOTECA — um .cs, uma vez, para
                                 todos os servidores

  Plugins\<id>\                  o CUSTOM daquele servidor — nenhum
                                 outro o enxerga

  Servers\<id>\oxide\plugins\    o que está VALENDO ali agora. Cópia
                                 derivada de um dos dois de cima
```

Migrações **002** (a biblioteca), **003** (o custom — o nome do plugin deixou de
ser chave, porque dois servidores podem ter homônimos com conteúdos diferentes)
e **004** (as dependências).

O que o agente já faz:

- **enviar** um `.cs` para a biblioteca (`POST /api/plugins`) ou como custom de
  um servidor (`POST /api/servers/:id/plugins`);
- **varrer a pasta**: um `.cs` copiado à mão para `Plugins\` ou `Plugins\<id>\`
  entra sozinho, no boot e a cada abertura de tela. Arquivo removido da pasta
  **não** apaga a linha;
- **ligar / desligar / aplicar** por servidor (`PUT`), copiando o arquivo e
  mandando `oxide.reload`. Desligar preserva `oxide\config\<Nome>.json`;
- **adotar** o que já estava em `oxide\plugins` quando o agente chegou;
- **dependências**: lê `// Requires:` e `[PluginReference]` do arquivo. Avisa o
  que falta ao ligar, e **recusa** desligar um plugin do qual outros dependem
  (409 `PLUGIN_HAS_DEPENDENTS`, com `?force=1` para confirmar);
- **conflito de nome**: a biblioteca e o custom não podem ter homônimos ligados
  ao mesmo tempo no mesmo servidor (`blockedBy` na tela, 409 na API).

Os seis plugins `OrigemZ*` já estão em `Plugins\`. Três deles declaram
`// Requires: OrigemZAgent`.

**Confira antes de começar:** `npm test -w core` deve dar 53 testes passando.

---

## 1. A configuração do plugin, pela tela

É o buraco maior. Hoje o operador liga o `OrigemZVip` e, para configurá-lo,
abre `Servers\<id>\oxide\config\OrigemZVip.json` num editor de texto na
máquina. O painel existe justamente para não precisar disso.

### O que o Oxide faz com esse arquivo

O plugin **cria** o `.json` no primeiro carregamento, com os padrões dele. Se o
arquivo já existe, ele lê. Mexer no arquivo com o plugin carregado não tem
efeito até um `oxide.reload <Nome>` — e é por isso que gravar e recarregar
andam juntos aqui.

### As três armadilhas

1. **O plugin reescreve o arquivo.** Vários chamam `SaveConfig()` no
   carregamento, normalizando o que leram. Gravar um JSON e recarregar pode
   devolver um arquivo diferente do que você mandou — e a tela precisa reler
   depois do reload, senão mostra o que ela acha que gravou.

2. **JSON inválido derruba o plugin.** O Oxide não carrega com config quebrada,
   e a mensagem vai para o console do jogo. Valide antes de gravar: se não faz
   `JSON.parse`, recuse com 400 dizendo onde está o erro. Nunca grave um
   arquivo que você já sabe que está quebrado.

3. **Comentário não sobrevive.** JSON não tem comentário e o Oxide reescreve o
   arquivo; não prometa preservar formatação.

### O que construir

```
GET    /api/servers/:id/plugins/:pluginId/config    o JSON de hoje
PUT    /api/servers/:id/plugins/:pluginId/config    grava e recarrega
DELETE /api/servers/:id/plugins/:pluginId/config    apaga: o plugin
                                                    recria com os padrões
```

- **Faça backup antes de gravar.** `Backups\<id>\oxide-config\<Nome>-<epoch>.json`,
  usando o `paths.backupsDir` que já existe. Um JSON gravado errado num plugin
  de VIP é uma noite de trabalho perdida, e o `Ctrl+Z` não existe numa tela.
- O `DELETE` é o "voltar ao padrão": apaga o arquivo e recarrega, e o plugin o
  recria. Diga isso na tela, e faça backup antes dele também.
- Config de plugin **desligado** também é legível: o arquivo continua lá. Não
  esconda a aba nesse caso — só avise que a mudança vale quando ele for ligado.

### A tela

Um editor de texto monoespaçado, com validação de JSON ao digitar (a mensagem
do `JSON.parse` já diz a posição) e o botão de gravar desabilitado enquanto
estiver inválido. **Não** invente formulário a partir do JSON: a estrutura muda
por plugin, e um formulário gerado erra em qualquer coisa aninhada.

Depois de gravar, mostre o que o Oxide respondeu — é onde aparece o erro que a
validação de sintaxe não pega (um campo que o plugin espera e não veio).

---

## 2. Ligar as dependências junto

Hoje, ligar o `OrigemZVip` sem o `OrigemZAgent` funciona e avisa. O passo que
falta é oferecer resolver: **"ligar também o OrigemZAgent"**, na ordem certa.

- a ordem é a topológica: dependência primeiro, dependente depois. Com ciclo —
  que não deveria existir, mas o arquivo é de terceiros —, **recuse** e diga
  quais plugins estão no ciclo, em vez de entrar em laço;
- se a dependência não está no acervo daquele servidor, diga isso: "o
  `OrigemZAgent` não está na biblioteca nem nos customs deste servidor". Ligar
  o que não existe não é uma opção que a tela deva oferecer;
- uma rota só, com o efeito inteiro:
  `POST /api/servers/:id/plugins/:pluginId/enable-with-deps`. A alternativa —
  a tela chamar o `PUT` várias vezes na ordem — põe a regra de ordenação no
  navegador, que é o lugar onde ela não tem teste.

---

## 3. O que mais falta na área

Em ordem de valor. Faça de cima para baixo e pare quando o tempo acabar — cada
item é entregável sozinho.

| O quê | Por quê |
|---|---|
| **Remover o custom pela aba do servidor** | Hoje só a API remove (`DELETE /api/plugins/:pluginId`). Um custom que ninguém mais usa fica na coluna de disponíveis para sempre |
| **Dependências na tela de rede** (`/plugins`) | A coluna "ativo em" já existe; falta dizer que o `OrigemZPlayer` depende do `OrigemZAgent`. Quem remove da biblioteca precisa ver isso ANTES |
| **O erro de compilação em destaque** | `reload.output` já vem na resposta e a tela o mostra num `<pre>`. Um plugin que não compila devia ser um estado visível na linha, não um texto que rolou para fora |
| **Conjuntos de plugins** | Ver [09-ROADMAP.md](09-ROADMAP.md), Fase 2: "instalar **conjunto** de plugins num servidor novo, não um a um". Um servidor novo hoje é ligar seis plugins na mão |

---

## Regras que não se negociam

1. **Rota nova entra no escopo `/api`** de `core/src/http/server.ts`. O guarda
   de autenticação está lá; rota fora dele nasce sem autenticação.
2. **Mensagem de erro em português, nascida no módulo que conhece a regra** —
   nunca reescrita na tela. Use `ApiError(code, message, status)`.
3. **Nada de `confirm()` do navegador**: `ConfirmButton` para o que apaga ou
   derruba; `toast` para o desfecho.
4. **Ausente vira travessão, nunca zero** (`panel/src/lib/format.ts`).
5. **O que a tela mostra sai do agente.** Nada de adivinhar no navegador.
6. **Migração nova é a 007.** As 005 e 006 estão **reservadas para o outro
   agente** — ver a seção seguinte. Nunca edite uma migração já aplicada: um
   banco que já a rodou não a roda de novo, e a mudança sumiria em silêncio nas
   máquinas que já estão de pé.
7. **Caminho de arquivo passa por `pluginPath()`**, sempre. Ele é a trava que
   impede um nome com `..` de escrever fora da pasta. Vale para o
   `oxide\config` também: o `<Nome>.json` precisa da mesma conferência.
8. **Teste o que quebra em silêncio.** O padrão está em
   `core/test/plugin-library.test.ts`: pasta temporária de verdade, banco em
   memória, e um RCON falso que só guarda os comandos.

---

## Não pise no outro agente

Outro agente está construindo a fase de **Administração** (a aba com Jogadores,
Chat, Admins, Comandos, e a BanList global) ao mesmo tempo que você.

**Trabalhe numa branch própria:**

```powershell
git checkout -b plugins-config
```

### Seus arquivos (mexa à vontade)

```
core/src/oxide/*
core/src/db/plugins-repository.ts
core/src/http/routes/plugins.ts
core/test/plugin-library.test.ts
panel/src/components/plugins-panel.tsx
panel/src/app/plugins/page.tsx
```

### Arquivos compartilhados (cuidado, os dois mexem)

| Arquivo | Como conviver |
|---|---|
| `core/src/db/migrations.ts` | **você é a 007+**; ele é a 005 e a 006. Acrescente no fim, nunca renumere |
| `core/src/http/server.ts` | uma linha de `registerXRoutes`. Mantenha a sua junto das outras de plugin |
| `panel/src/lib/api.ts` | acrescente os seus métodos **no fim** do objeto `agent`, num bloco com comentário |
| `panel/src/app/servidor/page.tsx` | ele acrescenta a aba *Administração*. **Você não mexe aqui** — a aba Plugins já está ligada |
| `Docs/06-API.md`, `Docs/07-PAINEL.md` | escreva só dentro da sua seção (Plugins) |

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

- gravar uma config inválida é **recusado**, e o arquivo em disco não muda;
- gravar uma config válida faz backup antes, e o backup tem o conteúdo
  **anterior**;
- apagar a config não apaga o `.cs` nem desliga o plugin;
- `enable-with-deps` liga na ordem topológica, e recusa com ciclo dizendo quem
  está nele.

Na máquina, com o `server01` (existe e está instalado):

1. reiniciar o agente e ver os seis `OrigemZ*` na coluna **Disponíveis**;
2. ligar o `OrigemZAgent` e depois o `OrigemZPlayer` — o aviso de dependência
   deve sumir quando o primeiro entrar;
3. tentar tirar o `OrigemZAgent`: a confirmação precisa dizer que
   `OrigemZPlayer`, `OrigemZQueue` e `OrigemZVip` saem junto;
4. abrir a configuração do `OrigemZVip`, mudar um valor e ver o plugin
   recarregar com ele.

Commits em português, explicando o **porquê** da mudança e o que dava errado
antes — leia o `git log` para pegar o tom. Não faça `git push` sem pedir.

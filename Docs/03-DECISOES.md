# 03 — Decisões

Cada bloco é uma escolha feita, o que ela custa, e o que faria voltar atrás.
Existe para que ninguém — inclusive nós — precise refazer a discussão daqui a
três meses olhando só o código.

---

## D1 — npm workspaces, não pnpm

**Decisão.** O repositório usa `npm` com `workspaces: ["core", "panel"]`, e o
`package-lock.json` é versionado.

**Por quê.** O fluxo de produção passou a ser `git clone` → `npm install` →
`pm2 start`. Exigir `npm i -g pnpm` antes disso é um passo a mais numa máquina
onde o objetivo é não ter passo nenhum. O `npm` vem com o Node.

**O que muda no código.** `pnpm --filter @rustagent/core build` vira
`npm run build -w core`. Os scripts da raiz ficam:

```json
"dev":       "npm run dev -w core",
"build":     "npm run build -w core && npm run build -w panel",
"start":     "npm run start -w core",
"test":      "npm run test --workspaces --if-present",
"typecheck": "npm run typecheck --workspaces --if-present",
"lint":      "npm run lint --workspaces --if-present"
```

**Custo.** `node_modules` maior (sem o store de links do pnpm) e install um
pouco mais lento. Nenhum dos dois é problema num dedicado.

---

## D2 — Sem installer, sem serviço Windows, sem auto-update

**Decisão.** Saem do projeto: `installer/` (Inno Setup), `service/` (WinSW),
`deploy/`, `dist-release/`, `launcher.mjs`, `current.json`, `releases/`,
`core/src/updates/*`, as rotas `/api/agent-update`, as credenciais de GitHub
(`GITHUB_TOKEN`, GitHub App) e os `scripts/*-release.mjs`. Também não há GitHub
Actions.

**Por quê.** Tudo isso resolve **um** problema: entregar uma versão nova numa
máquina onde ninguém tem acesso ao terminal. Não é o nosso caso — o dedicado é
nosso e tem git. O preço que se pagava era alto e permanente: um processo
intermediário (`launcher`), um estado em disco com dois donos
(`current.json`), probation, rollback, credencial de repositório privado,
empacotamento por release e testes de processo para tudo isso.

**Como se atualiza agora.**

```powershell
cd C:\RustAgent
git pull
npm install
npm run build
pm2 restart rustagent
```

**O que faria voltar atrás.** Distribuir o agente para máquinas de terceiros.
Aí o instalador volta — mas como projeto separado, consumindo este repo.

---

## D3 — Nada de `.bat`: SteamCMD e RustDedicated em TypeScript

**Decisão.** `StartServer.bat`, `UpdateServer.bat`, `Build.bat` e a pasta
`Tools\` (`LoadConfig.bat`, `InstallSteamCMD.bat`, `InstallOxide.ps1`,
`DisableQuickEdit.ps1`) **não vêm**. O core roda `steamcmd.exe` e
`RustDedicated.exe` direto, por `spawn`, e baixa o SteamCMD e o Oxide sozinho.

**Por quê.** Os `.bat` moravam fora do repositório, duplicavam regras que o
agente já tem (qual `.ini`, qual pasta, quais portas) e obrigavam a variáveis
de contorno (`RUSTAGENT_NONINTERACTIVE=1`) para não travar num `pause`
esperando um Enter que nunca vem. A divergência entre `LoadConfig.bat` e
`resolveServerPaths` do agente já produziu o sintoma clássico: o painel lendo
log de uma pasta enquanto o servidor escrevia noutra.

**O que ganha.** Uma regra só, em um lugar só. Log estruturado de verdade (o
que o painel mostra ao vivo), código de saída confiável, e o fim de citar
argumento para o `cmd.exe` — que é onde mora a injeção de comando.

**O que perde.** Não dá mais para "rodar o `.bat` na mão" quando o agente está
fora do ar. Compensação: um script `npm run server -w core -- <id> install`
para o mesmo efeito, pelo mesmo código.

---

## D4 — O `.ini` por servidor continua sendo a fonte da verdade

**Decisão.** Cada servidor é um `Configs\<id>.ini`. O banco espelha, não manda.

**Por quê.** É o que já funciona, é editável à mão e sobrevive a um banco
apagado. Mover a configuração para o SQLite seria uma refatoração grande num
recomeço que precisa ir para o ar rápido — e trocaria um arquivo que a pessoa
lê por uma tabela que ela não lê.

**O que muda.** O `.ini` não é mais lido por `cmd.exe`, então some a restrição
de ASCII puro e do `for /f`. Continuamos escrevendo CRLF e ASCII no modelo por
compatibilidade com quem já tem arquivos assim.

**O que faria voltar atrás.** Configuração por servidor crescer a ponto de
precisar de tipos (listas, objetos). Aí o `.ini` vira o quadro-de-avisos e o
banco vira a fonte.

---

## D5 — Login de operador simples na Fase 1

**Decisão.** O painel entra com **usuário + senha de operador**, guardados no
`.env` (a senha como hash scrypt), com sessão em cookie `HttpOnly` e CSRF. O
Steam OpenID, o PIN e os níveis por servidor **não** vêm agora.

**Por quê.** O login antigo é bom, mas resolve um problema que a Fase 1 não
tem: dar acesso graduado a vários admins, por servidor, com identidade Steam. A
Fase 1 tem um dono e uma máquina. Trazer `panel-auth-service.ts` (~38 KB),
`panel-auth-repository.ts` (~29 KB), `pin.ts`, `player_admins` e a tabela de
auditoria seria arrastar metade do banco antigo por causa da tela de entrar.

**O que fica preservado.** O formato da sessão (cookie + CSRF + `sid`) é o
mesmo, e as rotas `/auth/*` mantêm os nomes. Quando o login por Steam voltar
(Fase 3), ele acrescenta um jeito de provar quem você é — não muda o resto.

**Trava.** O agente **recusa subir** com `AGENT_HOST=0.0.0.0` e senha de
operador padrão. Quem alcança este painel liga e derruba servidores.

---

## D6 — Fase 1 sem plugins no repositório, mas com o instalador de plugins

**Decisão.** Os plugins `OrigemZ*` não vêm agora — serão reformulados. O que a
Fase 1 entrega é a **tela que instala plugin** em qualquer servidor.

**Por quê.** Trazer o código atual dos plugins garantiria migrar duas vezes: uma
agora, outra depois da reforma. E o agente não precisa conhecê-los para
instalá-los.

**O que isso implica no desenho.** O gerenciador de plugins é **genérico**:
recebe um `.cs` (upload pelo painel ou caminho local), grava em
`Servers\<id>\oxide\plugins\`, e pede `oxide.reload <Nome>` pelo RCON. Ele não
sabe o que o plugin faz. As rotas do core que hoje falam com plugins
específicos (loja, VIP, ads, UI) ficam para as fases seguintes.

---

## D7 — Um processo, modo fork, sempre

**Decisão.** `ecosystem.config.cjs` fixa `exec_mode: 'fork'` e `instances: 1`.
O PM2 sobe o `core/dist/index.js` **direto** (sem launcher).

**Por quê.** O agente mantém **uma** conexão WebRCON por servidor. Em cluster,
cada worker abriria a sua: o servidor receberia N cópias de cada comando e o
agente veria N cópias de cada linha de log. E o estado de operação vive em
memória — duas instâncias disputariam a trava do SteamCMD e deixariam a pasta
pela metade.

Isso **não é** para ser otimizado depois. Escalar exigiria antes: estado
externo e um dono único da conexão RCON.

---

## D8 — O servidor de jogo é destacado do agente

**Decisão.** O `RustDedicated.exe` sobe com `detached: true` e `stdio: 'ignore'`,
com o log indo para `Logs\<id>\server-<identity>.log` pelo próprio
`-logfile` do jogo.

**Por quê.** `pm2 restart rustagent` não pode derrubar quem está jogando.
Reiniciar o agente é rotina; derrubar o servidor é evento.

**Consequência.** O agente **redescobre** os servidores no boot: varre os
processos `RustDedicated.exe` da máquina e casa cada um com o servidor dele
pela linha de comando (`+server.identity`, `+rcon.port`). Não guardamos PID em
arquivo — PID reciclado apontando para outro processo é pior que não saber.

**E o sinal de "subiu" é o RCON responder**, não o processo existir: gerar um
mapa procedural leva minutos, e durante esse tempo o processo está lá sem
aceitar ninguém.

---

## D9 — Uma operação por vez, por máquina, com log incremental

**Decisão.** Trava **global** para o que toca no SteamCMD e no disco;
`POST /api/.../operations` responde **202**; o log é lido por
`GET .../operations/{id}?fromLine=N`.

**Por quê.**

- O SteamCMD é um cliente só, com um lock só. Dois `app_update` em paralelo
  deixam a pasta pela metade — e é exatamente o que aconteceria com dois
  servidores instalando ao mesmo tempo.
- Uma instalação de 6 GB não cabe em requisição HTTP nenhuma. As recusas de
  pré-condição (servidor no ar, operação em curso, RCON fora) acontecem
  **antes** do 202 e saem como 409.
- O SteamCMD imprime dezenas de milhares de linhas. Guardamos as últimas 2000 e
  contamos em `droppedLines` quantas foram descartadas — log truncado que não
  avisa que truncou é pior que log nenhum.

**O que continua sendo paralelo.** Operações que não disputam recurso — subir o
`pvp1` enquanto o `pve` está no ar — não se bloqueiam. A trava é por recurso
(`steamcmd`, `disk:<id>`), não por "qualquer coisa".

---

## D10 — Nada de comando arbitrário pela API

**Decisão.** Existe um conjunto **fixo** de operações. Não há rota que receba
uma linha de comando. Os únicos dados da requisição que chegam perto de um
`spawn` são o `serverId` (regex estrito **e** precisa existir no cadastro) e o
nome do plugin (regex estrito **e** o arquivo precisa existir).

**Por quê.** Com `OPS_ENABLED=1`, quem tem o token executa programa nesta
máquina. Um endpoint genérico transformaria o token em shell remoto. Com
`OPS_ENABLED=0` as rotas nem são registradas — respondem 404.

---

## D11 — SQLite, com migrações versionadas, desde o primeiro dia

**Decisão.** `better-sqlite3` em `data\rustagent.db`, com `migrations.ts`
numerado e `schema-version`. A Fase 1 usa poucas tabelas (`servers`,
`operations_history` se persistir, `schema_version`), mas o mecanismo entra
inteiro.

**Por quê.** As fases seguintes trazem jogadores, VIP e loja — e o custo de
enfiar migração num projeto que não nasceu com ela é conhecido. O mecanismo já
existe e é copiável quase intacto.

**O que não vem.** As ~30 migrações do banco antigo. A Fase 1 começa da
migração 001, com as tabelas que ela usa.

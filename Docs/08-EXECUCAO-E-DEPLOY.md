# 08 — Execução e deploy

## Requisitos

- **Node.js 20.11+** (o `npm` vem junto)
- **PM2**, só no dedicado: `npm i -g pm2`
- Windows (ver [02-ARQUITETURA.md](02-ARQUITETURA.md))

Não é preciso instalar SteamCMD, Oxide, nem o servidor de Rust: o agente faz
isso.

---

## Desenvolvimento, nesta máquina

```powershell
cd F:\Projects\RustAgent
npm install
copy .env.example .env      # e edite
npm run dev
```

`npm run dev` sobe o core em modo watch (`tsx watch`). O painel roda à parte,
quando você estiver mexendo nele:

```powershell
npm run dev -w panel        # http://localhost:3100
```

Os outros comandos, todos a partir da raiz:

```powershell
npm run build        # core -> core/dist   e   panel -> panel/out
npm run start        # roda o build (o que o PM2 executa)
npm test             # vitest, sem tocar em servidor real
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
```

---

## O `.env` do agente

Só o que a Fase 1 usa. Cada servidor de Rust tem a **sua** configuração no
`Configs\<id>.ini` — aqui é a configuração do **agente**.

```ini
# --- API ---------------------------------------------------
AGENT_HOST=127.0.0.1          # 0.0.0.0 expõe na rede: decisão consciente
AGENT_PORT=8787
AGENT_API_TOKEN=              # bearer das integrações (gere um)

# --- Painel ------------------------------------------------
PANEL_USER=admin
PANEL_PASSWORD_HASH=          # scrypt; gere com `npm run panel:senha -w core`
PANEL_SESSION_TTL_MS=28800000 # 8 h

# --- Operações ---------------------------------------------
OPS_ENABLED=1                 # 0 = as rotas de operação nem são registradas
SERVER_START_TIMEOUT_MS=900000

# --- Steam -------------------------------------------------
STEAM_UPDATE_CHECK_INTERVAL_MS=900000   # 15 min
STEAM_AUTO_UPDATE=1                     # 0 = só avisa, não atualiza sozinho

# --- Caminhos (padrão: dentro do repositório) ---------------
# SERVERS_DIR=F:\RustServers
# STEAMCMD_DIR=
# LOGS_DIR=
# AGENT_DB_PATH=
```

Gerando o token da API:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

O agente **não sobe** com configuração faltando ou inválida: ele imprime
exatamente qual variável está errada e sai com código 1. Um agente no ar com
metade da configuração é pior que um agente parado.

Duas recusas de segurança, no boot:

- `AGENT_HOST=0.0.0.0` com `PANEL_PASSWORD_HASH` vazio ou de exemplo;
- `AGENT_HOST=0.0.0.0` com `OPS_ENABLED=1` e sem `AGENT_API_TOKEN`.

Quem alcança esta API liga, derruba e reinstala servidores. Expor para fora
pede proxy reverso com TLS na frente e firewall restringindo a origem.

---

## Onde ficam os dados

Por padrão, tudo dentro do repositório — é o que faz "copiar a pasta" ser o
backup:

```
RustAgent\Configs\      <id>.ini
RustAgent\Servers\<id>\ a instalação do jogo
RustAgent\SteamCMD\     o cliente
RustAgent\Logs\<id>\    logs do jogo e do SteamCMD
RustAgent\Backups\<id>\ cópias do oxide\
RustAgent\data\         rustagent.db
```

`SERVERS_DIR` no `.env` move as instalações para outro disco sem mover o resto
— é o caso comum num dedicado com SSD pequeno e HD grande.

---

## Produção, no dedicado

```powershell
git clone https://github.com/Mateuus/RustAgent.git C:\RustAgent
cd C:\RustAgent
npm install
copy .env.example .env      # e edite
npm run build
pm2 start ecosystem.config.cjs
pm2 logs rustagent
pm2 save
```

`pm2 save` grava a lista para o `pm2 resurrect` do boot. Para o serviço subir
sozinho com o Windows: `pm2-startup install` (pacote `pm2-windows-startup`).

### Atualizar

```powershell
cd C:\RustAgent
git pull
npm install
npm run build
pm2 restart rustagent
```

**Isso não derruba os servidores de Rust.** Eles rodam destacados do agente
(D8); o que reinicia é quem os comanda. Os jogadores não percebem.

### O `ecosystem.config.cjs`

```js
module.exports = {
  apps: [{
    name: 'rustagent',
    script: 'core/dist/index.js',
    cwd: __dirname,
    exec_mode: 'fork',      // NÃO troque para cluster. Ver D7.
    instances: 1,
    autorestart: true,
    stop_exit_codes: [0],   // saída 0 = desligamento pedido
    watch: false,           // um arquivo tocado por engano derrubaria o RCON
    min_uptime: '20s',
    max_restarts: 10,
    restart_delay: 5000,
    shutdown_with_message: true,  // no Windows, IPC funciona; sinal não
    kill_timeout: 25000,
    time: true,
    out_file: 'logs/pm2-out.log',
    error_file: 'logs/pm2-error.log',
    merge_logs: true,
    env: { NODE_ENV: 'production' },
  }],
};
```

Duas linhas merecem explicação:

**`shutdown_with_message: true`.** No Windows, `process.kill(pid,'SIGINT')`
chama o `TerminateProcess`: o processo morre na hora e o handler de
`SIGINT`/`SIGTERM` **não roda**. Com essa opção o PM2 manda a string
`'shutdown'` pelo canal de IPC, e o agente escuta `process.on('message')` para
desligar limpo — fechar o RCON, parar os relógios, fechar o banco.

**`kill_timeout: 25000`.** O desligamento limpo do agente tem orçamento de 15 s;
o PM2 precisa esperar mais que isso, senão mata justamente quem estava
conduzindo o desligamento.

---

## Git

O repositório é `https://github.com/Mateuus/RustAgent.git`, branch `main`.

```powershell
cd F:\Projects\RustAgent
git init
git add .
git commit -m "primeiro commit"
git branch -M main
git remote add origin https://github.com/Mateuus/RustAgent.git
git push -u origin main
```

**Sem GitHub Actions**, por decisão. Os testes rodam na máquina de quem
desenvolve, antes do commit.

### O que **não** vai para o git

```
node_modules/  core/dist/  panel/out/  panel/.next/
.env  *.pem
Servers/  SteamCMD/  Logs/  Backups/  data/
Configs/*.ini
!Configs/server.example.ini
```

`Configs\*.ini` fica de fora porque tem **senha de RCON** dentro. O modelo
(`server.example.ini`) é versionado — é dele que todo servidor novo nasce.

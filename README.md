# RustAgent

Serviço sempre ligado que **controla vários servidores dedicados de Rust na
mesma máquina**. Ele instala o SteamCMD sozinho, baixa o servidor, sobe,
derruba, atualiza e instala plugins — por um botão no painel.

```
   navegador                RustAgent                       a máquina
  ┌────────────┐  HTTP     ┌────────────────────────┐  spawn      ┌──────────────┐
  │  painel    │ ────────► │  Fastify + SQLite      │ ──────────► │ steamcmd.exe │
  │  (Next.js) │ ◄──────── │  supervisor de servers │ ◄────────── │ RustDedicated│
  └────────────┘   JSON    └────────────────────────┘  WebRCON    └──────────────┘
```

Cada servidor é independente: instalar um não toca no outro, e derrubar um não
derruba os demais.

---

## Começando

```powershell
npm install
copy .env.example .env      # e edite
npm run dev
```

Produção, no dedicado:

```powershell
git clone https://github.com/Mateuus/RustAgent.git C:\RustAgent
cd C:\RustAgent
npm install
copy .env.example .env
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

Atualizar: `git pull` → `npm install` → `npm run build` → `pm2 restart rustagent`.
Isso **não** derruba os servidores de Rust — eles rodam destacados do agente.

---

## Requisitos

- Node.js 20.11+
- PM2 (só no dedicado): `npm i -g pm2`
- Windows

Não é preciso instalar SteamCMD, Oxide nem o servidor de Rust à mão. O agente
faz isso.

---

## Documentação

Tudo em [`Docs/`](Docs/README.md):

| | |
|---|---|
| [01 — Visão e escopo](Docs/01-VISAO-E-ESCOPO.md) | o que o agente faz e o que entra em cada fase |
| [02 — Arquitetura](Docs/02-ARQUITETURA.md) | pastas, camadas, fonte da verdade |
| [03 — Decisões](Docs/03-DECISOES.md) | cada escolha e o porquê |
| [04 — Plano de migração](Docs/04-PLANO-DE-MIGRACAO.md) | o que vem do projeto anterior |
| [05 — Operações](Docs/05-OPERACOES.md) | SteamCMD, Oxide, instalar, subir, atualizar |
| [06 — API](Docs/06-API.md) | as rotas e os códigos de erro |
| [07 — Painel](Docs/07-PAINEL.md) | as telas |
| [08 — Execução e deploy](Docs/08-EXECUCAO-E-DEPLOY.md) | npm, PM2, git |
| [09 — Roadmap](Docs/09-ROADMAP.md) | o que vem depois |
| [Progresso](Docs/PROGRESSO.md) | onde estamos |

---

## Comandos

```powershell
npm run dev          # core em watch
npm run dev -w panel # painel em http://localhost:3100
npm run build        # core -> core/dist  e  panel -> panel/out
npm run start        # roda o build (o que o PM2 executa)
npm test             # vitest, sem tocar em servidor real
npm run typecheck
npm run lint
```

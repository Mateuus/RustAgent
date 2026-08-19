# RustAgent — documentação do projeto

Este repositório é o **recomeço** do RustAgent. O código anterior vive em
`F:\Projects\Rust\RustAgent` e continua rodando; ele não é jogado fora — é a
**fonte de onde as peças boas são trazidas**, uma por vez, para uma árvore em
que dá para mexer sem medo.

O que este projeto é, em uma frase:

> Um serviço sempre ligado que **controla vários servidores de Rust na mesma
> máquina** — instala o SteamCMD sozinho, baixa o servidor, sobe, derruba e
> atualiza cada um deles, por um botão no painel.

---

## Por que começar de novo

O projeto antigo cresceu para dentro de uma máquina específica. Ele depende de
uma camada de `.bat` (`StartServer.bat`, `UpdateServer.bat`, `Tools\LoadConfig.bat`)
que mora **fora** do repositório, de um instalador Inno Setup, de um serviço
WinSW, de um `launcher.mjs` que troca releases em disco e de um auto-update que
fala com a API do GitHub. Cada uma dessas peças resolvia um problema real, e
juntas transformaram uma mudança de duas linhas numa investigação de meia hora.

O modelo de operação mudou, e é isso que autoriza o corte:

| Antes | Agora |
|---|---|
| instalador `.exe`, serviço Windows, releases versionadas em disco | `git pull` → `npm install` → `pm2 restart` |
| auto-update pela API do GitHub (repo privado, credencial, probation, rollback) | quem atualiza é uma pessoa, com o git |
| os `.bat` na raiz do projeto, fora do repo | tudo em TypeScript, dentro do `core` |

O que sai não é funcionalidade do produto. É **andaime de distribuição**.

---

## Os documentos

Leia nesta ordem na primeira vez:

| # | Documento | O que responde |
|---|---|---|
| 01 | [Visão e escopo](01-VISAO-E-ESCOPO.md) | o que o agente faz, o que entra na Fase 1 e o que fica para depois |
| 02 | [Arquitetura](02-ARQUITETURA.md) | as pastas, as camadas, o que é fonte da verdade de cada coisa |
| 03 | [Decisões](03-DECISOES.md) | cada escolha e o porquê dela (o registro que evita refazer a discussão) |
| 04 | [Plano de migração](04-PLANO-DE-MIGRACAO.md) | arquivo por arquivo: o que copia, o que reescreve, o que morre |
| 05 | [Operações](05-OPERACOES.md) | SteamCMD, Oxide, instalar, subir, derrubar, atualizar — o coração |
| 06 | [API](06-API.md) | as rotas da Fase 1 e as do wipe e das mensagens, com os códigos de erro |
| 07 | [Painel](07-PAINEL.md) | as telas da Fase 1 e o fluxo de "criar servidor até estar no ar" |
| 08 | [Execução e deploy](08-EXECUCAO-E-DEPLOY.md) | `npm run dev`, PM2 no dedicado, o git |
| 09 | [Roadmap](09-ROADMAP.md) | as fases seguintes, em ordem de dependência |
| — | [Progresso](PROGRESSO.md) | checklist vivo: o que já foi feito, o que está em curso |

Os documentos de **fase**, escritos quando cada frente começa (10 a 18 já foram
executadas):

| # | Documento | O que responde |
|---|---|---|
| 16 | [Plano: wipe, calendário e mensagens](16-PLANO-WIPE-CALENDARIO-MENSAGENS.md) | o agente mandando no ciclo de vida do mundo, o calendário no painel e no jogo, e o agendador de falas do servidor |
| 17 | [As frentes de wipe e mensagens](17-FRENTES-WIPE-E-MENSAGENS.md) | como vários agentes constroem o 16 ao mesmo tempo sem se atropelar |
| 18 | [Os prompts das frentes](18-PROMPTS-DAS-FRENTES.md) | os dez blocos prontos para abrir cada agente, e em que ondas eles rodam |

---

## O caminho curto

Desenvolvimento, nesta máquina:

```powershell
cd F:\Projects\RustAgent
npm install
npm run dev
```

Produção, no dedicado:

```powershell
git clone https://github.com/Mateuus/RustAgent.git
cd RustAgent
npm install
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

Não há instalador, não há serviço a registrar e não há release a empacotar. É
uma decisão, e está registrada em [03-DECISOES.md](03-DECISOES.md).

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
| 19 | [Pesquisa: ranking](19-PESQUISA-RANKING.md) | de onde vem cada número do leaderboard, e como guardá-lo |
| 20 | [Integração OzCoin: o agente e o site](20-INTEGRACAO-OZCOIN-AGENT.md) | o saldo passa a morar no site, a loja in-game cobra lá, e o que o jogador compra no site é entregue no jogo |
| 21 | [Status da integração, para o agente do site](21-STATUS-PARA-O-AGENTE-DO-SITE.md) | o que já está pronto deste lado, o que o site precisa entregar, e o que o agente manda no fio |
| 22 | [Comandos e config vindos do site](22-COMANDOS-E-CONFIG-DO-SITE.md) | as duas pontas que faltam aqui: a fila de comandos (start/stop/restart) e a config desejada — contrato, regras e critérios de aceite. **Nada disso existe ainda** |
| 23 | [Configurar pelo site: o `.ini` inteiro, a loja, os kits e o VIP](23-CONFIG-PELO-SITE.md) | a config de servidor cresceu de 7 para 23 campos, e nasceu um canal de **config de rede** (`store`, `kits`, `vips`) — contrato, regras e o que o snapshot substitui. Reconciliado no §23 dos dois manuais como `oz-rust/5` |
| 23b | [Configuração avançada pelo site: as quatro áreas aprovadas](23-CONFIG-AVANCADA-DO-SITE.md) | o pedido formal das **quatro áreas** que o dono aprovou trazer para o painel do site. A **área 1 (auto-update) foi feita** em 04/09/2026 (§3.5); as outras três — wipe, plugins/Oxide, admins/bans/mensagens — **não existem em lugar nenhum** |
| 24 | [VIP de Rust: o pedido ao agente do site](24-PROMPT-VIP-DE-RUST-PARA-O-AGENTE-DO-SITE.md) | o que falta do lado do site para o VIP de Rust ser vendável: o reconciliador, as duas rotas do espelho (`/vip/mirror`) e a régua do `tier` |
| 25 | [VIP de Rust: a resposta do agente do site](25-RESPOSTA-VIP-DE-RUST-DO-AGENTE-DO-SITE.md) | o que eles construíram, o que decidiram e o que devolveram como pergunta |
| 26 | [Tiers no espelho e `vip_revoke` na fila: o pedido deles](26-PEDIDO-TIERS-E-REVOKE.md) | os dois buracos que sobraram, com arquivo e linha DESTE repositório — e três perguntas de semântica cuja resposta vira contrato |
| 27 | [A resposta: os dois pedidos estão de pé](27-RESPOSTA-TIERS-E-REVOKE.md) | `tiers[]` viaja dentro do hash do espelho e `vip_revoke` fecha o ciclo da revogação; as três perguntas respondidas, e o oitavo alarme do §18.4 desarmado |
| 28 | [Confirmado: os dois lados fecharam](28-CONFIRMACAO-TIERS-E-REVOKE.md) | o site mediu o `tiers[]` chegando preenchido e a revogação fechando com `delivered` sem `reason` |
| 29 | [O catálogo de itens: a resposta do site](29-RESPOSTA-CATALOGO-DE-ITENS.md) | as rotas 19/20/21 existem, e o contrato mudou em quatro pontos — o alfabeto do shortname tem ESPAÇO, e a `version` não cobre as imagens |
| 30 | [O espelho de itens no ar deste lado](30-RESPOSTA-CATALOGO-DE-ITENS-IMPLEMENTADO.md) | o que subiu aqui, as quatro correções honradas, e o alias dos seis carros modulares |
| 28 | [Confirmado: os dois lados fecharam](28-CONFIRMACAO-TIERS-E-REVOKE.md) | as duas confirmações que faltavam para `tiers[]` e `vip_revoke` entrarem em produção |
| 29 | [O catálogo de itens: a resposta](29-RESPOSTA-CATALOGO-DE-ITENS.md) | as rotas **19/20/21** do espelho de itens estão de pé no site (`oz-rust/7`), e as **quatro correções** que o pedido original precisava: o alfabeto do shortname inclui **espaço**, a `version` não cobre as imagens, `missingImages` não pode listar o que o site recusa, e o espelho é snapshot. Traz também os 6 ícones de carro modular que hoje quebram o painel **deste** repositório |

E fora da pasta `Docs`:

| Onde | O que responde |
|---|---|
| [`contracts/`](../contracts/README.md) | as **fixtures compartilhadas** do canal agent↔site: os corpos de requisição e resposta, com `origin` dizendo quais foram **medidos** contra o dev e quais são só o que o manual descreve. Lido pelos testes deste repositório (`core/test/site-fixtures.test.ts`) |

> **O número 23 está ocupado por dois arquivos.** `23-CONFIG-PELO-SITE.md` descreve o que **já foi
> construído** deste lado; `23-CONFIG-AVANCADA-DO-SITE.md` descreve o que **ainda não existe em
> lugar nenhum**. São documentos diferentes, e nenhum é rascunho do outro. Renomear o segundo para
> `24-` é uma linha de `git mv` — ninguém decidiu ainda, e até lá ele é o **23b**.

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

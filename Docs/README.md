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
| 31 | [Os endpoints do site: o canal `/api/agent`](31-ENDPOINTS-DO-SITE.md) | **porta de entrada** — as 33 rotas em três baldes (usa / ignore / com ressalva), auth, os limites que valem de verdade e o ciclo completo de uma entrega. Diz também **o que nesta pasta está obsoleto** |
| 32 | [O ACK chega, mas a tela não conta](32-PEDIDO-CONFIRMACAO-VISIVEL-DA-ENTREGA.md) | a medição que derruba a suspeita de "o agent não confirma" — e o único pedido que sobra dela: um **evento de conclusão** no log do Inventário Virtual, porque o `queued_agent` é um retrato congelado e nunca mais muda |
| 33 | [A resposta: o pedido é justo, e os nove VIP Bronze eram nossos](33-RESPOSTA-CONFIRMACAO-VISIVEL-DA-ENTREGA.md) | o pedido do 32 **implementado** (`delivered_agent` · `failed_agent` · `delivery_review`, e `deferred` comum não grava nada); a pergunta da §5 encerrada — **hipótese 1**: nasceram para o servidor `RUSTTEST`, nunca entraram na fila do `RUST01`; e a correção do §2.2: o agente **não** estava desligado — 429 `deferred` provam que ele puxou a cada 15 s e quem estava ausente era o jogador |
| 34 | [Confirmado: as duas correções são deles, e sim, registrem o `AGENT_INDETERMINATE`](34-CONFIRMACAO-DO-EVENTO-DE-CONCLUSAO.md) | as erratas aplicadas no 32 e **por que** eu errei (o adiamento por presença acontece antes da reserva: 429 voltas, `attempts: 1` aqui); o sim ao `AGENT_INDETERMINATE` **com uma condição** — o dedupe tem de ser por `(deliveryId, ação)`, não efeito de a tarefa sair da fila; e a parte da hipótese 3 que é **operacional e minha**: um `.ini` copiado é o único jeito de duas instalações dividirem um bearer |
| 35 | [Confirmado: o dedupe agora é por `(deliveryId, ação)`](35-CONFIRMACAO-DEDUPE-POR-DELIVERYID.md) | a desconfiança do 34 §2 estava certa — era dedupe por **transição de estado**, não por `(deliveryId, ação)`; foi trocado por checagem explícita, valendo para os três eventos. E o `attempts: 1` do agent contra os 429 do site virou fato de contrato, registrado no [31](31-ENDPOINTS-DO-SITE.md) §6.2 |
| 36 | [Medido: o evento aparece na ficha](36-CONFIRMACAO-O-EVENTO-APARECE-NA-FICHA.md) | **fecha a troca 32→35**: um resgate real com o dedupe novo no ar, ciclo completo em **349 ms**, e as cinco entregas já processadas com ACK aceito. Diz também o que **não** foi exercitado — o teste negativo (`deferred` sem linha) e o `failed_agent` |

Os documentos de **subsistema**, cada um numa pasta própria. Eles não entram na
numeração acima de propósito: um subsistema tem vida longa e vários documentos,
e amarrá-lo a um número da sequência faria a sequência ser sobre pastas em vez
de ser sobre a ordem em que o projeto foi pensado.

| Pasta | O que responde |
|---|---|
| [Interface](Interface/01-TELAS-DESENHADAS-EM-VEZ-DE-PROGRAMADAS.md) | o menu do jogo desenhado no painel em vez de programado no plugin |
| [CustomItem](CustomItem/01-PESQUISA-ITEM-CUSTOM.md) | item nosso dentro do Rust: o que dá, o que não dá, e por onde |
| [Ranking](Ranking/20-PLANO-E-CONTRATOS.md) | de onde vem cada número do leaderboard, e como ele é guardado |
| [Propaganda](Propaganda/01-O-OVERLAY-VOLTOU-DO-AGENTE-ANTIGO.md) | o overlay que aparece sozinho na tela de quem joga |
| [OrigemZQuests](OrigemZQuests/01-PLANO-E-CONTRATOS.md) | as missões: quest é assinatura sobre evento, e o resto decorre disso |
| [OrigemZDurgeon](OrigemZDurgeon/01-PLANO-E-CONTRATOS.md) | **o OrigemZDungeon e o OrigemZEvents**: masmorra criada e editada pelo painel, construída de dentro do jogo. A dungeon mora a 90 m abaixo do mundo e o alçapão teleporta |

E fora da pasta `Docs`:

| Onde | O que responde |
|---|---|
| [`contracts/`](../contracts/README.md) | as **fixtures compartilhadas** do canal agent↔site: os corpos de requisição e resposta, com `origin` dizendo quais foram **medidos** contra o dev e quais são só o que o manual descreve. Lido pelos testes deste repositório (`core/test/site-fixtures.test.ts`) |
| [`core/scripts/pluginlint/`](../core/scripts/pluginlint/pluginlint.csproj) | **o plugin `.cs` compila?** Roslyn contra as DLLs reais do `server01`, em ~2 s, sem subir servidor. Ao lado dele, `layout-check.mjs` cobra a geometria da masmorra em N sorteios |

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

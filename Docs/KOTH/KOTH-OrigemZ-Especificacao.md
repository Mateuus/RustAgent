# KOTH OrigemZ — Especificação funcional e técnica

Versão: 1.0 • Data: 14/09/2026 • Plataforma: Rust • Documento para implementação e homologação.

## 1. Objetivo e autoridade das regras

Implementar um evento automático de domínio de território com base no modelo de DayZ fornecido pela equipe OrigemZ: escolher uma região, anunciar, permitir chegada física dos jogadores, capturar e defender, contestar com adversários, concluir a captura, entregar recompensas e encerrar com cooldown.

Este documento especifica o comportamento esperado. Não comprova que o plugin já existe ou funciona. A entrega só será considerada funcional após implementação, integração real e aprovação dos testes da seção 24.

Ordem de prioridade:

1. Modelo de DayZ e requisitos expressos do OrigemZ reproduzidos neste documento.
2. Regras operacionais propostas aqui para eliminar ambiguidades.
3. Recursos de referências de Rust, utilizados como inspiração de personalização.

Os números do preset são sugestões iniciais de teste, não valores de economia ou balanceamento aprovados. Identificadores de APIs, permissões, arquivos e eventos propostos devem ser adaptados ao projeto existente. Não inventar APIs do agente, da loja, dos VIPs, de kits, do BetterLoot ou do ranking.

Não foi disponibilizado um manual formal de normas internas nem o código do backend nesta tarefa. O padrão adotado é o conhecido nesta conversa e no material local: administração web, interface em português, catálogos selecionáveis, configurações por servidor, integrações da economia existente, permissões, auditoria e identidade OrigemZ. Validar convenções adicionais no repositório real antes de programar.

## 2. Escopo obrigatório

- Evento no mundo aberto; jogadores chegam por meios normais e usam seu inventário.
- Captura por presença e defesa, individual ou por equipe/clã conforme perfil.
- Agendamento automático e acionamento administrativo.
- Diversas localizações, perfis de dificuldade e conjuntos de recompensas.
- Contestação, abandono, decaimento de progresso, limite de duração e cooldown.
- NPCs opcionais, estruturas opcionais, objetos e caixas posicionáveis.
- HUD, mapa, chat, histórico e administração pelo painel web.
- Recompensas em OZCoins, Troféus BleikStore, kits, VIPs, itens e veículos compatíveis.
- Recuperação após falha, entrega auditável e prevenção de duplicidade.
- Integração com missões e métricas de ranking explicitamente selecionadas.

Não fazem parte da primeira implementação: arena com teleporte e inventário temporário, Deathmatch por abates, restauração geral de inventário, modo Battle Royale ou cópia do código de produtos comerciais. São experiências distintas da base solicitada. Pontos móveis podem ser uma extensão posterior, sem atrasar a entrega principal.

## 3. Conceitos e dados principais

| Conceito | Finalidade |
|---|---|
| Perfil | Regras, dificuldade, duração, NPCs e recompensas reutilizáveis |
| Localização | Região cadastrada para receber o evento |
| Instância | Uma execução específica, identificada por ID único |
| Zona externa | Participação, HUD e regras locais |
| Zona de captura | Volume onde a presença conta para domínio |
| Participante | SteamID registrado com contribuição individual |
| Lado | Jogador solo ou grupo concorrendo à captura |
| Controlador | Lado que detém o progresso atual |
| Beneficiário | Participante elegível para receber recompensa |
| Entrega | Registro individual de prêmio e estado do processamento |

Toda instância guarda servidor, identidade do wipe/mapa, localização, versão do perfil, versão dos conjuntos sorteados, datas, seed de sorteio, participantes, grupo registrado, progresso, resultado e entidades criadas.

Modificar um perfil não altera silenciosamente eventos em andamento: a execução usa uma cópia congelada da configuração. Ajustes emergenciais são operações explícitas, com auditoria.

## 4. Ciclo completo

```text
AGUARDANDO → PREPARANDO → ANUNCIADO → ATIVO → CONQUISTADO
                                               ↓
                              RESOLVENDO_RECOMPENSAS → EXTRAÇÃO → ENCERRADO

PREPARANDO/ANUNCIADO/ATIVO → CANCELADO ou EXPIRADO → LIMPEZA → ENCERRADO
Qualquer fase recuperável → SUSPENSO_POR_FALHA → recuperação ou cancelamento seguro
```

### 4.1 Preparação

Reservar uma vaga no limite de simultaneidade e a localização de forma atômica. Validar terreno, colisões, distâncias, integrações, prêmio, limites de grupos e plano de criação das entidades. Criar estrutura e NPCs em lotes. Só anunciar um evento pronto e acessível.

Falha parcial de preparação: remover apenas entidades já criadas por essa instância, liberar reserva, registrar erro e aplicar cooldown curto de falha para não repetir tentativas continuamente.

### 4.2 Anunciado

Mostrar região e horário de início, sem pontuar antes da hora. Regras contra construção já valem na área reservada. Por padrão NPCs só começam a conceder loot no estado ATIVO; evitar recompensas durante preparação.

Revalidar população mínima e condições de funcionamento na transição para ATIVO. Se insuficientes, adiar até um limite configurado ou cancelar com mensagem clara.

### 4.3 Ativo

Captura permitida. Controles territoriais e temporizadores são calculados pelo servidor do jogo. Painel e clientes apenas exibem informações e enviam ações autorizadas.

### 4.4 Conquista

Ao atingir a meta, congelar resultado e lista de beneficiários uma única vez. Gerar as entregas persistentes antes de chamar os sistemas de economia. A partir disso, sair da zona não transfere a vitória a outro grupo.

### 4.5 Extração e encerramento

Reservar prazo configurável para coleta física, aviso e saída da estrutura temporária. Entregas digitais pendentes continuam no registro mesmo após o encerramento territorial. Só remover estruturas depois da evacuação segura. A localização permanece indisponível durante extração e limpeza; o cooldown começa após limpeza bem-sucedida.

### 4.6 Expiração e cancelamento

No modo padrão, atingir o limite total sem concluir a captura resulta em EXPIRADO, sem vencedor nem prêmio de vitória. Pontuação parcial não produz uma vitória silenciosa. Cancelamento administrativo exige motivo; não entrega prêmio por padrão.

Não implementar botão casual de “forçar vencedor” na primeira versão. Correções excepcionais de recompensa usam processo administrativo separado, com permissão e auditoria.

## 5. Automação e agenda

Configurar por servidor:

- Ativado/desativado; início manual continua sujeito a permissão.
- Horários fixos ou intervalo após encerramento, escolhidos como políticas distintas.
- Fuso IANA; sugestão para OrigemZ: America/Sao_Paulo.
- Dias da semana, janelas permitidas, blackout de manutenção/wipe.
- Intervalo mínimo global e por perfil.
- Quantidade mínima de jogadores humanos conectados; excluir NPCs e sleepers. Excluir admins em serviço por padrão.
- Limite de instâncias simultâneas; padrão sugerido: 1.
- Cooldown por localização e distância mínima entre eventos simultâneos.
- Peso de sorteio por perfil/localização e opção de não repetir a última localização elegível.
- Tempo de anúncio, tolerância de atraso e número máximo de adiamentos.
- Regra de conflito com masmorras e outros eventos, se o sistema integrado informar suas áreas.

Se não houver local válido, registrar “sem localização disponível” e próxima tentativa; não forçar spawn inseguro. Cooldown da única localização disponível não pode ser ignorado para cumprir a agenda.

Após reinício, horários perdidos são pulados por padrão. Não disparar vários eventos atrasados juntos. Cada ocorrência agendada tem uma chave única, evitando duplicação por reconexão do agente ou clique repetido.

Queda da população depois do início não cancela instantaneamente: aplicar período de tolerância e política configurada. População online mínima e número mínimo de lados participantes são campos diferentes.

## 6. Localizações, geometria e mapa

### 6.1 Cadastro

Cada local deve ter nome legível, ID, servidor, identidade do mapa, centro X/Y/Z, rotação, zona externa, zona de captura, perfil permitido, peso, cooldown, pontos de NPCs/caixas/veículos e posição de evacuação segura.

Permitir pontos manuais, referências de monumentos suportados e seleção aleatória dentro de regiões aprovadas. Sorteio usa posições validadas, não coordenadas arbitrárias sobre todo o mapa.

### 6.2 Volume de captura

Suportar cilindro com raio e altura mínima/máxima e caixa orientada com largura, comprimento, altura e rotação. O editor deve mostrar os dois volumes e sua altura. O ponto de referência do jogador para teste de presença deve ser consistente e documentado.

Captura deve ficar contida na zona externa. Estar em túnel, teto distante, aeronave, subterrâneo ou fora dos limites verticais não conta. Identificar entrada/saída com pequena tolerância espacial configurável para evitar oscilação na borda; nunca conceder tempo fora do volume válido além dessa tolerância técnica.

### 6.3 Validação de segurança do local

Verificar água/profundidade, inclinação, colisão com construção de jogadores, TC, spawn de jogadores, safe zones, estradas/ferrovias e monumentos protegidos conforme perfil. Monumentos existentes são permitidos quando explicitamente cadastrados e compatíveis.

Revalidar antes de cada execução: um local livre ontem pode ter uma base hoje. Não destruir uma base para abrir espaço. Pular a localização e registrar o motivo.

### 6.4 Wipe

Guardar seed, tamanho e identidade do save/mapa. Em mapa alterado, desabilitar localizações absolutas até validação. Referências relativas a monumentos devem ser resolvidas e conferidas novamente. Não carregar pontuação territorial de um wipe anterior.

## 7. Estruturas e objetos

Permitir evento sem construção, em monumento existente ou com planta importada em formato já suportado pelo OrigemZ, incluindo CopyPaste se disponível.

O editor deve permitir selecionar planta, visualizar rotação/altura, posicionar captura, NPCs, caixas, decoração e recompensa de veículo. Pontos relativos à planta acompanham translação e rotação no spawn.

Objetos devem ter catálogo com nome e busca; prefab técnico pode aparecer nos detalhes, sem exigir sua digitação. Validar prefab antes de salvar e antes de spawnar.

Opções por estrutura: indestrutível ou destrutível; reparo permitido; loot inicial separado de prêmio final; portas abertas, trancadas ou controladas pelo evento. Não tornar raid obrigatório por padrão. Se houver porta, sempre garantir um caminho legítimo até o ponto de captura.

Registrar cada entidade criada. Limpeza atua nos IDs/propriedade da instância, jamais em todos os objetos semelhantes do servidor. Preservar monumentos, bases, corpos e veículos de jogadores. Se a destruição gerar entidades-filhas, rastreá-las ou aplicar a política apropriada sem recolher loot legítimo do jogador.

## 8. Participação e equipes

### 8.1 Modalidades

- Individual: cada SteamID representa um lado.
- Equipe nativa: membros do time do Rust representam um lado.
- Clã: agrupamento fornecido por integração selecionada e validada.

Escolher uma fonte por perfil. Não misturar automaticamente clã, aliados e equipe nativa. Sem integração de clã disponível, bloquear perfil que exige clã; não mudar para individual sem aviso.

No modo de equipes, permitir ou não solos. Padrão proposto: solo é um lado de um membro. Limite do grupo deve acompanhar a regra real do servidor, ainda a configurar.

### 8.2 Registro e alterações

Registrar cada lado quando seu primeiro membro elegível entrar. Congelar a lista de membros então reconhecida; esses integrantes podem chegar depois. Novos convites durante a instância não dão acesso à pontuação/recompensa dessa equipe. Um SteamID não pode mudar de lado no mesmo evento.

Se um integrante sair/trocar de grupo, suspender sua elegibilidade nessa instância e avisá-lo. Não tratá-lo como adversário novo para permitir farm contra ex-colegas. Se o grupo for dissolvido, bloquear novas contribuições do lado e aplicar abandono; manter histórico. Resultado já conquistado permanece congelado.

### 8.3 Quem conta

Conta somente jogador conectado, vivo, não ferido, não dormindo, dentro do volume correto, sem spectate/noclip/godmode e autorizado pelas regras do perfil. Admin em serviço não captura nem contesta. Desconexão e morte retiram a presença imediatamente.

Padrão: jogador montado ou em veículo não captura. Não usar raridade de equipamento, VIP ou gasto como condição de captura. Detectar inatividade por combinação de sinais, sem exigir movimento contínuo de quem está defendendo parado. Qualquer regra AFK deve ser explícita e não punir cobertura legítima.

## 9. Captura: algoritmo obrigatório

### 9.1 Parâmetros

| Campo | Significado |
|---|---|
| Tempo de conquista | Domínio necessário para vencer |
| Intervalo de avaliação | Frequência de atualização do estado |
| Mínimo de membros | Presença exigida para iniciar/manter captura |
| Regra de disputa | Exclusividade ou maioria estrita |
| Tolerância de abandono | Espera antes de reduzir progresso |
| Decaimento por segundo | Quantidade de progresso removida durante abandono |
| Regra contestada | Pausar; ou reduzir progresso, se configurado |
| Regra de retomada | Neutralizar antes de capturar ou resetar na transferência |
| Bloqueio por NPC | Nenhum, limpar guardas iniciais ou condição por onda |

### 9.2 Padrão: exclusividade e progresso do controlador

Há um único controlador e um único progresso territorial por instância. Este progresso não é uma carteira cumulativa que cada time leva consigo. Tempo histórico individual/de grupo é registrado à parte para estatísticas.

1. Zona sem presença elegível: NEUTRA ou ABANDONADA, conforme exista progresso.
2. Um único lado com presença mínima e guardas liberados: pode capturar.
3. Dois ou mais lados elegíveis: CONTESTADA. Uma pessoa inimiga já contesta, mesmo que não tenha o mínimo de membros para iniciar captura.
4. CONTESTADA pausa o progresso por padrão. O relógio máximo do evento continua correndo.
5. Sem controlador anterior/progresso: atribuir lado elegível e iniciar em zero.
6. Controlador presente e sem inimigos: adicionar tempo real transcorrido válido.
7. Controlador ausente: após tolerância, reduzir progresso mesmo se os adversários estiverem brigando entre si. A tolerância não reinicia a cada tick nem por entrada de terceiros.
8. Inimigo sozinho diante de progresso remanescente: neutralizar esse progresso primeiro. Não receber o tempo conquistado pelo antigo grupo.
9. Ao chegar a zero, limpar o controlador anterior e permitir nova captura no próximo ciclo.
10. Ao alcançar a meta, congelar conquista e avançar de estado uma vez.

Na opção “resetar na transferência”, inimigo exclusivo zera o progresso anterior e inicia em zero, sem receber prêmio imediato. Mostrar a regra na descrição do perfil.

Se o antigo grupo retornar durante a tolerância sem oposição, retoma seu progresso. Se retornar depois do decaimento, retoma o restante. Se outra equipe já assumiu, precisa disputar e neutralizar como qualquer adversário.

### 9.3 Modo opcional de maioria

Maioria estrita significa possuir mais jogadores válidos que todos os adversários somados, respeitando mínimo de membros e margem configurável. Empate contesta. Maioria não aumenta a velocidade: dez membros não capturam dez vezes mais rápido. Aplicar mesma regra de neutralização na troca de controlador.

Esse modo é opcional e desativado no preset inicial, pois favorece grupos maiores. Exibir “captura por maioria” no HUD e nas regras quando habilitado.

### 9.4 Tempo e desempenho

Usar tempo monotônico transcorrido, não incremento fixo por frame. Avaliação sugerida: uma vez por segundo. Intervalo anormalmente grande por travamento deve suspender pontuação e revalidar presença; não conceder minutos de captura por uma única atualização atrasada. Persistir checkpoints com limite de perda documentado.

### 9.5 Exemplo verificável

Meta 300 s; tolerância 10 s; decaimento 1 s/s. A controla 120 s. B entra: fica contestado em 120 s. A sai: em 10 s nada decai; nos 120 s seguintes B neutraliza até zero. No próximo ciclo B começa sua própria captura. B precisa completar 300 s de domínio válido para vencer.

Se A retornar após 30 s de ausência e B tiver saído, o progresso esperado de A é aproximadamente 100 s, respeitada a resolução de avaliação. Não deve reaparecer com 120 s nem receber o tempo de B.

## 10. Duração, ausência de disputa e expiração

Separar duração do anúncio, duração máxima ativa, tempo de conquista, tolerância, extração e cooldown. Não apresentar tudo como “tempo do evento”.

Configurar mínimo de lados distintos que precisam participar para liberar prêmio principal. Padrão proposto: 1, permitindo conquistar um evento PvE sem oposição; para eventos competitivos de BleikStore, administração pode exigir 2 ou mais. A presença deve ter duração mínima e contribuição válida; mera entrada de uma conta por um segundo não satisfaz disputa.

Se não cumprir requisito competitivo, sinalizar bloqueio antes da conquista. Perfil pode cancelar ao expirar ou permitir captura sem prêmio especial, com essa regra exibida desde o início. Não retirar silenciosamente prêmio prometido.

Padrão de expiração: sem vencedor. Uma extensão “maior domínio histórico ao término” somente se explicitamente habilitada, rotulada e testada, com mínimo de domínio e desempate definido; desativada na primeira entrega para preservar a base de concluir captura.

## 11. PvP, morte e restrições

PvP segue as regras normais do servidor. Se houver plugin PvE, a exceção territorial deve ser integrada explicitamente, nunca aplicada globalmente. Registrar comportamento de disparos de fora para dentro e de dentro para fora; padrão de mundo aberto PvP permite ambos conforme regras normais.

Morte deixa inventário/corpo segundo o Rust e plugins existentes. Retorno é físico por respawn normal, sem kit gratuito nem teleporte KOTH. Sair da zona não apaga corpo, equipamento ou elimina o jogador.

Campos por perfil:

- Construção, TC, sacos/camas, torres, armadilhas, barricadas, escadas e reparo.
- Veículos podem circular ou são bloqueados em pontos de acesso válidos; não destruí-los automaticamente.
- Itens proibidos por catálogo, com ação de uso bloqueada e mensagem. Não confiscar silenciosamente.
- Teleportes, kits, loja e comandos de remoção durante participação/combate.
- Explosivos e dano à estrutura do evento.

Bloqueios precisam alcançar as APIs e botões dos plugins, não só strings de chat. Definir cooldown de saída para impedir escapar da borda e teleportar instantaneamente quando combat block estiver ativo. Se uma integração não expõe bloqueio seguro, registrar limitação e desabilitar combinação incompatível.

Proteções de construção começam na preparação e terminam após limpeza. Estruturas anteriores de jogadores fazem o local ser descartado, não removido. Itens permitidos durante evento devem ter política de persistência clara; não apagar barricada paga pelo jogador sem aviso prévio.

## 12. NPCs e dificuldade

Catálogo de NPCs compatíveis, perfis reutilizáveis e posicionamento individual/por grupos. Configurar quantidade, vida, equipamento, munição, dano, precisão conforme integração, distância de visão, perseguição, patrulha, retorno à área, loot e limites de spawn.

Validar navegação e acessibilidade antes do evento. Se NPC essencial ficar preso/inacessível, repetir spawn em ponto válido com limite de tentativas; se não resolver, suspender/cancelar sem dar vitória gratuita.

Modos:

- Sem NPC: captura PvP pura.
- Guardas iniciais: captura bloqueada até eliminar os guardas marcados como obrigatórios.
- Ondas: reforços por tempo ou marco de progresso, cada onda com ID e execução única.

Definir se ondas bloqueiam captura; por padrão não bloqueiam após a limpeza inicial. Não gerar ondas infinitas de NPCs com loot valioso. Limitar número total, respawns e recompensas por instância. NPC nunca representa um lado de jogador nem conta para população online.

Separar loot dos NPCs do prêmio final e contabilizar ambos no orçamento do evento. Se guardas concederem Troféus BleikStore, registrar origem e limites; desativado inicialmente.

## 13. Recompensas: conjuntos, sorteio e editor

### 13.1 Estrutura

Cada perfil referencia um ou mais conjuntos versionados. Um conjunto contém entradas garantidas, grupos de sorteio e regras de distribuição. Permitir criar, copiar, editar, excluir vínculo, ativar/desativar e visualizar.

Cada entrada informa tipo, catálogo de destino, quantidade ou faixa, chance/peso, modalidade de entrega, destinatários, validade e comportamento em falha. Não deixar campos livres para métricas inexistentes.

### 13.2 Sorteio sem ambiguidade

- Garantido: 100%, separado de grupos ponderados.
- Chance independente: sorteio individual, 0–100% real, claramente rotulado.
- Grupo ponderado: selecionar N opções com pesos positivos; definir reposição/repetição.
- Quantidade: inteiro mínimo/máximo, sorteado após selecionar a entrada.
- Determinar se a seleção ocorre por evento ou por beneficiário; padrão por evento.

Congelar resultado sorteado antes de entregar. Retentar uma entrega não sorteia outro prêmio. Editor deve mostrar mínimo/máximo de emissão e probabilidade quando matematicamente calculável; simulações precisam ser rotuladas como estimativas, não promessa.

### 13.3 Catálogo obrigatório

| Tipo | Configuração e integração |
|---|---|
| OZCoins | Quantidade, destinatário e ledger existente da economia |
| Troféus BleikStore | Catálogo oficial do troféu, quantidade, ranking e temporada |
| Kit | Seleção de kit real; escolher entrega imediata ou direito de resgate |
| VIP | Plano real, duração, ativação e política para VIP já existente |
| Item Rust | Shortname/ID válido, quantidade, skin opcional, condição, componentes compatíveis |
| Veículo | Prefab válido, quantidade, ponto de spawn, combustível e política de propriedade |
| Pontos de ranking | Ranking explicitamente selecionado e habilitado para crédito externo |
| Outras integrações | Adaptadores cadastrados e testados; sem tipo fictício “qualquer coisa” |

### 13.4 OZCoins

Usar a economia central já existente, com identificação do servidor/conta conforme sua arquitetura. Não criar saldo paralelo KOTH. Registrar origem, beneficiário, valor, instância e ID da transação. Crédito e mensagem de sucesso só após confirmação do serviço.

### 13.5 Troféus BleikStore

“Troféus BleikStore” é o nome deste documento para a recompensa integrada ao ranking Bleik, anteriormente chamada BleikCoin. Confirmar ID/skin real no catálogo do projeto; nome visível não identifica um item com segurança.

Suportar duas modalidades explícitas:

1. Crédito direto: adicionar pontuação ao ranking Bleik pela API autorizada, sem criar item físico.
2. Item físico: criar o troféu reconhecido pelo conversor existente; somente a coleta que esse sistema reconhece adiciona pontuação e consome o item.

Uma mesma entrada nunca cria troféu e credita pontos diretamente ao mesmo tempo. Separar contador de emissão, coleta e crédito. Não substituir ranking Bleik por Metal, Abates ou uma chave inventada como quest.completed.

Vincular crédito direto à temporada resolvida no instante da conquista. Para prêmio físico, a política recomendada é validar temporada ao coletar e expirar troféus do evento após fechamento, evitando transferência de pontuação entre temporadas. Isso exige suporte de origem/identidade no conversor; se não existir, bloquear essa modalidade competitiva até implementar ou escolher crédito direto. Não alegar que um item genérico resolve auditoria por unidade.

Transferência física antes de coletar pode concentrar pontos em uma conta; mostrar esse efeito no editor. Para prêmio de equipe com pontuação individual, preferir dividir crédito direto entre elegíveis.

Premiação externa em skins de Rust continua sob o sistema próprio da temporada. Vitória KOTH não executa trade Steam nem entrega skin comercializável automaticamente.

### 13.6 Kits e VIPs

Separar kit de item e VIP de kit. Para VIP existente: prolongar, substituir ou manter o benefício mais alto conforme catálogo e política visível. Evitar rebaixamento automático. Toda duração deve ter unidade. Registrar início/fim e não ativar privilégio de captura mais rápida para VIP.

Kit que enche inventário precisa de resgate posterior, sem duplicar itens já entregues. Não presumir que o comando de kit respeita cooldown; configurar e testar no adaptador.

### 13.7 Itens, caixas e BetterLoot

Caixas do evento suportam: loot do servidor; acrescentar itens personalizados; substituir integralmente. Exibir itens e perfis carregados e permitir editar vínculos e itens individuais, incluindo remover. Se a caixa estiver no modo do jogo, permitir adoção pelo evento quando suportado; nunca mostrar controles que não aplicam.

Alterações valem somente para entidades da instância, não para todas as crate_elite/crate_normal do servidor. Definir ordem entre preenchimento nativo, BetterLoot e loot KOTH; impedir que refresh do BetterLoot sobrescreva prêmio final ou duplique Troféus. Quando não houver hook/API confiável, impedir modo conflitante e mostrar motivo.

Prêmio físico só nasce/desbloqueia após resultado persistido. Guardar estado de coleta e impedir regeneração de caixa saqueada por reload.

### 13.8 Veículos

Antes de anunciar perfil com veículo, validar espaço de spawn, terreno, água para barcos e acesso. Na vitória, conferir novamente. Se obstruído, deixar direito pendente em vez de esmagar jogadores ou criar veículo dentro da base.

Escolher destinatário explícito: um por grupo, por elegível ou resgate por representante. Limitar total. Veículo permanente entregue é retirado da lista de limpeza. Veículo temporário deve ter duração comunicada. Não prometer sistema de chave/propriedade que o plugin instalado não oferece.

## 14. Beneficiários, divisão e coleta

Congelar elegibilidade na conquista. Opções: controlador individual; membros elegíveis do lado vencedor; representante designado; recompensa coletiva em caixa. Mostrar quais opções são compatíveis com cada prêmio.

Participação mínima usa tempo individual válido na zona de captura e, opcionalmente, atividade de combate na zona externa. Não conceder ao clã inteiro só por constar na lista. Configurar presença exigida na conquista ou tolerância curta para quem morreu/desconectou após contribuir. Padrão: conectado e participante recente, com janela editável; jogadores suspensos/banidos são excluídos.

Distribuição:

- Por pessoa: todos recebem o valor completo; editor mostra emissão máxima pelo limite do grupo.
- Total dividido: dividir inteiro entre elegíveis. Resto distribuído por contribuição e SteamID como desempate determinístico.
- Coletivo: uma caixa ou veículo, sem multiplicação pelo grupo.

Exemplo: 10 troféus para 3 elegíveis = 4/3/3, nunca 10 para cada um sem selecionar explicitamente “por pessoa”. Contribuição define a sobra; não transforma abates no objetivo principal.

Caixa pode ser exclusiva dos vencedores durante uma janela ou pública desde o spawn. Depois da janela, configurar tornar pública, manter restrita ou recolher saldo para resgate. Nunca recolher para o vencedor loot já retirado por outra pessoa. Informar risco de roubo antes do evento.

## 15. Entrega confiável e recuperação

Estados por recompensa: PLANEJADA, PENDENTE, PROCESSANDO, ENTREGUE, FALHOU, RESULTADO_INCERTO, EXPIRADA. Chave única: instância + entrada + beneficiário + parcela. Para caixa/veículo, usar entidade e parcela coletiva.

Persistir plano antes de executar. Adaptadores de moeda/VIP devem aceitar chave idempotente ou permitir consulta por ID de transação. Timeout não significa que nada foi creditado. Consultar estado antes de retentar.

Se serviço externo não oferece idempotência nem consulta, marcar RESULTADO_INCERTO e exigir reconciliação autorizada; não retentar automaticamente um comando que pode ter executado. Não prometer entrega exatamente uma vez com integração incapaz de garanti-la.

Inventário cheio: fila de resgate segura ou entrega parcial rastreada, conforme perfil. Não jogar automaticamente prêmio valioso no chão. Sem conexão: manter pendente e notificar no próximo login. Falha de um item não repete OZCoins/VIP já entregues.

Mensagens distinguem “KOTH conquistado”, “recompensa disponível”, “recompensa entregue” e “entrega pendente”. Não mandar resgatar novamente algo já creditado.

Falha web não para captura se servidor do jogo e dados locais duráveis estiverem íntegros. Economia indisponível gera pendências; não inventar saldo local final. Persistência do resultado indisponível exige suspender conquista/entrega até recuperação segura.

## 16. HUD, mapa, mensagens e identidade

Interface em português, coerente com o painel existente: grafite, seleção/progresso vermelho OrigemZ e destaque dourado para OZCoins quando apropriado. Reutilizar componentes, acessibilidade, resoluções e convenções existentes. Logo oficial deve ser usada intacta quando presente.

HUD local: nome, estado, tempo máximo restante, controlador, progresso/meta, condição de bloqueio, sua equipe e contribuição. Mostrar “Neutralizando”, “Contestado”, “Elimine os guardas” e “Prêmio depende de disputa mínima” quando aplicável. Cor acompanhada de texto; não depender só de vermelho/verde.

Mapa: marcador exclusivo por instância, nome e raio configuráveis. Chat: anúncio, início, contestação com limite de frequência, troca de controle, avisos de término, conquista, prêmio e limpeza. Não publicar posição exata de cada participante.

Placar histórico opcional mostra domínio, vitórias e abates separados. Não colocar tempo de captura na métrica de metal farmado. Modo streamer existente deve poder ocultar marca e detalhes opcionais para contas autorizadas, mantendo regras/progresso necessários ao jogo.

Variáveis permitidas e validadas: nome do evento, região, controlador, progresso, meta, tempo restante, prêmio e motivo. Renderizar nomes de jogadores como texto seguro, sem interpretar marcação fornecida por eles. Prévia e teste de mensagem no painel antes de salvar.

## 17. Painel web OrigemZ

### Abas e funções

| Aba | Funções obrigatórias |
|---|---|
| Visão geral | Servidor, estado real, próximas execuções, saúde, integrações indisponíveis |
| Perfis | Criar, copiar, editar, desativar, validar, publicar versão |
| Localizações | Mapa, coordenadas, volumes/altura, rotações, cooldown, validação de terreno |
| Estruturas e NPCs | Catálogos, plantas, pontos relativos, grupos, ondas, loot |
| Captura e regras | Domínio, contestação, maioria, abandono, equipe, bloqueios |
| Recompensas | Conjuntos, sorteio, divisão, catálogos OZCoin/Bleik/kit/VIP/item/veículo |
| Agenda | Horário/fuso, população mínima, concorrência, próximos disparos |
| Mensagens | Texto, variáveis, cores, prévia, Discord opcional |
| Ao vivo | Progresso, lados, condições, iniciar/pausar/retomar/cancelar/limpar |
| Histórico | Resultado, configuração usada, participantes, entregas, auditoria |

Não depender de edição manual de JSON para tarefas comuns. Pode existir importação/exportação versionada para backup e usuários avançados, com validação antes de aplicar.

No painel, status de comando: solicitado, recebido pelo agente, executando, concluído ou falhou. “Enviado” não equivale a “evento iniciado”. Mostrar confirmação do servidor e erro legível.

Pausa administrativa congela captura e o tempo máximo, mantém restrições e anuncia pausa. Pausa prolongada expira em cancelamento seguro conforme limite. Retomada revalida local e integrações. Não permitir pausa silenciosa para favorecer lado.

Editor mostra erros no campo correspondente: valores negativos, raio inválido, prêmio inexistente, ranking não gravável, ponto fora da área, integração ausente, distribuição indefinida, fuso inválido. Excluir perfil em uso significa arquivar, preservando histórico.

## 18. Permissões e comandos propostos

Adaptar nomes à convenção real do agente. Permissões devem ser separadas: visualizar, editar configuração, operar evento, reconciliar prêmios e administrar acessos. Permissão web não depende de ser dono da equipe no jogo.

Comandos opcionais de fallback:

| Ação | Exemplo proposto |
|---|---|
| Regras e localização | /koth |
| Estado e placar | /koth status |
| Histórico pessoal | /koth historico |
| Pendências/resgate | /koth recompensas |
| Início autorizado | koth.start <perfil> <local> |
| Pausar/retomar | koth.pause <instância> / koth.resume <instância> |
| Cancelar com motivo | koth.cancel <instância> <motivo> |
| Validar cadastro | koth.validate <local> |
| Diagnóstico | koth.health |

/koth não teleporta no modelo base. Não herdar comandos destrutivos de outros plugins. Ações de limpeza aceitam ID da instância, não um raio genérico que apaga o mapa.

## 19. Integrações e contratos

Antes de implementar, dev deve identificar: runtime Rust usado (Oxide/Carbon ou outro), versão, agente, persistência, autenticação, catálogo de itens, economia, VIPs, kits, conversor Bleik, temporada, BetterLoot, NPCs, mapas, missões, bloqueios de combate e Discord.

Criar adaptadores para consultar disponibilidade, validar configuração, executar ação, consultar resultado e reconciliar. Funcionalidade configurada sem adaptador deve aparecer indisponível e impedir publicação desse perfil.

Eventos internos propostos: instância iniciada, participante elegível, controlador alterado, captura concluída, recompensa confirmada, evento encerrado. Payload mínimo: ID único, servidor, wipe, instância, instante, versão, SteamID/grupo quando relevante, causa e quantidade/unidade. Consumidores deduplicam pelo ID.

Missões podem consumir “vencer KOTH”, “dominar por X segundos” e “eliminar NPC do KOTH”. Contar apenas objetivo aceito e período válido; não contar mesmo evento duas vezes após reconexão. Objetivos por participação precisam de contribuição mínima.

Pontos de ranking adicionais só podem ser enviados a rankings que aceitam crédito externo. Métricas observacionais como abates reais ou metal coletado não recebem bônus artificial por padrão. Exibir ranking, unidade e período no editor.

Endpoints reais são definidos após inspeção do backend. Toda ação web requer autenticação, permissão por servidor, chave de requisição, auditoria e controle de concorrência. Clientes não enviam vencedor/progresso como autoridade.

Comandos de recompensa arbitrários, se necessários, ficam restritos a administrador técnico e lista de templates permitidos. Nunca interpolar nome livre em console; resolver SteamID e validar argumentos. URLs de webhook ficam protegidas e não aparecem em logs públicos.

## 20. Persistência, reinícios e limpeza

Persistir configurações versionadas, reservas, cooldowns, seed/sorteios, estado da execução, grupo congelado, contribuições, checkpoints, entidades, resultado e ledger das entregas.

Reinício durante ATIVO: padrão cancelar sem prêmio de vitória, restaurar limpeza e cooldown. Não somar tempo offline. Retomar evento ativo é extensão que exige revalidar mapa, presença, entidades e regras; não presumir retomada segura.

Reinício depois de CONQUISTADO: manter vencedor e recuperar entregas sem novo sorteio. Reconexão do agente web não cria outra instância. Instância antiga em wipe novo não respawna estruturas; reconciliar apenas entregas compatíveis com temporada.

Antes de remover estrutura, detectar jogadores dentro/sobre ela e avisar. Evacuação administrativa só para posição segura predefinida quando necessária para não deixar jogador cair ou preso; auditar e não usar como transporte voluntário. Adiar limpeza por tempo limitado quando seguro e bloquear novo spawn na mesma localização.

Scanner de recuperação identifica entidades órfãs pela propriedade persistida. Não executar busca destrutiva por shortname em todo servidor.

## 21. Auditoria, abuso e desempenho

Registrar início/fim, decisões do scheduler, presença relevante, captura, transferência, neutralização, morte, desconexão, alteração de grupo, mudanças administrativas, sorteios e cada recompensa. Logs devem ser consultáveis por instância/SteamID e exportáveis, com retenção configurada.

Sinais de abuso: trocas de grupo, oponentes combinados, repetição de recompensas, entradas sem contribuição, contas alimentando requisito de disputa e duplicidade de coleta. Alertas não são prova automática para banimento. IP compartilhado não identifica sozinho uma pessoa; evitar expor dados pessoais no ranking.

Exigir limites de NPCs, entidades, instâncias e frequência de mensagens. Avaliar somente jogadores próximos/registrados, mantendo checagem autoritativa periódica. Atualizar HUD por mudança ou frequência limitada, sem reconstruí-lo em todo frame. Spawn/limpeza em lotes.

Homologação de carga deve medir tempo por avaliação, server FPS antes/depois, memória, custo de UI, NPCs e limpeza no ambiente real. 300 slots configurados não prova capacidade sustentada. Definir orçamento mensurável com a equipe e anexar resultados; não prometer desempenho sem medição.

## 22. Preset inicial para homologação

Todos os valores abaixo são sugestões editáveis, não decisão comercial.

| Campo | Sugestão |
|---|---|
| Nome | KOTH OrigemZ — Domínio |
| Modalidade | Equipe nativa; solo permitido |
| Limite de grupo | Herdar regra confirmada do servidor |
| Início | Automático após intervalo de 2 h do encerramento |
| População mínima | 10 humanos |
| Simultâneos | 1 |
| Anúncio | 5 min |
| Duração ativa máxima | 30 min |
| Captura | 5 min de domínio do controlador |
| Contestação | Exclusividade; pausar quando adversário presente |
| Abandono | Tolerância 10 s; decaimento 1 s/s |
| Troca de controle | Neutralizar primeiro |
| Zona externa | Raio 100 m; altura validada no local |
| Captura | Raio 20 m; altura validada no local |
| NPCs | Opcional; guardas iniciais com limite definido no editor |
| Entrada/morte | Deslocamento e inventário normais |
| Construção | Bloqueada na área do evento |
| Contribuição mínima | 60 s válidos na captura |
| Elegibilidade final | Conectado; presença válida nos últimos 60 s |
| Extração | 5 min |
| Cooldown local | 4 h após limpeza |
| Prêmios | Configurar com catálogos reais; sem quantias inventadas |

Perfil de teste pode usar prêmio simulado, isolado da economia. Bloquear simulação em produção e distinguir “simulado” no HUD/painel/log. Teste real de pagamento deve usar conta autorizada e transação rastreável, sem gerar pontos na temporada competitiva sem autorização.

## 23. Sequência de implementação

1. Levantar contratos existentes e mapear campos do painel/integrações.
2. Implementar estado territorial, scheduler, localizações e testes determinísticos.
3. Implementar participação, captura, contestação, abandono e temporizadores.
4. Integrar entidades, NPCs, restrições, HUD e mapa.
5. Implementar ledger de recompensas e adaptadores reais.
6. Integrar web, permissões, agenda, histórico e diagnósticos.
7. Homologar reinício, falhas, carga e coexistência com demais plugins.
8. Publicar desativado, cadastrar locais/premiações aprovados e executar piloto monitorado.

Essas etapas não tornam funções obrigatórias opcionais. Concluir apenas o núcleo e deixar recompensas/painel com placeholders não satisfaz a entrega.

## 24. Matriz de testes e critérios de aceite

| ID | Cenário | Resultado exigido |
|---|---|---|
| T01 | Agenda com população insuficiente | Não inicia; painel informa motivo |
| T02 | Dois comandos/start simultâneos | Uma instância; limite respeitado |
| T03 | Local em cooldown ou ocupado por base | Pula local, preserva construção |
| T04 | Nenhum local válido | Aguarda, sem loop de spawn ou exceção |
| T05 | Anúncio/preparação | Sem progresso ou prêmio antecipado |
| T06 | Um lado controla 300 s válidos | Uma conquista e um resultado persistido |
| T07 | Adversário entra | Contestado e pausa dentro de uma avaliação |
| T08 | Adversário sai | Retoma sem somar tempo contestado |
| T09 | Controlador abandona | Tolerância e decaimento corretos |
| T10 | Inimigo neutraliza | Não herda progresso anterior |
| T11 | Antigo controlador retorna | Retoma restante só se ainda controlador |
| T12 | Ambos os lados morrem | Nenhum sleeper/corpo mantém domínio |
| T13 | Altura/borda/túnel/veículo | Somente volume e participante elegível contam |
| T14 | Maioria estrita | 3 contra 2 captura; 3 contra 2+2 não |
| T15 | Lag de vários segundos | Sem salto indevido de captura |
| T16 | Troca de grupo durante evento | Sem troca de lado/farm ou benefício retroativo |
| T17 | Grupo dissolvido | Para contribuição e preserva histórico |
| T18 | Guardas obrigatórios vivos | Captura bloqueada com explicação |
| T19 | Onda/reload | Onda não dispara duas vezes |
| T20 | NPC preso | Recuperação limitada ou cancelamento seguro |
| T21 | Comando, UI ou API de teleporte | Bloqueio coerente em todos os caminhos suportados |
| T22 | Kit/item proibido | Bloqueia ação sem destruir inventário |
| T23 | Vitória e morte no mesmo ciclo | Ordem determinística; morto não conclui se inelegível |
| T24 | Limite de duração sem conquista | Expira sem vencedor padrão |
| T25 | Requisito mínimo de disputa ausente | Política anunciada aplicada, sem prêmio enganoso |
| T26 | Divisão 10 por 3 | 4/3/3 determinístico; total 10 |
| T27 | Membro sem contribuição | Não recebe prêmio por pertencer ao grupo |
| T28 | OZCoins e timeout após crédito | Consulta/reconcilia; nunca duplica crédito |
| T29 | Kit entregue, VIP falha | Repete somente etapa pendente |
| T30 | Inventário cheio/desconectado | Prêmio pendente com resgate rastreado |
| T31 | Bleik físico | Uma coleta gera um crédito; não há crédito também na vitória |
| T32 | Bleik direto | Ranking correto, sem item físico adicional |
| T33 | Troca de temporada | Regra de período aplicada, sem pontuar temporada errada |
| T34 | Métrica inexistente/não gravável | Editor impede salvar/ativar |
| T35 | BetterLoot recarregado | Não sobrescreve/duplica prêmio KOTH |
| T36 | Caixa exclusiva/pública | Respeita acesso, janela e saldo coletado |
| T37 | Veículo com spawn obstruído | Aguarda resgate; não colide nem duplica |
| T38 | Veículo permanente entregue | Sobrevive à limpeza do evento |
| T39 | Reinício antes da conquista | Sem prêmio; limpeza e cooldown recuperados |
| T40 | Reinício depois de conquistar | Mesmo vencedor e sorteio; entregas conciliadas |
| T41 | Painel offline | Jogo continua quando persistência local está íntegra |
| T42 | Comando web repetido/reconectado | Requisição deduplicada e status real |
| T43 | Wipe/mapa alterado | Não reutiliza coordenadas sem validação |
| T44 | Limpeza com jogadores/objetos vizinhos | Evacua com segurança e preserva propriedades alheias |
| T45 | Recompensa já paga | Chat não manda resgatar novamente |
| T46 | Missão/consumidor recebe evento repetido | Progresso contabilizado uma vez |
| T47 | Configuração muda durante partida | Instância mantém versão congelada |
| T48 | Usuário web sem permissão | Ação negada no backend e auditada |
| T49 | Múltiplas instâncias permitidas | HUD, áreas, prêmio e limpeza independentes |
| T50 | Teste sob carga | Métricas dentro do orçamento acordado, sem vazamento crescente |

Definir precedência no ciclo: aplicar eventos de morte/desconexão conhecidos, recalcular presença, aplicar restrições/NPCs, calcular progresso e por último avaliar vitória. Nas fronteiras exatas de timeout usar timestamp autoritativo: conquista válida até o prazo; depois dele expiração. Documentar resolução temporal e tolerância do teste.

Entrega do dev deve incluir plugin/serviço, migrações, painel funcional, configurações de exemplo, catálogos integrados, manual administrativo, plano de rollback e evidências dos testes. Falhas ou integrações indisponíveis devem aparecer explicitamente no relatório, nunca como funções concluídas.

## 25. Decisões de produção ainda necessárias

- Limite real de grupo e fonte de equipes/clãs.
- Localizações, alturas e plantas aprovadas para o mapa.
- Frequência, população mínima e horários.
- Valores finais de OZCoins, troféus, itens, kits e VIPs.
- Ranking/temporada Bleik e regra de troféu físico entre temporadas.
- Divisão coletiva/individual e janela de participação.
- Lista final de bloqueios e integrações instaladas.
- Orçamento técnico de carga e retenção de logs.

O sistema deve oferecer os campos e validações para essas escolhas. Na ausência de valor de produção, manter perfil desativado e exibir pendência; não assumir uma economia aprovada.

## 26. Referências e limites da pesquisa

Fonte principal: descrição do KOTH de DayZ fornecida pelo OrigemZ nesta conversa. É a base normativa do comportamento solicitado, não código-fonte inspecionado do DayZ.

Referências complementares consultadas na pesquisa anterior:

1. [King Of The Hill Event — Lone Design](https://lone.design/product/king-of-the-hill-event-rust-plugin/): inspiração para base temporária, loot e defensores. A descrição pública não estabelece todas as regras de captura propostas aqui.
2. [KOTH Event — Battle of Supremacy — Codefling](https://codefling.com/plugins/koth-event-king-of-the-hill-battle-of-supremacy): inspiração para configuração de arenas, agenda, marcadores, restrições, estatísticas e prêmios. Sua competição por abates não substitui a base de domínio territorial.
3. [King of the Hill — Codefling](https://codefling.com/plugins/king-of-the-hill): referência de objetivo por tempo de controle e personalização de zonas. Seu modelo de arena teleportada/inventário protegido não faz parte desta versão.

Neutralização, tolerâncias, padrões numéricos, ledger, contratos propostos e testes deste documento são especificações de projeto para o OrigemZ. Não atribuir esses comportamentos aos plugins comerciais sem comprovação. Não é necessário implementar todos os modelos externos para atender esta entrega.
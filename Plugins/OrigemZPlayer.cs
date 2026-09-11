// Requires: OrigemZAgent
// Reference: 0Harmony

// ============================================================
//  OrigemZPlayer.cs
//
//  O jogador dentro do jogo: o kit que ele recebe ao nascer, o
//  inventario que ele tem agora, as acoes de admin sobre ele e a
//  velocidade com que as coisas andam para ele.
//
//  ------------------------------------------------------------
//  #### O QUE ELE FAZ ####
//
//   1. TIRA o kit de fabrica do Rust (tocha e pedra) e poe no
//      lugar o kit do NIVEL do jogador. Todo mundo tem kit: quem
//      nao e VIP recebe o `normal`, que e justamente o que
//      substitui aquelas duas pecas.
//
//   2. Responde o inventario REAL do jogador para o painel, por
//      origemz.player.inventory.
//
//   3. Executa as acoes de admin que hoje exigiriam entrar no
//      jogo: matar (origemz.player.kill) e dar o kit agora
//      (origemz.player.loadout).
//
//   4. Acelera, POR NIVEL, a fornalha, o craft, a pesquisa e o
//      reciclador - a aba Configuracoes > Player > Timers. E o
//      que o QuickSmelt fazia, mas preso ao nivel do jogador e sem
//      reescrever o forno do jogo. Ver a secao OS TIMERS.
//
//  O `// Reference: 0Harmony` la em cima e do item 4: o craft e
//  acelerado por um patch de Harmony, e o compilador de plugins do
//  Oxide so enxerga o 0Harmony.dll quando o plugin pede.
//
//  ------------------------------------------------------------
//  #### DE ONDE VEM O KIT ####
//
//  Do OrigemZAgent, por hook, e ja pronto:
//
//      GetVipTier(steamId)  -> "gold" | ... | null
//      GetLoadout(tier)     -> JSON com os itens daquele nivel
//
//  O agente guarda os dois em cache, empurrados pelo RustAgent
//  (origemz.vip.sync e origemz.loadout.sync). ISSO IMPORTA: o
//  kit e aplicado no caminho de nascimento do jogador, e uma
//  consulta de rede ali faria o jogador nascer sem kit toda vez
//  que a rede engasgasse.
//
//  #### POR QUE NAO PERGUNTAMOS AO OrigemZVip ####
//
//  Ele aplica os GRUPOS do Oxide a partir do que o agente manda;
//  o nivel nao mora nele. Perguntar ao OrigemZVip seria
//  perguntar ao reflexo em vez da fonte, e o reflexo pode estar
//  um passo atras (grupo ainda nao sincronizado). O contrato
//  esta em Docs\OrigemZAgent\HOOKS.md, e ele e explicito: quem
//  responde "qual o nivel" e o agente.
//
//  ------------------------------------------------------------
//  #### AS REGRAS QUE VALEM PARA O ARQUIVO INTEIRO ####
//
//   1. NENHUMA chamada ao agente em Init(). O Oxide so garante as
//      dependencias a partir de OnServerInitialized().
//
//   2. [PluginReference] vira null quando o alvo e descarregado.
//      Null-check em TODA chamada.
//
//   3. Nada de sintaxe acima de C# 6. O compilador em tempo de
//      execucao do Oxide para nesse teto - sem "out var", sem
//      tupla, sem funcao local, sem interpolacao de string.
//
//   4. Texto que o jogador le sai do lang, nunca do codigo.
//
//   5. NADA aqui pode lancar de dentro de um hook do jogo. Uma
//      excecao no OnPlayerRespawned nao trava so o kit: ela sobe
//      pelo caminho de nascimento do jogador.
// ============================================================

using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using UnityEngine;

using Oxide.Core.Plugins;

namespace Oxide.Plugins
{
    // 0.2.0: os timers por nivel (fornalha, craft, pesquisa e
    // reciclador). Precisa do OrigemZAgent 0.5.0 - com o antigo, o
    // GetTimers nao existe, a chamada volta null e todo mundo fica no
    // x1, que e o jogo sem plugin.
    [Info("OrigemZPlayer", "OrigemZ", "0.2.0")]
    [Description("Kit por nivel ao nascer, inventario ao vivo, acoes de admin e timers por nivel")]
    public class OrigemZPlayer : RustPlugin
    {
        [PluginReference]
        private Plugin OrigemZAgent;

        private const string HookGetApiVersion = "GetApiVersion";
        private const string HookGetVipTier = "GetVipTier";
        private const string HookGetLoadout = "GetLoadout";
        private const string HookGetSpawnStatus = "GetSpawnStatus";
        private const string HookGetTimers = "GetTimers";

        private const int ExpectedAgentApiVersion = 1;

        // Nivel de quem nao e VIP. Nao vem do agente: e a AUSENCIA
        // de VIP, e mesmo assim tem kit - o que substitui a tocha e
        // a pedra de fabrica.
        private const string TierNormal = "normal";

        // Nivel de quem tem auth level no Rust. Sai do jogo, e nao
        // de grupo nosso - mesma regra da fila (OrigemZQueue).
        private const string TierAdmin = "admin";

        private const string InventoryCommand = "origemz.player.inventory";
        private const string KillCommand = "origemz.player.kill";
        private const string LoadoutCommand = "origemz.player.loadout";
        private const string TeleportCommand = "origemz.player.teleport";

        private const string SlotWear = "wear";
        private const string SlotBelt = "belt";
        private const string SlotMain = "main";

        private const int SteamId64Length = 17;

        // Codigos de erro do contrato (Docs\OrigemZAgent\HOOKS.md).
        private const string ErrorInvalidArgs = "INVALID_ARGS";
        private const string ErrorPlayerNotFound = "PLAYER_NOT_FOUND";
        private const string ErrorInternal = "INTERNAL_ERROR";
        private const string ErrorOutsideWorld = "OUTSIDE_WORLD";

        // ========================================================
        //  A FOLGA DO TELEPORTE
        //
        //  Meio metro acima do chao. Zero deixaria o jogador
        //  NASCENDO DENTRO do terreno, que e o caminho mais rapido
        //  de ficar preso quando o chao e inclinado; muito mais que
        //  isso vira queda, e queda no Rust tira vida.
        // ========================================================
        private const float TeleportGroundClearance = 0.5f;

        // O nivel do mar do Rust. Ver o piso em HandleTeleport: sem
        // ele, um destino em mar aberto leva o jogador para o FUNDO.
        private const float OceanLevel = 0f;

        // Chaves do lang.
        private const string MsgKitGiven = "KitGiven";
        private const string MsgKitEmpty = "KitEmpty";
        private const string MsgKitPartial = "KitPartial";

        private PluginConfig _config;
        private bool _ready;

        // Ultima aplicacao de kit por jogador, em
        // Time.realtimeSinceStartup.
        //
        // Existe porque o respawn nao e um evento unico e limpo: o
        // OnPlayerRespawned pode disparar mais de uma vez para o
        // mesmo nascimento (respawn em saco de dormir, reconexao no
        // mesmo tick), e sem esta trava o jogador receberia o kit
        // duas vezes - o que num kit com arma e municao e um bug
        // que o jogador NAO reporta.
        private Dictionary<ulong, float> _lastApplied = new Dictionary<ulong, float>();

        // ========================================================
        //  CICLO DE VIDA
        // ========================================================
        private void Init()
        {
            // Os patches de Harmony do craft sao estaticos e precisam
            // achar o plugin. O Oxide os aplica logo DEPOIS do Init.
            _instance = this;

            ResolveRecycleThink();

            Puts("Init() - comandos: " + InventoryCommand + ", " + KillCommand + ", " +
                 LoadoutCommand + ", " + TeleportCommand +
                 ". Contrato do agente esperado: v" + ExpectedAgentApiVersion + ".");
        }

        private void OnServerInitialized()
        {
            try
            {
                LogAgentApiVersion();
                _ready = true;

                Puts("Kit ao nascer: " + (_config.AplicarKitAoNascer ? "ligado" : "desligado") +
                     ". Itens de fabrica do Rust: " +
                     (_config.RemoverItensPadraoDoJogo
                         ? "removidos so de quem tem kit"
                         : "mantidos") + ".");
            }
            catch (Exception ex)
            {
                PrintError("OnServerInitialized falhou; o kit fica desligado ate um reload: " + ex);
            }

            // Separado do bloco de cima de proposito: um erro nos
            // timers nao pode levar o kit junto, e vice-versa.
            try
            {
                StartTimers();
            }
            catch (Exception ex)
            {
                PrintError("Os timers nao subiram; fornalha, craft, pesquisa e reciclador ficam " +
                           "no x1 ate um reload: " + ex);
            }
        }

        // Devolve ao jogo o que os timers mexeram. O resto (o relogio
        // da fornalha, os patches do craft) o Oxide desfaz sozinho ao
        // descarregar o plugin.
        private void Unload()
        {
            try
            {
                RestoreResearchTables();
                RestoreRecyclers();
            }
            catch (Exception ex)
            {
                PrintError("Unload nao devolveu tudo ao jogo: " + ex);
            }

            _trackedOvens.Clear();
            _craftingNow = null;
            _instance = null;
        }

        // ========================================================
        //  OnDefaultItemsReceive - TIRAR A TOCHA E A PEDRA
        //
        //  O hook dispara em PlayerInventory.GiveDefaultItems, e
        //  RETORNO NAO-NULL CANCELA a entrega de fabrica. E o unico
        //  jeito limpo de fazer isso: a alternativa seria deixar o
        //  jogo dar os itens e limpar depois, e nesse meio-tempo o
        //  jogador ja viu a tocha aparecer e sumir.
        //
        //  Devolver `true` para cancelar, e null para deixar o jogo
        //  fazer o dele. NUNCA `false`: no Oxide o que conta e ser
        //  diferente de null, entao `false` cancelaria do mesmo
        //  jeito - e leria como se nao cancelasse.
        //
        //  ####  SO CANCELA QUEM TEM COM O QUE SUBSTITUIR  ####
        //
        //  ISTO ACONTECEU EM PRODUCAO: o nivel `normal` estava sem
        //  kit, este hook cancelou os itens de fabrica assim mesmo,
        //  e o jogador NASCEU PELADO. Cada peca fez o que devia; a
        //  soma e que estava errada.
        //
        //  Cancelar so faz sentido quando existe kit para colocar
        //  no lugar. Sem kit, o jogo da o dele: tocha e pedra sao um
        //  comeco pior que o kit e MUITO melhor que nada, e sao o
        //  que o Rust faz sozinho quando ninguem interfere.
        //
        //  A pergunta e barata: o loadout vem do cache em memoria do
        //  OrigemZAgent, sem ida a rede nem ao disco - e este hook
        //  roda no meio do nascimento do jogador.
        // ========================================================
        private object OnDefaultItemsReceive(PlayerInventory inventory)
        {
            try
            {
                // `AplicarKitAoNascer` desligado e o mesmo buraco por
                // outra porta: ninguem viria dar o kit no lugar do
                // que este hook tirasse (ver PluginConfig.Default).
                if (!_ready || !_config.RemoverItensPadraoDoJogo || !_config.AplicarKitAoNascer)
                {
                    return null;
                }

                if (inventory == null || OrigemZAgent == null)
                {
                    // Sem saber de quem e o inventario, ou sem o hub
                    // para perguntar, a escolha segura e a do jogo.
                    return null;
                }

                BasePlayer player = inventory.baseEntity;

                if (player == null || player.IsNpc)
                {
                    return null;
                }

                List<LoadoutItem> items = ReadLoadout(ResolveTier(player));

                // Vazio = o nivel nao tem kit, OU o cache ainda nao
                // chegou depois de um reload. Nos dois casos nao ha
                // o que substituir, e o certo e nao mexer.
                if (items == null || items.Count == 0)
                {
                    return null;
                }

                return true;
            }
            catch (Exception ex)
            {
                // Falhar aqui e deixar o jogo dar os itens de
                // fabrica, que e o comportamento de antes do plugin.
                PrintError("OnDefaultItemsReceive falhou: " + ex);
                return null;
            }
        }

        // ========================================================
        //  OnPlayerRespawned - O KIT
        //
        //  Cobre os dois casos que importam, e sao o mesmo evento
        //  para o jogo: a PRIMEIRA vez que o jogador nasce no
        //  servidor e cada vez que ele renasce depois de morrer.
        //
        //  O kit e aplicado com um atraso curto (ver
        //  SegundosAntesDeAplicarOKit): neste instante o jogo ainda
        //  esta montando o inventario do jogador, e escrever junto
        //  faz o item aparecer e sumir.
        // ========================================================
        private void OnPlayerRespawned(BasePlayer player)
        {
            try
            {
                if (!_ready || !_config.AplicarKitAoNascer || player == null || player.IsNpc)
                {
                    return;
                }

                float now = Time.realtimeSinceStartup;
                float last;

                if (_lastApplied.TryGetValue(player.userID, out last) &&
                    now - last < _config.SegundosMinimosEntreKits)
                {
                    return;
                }

                _lastApplied[player.userID] = now;

                ulong userId = player.userID;

                timer.Once(_config.SegundosAntesDeAplicarOKit, delegate
                {
                    // O jogador pode ter saido no meio do atraso -
                    // por isso buscamos de novo em vez de fechar
                    // sobre a referencia.
                    BasePlayer target = BasePlayer.FindByID(userId);

                    if (target == null || !target.IsConnected)
                    {
                        return;
                    }

                    // O STATUS antes do kit, e a ordem importa: o
                    // ApplyLoadout mexe em inventario, e um erro
                    // dele nao deveria impedir o jogador de nascer
                    // com a vida certa. O contrario tambem vale - o
                    // AplicarStatus nao lanca (ver la dentro).
                    AplicarStatus(target);

                    LoadoutOutcome outcome = ApplyLoadout(target, true);

                    if (outcome.Error != null)
                    {
                        PrintWarning("Kit nao aplicado para " + userId + " (" + outcome.Error + ").");
                        return;
                    }

                    AnnounceKit(target, outcome);
                });
            }
            catch (Exception ex)
            {
                PrintError("OnPlayerRespawned falhou: " + ex);
            }
        }

        private void OnPlayerDisconnected(BasePlayer player, string reason)
        {
            try
            {
                if (player == null)
                {
                    return;
                }

                // Sem isto o dicionario cresceria com um float por
                // jogador que ja passou pelo servidor.
                _lastApplied.Remove(player.userID);

                if (!player.IsNpc)
                {
                    // O motivo vem do proprio jogo ("disconnect",
                    // "Kicked: ...", "EAC: ..."), e e a unica pista
                    // que sobra quando alguem pergunta por que um
                    // jogador sumiu.
                    EmitEvent(EventDisconnected, player, reason);
                }
            }
            catch (Exception ex)
            {
                PrintError("OnPlayerDisconnected falhou: " + ex);
            }
        }

        // ========================================================
        //  OS EVENTOS DE SESSAO
        //
        //  #### POR QUE UMA LINHA NO CONSOLE, E NAO UM COMANDO ####
        //
        //  O plugin nao alcanca o RustAgent: quem abre conexao e o
        //  agente, e o unico canal de volta que existe e a saida do
        //  console, que ele ja le inteira pelo RCON.
        //
        //  Entao o evento vai como UMA LINHA marcada. O agente
        //  reconhece o marcador no stream de log e grava; quem nao
        //  conhece o marcador ve uma linha de log comum.
        //
        //  #### E POR QUE NAO BASTAVA A AVISTAGEM ####
        //
        //  A base ja se alimentava da lista de online lida a cada
        //  poucos segundos. Isso responde "ele existiu por aqui" e
        //  nao responde nada sobre a SESSAO: dois logins entre duas
        //  leituras viram um so, e uma morte entre elas nao deixa
        //  rastro nenhum. Evento e o unico jeito de ter a hora
        //  certa - e as duas coisas convivem, com a avistagem como
        //  rede de seguranca para o que o evento perder.
        //
        //  #### O MARCADOR E FIXO E FEIO DE PROPOSITO ####
        //
        //  "#OZPEVT#" nao aparece em log de servidor, de plugin nem
        //  de chat. Um prefixo bonito ("[player] ...") seria
        //  ambiguo com o que outro plugin imprime, e o agente
        //  gravaria sessao a partir de mensagem de terceiro.
        // ========================================================
        private const string EventMarker = "#OZPEVT#";

        private const string EventConnected = "connected";
        private const string EventDisconnected = "disconnected";
        private const string EventDied = "died";

        private void OnPlayerConnected(BasePlayer player)
        {
            try
            {
                if (player == null || player.IsNpc)
                {
                    return;
                }

                EmitEvent(EventConnected, player, null);
            }
            catch (Exception ex)
            {
                PrintError("OnPlayerConnected falhou: " + ex);
            }
        }

        // ========================================================
        //  OnPlayerDeath
        //
        //  Cuidado que o hook impoe: ele dispara para NPC tambem, e
        //  o BasePlayer de um NPC tem userID que nao e SteamID64.
        //  Gravar isso encheria a base de jogadores que nao
        //  existem - dai o IsNpc antes de qualquer coisa.
        //
        //  NAO devolvemos valor: retorno nao-null CANCELA a morte,
        //  e o jogador ficaria vivo com vida zero. O metodo e void
        //  por isso.
        // ========================================================
        private void OnPlayerDeath(BasePlayer player, HitInfo info)
        {
            try
            {
                if (player == null || player.IsNpc)
                {
                    return;
                }

                EmitEvent(EventDied, player, null);
            }
            catch (Exception ex)
            {
                PrintError("OnPlayerDeath falhou: " + ex);
            }
        }

        // Monta e imprime a linha do evento.
        //
        // Uma linha, sempre - o agente separa o stream por linha, e
        // um JSON quebrado em duas viraria dois fragmentos
        // invalidos. Por isso o nome do jogador tambem passa por
        // uma limpeza: ele e escolhido pelo proprio jogador e pode
        // conter quebra de linha.
        private void EmitEvent(string eventName, BasePlayer player, string reason)
        {
            if (!_config.EnviarEventosDeSessao)
            {
                return;
            }

            PlayerEventPayload payload = new PlayerEventPayload();
            payload.Event = eventName;
            payload.SteamId = player.UserIDString;
            payload.Name = SanitizeName(player.displayName);
            payload.Reason = reason;

            // Epoch em SEGUNDOS, do relogio do servidor. O agente
            // converte para ISO com o fuso dele - mandar texto ja
            // formatado exigiria que os dois lados concordassem
            // sobre fuso, e eles nao concordam.
            payload.At = (long)DateTimeOffset.UtcNow.ToUnixTimeSeconds();

            string line = EventMarker + JsonConvert.SerializeObject(payload);

            // #### O EVENTO SAI NO PROXIMO FRAME ####
            //
            // MEDIDO, e por um caminho que nao era obvio: um Puts
            // dentro de um ConsoleCommand vira a RESPOSTA daquele
            // comando (mesmo Identifier, Type=Generic, e o
            // ReplyWith so e transmitido quando o comando termina).
            //
            // Aqui o Puts nao esta num comando - esta num HOOK. So
            // que o hook e disparado POR um comando:
            // origemz.player.kill chama player.Die(), que dispara
            // OnPlayerDeath, que chama este metodo. O evento saia
            // no lugar da resposta do kill, e o desfecho era duplo:
            // o comando morria com PLUGIN_INVALID_RESPONSE E o
            // evento nunca chegava ao handler de log do agente -
            // ou seja, a morte nao era gravada.
            //
            // O mesmo vale para uma saida provocada por comando
            // (kick). Adiar um frame resolve os dois casos de uma
            // vez, e nao muda nada no caso comum (jogador morrendo
            // sozinho).
            timer.Once(0f, delegate { Puts(line); });
        }

        // Nome de jogador e texto que o JOGADOR escolhe. Quebra de
        // linha ali dentro quebraria o evento em dois fragmentos no
        // stream do agente.
        private static string SanitizeName(string name)
        {
            if (string.IsNullOrEmpty(name))
            {
                return string.Empty;
            }

            return name.Replace("\r", " ").Replace("\n", " ").Trim();
        }

        // Aviso no chat. Existe porque o kit chega em silencio: o
        // jogador que nasce com sete itens sem explicacao nao sabe
        // se aquilo e do servidor, do VIP dele, ou sobra da vida
        // anterior.
        private void AnnounceKit(BasePlayer player, LoadoutOutcome outcome)
        {
            if (!_config.AvisarNoChat)
            {
                return;
            }

            string userId = player.UserIDString;

            if (outcome.Given == 0 && outcome.Skipped == 0)
            {
                // Nivel sem kit configurado. Nao avisamos nada: o
                // jogador nao perdeu coisa nenhuma, e "voce recebeu
                // 0 itens" e ruido.
                return;
            }

            if (outcome.Skipped > 0)
            {
                SendReply(player, string.Format(Msg(MsgKitPartial, userId),
                    outcome.Given, outcome.Skipped));
                return;
            }

            SendReply(player, string.Format(Msg(MsgKitGiven, userId), outcome.Given));
        }

        // ========================================================
        //  O CORACAO: montar o kit no inventario
        //
        //  #### O QUE ELE FAZ, NA ORDEM ####
        //
        //   1. descobre o NIVEL do jogador (admin > VIP > normal);
        //   2. pede o kit daquele nivel ao agente;
        //   3. limpa o inventario, se for nascimento;
        //   4. cria e posiciona cada item.
        //
        //  Nunca lanca: devolve o desfecho dentro do
        //  LoadoutOutcome. Os dois chamadores (o respawn e o
        //  comando do agente) precisam de resposta, nao de excecao.
        // ========================================================
        private LoadoutOutcome ApplyLoadout(BasePlayer player, bool isSpawn)
        {
            try
            {
                if (player == null || player.inventory == null)
                {
                    return LoadoutOutcome.Failure(ErrorPlayerNotFound);
                }

                if (OrigemZAgent == null)
                {
                    return LoadoutOutcome.Failure("AGENT_UNAVAILABLE");
                }

                string tier = ResolveTier(player);
                List<LoadoutItem> items = ReadLoadout(tier);

                if (items == null)
                {
                    return LoadoutOutcome.Failure(ErrorInternal);
                }

                // Nivel sem kit e um estado NORMAL, e nao um erro:
                // o admin pode simplesmente nao ter configurado
                // aquele nivel ainda. Limpar o inventario aqui
                // deixaria o jogador pelado por causa de uma linha
                // que ninguem escreveu.
                if (items.Count == 0)
                {
                    // #### MAS ELE PRECISA APARECER NO LOG ####
                    //
                    // Ninguem nasce mais de maos vazias: o
                    // OnDefaultItemsReceive faz a mesma pergunta
                    // antes de cancelar, e sem kit deixa o jogo dar
                    // a tocha e a pedra dele.
                    //
                    // O aviso continua porque o jogador ESTA
                    // recebendo o de fabrica no lugar do que o admin
                    // configurou, e isso e silencioso: nenhum erro,
                    // nenhuma reclamacao, cada peca fazendo o que
                    // devia. Foi assim que um cache de kits
                    // esvaziado por um oxide.reload passou 25
                    // minutos sem ninguem notar.
                    //
                    // So no NASCIMENTO: o botao "dar o kit" da
                    // ficha aplicado a um nivel sem kit e uma
                    // escolha de quem clicou, nao uma surpresa.
                    if (isSpawn && _config.RemoverItensPadraoDoJogo)
                    {
                        PrintWarning("Jogador " + player.UserIDString + " nasceu com a TOCHA E A PEDRA " +
                                     "do Rust: o nivel '" + tier + "' esta sem kit, entao o de fabrica " +
                                     "ficou de pe para ele nao nascer pelado. Confira Configuracoes > " +
                                     "Player > Loadout no painel - e se o kit existir la, o cache deste " +
                                     "plugin pode ter sido esvaziado por um reload (ele se repoe " +
                                     "sozinho em ate 5 min).");
                    }

                    return LoadoutOutcome.Applied(tier, 0, 0);
                }

                if (isSpawn && _config.LimparInventarioAoNascer)
                {
                    // Strip() zera os tres conteineres. So no
                    // NASCIMENTO: aplicar o kit a mao (pelo painel)
                    // num jogador vivo nao pode apagar o que ele
                    // juntou.
                    player.inventory.Strip();
                }

                int given = 0;
                int skipped = 0;

                for (int i = 0; i < items.Count; i++)
                {
                    if (GiveLoadoutItem(player, items[i]))
                    {
                        given++;
                    }
                    else
                    {
                        skipped++;
                    }
                }

                return LoadoutOutcome.Applied(tier, given, skipped);
            }
            catch (Exception ex)
            {
                PrintError("Aplicacao de kit falhou: " + ex);
                return LoadoutOutcome.Failure(ErrorInternal);
            }
        }

        // Cria UM item e o coloca no lugar. Devolve false quando o
        // item nao existiu ou nao coube.
        private bool GiveLoadoutItem(BasePlayer player, LoadoutItem entry)
        {
            if (entry == null || string.IsNullOrEmpty(entry.Shortname))
            {
                return false;
            }

            int amount = entry.Amount < 1 ? 1 : entry.Amount;
            ulong skin = ParseSkin(entry.SkinId);

            Item item = ItemManager.CreateByName(entry.Shortname, amount, skin);

            if (item == null)
            {
                // Shortname que o jogo nao conhece. Avisamos UMA
                // vez por aplicacao e seguimos: um kit inteiro
                // recusado por causa de um item digitado errado
                // seria pior para o jogador do que um kit com um
                // item a menos.
                PrintWarning("Item '" + entry.Shortname + "' nao existe no jogo; " +
                             "confira o kit em Configuracoes > Player > Loadout.");
                return false;
            }

            ItemContainer container = ResolveContainer(player, entry.Slot);

            if (container == null)
            {
                item.Remove();
                return false;
            }

            // Posicao negativa = a primeira livre. E o que o jogo
            // entende por -1, e e o que a tela manda quando o admin
            // nao escolheu casinha.
            int position = entry.Position < 0 ? -1 : entry.Position;

            if (item.MoveToContainer(container, position, true))
            {
                return true;
            }

            // A casinha pedida estava ocupada (ou nao existe naquele
            // conteiner). Tentamos qualquer lugar antes de desistir:
            // o jogador prefere a arma na mochila a nao receber a
            // arma.
            if (item.MoveToContainer(container, -1, true))
            {
                return true;
            }

            // Nem no conteiner do slot, nem em lugar nenhum dele.
            // O item PRECISA ser removido: um Item criado e nao
            // colocado em cont\u00eainer nenhum fica pendurado no mundo,
            // sem dono.
            item.Remove();
            return false;
        }

        private ItemContainer ResolveContainer(BasePlayer player, string slot)
        {
            string normalized = slot == null ? string.Empty : slot.Trim().ToLowerInvariant();

            if (normalized == SlotWear)
            {
                return player.inventory.containerWear;
            }

            if (normalized == SlotBelt)
            {
                return player.inventory.containerBelt;
            }

            if (normalized == SlotMain)
            {
                return player.inventory.containerMain;
            }

            PrintWarning("Slot '" + slot + "' desconhecido no kit; o item foi ignorado. " +
                         "Os slots validos sao wear, belt e main.");
            return null;
        }

        // ========================================================
        //  O NIVEL DO JOGADOR
        //
        //  A ordem e admin > VIP > normal, e o admin sai do AUTH
        //  LEVEL do Rust, nao de grupo nosso: quem ja e admin nao
        //  precisa de cadastro de VIP para ter o kit de admin.
        //
        //  Se nao ha kit de admin configurado, o ResolveTier ainda
        //  devolve "admin" e o GetLoadout devolve lista vazia - o
        //  admin nasce sem kit, e nao com o kit de jogador normal.
        //  E a leitura certa: um nivel configurado vazio e uma
        //  escolha, nao um esquecimento a ser compensado.
        // ========================================================
        private string ResolveTier(BasePlayer player)
        {
            if (_config.AdminTemKitProprio && player.net != null &&
                player.net.connection != null && player.net.connection.authLevel > 0)
            {
                return TierAdmin;
            }

            string tier = OrigemZAgent.Call(HookGetVipTier, player.UserIDString) as string;

            if (string.IsNullOrEmpty(tier))
            {
                return TierNormal;
            }

            return tier.Trim().ToLowerInvariant();
        }

        // O kit daquele nivel, do cache do agente.
        //
        // Devolve lista VAZIA para nivel sem kit e null quando o
        // JSON nao parseia - os dois casos sao diferentes: o
        // primeiro e normal, o segundo e defeito e o chamador
        // precisa poder recusar em vez de "aplicar nada".
        // ========================================================
        //  O STATUS DE NASCIMENTO — vida, fome e sede
        //
        //  #### APLICADO UMA VEZ, E SO NO NASCIMENTO ####
        //
        //  Nada aqui vigia o jogador depois. Um VIP que nasce de
        //  barriga cheia passa fome no mesmo ritmo de todo mundo a
        //  partir do segundo seguinte, e isso e o desenho, nao uma
        //  limitacao: a alternativa (teto permanente, reaplicado a
        //  cada conexao) disputa com tudo que o jogo reseta sozinho,
        //  e o primeiro lugar onde isso vaza e um jogador com a
        //  barra de vida mudando no meio de um tiroteio.
        //
        //  #### UM VALOR, OU UMA FAIXA ####
        //
        //  Quando o agente manda `health` e `healthMax`, o numero e
        //  SORTEADO aqui, neste nascimento - e no proximo sai outro.
        //  Um numero fixo faz todo mundo do nivel acordar igual, e a
        //  vantagem vira um carimbo identico na tela de trinta
        //  pessoas. Ver Sortear().
        //
        //  #### O MAXIMO SOBE JUNTO, QUANDO PRECISA ####
        //
        //  Pedir 150 de vida num jogador cujo maximo e 100 daria 100
        //  em SILENCIO - o admin configuraria 150, veria 100, e nao
        //  teria como saber por que. Por isso o maximo e levantado
        //  antes de escrever o valor.
        //
        //  Vale enquanto aquele BasePlayer viver. Morreu, nasce de
        //  novo, e o ciclo se repete - que e exatamente o que "uma
        //  vez, ao nascer" quer dizer.
        //
        //  NUNCA lanca: roda dentro do timer do respawn, ao lado da
        //  entrega do kit, e uma excecao aqui levaria o kit junto.
        // ========================================================
        private void AplicarStatus(BasePlayer player)
        {
            try
            {
                if (player == null || player.IsNpc)
                {
                    return;
                }

                SpawnStatus status = ReadSpawnStatus(ResolveTier(player));

                // Sem configuracao para este nivel: o jogo decide, e
                // nao encostamos no jogador. E o caso comum, e o
                // estado correto de um servidor recem-instalado.
                if (status == null)
                {
                    return;
                }

                if (status.Health.HasValue)
                {
                    float health = Sortear(status.Health.Value, status.HealthMax);

                    // MaxHealth() e o teto efetivo (inclui
                    // modificadores). Subir so quando precisa evita
                    // mexer no jogador a toa no caso comum, que e
                    // pedir 100 num teto que ja e 100.
                    if (health > player.MaxHealth())
                    {
                        player.SetMaxHealth(health);
                    }

                    player.health = health;
                }

                PlayerMetabolism metabolism = player.metabolism;

                if (metabolism != null)
                {
                    if (status.Calories.HasValue)
                    {
                        AplicarAtributo(
                            metabolism.calories,
                            Sortear(status.Calories.Value, status.CaloriesMax));
                    }

                    if (status.Hydration.HasValue)
                    {
                        AplicarAtributo(
                            metabolism.hydration,
                            Sortear(status.Hydration.Value, status.HydrationMax));
                    }
                }

                // Empurra o estado novo para o cliente.
                //
                // Ja tentei `metabolism.SendChangesToClient()`, que
                // e o que muitos plugins usam: NAO existe em
                // PlayerMetabolism nesta versao do jogo (CS1061 no
                // build). O update de rede do proprio jogador leva
                // o metabolismo junto e e API estavel de
                // BaseEntity - sem ele, as barras na tela ficariam
                // mostrando o valor antigo ate o proximo tick que
                // as atualizasse por outro motivo.
                player.SendNetworkUpdateImmediate();
            }
            catch (Exception ex)
            {
                PrintError("AplicarStatus falhou: " + ex);
            }
        }

        // Escreve um atributo do metabolismo, levantando o teto dele
        // quando o valor pedido nao caberia.
        //
        // MetabolismAttribute e classe de NIVEL SUPERIOR
        // (Assets\Scripts\Entity\MetaBolism\MetabolismAttribute.cs),
        // e nao um tipo aninhado em PlayerMetabolism - escrever
        // PlayerMetabolism.MetabolismAttribute e CS0426.
        // O numero daquele nascimento.
        //
        //  ####  POR QUE O SORTEIO E AQUI, E NAO NO AGENTE  ####
        //
        //  Ele precisa acontecer A CADA NASCIMENTO. Se o agente
        //  sorteasse ao montar o payload, o numero ficaria congelado
        //  ate o push seguinte: trinta jogadores do mesmo nivel
        //  nasceriam com o MESMO valor, que e o que a faixa existe
        //  para evitar.
        //
        //  Teto ausente, menor ou igual ao piso devolve o piso: o
        //  agente ja recusa faixa invertida na gravacao, e aqui a
        //  resposta segura e o valor que o admin escreveu primeiro.
        private static float Sortear(float from, float? to)
        {
            if (!to.HasValue || to.Value <= from)
            {
                return from;
            }

            // Random.Range(float, float) inclui os dois extremos, que
            // e o que "entre 125 e 135" quer dizer para quem
            // configurou.
            return UnityEngine.Random.Range(from, to.Value);
        }

        private static void AplicarAtributo(MetabolismAttribute attribute, float value)
        {
            if (attribute == null)
            {
                return;
            }

            if (value > attribute.max)
            {
                attribute.max = value;
            }

            attribute.value = value;
        }

        // O status de nascimento do nivel, ou null quando nao ha
        // configuracao.
        //
        // null e a resposta esperada e comum aqui, ao contrario do
        // ReadLoadout: nivel sem status configurado e a regra, nao a
        // excecao.
        private SpawnStatus ReadSpawnStatus(string tier)
        {
            string json = OrigemZAgent.Call(HookGetSpawnStatus, tier) as string;

            if (string.IsNullOrEmpty(json))
            {
                return null;
            }

            try
            {
                return JsonConvert.DeserializeObject<SpawnStatus>(json);
            }
            catch (Exception ex)
            {
                PrintError("GetSpawnStatus devolveu JSON ilegivel para o nivel '" + tier + "': " +
                           ex.Message);
                return null;
            }
        }

        private List<LoadoutItem> ReadLoadout(string tier)
        {
            string json = OrigemZAgent.Call(HookGetLoadout, tier) as string;

            if (string.IsNullOrEmpty(json))
            {
                return new List<LoadoutItem>();
            }

            try
            {
                List<LoadoutItem> items = JsonConvert.DeserializeObject<List<LoadoutItem>>(json);
                return items == null ? new List<LoadoutItem>() : items;
            }
            catch (Exception ex)
            {
                PrintError("GetLoadout devolveu JSON ilegivel para o nivel '" + tier + "': " +
                           ex.Message);
                return null;
            }
        }

        // ========================================================
        //  origemz.player.inventory <steamId>
        //
        //  O inventario REAL do jogador, para o painel.
        //
        //  So funciona com ele ONLINE, e nao ha o que fazer sobre
        //  isso: o Rust descarrega o inventario junto com o
        //  BasePlayer. Para quem esta offline nao existe dado
        //  nenhum para ler, em lugar nenhum - por isso a resposta e
        //  PLAYER_NOT_FOUND, que a borda HTTP transforma em 404.
        // ========================================================
        [ConsoleCommand(InventoryCommand)]
        private void CommandInventory(ConsoleSystem.Arg arg)
        {
            try
            {
                arg.ReplyWith(HandleInventory(arg));
            }
            catch (Exception ex)
            {
                PrintError(InventoryCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleInventory(ConsoleSystem.Arg arg)
        {
            BasePlayer player = FindTarget(arg);

            if (player == null)
            {
                return BuildError(arg.Args == null || arg.Args.Length < 1
                    ? ErrorInvalidArgs
                    : ErrorPlayerNotFound);
            }

            List<InventoryItemResponse> items = new List<InventoryItemResponse>();

            CollectItems(player.inventory.containerWear, SlotWear, items);
            CollectItems(player.inventory.containerBelt, SlotBelt, items);
            CollectItems(player.inventory.containerMain, SlotMain, items);

            return JsonConvert.SerializeObject(new InventoryResponse
            {
                SteamId = player.UserIDString,
                Name = player.displayName,
                Alive = !player.IsDead(),
                Count = items.Count,
                Items = items
            });
        }

        private void CollectItems(ItemContainer container, string slot,
                                  List<InventoryItemResponse> into)
        {
            if (container == null || container.itemList == null)
            {
                return;
            }

            for (int i = 0; i < container.itemList.Count; i++)
            {
                Item item = container.itemList[i];

                if (item == null || item.info == null)
                {
                    continue;
                }

                InventoryItemResponse entry = new InventoryItemResponse();
                entry.Slot = slot;
                entry.Position = item.position;
                entry.Shortname = item.info.shortname;
                entry.ItemId = item.info.itemid;
                entry.Name = ResolveItemLabel(item);
                entry.Amount = item.amount;

                // string, e nao ulong: skin do workshop passa de
                // 2^53 e o JSON perderia a ultima casa do lado de
                // quem le em JavaScript.
                entry.SkinId = item.skin.ToString();

                // Item sem durabilidade sai com null nos dois
                // campos. Distinguir isso de "durabilidade zero"
                // importa: o segundo e um item quebrado, e a tela
                // pinta os dois de formas diferentes.
                if (item.hasCondition)
                {
                    entry.Condition = item.condition;
                    entry.MaxCondition = item.maxCondition;
                }

                into.Add(entry);
            }
        }

        // O nome de tela do item. Mesma regra do catalogo do
        // OrigemZAgent: displayName nao e string, e o ingles e a
        // fonte estavel.
        private static string ResolveItemLabel(Item item)
        {
            if (!string.IsNullOrEmpty(item.name))
            {
                // Item renomeado a mao pelo jogador (placa, caixa).
                return item.name;
            }

            if (item.info.displayName == null)
            {
                return item.info.shortname;
            }

            string label = item.info.displayName.english;

            if (string.IsNullOrEmpty(label))
            {
                label = item.info.displayName.translated;
            }

            return string.IsNullOrEmpty(label) ? item.info.shortname : label;
        }

        // ========================================================
        //  origemz.player.kill <steamId>
        //
        //  Para o admin resolver jogador preso em textura ou
        //  travado num estado impossivel.
        //
        //  Matar quem ja esta morto e no-op, e NAO e erro: a
        //  resposta leva wasAlive:false, porque a tela precisa
        //  saber a diferenca para nao anunciar uma morte que nao
        //  houve.
        // ========================================================
        // #### O Puts SAI NO PROXIMO FRAME, E ISSO NAO E ESTILO ####
        //
        // MEDIDO: Puts dentro de um ConsoleCommand sai pelo RCON com
        // o MESMO Identifier do pedido e com Type=Generic -
        // indistinguivel da resposta -, e sai ANTES dela mesmo
        // estando depois no codigo, porque o arg.ReplyWith so e
        // transmitido quando o comando TERMINA.
        //
        // O agente casa a primeira mensagem nao-diagnostica com o
        // identifier, entao a linha de log chega NO LUGAR da
        // resposta e a chamada morre com PLUGIN_INVALID_RESPONSE -
        // numa acao que funcionou.
        //
        // timer.Once(0f) empurra o log para o frame seguinte, com a
        // resposta ja transmitida. PrintWarning/PrintError nao tem
        // esse problema: saem com Type=Warning/Error e o agente os
        // descarta na correlacao.
        [ConsoleCommand(KillCommand)]
        private void CommandKill(ConsoleSystem.Arg arg)
        {
            try
            {
                string logLine;
                string response = HandleKill(arg, out logLine);

                arg.ReplyWith(response);

                if (logLine != null)
                {
                    string line = logLine;
                    timer.Once(0f, delegate { Puts(line); });
                }
            }
            catch (Exception ex)
            {
                PrintError(KillCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleKill(ConsoleSystem.Arg arg, out string logLine)
        {
            logLine = null;

            BasePlayer player = FindTarget(arg);

            if (player == null)
            {
                return BuildError(arg.Args == null || arg.Args.Length < 1
                    ? ErrorInvalidArgs
                    : ErrorPlayerNotFound);
            }

            bool wasAlive = !player.IsDead();

            if (wasAlive)
            {
                player.Die(null);
                logLine = KillCommand + ": " + player.UserIDString + " (" + player.displayName +
                          ") morreu por pedido do painel.";
            }

            return JsonConvert.SerializeObject(new KillResponse
            {
                SteamId = player.UserIDString,
                WasAlive = wasAlive
            });
        }

        // ========================================================
        //  origemz.player.teleport <steamId> <x> <z> [y]
        //
        //  Move o jogador para um ponto do mundo. Nasceu do mapa do
        //  painel, onde o gesto e arrastar o boneco para onde ele
        //  deve ir.
        //
        //  #### O `y` E OPCIONAL, E O NORMAL E OMITI-LO ####
        //
        //  Quem arrasta no mapa escolhe X e Z -- ALTURA nao existe
        //  num mapa 2D. Sem o terceiro numero, o plugin resolve a
        //  altura pelo terreno; com ele, obedece.
        //
        //  E resolver a altura NAO e detalhe: teleportar para um
        //  (x, z) com o `y` de onde o jogador estava o enterra
        //  dentro da montanha ou o larga a duzentos metros do chao.
        //  Enterrado ele fica preso; no ar, ele cai -- e queda no
        //  Rust tira vida. As duas pontas do erro machucam.
        //
        //  #### A AGUA CONTA COMO CHAO ####
        //
        //  `WaterMap` acima do terreno significa mar, lago ou rio.
        //  Usar o maior dos dois poe o jogador NA SUPERFICIE, e nao
        //  no fundo: cair no fundo do oceano e afogamento imediato,
        //  e ninguem arrastou o boneco para la querendo isso.
        //
        //  #### O QUE ELE NAO SABE ####
        //
        //  Construcoes. O heightmap e do TERRENO, entao um destino
        //  em cima de uma base poe o jogador no chao ABAIXO dela.
        //  Corrigir isso exigiria raycast, e raycast pega telhado,
        //  arvore e pedra -- trocaria um caso raro por um monte de
        //  destinos em cima de galho. Quem quer o telhado manda o
        //  `y` explicito.
        // ========================================================
        // O log adiado um frame pelo mesmo motivo medido no
        // CommandKill: um Puts dentro de um ConsoleCommand sai pelo
        // RCON com o mesmo Identifier da resposta.
        [ConsoleCommand(TeleportCommand)]
        private void CommandTeleport(ConsoleSystem.Arg arg)
        {
            try
            {
                string logLine;
                string response = HandleTeleport(arg, out logLine);

                arg.ReplyWith(response);

                if (logLine != null)
                {
                    string line = logLine;
                    timer.Once(0f, delegate { Puts(line); });
                }
            }
            catch (Exception ex)
            {
                PrintError(TeleportCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleTeleport(ConsoleSystem.Arg arg, out string logLine)
        {
            logLine = null;

            BasePlayer player = FindTarget(arg);

            if (player == null)
            {
                return BuildError(arg.Args == null || arg.Args.Length < 1
                    ? ErrorInvalidArgs
                    : ErrorPlayerNotFound);
            }

            // Tres argumentos no minimo: <steamId> <x> <z>.
            if (arg.Args.Length < 3)
            {
                return BuildError(ErrorInvalidArgs);
            }

            // `GetFloat` e nao float.Parse: o parse manual dependeria
            // da cultura do processo, e num servidor em pt-BR o
            // "-819.5" viraria -8195.
            float x = arg.GetFloat(1, float.NaN);
            float z = arg.GetFloat(2, float.NaN);

            if (float.IsNaN(x) || float.IsNaN(z))
            {
                return BuildError(ErrorInvalidArgs);
            }

            // O mundo e centrado na origem: a borda e metade do lado
            // para cada canto. Fora dele o jogo nao tem terreno, e o
            // jogador cairia para sempre.
            float half = TerrainMeta.Size.x / 2f;

            if (x < -half || x > half || z < -half || z > half)
            {
                return BuildError(ErrorOutsideWorld);
            }

            Vector3 destination = new Vector3(x, 0f, z);
            bool explicitHeight = arg.Args.Length > 3;

            if (explicitHeight)
            {
                float y = arg.GetFloat(3, float.NaN);

                if (float.IsNaN(y))
                {
                    return BuildError(ErrorInvalidArgs);
                }

                destination.y = y;
            }
            else
            {
                float ground = TerrainMeta.HeightMap.GetHeight(destination);
                float water = TerrainMeta.WaterMap.GetHeight(destination);
                float surface = Mathf.Max(ground, water);

                // #### O PISO E O NIVEL DO MAR, E ISSO FOI MEDIDO ####
                //
                // O `WaterMap` cobre rio e lago, e no OCEANO ele nao
                // devolve a superficie: o max entre chao e agua caiu
                // para -4,4 num ponto de mar aberto, e o jogador foi
                // parar no FUNDO -- vivo, afogando, sem nada na tela
                // explicando por que.
                //
                // O oceano do Rust fica em y = 0. Abaixo disso nao ha
                // destino valido para um jogador que nao pediu para
                // mergulhar: o piso poe quem foi solto no mar
                // BOIANDO, que e onde ele estaria se tivesse nadado
                // ate ali.
                if (surface < OceanLevel)
                {
                    surface = OceanLevel;
                }

                destination.y = surface + TeleportGroundClearance;
            }

            // #### A ORDEM AQUI NAO E ARBITRARIA ####
            //
            // Montado num veiculo, mover o jogador o deixa preso ao
            // assento e o veiculo o puxa de volta no tick seguinte;
            // com pai (um elevador, um barco), a posicao e RELATIVA
            // a ele. Os dois precisam sair antes do movimento.
            player.EnsureDismounted();
            player.SetParent(null, true, true);

            // `SetServerFall` desliga a checagem antifraude de
            // movimento durante o salto: sem ele o servidor ve um
            // jogador atravessando o mapa num tick e o trata como
            // trapaca -- puxando-o de volta ou expulsando.
            player.SetServerFall(true);

            try
            {
                player.Teleport(destination);
            }
            finally
            {
                player.SetServerFall(false);
            }

            player.SendNetworkUpdateImmediate();

            logLine = TeleportCommand + ": " + player.UserIDString + " (" + player.displayName +
                      ") movido para " + destination + " por pedido do painel.";

            return JsonConvert.SerializeObject(new TeleportResponse
            {
                SteamId = player.UserIDString,
                Position = new PositionPayload
                {
                    X = destination.x,
                    Y = destination.y,
                    Z = destination.z
                },
                HeightAdjusted = !explicitHeight
            });
        }

        // ========================================================
        //  origemz.player.loadout <steamId>
        //
        //  Aplica o kit AGORA, sem esperar o jogador morrer.
        //
        //  Nao limpa o inventario: isto e o botao "dar o kit" da
        //  ficha, e apagar o que o jogador juntou seria um efeito
        //  que ninguem pediu ao clicar nele. Quem quiser o
        //  comportamento de nascimento mata o jogador antes.
        // ========================================================
        // O log adiado um frame pelo mesmo motivo medido no
        // CommandKill.
        [ConsoleCommand(LoadoutCommand)]
        private void CommandLoadout(ConsoleSystem.Arg arg)
        {
            try
            {
                string logLine;
                string response = HandleLoadout(arg, out logLine);

                arg.ReplyWith(response);

                if (logLine != null)
                {
                    string line = logLine;
                    timer.Once(0f, delegate { Puts(line); });
                }
            }
            catch (Exception ex)
            {
                PrintError(LoadoutCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleLoadout(ConsoleSystem.Arg arg, out string logLine)
        {
            logLine = null;

            BasePlayer player = FindTarget(arg);

            if (player == null)
            {
                return BuildError(arg.Args == null || arg.Args.Length < 1
                    ? ErrorInvalidArgs
                    : ErrorPlayerNotFound);
            }

            LoadoutOutcome outcome = ApplyLoadout(player, false);

            if (outcome.Error != null)
            {
                return BuildError(outcome.Error);
            }

            logLine = LoadoutCommand + " " + player.UserIDString + ": nivel " + outcome.Tier +
                      ", " + outcome.Given + " item(ns) entregue(s) e " + outcome.Skipped +
                      " ignorado(s).";

            return JsonConvert.SerializeObject(new LoadoutResponse
            {
                SteamId = player.UserIDString,
                Tier = outcome.Tier,
                Given = outcome.Given,
                Skipped = outcome.Skipped
            });
        }

        // ========================================================
        //  OS TIMERS - fornalha, craft, pesquisa e reciclador
        //
        //  A aba Configuracoes > Player > Timers do painel. Cada
        //  NIVEL tem quatro multiplicadores de VELOCIDADE: x2 e duas
        //  vezes mais rapido, metade do tempo. x1 e o jogo.
        //
        //  #### DE ONDE VEM ####
        //
        //  Do OrigemZAgent, pelo GetTimers(tier), no mesmo caminho do
        //  kit e do status: o RustAgent empurra origemz.timers.sync, o
        //  hub guarda, este plugin pergunta.
        //
        //  #### QUAL NIVEL VALE, CAMPO A CAMPO ####
        //
        //  admin (so para quem tem auth level) > VIP > normal, e o
        //  primeiro que DEFINE aquele timer ganha. Nivel que deixa o
        //  campo em branco cai para o de baixo - e so no fim de tudo
        //  para o x1.
        //
        //  Nao e o que o kit faz (la o nivel troca o kit inteiro), e e
        //  de proposito: sem cair para o de baixo, um servidor com
        //  "normal: craft x2" e "gold: fornalha x3" deixaria o VIP
        //  gold craftando MAIS DEVAGAR que o jogador comum - e ninguem
        //  configura isso querendo.
        //
        //  #### O QUE CADA UM TOCA ####
        //
        //   fornalha    fornalha, fornalha grande, eletrica e
        //               refinaria - as que fundem ou refinam. Vale o
        //               MELHOR entre o dono e quem a acendeu.
        //   craft       a fila de fabricacao do jogador.
        //   pesquisa    a mesa de pesquisa, por quem apertou o botao.
        //   reciclador  por quem o ligou.
        //
        //  #### POR QUE NAO REESCREVER O FORNO, COMO O QUICKSMELT ####
        //
        //  O QuickSmelt trocava o laco de cozimento do jogo por uma
        //  copia dele. No Rust de setembro de 2026 o
        //  CanBeCookedByAtTemperature mora no CookableItemInfo, e nao
        //  mais no ItemModCookable - a copia deixou de compilar e a
        //  fornalha do servidor voltou ao x1.
        //
        //  Aqui o forno continua sendo o do jogo: o que muda e QUANTAS
        //  VEZES o Cook() do proprio jogo roda. A proxima mudanca da
        //  Facepunch no forno vem junto, de graca.
        //
        //  #### NUNCA MAIS DEVAGAR QUE O JOGO ####
        //
        //  O minimo e x1: desacelerar a fornalha exigiria CANCELAR
        //  ciclos do jogo, e ninguem pediu isso. O teto e x20, e o
        //  RustAgent recusa o que passa dele antes de chegar aqui -
        //  a trava deste lado e para o comando digitado a mao.
        // ========================================================
        private const float MinTimerSpeed = 1f;
        private const float MaxTimerSpeed = 20f;

        // De quanto em quanto tempo uma fornalha acesa refaz a conta
        // da velocidade. E o que faz o VIP comprado no meio da
        // fundicao valer sem ninguem apagar e acender.
        private const float OvenRecheckSeconds = 30f;

        // Teto de Cook() extras por fornalha a cada tique. Ver
        // CookExtra.
        private const int MaxExtraCookSteps = 8;

        // Os patches do craft sao estaticos (Harmony) e chegam ao
        // plugin por aqui. null = plugin descarregado.
        private static OrigemZPlayer _instance;

        // O ItemCrafter que esta rodando o ServerUpdate AGORA. Ver
        // CraftQueuePatch.
        private static ItemCrafter _craftingNow;

        // O RecycleThink do jogo, que e privado. Ver
        // ResolveRecycleThink.
        private static System.Reflection.MethodInfo _recycleThinkMethod;

        // Toda fornalha ACESA que funde ou refina, pela id de rede.
        private readonly Dictionary<ulong, TrackedOven> _trackedOvens =
            new Dictionary<ulong, TrackedOven>();

        private readonly List<TrackedOven> _ovenSnapshot = new List<TrackedOven>();

        // Quem apertou "ligar" na fornalha, entre o OnOvenToggle e o
        // OnOvenStarted - os dois acontecem na mesma chamada do jogo.
        private BaseOven _pendingToggleOven;
        private ulong _pendingToggleBy;

        // A duracao ORIGINAL das mesas de pesquisa que estao com o
        // tempo mexido. Ver OnItemResearch.
        private readonly Dictionary<ulong, ResearchOriginal> _researchOriginals =
            new Dictionary<ulong, ResearchOriginal>();

        // Os recicladores rodando acelerados, para o Unload devolver.
        private readonly Dictionary<ulong, Recycler> _spedUpRecyclers =
            new Dictionary<ulong, Recycler>();

        // O JSON que o hub devolve, ja lido. A chave e o proprio
        // texto: mudou o texto, mudou a entrada - sem precisar de
        // aviso de que o cache do hub foi trocado.
        private readonly Dictionary<string, TimersEntry> _timersParsed =
            new Dictionary<string, TimersEntry>(StringComparer.Ordinal);

        private bool _warnedCraftFailure;

        private void StartTimers()
        {
            timer.Every(BaseOven.UpdateRate, SmeltTick);

            // Fornalha que ja estava acesa quando o plugin subiu nao
            // passa pelo OnOvenStarted: o reload do plugin, e o boot
            // do servidor, que reacende as fornalhas ANTES de os
            // plugins carregarem.
            int tracked = 0;

            foreach (BaseNetworkable entity in BaseNetworkable.serverEntities)
            {
                BaseOven oven = entity as BaseOven;

                if (oven == null || !oven.IsOn() || !IsTimedOven(oven))
                {
                    continue;
                }

                TrackOven(oven, 0UL);
                tracked++;
            }

            Puts("Timers ligados: " + tracked + " fornalha(s) acesa(s) agora." +
                 (_recycleThinkMethod == null
                     ? " O reciclador fica no x1 - ver o erro do Init."
                     : ""));
        }

        // Os quatro timers de um jogador, ja resolvidos. Ver QUAL
        // NIVEL VALE, no cabecalho da secao.
        //
        // `player` pode ser null - o dono offline de uma fornalha.
        // Sem conexao nao ha auth level para ler, e o nivel admin
        // fica de fora; o VIP e o normal continuam valendo, porque
        // vem do cache do agente, por SteamID.
        private TimerSpeeds TimersOf(ulong userId, BasePlayer player)
        {
            if (OrigemZAgent == null)
            {
                return TimerSpeeds.Vanilla;
            }

            TimersEntry admin = player != null && IsStaff(player) ? ReadTimers(TierAdmin) : null;
            TimersEntry vip = null;

            if (userId != 0UL)
            {
                string tier = OrigemZAgent.Call(HookGetVipTier, userId.ToString()) as string;

                if (!string.IsNullOrEmpty(tier))
                {
                    vip = ReadTimers(tier.Trim().ToLowerInvariant());
                }
            }

            return TimerSpeeds.Resolve(admin, vip, ReadTimers(TierNormal));
        }

        // Os timers de UM nivel, como o hub os guarda, ou null quando
        // o nivel nao tem nenhum.
        private TimersEntry ReadTimers(string tier)
        {
            // Regra 2 do cabecalho: [PluginReference] vira null quando
            // o alvo e descarregado, e o TimersOf pode ter passado por
            // aqui antes disso.
            if (OrigemZAgent == null)
            {
                return null;
            }

            string json = OrigemZAgent.Call(HookGetTimers, tier) as string;

            if (string.IsNullOrEmpty(json))
            {
                return null;
            }

            TimersEntry entry;

            if (_timersParsed.TryGetValue(json, out entry))
            {
                return entry;
            }

            try
            {
                entry = JsonConvert.DeserializeObject<TimersEntry>(json);
            }
            catch (Exception ex)
            {
                PrintError("GetTimers devolveu JSON ilegivel para o nivel '" + tier + "': " +
                           ex.Message);
                entry = null;
            }

            // Um texto por nivel, e ele so muda quando o admin grava. O
            // teto existe para uma sequencia de gravacoes nao fazer o
            // dicionario crescer para sempre.
            if (_timersParsed.Count >= 64)
            {
                _timersParsed.Clear();
            }

            _timersParsed[json] = entry;
            return entry;
        }

        // Mesma regra do ResolveTier: o admin sai do auth level do
        // Rust, e nao de grupo nosso.
        private static bool IsStaff(BasePlayer player)
        {
            return player.net != null && player.net.connection != null &&
                   player.net.connection.authLevel > 0;
        }

        // ========================================================
        //  A FORNALHA
        //
        //  #### O TIQUE ####
        //
        //  O jogo cozinha cada fornalha acesa numa fila de trabalho,
        //  em passos de BaseOven.UpdateRate (0,5 s): cada passo e um
        //  Cook(0.5f), que queima combustivel, avanca o cozimento e
        //  solta carvao. Este plugin roda o MESMO Cook(), no mesmo
        //  ritmo, com (x - 1) vezes o passo do jogo. x3 = o jogo anda
        //  meio segundo, nos andamos mais um.
        //
        //  Por isso o combustivel por minerio e o do jogo: a lenha
        //  queima tres vezes mais rapido junto com o minerio. A
        //  fornalha x3 e o tempo andando tres vezes mais rapido dentro
        //  dela, e nao uma fornalha que tambem economiza lenha.
        //
        //  #### DE QUEM E A VELOCIDADE ####
        //
        //  A melhor entre a do DONO (quem a colocou) e a de quem a
        //  ACENDEU. A fornalha do VIP e rapida para o time inteiro, e
        //  o VIP que acende a fornalha de um amigo tambem leva a dele.
        //  E a regra do QuickSmelt ("dono OU quem liga"), com nivel no
        //  lugar de permissao.
        //
        //  Fornalha que acende sozinha (energia, reinicio do
        //  servidor) so tem dono. E a conta e REFEITA a cada
        //  OvenRecheckSeconds.
        // ========================================================
        private void OnOvenToggle(BaseOven oven, BasePlayer player)
        {
            try
            {
                // Acesa = o pedido e para apagar, e apagar nao precisa
                // de nada nosso.
                if (!_ready || oven == null || player == null || oven.IsOn())
                {
                    return;
                }

                // So ANOTA. Quem decide se acende e o jogo, logo em
                // seguida (tranca, privilegio de construcao,
                // combustivel) - e quem confirma e o OnOvenStarted.
                _pendingToggleOven = oven;
                _pendingToggleBy = player.userID;

                // Se o jogo recusar, a anotacao nao pode sobrar para a
                // proxima fornalha que acender sozinha.
                NextTick(ClearPendingToggle);
            }
            catch (Exception ex)
            {
                PrintError("OnOvenToggle falhou: " + ex);
            }
        }

        private void ClearPendingToggle()
        {
            _pendingToggleOven = null;
            _pendingToggleBy = 0UL;
        }

        private void OnOvenStarted(BaseOven oven)
        {
            try
            {
                ulong litBy = _pendingToggleOven != null && _pendingToggleOven == oven
                    ? _pendingToggleBy
                    : 0UL;

                ClearPendingToggle();

                if (!_ready || !IsTimedOven(oven))
                {
                    return;
                }

                TrackOven(oven, litBy);
            }
            catch (Exception ex)
            {
                PrintError("OnOvenStarted falhou: " + ex);
            }
        }

        // As que FUNDEM ou REFINAM. Fogueira, churrasqueira e barril
        // (cozinhar e aquecer) ficam de fora - e a lanterna
        // principalmente: acelerar a lanterna seria so queimar o oleo
        // do jogador mais rapido.
        private static bool IsTimedOven(BaseOven oven)
        {
            if (oven == null || oven is BaseFuelLightSource)
            {
                return false;
            }

            return oven.temperature == BaseOven.TemperatureType.Smelting ||
                   oven.temperature == BaseOven.TemperatureType.Fractioning;
        }

        private void TrackOven(BaseOven oven, ulong litBy)
        {
            if (oven.net == null)
            {
                return;
            }

            TrackedOven tracked = new TrackedOven();
            tracked.Key = oven.net.ID.Value;
            tracked.Oven = oven;
            tracked.LitBy = litBy;
            tracked.Speed = SmeltSpeedOf(oven, litBy);
            tracked.CheckedAt = Time.realtimeSinceStartup;

            // TODA fornalha acesa entra, inclusive a de x1: e a reconta
            // periodica que a promove quando o dono vira VIP.
            _trackedOvens[tracked.Key] = tracked;
        }

        private float SmeltSpeedOf(BaseOven oven, ulong litBy)
        {
            ulong owner = oven.OwnerID;

            // Dono 0 e fornalha do mundo: fica com o nivel normal, que
            // e o "servidor inteiro x2" de quem configurar assim.
            float speed = TimersOf(owner, owner == 0UL ? null : BasePlayer.FindByID(owner)).Smelt;

            if (litBy != 0UL && litBy != owner)
            {
                speed = Mathf.Max(speed, TimersOf(litBy, BasePlayer.FindByID(litBy)).Smelt);
            }

            return speed;
        }

        private void SmeltTick()
        {
            if (_trackedOvens.Count == 0)
            {
                return;
            }

            float now = Time.realtimeSinceStartup;

            // Uma COPIA: o Cook() chama hooks de outros plugins, e um
            // deles acendendo outra fornalha poria uma entrada nova no
            // dicionario no meio do laco.
            _ovenSnapshot.Clear();
            _ovenSnapshot.AddRange(_trackedOvens.Values);

            for (int i = 0; i < _ovenSnapshot.Count; i++)
            {
                TrackedOven tracked = _ovenSnapshot[i];
                BaseOven oven = tracked.Oven;

                if (oven == null || oven.IsDestroyed || !oven.IsOn())
                {
                    _trackedOvens.Remove(tracked.Key);
                    continue;
                }

                try
                {
                    if (now - tracked.CheckedAt >= OvenRecheckSeconds)
                    {
                        tracked.Speed = SmeltSpeedOf(oven, tracked.LitBy);
                        tracked.CheckedAt = now;
                    }

                    if (tracked.Speed > MinTimerSpeed)
                    {
                        CookExtra(oven, tracked.Speed);
                    }
                }
                catch (Exception ex)
                {
                    // A fornalha com problema sai da aceleracao, e so
                    // ela: volta ao x1 do jogo, que e o que ela seria
                    // sem este plugin.
                    _trackedOvens.Remove(tracked.Key);
                    PrintError("A fornalha " + tracked.Key + " voltou ao x1 depois de um erro: " + ex);
                }
            }

            _ovenSnapshot.Clear();
        }

        // (x - 1) passos a mais, do tamanho do passo do jogo.
        //
        // #### O TETO DE PASSOS ####
        //
        // Ate x9, cada passo extra e EXATAMENTE o do jogo. Acima
        // disso os passos crescem em vez de se multiplicarem - no
        // maximo MaxExtraCookSteps Cook() extras por fornalha a cada
        // meio segundo -, e e o que segura o custo num servidor
        // cheio de fornalhas.
        //
        // O preco fica no combustivel, e so acima de x9: o jogo troca
        // a lenha no maximo uma vez por Cook(), entao um passo maior
        // que o do jogo pode queimar a sobra de uma lenha que ele
        // mesmo jogaria fora - e o combustivel por minerio fica um
        // pouco MENOR que o do jogo.
        private static void CookExtra(BaseOven oven, float speed)
        {
            float extra = BaseOven.UpdateRate * (speed - 1f);
            int steps = Mathf.Clamp(Mathf.CeilToInt(extra / BaseOven.UpdateRate), 1, MaxExtraCookSteps);
            float step = extra / steps;

            for (int i = 0; i < steps; i++)
            {
                // O Cook() apaga a fornalha quando acaba o combustivel
                // ou a saida enche. Apagada, o resto dos passos nao tem
                // o que fazer.
                if (!oven.IsOn())
                {
                    return;
                }

                oven.Cook(step);
            }
        }

        // ========================================================
        //  O CRAFT
        //
        //  #### POR QUE HARMONY, E NAO UM HOOK ####
        //
        //  Nao existe hook no ponto que importa. O ItemCrafter decide
        //  a duracao de cada unidade dentro do ServerUpdate, quando a
        //  tarefa chega a frente da fila: chama o GetScaledDuration,
        //  aplica o bonus da bancada, grava o endTime e manda ao
        //  cliente o note.craft_start COM a duracao. O OnItemCraft
        //  chega antes disso tudo, com o endTime ainda em zero.
        //
        //  Encurtar o endTime depois deixaria a barra do cliente
        //  andando no tempo antigo - o item ficaria pronto com a barra
        //  pela metade. O unico jeito de o cliente ver o tempo certo e
        //  a duracao JA SAIR certa do GetScaledDuration.
        //
        //  #### OS DOIS PATCHES ####
        //
        //  O GetScaledDuration e estatico e nao sabe de QUEM e o
        //  craft. Entao o ServerUpdate anota o ItemCrafter que esta
        //  rodando (CraftQueuePatch), e a duracao e dividida pela
        //  velocidade do dono dele (CraftDurationPatch). O
        //  GetScaledDuration tem esse unico chamador no Assembly-CSharp
        //  inteiro - conferido em 11/09/2026 -, entao a anotacao nao
        //  vaza para outro lugar.
        //
        //  O Oxide aplica os dois pelo [AutoPatch], logo depois do
        //  Init, e os desfaz ao descarregar o plugin. Patch que nao
        //  acha o metodo (update da Facepunch) vira erro no log do
        //  Oxide e o craft fica no x1 - nada mais para.
        // ========================================================
        [AutoPatch]
        [HarmonyLib.HarmonyPatch(typeof(ItemCrafter), "ServerUpdate", new Type[] { typeof(float) })]
        private static class CraftQueuePatch
        {
            private static void Prefix(ItemCrafter __instance)
            {
                _craftingNow = __instance;
            }

            private static void Postfix()
            {
                _craftingNow = null;
            }
        }

        [AutoPatch]
        [HarmonyLib.HarmonyPatch(typeof(ItemCrafter), "GetScaledDuration",
            new Type[] { typeof(ItemBlueprint), typeof(float), typeof(bool) })]
        private static class CraftDurationPatch
        {
            private static void Postfix(ref float __result)
            {
                ItemCrafter crafter = _craftingNow;
                OrigemZPlayer plugin = _instance;

                if (crafter == null || plugin == null)
                {
                    return;
                }

                __result = plugin.ScaleCraftDuration(crafter, __result);
            }
        }

        // NUNCA lanca: roda dentro do ServerUpdate do jogo, e uma
        // excecao aqui travaria a fila de craft do jogador.
        private float ScaleCraftDuration(ItemCrafter crafter, float duration)
        {
            try
            {
                BasePlayer owner = crafter.owner;

                if (!_ready || owner == null || owner.IsNpc)
                {
                    return duration;
                }

                float speed = TimersOf(owner.userID, owner).Craft;

                return speed > MinTimerSpeed ? duration / speed : duration;
            }
            catch (Exception ex)
            {
                if (!_warnedCraftFailure)
                {
                    _warnedCraftFailure = true;
                    PrintError("A aceleracao do craft falhou; o craft segue no tempo do jogo: " + ex);
                }

                return duration;
            }
        }

        // ========================================================
        //  A PESQUISA
        //
        //  O jogo chama o OnItemResearch e SO DEPOIS le o
        //  researchDuration da mesa, para marcar o fim e agendar o
        //  resultado - conferido no Assembly-CSharp de 11/09/2026.
        //  Basta ajustar o campo aqui: o relogio que o cliente mostra
        //  sai do mesmo numero e fica certo sozinho.
        //
        //  O campo e da MESA, e nao do jogador. Por isso o valor
        //  original fica guardado e volta quando quem pesquisa em
        //  seguida e x1 - e no Unload.
        // ========================================================
        private void OnItemResearch(ResearchTable table, Item item, BasePlayer player)
        {
            try
            {
                if (!_ready || table == null || table.net == null || player == null)
                {
                    return;
                }

                ulong key = table.net.ID.Value;
                float speed = TimersOf(player.userID, player).Research;

                ResearchOriginal original;
                bool touched = _researchOriginals.TryGetValue(key, out original);

                if (speed <= MinTimerSpeed)
                {
                    if (touched)
                    {
                        table.researchDuration = original.Duration;
                        _researchOriginals.Remove(key);
                    }

                    return;
                }

                if (!touched)
                {
                    PruneResearchOriginals();

                    original = new ResearchOriginal();
                    original.Table = table;
                    original.Duration = table.researchDuration;
                    _researchOriginals[key] = original;
                }

                table.researchDuration = original.Duration / speed;
            }
            catch (Exception ex)
            {
                PrintError("OnItemResearch falhou: " + ex);
            }
        }

        // Mesa destruida some da lista. So roda quando entra mesa
        // nova, e a lista so tem as mesas com o tempo mexido agora.
        private void PruneResearchOriginals()
        {
            List<ulong> gone = null;

            foreach (KeyValuePair<ulong, ResearchOriginal> pair in _researchOriginals)
            {
                if (pair.Value.Table == null)
                {
                    if (gone == null)
                    {
                        gone = new List<ulong>();
                    }

                    gone.Add(pair.Key);
                }
            }

            if (gone == null)
            {
                return;
            }

            for (int i = 0; i < gone.Count; i++)
            {
                _researchOriginals.Remove(gone[i]);
            }
        }

        private void RestoreResearchTables()
        {
            foreach (ResearchOriginal original in _researchOriginals.Values)
            {
                if (original.Table != null)
                {
                    original.Table.researchDuration = original.Duration;
                }
            }

            _researchOriginals.Clear();
        }

        // ========================================================
        //  O RECICLADOR
        //
        //  O jogo liga o reciclador com um InvokeRepeating do
        //  RecycleThink, no intervalo que o RecyclerConfig da para
        //  aquele tipo de reciclador. O OnRecyclerToggle chega ANTES
        //  de ligar, entao a troca e no quadro seguinte: cancelar o
        //  agendamento do jogo e agendar o mesmo metodo, mais curto.
        //
        //  #### O RecycleThink E PRIVADO ####
        //
        //  Por isso o delegate sai por reflexao, como no
        //  OrigemZLootRefresh. E ele e o MESMO para o jogo: o
        //  InvokeHandler compara delegate por alvo e metodo, entao o
        //  StopRecycling do proprio jogo cancela o nosso agendamento
        //  sem saber que ele e nosso.
        //
        //  Se a Facepunch renomear o metodo, a reflexao volta null, o
        //  Init avisa, e o reciclador fica no x1 - os outros tres
        //  timers seguem funcionando.
        // ========================================================
        private void ResolveRecycleThink()
        {
            try
            {
                _recycleThinkMethod = typeof(Recycler).GetMethod(
                    "RecycleThink",
                    System.Reflection.BindingFlags.Instance |
                    System.Reflection.BindingFlags.Public |
                    System.Reflection.BindingFlags.NonPublic,
                    null, Type.EmptyTypes, null);
            }
            catch (Exception ex)
            {
                _recycleThinkMethod = null;
                PrintError("Nao consegui procurar o Recycler.RecycleThink: " + ex.Message);
            }

            if (_recycleThinkMethod == null)
            {
                PrintError("O Recycler.RecycleThink nao existe neste Rust (update da Facepunch?). " +
                           "O reciclador fica no x1; fornalha, craft e pesquisa seguem valendo.");
            }
        }

        private static Action RecycleThinkOf(Recycler recycler)
        {
            if (_recycleThinkMethod == null)
            {
                return null;
            }

            return Delegate.CreateDelegate(typeof(Action), recycler, _recycleThinkMethod, false) as Action;
        }

        private void OnRecyclerToggle(Recycler recycler, BasePlayer player)
        {
            try
            {
                // Ligado = o pedido e para desligar.
                if (!_ready || recycler == null || player == null || recycler.IsOn() ||
                    _recycleThinkMethod == null)
                {
                    return;
                }

                float speed = TimersOf(player.userID, player).Recycle;

                if (speed <= MinTimerSpeed)
                {
                    return;
                }

                NextTick(delegate { SpeedUpRecycler(recycler, speed); });
            }
            catch (Exception ex)
            {
                PrintError("OnRecyclerToggle falhou: " + ex);
            }
        }

        private void SpeedUpRecycler(Recycler recycler, float speed)
        {
            try
            {
                // O jogo pode ter recusado ligar (sem energia, sem nada
                // reciclavel, outro jogador no reciclador).
                if (recycler == null || recycler.IsDestroyed || !recycler.IsOn() ||
                    recycler.net == null)
                {
                    return;
                }

                Action think = RecycleThinkOf(recycler);

                if (think == null)
                {
                    return;
                }

                float efficiency;
                float duration;
                recycler.GetRecyclerStats(out efficiency, out duration);

                if (duration <= 0f)
                {
                    return;
                }

                float interval = duration / speed;

                recycler.CancelInvoke(think);
                recycler.InvokeRepeating(think, interval, interval);

                PruneRecyclers();
                _spedUpRecyclers[recycler.net.ID.Value] = recycler;
            }
            catch (Exception ex)
            {
                PrintError("Nao consegui acelerar o reciclador: " + ex);
            }
        }

        private void PruneRecyclers()
        {
            List<ulong> gone = null;

            foreach (KeyValuePair<ulong, Recycler> pair in _spedUpRecyclers)
            {
                if (pair.Value == null || !pair.Value.IsOn())
                {
                    if (gone == null)
                    {
                        gone = new List<ulong>();
                    }

                    gone.Add(pair.Key);
                }
            }

            if (gone == null)
            {
                return;
            }

            for (int i = 0; i < gone.Count; i++)
            {
                _spedUpRecyclers.Remove(gone[i]);
            }
        }

        // O reciclador que ainda roda acelerado volta ao intervalo do
        // jogo: sem isto ele seguiria rapido ate esvaziar, com o
        // plugin ja fora do ar.
        private void RestoreRecyclers()
        {
            foreach (Recycler recycler in _spedUpRecyclers.Values)
            {
                if (recycler == null || recycler.IsDestroyed || !recycler.IsOn())
                {
                    continue;
                }

                Action think = RecycleThinkOf(recycler);

                if (think == null)
                {
                    continue;
                }

                float efficiency;
                float duration;
                recycler.GetRecyclerStats(out efficiency, out duration);

                if (duration <= 0f)
                {
                    continue;
                }

                recycler.CancelInvoke(think);
                recycler.InvokeRepeating(think, duration, duration);
            }

            _spedUpRecyclers.Clear();
        }

        // ========================================================
        //  AGENTE
        // ========================================================
        private void LogAgentApiVersion()
        {
            if (OrigemZAgent == null)
            {
                PrintError("OrigemZAgent nao esta carregado - sem ele nao ha nivel nem kit, " +
                           "e o jogador nasce sem nada (os itens de fabrica ja foram removidos).");
                return;
            }

            object raw = OrigemZAgent.Call(HookGetApiVersion);

            if (!(raw is int))
            {
                PrintError("GetApiVersion do agente devolveu " + (raw == null ? "null" : raw.ToString()) +
                           ", que nao e um inteiro. O contrato de hook pode ter mudado.");
                return;
            }

            int version = (int)raw;
            Puts("API do agente: v" + version + " (este plugin foi escrito para a v" +
                 ExpectedAgentApiVersion + ").");

            if (version != ExpectedAgentApiVersion)
            {
                PrintWarning("Versao de contrato diferente da esperada. Confira " +
                             "Docs\\OrigemZAgent\\HOOKS.md antes de confiar no resultado.");
            }
        }

        // ========================================================
        //  CONFIG
        // ========================================================
        protected override void LoadDefaultConfig()
        {
            _config = PluginConfig.Default();
            PrintWarning("Config novo criado com os padroes.");
        }

        protected override void LoadConfig()
        {
            base.LoadConfig();

            try
            {
                _config = Config.ReadObject<PluginConfig>();
            }
            catch (Exception ex)
            {
                PrintError("Config ilegivel, usando os padroes SEM gravar por cima. " +
                           "Conserte Server\\oxide\\config\\OrigemZPlayer.json: " + ex.Message);
                _config = PluginConfig.Default();
                return;
            }

            if (_config == null)
            {
                LoadDefaultConfig();
            }

            SaveConfig();
        }

        protected override void SaveConfig()
        {
            Config.WriteObject(_config, true);
        }

        // ========================================================
        //  LANG
        //
        //  \uXXXX em vez de acento direto: o arquivo fonte viaja
        //  para Server\oxide\plugins e e recompilado la, e byte
        //  acentuado dependeria de os dois lados concordarem sobre
        //  a codificacao. O jogador nunca ve o escape - o Oxide
        //  grava o lang ja com o caractere certo.
        // ========================================================
        protected override void LoadDefaultMessages()
        {
            lang.RegisterMessages(new Dictionary<string, string>
            {
                { MsgKitGiven, "You received your kit ({0} items)." },
                { MsgKitPartial, "You received {0} item(s); {1} did not fit." },
                { MsgKitEmpty, "There is no kit set for your tier." }
            }, this);

            lang.RegisterMessages(new Dictionary<string, string>
            {
                // Rende: Voce recebeu seu kit ({0} itens).
                { MsgKitGiven, "Voc\u00ea recebeu seu kit ({0} itens)." },
                // Rende: Voce recebeu {0} item(ns); {1} nao coube(ram).
                { MsgKitPartial, "Voc\u00ea recebeu {0} item(ns); {1} n\u00e3o coube(ram)." },
                // Rende: Nao ha kit configurado para o seu nivel.
                { MsgKitEmpty, "N\u00e3o h\u00e1 kit configurado para o seu n\u00edvel." }
            }, this, "pt-BR");
        }

        private string Msg(string key, string userId)
        {
            return lang.GetMessage(key, this, userId);
        }

        // ========================================================
        //  AUXILIARES
        // ========================================================

        // O jogador do primeiro argumento. null quando falta o
        // argumento, quando ele nao e SteamID64 ou quando o jogador
        // nao esta online.
        //
        // NAO indexe arg.Args diretamente: no Rust atual ele e
        // Facepunch.StringView[], que nao converte para string.
        private static BasePlayer FindTarget(ConsoleSystem.Arg arg)
        {
            if (arg.Args == null || arg.Args.Length < 1)
            {
                return null;
            }

            string steamId = arg.GetString(0, "").Trim();

            if (!IsSteamId64(steamId))
            {
                return null;
            }

            ulong userId;

            if (!ulong.TryParse(steamId, out userId))
            {
                return null;
            }

            BasePlayer player = BasePlayer.FindByID(userId);

            // Sleeper e jogador online: ele tem BasePlayer e
            // inventario, e o admin costuma querer justamente
            // mexer em quem dormiu no servidor.
            if (player == null)
            {
                player = BasePlayer.FindSleeping(userId);
            }

            return player;
        }

        // Skin vem como string porque passa de 2^53 no JSON. Valor
        // ilegivel vira 0 (sem skin), que e o lado seguro: um item
        // sem skin e melhor do que item nenhum.
        private static ulong ParseSkin(string raw)
        {
            if (string.IsNullOrEmpty(raw))
            {
                return 0UL;
            }

            ulong skin;
            return ulong.TryParse(raw.Trim(), out skin) ? skin : 0UL;
        }

        // 17 digitos ASCII, mesma regra do OrigemZAgent.
        private static bool IsSteamId64(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length != SteamId64Length)
            {
                return false;
            }

            for (int i = 0; i < value.Length; i++)
            {
                if (value[i] < '0' || value[i] > '9')
                {
                    return false;
                }
            }

            return true;
        }

        private static string BuildError(string code)
        {
            return JsonConvert.SerializeObject(new ErrorResponse { Error = code });
        }

        // --------------------------------------------------------
        //  O desfecho de uma aplicacao de kit.
        //
        //  Error != null significa que NADA foi aplicado.
        // --------------------------------------------------------
        private class LoadoutOutcome
        {
            public string Error { get; set; }

            public string Tier { get; set; }

            public int Given { get; set; }

            /** O que nao coube ou o jogo nao reconheceu. */
            public int Skipped { get; set; }

            public static LoadoutOutcome Failure(string code)
            {
                return new LoadoutOutcome { Error = code };
            }

            public static LoadoutOutcome Applied(string tier, int given, int skipped)
            {
                return new LoadoutOutcome { Tier = tier, Given = given, Skipped = skipped };
            }
        }

        // --------------------------------------------------------
        //  CONFIG
        //
        //  Chaves em portugues porque quem edita este arquivo e o
        //  admin do servidor. O CONTEUDO dos kits nao esta aqui:
        //  ele mora no banco do RustAgent e e editado no painel,
        //  porque muda com a promocao e precisa de historico.
        // --------------------------------------------------------
        // #### POR QUE CADA PROPRIEDADE TEM INICIALIZADOR ####
        //
        // MEDIDO neste servidor, e custou um jogador nascendo sem
        // nada: quando o plugin ganha uma chave NOVA, o arquivo de
        // config que ja existe nao a tem. O Newtonsoft entao deixa
        // o default do TIPO (false, 0), e nao o do Default() - e o
        // SaveConfig logo em seguida GRAVA esse false no arquivo.
        //
        // O sintoma e traicoeiro: o config ganha a chave nova com
        // o valor errado e parece que alguem a desligou de
        // proposito. Foi o que aconteceu com EnviarEventosDeSessao.
        //
        // Com inicializador, a chave ausente mantem o padrao. O
        // Default() abaixo continua existindo para o arquivo
        // nascer completo e legivel na primeira carga.
        private class PluginConfig
        {
            [JsonProperty("RemoverItensPadraoDoJogo")]
            public bool RemoverItensPadraoDoJogo { get; set; } = true;

            [JsonProperty("AplicarKitAoNascer")]
            public bool AplicarKitAoNascer { get; set; } = true;

            [JsonProperty("LimparInventarioAoNascer")]
            public bool LimparInventarioAoNascer { get; set; } = true;

            [JsonProperty("AdminTemKitProprio")]
            public bool AdminTemKitProprio { get; set; } = true;

            [JsonProperty("SegundosAntesDeAplicarOKit")]
            public float SegundosAntesDeAplicarOKit { get; set; } = 0.5f;

            [JsonProperty("SegundosMinimosEntreKits")]
            public float SegundosMinimosEntreKits { get; set; } = 3f;

            [JsonProperty("AvisarNoChat")]
            public bool AvisarNoChat { get; set; } = true;

            [JsonProperty("EnviarEventosDeSessao")]
            public bool EnviarEventosDeSessao { get; set; } = true;

            public static PluginConfig Default()
            {
                PluginConfig config = new PluginConfig();

                // O par que faz o sistema fazer sentido: sem tirar
                // os itens de fabrica, o kit `normal` vira tocha +
                // pedra + kit. O contrario nao da mais em jogador
                // pelado - o OnDefaultItemsReceive so tira a tocha
                // quando ha kit E o kit ao nascer esta ligado -, mas
                // ligar os dois continua sendo a config coerente.
                config.RemoverItensPadraoDoJogo = true;
                config.AplicarKitAoNascer = true;

                config.LimparInventarioAoNascer = true;
                config.AdminTemKitProprio = true;

                // Meio segundo. O jogo ainda esta montando o
                // inventario no instante do respawn, e escrever
                // junto faz o item aparecer e sumir. Nao e um
                // numero medido - e o menor valor que se mostrou
                // estavel em plugins de kit conhecidos.
                config.SegundosAntesDeAplicarOKit = 0.5f;

                // Trava contra o kit dobrado: o respawn pode
                // disparar mais de uma vez para o mesmo
                // nascimento.
                config.SegundosMinimosEntreKits = 3f;

                config.AvisarNoChat = true;

                // Entrada, saida e morte viram linha no console
                // para o RustAgent gravar. Desligar cega a base de
                // jogadores do painel: ela volta a depender so das
                // avistagens, que nao enxergam sessao nem morte.
                config.EnviarEventosDeSessao = true;

                return config;
            }
        }

        // --------------------------------------------------------
        //  DTOs
        //
        //  Cada campo com [JsonProperty] no nome exato: sem isso o
        //  Newtonsoft usaria PascalCase e o agente nao reconheceria
        //  nada.
        // --------------------------------------------------------

        // O que CHEGA do agente, pelo GetLoadout.
        private class LoadoutItem
        {
            [JsonProperty("slot")]
            public string Slot { get; set; }

            [JsonProperty("shortname")]
            public string Shortname { get; set; }

            [JsonProperty("amount")]
            public int Amount { get; set; }

            [JsonProperty("skinId")]
            public string SkinId { get; set; }

            [JsonProperty("position")]
            public int Position { get; set; }
        }

        // Vida, fome e sede AO NASCER, como o agente as manda.
        //
        // float? e nao float: null quer dizer "o jogo decide este
        // atributo", e e diferente de zero (que para fome e sede e
        // nascer morrendo). Um float sem nullable transformaria os
        // dois casos em 0 na desserializacao - e todo jogador
        // nasceria com fome num nivel que so configurou vida.
        private class SpawnStatus
        {
            [JsonProperty("health")]
            public float? Health { get; set; }

            [JsonProperty("calories")]
            public float? Calories { get; set; }

            [JsonProperty("hydration")]
            public float? Hydration { get; set; }

            // O TETO da faixa. Ausente quer dizer que o valor acima e
            // exato - foi assim que o payload sempre veio, e um
            // config antigo continua valendo sem nenhum ajuste.
            //
            // Com os dois, o numero e SORTEADO a cada nascimento. Ver
            // Sortear() e o cabecalho de AplicarStatus.
            [JsonProperty("healthMax")]
            public float? HealthMax { get; set; }

            [JsonProperty("caloriesMax")]
            public float? CaloriesMax { get; set; }

            [JsonProperty("hydrationMax")]
            public float? HydrationMax { get; set; }
        }

        // Os timers de UM nivel, como o agente os manda.
        //
        // float? e nao float, e pelo mesmo motivo do SpawnStatus:
        // ausente quer dizer "este nivel nao decide este timer", e o
        // jogador cai para o nivel de baixo. Um float sem nullable
        // viraria 0 - e 0 aqui nao e x1, e parar o tempo.
        private class TimersEntry
        {
            [JsonProperty("smelt")]
            public float? Smelt { get; set; }

            [JsonProperty("craft")]
            public float? Craft { get; set; }

            [JsonProperty("research")]
            public float? Research { get; set; }

            [JsonProperty("recycle")]
            public float? Recycle { get; set; }
        }

        // Os quatro timers de UM jogador, ja resolvidos: sempre um
        // numero, sempre entre MinTimerSpeed e MaxTimerSpeed.
        private class TimerSpeeds
        {
            public static readonly TimerSpeeds Vanilla = new TimerSpeeds(1f, 1f, 1f, 1f);

            public readonly float Smelt;
            public readonly float Craft;
            public readonly float Research;
            public readonly float Recycle;

            private TimerSpeeds(float smelt, float craft, float research, float recycle)
            {
                Smelt = smelt;
                Craft = craft;
                Research = research;
                Recycle = recycle;
            }

            // Campo a campo, o primeiro nivel que DEFINE o timer ganha.
            // Ver QUAL NIVEL VALE, no cabecalho da secao OS TIMERS.
            public static TimerSpeeds Resolve(TimersEntry admin, TimersEntry vip, TimersEntry normal)
            {
                return new TimerSpeeds(
                    Pick(admin == null ? null : admin.Smelt, vip == null ? null : vip.Smelt,
                         normal == null ? null : normal.Smelt),
                    Pick(admin == null ? null : admin.Craft, vip == null ? null : vip.Craft,
                         normal == null ? null : normal.Craft),
                    Pick(admin == null ? null : admin.Research, vip == null ? null : vip.Research,
                         normal == null ? null : normal.Research),
                    Pick(admin == null ? null : admin.Recycle, vip == null ? null : vip.Recycle,
                         normal == null ? null : normal.Recycle));
            }

            private static float Pick(float? first, float? second, float? third)
            {
                if (first.HasValue)
                {
                    return Clamp(first.Value);
                }

                if (second.HasValue)
                {
                    return Clamp(second.Value);
                }

                return third.HasValue ? Clamp(third.Value) : MinTimerSpeed;
            }

            // A trava deste lado, para o comando digitado a mao: o
            // agente ja recusa fora da faixa antes de gravar.
            private static float Clamp(float value)
            {
                if (float.IsNaN(value) || value < MinTimerSpeed)
                {
                    return MinTimerSpeed;
                }

                return value > MaxTimerSpeed ? MaxTimerSpeed : value;
            }
        }

        // Uma fornalha acesa. Ver A FORNALHA.
        private class TrackedOven
        {
            public ulong Key;
            public BaseOven Oven;

            // Quem apertou "ligar". 0 = acendeu sozinha.
            public ulong LitBy;

            public float Speed;

            // Time.realtimeSinceStartup da ultima conta da velocidade.
            public float CheckedAt;
        }

        // A duracao de uma mesa de pesquisa ANTES de ser mexida.
        private class ResearchOriginal
        {
            public ResearchTable Table;
            public float Duration;
        }

        // O que SAI no evento de sessao. Nomes curtos de proposito:
        // isto passa por linha de console a cada entrada, saida e
        // morte de jogador.
        private class PlayerEventPayload
        {
            [JsonProperty("event")]
            public string Event { get; set; }

            [JsonProperty("steamId")]
            public string SteamId { get; set; }

            [JsonProperty("name")]
            public string Name { get; set; }

            // Epoch em SEGUNDOS. Ver EmitEvent.
            [JsonProperty("at")]
            public long At { get; set; }

            // So na saida: o motivo que o jogo deu. null nos
            // outros eventos, e precisa SAIR como null.
            [JsonProperty("reason")]
            public string Reason { get; set; }
        }

        private class InventoryResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return true; } }

            [JsonProperty("steamId")]
            public string SteamId { get; set; }

            [JsonProperty("name")]
            public string Name { get; set; }

            [JsonProperty("alive")]
            public bool Alive { get; set; }

            [JsonProperty("count")]
            public int Count { get; set; }

            [JsonProperty("items")]
            public List<InventoryItemResponse> Items { get; set; }
        }

        private class InventoryItemResponse
        {
            [JsonProperty("slot")]
            public string Slot { get; set; }

            [JsonProperty("position")]
            public int Position { get; set; }

            [JsonProperty("shortname")]
            public string Shortname { get; set; }

            [JsonProperty("itemId")]
            public int ItemId { get; set; }

            [JsonProperty("name")]
            public string Name { get; set; }

            [JsonProperty("amount")]
            public int Amount { get; set; }

            [JsonProperty("skinId")]
            public string SkinId { get; set; }

            // Nullable: null significa "este item NAO tem
            // durabilidade", que e diferente de zero (quebrado).
            [JsonProperty("condition")]
            public float? Condition { get; set; }

            [JsonProperty("maxCondition")]
            public float? MaxCondition { get; set; }
        }

        private class KillResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return true; } }

            [JsonProperty("steamId")]
            public string SteamId { get; set; }

            [JsonProperty("wasAlive")]
            public bool WasAlive { get; set; }
        }

        // --------------------------------------------------------
        //  A resposta do teleporte.
        //
        //  A POSICAO FINAL volta, e nao a pedida: quando o `y` e
        //  resolvido pelo terreno, so o servidor sabe onde o jogador
        //  parou. Sem isso a tela teria de adivinhar a altura para
        //  redesenhar o ponto -- e adivinhar altura foi exatamente
        //  o que este comando existe para evitar.
        // --------------------------------------------------------
        private class TeleportResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return true; } }

            [JsonProperty("steamId")]
            public string SteamId { get; set; }

            [JsonProperty("position")]
            public PositionPayload Position { get; set; }

            // Falso quando quem chamou mandou o `y`. E o que permite
            // a tela dizer "coloquei no chao" em vez de deixar a
            // duvida sobre quem escolheu a altura.
            [JsonProperty("heightAdjusted")]
            public bool HeightAdjusted { get; set; }
        }

        private class PositionPayload
        {
            [JsonProperty("x")]
            public float X { get; set; }

            [JsonProperty("y")]
            public float Y { get; set; }

            [JsonProperty("z")]
            public float Z { get; set; }
        }

        private class LoadoutResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return true; } }

            [JsonProperty("steamId")]
            public string SteamId { get; set; }

            // null quando o jogador nao tem VIP; o kit entregue foi
            // o `normal`. Precisa SAIR como null no JSON.
            [JsonProperty("tier")]
            public string Tier { get; set; }

            [JsonProperty("given")]
            public int Given { get; set; }

            [JsonProperty("skipped")]
            public int Skipped { get; set; }
        }

        private class ErrorResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return false; } }

            [JsonProperty("error")]
            public string Error { get; set; }
        }
    }
}

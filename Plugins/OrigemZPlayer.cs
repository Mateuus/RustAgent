// Requires: OrigemZAgent

// ============================================================
//  OrigemZPlayer.cs
//
//  O jogador dentro do jogo: o kit que ele recebe ao nascer, o
//  inventario que ele tem agora, e as acoes de admin sobre ele.
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
    [Info("OrigemZPlayer", "OrigemZ", "0.1.0")]
    [Description("Kit por nivel ao nascer, inventario ao vivo e acoes de admin sobre o jogador")]
    public class OrigemZPlayer : RustPlugin
    {
        [PluginReference]
        private Plugin OrigemZAgent;

        private const string HookGetApiVersion = "GetApiVersion";
        private const string HookGetVipTier = "GetVipTier";
        private const string HookGetLoadout = "GetLoadout";
        private const string HookGetSpawnStatus = "GetSpawnStatus";

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
                    float health = status.Health.Value;

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
                        AplicarAtributo(metabolism.calories, status.Calories.Value);
                    }

                    if (status.Hydration.HasValue)
                    {
                        AplicarAtributo(metabolism.hydration, status.Hydration.Value);
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

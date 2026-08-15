// ============================================================
//  OrigemZChat.cs
//
//  Toma conta do chat: cada jogador fala com a TAG do grupo dele,
//  o nome na cor do grupo e a mensagem formatada. Portado do
//  BetterChat 5.2.15 (LaserHydra) - o estudo esta em
//  Docs\PluginsEstudos\BetterChat.cs.
//
//  ------------------------------------------------------------
//  #### O QUE ELE FAZ, EM UMA FRASE ####
//
//  Ele CANCELA a mensagem original e emite uma no lugar. Nada
//  mais: quem decide o texto final e o formato do grupo, e quem
//  pode mudar esse texto sao os outros plugins, pelo hook.
//
//  ------------------------------------------------------------
//  #### O PONTO DESTE PORTE: O HOOK ####
//
//  Antes de enviar, ele chama em TODOS os plugins carregados:
//
//      object OnOrigemZChat(Dictionary<string, object> dados)
//
//  A resposta decide o destino da mensagem:
//
//      null                       segue como esta
//      Dictionary<string,object>  segue com os dados TROCADOS
//      qualquer outra coisa       a mensagem MORRE aqui
//
//  E isso que permite um silenciamento, um anti-flood, um filtro
//  de palavra ou uma tag temporaria existirem em plugins
//  SEPARADOS, sem tocar neste arquivo. O BetterChatMute do
//  ecossistema original funciona exatamente assim.
//
//  As chaves do dicionario estao em ChatKey* mais abaixo, e a
//  lista completa esta em Docs\OrigemZChat\HOOKS.md.
//
//  ------------------------------------------------------------
//  #### DE ONDE VEM O GRUPO DE UM JOGADOR ####
//
//  Dos grupos do OXIDE, e nao de uma lista propria. E o que faz o
//  VIP funcionar sem uma linha de codigo aqui: o OrigemZVip ja
//  poe o jogador em `origemz.vip.gold` quando ele compra, e o
//  config padrao deste plugin ja tem uma entrada com esse nome.
//  Comprou VIP -> ganhou a tag. Venceu -> perdeu a tag.
//
//  Um jogador em varios grupos usa o formato do de MAIOR
//  prioridade (ver Prioridade), e pode exibir as tags dos outros.
//
//  ------------------------------------------------------------
//  #### CINCO REGRAS, COMO NO RESTO DOS PLUGINS ####
//
//   1. Nada de sintaxe acima de C# 6. O compilador em tempo de
//      execucao do Oxide para nesse teto, e codigo mais novo
//      compila no MSBuild e e recusado no servidor - com erro
//      longe da causa.
//
//   2. O fonte e ASCII puro. Ele viaja para Server\oxide\plugins
//      e e recompilado la; byte acentuado dependeria de os dois
//      lados concordarem sobre a codificacao. Acento so no lang,
//      escapado com \uXXXX.
//
//   3. Texto que o jogador le sai do lang. Formato de chat e
//      COR sao config (ajuste do dono do servidor), nao lang.
//
//   4. O config e de AJUSTE, nunca de ESTADO. Quem esta em que
//      grupo e do Oxide; aqui so mora como cada grupo APARECE.
//
//   5. Nada do que o jogador digita entra formatado. Ver
//      StripRichText: sem isso, qualquer um manda `</color>` e
//      quebra o chat de todo mundo, ou se passa por [ADMIN].
// ============================================================

using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

using ConVar;
using Facepunch.Math;
using Newtonsoft.Json;
using Oxide.Core.Plugins;

namespace Oxide.Plugins
{
    [Info("OrigemZChat", "OrigemZ", "0.1.0")]
    [Description("Chat com tag, cor e formato por grupo do Oxide, com hook para os outros plugins mudarem ou cancelarem a mensagem")]
    public class OrigemZChat : RustPlugin
    {
        // ========================================================
        //  O HOOK QUE ESTE PLUGIN EMITE
        //
        //  Nome de hook e string dos dois lados da fronteira: erro
        //  de digitacao so apareceria em runtime. A constante ao
        //  menos concentra o erro num lugar so.
        // ========================================================
        private const string HookChat = "OnOrigemZChat";

        // Chaves do dicionario que atravessa o hook. Elas sao
        // PROTOCOLO entre plugins: renomear qualquer uma quebra
        // todo mundo que escuta, em silencio.
        private const string KeySteamId = "SteamId";
        private const string KeyUsername = "Username";
        private const string KeyMessage = "Message";
        private const string KeyTitles = "Titles";
        private const string KeyPrimaryGroup = "PrimaryGroup";
        private const string KeyChannel = "Channel";
        private const string KeyBlocked = "BlockedReceivers";
        private const string KeyCancelled = "Cancelled";
        private const string KeyUsernameColor = "UsernameColor";
        private const string KeyUsernameSize = "UsernameSize";
        private const string KeyMessageColor = "MessageColor";
        private const string KeyMessageSize = "MessageSize";
        private const string KeyChatFormat = "ChatFormat";
        private const string KeyConsoleFormat = "ConsoleFormat";

        // Verdadeiro quando a mensagem e do SERVIDOR (um aviso
        // automatico, um anuncio pelo painel) e nao de um jogador.
        //
        // Existe para quem escuta o hook conseguir distinguir os
        // dois: um plugin de silenciamento nao deveria calar o
        // aviso de manutencao, e um filtro de palavrao nao precisa
        // conferir o que o proprio servidor escreveu.
        private const string KeyIsServer = "IsServer";

        // Prefixo "origemz." porque comando de console no Oxide e
        // global: sem namespace, dois plugins com um comando
        // "groups" colidiriam.
        private const string CmdGroups = "origemz.chat.groups";
        private const string CmdSet = "origemz.chat.set";
        private const string CmdAddGroup = "origemz.chat.addgroup";
        private const string CmdBroadcast = "origemz.chat.broadcast";

        private const string PermAdmin = "origemzchat.admin";

        // Chaves do lang.
        private const string MsgNoPermission = "NoPermission";
        private const string MsgGroupCreated = "GroupCreated";
        private const string MsgGroupExists = "GroupExists";
        private const string MsgGroupNotFound = "GroupNotFound";
        private const string MsgFieldNotFound = "FieldNotFound";
        private const string MsgFieldInvalid = "FieldInvalid";
        private const string MsgFieldSet = "FieldSet";
        private const string MsgUsageSet = "UsageSet";
        private const string MsgUsageAddGroup = "UsageAddGroup";

        private PluginConfig _config;

        // Os grupos JA VALIDADOS, ordenados por prioridade. Lista
        // vazia ate o OnServerInitialized montar.
        private List<ChatGroup> _grupos = new List<ChatGroup>();

        // Grupo usado quando o jogador nao esta em nenhum grupo
        // configurado. Ele NAO vem do config e nao pode ser
        // removido: sem ele, um jogador comum ficaria sem formato
        // nenhum e a mensagem sairia crua.
        private readonly ChatGroup _fallback = ChatGroup.Fallback();

        // Tags que OUTROS plugins registraram (ver
        // API_RegisterThirdPartyTitle). A chave e o plugin para o
        // registro sumir junto quando ele for descarregado - senao
        // um plugin descarregado continuaria pondo tag no chat
        // atraves de um delegate morto.
        private readonly Dictionary<Plugin, Func<string, string>> _tagsDeTerceiros =
            new Dictionary<Plugin, Func<string, string>>();

        private bool _ready;

        // ========================================================
        //  A FAXINA DO TEXTO DO JOGADOR
        //
        //  #### ISTO E SEGURANCA, NAO ESTETICA ####
        //
        //  O chat do Rust interpreta rich text da Unity. Sem esta
        //  limpeza, qualquer jogador digita
        //
        //      </color><color=red>[ADMIN] eu
        //
        //  e passa a aparecer como admin para o servidor inteiro -
        //  ou fecha uma tag que nao abriu e pinta todas as
        //  mensagens seguintes.
        //
        //  Os padroes sao COMPILADOS uma vez: eles rodam em toda
        //  mensagem de chat do servidor.
        // ========================================================
        private static readonly Regex[] RichTextPatterns = new Regex[]
        {
            new Regex("<color=.+?>", RegexOptions.Compiled | RegexOptions.IgnoreCase),
            new Regex("<size=.+?>", RegexOptions.Compiled | RegexOptions.IgnoreCase),
            new Regex("<voffset=.+?>", RegexOptions.Compiled | RegexOptions.IgnoreCase),
            new Regex("<material=.+?>", RegexOptions.Compiled | RegexOptions.IgnoreCase),
            new Regex("<sprite=.+?>", RegexOptions.Compiled | RegexOptions.IgnoreCase),
            new Regex("</color>", RegexOptions.Compiled | RegexOptions.IgnoreCase),
            new Regex("</size>", RegexOptions.Compiled | RegexOptions.IgnoreCase),
            new Regex("</voffset>", RegexOptions.Compiled | RegexOptions.IgnoreCase),
            new Regex("</?b>", RegexOptions.Compiled | RegexOptions.IgnoreCase),
            new Regex("</?i>", RegexOptions.Compiled | RegexOptions.IgnoreCase)
        };

        // ========================================================
        //  CICLO DE VIDA
        // ========================================================
        private void Init()
        {
            permission.RegisterPermission(PermAdmin, this);

            Puts("Init() - comandos de console: " + CmdGroups + ", " + CmdSet + ", " + CmdAddGroup +
                 ", " + CmdBroadcast + ". Hook emitido: " + HookChat + ".");
        }

        private void OnServerInitialized()
        {
            try
            {
                _grupos = BuildGroups(_config);

                if (_grupos.Count == 0)
                {
                    PrintWarning("Nenhum grupo utilizavel no config: todo mundo vai falar com o " +
                                 "formato padrao. Ver Server\\oxide\\config\\OrigemZChat.json.");
                }

                EnsureGroups();

                _ready = true;

                Puts("Pronto: " + _grupos.Count + " grupo(s) de chat carregado(s).");
            }
            catch (Exception ex)
            {
                // _ready continua falso, e com ele o chat volta ao
                // comportamento do jogo. Um plugin de chat pela
                // metade e pior que plugin de chat nenhum: ele
                // engoliria as mensagens.
                PrintError("OnServerInitialized falhou; o chat fica no formato padrao do jogo " +
                           "ate um reload: " + ex);
            }
        }

        // O Oxide zera [PluginReference] sozinho, mas um delegate
        // guardado num dicionario nosso e responsabilidade nossa:
        // sem isto, a tag de um plugin descarregado continuaria
        // sendo chamada - e a excecao apareceria no chat de todo
        // mundo, longe da causa.
        private void OnPluginUnloaded(Plugin plugin)
        {
            if (plugin != null && _tagsDeTerceiros.ContainsKey(plugin))
            {
                _tagsDeTerceiros.Remove(plugin);
            }
        }

        // ========================================================
        //  O CORACAO
        //
        //  #### RETORNAR NAO-NULO AQUI CANCELA A MENSAGEM ####
        //
        //  Cancelamos SEMPRE que formatamos: a mensagem original
        //  nao pode sair junto com a nossa, senao cada frase
        //  apareceria duas vezes.
        //
        //  Devolver null e o caminho de "nao mexi nisso" - e ele
        //  existe para os casos em que e melhor o jogo cuidar:
        //  plugin nao inicializado, canal que nao tratamos,
        //  mensagem vazia.
        // ========================================================
        private object OnPlayerChat(BasePlayer player, string message, Chat.ChatChannel channel)
        {
            if (!_ready || player == null || string.IsNullOrEmpty(message))
            {
                return null;
            }

            // #### SO GLOBAL E LOCAL SAO FORMATADOS ####
            //
            // Canal que este plugin nao formata segue pelo caminho
            // do jogo, cru. Cartas e cla dependem de estado que nao
            // da para conferir aqui sem duplicar regra do jogo, e
            // uma mensagem entregue sem tag e melhor que uma
            // mensagem perdida.
            //
            // O CANAL DO TIME esta de fora por um motivo especifico
            // e MEDIDO: alem do `chat.add`, o jogo avisa o app do
            // celular por um caminho proprio, e o metodo que fazia
            // isso (`BroadcastTeamChat`) nao existe mais em
            // `PlayerTeam` nesta versao do Rust - o compilador
            // recusa. Formatar o time sem ele significaria que
            // quem joga acompanhando pelo Rust+ PARARIA de receber
            // as mensagens do proprio time.
            //
            // Trocar uma tag por uma conversa que some nao vale.
            // Quando a API do app estiver mapeada, o time entra
            // aqui - e o resto do plugin ja esta pronto para ele.
            if (channel != Chat.ChatChannel.Global &&
                channel != Chat.ChatChannel.Local)
            {
                return null;
            }

            try
            {
                Dictionary<string, object> dados = PrepareMessage(player, message, channel);

                if (dados == null)
                {
                    return null;
                }

                // #### A PALAVRA DOS OUTROS PLUGINS ####
                //
                // Aqui a mensagem sai das nossas maos: um plugin
                // pode trocar o texto, o nome, as tags, esconder de
                // certos jogadores, ou matar a mensagem.
                dados = RunChatHook(dados);

                if (dados == null || IsCancelled(dados))
                {
                    // Cancelada por um plugin. Retorno nao-nulo:
                    // deixar o jogo emitir a original aqui seria
                    // ignorar o cancelamento.
                    return true;
                }

                Broadcast(player, dados, channel);
                return true;
            }
            catch (Exception ex)
            {
                // #### O CHAT NAO PODE MORRER POR NOSSA CAUSA ####
                //
                // Uma excecao aqui, com retorno nao-nulo, engoliria
                // a mensagem. Devolvendo null, o jogo emite a
                // original sem formatacao: o jogador continua sendo
                // ouvido, e o erro vai para o log do servidor.
                PrintError("Falha ao formatar a mensagem de " + player.UserIDString +
                           "; ela sai no formato do jogo. " + ex);
                return null;
            }
        }

        // ========================================================
        //  MONTAGEM
        // ========================================================

        /// <summary>
        /// Monta o dicionario que atravessa o hook e vira mensagem.
        /// </summary>
        private Dictionary<string, object> PrepareMessage(BasePlayer player, string message, Chat.ChatChannel channel)
        {
            string texto = StripRichText(message);

            if (_config.TamanhoMaximoDaMensagem > 0 && texto.Length > _config.TamanhoMaximoDaMensagem)
            {
                texto = texto.Substring(0, _config.TamanhoMaximoDaMensagem);
            }

            texto = texto.Trim();

            if (texto.Length == 0)
            {
                // Sobrou nada depois da faxina: era so rich text.
                // Nao emitimos e nao deixamos o jogo emitir - senao
                // a limpeza nao teria servido para nada.
                return null;
            }

            List<ChatGroup> doJogador = GetUserGroups(player.UserIDString);
            ChatGroup principal = GetPrimaryGroup(doJogador);

            if (principal == null)
            {
                principal = _fallback;
                doJogador.Add(principal);
            }

            List<string> tags = BuildTitles(doJogador, principal, player.UserIDString);

            Dictionary<string, object> dados = new Dictionary<string, object>();

            dados[KeySteamId] = player.UserIDString;
            dados[KeyUsername] = StripRichText(player.displayName);
            dados[KeyMessage] = texto;
            dados[KeyTitles] = tags;
            dados[KeyPrimaryGroup] = principal.Nome;

            // SOMENTE LEITURA para quem escuta o hook: o canal vem
            // por parametro ate o envio, e trocar este valor nao
            // muda para onde a mensagem vai.
            //
            // E de proposito. Um plugin que pudesse promover o
            // canal transformaria uma conversa local numa global -
            // e quem falou baixinho nao espera isso.
            dados[KeyChannel] = (int)channel;
            dados[KeyBlocked] = new List<string>();
            dados[KeyCancelled] = false;
            dados[KeyUsernameColor] = principal.CorDoNome;
            dados[KeyUsernameSize] = principal.TamanhoDoNome;
            dados[KeyMessageColor] = principal.CorDaMensagem;
            dados[KeyMessageSize] = principal.TamanhoDaMensagem;
            dados[KeyChatFormat] = principal.FormatoChat;
            dados[KeyConsoleFormat] = principal.FormatoConsole;
            dados[KeyIsServer] = false;

            return dados;
        }

        /// <summary>
        /// As tags que vao aparecer, na ordem, ja com cor e tamanho.
        /// </summary>
        private List<string> BuildTitles(List<ChatGroup> grupos, ChatGroup principal, string steamId)
        {
            List<string> tags = new List<string>();

            for (int i = 0; i < grupos.Count; i++)
            {
                ChatGroup grupo = grupos[i];

                if (grupo.TagOculta)
                {
                    continue;
                }

                // "So no grupo principal": e como um cargo alto
                // aparece sozinho em vez de empilhar com os
                // herdados. O VIP Gold que herda do Bronze nao
                // deveria mostrar as duas tags.
                if (grupo.TagSoNoPrincipal && grupo != principal)
                {
                    continue;
                }

                if (string.IsNullOrEmpty(grupo.Tag))
                {
                    continue;
                }

                tags.Add(Wrap(grupo.Tag, grupo.CorDaTag, grupo.TamanhoDaTag));

                if (_config.MaximoDeTags > 0 && tags.Count >= _config.MaximoDeTags)
                {
                    break;
                }
            }

            if (_config.InverterOrdemDasTags)
            {
                tags.Reverse();
            }

            // As tags de outros plugins entram DEPOIS do teto: elas
            // sao pedidas de codigo, uma a uma, e nao vem de um
            // config que alguem possa ter enchido sem querer.
            foreach (KeyValuePair<Plugin, Func<string, string>> registro in _tagsDeTerceiros)
            {
                try
                {
                    string tag = registro.Value(steamId);

                    if (!string.IsNullOrEmpty(tag))
                    {
                        tags.Add(tag);
                    }
                }
                catch (Exception ex)
                {
                    string nome = registro.Key == null ? "(desconhecido)" : registro.Key.Name;
                    PrintError("A tag registrada pelo plugin '" + nome + "' lancou; ela fica de " +
                               "fora desta mensagem. " + ex);
                }
            }

            return tags;
        }

        // ========================================================
        //  O HOOK
        // ========================================================

        /// <summary>
        /// Passa os dados por todos os plugins e devolve o
        /// resultado. `null` significa CANCELADA.
        /// </summary>
        private Dictionary<string, object> RunChatHook(Dictionary<string, object> dados)
        {
            Plugin[] carregados = plugins.GetAll();

            for (int i = 0; i < carregados.Length; i++)
            {
                Plugin plugin = carregados[i];

                if (plugin == null || plugin == this)
                {
                    continue;
                }

                object resposta;

                try
                {
                    resposta = plugin.CallHook(HookChat, dados);
                }
                catch (Exception ex)
                {
                    // Plugin que lanca no hook NAO derruba a
                    // mensagem: ele perde a vez. A alternativa
                    // seria um plugin com defeito calar o servidor
                    // inteiro.
                    PrintError("O plugin '" + plugin.Name + "' lancou em " + HookChat +
                               "; a mensagem segue sem o que ele faria. " + ex);
                    continue;
                }

                if (resposta == null)
                {
                    continue;
                }

                Dictionary<string, object> trocado = resposta as Dictionary<string, object>;

                if (trocado != null)
                {
                    // O plugin devolveu dados novos. Eles passam
                    // pelos plugins SEGUINTES, e nao direto para o
                    // envio: e o que permite dois plugins mexerem
                    // na mesma mensagem (um filtra palavrao, outro
                    // acrescenta tag).
                    dados = trocado;
                    continue;
                }

                // Qualquer outra coisa nao-nula e "cancela".
                return null;
            }

            return dados;
        }

        // ========================================================
        //  ENVIO
        // ========================================================

        private void Broadcast(BasePlayer autor, Dictionary<string, object> dados, Chat.ChatChannel channel)
        {
            string textoChat = Render(dados, true);
            string textoConsole = Render(dados, false);

            ulong steamId = autor.userID;
            List<string> bloqueados = GetList(dados, KeyBlocked);

            if (channel == Chat.ChatChannel.Local)
            {
                SendToLocal(autor, steamId, textoChat, bloqueados);
            }
            else
            {
                SendToAll(steamId, textoChat, bloqueados);
            }

            Puts("[" + channel + "] " + textoConsole);

            // #### O REGISTRO NO SERVIDOR ####
            //
            // Sem isto, a mensagem aparece para os jogadores e NAO
            // existe para o resto do mundo: some do historico de
            // chat, do console do F1 e das ferramentas de admin que
            // leem o chat. Como este plugin cancela a original, o
            // registro dela tambem foi cancelado - e cabe a nos
            // refaze-lo.
            Chat.ChatEntry entrada = new Chat.ChatEntry();
            entrada.Channel = channel;
            entrada.Message = textoConsole;
            // `UserId` do registro e TEXTO, e nao o ulong que o
            // `chat.add` recebe. Os dois convivem no mesmo metodo
            // de proposito - trocar um pelo outro compila em um dos
            // lados e falha no outro.
            entrada.UserId = autor.UserIDString;
            entrada.Username = autor.displayName;
            entrada.Color = GetString(dados, KeyUsernameColor, _fallback.CorDoNome);
            entrada.Time = Epoch.Current;

            Chat.Record(entrada);
        }

        // `BasePlayer.activePlayerList` NAO e um List<BasePlayer>: e
        // um ListHashSet do proprio jogo. Guardar numa variavel
        // tipada nao compila, entao o laco vai direto na colecao -
        // que e o que os outros plugins do projeto ja fazem.
        private void SendToAll(ulong steamId, string texto, List<string> bloqueados)
        {
            foreach (BasePlayer alvo in BasePlayer.activePlayerList)
            {
                if (alvo == null || IsBlocked(bloqueados, alvo.UserIDString))
                {
                    continue;
                }

                alvo.SendConsoleCommand("chat.add", (int)Chat.ChatChannel.Global, steamId, texto);
            }
        }

        private void SendToLocal(BasePlayer autor, ulong steamId, string texto, List<string> bloqueados)
        {
            // O alcance e o do JOGO (`chat.localchatrange`), e nao
            // um numero nosso: dois alcances diferentes fariam o
            // jogador ouvir alguem que o jogo considera longe
            // demais - ou o contrario.
            float alcance = Chat.localChatRange * Chat.localChatRange;

            foreach (BasePlayer alvo in BasePlayer.activePlayerList)
            {
                if (alvo == null || IsBlocked(bloqueados, alvo.UserIDString))
                {
                    continue;
                }

                if ((autor.transform.position - alvo.transform.position).sqrMagnitude > alcance)
                {
                    continue;
                }

                alvo.SendConsoleCommand("chat.add", (int)Chat.ChatChannel.Local, steamId, texto);
            }
        }

        // ========================================================
        //  FORMATACAO
        // ========================================================

        /// <summary>
        /// Aplica o formato do grupo aos dados. `paraChat` falso
        /// devolve a versao sem rich text, para o console e o log.
        /// </summary>
        private string Render(Dictionary<string, object> dados, bool paraChat)
        {
            string formato = paraChat
                ? GetString(dados, KeyChatFormat, _fallback.FormatoChat)
                : GetString(dados, KeyConsoleFormat, _fallback.FormatoConsole);

            string usuario = GetString(dados, KeyUsername, string.Empty);
            string mensagem = GetString(dados, KeyMessage, string.Empty);
            List<string> tags = GetList(dados, KeyTitles);

            string tagsUnidas = tags == null ? string.Empty : string.Join(" ", tags.ToArray());

            string usuarioFinal = paraChat
                ? Wrap(usuario,
                       GetString(dados, KeyUsernameColor, _fallback.CorDoNome),
                       GetInt(dados, KeyUsernameSize, _fallback.TamanhoDoNome))
                : usuario;

            string mensagemFinal = paraChat
                ? Wrap(mensagem,
                       GetString(dados, KeyMessageColor, _fallback.CorDaMensagem),
                       GetInt(dados, KeyMessageSize, _fallback.TamanhoDaMensagem))
                : mensagem;

            DateTime agora = DateTime.Now;

            string saida = formato;

            saida = saida.Replace("{Title}", paraChat ? tagsUnidas : StripRichText(tagsUnidas));
            saida = saida.Replace("{Username}", usuarioFinal);
            saida = saida.Replace("{Message}", mensagemFinal);
            saida = saida.Replace("{Group}", GetString(dados, KeyPrimaryGroup, string.Empty));
            saida = saida.Replace("{ID}", GetString(dados, KeySteamId, string.Empty));
            saida = saida.Replace("{Time}", agora.ToString("HH:mm"));
            saida = saida.Replace("{Date}", agora.ToString("dd/MM/yyyy"));

            if (!paraChat)
            {
                saida = StripRichText(saida);
            }

            // Um formato sem tag ("{Title} {Username}") comeca com
            // espaco quando o jogador nao tem tag nenhuma.
            return saida.Trim();
        }

        /// <summary>Envolve o texto em cor e tamanho do rich text.</summary>
        private static string Wrap(string texto, string cor, int tamanho)
        {
            if (string.IsNullOrEmpty(texto))
            {
                return string.Empty;
            }

            string resultado = texto;

            if (tamanho > 0)
            {
                resultado = "<size=" + tamanho + ">" + resultado + "</size>";
            }

            if (!string.IsNullOrEmpty(cor))
            {
                resultado = "<color=" + cor + ">" + resultado + "</color>";
            }

            return resultado;
        }

        /// <summary>
        /// Tira todo rich text do texto. Ver o comentario de
        /// RichTextPatterns: isto e a barreira contra um jogador se
        /// passar por outro.
        /// </summary>
        private static string StripRichText(string texto)
        {
            if (string.IsNullOrEmpty(texto))
            {
                return string.Empty;
            }

            string limpo = texto;

            for (int i = 0; i < RichTextPatterns.Length; i++)
            {
                limpo = RichTextPatterns[i].Replace(limpo, string.Empty);
            }

            return limpo;
        }

        // ========================================================
        //  GRUPOS
        // ========================================================

        /// <summary>
        /// Os grupos configurados em que o jogador esta, ja
        /// ordenados por prioridade.
        /// </summary>
        private List<ChatGroup> GetUserGroups(string steamId)
        {
            List<ChatGroup> encontrados = new List<ChatGroup>();
            string[] doOxide = permission.GetUserGroups(steamId);

            if (doOxide == null)
            {
                return encontrados;
            }

            for (int i = 0; i < _grupos.Count; i++)
            {
                for (int j = 0; j < doOxide.Length; j++)
                {
                    if (string.Equals(_grupos[i].Nome, doOxide[j], StringComparison.OrdinalIgnoreCase))
                    {
                        encontrados.Add(_grupos[i]);
                        break;
                    }
                }
            }

            // `_grupos` ja esta ordenado por prioridade, e o laco
            // acima preserva essa ordem: o primeiro e o mais forte.
            return encontrados;
        }

        private ChatGroup GetPrimaryGroup(List<ChatGroup> grupos)
        {
            return grupos.Count == 0 ? null : grupos[0];
        }

        /// <summary>
        /// Cria no Oxide os grupos que o config menciona e que
        /// ainda nao existem.
        ///
        /// Sem isto, uma entrada nova no config nao teria como
        /// receber ninguem: `oxide.usergroup add` recusa grupo
        /// inexistente, e o admin veria "grupo nao existe" logo
        /// depois de configura-lo aqui.
        /// </summary>
        private void EnsureGroups()
        {
            for (int i = 0; i < _grupos.Count; i++)
            {
                ChatGroup grupo = _grupos[i];

                if (permission.GroupExists(grupo.Nome))
                {
                    continue;
                }

                if (permission.CreateGroup(grupo.Nome, grupo.Tag, 0))
                {
                    Puts("Grupo '" + grupo.Nome + "' criado no Oxide.");
                }
            }
        }

        // ========================================================
        //  API PARA OUTROS PLUGINS
        //
        //  #### CHAMADAS, E NAO REFERENCIA DIRETA ####
        //
        //  Quem usa chama por `plugins.Find("OrigemZChat")` +
        //  `Call(...)`. Assim um servidor sem este plugin nao
        //  impede os outros de carregar - o chat so fica no formato
        //  do jogo.
        //
        //  A lista completa esta em Docs\OrigemZChat\HOOKS.md.
        // ========================================================

        /// <summary>O nome do jogador ja com cor e tamanho do grupo.</summary>
        private string API_GetFormattedName(string steamId)
        {
            BasePlayer player = BasePlayer.Find(steamId);
            string nome = player == null ? steamId : StripRichText(player.displayName);

            ChatGroup principal = GetPrimaryGroup(GetUserGroups(steamId));

            if (principal == null)
            {
                principal = _fallback;
            }

            return Wrap(nome, principal.CorDoNome, principal.TamanhoDoNome);
        }

        /// <summary>A linha inteira, como sairia no chat.</summary>
        private string API_GetFormattedMessage(string steamId, string message, bool console)
        {
            BasePlayer player = BasePlayer.Find(steamId);

            if (player == null)
            {
                return message;
            }

            Dictionary<string, object> dados =
                PrepareMessage(player, message, Chat.ChatChannel.Global);

            return dados == null ? message : Render(dados, !console);
        }

        /// <summary>Os grupos de chat do jogador, do mais forte para o mais fraco.</summary>
        private List<string> API_GetUserGroups(string steamId)
        {
            List<ChatGroup> grupos = GetUserGroups(steamId);
            List<string> nomes = new List<string>();

            for (int i = 0; i < grupos.Count; i++)
            {
                nomes.Add(grupos[i].Nome);
            }

            return nomes;
        }

        private bool API_GroupExists(string group)
        {
            return FindGroup(group) != null;
        }

        /// <summary>
        /// Cria um grupo de chat com os padroes e GRAVA o config.
        ///
        /// Devolve falso quando ja existe - e nao sobrescreve: um
        /// plugin recarregando nao pode apagar o ajuste que o dono
        /// do servidor fez no grupo dele.
        /// </summary>
        private bool API_AddGroup(string group)
        {
            if (string.IsNullOrEmpty(group) || FindGroup(group) != null)
            {
                return false;
            }

            GroupConfig novo = GroupConfig.Padrao(group);

            _config.Grupos.Add(novo);
            SaveConfig();

            _grupos = BuildGroups(_config);
            EnsureGroups();

            return true;
        }

        private Dictionary<string, object> API_GetGroupFields(string group)
        {
            ChatGroup grupo = FindGroup(group);

            return grupo == null ? new Dictionary<string, object>() : grupo.ToFields();
        }

        /// <summary>
        /// Muda um campo de um grupo e grava. Devolve "OK",
        /// "GRUPO_NAO_EXISTE", "CAMPO_NAO_EXISTE" ou "VALOR_INVALIDO".
        ///
        /// Codigo, e nao frase: quem le isto e outro plugin ou o
        /// admin no console. A frase para o jogador sai do lang.
        /// </summary>
        private string API_SetGroupField(string group, string field, string value)
        {
            GroupConfig alvo = FindGroupConfig(group);

            if (alvo == null)
            {
                return "GRUPO_NAO_EXISTE";
            }

            string resultado = alvo.SetField(field, value);

            if (resultado == "OK")
            {
                SaveConfig();
                _grupos = BuildGroups(_config);
            }

            return resultado;
        }

        /// <summary>
        /// Registra uma tag calculada por OUTRO plugin.
        ///
        /// #### PARA QUE ISTO EXISTE ####
        ///
        /// Tag de config e ESTATICA: ela vale para todo mundo do
        /// grupo, o tempo todo. Tem tag que nao e assim - "3 dias
        /// de VIP restantes", "top 1 da semana", "em combate". Elas
        /// dependem de estado que mora no outro plugin, e ele passa
        /// a calcula-las a cada mensagem por aqui.
        ///
        /// O delegate recebe o SteamID e devolve a tag pronta (com
        /// cor, se quiser) ou vazio para nao aparecer.
        /// </summary>
        private void API_RegisterThirdPartyTitle(Plugin plugin, Func<string, string> titleGetter)
        {
            if (plugin == null || titleGetter == null)
            {
                return;
            }

            _tagsDeTerceiros[plugin] = titleGetter;
            Puts("O plugin '" + plugin.Name + "' registrou uma tag de chat.");
        }

        /// <summary>
        /// Emite uma mensagem JA no formato deste plugin, passando
        /// pelo hook como qualquer outra.
        ///
        /// E o caminho para um plugin falar "como se fosse" o chat:
        /// um anuncio, uma mensagem de sistema com tag propria.
        /// </summary>
        private bool API_SendMessage(Dictionary<string, object> dados, int channel)
        {
            if (!_ready || dados == null)
            {
                return false;
            }

            string steamId = GetString(dados, KeySteamId, string.Empty);
            BasePlayer autor = BasePlayer.Find(steamId);

            if (autor == null)
            {
                return false;
            }

            Dictionary<string, object> final = RunChatHook(dados);

            if (final == null || IsCancelled(final))
            {
                return false;
            }

            Broadcast(autor, final, (Chat.ChatChannel)channel);
            return true;
        }

        // ========================================================
        //  COMANDOS DE CONSOLE
        //
        //  A edicao normal e o JSON. Estes existem para o que o
        //  JSON nao resolve: olhar o estado sem abrir arquivo, e
        //  mudar uma cor com o servidor no ar.
        // ========================================================

        [ConsoleCommand(CmdGroups)]
        private void CmdGroupsHandler(ConsoleSystem.Arg arg)
        {
            if (!HasConsoleAccess(arg))
            {
                return;
            }

            if (_grupos.Count == 0)
            {
                arg.ReplyWith("Nenhum grupo de chat configurado.");
                return;
            }

            string saida = "Grupos de chat, do mais forte para o mais fraco:";

            for (int i = 0; i < _grupos.Count; i++)
            {
                ChatGroup g = _grupos[i];
                saida += "\n  " + g.Nome +
                         "  prioridade=" + g.Prioridade +
                         "  tag='" + g.Tag + "'" +
                         "  cor=" + g.CorDaTag;
            }

            arg.ReplyWith(saida);
        }

        [ConsoleCommand(CmdSet)]
        private void CmdSetHandler(ConsoleSystem.Arg arg)
        {
            if (!HasConsoleAccess(arg))
            {
                return;
            }

            if (arg.Args == null || arg.Args.Length < 3)
            {
                arg.ReplyWith(GetMessage(MsgUsageSet, null));
                return;
            }

            // `arg.GetString(indice, padrao)` devolve string de
            // fato; `arg.Args[i]` nao e string nesta versao do Rust
            // (e um Facepunch.StringView) e nao compila atribuido
            // direto.
            string grupo = arg.GetString(0, string.Empty);
            string campo = arg.GetString(1, string.Empty);

            // O valor pode ter espaco ("VIP Ouro"): o resto dos
            // argumentos e juntado de volta.
            string valor = string.Empty;

            for (int i = 2; i < arg.Args.Length; i++)
            {
                if (valor.Length > 0)
                {
                    valor += " ";
                }

                valor += arg.GetString(i, string.Empty);
            }

            string resultado = API_SetGroupField(grupo, campo, valor);

            if (resultado == "GRUPO_NAO_EXISTE")
            {
                arg.ReplyWith(GetMessage(MsgGroupNotFound, null).Replace("{group}", grupo));
                return;
            }

            if (resultado == "CAMPO_NAO_EXISTE")
            {
                arg.ReplyWith(GetMessage(MsgFieldNotFound, null)
                    .Replace("{field}", campo)
                    .Replace("{fields}", GroupConfig.CamposDisponiveis()));
                return;
            }

            if (resultado == "VALOR_INVALIDO")
            {
                arg.ReplyWith(GetMessage(MsgFieldInvalid, null)
                    .Replace("{field}", campo)
                    .Replace("{value}", valor));
                return;
            }

            arg.ReplyWith(GetMessage(MsgFieldSet, null)
                .Replace("{group}", grupo)
                .Replace("{field}", campo)
                .Replace("{value}", valor));
        }

        [ConsoleCommand(CmdAddGroup)]
        private void CmdAddGroupHandler(ConsoleSystem.Arg arg)
        {
            if (!HasConsoleAccess(arg))
            {
                return;
            }

            if (arg.Args == null || arg.Args.Length < 1)
            {
                arg.ReplyWith(GetMessage(MsgUsageAddGroup, null));
                return;
            }

            string grupo = arg.GetString(0, string.Empty);

            if (API_AddGroup(grupo))
            {
                arg.ReplyWith(GetMessage(MsgGroupCreated, null).Replace("{group}", grupo));
                return;
            }

            arg.ReplyWith(GetMessage(MsgGroupExists, null).Replace("{group}", grupo));
        }

        // ========================================================
        //  A MENSAGEM DO SERVIDOR
        //
        //      origemz.chat.broadcast <base64 do JSON>
        //
        //  E por aqui que entram os avisos automaticos do RustAgent
        //  ("se torne VIP", "wipe na quinta") e qualquer anuncio
        //  disparado pelo painel ou por um site.
        //
        //  ------------------------------------------------------
        //  #### POR QUE BASE64, E NAO JSON CRU ####
        //
        //  MEDIDO neste projeto, no origemz.vip.sync (ver o
        //  comentario em OrigemZAgent.cs). Mandando por RCON
        //
        //      origemz.chat.broadcast {"text":"oi"}
        //
        //  o plugin recebe o JSON com as ASPAS COMIDAS: o parser de
        //  console do Rust trata token entre aspas como argumento
        //  citado e as remove. Remontar com string.Join nao desfaz
        //  isso - a informacao se perdeu antes de chegar aqui.
        //
        //  Base64 nao tem aspas, nem espaco, nem chave: atravessa
        //  qualquer parser de console sem perder byte.
        //
        //  ------------------------------------------------------
        //  O JSON aceito:
        //
        //      {
        //        "text":     "obrigatorio",
        //        "tag":      "[AVISO]",
        //        "tagColor": "#ffcc00",
        //        "color":    "#ffffff",
        //        "size":     15,
        //        "steamId":  "7656..."   // opcional: so para ele
        //      }
        //
        //  A resposta e JSON de uma linha, como no OrigemZAgent:
        //  quem chamou e o agente, e ele precisa de codigo, nao de
        //  frase.
        // ========================================================
        [ConsoleCommand(CmdBroadcast)]
        private void CmdBroadcastHandler(ConsoleSystem.Arg arg)
        {
            // #### SO DO CONSOLE DO SERVIDOR E DO RCON ####
            //
            // `arg.Connection != null` significa que veio de um
            // CLIENTE. Um jogador que descobrisse este comando
            // falaria pelo servidor, com a tag de aviso - o golpe
            // mais barato que existe num servidor de Rust.
            if (arg.Connection != null)
            {
                return;
            }

            if (!_ready)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"NOT_READY\"}");
                return;
            }

            string json = DecodeBase64(arg.GetString(0, string.Empty));

            if (json == null)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"INVALID_ARGS\"}");
                return;
            }

            BroadcastPayload payload;

            try
            {
                payload = JsonConvert.DeserializeObject<BroadcastPayload>(json);
            }
            catch (Exception ex)
            {
                // JSON ilegivel e INVALID_ARGS, e nao erro interno:
                // o defeito esta no que chegou. A excecao vai para
                // o log, que e a unica pista de ONDE quebrou.
                PrintError(CmdBroadcast + ": JSON ilegivel. " + ex.Message);
                arg.ReplyWith("{\"ok\":false,\"error\":\"INVALID_ARGS\"}");
                return;
            }

            if (payload == null || string.IsNullOrEmpty(payload.Text))
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"INVALID_ARGS\"}");
                return;
            }

            try
            {
                int recebidos = SendServerMessage(payload);
                arg.ReplyWith("{\"ok\":true,\"sent\":" + recebidos + "}");
            }
            catch (Exception ex)
            {
                PrintError(CmdBroadcast + " falhou: " + ex);
                arg.ReplyWith("{\"ok\":false,\"error\":\"INTERNAL_ERROR\"}");
            }
        }

        /// <summary>
        /// Monta e entrega a mensagem do servidor. Devolve para
        /// quantos jogadores ela foi.
        /// </summary>
        private int SendServerMessage(BroadcastPayload payload)
        {
            // O texto vem de FORA (agente, painel, site). Ele passa
            // pela mesma faxina do texto de jogador: um `</color>`
            // vindo de um campo de formulario quebra o chat de todo
            // mundo igual.
            //
            // A TAG nao passa: ela e do dono do servidor e a cor
            // dela e o proposito.
            string texto = StripRichText(payload.Text).Trim();

            if (texto.Length == 0)
            {
                return 0;
            }

            string corDaMensagem = string.IsNullOrEmpty(payload.Color) ? "white" : payload.Color;
            string corDaTag = string.IsNullOrEmpty(payload.TagColor) ? "#ffcc00" : payload.TagColor;
            int tamanho = payload.Size > 0 ? payload.Size : 15;

            List<string> tags = new List<string>();

            if (!string.IsNullOrEmpty(payload.Tag))
            {
                tags.Add(Wrap(payload.Tag, corDaTag, tamanho));
            }

            Dictionary<string, object> dados = new Dictionary<string, object>();

            // SteamID zero e o do SERVIDOR: e assim que o cliente
            // desenha a mensagem sem avatar de jogador.
            dados[KeySteamId] = "0";
            dados[KeyUsername] = string.Empty;
            dados[KeyMessage] = texto;
            dados[KeyTitles] = tags;
            dados[KeyPrimaryGroup] = string.Empty;
            dados[KeyChannel] = (int)Chat.ChatChannel.Global;
            dados[KeyBlocked] = new List<string>();
            dados[KeyCancelled] = false;
            dados[KeyUsernameColor] = corDaMensagem;
            dados[KeyUsernameSize] = tamanho;
            dados[KeyMessageColor] = corDaMensagem;
            dados[KeyMessageSize] = tamanho;

            // Sem {Username}: nao ha jogador falando. Um formato com
            // ele deixaria dois espacos no comeco de todo aviso.
            dados[KeyChatFormat] = "{Title} {Message}";
            dados[KeyConsoleFormat] = "{Title} {Message}";
            dados[KeyIsServer] = true;

            // O aviso do servidor passa pelo hook como qualquer
            // mensagem: e o que permite um plugin traduzir, filtrar
            // ou registrar tambem os anuncios. Quem nao quiser agir
            // sobre eles olha `IsServer`.
            Dictionary<string, object> final = RunChatHook(dados);

            if (final == null || IsCancelled(final))
            {
                return 0;
            }

            string textoChat = Render(final, true);
            string textoConsole = Render(final, false);

            int enviados = 0;

            // Com `steamId` no payload, a mensagem e SO para ele.
            // E o caminho de um aviso pessoal ("sua compra caiu",
            // "seu VIP vence amanha") sem inventar um segundo
            // comando.
            if (!string.IsNullOrEmpty(payload.SteamId))
            {
                BasePlayer alvo = BasePlayer.Find(payload.SteamId);

                if (alvo == null || !alvo.IsConnected)
                {
                    return 0;
                }

                alvo.SendConsoleCommand("chat.add", (int)Chat.ChatChannel.Global, 0UL, textoChat);
                Puts("[privado -> " + payload.SteamId + "] " + textoConsole);

                return 1;
            }

            List<string> bloqueados = GetList(final, KeyBlocked);

            foreach (BasePlayer alvo in BasePlayer.activePlayerList)
            {
                if (alvo == null || IsBlocked(bloqueados, alvo.UserIDString))
                {
                    continue;
                }

                alvo.SendConsoleCommand("chat.add", (int)Chat.ChatChannel.Global, 0UL, textoChat);
                enviados++;
            }

            Puts("[anuncio] " + textoConsole);

            // O registro no historico do servidor, como no chat de
            // jogador: sem ele o aviso nao existiria para o console
            // do F1 nem para as ferramentas de admin.
            Chat.ChatEntry entrada = new Chat.ChatEntry();
            entrada.Channel = Chat.ChatChannel.Global;
            entrada.Message = textoConsole;
            entrada.UserId = "0";
            entrada.Username = "SERVER";
            entrada.Color = corDaMensagem;
            entrada.Time = Epoch.Current;

            Chat.Record(entrada);

            return enviados;
        }

        /// <summary>
        /// Base64 -> texto. `null` quando nao e base64 valido.
        ///
        /// Mesmo tratamento do OrigemZAgent: as duas excecoes que o
        /// Convert lanca viram null, e quem chamou responde
        /// INVALID_ARGS.
        /// </summary>
        private static string DecodeBase64(string encoded)
        {
            if (string.IsNullOrEmpty(encoded))
            {
                return null;
            }

            try
            {
                byte[] bytes = Convert.FromBase64String(encoded.Trim());
                return System.Text.Encoding.UTF8.GetString(bytes);
            }
            catch (FormatException)
            {
                return null;
            }
            catch (ArgumentException)
            {
                return null;
            }
        }

        /// <summary>
        /// Quem pode rodar os comandos: o console do servidor (sem
        /// conexao) e quem tem a permissao.
        ///
        /// #### POR QUE NAO `arg.Player()` ####
        ///
        /// Ele e um metodo de EXTENSAO, e o `using ConVar;` la em
        /// cima traz outra extensao de mesmo nome que ganha a
        /// disputa - o compilador recusa com uma mensagem sobre
        /// `NetworkReadEx.Player(NetRead)`, que nao tem nada a ver
        /// com o que se pediu. Pela conexao nao ha ambiguidade
        /// possivel.
        /// </summary>
        private bool HasConsoleAccess(ConsoleSystem.Arg arg)
        {
            if (arg.Connection == null)
            {
                // Console do servidor ou RCON: e o dono da maquina.
                return true;
            }

            BasePlayer player = arg.Connection.player as BasePlayer;

            if (player == null)
            {
                return true;
            }

            if (permission.UserHasPermission(player.UserIDString, PermAdmin))
            {
                return true;
            }

            arg.ReplyWith(GetMessage(MsgNoPermission, player.UserIDString));
            return false;
        }

        private string GetMessage(string key, string steamId)
        {
            return lang.GetMessage(key, this, steamId);
        }

        // ========================================================
        //  LEITURA DO DICIONARIO DO HOOK
        //
        //  #### POR QUE TUDO E DEFENSIVO AQUI ####
        //
        //  Este dicionario voltou de OUTRO plugin. Ele pode ter
        //  vindo com uma chave faltando, com o tipo trocado
        //  (`"15"` no lugar de `15`) ou com um null onde havia
        //  texto. Nada disso pode virar excecao no caminho de toda
        //  mensagem de chat do servidor: o valor padrao entra e a
        //  mensagem sai.
        // ========================================================

        private static string GetString(Dictionary<string, object> dados, string chave, string padrao)
        {
            object valor;

            if (dados == null || !dados.TryGetValue(chave, out valor) || valor == null)
            {
                return padrao;
            }

            string texto = valor as string;

            return texto == null ? padrao : texto;
        }

        private static int GetInt(Dictionary<string, object> dados, string chave, int padrao)
        {
            object valor;

            if (dados == null || !dados.TryGetValue(chave, out valor) || valor == null)
            {
                return padrao;
            }

            if (valor is int)
            {
                return (int)valor;
            }

            int convertido;

            return int.TryParse(valor.ToString(), out convertido) ? convertido : padrao;
        }

        private static List<string> GetList(Dictionary<string, object> dados, string chave)
        {
            object valor;

            if (dados == null || !dados.TryGetValue(chave, out valor) || valor == null)
            {
                return new List<string>();
            }

            List<string> lista = valor as List<string>;

            return lista == null ? new List<string>() : lista;
        }

        private static bool IsCancelled(Dictionary<string, object> dados)
        {
            object valor;

            if (dados == null || !dados.TryGetValue(KeyCancelled, out valor) || valor == null)
            {
                return false;
            }

            return valor is bool && (bool)valor;
        }

        private static bool IsBlocked(List<string> bloqueados, string steamId)
        {
            if (bloqueados == null || bloqueados.Count == 0)
            {
                return false;
            }

            for (int i = 0; i < bloqueados.Count; i++)
            {
                if (string.Equals(bloqueados[i], steamId, StringComparison.Ordinal))
                {
                    return true;
                }
            }

            return false;
        }

        private ChatGroup FindGroup(string nome)
        {
            if (string.IsNullOrEmpty(nome))
            {
                return null;
            }

            for (int i = 0; i < _grupos.Count; i++)
            {
                if (string.Equals(_grupos[i].Nome, nome, StringComparison.OrdinalIgnoreCase))
                {
                    return _grupos[i];
                }
            }

            return null;
        }

        private GroupConfig FindGroupConfig(string nome)
        {
            if (string.IsNullOrEmpty(nome) || _config == null || _config.Grupos == null)
            {
                return null;
            }

            for (int i = 0; i < _config.Grupos.Count; i++)
            {
                GroupConfig entrada = _config.Grupos[i];

                if (entrada != null && string.Equals(entrada.Nome, nome, StringComparison.OrdinalIgnoreCase))
                {
                    return entrada;
                }
            }

            return null;
        }

        // ========================================================
        //  CONFIG
        // ========================================================
        protected override void LoadDefaultConfig()
        {
            _config = PluginConfig.Default();
            PrintWarning("Config novo criado com os grupos padrao (jogador, VIPs e admin).");
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
                // Config ilegivel NAO vira config padrao gravado por
                // cima: sobrescrever apagaria o arquivo que o admin
                // escreveu errado, e com ele a unica pista do que
                // ele quis dizer.
                PrintError("Config ilegivel, usando os padroes SEM gravar por cima. " +
                           "Conserte Server\\oxide\\config\\OrigemZChat.json: " + ex.Message);
                _config = PluginConfig.Default();
                return;
            }

            if (_config == null || _config.Grupos == null)
            {
                LoadDefaultConfig();
            }

            SaveConfig();
        }

        protected override void SaveConfig()
        {
            Config.WriteObject(_config, true);
        }

        /// <summary>
        /// Config cru vira lista validada e ORDENADA por
        /// prioridade.
        ///
        /// Entrada sem nome de grupo e DESCARTADA: adivinhar o nome
        /// criaria um grupo que ninguem pediu e daria tag por
        /// acidente.
        /// </summary>
        private List<ChatGroup> BuildGroups(PluginConfig config)
        {
            List<ChatGroup> grupos = new List<ChatGroup>();

            if (config == null || config.Grupos == null)
            {
                return grupos;
            }

            HashSet<string> vistos = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            for (int i = 0; i < config.Grupos.Count; i++)
            {
                GroupConfig entrada = config.Grupos[i];

                if (entrada == null)
                {
                    continue;
                }

                string nome = entrada.Nome == null ? null : entrada.Nome.Trim();

                if (string.IsNullOrEmpty(nome))
                {
                    PrintError("Grupo #" + i + " ignorado: sem nome no config.");
                    continue;
                }

                // Nome repetido faria dois formatos brigarem pelo
                // mesmo grupo do Oxide, e quem vence seria a ordem
                // do JSON - que ninguem le como regra.
                if (!vistos.Add(nome))
                {
                    PrintError("Grupo '" + nome + "' aparece mais de uma vez no config. " +
                               "So a primeira entrada vale.");
                    continue;
                }

                grupos.Add(ChatGroup.From(entrada, nome));
            }

            // #### MENOR NUMERO = MAIS FORTE ####
            //
            // E a semantica do BetterChat, mantida de proposito:
            // quem chega com um config de la nao ve o chat inverter
            // sozinho. Esta ordenacao acontece UMA vez, aqui, e por
            // isso o resto do plugin pode tratar "o primeiro da
            // lista" como "o grupo principal".
            grupos.Sort(delegate(ChatGroup a, ChatGroup b)
            {
                return a.Prioridade.CompareTo(b.Prioridade);
            });

            return grupos;
        }

        // ========================================================
        //  LANG
        //
        //  #### POR QUE \uXXXX EM VEZ DE ACENTO DIRETO ####
        //
        //  O fonte e ASCII puro: ele viaja para
        //  Server\oxide\plugins e e recompilado la pelo Oxide, e
        //  byte acentuado dependeria de os dois lados concordarem
        //  sobre a codificacao. O escape resolve isso no
        //  compilador, antes de existir arquivo.
        // ========================================================
        protected override void LoadDefaultMessages()
        {
            lang.RegisterMessages(new Dictionary<string, string>
            {
                { MsgNoPermission, "Voc\u00ea n\u00e3o tem permiss\u00e3o para isso." },
                { MsgGroupCreated, "Grupo '{group}' criado com os padr\u00f5es." },
                { MsgGroupExists, "O grupo '{group}' j\u00e1 existe." },
                { MsgGroupNotFound, "O grupo '{group}' n\u00e3o existe no config." },
                { MsgFieldNotFound, "Campo '{field}' n\u00e3o existe. Dispon\u00edveis: {fields}" },
                { MsgFieldInvalid, "Valor inv\u00e1lido para '{field}': {value}" },
                { MsgFieldSet, "Grupo '{group}': {field} = {value}" },
                { MsgUsageSet, "Uso: origemz.chat.set <grupo> <campo> <valor>" },
                { MsgUsageAddGroup, "Uso: origemz.chat.addgroup <grupo>" }
            }, this);
        }

        // ========================================================
        //  ESTRUTURAS
        // ========================================================

        /// <summary>Um grupo ja validado, em memoria.</summary>
        private class ChatGroup
        {
            public string Nome;
            public int Prioridade;

            public string Tag;
            public string CorDaTag;
            public int TamanhoDaTag;
            public bool TagOculta;
            public bool TagSoNoPrincipal;

            public string CorDoNome;
            public int TamanhoDoNome;

            public string CorDaMensagem;
            public int TamanhoDaMensagem;

            public string FormatoChat;
            public string FormatoConsole;

            public static ChatGroup From(GroupConfig entrada, string nome)
            {
                ChatGroup grupo = new ChatGroup();

                grupo.Nome = nome;
                grupo.Prioridade = entrada.Prioridade;
                grupo.Tag = entrada.Tag == null ? string.Empty : entrada.Tag;
                grupo.CorDaTag = Fallback(entrada.CorDaTag, "#55aaff");
                grupo.TamanhoDaTag = entrada.TamanhoDaTag;
                grupo.TagOculta = entrada.TagOculta;
                grupo.TagSoNoPrincipal = entrada.TagSoNoPrincipal;
                grupo.CorDoNome = Fallback(entrada.CorDoNome, "#55aaff");
                grupo.TamanhoDoNome = entrada.TamanhoDoNome;
                grupo.CorDaMensagem = Fallback(entrada.CorDaMensagem, "white");
                grupo.TamanhoDaMensagem = entrada.TamanhoDaMensagem;
                grupo.FormatoChat = Fallback(entrada.FormatoChat, "{Title} {Username}: {Message}");
                grupo.FormatoConsole = Fallback(entrada.FormatoConsole, "{Title} {Username}: {Message}");

                return grupo;
            }

            /// <summary>
            /// O grupo de quem nao esta em grupo nenhum.
            ///
            /// Ele NAO sai do config e nao pode ser apagado: sem
            /// ele, um jogador fora de todos os grupos ficaria sem
            /// formato e a mensagem sairia crua - ou nao sairia.
            /// </summary>
            public static ChatGroup Fallback()
            {
                ChatGroup grupo = new ChatGroup();

                grupo.Nome = "default";
                grupo.Prioridade = int.MaxValue;
                grupo.Tag = string.Empty;
                grupo.CorDaTag = "#55aaff";
                grupo.TamanhoDaTag = 15;
                grupo.CorDoNome = "#55aaff";
                grupo.TamanhoDoNome = 15;
                grupo.CorDaMensagem = "white";
                grupo.TamanhoDaMensagem = 15;
                grupo.FormatoChat = "{Title} {Username}: {Message}";
                grupo.FormatoConsole = "{Title} {Username}: {Message}";

                return grupo;
            }

            public Dictionary<string, object> ToFields()
            {
                Dictionary<string, object> campos = new Dictionary<string, object>();

                campos["Prioridade"] = Prioridade;
                campos["Tag"] = Tag;
                campos["CorDaTag"] = CorDaTag;
                campos["TamanhoDaTag"] = TamanhoDaTag;
                campos["TagOculta"] = TagOculta;
                campos["TagSoNoPrincipal"] = TagSoNoPrincipal;
                campos["CorDoNome"] = CorDoNome;
                campos["TamanhoDoNome"] = TamanhoDoNome;
                campos["CorDaMensagem"] = CorDaMensagem;
                campos["TamanhoDaMensagem"] = TamanhoDaMensagem;
                campos["FormatoChat"] = FormatoChat;
                campos["FormatoConsole"] = FormatoConsole;

                return campos;
            }

            private static string Fallback(string valor, string padrao)
            {
                return string.IsNullOrEmpty(valor) ? padrao : valor;
            }
        }

        /// <summary>
        /// O JSON de `origemz.chat.broadcast`.
        ///
        /// Os nomes sao em ingles e minusculos porque este e um
        /// PROTOCOLO com o RustAgent, e la o resto da API tambem e
        /// - o portugues fica no config e no que o jogador le.
        /// </summary>
        private class BroadcastPayload
        {
            [JsonProperty("text")]
            public string Text { get; set; }

            [JsonProperty("tag")]
            public string Tag { get; set; }

            [JsonProperty("tagColor")]
            public string TagColor { get; set; }

            [JsonProperty("color")]
            public string Color { get; set; }

            [JsonProperty("size")]
            public int Size { get; set; }

            /// <summary>Vazio = todo mundo. Preenchido = so ele.</summary>
            [JsonProperty("steamId")]
            public string SteamId { get; set; }
        }

        private class PluginConfig
        {
            [JsonProperty("Grupos")]
            public List<GroupConfig> Grupos { get; set; }

            [JsonProperty("Maximo de tags por mensagem")]
            public int MaximoDeTags { get; set; }

            [JsonProperty("Inverter a ordem das tags")]
            public bool InverterOrdemDasTags { get; set; }

            [JsonProperty("Tamanho maximo da mensagem")]
            public int TamanhoMaximoDaMensagem { get; set; }

            /// <summary>
            /// O padrao de um servidor recem-instalado.
            ///
            /// Os nomes dos grupos de VIP sao os MESMOS do config
            /// padrao do OrigemZVip (origemz.vip.bronze/silver/
            /// gold) de proposito: quem instala os dois plugins com
            /// os padroes ve a tag de VIP funcionando sem
            /// configurar nada. Trocou o nome la, troque aqui.
            /// </summary>
            public static PluginConfig Default()
            {
                PluginConfig config = new PluginConfig();

                config.MaximoDeTags = 2;
                config.InverterOrdemDasTags = false;

                // 128 e o teto do proprio chat do Rust. Maior que
                // isso nao chegaria inteiro de qualquer forma.
                config.TamanhoMaximoDaMensagem = 128;

                config.Grupos = new List<GroupConfig>();

                // Prioridade 0 e a mais forte. O espacamento de 10
                // e proposital: um cargo novo no meio entra sem
                // renumerar os outros.
                config.Grupos.Add(new GroupConfig
                {
                    Nome = "admin",
                    Prioridade = 0,
                    Tag = "[ADMIN]",
                    CorDaTag = "#ff5555",
                    TamanhoDaTag = 15,
                    TagSoNoPrincipal = true,
                    CorDoNome = "#ff5555",
                    TamanhoDoNome = 15,
                    CorDaMensagem = "white",
                    TamanhoDaMensagem = 15,
                    FormatoChat = "{Title} {Username}: {Message}",
                    FormatoConsole = "{Title} {Username}: {Message}"
                });

                config.Grupos.Add(new GroupConfig
                {
                    Nome = "origemz.vip.gold",
                    Prioridade = 10,
                    Tag = "[VIP OURO]",
                    CorDaTag = "#ffd700",
                    TamanhoDaTag = 15,
                    TagSoNoPrincipal = true,
                    CorDoNome = "#ffd700",
                    TamanhoDoNome = 15,
                    CorDaMensagem = "white",
                    TamanhoDaMensagem = 15,
                    FormatoChat = "{Title} {Username}: {Message}",
                    FormatoConsole = "{Title} {Username}: {Message}"
                });

                config.Grupos.Add(new GroupConfig
                {
                    Nome = "origemz.vip.silver",
                    Prioridade = 20,
                    Tag = "[VIP PRATA]",
                    CorDaTag = "#c0c0c0",
                    TamanhoDaTag = 15,
                    TagSoNoPrincipal = true,
                    CorDoNome = "#c0c0c0",
                    TamanhoDoNome = 15,
                    CorDaMensagem = "white",
                    TamanhoDaMensagem = 15,
                    FormatoChat = "{Title} {Username}: {Message}",
                    FormatoConsole = "{Title} {Username}: {Message}"
                });

                config.Grupos.Add(new GroupConfig
                {
                    Nome = "origemz.vip.bronze",
                    Prioridade = 30,
                    Tag = "[VIP BRONZE]",
                    CorDaTag = "#cd7f32",
                    TamanhoDaTag = 15,
                    TagSoNoPrincipal = true,
                    CorDoNome = "#cd7f32",
                    TamanhoDoNome = 15,
                    CorDaMensagem = "white",
                    TamanhoDaMensagem = 15,
                    FormatoChat = "{Title} {Username}: {Message}",
                    FormatoConsole = "{Title} {Username}: {Message}"
                });

                // "player" e o grupo que o proprio Oxide cria e em
                // que todo mundo entra. Sem tag: o chat de um
                // servidor em que todos tem tag nao tem tag
                // nenhuma.
                config.Grupos.Add(new GroupConfig
                {
                    Nome = "player",
                    Prioridade = 100,
                    Tag = "",
                    CorDaTag = "#55aaff",
                    TamanhoDaTag = 15,
                    CorDoNome = "#55aaff",
                    TamanhoDoNome = 15,
                    CorDaMensagem = "white",
                    TamanhoDaMensagem = 15,
                    FormatoChat = "{Title} {Username}: {Message}",
                    FormatoConsole = "{Title} {Username}: {Message}"
                });

                return config;
            }
        }

        private class GroupConfig
        {
            [JsonProperty("Grupo do Oxide")]
            public string Nome { get; set; }

            // MENOR = MAIS FORTE. Ver o comentario do Sort em
            // BuildGroups.
            [JsonProperty("Prioridade (menor = mais forte)")]
            public int Prioridade { get; set; }

            [JsonProperty("Tag")]
            public string Tag { get; set; }

            [JsonProperty("Cor da tag")]
            public string CorDaTag { get; set; }

            [JsonProperty("Tamanho da tag")]
            public int TamanhoDaTag { get; set; }

            [JsonProperty("Esconder a tag")]
            public bool TagOculta { get; set; }

            [JsonProperty("Mostrar a tag so quando for o grupo principal")]
            public bool TagSoNoPrincipal { get; set; }

            [JsonProperty("Cor do nome")]
            public string CorDoNome { get; set; }

            [JsonProperty("Tamanho do nome")]
            public int TamanhoDoNome { get; set; }

            [JsonProperty("Cor da mensagem")]
            public string CorDaMensagem { get; set; }

            [JsonProperty("Tamanho da mensagem")]
            public int TamanhoDaMensagem { get; set; }

            [JsonProperty("Formato no chat")]
            public string FormatoChat { get; set; }

            [JsonProperty("Formato no console")]
            public string FormatoConsole { get; set; }

            public static GroupConfig Padrao(string nome)
            {
                GroupConfig entrada = new GroupConfig();

                entrada.Nome = nome;
                entrada.Prioridade = 50;
                entrada.Tag = "[" + nome + "]";
                entrada.CorDaTag = "#55aaff";
                entrada.TamanhoDaTag = 15;
                entrada.CorDoNome = "#55aaff";
                entrada.TamanhoDoNome = 15;
                entrada.CorDaMensagem = "white";
                entrada.TamanhoDaMensagem = 15;
                entrada.FormatoChat = "{Title} {Username}: {Message}";
                entrada.FormatoConsole = "{Title} {Username}: {Message}";

                return entrada;
            }

            public static string CamposDisponiveis()
            {
                return "Prioridade, Tag, CorDaTag, TamanhoDaTag, TagOculta, TagSoNoPrincipal, " +
                       "CorDoNome, TamanhoDoNome, CorDaMensagem, TamanhoDaMensagem, " +
                       "FormatoChat, FormatoConsole";
            }

            /// <summary>
            /// Muda um campo por nome. "OK", "CAMPO_NAO_EXISTE" ou
            /// "VALOR_INVALIDO".
            ///
            /// A tabela e um `switch` de proposito: um dicionario
            /// de delegates seria mais curto e esconderia o tipo de
            /// cada campo, que e justamente o que precisa ficar
            /// visivel para quem acrescenta um campo novo.
            /// </summary>
            public string SetField(string campo, string valor)
            {
                if (string.IsNullOrEmpty(campo))
                {
                    return "CAMPO_NAO_EXISTE";
                }

                string nome = campo.Trim().ToLowerInvariant();
                int numero;
                bool booleano;

                switch (nome)
                {
                    case "prioridade":
                        if (!int.TryParse(valor, out numero)) return "VALOR_INVALIDO";
                        Prioridade = numero;
                        return "OK";

                    case "tag":
                        Tag = valor;
                        return "OK";

                    case "cordatag":
                        CorDaTag = valor;
                        return "OK";

                    case "tamanhodatag":
                        if (!int.TryParse(valor, out numero)) return "VALOR_INVALIDO";
                        TamanhoDaTag = numero;
                        return "OK";

                    case "tagoculta":
                        if (!bool.TryParse(valor, out booleano)) return "VALOR_INVALIDO";
                        TagOculta = booleano;
                        return "OK";

                    case "tagsonoprincipal":
                        if (!bool.TryParse(valor, out booleano)) return "VALOR_INVALIDO";
                        TagSoNoPrincipal = booleano;
                        return "OK";

                    case "cordonome":
                        CorDoNome = valor;
                        return "OK";

                    case "tamanhodonome":
                        if (!int.TryParse(valor, out numero)) return "VALOR_INVALIDO";
                        TamanhoDoNome = numero;
                        return "OK";

                    case "cordamensagem":
                        CorDaMensagem = valor;
                        return "OK";

                    case "tamanhodamensagem":
                        if (!int.TryParse(valor, out numero)) return "VALOR_INVALIDO";
                        TamanhoDaMensagem = numero;
                        return "OK";

                    case "formatochat":
                        FormatoChat = valor;
                        return "OK";

                    case "formatoconsole":
                        FormatoConsole = valor;
                        return "OK";
                }

                return "CAMPO_NAO_EXISTE";
            }
        }
    }
}

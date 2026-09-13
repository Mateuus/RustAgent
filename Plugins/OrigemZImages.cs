// ============================================================
//  OrigemZImages.cs
//
//  A biblioteca de imagens da rede. Guarda no FileStorage do
//  servidor os PNG/JPEG que o RustAgent manda, e entrega o CRC de
//  cada um aos outros plugins - o OrigemZUI (menu e propagandas) e
//  o OrigemZItems (icone de item custom).
//
//  Contrato do outro lado:
//      RustAgent\core\src\game\image-library.ts
//
//  ------------------------------------------------------------
//  ####  POR QUE UM PLUGIN SO PARA ISTO  ####
//
//  Antes havia TRES copias do mesmo mecanismo: `origemz.ui.image`,
//  `origemz.ads.image.*` e `origemz.item.icon*`. Cada uma com o
//  seu mapa chave->CRC, o seu teto e o seu fatiamento - e cada
//  defeito corrigido numa continuava vivo nas outras duas.
//
//  E o desenho do ImageLibrary (Absolut & K1lly0u): um dono das
//  imagens, que os outros consultam por Call("GetImage"). O que
//  ficou de fora dele, de proposito:
//
//   - baixar URL daqui de dentro. Quem baixa e confere e o agente,
//     que tem timeout, teto e teste. O ImageLibrary baixa sem
//     timeout, um de cada vez, e uma URL lenta trava a fila de
//     todos os plugins;
//   - recodificar tudo em PNG. Isso infla o JPEG que cada jogador
//     vai baixar e trava o tick decodificando na thread principal;
//   - CDN de terceiro (imgur, rusthelp, GitHub). Icone de item do
//     jogo o CUI ja desenha por `itemid`, sem download nenhum.
//
//  ------------------------------------------------------------
//  ####  O CLIENTE BAIXA UMA VEZ  ####
//
//  O que viaja no CUI (campo `png`) ou no item (iconImageId) sao
//  os QUATRO BYTES do CRC, nunca o arquivo. O cliente pede os
//  bytes pelo canal do jogo so na primeira vez que ve um CRC, e o
//  CRC nasce do CONTEUDO: imagem igual, mesmo numero; imagem
//  trocada, numero novo. Nao ha versao a incrementar.
//
//  ------------------------------------------------------------
//  ####  O MAPA SOBREVIVE AO RELOAD, E SO A ELE  ####
//
//  Os bytes ja moram no FileStorage, que e do SAVE. O que se perdia
//  num `oxide.reload` era so a tabela chave->CRC, e a tela ficava
//  com o quadrado vazio ate o agente reenviar. Agora a tabela vai
//  para oxide\data e volta no boot do plugin.
//
//  Ela so volta se a CommunityEntity for a MESMA: o FileStorage
//  indexa cada arquivo pelo id da entidade dona, e com outro id o
//  CRC antigo nao acha mais nada. Nesse caso a tabela e descartada
//  e o agente reenvia - ele tem os originais. (O ImageLibrary lia
//  o banco do save anterior por SQLite para salvar os bytes; aqui
//  isso nao compra nada.)
//
//  ------------------------------------------------------------
//  Nada de sintaxe acima de C# 6. O compilador em tempo de
//  execucao do Oxide para nesse teto - sem "out var", sem tupla,
//  sem funcao local, sem pattern matching.
// ============================================================

using System;
using System.Collections.Generic;
using System.Globalization;
using Newtonsoft.Json;

// Interface.Oxide.DataFileSystem (a tabela em disco) e
// Interface.CallHook (o aviso de imagem guardada).
using Oxide.Core;

// [HookMethod] mora em Oxide.Core.Plugins, e nao em Oxide.Plugins.
// Ver o mesmo comentario no OrigemZAgent.cs.
using Oxide.Core.Plugins;

namespace Oxide.Plugins
{
    [Info("OrigemZImages", "OrigemZ", "0.1.0")]
    [Description("Guarda no FileStorage do servidor as imagens que o RustAgent manda e entrega o CRC aos outros plugins.")]
    public class OrigemZImages : RustPlugin
    {
        // ========================================================
        //  COMANDOS
        //
        //  Todos so do console do servidor / RCON. Um jogador que
        //  digitasse `origemz.image.forget *` no F1 apagaria as
        //  imagens de todo mundo.
        // ========================================================

        /// <summary>`origemz.image.begin chave partes bytes sha`</summary>
        private const string BeginCommand = "origemz.image.begin";

        /// <summary>`origemz.image.part chave indice base64`</summary>
        private const string PartCommand = "origemz.image.part";

        /// <summary>`origemz.image.end chave`</summary>
        private const string EndCommand = "origemz.image.end";

        /// <summary>`origemz.image.list` - o manifesto chave->sha.</summary>
        private const string ListCommand = "origemz.image.list";

        /// <summary>`origemz.image.forget chave|*` - esquece o mapa, nao os bytes.</summary>
        private const string ForgetCommand = "origemz.image.forget";

        /// <summary>
        /// O aviso aos outros plugins: a imagem `chave` ficou pronta.
        ///
        /// Assinatura: OnOrigemZImageStored(string key, uint crc).
        /// E o `callback` do ImageLibrary, so que por hook: quem
        /// desenhou antes de a imagem chegar sabe que pode redesenhar.
        /// </summary>
        private const string StoredHook = "OnOrigemZImageStored";

        private const string DataFile = "OrigemZImages";

        // ========================================================
        //  TETOS
        // ========================================================

        /// <summary>
        /// Maior imagem aceita, em bytes de arquivo.
        ///
        /// 3 MiB e o teto de transferencia de arquivo do FileStorage
        /// para o cliente - o numero que o ImageLibrary ja aplicava
        /// (3145728). Acima disso o CRC existiria e o cliente nao
        /// receberia os bytes: um quadrado vazio que parece sucesso.
        /// </summary>
        private const int MaxBytes = 3 * 1024 * 1024;

        /// <summary>
        /// Quantos pedacos um envio pode ter.
        ///
        /// O agente fatia em 27 KB (o frame do WebRCON aguenta ~50
        /// KB e o base64 infla 4/3). 3 MiB / 27 KB da 117 - o teto e
        /// isso com folga. Ele existe para um `begin` com numero
        /// absurdo nao alocar um array gigante antes do primeiro byte.
        /// </summary>
        private const int MaxParts = 128;

        /// <summary>
        /// Chave: minusculas, digitos, ponto, hifen e sublinhado.
        ///
        /// Ela viaja em comando de console, separado por ESPACO, e
        /// dentro do lugar reservado `{img:chave}` do OrigemZUI -
        /// onde `}` fecharia o lugar no meio da chave.
        /// </summary>
        private const int MaxKeyLength = 80;

        /// <summary>O sha256 que o agente manda, em hex.</summary>
        private const int MaxShaLength = 64;

        /// <summary>
        /// Versao da superficie de hook.
        ///
        /// A chamada e por string dos dois lados; renomear um metodo
        /// daqui so falharia em runtime. Mudanca incompativel sobe
        /// este numero, e o consumidor pode le-lo no boot.
        /// </summary>
        private const int ApiVersion = 1;

        // ========================================================
        //  ESTADO
        // ========================================================

        private class StoredImage
        {
            public uint Crc;
            /// <summary>O sha256 do conteudo, como o agente o calculou.</summary>
            public string Sha;
            public int Bytes;
        }

        private class StoredData
        {
            /// <summary>
            /// O id da CommunityEntity quando a tabela foi gravada.
            ///
            /// E o que diz se os CRC ainda valem - ver o cabecalho.
            /// </summary>
            public ulong EntityId;

            public Dictionary<string, StoredImage> Images = new Dictionary<string, StoredImage>();
        }

        private class Upload
        {
            public byte[][] Parts;
            /// <summary>Quantos bytes o `begin` prometeu.</summary>
            public int Bytes;
            public string Sha;
        }

        private class ListResponse
        {
            [JsonProperty("ok")] public bool Ok;
            [JsonProperty("ready")] public bool Ready;
            [JsonProperty("images")] public Dictionary<string, string> Images;
        }

        /// <summary>Chave -> a imagem guardada.</summary>
        private readonly Dictionary<string, StoredImage> _images = new Dictionary<string, StoredImage>();

        /// <summary>
        /// Os envios em curso, ate o `end`.
        ///
        /// Meio arquivo nunca vira imagem: o `end` confere a
        /// contagem e o tamanho antes de guardar. Um PNG cortado no
        /// meio ganharia um CRC valido para um arquivo que o cliente
        /// nao monta - o pior desfecho, porque parece que deu certo.
        /// </summary>
        private readonly Dictionary<string, Upload> _uploads = new Dictionary<string, Upload>();

        /// <summary>
        /// A tabela ja foi lida do disco?
        ///
        /// Antes disso o manifesto responde `ready:false` e o agente
        /// espera: mandar bytes para um mapa que ainda vai ser
        /// sobrescrito pelo disco seria perde-los.
        /// </summary>
        private bool _restored;

        // ========================================================
        //  CICLO DE VIDA
        // ========================================================

        private void OnServerInitialized()
        {
            // Aqui, e nao no Loaded: a CommunityEntity so existe com o
            // servidor de pe, e sem ela nao ha como conferir se a
            // tabela em disco ainda vale. Plugin carregado DEPOIS do
            // boot tambem passa por aqui - o Oxide chama o hook para
            // quem chega atrasado.
            Restore();
            _restored = true;
        }

        private void Unload()
        {
            if (_restored)
            {
                Save();
            }

            _uploads.Clear();
        }

        /// <summary>
        /// Le a tabela do disco e fica so com o que ainda vale.
        ///
        /// NUNCA lanca: uma tabela ilegivel custa um reenvio do
        /// agente, e nao pode custar o plugin.
        /// </summary>
        private void Restore()
        {
            CommunityEntity community = CommunityEntity.ServerInstance;

            if (community == null || community.net == null)
            {
                return;
            }

            ulong entityId = community.net.ID.Value;
            StoredData data = null;

            try
            {
                data = Interface.Oxide.DataFileSystem.ReadObject<StoredData>(DataFile);
            }
            catch (Exception ex)
            {
                PrintWarning("nao consegui ler oxide\\data\\" + DataFile + ".json; o agente reenvia as imagens: " + ex.Message);
            }

            if (data == null || data.Images == null || data.Images.Count == 0)
            {
                return;
            }

            if (data.EntityId != entityId)
            {
                // O save mudou (wipe, ou servidor novo). Os CRC antigos
                // apontam para arquivos de outra entidade.
                Puts("a CommunityEntity mudou (" + data.EntityId + " -> " + entityId +
                     "); " + data.Images.Count + " imagem(ns) descartada(s), o agente reenvia");
                Save();
                return;
            }

            int kept = 0;
            int dropped = 0;

            foreach (KeyValuePair<string, StoredImage> entry in data.Images)
            {
                StoredImage image = entry.Value;

                // O mapa diz que existe; o FileStorage e quem sabe. Um
                // CRC sem arquivo desenharia o quadrado vazio sem nada
                // dizendo por que - melhor esquecer e deixar o agente
                // reenviar.
                if (image != null && IsValidKey(entry.Key) &&
                    FileStorage.server.Get(image.Crc, FileStorage.Type.png, community.net.ID) != null)
                {
                    _images[entry.Key] = image;
                    kept++;
                }
                else
                {
                    dropped++;
                }
            }

            Puts(kept + " imagem(ns) de volta do disco" +
                 (dropped > 0 ? ", " + dropped + " sem arquivo no FileStorage (o agente reenvia)" : ""));
        }

        private void Save()
        {
            CommunityEntity community = CommunityEntity.ServerInstance;

            StoredData data = new StoredData();
            data.EntityId = community == null || community.net == null ? 0UL : community.net.ID.Value;
            data.Images = new Dictionary<string, StoredImage>(_images);

            try
            {
                Interface.Oxide.DataFileSystem.WriteObject(DataFile, data);
            }
            catch (Exception ex)
            {
                // Nao gravar custa um reenvio no proximo reload. Nao e
                // motivo para derrubar o envio que acabou de dar certo.
                PrintWarning("nao consegui gravar oxide\\data\\" + DataFile + ".json: " + ex.Message);
            }
        }

        // ========================================================
        //  O ENVIO, EM PEDACOS
        // ========================================================

        [ConsoleCommand(BeginCommand)]
        private void CmdBegin(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            if (!arg.HasArgs(4))
            {
                arg.ReplyWith(Error("INVALID_ARGS"));
                return;
            }

            string key = arg.GetString(0, "");
            int parts = arg.GetInt(1, 0);
            int bytes = arg.GetInt(2, 0);
            string sha = arg.GetString(3, "");

            if (!IsValidKey(key) || parts <= 0 || parts > MaxParts || bytes <= 0 || !IsValidSha(sha))
            {
                arg.ReplyWith(Error("INVALID_ARGS"));
                return;
            }

            if (bytes > MaxBytes)
            {
                // Recusado, e nao cortado: ver MaxBytes.
                arg.ReplyWith(Error("IMAGE_TOO_LARGE"));
                return;
            }

            if (!IsServerReady())
            {
                // Recusar ANTES dos pedacos poupa o agente de mandar
                // megabytes que o `end` jogaria fora.
                arg.ReplyWith(Error("SERVER_NOT_READY"));
                return;
            }

            Upload upload = new Upload();
            upload.Parts = new byte[parts][];
            upload.Bytes = bytes;
            upload.Sha = sha;

            // Um `begin` repetido para a mesma chave recomeca do zero:
            // e o agente que reiniciou no meio de um envio.
            _uploads[key] = upload;

            arg.ReplyWith("{\"ok\":true}");
        }

        [ConsoleCommand(PartCommand)]
        private void CmdPart(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            if (!arg.HasArgs(3))
            {
                arg.ReplyWith(Error("INVALID_ARGS"));
                return;
            }

            string key = arg.GetString(0, "");
            int index = arg.GetInt(1, -1);

            Upload upload;

            if (!_uploads.TryGetValue(key, out upload))
            {
                // Chegou sem o `begin`: o agente reiniciou no meio, ou
                // a ordem se perdeu. A proxima sincronizacao recomeca.
                arg.ReplyWith(Error("NO_BEGIN"));
                return;
            }

            if (index < 0 || index >= upload.Parts.Length)
            {
                arg.ReplyWith(Error("BAD_INDEX"));
                return;
            }

            try
            {
                upload.Parts[index] = Convert.FromBase64String(arg.GetString(2, ""));
            }
            catch (FormatException)
            {
                arg.ReplyWith(Error("INVALID_BASE64"));
                return;
            }

            arg.ReplyWith("{\"ok\":true}");
        }

        [ConsoleCommand(EndCommand)]
        private void CmdEnd(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            try
            {
                string key = arg.GetString(0, "");
                Upload upload;

                if (!_uploads.TryGetValue(key, out upload))
                {
                    arg.ReplyWith(Error("NO_BEGIN"));
                    return;
                }

                _uploads.Remove(key);

                // ####  FALTOU PEDACO OU SOBROU BYTE: DESCARTA  ####
                //
                // Ver `_uploads`. A contagem de pedacos pega o pedaco
                // perdido; o tamanho pega o pedaco trocado.
                int total = 0;

                for (int i = 0; i < upload.Parts.Length; i++)
                {
                    if (upload.Parts[i] == null)
                    {
                        PrintWarning("imagem " + key + ": faltou o pedaco " + i + ", descartada");
                        arg.ReplyWith(Error("MISSING_PART"));
                        return;
                    }

                    total += upload.Parts[i].Length;
                }

                if (total != upload.Bytes)
                {
                    PrintWarning("imagem " + key + ": chegaram " + total + " bytes e o begin prometeu " +
                                 upload.Bytes + ", descartada");
                    arg.ReplyWith(Error("SIZE_MISMATCH"));
                    return;
                }

                byte[] bytes = new byte[total];
                int offset = 0;

                for (int i = 0; i < upload.Parts.Length; i++)
                {
                    Buffer.BlockCopy(upload.Parts[i], 0, bytes, offset, upload.Parts[i].Length);
                    offset += upload.Parts[i].Length;
                }

                // ####  SO PNG E JPEG  ####
                //
                // E o que o cliente monta. O ImageLibrary guardava o
                // que viesse - uma pagina de erro em HTML virava
                // "imagem" com CRC valido. Aqui a assinatura do
                // arquivo e conferida antes.
                if (!IsPng(bytes) && !IsJpeg(bytes))
                {
                    arg.ReplyWith(Error("INVALID_IMAGE"));
                    return;
                }

                if (!IsServerReady())
                {
                    arg.ReplyWith(Error("SERVER_NOT_READY"));
                    return;
                }

                // `Type.png` vale para o JPEG tambem: o tipo so escolhe
                // a tabela, e o cliente decodifica pelos bytes.
                uint crc = FileStorage.server.Store(bytes, FileStorage.Type.png, CommunityEntity.ServerInstance.net.ID);

                StoredImage image = new StoredImage();
                image.Crc = crc;
                image.Sha = upload.Sha;
                image.Bytes = total;

                _images[key] = image;
                Save();

                Puts("imagem " + key + ": " + total.ToString(CultureInfo.InvariantCulture) +
                     " bytes em " + upload.Parts.Length + " pedaco(s), crc " +
                     crc.ToString(CultureInfo.InvariantCulture));

                // Depois de gravar e de responder nada pode dar errado
                // por causa de quem ouve o hook: o Oxide isola a
                // excecao de cada plugin.
                Interface.CallHook(StoredHook, key, crc);

                arg.ReplyWith("{\"ok\":true,\"crc\":" + crc.ToString(CultureInfo.InvariantCulture) + "}");
            }
            catch (Exception ex)
            {
                PrintError(EndCommand + " falhou: " + ex);
                arg.ReplyWith(Error("INTERNAL_ERROR"));
            }
        }

        // ========================================================
        //  O MANIFESTO
        //
        //  E o `HasImage` do ImageLibrary virado protocolo: o agente
        //  pergunta o que ja esta aqui e manda so o que falta ou
        //  mudou. Antes as imagens do menu subiam inteiras a cada
        //  sincronizacao, de cinco em cinco minutos.
        //
        //  Cabe no frame do RCON com folga: cada entrada tem ~150
        //  caracteres, e a rede tem dezenas de imagens, nao
        //  centenas.
        // ========================================================
        [ConsoleCommand(ListCommand)]
        private void CmdList(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            ListResponse response = new ListResponse();
            response.Ok = true;
            response.Ready = _restored && IsServerReady();
            response.Images = new Dictionary<string, string>();

            if (response.Ready)
            {
                foreach (KeyValuePair<string, StoredImage> entry in _images)
                {
                    response.Images[entry.Key] = entry.Value.Sha ?? "";
                }
            }

            arg.ReplyWith(JsonConvert.SerializeObject(response));
        }

        /// <summary>
        /// Esquece uma chave (ou `*` para todas).
        ///
        /// So o MAPA: os bytes continuam no FileStorage. Serve para
        /// forcar o agente a reenviar - na proxima sincronizacao o
        /// manifesto nao tem a chave e ela sobe de novo.
        /// </summary>
        [ConsoleCommand(ForgetCommand)]
        private void CmdForget(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            string key = arg.GetString(0, "");
            int forgotten = 0;

            if (key == "*")
            {
                forgotten = _images.Count;
                _images.Clear();
                _uploads.Clear();
            }
            else if (_images.Remove(key))
            {
                forgotten = 1;
            }

            if (forgotten > 0)
            {
                Save();
            }

            arg.ReplyWith("{\"ok\":true,\"forgotten\":" + forgotten + "}");
        }

        // ========================================================
        //  SUPERFICIE DE HOOK
        //
        //  Consumida por outro plugin com [PluginReference] +
        //  Call("Nome", ...). Nada aqui lanca: excecao que sobe de
        //  um HookMethod vira null para quem chamou.
        // ========================================================

        [HookMethod(nameof(GetApiVersion))]
        private int GetApiVersion()
        {
            return ApiVersion;
        }

        /// <summary>
        /// O CRC da imagem, ou 0 quando ela nao esta aqui.
        ///
        /// 0 e o "nao tenho" porque o FileStorage nunca devolve 0
        /// para um arquivo guardado, e porque e o valor que o
        /// consumidor ja trata (iconImageId 0 = icone do item base).
        /// </summary>
        [HookMethod(nameof(GetImage))]
        private uint GetImage(string key)
        {
            if (string.IsNullOrEmpty(key))
            {
                return 0U;
            }

            StoredImage image;
            return _images.TryGetValue(key, out image) ? image.Crc : 0U;
        }

        [HookMethod(nameof(HasImage))]
        private bool HasImage(string key)
        {
            return GetImage(key) != 0U;
        }

        // ========================================================
        //  AUXILIARES
        // ========================================================

        private static bool IsServerReady()
        {
            return CommunityEntity.ServerInstance != null && CommunityEntity.ServerInstance.net != null;
        }

        private static bool IsValidKey(string key)
        {
            if (string.IsNullOrEmpty(key) || key.Length > MaxKeyLength)
            {
                return false;
            }

            for (int i = 0; i < key.Length; i++)
            {
                char c = key[i];
                bool alnum = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');

                if (i == 0 ? !alnum : !(alnum || c == '.' || c == '-' || c == '_'))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool IsValidSha(string sha)
        {
            if (string.IsNullOrEmpty(sha) || sha.Length > MaxShaLength)
            {
                return false;
            }

            for (int i = 0; i < sha.Length; i++)
            {
                char c = sha[i];

                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool IsPng(byte[] bytes)
        {
            return bytes.Length >= 8 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47;
        }

        private static bool IsJpeg(byte[] bytes)
        {
            return bytes.Length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF;
        }

        private static string Error(string code)
        {
            return "{\"ok\":false,\"error\":\"" + code + "\"}";
        }
    }
}

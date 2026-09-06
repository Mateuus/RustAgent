using Facepunch;
using HarmonyLib;
using Network;
using Newtonsoft.Json;
using Oxide.Core;
using Oxide.Core.Libraries;
using Oxide.Core.Plugins;
using Oxide.Game.Rust.Cui;
using Oxide.Plugins.CustomItemDefinitionExtensions;
using SilentOrbit.ProtocolBuffers;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Text;
using System.Text.RegularExpressions;
using UnityEngine;
using static Oxide.Plugins.CustomItemDefinitions;

#region Library
namespace Oxide.Plugins
{
    [Info("CustomItemDefinitions", "0xF // dsc.gg/0xf-plugins", "2.5.4")]
    [Description("Library of the Future. Allows you to create your own full-fledged custom items with own item definition.")]
    public class CustomItemDefinitions : RustPlugin
    {
        #region Consts
        public const ItemDefinition.Flag CUSTOM_DEFINITION_FLAG = (ItemDefinition.Flag)128;
        private static readonly ItemDefinition FallbackItemDefinition = ItemManager.FindItemDefinition("batteringram.head.repair");
        private static readonly Regex regexNumeric = new Regex(@"^-?[0-9]+$");
        #endregion

        #region Dto Class
        [Obsolete("This class name is obsolete; Oxide.Plugins.ItemDefinitionDto is now used.")]
        public class CustomItemDefinition : ItemDefinitionDto { }
        #endregion

        #region Variables
        private static CustomItemDefinitions PluginInstance;
        private static Dictionary<int, ItemDefinition> ExistingDefinitions;
        private static Dictionary<int, int> parentMap;
        private static uint fallbackItemIcon;

        private DataFileSystem fs = new DataFileSystem($"{Interface.Oxide.DataDirectory}\\{nameof(CustomItemDefinitions)}");

        private static AccessTools.FieldRef<NetWrite, BufferStream> NetWriteGetBufferStream = AccessTools.FieldRefAccess<NetWrite, BufferStream>(AccessTools.Field("Network.NetWrite:stream"));
        private static AccessTools.FieldRef<Plugin, Lang> PluginGetLang = AccessTools.FieldRefAccess<Plugin, Lang>(AccessTools.Field(typeof(RustPlugin), "lang"));
        private static MethodInfo PluginGetHarmonyInstance = AccessTools.PropertyGetter(typeof(CSPlugin), "HarmonyInstance");
#if OXIDE
        private static AccessTools.FieldRef<Lang, Dictionary<string, Dictionary<string, string>>> LangGetLangFiles = AccessTools.FieldRefAccess<Lang, Dictionary<string, Dictionary<string, string>>>(AccessTools.Field(typeof(Lang), "langFiles"));
#endif

        private static ProtoBuf.Item.InstanceData BlueprintInstanceData = new ProtoBuf.Item.InstanceData()
        {
            ShouldPool = false,
            blueprintTarget = 1394042569
        };
        private const ulong BlueprintBaseIconSkinId = 3530644207;

        #endregion

        #region Hooks
        void Init()
        {
            PluginInstance = this;
            LoadData();

            CacheAlreadyCreated();

            Patcher patcher = new Patcher(this, this.HarmonyInstance);
            patcher.PatchNestedClasses();
            patcher.PatchWriteToStreamClass();
        }

        void OnServerInitialized(bool initial)
        {
            LoadFallbackItemIcon();
        }

        void Loaded()
        {
            CallLibraryLoadedHookGlobal();
        }

        void OnPluginLoaded(Plugin plugin)
        {
            CallLibraryLoadedHook(plugin);
        }

        void OnServerSave()
        {
            SaveData();
        }

        private void CallLibraryLoadedHookGlobal()
        {
            foreach (Plugin plugin in Interface.Oxide.RootPluginManager.GetPlugins())
                CallLibraryLoadedHook(plugin);
        }

        private void CallLibraryLoadedHook(Plugin plugin)
        {
            if (!PluginContext.Array.TryGetFromCache(plugin, out _))
                plugin.CallHook("OnCIDLoaded", this);
        }

        private void Unload()
        {
            using (PooledArray<PluginContext> array = PluginContext.All.ToPooledArray())
            {
                foreach (IDisposable disposable in array.Array)
                    disposable?.Dispose();
            }

            SaveData();

            Interface.Oxide.CallHook("OnCIDUnloaded");
        }

        private void OnEntitySaved(BaseNetworkable entity, BaseNetworkable.SaveInfo saveInfo)
        {
            try
            {
                Mutate.ToClientSide(saveInfo.msg, saveInfo.forConnection);
            }
            catch (Exception ex)
            {
                ProtoWriteToStream.LibraryFinalizer(ex);
            }
        }

        void OnLootNetworkUpdate(PlayerLoot loot)
        {
            RepairBench repairBench = loot.entitySource as RepairBench;
            if (repairBench == null)
                return;

            Item repairableItem = repairBench.inventory?.GetSlot(0);
            if (repairableItem == null)
                return;

            ItemDefinition itemDefinition = repairableItem.info;
            if (!itemDefinition.Blueprint || !itemDefinition.condition.repairable)
                return;

            BasePlayer player = loot.baseEntity;
            if (IsValidCID(itemDefinition) && player.blueprints.HasUnlocked(itemDefinition))
                SendFakeUnlockedBlueprint(player, repairableItem.info.Parent.itemid);
            else
                player.SendNetworkUpdateImmediate();
        }

        object OnItemCraft(IndustrialCrafter crafter, ItemBlueprint blueprint)
        {
            if (IsValidCID(blueprint.targetItem) && !blueprint.userCraftable)
                return false;
            return null;
        }

        void OnPlayerLanguageChanged(BasePlayer player)
        {
            PlayerLanguages.OnPlayerLanguageChanged(player.userID);

            {
                player.inventory.containerBelt.dirty = true;
                player.inventory.containerMain.dirty = true;
                player.inventory.containerWear.dirty = true;
            }
        }

        private static void OnItemDefinitionBroken(Item item, ProtoBuf.Item protoItem)
        {
            UnityEngine.Debug.LogWarning("Item has broken definition, the fallback item definition will be applied to it.");

            ItemDefinition definitionToClone = null;
            if (parentMap != null && parentMap.TryGetValue(protoItem.itemid, out int parentItemID))
                definitionToClone = ItemManager.FindItemDefinition(parentItemID);
            definitionToClone ??= FallbackItemDefinition;

            ItemDefinition definition = GetOrCloneDefinition(protoItem.itemid, definitionToClone);
            definition.itemid = protoItem.itemid;
            ClearItemMods(definition);
            definition.Initialize(ItemManager.itemList);
            item.info = definition;
        }

        protected override void LoadDefaultMessages()
        {
            lang.RegisterMessages(new Dictionary<string, string>
            {
                ["itemownership.description.phrase"] = "ITEM DESCRIPTION",
            }, this);
            lang.RegisterMessages(new Dictionary<string, string>
            {
                ["itemownership.description.phrase"] = "DESCRIPCIÓN DEL ARTÍCULO",
            }, this, "es-ES");
            lang.RegisterMessages(new Dictionary<string, string>
            {
                ["itemownership.description.phrase"] = "ОПИСАНИЕ ПРЕДМЕТА",
            }, this, "ru");
            lang.RegisterMessages(new Dictionary<string, string>
            {
                ["itemownership.description.phrase"] = "ОПИС ПРЕДМЕТУ",
            }, this, "uk");
            lang.RegisterMessages(new Dictionary<string, string>
            {
                ["itemownership.description.phrase"] = "項目説明",
            }, this, "ja");
            lang.RegisterMessages(new Dictionary<string, string>
            {
                ["itemownership.description.phrase"] = "项目描述",
            }, this, "zh-CN");
            lang.RegisterMessages(new Dictionary<string, string>
            {
                ["itemownership.description.phrase"] = "項目描述",
            }, this, "zh-TW");
            lang.RegisterMessages(new Dictionary<string, string>
            {
                ["itemownership.description.phrase"] = "항목 설명",
            }, this, "ko");
        }
        #endregion

        #region Commands
        [ConsoleCommand("itemid")]
        private void itemid(ConsoleSystem.Arg arg)
        {
            if (!arg.IsAdmin)
                return;

            string shortname = arg.GetString(0);
            if (string.IsNullOrEmpty(shortname))
                return;

            ItemDefinition itemDefinition = ItemManager.FindItemDefinition(shortname);
            if (itemDefinition == null)
            {
                arg.ReplyWith("Item definion for the specified short name was not found.");
                return;
            }

            arg.ReplyWith(itemDefinition.itemid);
        }

        [ConsoleCommand("shortname")]
        private void shortname(ConsoleSystem.Arg arg)
        {
            if (!arg.IsAdmin)
                return;

            int itemId = arg.GetInt(0);
            if (itemId == default)
                return;

            ItemDefinition itemDefinition = ItemManager.FindItemDefinition(itemId);
            if (itemDefinition == null)
            {
                arg.ReplyWith("Item definion for the specified item id was not found.");
                return;
            }

            arg.ReplyWith(itemDefinition.shortname);
        }
        #endregion

        #region Classes
        public class PluginContext : IDisposable
        {
            private Plugin plugin;
            private HashSet<ItemDefinition> definitions;

            private PluginContext(Plugin plugin)
            {
                this.plugin = plugin;
                this.definitions = new HashSet<ItemDefinition>();
            }

            public bool ContainsDefinition(ItemDefinition definition)
            {
                return definitions.Contains(definition);
            }

            public HashSet<ItemDefinition> RegisterDefinitions(IEnumerable<ItemDefinitionDto> dtos)
            {
                HashSet<ItemDefinition> hashSet = new HashSet<ItemDefinition>();
                foreach (var dto in dtos)
                {
                    ItemDefinition result = RegisterDefinition(dto);
                    if (result != null)
                        hashSet.Add(result);
                };
                return hashSet;
            }

            public ItemDefinition RegisterDefinition(ItemDefinitionDto dto)
            {
                dto.FillEmptyValues();
                dto.Validate(plugin);

                int itemId = dto.itemId.Value;
                ItemDefinition parent = dto.ParentDefinition;

                ItemDefinition @new = GetOrCloneDefinition(itemId, parent);
                if (@new == null)
                    throw new Exception(string.Format("Error by the plugin \"{0}\": Failure to create or search for a new item definition ({1})!", plugin.Name, dto.shortname));

                SettingDefinitionFields(@new, dto);
                SetNameAndDescription(@new, dto, plugin);
                SaveDefaultIds(@new, dto);

                ClearItemMods(@new);
                MakeNewMods(dto, @new);

                ConfigureBlueprint(dto, parent, @new);
                SettingStaticOwnerships(dto, plugin, @new);

                AddServerTranslationPhrases(dto, plugin);
                AddDefinitionToCollections(@new);

                definitions.Add(@new);
                parentMap[itemId] = parent.itemid;

                Interface.Oxide.CallHook("OnItemDefinitionRegistered", @new);
                return @new;

                static void ConfigureBlueprint(ItemDefinitionDto definition, ItemDefinition parent, ItemDefinition @new)
                {
                    bool needsBlueprint = definition.craftable || definition.repairable;
                    if (!@new.TryGetComponent(out ItemBlueprint blueprint))
                    {
                        if (!needsBlueprint)
                            return;
                        blueprint = @new.gameObject.AddComponent<ItemBlueprint>();
                    }

                    if (!needsBlueprint)
                    {
                        UnityEngine.Object.Destroy(blueprint);
                        return;
                    }

                    List<ItemAmount> ingredients;
                    if (definition.blueprintIngredients != null && definition.blueprintIngredients.Count > 0)
                        ingredients = definition.blueprintIngredients;
                    else
                        ingredients = parent.Blueprint?.ingredients ?? new List<ItemAmount>();

                    blueprint.defaultBlueprint = definition.defaultBlueprintUnlocked;
                    blueprint.userCraftable = definition.craftable;
                    blueprint.isResearchable = definition.craftable || definition.repairable;
                    blueprint.workbenchLevelRequired = definition.workbenchLevelRequired;
                    blueprint.ingredients = ingredients;
                }

                static void SetNameAndDescription(ItemDefinition @new, ItemDefinitionDto definition, Plugin plugin)
                {
                    if (definition.defaultName != null || definition.defaultDescription != null)
                    {
                        Lang pluginLang = PluginGetLang(plugin);
                        Translate.InitServerTranslations();

                        if (definition.defaultName != null)
                            SetValueWithCache(definition.defaultName, ref @new.displayName, @new.itemid, Mutate.Item.Dictionaries.NamePhrase);

                        if (definition.defaultDescription != null)
                            SetValueWithCache(definition.defaultDescription, ref @new.displayDescription, @new.itemid, Mutate.Item.Dictionaries.DescriptionPhrase);

                        Dictionary<string, string> langDictionary = Pool.Get<Dictionary<string, string>>();
                        Dictionary<string, string> existingMessages = pluginLang.GetMessages("en", plugin);
                        if (existingMessages != null)
                        {
                            foreach (KeyValuePair<string, string> pair in existingMessages)
                                langDictionary.Add(pair.Key, pair.Value);
                        }

                        bool nameHasBeenAdded = langDictionary.TryAdd(@new.displayName.token, @new.displayName.english);
                        bool descriptionHasBeenAdded = langDictionary.TryAdd(@new.displayDescription.token, @new.displayDescription.english);
                        if (nameHasBeenAdded || descriptionHasBeenAdded)
                        {
                            pluginLang.RegisterMessages(langDictionary, plugin);
                        }
                        Pool.FreeUnmanaged(ref langDictionary);
                    }
                }

                static void AddServerTranslationPhrases(ItemDefinitionDto dto, Plugin plugin)
                {
                    List<Translate.Phrase> phrases = Pool.Get<List<Translate.Phrase>>();

                    if (dto.defaultName != null && dto.defaultName.IsValid())
                        phrases.Add(dto.defaultName);
                    if (dto.defaultDescription != null && dto.defaultDescription.IsValid())
                        phrases.Add(dto.defaultDescription);

                    if (dto.staticOwnerships != null)
                    {
                        foreach (var ownership in dto.staticOwnerships)
                        {
                            if (ownership.label.IsValid())
                                phrases.Add(ownership.label);
                            if (ownership.text.IsValid())
                                phrases.Add(ownership.text);
                        }
                    }

                    if (phrases.Count > 0)
                    {
                        foreach ((string language, Dictionary<string, string> pairs) in Translate.allServerTranslations)
                        {
                            foreach (Translate.Phrase phrase in phrases)
                            {
                                string token = phrase.token;

                                string message = GetMessageByLanguage(token, plugin, language);
                                if (message != token)
                                    pairs[token] = message;
                                else if (pairs.ContainsKey(token))
                                    pairs.Remove(token);
                            }
                        }
                    }

                    Pool.FreeUnmanaged(ref phrases);
                }

                static void SettingDefinitionFields(ItemDefinition @new, ItemDefinitionDto definition)
                {
                    @new.itemid = definition.itemId.Value;
                    @new.shortname = definition.shortname;
                    @new.Parent = definition.ParentDefinition;
                    @new.flags = CUSTOM_DEFINITION_FLAG;
                    @new.flags |= definition.flags;
                    if (definition.category.HasValue)
                        @new.category = definition.category.Value;
                    if (definition.maxStackSize.HasValue)
                        @new.stackable = definition.maxStackSize.Value;
                    @new.condition.repairable = definition.repairable;
                    Mutate.Item.Dictionaries.ItemId[@new.itemid] = @new.Parent.itemid;
                }

                static void MakeNewMods(ItemDefinitionDto definition, ItemDefinition @new)
                {
                    if (definition.itemMods != null)
                    {
                        foreach (ItemMod mod in definition.itemMods)
                        {
                            if ((mod as object) == null)
                                continue;

                            Type type = mod.GetType();
                            Component component = @new.gameObject.AddComponent(type);
                            mod.CopyFields(component as ItemMod);
                        }
                    }
                    @new.Initialize(ItemManager.itemList);
                }

                static void SaveDefaultIds(ItemDefinition @new, ItemDefinitionDto definition)
                {
                    if (definition.defaultSkinId != default)
                        Mutate.Item.Dictionaries.SkinId[@new.itemid] = definition.defaultSkinId;
                    if (definition.iconFileId != default)
                        Mutate.Item.Dictionaries.IconId[@new.itemid] = definition.iconFileId;
                    else
                        Mutate.Item.Dictionaries.IconId.Remove(@new.itemid);
                }

                static void SettingStaticOwnerships(ItemDefinitionDto definition, Plugin plugin, ItemDefinition @new)
                {
                    if (definition.staticOwnerships != null)
                    {
                        Mutate.Item.Dictionaries.StaticOwnerships[@new.itemid] = definition.staticOwnerships;
                    }
                }
            }


            public List<MethodInfo> PatchMutateMethod(Type argumentType, Type patchClass)
            {
                return PluginInstance.PatchMutateMethod(argumentType, patchClass, (Harmony)PluginGetHarmonyInstance.Invoke(plugin, null));
            }

            public void UnregisterDefinition(ItemDefinition definition)
            {
                if (definition == null)
                    return;

                if (!definition.HasFlag(CUSTOM_DEFINITION_FLAG))
                    return;

                Mutate.Item.Dictionaries.Remove(definition.itemid);

                ClearItemMods(definition);
                definition.Initialize(ItemManager.itemList);

                RemoveDefinitionFromCollections(definition);

                definitions.Remove(definition);

                Interface.Oxide.CallHook("OnItemDefinitionUnregistered", definition);
            }


            public void Dispose()
            {
                if (Interface.Oxide.IsShuttingDown)
                    return;

                using (PooledArray<ItemDefinition> array = definitions.ToPooledArray())
                {
                    foreach (var definition in array.Array)
                        UnregisterDefinition(definition);
                }
                definitions.Clear();
                _all.Remove(this);
            }

            #region Static
            private static List<PluginContext> _all { get; } = new List<PluginContext>();

            internal static ReadOnlyCollection<PluginContext> All => _all.AsReadOnly();
            internal static Memoized<PluginContext, Plugin> Array { get; } = new Memoized<PluginContext, Plugin>((Plugin plugin) =>
            {
                PluginContext instance = new PluginContext(plugin);
                _all.Add(instance);
                return instance;
            });
            #endregion
        }

        internal class Memoized<TResult, TArgs>
        {
            public Memoized(Func<TArgs, TResult> factory)
            {
                if (factory == null)
                {
                    throw new ArgumentNullException("factory");
                }
                this._factory = factory;
                this._cache = new Dictionary<TArgs, TResult>();
            }

            public bool TryGetFromCache(TArgs args, out TResult result)
            {
                return this._cache.TryGetValue(args, out result);
            }

            public TResult Get(TArgs args)
            {
                TResult tresult;
                if (this._cache.TryGetValue(args, out tresult))
                {
                    return tresult;
                }
                TResult tresult2 = this._factory(args);
                this._cache.Add(args, tresult2);
                return tresult2;
            }

            private readonly Func<TArgs, TResult> _factory;

            private readonly Dictionary<TArgs, TResult> _cache;
        }


        private static class ProtoWriteToStream
        {
            internal const string HANDLE_METHOD_NAME = nameof(Handle);

            private static Connection GetConnection(BufferStream stream)
            {
                if (NetWritePool.BufferToStream.TryGetValue(stream, out NetWrite netWrite))
                    return netWrite.connections.FirstOrDefault();
                return null;
            }

            private static void Handle(ProtoBuf.Entity __instance, BufferStream stream)
            {
                Connection connection = GetConnection(stream);
                if (connection == null)
                    return;

                Mutate.ToClientSide(__instance, connection);
            }

            private static void Handle(ProtoBuf.PlayerUpdateLoot __instance, BufferStream stream)
            {
                Connection connection = GetConnection(stream);
                if (connection == null)
                    return;

                if (__instance.containers != null)
                    Mutate.ToClientSide(__instance.containers, connection);
            }

            private static void Handle(ProtoBuf.UpdateItem __instance, BufferStream stream)
            {
                Connection connection = GetConnection(stream);
                if (connection == null)
                    return;

                Mutate.ToClientSide(__instance, connection);
            }

            private static void Handle(ProtoBuf.UpdateItemContainer __instance, BufferStream stream)
            {
                Connection connection = GetConnection(stream);
                if (connection == null)
                    return;

                Mutate.ToClientSide(__instance, connection);
            }

            private static void Handle(ref ProtoBuf.VendingMachine.SellOrderContainer __instance, BufferStream stream)
            {
                __instance = __instance.Copy();
                foreach (ProtoBuf.VendingMachine.SellOrder order in __instance.sellOrders)
                    Mutate.ToClientSide(order);
            }

            private static void Handle(ProtoBuf.VendingMachinePurchaseHistoryMessage __instance, BufferStream stream)
            {
                Mutate.ToClientSide(__instance);
            }

            private static void Handle(ProtoBuf.ItemAmountList __instance, BufferStream stream)
            {
                Connection connection = GetConnection(stream);
                if (connection == null)
                    return;

                List<int> itemID = __instance.itemID;
                int count = itemID.Count;
                for (int i = 0; i < count; i++)
                {
                    int itemId = itemID[i];
                    if (Mutate.Item.ItemId(ref itemId))
                        itemID[i] = itemId;
                }
            }

            private static void Handle(ProtoBuf.AppEntityPayload __instance)
            {
                List<ProtoBuf.AppEntityPayload.Item> items = __instance.items;
                int count = items.Count;
                for (int i = 0; i < count; i++)
                {
                    int itemId = items[i].itemId;
                    if (Mutate.Item.ItemId(ref itemId))
                        items[i].itemId = itemId;
                }
            }

            private static void Handle(ProtoBuf.IndustrialConveyorTransfer __instance)
            {
                List<ProtoBuf.IndustrialConveyorTransfer.ItemTransfer> transfers = __instance.ItemTransfers;
                int count = transfers.Count;
                for (int i = 0; i < count; i++)
                {
                    ProtoBuf.IndustrialConveyorTransfer.ItemTransfer transfer = transfers[i];
                    int itemId = transfer.itemId;
                    if (Mutate.Item.ItemId(ref itemId))
                        transfers[i] = new ProtoBuf.IndustrialConveyorTransfer.ItemTransfer { itemId = itemId, amount = transfer.amount };
                }
            }

            internal static Exception LibraryFinalizer(Exception __exception)
            {
                if (__exception != null)
                    if (__exception != null)
                        Interface.Oxide.LogException($"[{nameof(CustomItemDefinitions)}] There was an error in the client side package handler! This is a very important part! Please inform the developer about it!", __exception);
                return null;
            }

            internal static Exception ExternalFinalizer(Exception __exception)
            {
                if (__exception != null)
                    Interface.Oxide.LogException(string.Format("[{0}]", __exception.TargetSite.DeclaringType), __exception);
                return null;
            }
        }

        private static class PlayerLanguages
        {
            private static Dictionary<ulong, string> playerLanguages = new();

            public static void OnPlayerLanguageChanged(ulong userId)
            {
                UpdatePlayerLanguage(userId);
            }

            private static void UpdatePlayerLanguage(ulong userId)
            {
                playerLanguages[userId] = PluginInstance.lang.GetLanguage(userId.ToString());
            }

            public static string GetPlayerLanguage(ulong userId)
            {
                if (!playerLanguages.TryGetValue(userId, out string lang))
                {
                    UpdatePlayerLanguage(userId);
                    lang = playerLanguages[userId];
                }
                return lang;
            }
        }

        public static class Mutate
        {
            public class Item
            {
                public class Dictionaries
                {
                    public static Dictionary<int, int> ItemId = new();
                    public static Dictionary<int, ulong> SkinId = new();
                    public static Dictionary<int, uint> IconId = new();
                    public static Dictionary<int, Translate.Phrase> NamePhrase = new();
                    public static Dictionary<int, Translate.Phrase> DescriptionPhrase = new();
                    public static Dictionary<int, List<(Translate.Phrase label, Translate.Phrase text)>> StaticOwnerships = new();

                    public static void Remove(int itemID)
                    {
                        ItemId.Remove(itemID);
                        SkinId.Remove(itemID);
                        IconId.Remove(itemID);
                        NamePhrase.Remove(itemID);
                        StaticOwnerships.Remove(itemID);
                    }
                }

                private static void AddOwnership(ProtoBuf.Item item, string label, string text)
                {
                    item.ownership ??= Pool.Get<List<ProtoBuf.ItemOwnershipAmount>>();
                    ProtoBuf.ItemOwnershipAmount itemOwnershipAmount = Pool.Get<ProtoBuf.ItemOwnershipAmount>();
                    itemOwnershipAmount.username = label;
                    itemOwnershipAmount.reason = text;
                    itemOwnershipAmount.amount = item.amount;
                    item.ownership.Add(itemOwnershipAmount);
                }

                public static bool IsBlueprint(ProtoBuf.Item item) => item.instanceData != null && item.instanceData.blueprintTarget != default;

                public static bool ItemId(ref int itemID)
                {
                    if (Dictionaries.ItemId.TryGetValue(itemID, out int target))
                    {
                        itemID = target;
                        return true;
                    }
                    return false;
                }

                public static bool IconId(int itemID, ref uint iconId)
                {
                    if (Dictionaries.IconId.TryGetValue(itemID, out uint target))
                    {
                        iconId = target;
                        return true;
                    }
                    return false;
                }

                public static bool SkinId(int itemID, ref ulong skinID)
                {
                    if (Dictionaries.SkinId.TryGetValue(itemID, out ulong target))
                    {
                        skinID = target;
                        return true;
                    }
                    return false;
                }

                public static bool Name(ProtoBuf.Item item, Connection connection)
                {
                    if (!string.IsNullOrEmpty(item.name))
                        return false;

                    bool isBlueprint = IsBlueprint(item);
                    int itemId = isBlueprint ? item.instanceData.blueprintTarget : item.itemid;

                    if (!Dictionaries.NamePhrase.TryGetValue(itemId, out Translate.Phrase phrase))
                        return false;

                    if (!phrase.IsValid())
                        return false;

                    string language = PlayerLanguages.GetPlayerLanguage(connection.userid);

                    item.name = Translate.GetServerTranslation(phrase.token, language);
                    if (isBlueprint)
                        item.name = item.name + " " + Translate.GetServerTranslation("blueprintbase.name", language);
                    return true;
                }

                public static bool Description(ProtoBuf.Item item, Connection connection)
                {
                    if (!Dictionaries.DescriptionPhrase.TryGetValue(item.itemid, out Translate.Phrase phrase))
                        return false;

                    if (!phrase.IsValid())
                        return false;

                    string language = PlayerLanguages.GetPlayerLanguage(connection.userid);

                    string text = Translate.GetServerTranslation(phrase.token, language);
                    if (string.IsNullOrEmpty(text))
                        return false;

                    string label = "\r\r\r\r\r\r\r\r\r\r\r" + PluginInstance.GetMessageByLanguage("itemownership.description.phrase", language);
                    AddOwnership(item, label, text);
                    return true;
                }

                public static bool StaticOwnerShips(ProtoBuf.Item item, Connection connection)
                {
                    if (!Dictionaries.StaticOwnerships.TryGetValue(item.itemid, out var ownerships))
                        return false;

                    string language = null;
                    foreach (var ownership in ownerships)
                    {
                        language ??= PlayerLanguages.GetPlayerLanguage(connection.userid);

                        string label = GetTranslatedText(ownership.label);
                        string text = GetTranslatedText(ownership.text);

                        string GetTranslatedText(Translate.Phrase phrase)
                        {
                            if (phrase.IsValid())
                            {
                                string result = Translate.GetServerTranslation(phrase.token, language);
                                if (!string.IsNullOrEmpty(result))
                                    return result;
                            }

                            return phrase.english;
                        }

                        AddOwnership(item, label, text);
                    }
                    return true;
                }

                public static void ToFallback(ProtoBuf.Item item, Connection forConnection)
                {
                    item.itemid = FallbackItemDefinition.itemid;
                    item.name = $"Fallback Item [{item.UID}]";
                    item.iconImageId = fallbackItemIcon;
                    item.ownership ??= Pool.Get<List<ProtoBuf.ItemOwnershipAmount>>();
                    {
                        ProtoBuf.ItemOwnershipAmount ownership = Pool.Get<ProtoBuf.ItemOwnershipAmount>();
                        ownership.username = "FALLBACK ITEM";
                        ownership.reason = "This is a fallback item in case of a plugin error. Please contact the administrator.";
                        ownership.amount = item.amount;
                        item.ownership.Add(ownership);
                    }
                    if (forConnection.authLevel >= 2)
                    {
                        ProtoBuf.ItemOwnershipAmount ownership = Pool.Get<ProtoBuf.ItemOwnershipAmount>();
                        ownership.username = "INFO FOR ADMIN";
                        ownership.reason = "The plugin providing this item was not compiled or was not loaded before the item was registered.\nPlease contact the plugin developer and specify the error.";
                        ownership.amount = item.amount;
                        item.ownership.Add(ownership);
                    }
                }
            }


            public static void ToClientSide(ProtoBuf.Item item, Connection connection)
            {
                if (ItemManager.FindItemDefinition(item.itemid) == null)
                {
                    Item.ToFallback(item, connection);
                    return;
                }

                int currentItemId = item.itemid;
                int originalItemId;

                if (Mutate.Item.Dictionaries.ItemId.TryGetValue(currentItemId, out originalItemId))
                {
                    Item.Name(item, connection);
                    Item.Description(item, connection);
                    Item.StaticOwnerShips(item, connection);
                    Item.SkinId(item.itemid, ref item.skinid);
                    Item.IconId(item.itemid, ref item.iconImageId);

                    if (Item.IsBlueprint(item) && Mutate.Item.Dictionaries.ItemId.ContainsKey(item.instanceData.blueprintTarget))
                    {
                        item.instanceData = BlueprintInstanceData;
                        if (item.skinid == default)
                            item.skinid = BlueprintBaseIconSkinId;
                    }
                    else
                    {
                        Item.ItemId(ref item.itemid);
                    }

                    ProtoBuf.Item.ConditionData conditionData = item.conditionData;
                    if (conditionData != null)
                    {
                        ItemDefinition original = ItemManager.FindItemDefinition(originalItemId);
                        if (original && original.condition.enabled)
                        {
                            float clientMaxCondition = original.condition.max;
                            float conditionNormalized = conditionData.condition / conditionData.maxCondition;
                            conditionData.maxCondition = clientMaxCondition;
                            conditionData.condition = clientMaxCondition * conditionNormalized;
                        }
                    }
                }
                
                if (item.contents != null)
                {
                    ToClientSide(item.contents, connection);
                }
            }

            public static void ToClientSide(ProtoBuf.ItemContainer container, Connection connection)
            {
                if (container != null && container.contents != null)
                {
                    foreach (ProtoBuf.Item item in container.contents)
                        ToClientSide(item, connection);
                }
            }

            public static void ToClientSide(List<ProtoBuf.ItemContainer> containers, Connection connection)
            {
                foreach (ProtoBuf.ItemContainer container in containers)
                    ToClientSide(container, connection);
            }

            public static void ToClientSide(ProtoBuf.BasePlayer player, Connection connection)
            {
                ToClientSide(player.inventory, connection);
                if (player.itemCrafter is ProtoBuf.ItemCrafter itemCrafter)
                    ToClientSide(itemCrafter, connection);
            }

            public static void NoteInvToClientSide(ref object[] args, Connection connection)
            {
                if (args.Length > 2 && args[0] is int itemId)
                {
                    if (Mutate.Item.Dictionaries.ItemId.ContainsKey(itemId))
                    {
                        List<object> list = Pool.Get<List<object>>();
                        list.Add(Mutate.Item.Dictionaries.ItemId[itemId].ToString());
                        list.Add(args[1]);
                        if (args.Length > 2)
                        {
                            if (args[2] is string arg2Name && !string.IsNullOrEmpty(arg2Name))
                            {
                                list.Add(arg2Name);
                            }
                            else if (Mutate.Item.Dictionaries.NamePhrase.TryGetValue(itemId, out Translate.Phrase phrase))
                            {
                                if (phrase.IsValid())
                                {
                                    string lang = PlayerLanguages.GetPlayerLanguage(connection.userid);
                                    string name = Translate.GetServerTranslation(phrase.token, lang);
                                    list.Add(name);
                                }
                            }
                        }
                        if (args.Length > 3)
                            list.AddRange(args.Skip(3));

                        args = list.ToArray();

                        Pool.FreeUnmanaged(ref list);
                    }
                }
            }

            public static void ToClientSide(ProtoBuf.PlayerInventory inventory, Connection connection)
            {
                if (inventory.invBelt != null)
                    ToClientSide(inventory.invBelt, connection);
                if (inventory.invMain != null)
                    ToClientSide(inventory.invMain, connection);
                if (inventory.invWear != null)
                    ToClientSide(inventory.invWear, connection);
            }

            public static void ToClientSide(ProtoBuf.ItemCrafter crafter, Connection connection)
            {
                foreach (ProtoBuf.ItemCrafter.Task task in crafter.queue)
                    Item.ItemId(ref task.itemID);
            }

            public static void ToClientSide(ProtoBuf.WorldItem worldItem, Connection connection)
            {
                if (worldItem.item != null)
                    ToClientSide(worldItem.item, connection);
            }

            public static void ToClientSide(ProtoBuf.UpdateItem updateItem, Connection connection)
            {
                if (updateItem.item != null)
                    ToClientSide(updateItem.item, connection);
            }

            public static void ToClientSide(ProtoBuf.UpdateItemContainer updateItemContainer, Connection connection)
            {
                if (updateItemContainer.container != null)
                    ToClientSide(updateItemContainer.container, connection);
            }

            public static void ToClientSide(ProtoBuf.VendingMachine.SellOrder sellOrder)
            {
                Item.SkinId(sellOrder.itemToSellID, ref sellOrder.sellSkinId);
                Item.ItemId(ref sellOrder.itemToSellID);
                Item.SkinId(sellOrder.currencyID, ref sellOrder.costSkinId);
                Item.ItemId(ref sellOrder.currencyID);
            }

            public static void ToClientSide(ProtoBuf.MarketTerminal marketTerminal, Connection connection)
            {
                Item.ItemId(ref marketTerminal.deliveryFeeCurrency);
            }

            public static void ToClientSide(ProtoBuf.IndustrialConveyor.ItemFilter filter, Connection connection)
            {
                Item.ItemId(ref filter.itemDef);
            }

            public static void ToClientSide(ProtoBuf.WeaponRackItem weaponRackItem, Connection connection)
            {
                Item.SkinId(weaponRackItem.itemID, ref weaponRackItem.skinid);
                Item.ItemId(ref weaponRackItem.itemID);
            }

            public static void ToClientSide(ProtoBuf.VendingMachinePurchaseHistoryMessage purchaseHistoryMessage)
            {
                if (purchaseHistoryMessage == null)
                    return;

                if (purchaseHistoryMessage.transactions != null)
                    foreach (ProtoBuf.VendingMachinePurchaseHistoryEntryMessage entryMessage in purchaseHistoryMessage.transactions)
                        Item.ItemId(ref entryMessage.itemID);

                if (purchaseHistoryMessage.smallTransactions != null)
                    foreach (ProtoBuf.VendingMachinePurchaseHistoryEntrySmallMessage entryMessage in purchaseHistoryMessage.smallTransactions)
                        Item.ItemId(ref entryMessage.itemID);
            }

            public static void ToClientSide(ProtoBuf.Mannequin mannequin, Connection connection)
            {
                if (mannequin.clothingItems == null)
                    return;

                foreach (ProtoBuf.Mannequin.ClothingItem clothingItem in mannequin.clothingItems)
                    ToClientSide(clothingItem, connection);
            }

            public static void ToClientSide(ProtoBuf.Mannequin.ClothingItem clothingItem, Connection connection)
            {
                Item.SkinId(clothingItem.itemId, ref clothingItem.skin);
                Item.ItemId(ref clothingItem.itemId);
            }

            public static void ToClientSide(ProtoBuf.BuriedItems buriedItems, Connection connection)
            {
                if (buriedItems.buriedItems == null)
                    return;

                foreach (ProtoBuf.BuriedItems.StoredBuriedItem clothingItem in buriedItems.buriedItems)
                    ToClientSide(clothingItem, connection);
            }

            public static void ToClientSide(ProtoBuf.BuriedItems.StoredBuriedItem buriedItem, Connection connection)
            {
                Item.SkinId(buriedItem.itemId, ref buriedItem.skinId);
                Item.ItemId(ref buriedItem.itemId);
            }

            public static void ToClientSide(ProtoBuf.Entity entity, Connection connection)
            {
                if (entity.basePlayer != null)
                    ToClientSide(entity.basePlayer, connection);
                if (entity.worldItem?.item != null)
                    ToClientSide(entity.worldItem, connection);
                if (entity.storageBox?.contents != null)
                    ToClientSide(entity.storageBox.contents, connection);
                if (entity.mailbox?.inventory != null)
                    ToClientSide(entity.mailbox?.inventory, connection);
                if (entity.lootableCorpse?.privateData?.container != null)
                    ToClientSide(entity.lootableCorpse.privateData.container, connection);
                if (entity.mannequin != null)
                    ToClientSide(entity.mannequin, connection);
                if (entity.mannequin != null)
                    ToClientSide(entity.mannequin, connection);

                if (entity.miningQuarry?.extractor is ProtoBuf.ResourceExtractor extractor)
                {
                    ToClientSide(extractor.fuelContents, connection);
                    ToClientSide(extractor.outputContents, connection);
                }

                if (entity.vendingMachine is ProtoBuf.VendingMachine vendingMachine)
                {
                    if (vendingMachine.sellOrderContainer != null)
                    {
                        foreach (ProtoBuf.VendingMachine.SellOrder order in vendingMachine.sellOrderContainer.sellOrders)
                            ToClientSide(order);
                    }
                }

                if (entity.marketTerminal is ProtoBuf.MarketTerminal marketTerminal)
                {
                    ToClientSide(marketTerminal, connection);
                }

                if (entity.horse is ProtoBuf.Horse horse)
                {
                    ToClientSide(horse.equipmentContainer, connection);
                    ToClientSide(horse.storageContainer, connection);
                }

                if (entity.FrankensteinTable is ProtoBuf.FrankensteinTable FrankensteinTable)
                {
                    for (int i = 0; i < FrankensteinTable.itemIds.Count; i++)
                    {
                        int itemId = FrankensteinTable.itemIds[i];
                        if (Item.ItemId(ref itemId))
                            FrankensteinTable.itemIds[i] = itemId;
                    }
                }

                if (entity.industrialConveyor is ProtoBuf.IndustrialConveyor industrialConveyor)
                {
                    foreach (ProtoBuf.IndustrialConveyor.ItemFilter filter in industrialConveyor.filters)
                        ToClientSide(filter, connection);
                }

                if (entity.weaponRack is ProtoBuf.WeaponRack weaponRack)
                {
                    foreach (ProtoBuf.WeaponRackItem item in weaponRack.items)
                        ToClientSide(item, connection);
                }


            }

            public static MethodInfo GetMethod(Type type)
            {
                return AccessTools.Method(typeof(Mutate), nameof(ToClientSide), new Type[] { type, typeof(Connection) });
            }
        }

        private class Patcher
        {
            public static Patcher Instance { get; private set; }

            private RustPlugin plugin;
            private Harmony harmonyInstance;
            private HarmonyMethod protoWriteToStreamFinalizer = new HarmonyMethod(AccessTools.Method(typeof(ProtoWriteToStream), nameof(ProtoWriteToStream.LibraryFinalizer)));
            private HarmonyMethod protoWriteToStreamExternalsFinalizer = new HarmonyMethod(AccessTools.Method(typeof(ProtoWriteToStream), nameof(ProtoWriteToStream.LibraryFinalizer)));
            private AccessTools.FieldRef<PatchClassProcessor, Dictionary<Type, MethodInfo>> PatchClassProcessor__auxilaryMethods = AccessTools.FieldRefAccess<PatchClassProcessor, Dictionary<Type, MethodInfo>>("auxilaryMethods");

            public Patcher(RustPlugin plugin, Harmony harmonyInstance)
            {
                this.plugin = plugin;
                this.harmonyInstance = harmonyInstance;

                Instance = this;
            }

            public void PatchNestedClasses()
            {
                foreach (Type type in typeof(CustomItemDefinitions).GetNestedTypes(BindingFlags.DeclaredOnly | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
                {
                    object[] attribute = type.GetCustomAttributes(typeof(HarmonyPatch), false);
                    if (attribute.Length >= 1)
                    {
                        try
                        {
                            PatchClassProcessor patchClassProcessor = harmonyInstance.CreateClassProcessor(type);
                            patchClassProcessor.Patch();
                        }
                        catch (Exception ex)
                        {
                            this.plugin.RaiseError(ex.ToString());
                        }
                    }
                }
            }

            public void PatchWriteToStreamClass()
            {
                Type protoType = typeof(IProto);
                MethodInfo PatchWriteToStreamMethod = typeof(Patcher).GetMethod(nameof(PatchWriteToStream), BindingFlags.Public | BindingFlags.Instance);

                foreach (MethodInfo method in typeof(ProtoWriteToStream).GetMethods(BindingFlags.NonPublic | BindingFlags.Static))
                {
                    if (method.Name != ProtoWriteToStream.HANDLE_METHOD_NAME)
                        continue;

                    ParameterInfo[] parameters = method.GetParameters();
                    if (parameters.Length < 1)
                        continue;

                    ParameterInfo firstParam = parameters[0];
                    if (!firstParam.ParameterType.GetInterfaces().Contains(protoType))
                        continue;

                    PatchWriteToStreamMethod.MakeGenericMethod(firstParam.ParameterType).Invoke(this, new object[] { method });
                }
            }

            public void PatchWriteToStream<T>(MethodInfo prefix) where T : class, IProto, new()
            {
                PatchProcessor processor = harmonyInstance.CreateProcessor(GetWriteToStreamMethod<T>());
                if (prefix != null)
                    processor.AddPrefix(new HarmonyMethod(prefix));
                processor.AddFinalizer(protoWriteToStreamFinalizer);
                processor.Patch();
            }


            public List<MethodInfo> PatchMutateMethod(MethodInfo targetMethod, Type patchClass, Harmony harmonyInstance)
            {
                if (targetMethod.DeclaringType != typeof(Mutate))
                    throw new ArgumentException();

                List<MethodInfo> list = new List<MethodInfo>();

                try
                {
                    PatchClassProcessor patchClassProcessor = new PatchClassProcessor(harmonyInstance, patchClass);
                    Dictionary<Type, MethodInfo> auxilaryMethods = PatchClassProcessor__auxilaryMethods(patchClassProcessor);
                    auxilaryMethods[typeof(HarmonyTargetMethod)] = HarmonyTargetMethod();
                    auxilaryMethods.Remove(typeof(HarmonyTargetMethods));
                    list.AddRange(patchClassProcessor.Patch());
                }
                catch (Exception ex)
                {
                    throw ex;
                }
                finally
                {
                    PatchProcessor patchProcessor = new PatchProcessor(harmonyInstance, targetMethod);
                    patchProcessor.AddFinalizer(new HarmonyMethod(typeof(ProtoWriteToStream), nameof(ProtoWriteToStream.ExternalFinalizer)));
                    list.Add(patchProcessor.Patch());
                }

                return list;

                MethodInfo HarmonyTargetMethod()
                {
                    DynamicMethod method = new DynamicMethod(
                         Guid.NewGuid().ToString(),
                         typeof(MethodBase),
                         Type.EmptyTypes,
                         patchClass.Module,
                         skipVisibility: true
                     );

                    ILGenerator il = method.GetILGenerator();

                    il.Emit(OpCodes.Ldtoken, targetMethod);
                    il.Emit(OpCodes.Call, typeof(MethodBase).GetMethod(nameof(MethodBase.GetMethodFromHandle), new[] { typeof(RuntimeMethodHandle) }));
                    il.Emit(OpCodes.Ret);

                    return method.CreateDelegate(typeof(Func<MethodBase>)).Method;
                }

            }

            private MethodInfo GetWriteToStreamMethod<T>() where T : class, IProto, new()
            {
                return typeof(T).GetMethod(nameof(IProto.WriteToStream), BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly);
            }
        }
        #endregion

        #region Patches


        [HarmonyPatch(typeof(VendingMachine), nameof(VendingMachine.CanSellOrBuyItem))]
        private static class VendingMachine_CanSellOrBuyItem_Patch
        {
            private static bool Prefix(ref int itemToSellID, ref int currencyID)
            {
                TryFallback(ref itemToSellID);
                TryFallback(ref currencyID);

                void TryFallback(ref int itemID)
                {
                    const int FALLBACK_ITEMID = -996920608;
                    if (ItemManager.FindItemDefinition(itemID) == null)
                    {
                        if (parentMap.TryGetValue(itemID, out int parentID))
                            itemID = parentID;
                        else
                            itemID = FALLBACK_ITEMID;
                    }
                }
                return true;
            }
        }


        [HarmonyPatch(typeof(VendingMachine), nameof(VendingMachine.AddSellOrder))]
        private static class VendingMachine_AddSellOrder_Patch
        {
            private static bool Prefix(ref int itemToSellID, ref int currencyToUseID, ref ulong sellSkinId, ref ulong costSkinId)
            {
                if (sellSkinId != default || costSkinId != default)
                {
                    foreach (KeyValuePair<int, ulong> pair in Mutate.Item.Dictionaries.SkinId)
                    {
                        TryMutateOrderItem(ref itemToSellID, ref sellSkinId);
                        TryMutateOrderItem(ref currencyToUseID, ref costSkinId);

                        void TryMutateOrderItem(ref int itemID, ref ulong skinID)
                        {
                            if (skinID != default)
                            {
                                if (pair.Value == skinID)
                                {
                                    if (Mutate.Item.Dictionaries.ItemId.TryGetValue(pair.Key, out int baseItemID)
                                        && baseItemID == itemID)
                                    {
                                        itemID = pair.Key;
                                        skinID = 0UL;
                                    }
                                }
                            }
                        }
                    }
                }
                return true;
            }
        }

        [HarmonyPatch(typeof(PlayerBlueprints), nameof(PlayerBlueprints.HasUnlocked))]
        private static class PlayerBlueprints_HasUnlocked_Patch
        {
            private static IEnumerable<CodeInstruction> Transpiler(IEnumerable<CodeInstruction> instructions, ILGenerator generator)
            {
                CodeMatcher codeMatcher = new CodeMatcher(instructions, generator)
                    .MatchEndForward(CodeMatch.Calls(AccessTools.Method(typeof(PlayerBlueprints), nameof(PlayerBlueprints.IsUnlocked))))
                    .ThrowIfInvalid($"No instructions found for calling PlayerBlueprints.IsUnlocked. ({nameof(PlayerBlueprints_HasUnlocked_Patch)})")
                    .DefineLabel(out Label isUnlockedBlueprint)
                    .Advance(1)
                    .Insert(
                        new CodeInstruction(OpCodes.Brtrue_S, isUnlockedBlueprint),
                        new CodeInstruction(OpCodes.Ldarg_1),
                        new CodeInstruction(OpCodes.Call, AccessTools.Method(typeof(PlayerBlueprints_HasUnlocked_Patch), nameof(HasDefaultBlueprint))),
                        new CodeInstruction(OpCodes.Ret),
                        new CodeInstruction(OpCodes.Ldc_I4_1)
                        {
                            labels =
                            {
                                isUnlockedBlueprint
                            }
                        }
                    );

                return codeMatcher.Instructions();
            }

            public static bool HasDefaultBlueprint(ItemDefinition definition)
            {
                if (!IsValidCID(definition))
                    return false;
                return definition.Blueprint && definition.Blueprint.defaultBlueprint;
            }
        }

        [HarmonyPatch(typeof(NetWrite))]
        private static class NetWritePool
        {
            public static Dictionary<BufferStream, NetWrite> BufferToStream { get; } = new();

            [HarmonyPatch(nameof(Pool.IPooled.EnterPool))]
            [HarmonyPrefix]
            private static void EnterPool(NetWrite __instance)
            {
                lock (BufferToStream)
                    BufferToStream.Remove(NetWriteGetBufferStream(__instance));
            }


            [HarmonyPatch(nameof(NetWrite.Start))]
            [HarmonyPostfix]
            private static void Start(NetWrite __instance)
            {
                lock (BufferToStream)
                    BufferToStream[NetWriteGetBufferStream(__instance)] = __instance;
            }

            [HarmonyPatch(nameof(NetWrite.Send))]
            [HarmonyPrefix]
            private static void Send(NetWrite __instance)
            {
                __instance.connections.Clear();
            }

            [HarmonyPatch(nameof(Pool.IPooled.EnterPool))]
            [HarmonyPatch(nameof(NetWrite.Start))]
            [HarmonyPatch(nameof(NetWrite.Send))]
            [HarmonyFinalizer]
            static Exception Finalizer()
            {
                return null;
            }
        }


        [HarmonyPatch(typeof(BaseEntity))]
        private static class ClientRPCPatches
        {
            private static IEnumerable<MethodBase> TargetMethods()
            {
                Type protoType = typeof(IProto);
                foreach (MethodInfo methodInfo in typeof(BaseEntity).GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
                {
                    ParameterInfo[] parameters = methodInfo.GetParameters();
                    if (methodInfo.Name == nameof(BaseEntity.ClientRPC) && parameters.Length == 2 && parameters[1].ParameterType.GetInterfaces().Contains(protoType))
                    {
                        yield return methodInfo;
                    }
                }
            }

            private static IEnumerable<CodeInstruction> Transpiler(IEnumerable<CodeInstruction> instructions, ILGenerator gen)
            {
                CodeMatcher matcher = new CodeMatcher(instructions)
                    .MatchStartForward(CodeMatch.Calls(AccessTools.Method("BaseEntity:ClientRPCStart")))
                    .ThrowIfInvalid("Could not find call to BaseEntity:ClientRPCStart")
                    .Advance(2)
                    .Insert(
                        CodeMatch.LoadLocal(0),
                        CodeMatch.LoadArgument(1),
                        CodeMatch.Call(typeof(ClientRPCPatches), $"<{nameof(Transpiler)}>g__{nameof(AddInformationAboutTargetsToRPC)}|1_0")
                    );

                void AddInformationAboutTargetsToRPC(NetWrite netWrite, RpcTarget target)
                {
                    SendInfo info = target.Connections;
                    if (info.connections != null)
                        netWrite.connections.AddRange(info.connections);
                    if (info.connection != null)
                        netWrite.connections.Add(info.connection);
                }

                return matcher.InstructionEnumeration();
            }
        }

        [HarmonyPatch(typeof(ConsoleNetwork), nameof(ConsoleNetwork.SendClientCommand), new Type[] { typeof(Connection), typeof(string), typeof(string[]) })]
        private static class ConsoleNetwork_NoteInv_Patch
        {
            private const string NOTE_INV = "note.inv";

            private static bool Prefix(Connection __0, string __1, ref object[] __2)
            {
                if (__1 == NOTE_INV)
                    Mutate.NoteInvToClientSide(ref __2, __0);

                return true;
            }
        }


#if CARBON
        [HarmonyPatch(typeof(Carbon.Core.ModLoader), nameof(Carbon.Core.ModLoader.UninitializePlugin))]
#else
        [HarmonyPatch(typeof(Oxide.Core.OxideMod), nameof(Oxide.Core.OxideMod.UnloadPlugin))]
#endif
        private static class UnloadingPatch
        {
#if CARBON
            private static void Prefix(RustPlugin plugin)
            {
                if (PluginContext.Array.TryGetFromCache(plugin, out PluginContext context))
                {
                    context.Dispose();
                    if (PluginInstance.IsLoaded)
                        PluginInstance.SaveData();
                }
            }
#else
            private static void Prefix(string name)
            {
                Plugin plugin = Oxide.Core.Interface.Oxide.RootPluginManager.GetPlugin(name);
                if (plugin == null || (plugin.IsCorePlugin && !Oxide.Core.Interface.Oxide.IsShuttingDown))
                    return;

                if (PluginContext.Array.TryGetFromCache(plugin, out PluginContext context))
                {
                    context.Dispose();
                    if (PluginInstance.IsLoaded)
                        PluginInstance.SaveData();
                }
            }
#endif
        }


        [HarmonyPatch(typeof(global::Item), nameof(global::Item.Load))]
        private static class Item_Load_Patch
        {
            private static bool Prefix(Item __instance, ProtoBuf.Item __0)
            {
                if (__instance.info == null || __instance.info.itemid != __0.itemid)
                {
                    __instance.info = ItemManager.FindItemDefinition(__0.itemid);
                    if (__instance.info == null)
                        OnItemDefinitionBroken(__instance, __0);
                }
                return true;
            }
        }


        [HarmonyPatch(typeof(CuiImageComponent))]
        private static class CuiImageComponentPatches
        {
            private readonly static AccessTools.FieldRef<CuiImageComponent, int> ItemIdRef = AccessTools.FieldRefAccess<CuiImageComponent, int>($"<{nameof(CuiImageComponent.ItemId)}>k__BackingField");

            [HarmonyPostfix]
            [HarmonyPatch(nameof(CuiImageComponent.ItemId), MethodType.Getter)]
            private static void ItemId_Getter(CuiImageComponent __instance, ref int __result)
            {
                Mutate.Item.ItemId(ref __result);
            }

            [HarmonyPostfix]
            [HarmonyPatch(nameof(CuiImageComponent.SkinId), MethodType.Getter)]
            private static void SkinId_Getter(CuiImageComponent __instance, ref ulong __result)
            {
                if (__result == default)
                    Mutate.Item.SkinId(ItemIdRef(__instance), ref __result);
            }
        }

#if CARBON
        [HarmonyPatch(typeof(Carbon.Components.LuiBuilderInstance))]
        [HarmonyPatch(MethodType.Constructor)]
        [HarmonyPatch(new Type[] { typeof(Carbon.Components.LUI) })]
        private static class CarbonLUISerializerPatch
        {
            private static readonly MethodInfo MutateItemId = AccessTools.Method(typeof(Mutate.Item), nameof(Mutate.Item.ItemId));
            private static readonly MethodInfo MutateSkinId = AccessTools.Method(typeof(Mutate.Item), nameof(Mutate.Item.SkinId));
            private static readonly FieldInfo LuiImageComp_Itemid = AccessTools.Field(typeof(Carbon.Components.LuiImageComp), nameof(Carbon.Components.LuiImageComp.itemid));
            private static readonly FieldInfo LuiImageComp_SkinId = AccessTools.Field(typeof(Carbon.Components.LuiImageComp), nameof(Carbon.Components.LuiImageComp.skinid));

            private static IEnumerable<CodeInstruction> Transpiler(IEnumerable<CodeInstruction> instructions, ILGenerator generator)
            {
                CodeMatcher matcher = new CodeMatcher(instructions, generator)
                   .MatchStartForward(
                       new CodeMatch(OpCodes.Ldarg_0),
                       new CodeMatch(OpCodes.Ldstr, "itemid")
                   ).ThrowIfInvalid("Expected instruction WriteField(\"itemid\", ...) not found");

                #region ItemId
                matcher.DeclareLocal(typeof(int), out LocalBuilder itemIdLocalVar);

                CodeInstruction loadImageLocalVar = matcher.InstructionAt(2);

                LocalBuilder ldloc_image = (LocalBuilder)loadImageLocalVar.operand;

                matcher.InsertAndAdvance(
                    new CodeInstruction(OpCodes.Ldloc_S, ldloc_image),
                    new CodeInstruction(OpCodes.Ldfld, LuiImageComp_Itemid),
                    new CodeInstruction(OpCodes.Stloc, itemIdLocalVar),
                    new CodeInstruction(OpCodes.Ldloca_S, itemIdLocalVar),
                    new CodeInstruction(OpCodes.Call, MutateItemId),
                    new CodeInstruction(OpCodes.Pop)
                );

                loadImageLocalVar.operand = itemIdLocalVar;
                matcher.Advance(3).RemoveInstruction();
                #endregion

                #region SkinId
                matcher = matcher.MatchStartForward(
                      new CodeMatch(OpCodes.Ldfld, LuiImageComp_SkinId)
                  ).ThrowIfInvalid("Expected instruction [ldfld     uint64 Carbon.Components.LuiImageComp::skinid] not found");

                matcher.Advance(1);

                if (matcher.Instruction.opcode != OpCodes.Brfalse)
                {
                    int position0 = matcher.Pos;

                    matcher = matcher.MatchStartForward(new CodeMatch(OpCodes.Brfalse_S))
                        .ThrowIfInvalid("Expected instruction [brfalse.s  IL_05B1] not found");

                    int position1 = matcher.Pos;

                    int delta = position1 - position0;

                    matcher.Advance(delta * -1).RemoveInstructions(delta);
                }

                matcher.DeclareLocal(typeof(ulong), out LocalBuilder skinIdLocalVar);
                matcher.DefineLabel(out Label skipLabel);

                matcher.InsertAndAdvance(
                    new CodeInstruction(OpCodes.Stloc, skinIdLocalVar),
                    new CodeInstruction(OpCodes.Ldloc_S, ldloc_image),
                    new CodeInstruction(OpCodes.Ldfld, LuiImageComp_Itemid),
                    new CodeInstruction(OpCodes.Brfalse_S, skipLabel),
                    new CodeInstruction(OpCodes.Ldloc_S, skinIdLocalVar),
                    new CodeInstruction(OpCodes.Brtrue_S, skipLabel),
                    new CodeInstruction(OpCodes.Ldloc_S, ldloc_image),
                    new CodeInstruction(OpCodes.Ldfld, LuiImageComp_Itemid),
                    new CodeInstruction(OpCodes.Ldloca_S, skinIdLocalVar),
                    new CodeInstruction(OpCodes.Call, MutateSkinId),
                    new CodeInstruction(OpCodes.Pop),
                    new CodeInstruction(OpCodes.Ldloc_S, skinIdLocalVar)
                );

                matcher.InstructionAt(-1).labels.Add(skipLabel);

                matcher = matcher.MatchStartForward(
                    new CodeMatch(OpCodes.Ldarg_0),
                    new CodeMatch(OpCodes.Ldstr, "skinid")
                ).ThrowIfInvalid("Expected instruction WriteField(\"skinid\", ...) not found");

                matcher.Advance(2);
                matcher.Instruction.operand = skinIdLocalVar;
                matcher.Advance(1);
                matcher.RemoveInstruction();
                #endregion

                return matcher.InstructionEnumeration();
            }
        }
#endif

#if OXIDE
        [HarmonyPatch(typeof(Lang), "MergeMessages")]
        private static class Lang_MergeMessages_Patch
        {
            private static bool Prefix(Dictionary<string, string> existingMessages, Dictionary<string, string> messages, ref bool __result)
            {
                bool flag = false;
                if (messages != null)
                {
                    foreach (KeyValuePair<string, string> keyValuePair in messages)
                    {
                        if (!existingMessages.ContainsKey(keyValuePair.Key))
                        {
                            existingMessages.Add(keyValuePair.Key, keyValuePair.Value);
                            flag = true;
                        }
                    }
                }
                __result = flag;
                return false;
            }
        }
#endif
        #endregion

        #region Methods
        #region API
        private object Register(object @object, RustPlugin plugin)
        {
            if (@object is IEnumerable enumerable)
            {
                List<ItemDefinitionDto> list = new List<ItemDefinitionDto>();
                foreach (object item in enumerable)
                    list.Add(ItemDefinitionDto.FromObject(item));

                return For(plugin).RegisterDefinitions(list);
            }
            else
            {
                return For(plugin).RegisterDefinition(ItemDefinitionDto.FromObject(@object));
            }
        }

        private bool Unregister(ItemDefinition definition, Plugin plugin)
        {
            if (definition == null || !IsValidCID(definition))
                return false;

            if (!PluginContext.Array.TryGetFromCache(plugin, out PluginContext context))
            {
                PrintWarning($"No definitions registered for plugin {plugin.Name}");
                return false;
            }

            if (!context.ContainsDefinition(definition))
            {
                PrintWarning($"Definition {definition.shortname} is not registered to plugin {plugin.Name}");
                return false;
            }

            context.UnregisterDefinition(definition);
            return true;
        }

        private bool Unregister(ItemDefinitionDto dto, Plugin plugin)
        {
            if (dto == null)
                return false;

            if (!PluginContext.Array.TryGetFromCache(plugin, out PluginContext context))
            {
                PrintWarning($"No definitions registered for plugin {plugin.Name}");
                return false;
            }

            ItemDefinition definition = ItemManager.FindItemDefinition(dto.shortname);

            if (!context.ContainsDefinition(definition))
            {
                PrintWarning($"Definition {definition.shortname} is not registered to plugin {plugin.Name}");
                return false;
            }

            try
            {
                context.UnregisterDefinition(definition);
                return true;
            }
            catch (Exception ex)
            {
                PrintError($"Failed to unregister definition {definition.shortname}: {ex}");
                return false;
            }
        }

        private void UnregisterAll(Plugin plugin)
        {
            if (PluginContext.Array.TryGetFromCache(plugin, out PluginContext @out))
                @out.Dispose();
        }

        private List<MethodInfo> PatchMutateMethod(Type argumentType, Type patchClass, Harmony harmonyInstance)
        {
            MethodInfo targetMethod = Mutate.GetMethod(argumentType);
            if (targetMethod == null)
                throw new Exception("Failed to patch the mutation method because no method with the specified type was found");

            return Patcher.Instance.PatchMutateMethod(targetMethod, patchClass, harmonyInstance);
        }

        private int GetItemIdForClientside(ItemDefinition definition)
        {
            return GetItemIdForClientside(definition.itemid);
        }

        private int GetItemIdForClientside(int itemId)
        {
            if (IsCustomDefinition(itemId))
            {
                int __ref = 0;
                if (Mutate.Item.ItemId(ref __ref))
                    return __ref;
            }

            return itemId;
        }

        private ulong GetSkin(ItemDefinition definition)
        {
            return GetSkin(definition.itemid);
        }

        private ulong GetSkin(int itemId)
        {
            ulong skinId = 0UL;
            if (IsCustomDefinition(itemId))
                Mutate.Item.SkinId(itemId, ref skinId);

            return skinId;
        }

        private uint GetIconId(ItemDefinition definition)
        {
            return GetIconId(definition.itemid);
        }

        private uint GetIconId(int itemId)
        {
            uint iconId = 0U;
            if (IsCustomDefinition(itemId))
                Mutate.Item.IconId(itemId, ref iconId);

            return iconId;
        }

        private object GetSpriteOverride(ItemDefinition definition)
        {
            return GetSpriteOverride(definition.itemid);
        }

        private object GetSpriteOverride(int itemId)
        {
            if (IsCustomDefinition(itemId))
            {
                uint iconId = 0U;
                if (Mutate.Item.IconId(itemId, ref iconId))
                    return iconId;
                ulong skinId = 0UL;
                if (Mutate.Item.SkinId(itemId, ref skinId))
                    return skinId;
            }

            return null;
        }

        private string GetTranslatedDisplayName(ItemDefinition customDefinition, ulong userID)
        {
            return GetTranslatedDisplayName(customDefinition, PlayerLanguages.GetPlayerLanguage(userID));
        }

        private string GetTranslatedDisplayName(ItemDefinition customDefinition, string languageOrUserID)
        {
            if (string.IsNullOrEmpty(languageOrUserID))
                return null;

            if (!IsValidCID(customDefinition))
                return null;

            if (languageOrUserID.IsSteamId() && ulong.TryParse(languageOrUserID, out ulong userID))
                return GetTranslatedDisplayName(customDefinition, userID);

            string language = languageOrUserID;
            if (customDefinition.displayName.IsValid())
            {
                if (Mutate.Item.Dictionaries.NamePhrase.TryGetValue(customDefinition.itemid, out Translate.Phrase phrase))
                    return Translate.GetServerTranslation(phrase.token, language);
            }
            return customDefinition.displayName.translated;
        }

        private bool IsCustomDefinition(ItemDefinition definition) => IsCustomDefinition(definition.itemid);

        private bool IsCustomDefinition(int itemId) => Mutate.Item.Dictionaries.ItemId.ContainsKey(itemId);
        #endregion

        #region GetMessageByLanguage
        public string GetMessageByLanguage(string token, string language)
        {
            return lang.GetMessageByLanguage(token, this, language);
        }

        public static string GetMessageByLanguage(string token, Plugin plugin = null, string language = "en")
        {
            plugin ??= PluginInstance;
            return PluginGetLang(plugin).GetMessageByLanguage(token, plugin, language);
        }
        #endregion

        #region Data
        private void LoadData()
        {
            parentMap = fs.ReadObject<Dictionary<int, int>>("parents") ?? new();
        }
        private void SaveData()
        {
            fs.WriteObject("parents", parentMap);
        }
        #endregion

        #region Registration

        [Obsolete("Updated version - CustomItemDefinitions.For(Plugin plugin).RegisterDefinitions(IEnumerable<ItemDefinitionDto> dtos)")]
        public static HashSet<ItemDefinition> RegisterPluginItemDefinitions(IEnumerable<ItemDefinitionDto> definitions, RustPlugin plugin)
        {
            return For(plugin).RegisterDefinitions(definitions);
        }

        [Obsolete("Updated version - CustomItemDefinitions.For(Plugin plugin).RegisterDefinition(ItemDefinitionDto dto)")]
        public static ItemDefinition RegisterPluginItemDefinition(ItemDefinitionDto dto, RustPlugin plugin)
        {
            return For(plugin).RegisterDefinition(dto);
        }
        #endregion

        #region Common
        public static PluginContext For(Plugin plugin) => PluginContext.Array.Get(plugin);

        private void LoadFallbackItemIcon()
        {
            fallbackItemIcon = FileStorage.server.Store(Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAACXBIWXMAACz+AAAs/gF2iE6SAAAAGXRFWHRTb2Z0d2FyZQB3d3cuaW5rc2NhcGUub3Jnm+48GgAAA81JREFUeJztm71vFFcUxX/Lh00wIAs2UrANRZCwXUJSBVKki5SAoc+/QJEGURKMCCVfAtHSBSUp0mFRIELSIBMKpIQE2eFDAYwB2ywFJOikeLPKMvt2d3Z37ntD2CPdwndWuvccv3nz7p070EMPPbzNKFkHEKwAPgB2AmPAKDACDAJr3E94DiwA94CbwG/AFWC6BP9Y55g7BH2CvYLvBUsCdWiLgu8EewR9sXm1hKAsOCyY74J0I5sXTArKsXnWQTAgOCqoGBBPW0VwRDAQmzcAyfK8E4B42m4LJmISXyU4HoF42s4JVocmPyK4XgDyVbsmGApFfovgVgFIp+1PuUesKfkxwVwByDayh4KtVuSHBbMFINnK7go25U1+lYp1z7eyaUF/ngKcLQCpdu1UXuT3FoBMp7arW/JrZHPIeSHYLxhK7EDiyzvOrLo5Iwi+NvrP7PfEOmAUa7JT8hsEz4yS2uiJt9EoVkVNCqhlTTT4Elev544S3M/iywkDwL4mudRDrvb+C9hgkVGpcVxZxAPmgeESvExfaLQCPseIfCSUgU99FxoJ8IVdLtHg5VS3FOV6eI+BdVaZRLgFwPUcyyV4Vev0rYAPMSQfEYPAtrTTJ8AO+1yi4eO0wyfAeIBEYmEs7fAJYNtUiIs6bj4BRgIkEgub0w6fAP/HDbCKtWmHTwCT429BkEmAtwo+ASrBswiHZ2mHT4Al6ywE72TxGSCTAHcDJPKRx7czQNw7aYdPgJsBEjmpmta13OPpRIC4ddxWeH70a4BExoEbgkvJ35/g2aENUMfNJ8BPARIBd97YHShWFT+mHVHK4UjIVg4nMzkXAyS0CFwApvDszgaYSpNvCNm/DJkSvFsT7z3BJeOY2V+SyA05Wcz5SPBYnn5jIsKiUcw5wUofV+9ROOmensmsWHu4XHJ7TDrmA+Bno5inS/C370KzWuAYNsfiZn0/i57gczp9USo3jWWxHAc9scqCpwbxDnUsndz4222DpH6oFUGwXnDBIM6Muq0xBBOGG9O3cpOgVhvuZ12RrxHhjFGClpZfbSE3InOtAKSy2lXlOSKTiDCkN2NIakae1+95iTAqN4oWm2QjsxuTqxHhfcEfBSCbtlmFeqeR3A7TBSBdtatmy76JCP0qxrD0WeW94bUpxC65Od3QxGeU13O+WwhWy33NYTVUVWtLgkMK00VuD3KTZV8JHhkQnxMcFKyPzbMl5PoJuwXn1V2B80TwTXKbeev5bhHis7nlwHZe/2xuE/99Ngeu7F7A9e1/x3VvrwC/ZG5j9dBDDz10gH8B76GlmUY3Z9QAAAAASUVORK5CYII="), FileStorage.Type.png, default);
        }

        private static void CacheAlreadyCreated()
        {
            if (ExistingDefinitions == null)
            {
                ExistingDefinitions = new Dictionary<int, ItemDefinition>();
                if (ServerMgr.Instance != null)
                {
                    foreach (GameObject gameObject in ServerMgr.Instance.gameObject.scene.GetRootGameObjects())
                    {
                        if (!regexNumeric.IsMatch(gameObject.name))
                            continue;

                        if (gameObject.TryGetComponent(out ItemDefinition itemDefinition))
                            ExistingDefinitions[itemDefinition.itemid] = itemDefinition;
                    }
                }
            }
        }

        public static bool IsValidCID(ItemDefinition definition)
        {
            return definition != null && PluginInstance.IsCustomDefinition(definition) && definition.HasFlag(CUSTOM_DEFINITION_FLAG) && definition.Parent != null;
        }

        private static void SetValueWithCache<TKey, TValue>(TValue value, ref TValue target, TKey key, Dictionary<TKey, TValue> dictionary)
        {
            target = value;
            dictionary[key] = value;
        }

        private static void ClearItemMods(ItemDefinition @new)
        {
            @new.itemMods = null;
            foreach (ItemMod mod in @new.GetComponentsInChildren<ItemMod>(true))
                UnityEngine.Object.DestroyImmediate(mod);
        }

        private static ItemDefinition GetOrCloneDefinition(int itemId, ItemDefinition template)
        {
            if (!ExistingDefinitions.TryGetValue(itemId, out ItemDefinition result))
            {
                result = CloneItemDefinition(template);
                result.name = itemId.ToString();
                ExistingDefinitions[itemId] = result;
            }
            return result;
        }
        #endregion

        #region ItemManager
        private static void AddDefinitionToCollections(ItemDefinition definition)
        {
            ItemManager.itemDictionary[definition.itemid] = definition;
            ItemManager.itemDictionaryByName[definition.shortname] = definition;
            if (!ItemManager.itemList.Contains(definition))
                ItemManager.itemList.Add(definition);
        }

        private static void RemoveDefinitionFromCollections(ItemDefinition definition)
        {
            ItemManager.itemDictionary.Remove(definition.itemid);
            ItemManager.itemDictionaryByName.Remove(definition.shortname);
            ItemManager.itemList.Remove(definition);
        }
        #endregion

        #region CloneItemDefinition
        private static ItemDefinition CloneItemDefinition(ItemDefinition itemDefinition)
        {
            if (itemDefinition == null)
                return null;
            GameObject clone = UnityEngine.Object.Instantiate(itemDefinition.gameObject);
            UnityEngine.Object.DontDestroyOnLoad(clone);
            return clone.GetComponent<ItemDefinition>();
        }

        private static ItemDefinition CloneItemDefinition(string shortname) => CloneItemDefinition(ItemManager.FindItemDefinition(shortname));
        private static ItemDefinition CloneItemDefinition(int itemId) => CloneItemDefinition(ItemManager.FindItemDefinition(itemId));
        #endregion

        #region Blueprint Bypasses
        private static void SendSnapshotWithUnlockedBlueprint(BasePlayer player, int itemId)
        {
            if (player == null || player.net == null || !player.IsConnected)
                return;

            Network.Connection connection = player.net.connection;
            try
            {
                NetWrite netWrite = Network.Net.sv.StartWrite();
                global::BaseNetworkable.SaveInfo saveInfo = new global::BaseNetworkable.SaveInfo
                {
                    forConnection = player.net.connection,
                    forDisk = false
                };
                netWrite.PacketID(Message.Type.Entities);
                netWrite.UInt32(connection.validate.entityUpdates + 1U);
                using (saveInfo.msg = Facepunch.Pool.Get<ProtoBuf.Entity>())
                {
                    player.Save(saveInfo);
                    Interface.Oxide.CallHook("OnEntitySaved", player, saveInfo);
                    ProtoBuf.PersistantPlayer persistantData = saveInfo.msg.basePlayer.persistantData;
                    if (persistantData != null && persistantData.unlockedItems != null && !persistantData.unlockedItems.Contains(itemId))
                        persistantData.unlockedItems.Add(itemId);
                    saveInfo.msg.WriteToStream(netWrite);
                }
                netWrite.Send(new SendInfo(player.net.connection));
            }
            catch (Exception ex)
            {
                UnityEngine.Debug.LogException(ex);
            }
            finally
            {
                connection.validate.entityUpdates++;
            }
        }

        private static void SendFakeUnlockedBlueprint(BasePlayer player, int itemId)
        {
            SendSnapshotWithUnlockedBlueprint(player, itemId);
            player.ClientRPC(RpcTarget.Player("UnlockedBlueprint", player), 0); // [Clientside RPC] Update blueprints
        }
        #endregion
        #endregion

        #region Obsolate
        [Obsolete]
        private static bool IsValidCustomItemDefinition(ItemDefinition definition) => IsValidCID(definition);
        #endregion
    }


    #region Dto Class
    public class ItemDefinitionDto : Pool.IPooled
    {
        public int parentItemId;
        public string shortname;
        public int? itemId;
        public uint iconFileId;
        public Translate.Phrase defaultName;
        public Translate.Phrase defaultDescription;
        public ulong defaultSkinId;
        public int? maxStackSize;
        public ItemCategory? category;
        public ItemDefinition.Flag flags;
        public ItemMod[] itemMods;
        public bool repairable;
        public bool craftable;
        public bool defaultBlueprintUnlocked;
        public List<ItemAmount> blueprintIngredients;
        public int workbenchLevelRequired;
        public List<(Translate.Phrase label, Translate.Phrase text)> staticOwnerships;

        public ItemDefinition ParentDefinition => ItemManager.FindItemDefinition(parentItemId);

        internal void FillEmptyValues()
        {
            if (!itemId.HasValue && !string.IsNullOrEmpty(shortname))
                itemId = shortname.GetHashCode();

            if (defaultName != null && string.IsNullOrEmpty(defaultName.token) && !string.IsNullOrEmpty(shortname))
                defaultName.token = shortname;

            if (defaultDescription != null && string.IsNullOrEmpty(defaultDescription.token) && !string.IsNullOrEmpty(shortname))
                defaultDescription.token = $"{shortname}.desc";
        }

        internal void Validate(Plugin plugin)
        {
            if (string.IsNullOrEmpty(shortname) || parentItemId == default)
                throw new Exception(string.Format("Error of incorrect data provided by the plugin \"{0}\": The fields shortname, parentItemId is required", plugin.Name));

            if (ItemManager.FindItemDefinition(shortname) != null)
                throw new Exception(string.Format("Error of incorrect data provided by the plugin \"{0}\": Shortname must be unique! The provided shortname - \"{1}\"", plugin.Name, shortname));

            if (ItemManager.FindItemDefinition(itemId.Value) != null)
                throw new Exception(string.Format("Error of incorrect data provided by the plugin \"{0}\": ItemId must be unique! The provided itemId - \"{1}\"", plugin.Name, itemId));

            ItemDefinition parent = this.ParentDefinition;
            if (parent == null)
                throw new Exception(string.Format("Error of incorrect data provided by the plugin \"{0}\": ItemDefinition by parentItemId not found! The provided parentItemId - \"{1}\"", plugin.Name, parentItemId));

            if (parent.gameObject.scene.isLoaded)
                throw new Exception(string.Format("Error by the plugin \"{0}\": You cannot use a custom ItemDefinition as a parent!", plugin.Name));
        }

        public static ItemDefinitionDto FromObject(object @object)
        {
            Type cidType = typeof(ItemDefinitionDto);
            Type argType = @object.GetType();
            ItemDefinitionDto @new = Pool.Get<ItemDefinitionDto>();

            foreach (PropertyInfo propertyInfo in argType.GetProperties())
                SetField(@new, propertyInfo.Name, propertyInfo.GetValue(@object));

            foreach (FieldInfo fieldInfo in argType.GetFields())
                SetField(@new, fieldInfo.Name, fieldInfo.GetValue(@object));

            void SetField(ItemDefinitionDto cid, string fieldName, object value)
            {
                FieldInfo fieldInfo = cidType.GetField(fieldName);
                if (fieldInfo == null)
                {
                    UnityEngine.Debug.LogWarning(string.Format("[CID] The field named \"{0}\" is missing in the CustomItemDefinition class, skipped.", fieldName));
                    return;
                }
                try
                {
                    if (fieldInfo.FieldType == typeof(Translate.Phrase) && value is string @string)
                        value = new Translate.Phrase(string.Empty, @string);

                    fieldInfo.SetValue(cid, value);
                }
                catch (Exception ex)
                {
                    UnityEngine.Debug.LogWarning(string.Format("[CID] The field named \"{0}\" has error [ {1} ], skipped.", fieldName, ex.Message));
                }
            }
            return @new;
        }

        public void EnterPool()
        {
            parentItemId = default;
            shortname = default;
            itemId = default;
            defaultName = default;
            defaultDescription = default;
            defaultSkinId = default;
            maxStackSize = default;
            category = default;
            flags = default;
            itemMods = default;
            repairable = default;
            craftable = default;
            blueprintIngredients = default;
            workbenchLevelRequired = default;
            staticOwnerships = default;
        }

        public void LeavePool() { }
    }
    #endregion
}
#endregion


#region Extensions
namespace Oxide.Plugins.CustomItemDefinitionExtensions
{
    public static class PluginExtensions
    {
        public static PluginContext CID(this Plugin plugin) => For(plugin);
    }

    public static class ItemModExtensions
    {
        public static void CopyFields(this ItemMod from, ItemMod to)
        {
            if ((from as object) == null || (to as object) == null)
                return;

            Type type = from.GetType();
            do
            {
                foreach (FieldInfo field in from.GetType().GetFields(BindingFlags.Static | BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.SetField))
                    field.SetValue(to, field.GetValue(from));

                if (type == typeof(ItemMod))
                    break;

                type = type.BaseType;
            }
            while (type != null);
        }
    }
}
#endregion  
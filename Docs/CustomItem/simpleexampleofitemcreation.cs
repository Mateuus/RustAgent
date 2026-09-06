using Oxide.Core.Plugins;
using System;
using System.Collections.Generic;

namespace Oxide.Plugins
{
    [Info("CIDLibraryDemo", "0xF", "0.0.0")]
    partial class CIDLibraryDemo : RustPlugin
    {
        [PluginReference]
        private Plugin CustomItemDefinitions;

        public static CIDLibraryDemo Instance;
        private static readonly ItemDefinition PARENT_DEFINITION = ItemManager.FindItemDefinition("longsword");

        void Init()
        {
            Instance = this;
        }

        void OnServerInitialized(bool initial)
        {
            CheckCID();
        }

        void OnCIDLoaded(Plugin library = null)
        {
            CustomItemDefinitions ??= library;
            RegisterItems();
        }

        private void CheckCID()
        {
            if (CustomItemDefinitions == null)
                throw new Exception("The library CustomItemDefinitions not installed or loaded. Please download it from https://codefling.com/extensions/custom-item-definitions");

            if (CustomItemDefinitions.Version.Major < 2)
                throw new Exception("The version of the CustomItemDefinitions library being used is outdated for use by this plugin. Use version 2.* or higher.");
        }

        private void RegisterItems()
        {
            CheckCID();

            CustomItemDefinitions.Call<ItemDefinition>("Register", new
            {
                // Not all available fields are listed here.
                // You can view all available fields by looking at the CustomItemDefinition class in the library.
                shortname = "test.demoitem",
                parentItemId = PARENT_DEFINITION.itemid,
                maxStackSize = 1,
                category = ItemCategory.Weapon,
                defaultName = "Name for an item with multilingual support", // autogenerate from string OR new Translate.Phrase("some_token_for_name", "english-version")
                defaultDescription = "Description for an item with multilingual support", // autogenerate from string OR new Translate.Phrase("some_token_for_desc", "english-version")
                defaultSkinId = 2973264769,
                staticOwnerships = new List<(Translate.Phrase label, Translate.Phrase text)>
                {
                    new ("TEST 1", "Test 1 ToolTip"), // OR new (new Translate.Phrase("lang_static_ownership_label_1", "TEST 1"), new Translate.Phrase("lang_static_ownership_text_1", "Test 1 ToolTip")) 
                    new ("TEST 2", "Test 2 ToolTip"), 
                },
                itemMods = new ItemMod[]
                {
                    PARENT_DEFINITION.GetComponent<ItemModEntity>(), // This modifier is responsible for the sword's Held Entity and is present in the parent, but you can create your own.
                    new ItemModTest()
                    {
                        onItemCreatedLogMessage = "Custom item created with ID: {0}"
                    }
                }
            }, this);
        }

        private class ItemModTest : ItemMod
        {
            public string onItemCreatedLogMessage;

            public override void ModInit()
            {
                base.ModInit();
                CIDLibraryDemo.Instance.Puts("ModInit");
            }

            public override void OnItemCreated(Item item)
            {
                base.OnItemCreated(item);
                if (!string.IsNullOrEmpty(onItemCreatedLogMessage))
                    CIDLibraryDemo.Instance.Puts(string.Format(onItemCreatedLogMessage, item.uid));
            }

            // Used when a player is attacked for an item with the ItemModWearable mod when ItemModWearable.ProtectsArea().
            // Not applicable to the item in the example, only mentioned for illustrative purposes.
            // There are other methods of overriding.
            public override void OnAttacked(Item item, HitInfo info)
            {
                base.OnAttacked(item, info);
                CIDLibraryDemo.Instance.Puts(string.Format("OnAttacked | Item ID: {0}", item.uid));
            }
        }
    }
}
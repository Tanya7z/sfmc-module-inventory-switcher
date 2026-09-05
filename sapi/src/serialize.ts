/**
 * 背包物品序列化 / 反序列化（36 格 + 4 装备 + 副手）
 */

import {
  EntityEquippableComponent,
  EntityInventoryComponent,
  EquipmentSlot,
  ItemStack,
  Player,
} from "@minecraft/server";

/** 单格物品快照 */
export interface SerializedItem {
  typeId: string;
  amount: number;
  damage?: number;
  nameTag?: string;
  lore?: string[];
  enchantments?: Array<{ type: string; level: number }>;
}

/** 完整背包快照 */
export interface InventorySnapshot {
  slots: Array<SerializedItem | null>;
  armor: {
    head: SerializedItem | null;
    chest: SerializedItem | null;
    legs: SerializedItem | null;
    feet: SerializedItem | null;
  };
  offhand: SerializedItem | null;
  xp?: { level: number; totalXp: number };
}

const ARMOR_SLOTS = [
  EquipmentSlot.Head,
  EquipmentSlot.Chest,
  EquipmentSlot.Legs,
  EquipmentSlot.Feet,
] as const;

const ARMOR_KEYS = ["head", "chest", "legs", "feet"] as const;

/** 将 ItemStack 转为可 JSON 持久化结构。 */
export function serializeItem(item: ItemStack | undefined): SerializedItem | null {
  if (!item) return null;
  const out: SerializedItem = {
    typeId: item.typeId,
    amount: item.amount,
  };
  try {
    const dur = item.getComponent("minecraft:durability") as { damage?: number } | undefined;
    if (dur && typeof dur.damage === "number" && dur.damage > 0) out.damage = dur.damage;
  } catch {
    /* ignore */
  }
  if (item.nameTag) out.nameTag = item.nameTag;
  try {
    const lore = item.getLore();
    if (lore?.length) out.lore = lore.map(String);
  } catch {
    /* ignore */
  }
  try {
    const ench = item.getComponent("minecraft:enchantable") as
      | { getEnchantments?: () => Array<{ type: { id: string }; level: number }> }
      | undefined;
    const list = ench?.getEnchantments?.() ?? [];
    if (list.length) {
      out.enchantments = list.map((e) => ({ type: e.type.id, level: e.level }));
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** 从快照重建 ItemStack。 */
export function deserializeItem(data: SerializedItem | null | undefined): ItemStack | undefined {
  if (!data?.typeId) return undefined;
  try {
    const stack = new ItemStack(data.typeId, Math.max(1, data.amount || 1));
    if (data.nameTag) stack.nameTag = data.nameTag;
    if (data.lore?.length) {
      try {
        stack.setLore(data.lore);
      } catch {
        /* ignore */
      }
    }
    if (typeof data.damage === "number" && data.damage > 0) {
      try {
        const dur = stack.getComponent("minecraft:durability") as { damage?: number } | undefined;
        if (dur) dur.damage = data.damage;
      } catch {
        /* ignore */
      }
    }
    if (data.enchantments?.length) {
      try {
        const ench = stack.getComponent("minecraft:enchantable") as
          | { addEnchantment?: (e: { type: string; level: number }) => void }
          | undefined;
        for (const e of data.enchantments) {
          ench?.addEnchantment?.({ type: e.type, level: e.level });
        }
      } catch {
        /* ignore */
      }
    }
    return stack;
  } catch {
    return undefined;
  }
}

/** 读取玩家完整背包快照。 */
export function captureInventory(player: Player, saveXp = false): InventorySnapshot {
  const slots: Array<SerializedItem | null> = [];
  const inv = player.getComponent("inventory") as EntityInventoryComponent | undefined;
  const container = inv?.container;
  for (let i = 0; i < 36; i++) {
    slots.push(serializeItem(container?.getItem(i)));
  }

  const eq = player.getComponent("equippable") as EntityEquippableComponent | undefined;
  const armor = {
    head: serializeItem(eq?.getEquipment(EquipmentSlot.Head)),
    chest: serializeItem(eq?.getEquipment(EquipmentSlot.Chest)),
    legs: serializeItem(eq?.getEquipment(EquipmentSlot.Legs)),
    feet: serializeItem(eq?.getEquipment(EquipmentSlot.Feet)),
  };
  const offhand = serializeItem(eq?.getEquipment(EquipmentSlot.Offhand));

  const snap: InventorySnapshot = { slots, armor, offhand };
  if (saveXp) {
    snap.xp = { level: player.level, totalXp: player.getTotalXp() };
  }
  return snap;
}

/** 先清空再填充，杜绝复制漏洞。 */
export function applyInventory(player: Player, snap: InventorySnapshot): void {
  const inv = player.getComponent("inventory") as EntityInventoryComponent | undefined;
  const container = inv?.container;
  if (container) {
    for (let i = 0; i < container.size; i++) {
      container.setItem(i, undefined);
    }
  }
  const eq = player.getComponent("equippable") as EntityEquippableComponent | undefined;
  if (eq) {
    for (const slot of ARMOR_SLOTS) eq.setEquipment(slot, undefined);
    eq.setEquipment(EquipmentSlot.Offhand, undefined);
  }

  if (container) {
    for (let i = 0; i < 36; i++) {
      const item = deserializeItem(snap.slots[i] ?? null);
      if (item) container.setItem(i, item);
    }
  }
  if (eq) {
    for (let i = 0; i < ARMOR_KEYS.length; i++) {
      const key = ARMOR_KEYS[i]!;
      const slot = ARMOR_SLOTS[i]!;
      const item = deserializeItem(snap.armor[key]);
      if (item) eq.setEquipment(slot, item);
    }
    const off = deserializeItem(snap.offhand);
    if (off) eq.setEquipment(EquipmentSlot.Offhand, off);
  }

  if (snap.xp) {
    try {
      player.resetLevel();
      // 还原等级：逐级 addLevels 近似（API 无直接 setLevel）
      if (snap.xp.level > 0) player.addLevels(snap.xp.level);
    } catch {
      /* ignore */
    }
  }
}

/** 清空玩家全部栏位。 */
export function clearInventory(player: Player): void {
  applyInventory(player, {
    slots: Array.from({ length: 36 }, () => null),
    armor: { head: null, chest: null, legs: null, feet: null },
    offhand: null,
  });
}

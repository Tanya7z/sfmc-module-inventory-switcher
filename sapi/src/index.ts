/**
 * @sfmc-bds/module-inventory-switcher — 背包快照与多槽位切换服务
 */

import { Player, world } from "@minecraft/server";
import { config } from "@sfmc-bds/sdk/sapi/config";
import { db } from "@sfmc-bds/sdk/sapi/db";
import { ModuleRegistry } from "@sfmc-bds/sdk/module-loader";
import { debug, Permission } from "@sfmc-bds/sdk/sapi/runtime";
import { service } from "@sfmc-bds/sdk/sapi/service";
import { rowId } from "./ids.js";
import {
  applyInventory,
  captureInventory,
  clearInventory,
  type InventorySnapshot,
} from "./serialize.js";

const MODULE_ID = "inventory-switcher";
const TABLE = "sfmc_inventories";
const DEFAULT_SLOT = "default";

const unprovide: Array<() => void> = [];
let maxSlots = 5;
let saveXp = false;

function findPlayer(playerId: string): Player | undefined {
  return world.getAllPlayers().find((p) => p.id === playerId);
}

async function countSlots(playerId: string): Promise<number> {
  const rows = await db.query<{ id: string }>(TABLE, {
    where: { eq: ["player_id", playerId] },
    limit: 100,
  });
  return rows.length;
}

async function upsertSnapshot(
  playerId: string,
  slotKey: string,
  snap: InventorySnapshot,
): Promise<void> {
  const id = rowId(playerId, slotKey);
  const row = {
    id,
    player_id: playerId,
    slot_key: slotKey,
    items_data: JSON.stringify(snap),
    updated_at: Date.now(),
  };
  await db.tx(async (tx) => {
    const existing = await tx.get(TABLE, id);
    if (existing) await tx.update(TABLE, id, row);
    else await tx.insert(TABLE, row);
  });
}

async function loadSnapshot(
  playerId: string,
  slotKey: string,
): Promise<InventorySnapshot | null> {
  const id = rowId(playerId, slotKey);
  const row = await db.get<{ items_data: string }>(TABLE, id);
  if (!row?.items_data) return null;
  try {
    return JSON.parse(String(row.items_data)) as InventorySnapshot;
  } catch {
    return null;
  }
}

async function deleteSnapshot(
  playerId: string,
  slotKey: string,
): Promise<void> {
  const id = rowId(playerId, slotKey);
  await db.tx(async (tx) => {
    await tx.delete(TABLE, id);
  });
}

async function handleSave(
  input: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  const playerId = String(input.playerId ?? "");
  const slotKey = String(input.slotKey ?? DEFAULT_SLOT) || DEFAULT_SLOT;
  const clearCurrent = Boolean(input.clearCurrent);
  const player = findPlayer(playerId);
  if (!player) return { ok: false };

  const existing = await loadSnapshot(playerId, slotKey);
  if (!existing) {
    const n = await countSlots(playerId);
    if (n >= maxSlots) return { ok: false };
  }

  const snap = captureInventory(player, saveXp);
  await upsertSnapshot(playerId, slotKey, snap);
  if (clearCurrent) clearInventory(player);
  return { ok: true };
}

async function handleRestore(
  input: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  const playerId = String(input.playerId ?? "");
  const slotKey = String(input.slotKey ?? DEFAULT_SLOT) || DEFAULT_SLOT;
  const clearAfter = Boolean(input.clearAfter);
  const player = findPlayer(playerId);
  if (!player) return { ok: false };
  const snap = await loadSnapshot(playerId, slotKey);
  if (!snap) return { ok: false };
  applyInventory(player, snap);
  if (clearAfter) await deleteSnapshot(playerId, slotKey);
  return { ok: true };
}

async function handleSwitch(
  input: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  const playerId = String(input.playerId ?? "");
  const fromSlotKey = String(input.fromSlotKey ?? "");
  const toSlotKey = String(input.toSlotKey ?? "");
  if (!playerId || !fromSlotKey || !toSlotKey) return { ok: false };
  const player = findPlayer(playerId);
  if (!player) return { ok: false };

  const current = captureInventory(player, saveXp);
  const target = await loadSnapshot(playerId, toSlotKey);
  await upsertSnapshot(playerId, fromSlotKey, current);
  if (target) applyInventory(player, target);
  else clearInventory(player);
  return { ok: true };
}

async function handleClear(
  input: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  const playerId = String(input.playerId ?? "");
  const backupSlotKey =
    typeof input.backupSlotKey === "string" ? input.backupSlotKey : undefined;
  const player = findPlayer(playerId);
  if (!player) return { ok: false };
  if (backupSlotKey) {
    const snap = captureInventory(player, saveXp);
    await upsertSnapshot(playerId, backupSlotKey, snap);
  }
  clearInventory(player);
  return { ok: true };
}

async function handleHas(
  input: Record<string, unknown>,
): Promise<{ exists: boolean }> {
  const playerId = String(input.playerId ?? "");
  const slotKey = String(input.slotKey ?? "");
  if (!playerId || !slotKey) return { exists: false };
  const snap = await loadSnapshot(playerId, slotKey);
  return { exists: !!snap };
}

ModuleRegistry.register({
  id: MODULE_ID,
  afterWorldLoad: true,
  lifecycle: {
    registerPermissions() {
      Permission.register("inv.admin", Permission.Admin);
    },
    registerEvents() {
      // 纯被动服务：不监听模式切换
    },
    async init() {
      const max = await config.get<number>("max_slots_per_player");
      const xp = await config.get<boolean>("save_xp_level");
      if (typeof max === "number" && max > 0) maxSlots = max;
      if (typeof xp === "boolean") saveXp = xp;

      await db.defineTable(TABLE, {
        id: { type: "TEXT", primary: true },
        player_id: { type: "TEXT", notNull: true, index: true },
        slot_key: { type: "TEXT", notNull: true, index: true },
        items_data: { type: "TEXT", notNull: true, default: "{}" },
        updated_at: { type: "INTEGER", notNull: true, default: 0 },
      });

      unprovide.push(
        service.provide("inventory.save", (input) => handleSave(input)),
      );
      unprovide.push(
        service.provide("inventory.restore", (input) => handleRestore(input)),
      );
      unprovide.push(
        service.provide("inventory.switch", (input) => handleSwitch(input)),
      );
      unprovide.push(
        service.provide("inventory.clear", (input) => handleClear(input)),
      );
      unprovide.push(
        service.provide("inventory.has", (input) => handleHas(input)),
      );

      debug.i("INV", `init maxSlots=${maxSlots} saveXp=${saveXp}`);
    },
    cleanup() {
      for (const off of unprovide.splice(0, unprovide.length)) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      debug.i("INV", "cleanup");
    },
  },
});

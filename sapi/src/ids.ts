/** 行主键工具（无 @minecraft 依赖，便于单测）。 */

/** 行主键：player_id|slot_key */
export function rowId(playerId: string, slotKey: string): string {
  return `${playerId}|${slotKey}`;
}

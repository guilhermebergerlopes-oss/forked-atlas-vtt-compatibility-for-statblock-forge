import type { AtlasSheetInstance } from '../api/sheets/types';

/**
 * Keep Atlas sheet instances alive when their token is deleted, but remove the stale association.
 * The returned record is structurally shared when no instance refers to one of the removed tokens.
 */
export function detachSheetInstancesFromTokens(
  instances: Record<string, AtlasSheetInstance>,
  tokenIds: readonly string[],
): Record<string, AtlasSheetInstance> {
  if (tokenIds.length === 0) return instances;
  const removed = new Set(tokenIds);
  let next = instances;

  for (const [instanceId, instance] of Object.entries(instances)) {
    if (instance.tokenId === undefined || !removed.has(instance.tokenId)) continue;
    if (next === instances) next = { ...instances };
    const { tokenId: _tokenId, ...unbound } = instance;
    next[instanceId] = unbound;
  }

  return next;
}

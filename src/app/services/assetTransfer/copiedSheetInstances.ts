import type { BundleFile } from '../collectionBundle/bundleFormat';
import { isRecord } from '../../utils/guards';

export type CopiedSheetInstanceIds = Map<string, string>;

/**
 * A copied scene is a separate Atlas state. Give its provider instances new identities while
 * keeping the same identity mapping across the scene map and all snapshots belonging to it.
 * Moves deliberately do not use this helper: moving a scene preserves its instance identities.
 */
export function cloneCopiedSceneSheetInstanceIds(
  content: string,
  file: Pick<BundleFile, 'role' | 'owners' | 'vaultPath'>,
  identities: CopiedSheetInstanceIds,
): string {
  if (file.role !== 'scene-map' && file.role !== 'scene-snapshot') return content;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (!isRecord(parsed) || !isRecord(parsed.state) || !isRecord(parsed.state.sheetInstances)) return content;

  const owner = file.owners?.[0] ?? file.vaultPath;
  const next: Record<string, unknown> = {};
  let changed = false;
  for (const [key, candidate] of Object.entries(parsed.state.sheetInstances)) {
    if (!isRecord(candidate)) {
      next[key] = candidate;
      continue;
    }
    const oldId = typeof candidate.id === 'string' ? candidate.id : key;
    // Snapshot state omits mapPath, but its Atlas-owned sceneId survives path remapping.
    // Prefer that stable scene identity so snapshots and map files share the same copied id,
    // even when more than one scene asset references the same map file.
    const sceneIdentity = typeof candidate.sceneId === 'string' ? candidate.sceneId : owner;
    const identityKey = `${sceneIdentity}\u0000${oldId}`;
    let id = identities.get(identityKey);
    if (!id) {
      id = crypto.randomUUID();
      while ([...identities.values()].includes(id)) id = crypto.randomUUID();
      identities.set(identityKey, id);
    }
    next[id] = { ...candidate, id };
    changed ||= id !== key || id !== candidate.id;
  }

  if (!changed) return content;
  parsed.state.sheetInstances = next;
  const rewritten = JSON.stringify(parsed, null, 2);
  return content.endsWith('\n') ? `${rewritten}\n` : rewritten;
}

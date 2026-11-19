import type { EventRef, Plugin } from 'obsidian';
import type { AtlasPublicAPI } from '../api/sheets/types';
import {
  findForgeStatblockNoteDependencies,
  FORGE_STATBLOCK_NOTE_CHANGED_EVENT,
  type ForgeStatblockNoteChange,
} from './forgeStatblockNoteObserver';

export interface ForgeStatblockRefreshReport {
  readonly sceneId: string;
  readonly sourceId: string;
  readonly matched: number;
  readonly refreshed: number;
  readonly failed: number;
}

/**
 * Refreshes every instance of one changed Forge note in the currently loaded Atlas scene.
 * It deliberately updates only Atlas' last-known definition snapshot/source revision; Resources
 * and token state are reconciled by a later host-owned stage.
 */
export async function refreshLoadedForgeNoteInstances(
  api: AtlasPublicAPI,
  sceneId: string,
  change: ForgeStatblockNoteChange,
  onError: (error: unknown, instanceId: string) => void = (error, instanceId) => {
    console.error(`[Atlas] Refreshing Forge sheet instance ${instanceId} failed:`, error);
  },
): Promise<ForgeStatblockRefreshReport> {
  if (change.kind !== 'updated' && change.kind !== 'renamed' && change.kind !== 'restored') {
    return Object.freeze({ sceneId, sourceId: change.sourceId, matched: 0, refreshed: 0, failed: 0 });
  }

  const instances = api.sheets.getInstances(sceneId);
  const dependencies = findForgeStatblockNoteDependencies([{ sceneId, instances }], change.sourceId);
  const results = await Promise.all(dependencies.map(async (dependency) => {
    try {
      await api.sheets.refreshInstance(dependency.instanceId);
      return true;
    } catch (error) {
      onError(error, dependency.instanceId);
      return false;
    }
  }));

  const refreshed = results.filter(Boolean).length;
  return Object.freeze({
    sceneId,
    sourceId: change.sourceId,
    matched: dependencies.length,
    refreshed,
    failed: dependencies.length - refreshed,
  });
}

/**
 * Connects the note observer event to the public Atlas sheet API. This intentionally targets the
 * one scene Atlas currently has loaded; inactive map tabs and closed map files are handled by the
 * later scene synchronization stages. Events for the same path are serialized in observer order.
 */
export function registerForgeStatblockNoteRefresh(
  plugin: Plugin,
  api: AtlasPublicAPI,
  getLoadedSceneId: () => string | null,
): void {
  let destroyed = false;
  const pathQueues = new Map<string, Promise<void>>();
  const latestSequence = new Map<string, number>();

  const handleChange = (change: ForgeStatblockNoteChange): void => {
    if (destroyed || !change || typeof change.sourceId !== 'string' || !change.sourceId.trim()
      || !Number.isInteger(change.sequence) || change.sequence < 1) return;
    const previousSequence = latestSequence.get(change.sourceId) ?? 0;
    if (change.sequence <= previousSequence) return;
    latestSequence.set(change.sourceId, change.sequence);

    const previous = pathQueues.get(change.sourceId);
    const operation = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (destroyed || (change.kind !== 'updated' && change.kind !== 'renamed' && change.kind !== 'restored')) return;
      let sceneId: string | null;
      try { sceneId = getLoadedSceneId(); }
      catch (error) {
        console.error('[Atlas] Could not identify the loaded scene for a Forge note refresh:', error);
        return;
      }
      if (!sceneId) return;
      try {
        await refreshLoadedForgeNoteInstances(api, sceneId, change);
      } catch (error) {
        console.error(`[Atlas] Refreshing instances for Forge note ${change.sourceId} failed:`, error);
      }
    });
    pathQueues.set(change.sourceId, operation);
    void operation.then(() => {
      if (pathQueues.get(change.sourceId) === operation) pathQueues.delete(change.sourceId);
    });
  };

  const eventRef: EventRef = plugin.app.workspace.on(FORGE_STATBLOCK_NOTE_CHANGED_EVENT, handleChange);
  plugin.registerEvent(eventRef);
  plugin.register(() => {
    destroyed = true;
    pathQueues.clear();
    latestSequence.clear();
  });
}

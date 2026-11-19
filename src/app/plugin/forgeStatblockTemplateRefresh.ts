import type { EventRef, Plugin } from 'obsidian';
import type { AtlasPublicAPI, AtlasSheetInstance } from '../api/sheets/types';
import { FORGE_SHEET_PROVIDER_ID } from '../services/providerStatblockPreview';
import { notifyForgeStatblockTokenRefresh } from './forgeStatblockTokenRefresh';
import {
  FORGE_STATBLOCK_TEMPLATE_CHANGED_EVENT,
  type ForgeStatblockTemplateChange,
} from './forgeStatblockTemplateObserver';

export interface ForgeStatblockTemplateRefreshReport {
  readonly sceneId: string;
  readonly templatePath: string;
  readonly matched: number;
  readonly refreshed: number;
  readonly failed: number;
}

export type ForgeStatblockTemplateRefreshErrorHandler = (error: unknown, instanceId: string) => void;
export type ForgeStatblockTemplateInstancesRefreshed = (sceneId: string, sourceId: string, instanceIds: readonly string[]) => void;

/**
 * Resolve every note-dependent Forge instance in one currently loaded scene again through its
 * registered provider. The provider owns note/template resolution (saved path first, stable ID
 * fallback, and duplicate-ID ambiguity); Atlas only commits the validated definition snapshot.
 *
 * The observer's dependency list is a candidate set. Before refreshing, Atlas re-reads the live
 * scene instances and verifies the provider/source identity so relinks between observation and
 * processing cannot refresh an unrelated source. Its own persistence operation only commits
 * sheet snapshots; a separate callback may notify map-local token synchronization after success.
 */
export async function refreshLoadedForgeTemplateInstances(
  api: AtlasPublicAPI,
  sceneId: string,
  change: ForgeStatblockTemplateChange,
  onError: ForgeStatblockTemplateRefreshErrorHandler = (error, instanceId) => {
    console.error(`[Atlas] Refreshing Forge template-dependent instance ${instanceId} failed:`, error);
  },
  onRefreshed: ForgeStatblockTemplateInstancesRefreshed = () => undefined,
): Promise<ForgeStatblockTemplateRefreshReport> {
  const notePaths = new Set(change.noteDependencies.map((dependency) => dependency.notePath));
  if (change.kind === 'deleted' || change.kind === 'invalid' || change.kind === 'unreadable') {
    return Object.freeze({ sceneId, templatePath: change.path, matched: 0, refreshed: 0, failed: 0 });
  }
  if (!sceneId || notePaths.size === 0) {
    return Object.freeze({ sceneId, templatePath: change.path, matched: 0, refreshed: 0, failed: 0 });
  }

  const instances: readonly AtlasSheetInstance[] = api.sheets.getInstances(sceneId);

  // Use the live Atlas-owned instance collection rather than trusting the observer's snapshot.
  // Multiple instances may intentionally refer to the same note and must remain independent.
  const dependencies = instances.filter((instance) =>
    instance.sceneId === sceneId
    && instance.source.providerId === FORGE_SHEET_PROVIDER_ID
    && notePaths.has(instance.source.sourceId),
  );

  const results = await Promise.all(dependencies.map(async (instance) => {
    try {
      await api.sheets.refreshInstance(instance.id);
      return true;
    } catch (error) {
      onError(error, instance.id);
      return false;
    }
  }));

  const refreshedDependencies = dependencies.filter((_, index) => results[index] === true);
  const bySource = new Map<string, string[]>();
  for (const instance of refreshedDependencies) {
    const ids = bySource.get(instance.source.sourceId) ?? [];
    ids.push(instance.id);
    bySource.set(instance.source.sourceId, ids);
  }
  for (const [sourceId, instanceIds] of bySource) {
    try { onRefreshed(sceneId, sourceId, Object.freeze(instanceIds)); }
    catch (error) { console.error(`[Atlas] Publishing Forge token refresh for ${sourceId} failed:`, error); }
  }

  const refreshed = refreshedDependencies.length;
  return Object.freeze({
    sceneId,
    templatePath: change.path,
    matched: dependencies.length,
    refreshed,
    failed: dependencies.length - refreshed,
  });
}

/**
 * Connect template-change notifications to the public sheet refresh API. Events are serialized
 * per template path and instances are independently serialized by refreshInstance(). The loaded
 * scene is resolved when queued work starts, not when the observer emitted the event.
 */
export function registerForgeStatblockTemplateRefresh(
  plugin: Plugin,
  api: AtlasPublicAPI,
  getLoadedSceneId: () => string | null,
  onRefreshed: ForgeStatblockTemplateInstancesRefreshed = (sceneId, sourceId, instanceIds) => {
    notifyForgeStatblockTokenRefresh(plugin.app, sceneId, sourceId, instanceIds);
  },
): void {
  let destroyed = false;
  const pathQueues = new Map<string, Promise<void>>();
  const latestSequence = new Map<string, number>();

  const handleChange = (change: ForgeStatblockTemplateChange): void => {
    if (destroyed || !change || typeof change.path !== 'string' || !change.path.trim()
      || !Number.isInteger(change.sequence) || change.sequence < 1
      || !Array.isArray(change.noteDependencies)) return;

    const previousSequence = latestSequence.get(change.path) ?? 0;
    if (change.sequence <= previousSequence) return;
    latestSequence.set(change.path, change.sequence);

    const previous = pathQueues.get(change.path);
    const operation = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
      // If a later template revision arrived while this item waited in the path queue, skip the
      // stale refresh; the newest event will resolve the provider once the queue reaches it.
      if (destroyed || latestSequence.get(change.path) !== change.sequence || change.noteDependencies.length === 0
        || change.kind === 'deleted' || change.kind === 'invalid' || change.kind === 'unreadable') return;
      let sceneId: string | null;
      try { sceneId = getLoadedSceneId(); }
      catch (error) {
        console.error('[Atlas] Could not identify the loaded scene for a Forge template refresh:', error);
        return;
      }
      if (!sceneId || destroyed) return;
      try {
        await refreshLoadedForgeTemplateInstances(api, sceneId, change, undefined, (refreshedSceneId, sourceId, instanceIds) => {
          if (!destroyed) onRefreshed(refreshedSceneId, sourceId, instanceIds);
        });
      } catch (error) {
        console.error(`[Atlas] Refreshing instances for Forge template ${change.path} failed:`, error);
      }
    });
    pathQueues.set(change.path, operation);
    void operation.then(() => {
      if (pathQueues.get(change.path) === operation) pathQueues.delete(change.path);
    });
  };

  const eventRef: EventRef = plugin.app.workspace.on(FORGE_STATBLOCK_TEMPLATE_CHANGED_EVENT, handleChange);
  plugin.registerEvent(eventRef);
  plugin.register(() => {
    destroyed = true;
    pathQueues.clear();
    latestSequence.clear();
  });
}

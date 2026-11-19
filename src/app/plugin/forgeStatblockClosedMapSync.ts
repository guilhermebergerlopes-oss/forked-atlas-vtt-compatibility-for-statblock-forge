import type { EventRef, Plugin, TFile } from 'obsidian';
import type { AtlasPublicAPI, AtlasSheetDefinition } from '../api/sheets/types';
import { sceneFromFile, sceneToFile } from '../resources/resourceFileFormat';
import type { ResourceDefinition } from '../resources/resourceTypes';
import type { StatblockFields } from '../resources/statblockResourceSync';
import { mapResources } from '../resources/collectionResources';
import { statblockTokenChanges } from '../pixi/token-renderer/statblockTokenSync';
import type { TokenEntity } from '../types';
import { parseSceneFile } from '../services/MapPersistence';
import { AssetService } from '../services/AssetService';
import { rulesLookup } from '../services/mapRules';
import { TokenStatblockLinkService } from '../services/TokenStatblockLinkService';
import { FORGE_SHEET_PROVIDER_ID } from '../services/providerStatblockPreview';
import {
  FORGE_STATBLOCK_NOTE_CHANGED_EVENT,
  type ForgeStatblockNoteChange,
} from './forgeStatblockNoteObserver';
import {
  FORGE_STATBLOCK_TEMPLATE_CHANGED_EVENT,
  type ForgeStatblockTemplateChange,
} from './forgeStatblockTemplateObserver';

interface SceneSerializationState {
  [key: string]: unknown;
  objects?: { tokens?: Record<string, object> } | null;
  tokenSettings?: object;
  initiative?: { entries?: unknown } | null;
}

interface ClosedMapRewriteInput {
  readonly content: string;
  readonly mapPath: string;
  readonly sourceId: string;
  readonly definition: AtlasSheetDefinition;
  readonly statblock: StatblockFields;
  readonly resourceDefinitions: readonly ResourceDefinition[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Update one serialized, closed scene for a resolved Forge note. The conversion boundary is the
 * same one used by normal map persistence: sceneFromFile() before editing and sceneToFile() after.
 * A null result means the file was invalid/newer or had no affected token/instance.
 */
export function rewriteClosedForgeMap(input: ClosedMapRewriteInput): string | null {
  const { content, mapPath, sourceId, definition, statblock, resourceDefinitions } = input;
  if (definition.providerId !== FORGE_SHEET_PROVIDER_ID || definition.sourceId !== sourceId) return null;

  let parsed;
  try {
    parsed = parseSceneFile(content);
  } catch {
    // A damaged or newer map must remain untouched; the normal map loader owns its recovery.
    return null;
  }

  const scene = sceneFromFile(parsed.state as SceneSerializationState);
  let changed = false;

  const tokens = scene.objects?.tokens as Record<string, TokenEntity> | undefined;
  if (tokens) {
    // This is the same pure reconciliation used for open maps. It preserves hand-set names,
    // current Resource values, manually overridden maxima, per-token art and independent links.
    const changes = statblockTokenChanges(tokens, sourceId, statblock, resourceDefinitions, null);
    for (const entry of changes) {
      const token = tokens[entry.id];
      if (!token) continue;
      tokens[entry.id] = { ...token, ...entry.changes } as TokenEntity;
      changed = true;
    }
  }

  const instances = (scene as Record<string, unknown>).sheetInstances;
  if (isRecord(instances)) {
    const nextInstances: Record<string, unknown> = { ...instances };
    let instancesChanged = false;
    for (const [id, raw] of Object.entries(instances)) {
      if (!isRecord(raw) || raw.id !== id || raw.sceneId !== mapPath || !isRecord(raw.source)) continue;
      if (raw.source.providerId !== FORGE_SHEET_PROVIDER_ID || raw.source.sourceId !== sourceId) continue;

      const next: Record<string, unknown> = { ...raw, lastKnownDefinition: definition };
      if (definition.revision !== undefined) next.sourceRevision = definition.revision;
      else delete next.sourceRevision;
      nextInstances[id] = next;
      instancesChanged = true;
    }
    if (instancesChanged) {
      (scene as Record<string, unknown>).sheetInstances = nextInstances;
      changed = true;
    }
  }

  if (!changed) return null;
  const state = sceneToFile(scene);
  return JSON.stringify({ ...parsed, state }, null, 2);
}

export type ForgeClosedMapIsOpen = (mapPath: string) => boolean;

/**
 * Synchronize saved .atlasmap files that are not open in an Atlas tab when Forge notes/templates
 * change. The provider resolves its own sheet definition; Atlas stores that validated snapshot and
 * reconciles linked token data using its existing statblock/Resource rules.
 */
export function registerForgeStatblockClosedMapSync(
  plugin: Plugin,
  api: AtlasPublicAPI,
  isMapOpen: ForgeClosedMapIsOpen,
): void {
  let destroyed = false;
  const sourceGenerations = new Map<string, number>();
  const sourceQueues = new Map<string, Promise<void>>();
  const mapQueues = new Map<string, Promise<void>>();
  const app = plugin.app;
  const assets = AssetService.getInstance(app);
  const links = TokenStatblockLinkService.getInstance(app);
  const mapIsOpen = (mapPath: string): boolean => {
    try { return isMapOpen(mapPath); }
    catch (error) {
      // If tab state cannot be read, fail closed: never write a scene that may be open and dirty.
      console.error(`[Atlas] Could not determine whether map ${mapPath} is open; skipping closed-map sync:`, error);
      return true;
    }
  };

  const processSource = async (sourceId: string, generation: number): Promise<void> => {
    if (destroyed || sourceGenerations.get(sourceId) !== generation) return;
    let provider;
    try { provider = api.sheets.getProviderDescriptor(FORGE_SHEET_PROVIDER_ID); }
    catch (error) {
      console.error(`[Atlas] Could not inspect the Forge provider for closed maps (${sourceId}):`, error);
      return;
    }
    if (!provider) return;

    let definition: AtlasSheetDefinition | null;
    try {
      definition = await api.sheets.getDefinition({ providerId: FORGE_SHEET_PROVIDER_ID, sourceId });
    } catch (error) {
      console.error(`[Atlas] Could not resolve Forge definition for closed maps (${sourceId}):`, error);
      return;
    }
    if (!definition || destroyed || sourceGenerations.get(sourceId) !== generation) return;

    let statblock: StatblockFields | null;
    try {
      statblock = await links.readStatblockRecord(sourceId);
    } catch (error) {
      console.error(`[Atlas] Could not read Forge statblock fields for closed maps (${sourceId}):`, error);
      return;
    }
    // Missing, invalid or ambiguous sources retain the last valid map snapshot and token values.
    if (!statblock || destroyed || sourceGenerations.get(sourceId) !== generation) return;

    try {
      await assets.initialize();
    } catch (error) {
      console.error('[Atlas] Could not initialize Collection rules for Forge closed-map sync:', error);
      return;
    }

    const files: TFile[] = app.vault.getFiles().filter((file: TFile) => file.extension.toLowerCase() === 'atlasmap');
    for (const file of files) {
      if (destroyed || sourceGenerations.get(sourceId) !== generation) return;
      if (mapIsOpen(file.path)) continue;
      await queueMap(file, sourceId, definition, statblock, generation);
    }
  };

  const queueMap = (
    file: TFile,
    sourceId: string,
    definition: AtlasSheetDefinition,
    statblock: StatblockFields,
    generation: number,
  ): Promise<void> => {
    const previous = mapQueues.get(file.path);
    const operation = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (destroyed || sourceGenerations.get(sourceId) !== generation || mapIsOpen(file.path)) return;
      try {
        await app.vault.process(file, (latestContent: string) => {
          // Atlas tabs may be opened while a map is waiting in the per-file queue.
          if (destroyed || sourceGenerations.get(sourceId) !== generation || mapIsOpen(file.path)) return latestContent;
          try {
            const rewritten = rewriteClosedForgeMap({
              content: latestContent,
              mapPath: file.path,
              sourceId,
              definition,
              statblock,
              resourceDefinitions: mapResources(rulesLookup(app, assets), file.path),
            });
            return rewritten ?? latestContent;
          } catch (error) {
            console.error(`[Atlas] Could not reconcile Forge-linked tokens in closed map ${file.path}:`, error);
            return latestContent;
          }
        });
      } catch (error) {
        console.error(`[Atlas] Could not update closed map ${file.path} for Forge source ${sourceId}:`, error);
      }
    });
    mapQueues.set(file.path, operation);
    void operation.then(() => {
      if (mapQueues.get(file.path) === operation) mapQueues.delete(file.path);
    });
    return operation;
  };

  const scheduleSource = (sourceId: string): void => {
    if (destroyed || !sourceId.trim()) return;
    const generation = (sourceGenerations.get(sourceId) ?? 0) + 1;
    sourceGenerations.set(sourceId, generation);
    const previous = sourceQueues.get(sourceId);
    const operation = (previous ?? Promise.resolve()).catch(() => undefined)
      .then(() => processSource(sourceId, generation))
      .catch((error: unknown) => { console.error(`[Atlas] Closed-map Forge synchronization failed for ${sourceId}:`, error); });
    sourceQueues.set(sourceId, operation);
    void operation.then(() => {
      if (sourceQueues.get(sourceId) !== operation) return;
      sourceQueues.delete(sourceId);
      if (sourceGenerations.get(sourceId) === generation) sourceGenerations.delete(sourceId);
    });
  };

  const onNoteChanged = (change: ForgeStatblockNoteChange): void => {
    if (!change || (change.kind !== 'updated' && change.kind !== 'restored') || typeof change.sourceId !== 'string') return;
    scheduleSource(change.sourceId);
  };
  const onTemplateChanged = (change: ForgeStatblockTemplateChange): void => {
    if (!change || !Array.isArray(change.noteDependencies)
      || change.kind === 'deleted' || change.kind === 'invalid' || change.kind === 'unreadable') return;
    // The observer's dependencies are vault-wide, not limited to the scene currently open.
    for (const dependency of change.noteDependencies) {
      if (typeof dependency?.notePath === 'string') scheduleSource(dependency.notePath);
    }
  };

  const noteRef: EventRef = app.workspace.on(FORGE_STATBLOCK_NOTE_CHANGED_EVENT, onNoteChanged);
  const templateRef: EventRef = app.workspace.on(FORGE_STATBLOCK_TEMPLATE_CHANGED_EVENT, onTemplateChanged);
  plugin.registerEvent(noteRef);
  plugin.registerEvent(templateRef);
  plugin.register(() => {
    destroyed = true;
    sourceGenerations.clear();
    sourceQueues.clear();
    mapQueues.clear();
  });
}

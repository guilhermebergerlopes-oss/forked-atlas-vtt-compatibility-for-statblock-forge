import { App, TFile, type EventRef } from 'obsidian';
import type { ViewAtlasStore } from '../storeFactory';
import type { TokenEntity } from '../types';
import type { TokenUpdates } from '../types/viewState';
import type { ResourceDefinition, ResourceDefsProvider } from '../resources/resourceTypes';
import {
  fillMissingResources, followStatblockResources, refieldedResources, type ResourceTokens, type StatblockFields,
} from '../resources/statblockResourceSync';
import { runUntracked } from '../stores/history';
import type { TokenStatblockLinkService, LinkChangeEvent } from '../services/TokenStatblockLinkService';
import { buildStatblockLinkUpdates } from '../pixi/token-renderer/statblockFrontmatter';
import { applyLinkChange, syncLinkedTokens } from '../pixi/token-renderer/statblockTokenSync';
import { runInBackground } from '../utils/backgroundTask';
import { statblockTokenAppearance } from './statblockTokenAppearance';
import { sceneTokens } from '../tokens/offMap';
import { frontmatterSource, hasForgeStatblockMetadata } from '../statblocks/notes/statblockSource';
import { FORGE_STATBLOCK_TOKEN_REFRESH_EVENT, isForgeStatblockTokenRefreshEvent, type ForgeStatblockTokenRefreshEvent } from './forgeStatblockTokenRefresh';

interface StatblockTokenLinks extends Pick<TokenStatblockLinkService,
  'readStatblockImage' | 'findAssetByAnyPath' | 'getStatblockLinkedToToken' |
  'linkTokenToStatblock' | 'readStatblockRecord'>, Partial<Pick<TokenStatblockLinkService, 'arePathsEquivalent'>> {
  on(event: 'link-changed', listener: (change: LinkChangeEvent) => void): void;
  off(event: 'link-changed', listener: (change: LinkChangeEvent) => void): void;
}

/** Keeps the tokens of one map in step with their linked notes, read through the statblock resolver. */
export class StatblockTokenSync {
  private readonly metadataChange: EventRef;
  private readonly forgeTokenRefresh: EventRef;
  private readonly forgeRefreshQueues = new Map<string, Promise<void>>();
  private readonly forgeRefreshGenerations = new Map<string, number>();
  /** Link changes of the statblock link service, applied in the order they came. */
  private linkChanges: Promise<void> = Promise.resolve();
  private destroyed = false;
  /** The resource definitions this map's tokens last followed, and the map they were read for. */
  private followedRules: { mapPath: string | null; definitions: readonly ResourceDefinition[] } | null = null;

  constructor(
    private readonly obsApp: App,
    private readonly store: ViewAtlasStore,
    private readonly tokenStatblockLinkService: StatblockTokenLinks,
    private readonly resourceDefsProvider: ResourceDefsProvider,
  ) {
    this.metadataChange = obsApp.metadataCache.on('changed', (file) => this.metadataChanged(file));
    this.forgeTokenRefresh = obsApp.workspace.on(FORGE_STATBLOCK_TOKEN_REFRESH_EVENT, this.handleForgeTokenRefresh);
    tokenStatblockLinkService.on('link-changed', this.handleLinkChange);
  }

  public prepareToken(token: TokenEntity): Promise<TokenEntity> {
    return statblockTokenAppearance(this.obsApp, token, this.tokenStatblockLinkService, this.resourceDefsProvider);
  }

  public destroy(): void {
    this.destroyed = true;
    this.obsApp.metadataCache.offref(this.metadataChange);
    this.obsApp.workspace.offref(this.forgeTokenRefresh);
    this.forgeRefreshQueues.clear();
    this.forgeRefreshGenerations.clear();
    this.tokenStatblockLinkService.off('link-changed', this.handleLinkChange);
  }

  /**
   * Template edits do not modify the Markdown note, so metadataCache.changed cannot see them.
   * Once the public provider has refreshed its Atlas snapshot, reread the note through the normal
   * statblock resolver and apply the same token/resource rules used by note edits.
   */
  private readonly handleForgeTokenRefresh = (value: unknown): void => {
    if (this.destroyed || !isForgeStatblockTokenRefreshEvent(value)) return;
    const change: ForgeStatblockTokenRefreshEvent = value;
    const initial = this.store.getState();
    if (!initial.mapLoaded || initial.mapPath !== change.sceneId || initial.isPlayerView) return;

    const sourceId = change.sourceId;
    const generation = (this.forgeRefreshGenerations.get(sourceId) ?? 0) + 1;
    this.forgeRefreshGenerations.set(sourceId, generation);
    const previous = this.forgeRefreshQueues.get(sourceId);
    const operation = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (this.destroyed || this.forgeRefreshGenerations.get(sourceId) !== generation) return;
      const beforeRead = this.store.getState();
      if (!beforeRead.mapLoaded || beforeRead.mapPath !== change.sceneId || beforeRead.isPlayerView) return;

      // Avoid resolving note data when no token in this map still follows this exact source path.
      const hasLinkedToken = Object.values(sceneTokens<TokenEntity>(this.store.getState().objects))
        .some((token) => token.kind === 'character' && token.statblockPath === sourceId);
      if (!hasLinkedToken) return;

      const statblock = await this.tokenStatblockLinkService.readStatblockRecord(sourceId);
      if (this.destroyed || this.forgeRefreshGenerations.get(sourceId) !== generation || !statblock) return;
      const latest = this.store.getState();
      if (!latest.mapLoaded || latest.mapPath !== change.sceneId || latest.isPlayerView) return;
      // A token may have been relinked while the note was being read. Re-check before invoking
      // the synchronizer as well as relying on its own live-path filter at write time.
      const stillHasLinkedToken = Object.values(sceneTokens<TokenEntity>(latest.objects))
        .some((token) => token.kind === 'character' && token.statblockPath === sourceId);
      if (!stillHasLinkedToken) return;

      // Uses syncedResources(), which already preserves current values and manually overridden maxima.
      // No art is copied from the shared note: each placed token owns its own artwork.
      syncLinkedTokens(this.store, sourceId, statblock, this.resourceDefsProvider(), null);
    }).catch((error: unknown) => {
      console.error(`[StatblockTokenSync] Failed to apply refreshed Forge template data for ${sourceId}:`, error);
    });
    this.forgeRefreshQueues.set(sourceId, operation);
    void operation.then(() => {
      if (this.forgeRefreshQueues.get(sourceId) === operation) this.forgeRefreshQueues.delete(sourceId);
    });
  };

  private async metadataChanged(file: TFile): Promise<void> {
    const frontmatter = this.obsApp.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontmatter) return;

    const source = frontmatterSource(frontmatter);
    // A malformed Forge link must not fall through to the legacy character-note markers.
    if (hasForgeStatblockMetadata(frontmatter) && source?.kind !== 'forge') return;

    // Forge-native v2 notes may contain only `statblock-forge`; they need the same refresh path
    // as legacy character notes after a numeric Field changes. Keep the legacy markers for
    // existing Atlas/Fantasy Statblocks notes.
    const isCharacter = source?.kind === 'forge'
      || frontmatter.hp !== undefined
      || frontmatter.statblock !== undefined
      || frontmatter.isCharacter === true
      || frontmatter.type === 'character';
    if (!isCharacter) return;

    const statblockPath = file.path;
    await this.linkTokenNamedByImage(file);

    // Linked tokens follow the statblock as the resolver reads it (renamed keys, meanings),
    // untracked: a statblock edit must not become an undo step of this map. Their art stays:
    // a statblock is shared by many tokens, and its picture is only one of them.
    const statblock = await this.tokenStatblockLinkService.readStatblockRecord(statblockPath);
    if (statblock && !this.destroyed) {
      syncLinkedTokens(this.store, statblockPath, statblock, this.resourceDefsProvider(), null);
    }
  }

  /**
   * A note whose picture names a token that links no statblock links that
   * token too. The picture alone never unlinks a token, takes one from another
   * statblock or changes the art of placed tokens: a statblock is shared by
   * many tokens, and its picture is only one of them.
   */
  private async linkTokenNamedByImage(file: TFile): Promise<void> {
    // Read through the link service so this listener and the writer agree
    // on which frontmatter key holds the statblock's image.
    const image = this.tokenStatblockLinkService.readStatblockImage(file);
    if (!image) return;
    const asset = await this.tokenStatblockLinkService.findAssetByAnyPath(image);
    if (!asset || asset.statblockPath) return;
    await this.tokenStatblockLinkService.linkTokenToStatblock(asset.imagePath, file.path, { updateStatblockAvatar: false, fromNote: true, assetId: asset.id });
  }

  // A link reads its statblock first, so the changes are applied one after another, in order.
  private readonly handleLinkChange = (event: LinkChangeEvent): void => {
    this.linkChanges = this.linkChanges.then(() => this.applyStatblockLinkChange(event));
  };

  /**
   * Linked tokens follow the map's rules as they are now (a map loaded, a collection's settings
   * saved): a resource that reads another statblock field than when they last followed them takes
   * that field's maximum, and they start the resources they do not hold yet.
   */
  public followRules(): void {
    const state = this.store.getState();
    if (state.isPlayerView) return;
    const definitions = this.resourceDefsProvider();
    const seen = this.followedRules;
    this.followedRules = { mapPath: state.mapPath, definitions };
    // Another map's rules say nothing of what this map's tokens hold
    const refielded = seen && seen.mapPath === state.mapPath ? refieldedResources(seen.definitions, definitions) : [];
    runInBackground(
      followStatblockResources(this.resourceTokens(), definitions, refielded, this.readStatblock),
      'Following token resources',
    );
  }

  /** Linked tokens start the collection's resources they do not hold yet, e.g. one defined after they were placed. */
  public fillMissingResources(): void {
    if (this.store.getState().isPlayerView) return;
    runInBackground(
      fillMissingResources(this.resourceTokens(), this.resourceDefsProvider(), this.readStatblock),
      'Starting missing token resources',
    );
  }

  private resourceTokens(): ResourceTokens {
    return {
      tokens: () => this.store.getState().objects.tokens,
      // Not an edit of the game master's: it must not become an undo step.
      apply: (entries) => runUntracked(this.store, () => this.store.getState().updateTokens(entries)),
    };
  }

  private readonly readStatblock = (path: string): Promise<StatblockFields | null> => this.tokenStatblockLinkService.readStatblockRecord(path);

  /**
   * Applies a link change to the open map. A link reads its statblock through the resolver first,
   * as closed maps are linked, so renamed keys and the template's meanings count.
   */
  private async applyStatblockLinkChange(event: LinkChangeEvent): Promise<void> {
    try {
      const statblock = event.type === 'linked' && event.statblockPath
        ? await this.tokenStatblockLinkService.readStatblockRecord(event.statblockPath)
        : null;
      if (this.destroyed) return;
      applyLinkChange(
        this.store,
        event,
        (token, statblockPath) => statblock && this.statblockLinkUpdates(token, statblockPath, statblock),
        this.tokenStatblockLinkService.arePathsEquivalent
          ? (left, right) => this.tokenStatblockLinkService.arePathsEquivalent!(left, right)
          : undefined,
      );
    } catch (error) {
      console.error('[StatblockTokenSync] Failed to apply a statblock link change:', error);
    }
  }

  private statblockLinkUpdates(token: TokenEntity, statblockPath: string, statblock: StatblockFields): TokenUpdates {
    const currentName = token.kind === 'character' ? token.name : undefined;
    return {
      statblockPath,
      // Maxima set by hand belonged to the previous statblock.
      overriddenMax: undefined,
      ...buildStatblockLinkUpdates(
        statblock, currentName, this.resourceDefsProvider(), token.resources,
        token.kind === 'character' && token.statblockNameOverridden === true,
      ),
    };
  }
}

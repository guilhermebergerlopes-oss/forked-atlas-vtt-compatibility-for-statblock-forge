import { StatblockTokenImportService } from './StatblockTokenImportService';
import { App, TFile } from 'obsidian';
import { EventEmitter } from 'events';
import { AssetService, type TokenAsset } from './AssetService';
import { difficultyLabel } from '../creatures/statblockRating';
import { mapResources } from '../resources/collectionResources';
import { rulesLookup } from './mapRules';
import { tokenFromFile, tokenToFile } from '../resources/resourceFileFormat';
import type { ResourceDefinition } from '../resources/resourceTypes';
import { startingResources } from '../resources/statblockResourceValues';
import type { StatblockFields } from '../resources/statblockResourceSync';
import type { FieldMeanings } from '../statblocks/resolve/fieldMeanings';
import { readStatblockRecord } from '../statblocks/resolve/statblockRecord';
import { cachedFrontmatter, frontmatterSource, hasForgeFrontmatterMarkerInText, hasForgeStatblockMetadata } from '../statblocks/notes/statblockSource';
import { isPersistedMapEnvelope } from './MapPersistence';
import { STATBLOCK_IMAGE_KEYS } from './statblockImageKeys';
import { followsAssetLinkChange } from '../characters/statblockLinkPrecedence';
import { statblockImageSrc } from '../statblocks/render/shared/statblockImage';
import { NoteFieldWriter } from '../statblocks/notes/NoteFieldWriter';
import type { NotePatch } from '../statblocks/notes/patchTypes';
import type { BaseToken, Character } from '../types';
import { t } from '../i18n';
import { showNotice } from '../ui/notice';

export interface TokenStatblockLink {
  tokenImagePath: string;
  statblockPath: string;
}

/**
 * The statblock-derived fields of a token read from a map file. Linking
 * writes them onto the token whatever its `kind`, so all are optional here.
 */
type StoredStatblockFields = Pick<BaseToken, 'imagePath'>
  & Partial<Pick<BaseToken, 'assetId'>>
  & Partial<Pick<Character, 'name' | 'difficulty' | 'statblockPath' | 'statblockName' | 'statblockNameOverridden' | 'resources' | 'overriddenMax'>>;

function nonEmpty<T extends object>(record: T): T | undefined {
  return Object.keys(record).length > 0 ? record : undefined;
}

/** A frontmatter scalar usable as text; YAML may hold a name or tier as a number. */
function frontmatterLabel(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A note's name as a notice names it: its file name without the folder and extension. */
function noteName(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/, '');
}

function setOrDelete<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) {
    delete target[key];
  } else {
    target[key] = value;
  }
}

export interface LinkChangeEvent {
  type: 'linked' | 'unlinked';
  /** The library record takes precedence over a shared image path when present. */
  assetId?: string;
  /** Legacy instances without an Asset ID may use the image fallback only when it is unique. */
  allowLegacyPathMatch?: boolean;
  tokenImagePath: string;
  statblockPath: string | null;
  previousStatblockPath?: string | null;
  /** A statblock note's image moved the link: open maps apply it untracked, as no edit of theirs. */
  fromNote?: boolean;
}

/**
 * Centralized service for managing token-statblock relationships. A token
 * links one statblock; a statblock may be linked by any number of tokens
 * (colour variants, NPCs sharing a creature). The statblock's picture is the
 * note's own `image`: linking fills it only where the note has none.
 */
export class TokenStatblockLinkService extends EventEmitter {
  private static instance: TokenStatblockLinkService | null = null;
  private app: App;
  private assetService: AssetService;
  
  private constructor(app: App) {
    super();
    this.app = app;
    this.assetService = AssetService.getInstance(app);
    // Initialize the AssetService
    this.assetService.initialize().catch(err => {
      console.error('[TokenStatblockLinkService] Failed to initialize AssetService:', err);
    });
  }
  
  static getInstance(app?: App): TokenStatblockLinkService {
    if (!TokenStatblockLinkService.instance) {
      if (!app) {
        throw new Error('TokenStatblockLinkService must be initialized with an App instance');
      }
      TokenStatblockLinkService.instance = new TokenStatblockLinkService(app);
    }
    return TokenStatblockLinkService.instance;
  }
  
  /**
   * Links the exact token Asset (by ID where available; by unique artwork for legacy callers) to a statblock. Other
   * tokens linked to the statblock stay linked; this token's previous
   * statblock, if any, is unlinked. Map tokens spawned from the image are
   * updated too. With `updateStatblockAvatar` the token's art becomes the
   * statblock's picture when the note has none it can show (none, or a file
   * the vault no longer holds); a picture that shows is never replaced.
   * One notice at most: that the token moved here from another statblock,
   * else that it was linked, unless `notice` is false (a panel that shows
   * the link itself).
   */
  async linkTokenToStatblock(
    tokenImagePath: string, 
    statblockPath: string,
    options: {
      updateStatblockAvatar?: boolean;
      /** The note's image named the token (`StatblockTokenSync`); passed on with every event. */
      fromNote?: boolean;
      /** Whether a plain link is announced; a token moved from another statblock always is. */
      notice?: boolean;
      /** Exact library token record; prevents another asset with the same art being changed. */
      assetId?: string;
    } = {}
  ): Promise<boolean> {
    const { updateStatblockAvatar = true, fromNote = false, notice = true, assetId } = options;
    
    // Get the statblock file
    const statblockFile = this.app.vault.getAbstractFileByPath(statblockPath);
    if (!(statblockFile instanceof TFile)) {
      showNotice(t('link.notFound', { path: statblockPath }));
      return false;
    }
    
    // Resolve the exact Asset ID first. A path-only lookup is accepted only when
    // exactly one library token uses that artwork; duplicate art is ambiguous.
    const pathMatches = assetId ? [] : await this.findAssetsByAnyPath(tokenImagePath);
    if (!assetId && pathMatches.length > 1) {
      showNotice(t('link.ambiguousAsset'));
      return false;
    }
    const asset = assetId
      ? await this.findAssetByAnyPath(tokenImagePath, assetId)
      : pathMatches[0] ?? null;
    if (assetId && !asset) {
      console.warn(`[TokenStatblockLinkService] Token asset ${assetId} no longer exists; link was not changed.`);
      return false;
    }
    const finalTokenPath = asset?.imagePath ?? tokenImagePath;
    const allowLegacyPathMatch = await this.canMatchLegacyInstances(finalTokenPath, asset);

    // Check if this token is already linked to another statblock. Using the
    // canonical path prevents a resource URL from bypassing the old link.
    const currentStatblockPath = await this.getStatblockLinkedToToken(finalTokenPath, asset?.id);
    if (currentStatblockPath && currentStatblockPath !== statblockPath) {
      // A token links one statblock: it leaves its current one, which the notice below names.
      await this.unlinkToken(finalTokenPath, { updateStatblockAvatar: true, notify: false, notice: false, fromNote, ...(asset?.id && { assetId: asset.id }) });
    }

    if (asset) await this.assetService.updateAsset(asset.id, { statblockPath });

    if (updateStatblockAvatar && !this.showsStatblockImage(statblockFile)) {
      await this.updateStatblockImage(statblockPath, finalTokenPath);
    }
    
    // Wait a bit to ensure the save has completed
    await new Promise(resolve => window.setTimeout(resolve, 100));
    
    // Force the AssetService to reload its metadata
    await this.assetService.refreshMetadata();
    
    // Emit event
    this.emit('link-changed', {
      type: 'linked',
      ...(asset?.id && { assetId: asset.id }),
      allowLegacyPathMatch,
      tokenImagePath: finalTokenPath,
      statblockPath,
      previousStatblockPath: currentStatblockPath,
      ...(fromNote && { fromNote }),
    });
    
    // Update all spawned tokens on all maps
    await this.updateAllSpawnedTokens(finalTokenPath, statblockPath, asset?.id, currentStatblockPath, allowLegacyPathMatch);
    
    this.app.workspace.trigger('atlas-vtt:refresh-assets');
    
    const moved = currentStatblockPath !== null && currentStatblockPath !== statblockPath;
    if (moved) {
      showNotice(t('link.moved', { token: asset?.name ?? t('link.unknown'), previous: noteName(currentStatblockPath) }));
    } else if (notice) {
      showNotice(t('link.linked'));
    }
    
    return true;
  }
  
  /**
   * Unlinks a token from its statblock. Asset ID is authoritative; path-only unlinking requires unique artwork.
   * `notify` fires the asset-manager refresh event; pass false when the unlink
   * is one step of a larger operation that refreshes once at the end.
   * `fromNote` marks the event as one a statblock note's image caused.
   * `notice: false` shows no notice, for an unlink that is one step of a link.
   */
  async unlinkToken(
    tokenImagePath: string,
    options: { 
      updateStatblockAvatar?: boolean;
      notify?: boolean;
      fromNote?: boolean;
      notice?: boolean;
      /** Exact library token record; prevents another asset with the same art being changed. */
      assetId?: string;
    } = {}
  ): Promise<boolean> {
    const { updateStatblockAvatar = true, notify = true, fromNote = false, notice = true, assetId } = options;
    
    // Resolve alternate resource URLs to the canonical path. Path-only operations
    // are safe only when one library Asset uses that artwork.
    const pathMatches = assetId ? [] : await this.findAssetsByAnyPath(tokenImagePath);
    if (!assetId && pathMatches.length > 1) {
      showNotice(t('link.ambiguousAsset'));
      return false;
    }
    const asset = assetId
      ? await this.findAssetByAnyPath(tokenImagePath, assetId)
      : pathMatches[0] ?? null;
    if (assetId && !asset) return true; // The exact record is gone; do not unlink another asset with the same art.
    const finalTokenPath = asset?.imagePath ?? tokenImagePath;
    const allowLegacyPathMatch = await this.canMatchLegacyInstances(finalTokenPath, asset);
    const statblockPath = await this.getStatblockLinkedToToken(finalTokenPath, asset?.id);
    if (!statblockPath) return true; // Already unlinked

    // Match equivalent image paths, but only clear assets that actually carry
    // the relationship being removed.
    const tokenAssets = asset
      ? (asset.statblockPath === statblockPath ? [asset] : [])
      : (await this.assetService.getTokenAssets())
        .filter(candidate => this.arePathsEquivalent(candidate.imagePath, finalTokenPath) && candidate.statblockPath === statblockPath);

    for (const asset of tokenAssets) {
      // Explicitly set statblockPath to undefined to trigger removal
      await this.assetService.updateAsset(asset.id, { statblockPath: undefined });
    }
    
    // Wait a bit to ensure the save has completed
    await new Promise(resolve => window.setTimeout(resolve, 100));
    
    // Force the AssetService to reload its metadata to avoid cache issues
    await this.assetService.refreshMetadata();
    
    if (notify) this.app.workspace.trigger('atlas-vtt:refresh-assets');
    
    if (notice) showNotice(t('link.unlinked'));
    
    if (updateStatblockAvatar) await this.releaseStatblockImage(statblockPath, finalTokenPath);
    
    // Emit event
    this.emit('link-changed', {
      type: 'unlinked',
      ...(asset?.id && { assetId: asset.id }),
      allowLegacyPathMatch,
      tokenImagePath: finalTokenPath,
      statblockPath: null,
      previousStatblockPath: statblockPath,
      ...(fromNote && { fromNote }),
    });
    
    // Update all spawned tokens on all maps
    await this.updateAllSpawnedTokens(finalTokenPath, null, asset?.id, statblockPath, allowLegacyPathMatch);
    
    return true;
  }

  /**
   * A statblock whose picture is the art of a token that left it shows the
   * art of a token still linked to it, or no picture when none is left.
   */
  private async releaseStatblockImage(statblockPath: string, tokenImagePath: string): Promise<void> {
    const statblockFile = this.app.vault.getAbstractFileByPath(statblockPath);
    if (!(statblockFile instanceof TFile)) return;
    const currentImage = this.readStatblockImage(statblockFile);
    // Path comparison handles differing formats (app:// URLs, relative paths).
    if (!currentImage || !this.arePathsEquivalent(currentImage, tokenImagePath)) return;
    const [remaining] = await this.getTokensLinkedToStatblock(statblockPath);
    if (remaining) await this.updateStatblockImage(statblockPath, remaining);
    else await this.updateStatblockImage(statblockPath, tokenImagePath, false);
  }
  
  /**
   * Gets the statblock linked to a token.
   */
  async getStatblockLinkedToToken(tokenImagePath: string, assetId?: string): Promise<string | null> {
    if (assetId) {
      const exact = await this.assetService.getAssetById(assetId);
      // An Asset ID is authoritative. Never borrow another record's link just because
      // it happens to use the same artwork.
      return exact?.type === 'token' ? exact.statblockPath ?? null : null;
    }
    const tokenAssets = await this.findAssetsByAnyPath(tokenImagePath);
    // A legacy token has no identity beyond its art. Do not choose an arbitrary
    // relationship when multiple library Assets use the same image.
    return tokenAssets.length === 1 ? tokenAssets[0].statblockPath ?? null : null;
  }
  
  /** The image paths of every token asset linked to a statblock, in index order. */
  async getTokensLinkedToStatblock(statblockPath: string): Promise<string[]> {
    const tokenAssets = await this.assetService.getTokenAssets();
    return tokenAssets.filter(asset => asset.statblockPath === statblockPath).map(asset => asset.imagePath);
  }

  /**
   * Creates a token asset from the statblock's own artwork and links it.
   *
   * The reverse of the usual flow: rather than making a token first and linking
   * it, this imports a statblock that already carries an image.
   *
   * Returns the created token's image path, or null when there is nothing to
   * import or a token is already linked. The token goes into `collectionId`,
   * else the default collection.
   */
  async createTokenFromStatblockImage(statblockPath: string, collectionId?: string): Promise<string | null> {
    try {
      const collection = collectionId ?? this.assetService.getDefaultCollectionId();
      const result = await new StatblockTokenImportService(this.app, this.assetService).import([statblockPath], collection);
      const item = result.items[0];
      if (item?.asset) {
        const allowLegacyPathMatch = await this.canMatchLegacyInstances(item.asset.imagePath, item.asset);
        this.emit('link-changed', {
          type: 'linked',
          assetId: item.asset.id,
          allowLegacyPathMatch,
          tokenImagePath: item.asset.imagePath,
          statblockPath,
          previousStatblockPath: null,
        });
        showNotice(t('link.created', { name: item.name }));
        return item.asset.imagePath;
      }
      showNotice(item?.message ?? t('link.noneCreated'));
    } catch (error) {
      showNotice(error instanceof Error ? error.message : t('link.importFailed'));
    }
    return null;
  }

  /**
   * The statblock's avatar metadata. Fantasy Statblocks' `image` is
   * authoritative; `token` and legacy `token-image` are read as fallbacks.
   * Forge-native Fields are never interpreted as token avatars.
   */
  public readStatblockImage(file: TFile): string | null {
    const frontmatter = cachedFrontmatter(this.app, file);
    // In a Forge-native note `image` (or another familiar key) may be an
    // ordinary Forge Field. It is not Atlas' token-avatar metadata.
    if (frontmatterSource(frontmatter)?.kind === 'forge' || hasForgeStatblockMetadata(frontmatter)) return null;
    const images = STATBLOCK_IMAGE_KEYS.map((key) => frontmatter?.[key]);
    return images.find((image): image is string => typeof image === 'string' && image.length > 0) ?? null;
  }

  /** Whether the statblock has a picture that shows: a web address, or a file the vault holds. */
  private showsStatblockImage(file: TFile): boolean {
    const image = this.readStatblockImage(file);
    return image !== null && statblockImageSrc(this.app, image, file.path) !== '';
  }

  /**
   * Writes the token image into an Atlas/Fantasy note's frontmatter, through
   * the open editor when it has one. Forge-owned note Fields are left entirely
   * untouched. The legacy `token-image` key is cleared alongside `image` on
   * unlink; a user's `token` property is cleared only when it names this token.
   */
  /** Whether this note's `image` key is Atlas avatar metadata rather than a Forge Field. */
  private async canWriteStatblockImage(file: TFile): Promise<boolean> {
    const frontmatter = cachedFrontmatter(this.app, file);
    const source = frontmatterSource(frontmatter);
    if (source?.kind === 'forge' || hasForgeStatblockMetadata(frontmatter)) return false;
    // Forge v1 notes published by Atlas are Atlas-owned, despite retaining a
    // Forge backlink; all other raw Forge markers must remain untouched.
    if (source?.kind === 'atlas') return true;
    const content = await this.app.vault.cachedRead(file);
    return !hasForgeFrontmatterMarkerInText(content);
  }

  private async updateStatblockImage(statblockPath: string, tokenImagePath: string, linked = true): Promise<void> {
    const file = this.app.vault.getFileByPath(statblockPath);
    if (!(file instanceof TFile)) return;
    if (!(await this.canWriteStatblockImage(file))) return;
    const outcome = await NoteFieldWriter.forApp(this.app).patchNow(statblockPath, (frontmatter): NotePatch[] => {
      if (linked) return [{ op: 'set', path: ['image'], base: frontmatter?.image, next: tokenImagePath }];
      const cleared = (['image', 'token-image'] as const).flatMap((key): NotePatch[] => {
        const value = frontmatter?.[key];
        return value === undefined ? [] : [{ op: 'delete', path: [key], base: value }];
      });
      const token = frontmatter?.token;
      return typeof token === 'string' && this.arePathsEquivalent(token, tokenImagePath)
        ? [...cleared, { op: 'delete', path: ['token'], base: token }]
        : cleared;
    });
    if (outcome.problem) console.error(`[TokenStatblockLinkService] Could not write the image of ${statblockPath}: ${outcome.problem}`);
  }

  /**
   * Updates all spawned tokens on all maps that use the given image. A link whose
   * statblock is not known whole yet gives them the link alone.
   */
  private async updateAllSpawnedTokens(
    tokenImagePath: string,
    statblockPath: string | null,
    assetId?: string,
    previousStatblockPath?: string | null,
    allowLegacyPathMatch = true,
  ): Promise<void> {
    const mapFiles = this.app.vault.getFiles().filter(f => f.extension === 'atlasmap');
    const statblockData = statblockPath ? await this.extractStatblockData(statblockPath, true) : null;

    /** Returns the rewritten map JSON, or null when no token on the map uses the image. */
    const rewriteMap = (content: string, definitions: readonly ResourceDefinition[]): string | null => {
      const mapData: unknown = JSON.parse(content);
      if (!isPersistedMapEnvelope(mapData)) return null;

      const tokens = mapData.state?.objects?.tokens;
      if (!tokens) return null;

      let modified = false;

      const change = { assetId, allowLegacyPathMatch, tokenImagePath, previousStatblockPath, statblockPath };
      for (const [id, stored] of Object.entries<StoredStatblockFields>(tokens)) {
        if (!followsAssetLinkChange(stored, change, (left, right) => this.arePathsEquivalent(left, right))) continue;
        const token = tokenFromFile(stored);
        if (statblockPath) {
          token.statblockPath = statblockPath;

          if (statblockData) {
            token.statblockName = statblockData.name;
            if (token.statblockNameOverridden !== true) token.name = statblockData.name;
            // As on an open map: what the statblock supplies starts anew, the rest stays
            setOrDelete(token, 'resources', nonEmpty({ ...token.resources, ...startingResources(statblockData.record, definitions, statblockData.meanings, statblockData.forge) }));
            setOrDelete(token, 'difficulty', statblockData.difficulty);
            delete token.overriddenMax;
          }
        } else {
          // Unlink from statblock - clear ALL statblock-derived data
          delete token.statblockPath;
          if (token.statblockNameOverridden !== true) delete token.name;
          delete token.statblockName;
          delete token.statblockNameOverridden;
          delete token.resources;
          delete token.overriddenMax;
          delete token.difficulty;
        }
        (tokens as Record<string, object>)[id] = tokenToFile(token);
        modified = true;
      }

      return modified ? JSON.stringify(mapData, null, 2) : null;
    };

    for (const mapFile of mapFiles) {
      try {
        // Only a link reads the map's resources; an unlink clears whatever the token holds.
        const definitions = statblockData ? mapResources(rulesLookup(this.app, this.assetService), mapFile.path) : [];
        if (rewriteMap(await this.app.vault.read(mapFile), definitions) === null) continue;
        await this.app.vault.process(mapFile, (latest) => rewriteMap(latest, definitions) ?? latest);
      } catch (error) {
        console.error(`Error updating tokens in map ${mapFile.path}:`, error);
      }
    }
  }
  
  /** The fields of a statblock note with its template's meanings, as resources read them; null when the note is no statblock. */
  async readStatblockRecord(statblockPath: string): Promise<StatblockFields | null> {
    const data = await this.extractStatblockData(statblockPath);
    return data && {
      fields: data.record,
      meanings: data.meanings,
      ...(data.emptyFields.length > 0 && { emptyFields: data.emptyFields }),
      ...(data.forge ? { forge: data.forge } : {}),
    };
  }

  /**
   * Extracts relevant data from a statblock. While Fantasy Statblocks still parses
   * the vault, a creature read by name is not there yet and one that extends
   * another comes without it: with `wholeOnly` such a statblock gives no data.
   */
  private async extractStatblockData(statblockPath: string, wholeOnly = false): Promise<{
    name: string;
    difficulty?: string;
    /** The statblock's fields as the resolver gives them, with the note's frontmatter laid over them. */
    record: Record<string, unknown>;
    /** What the fields of the statblock's template mean (hit points, rating under other keys). */
    meanings: FieldMeanings;
    /** The template fields a native statblock's note leaves empty (`StatblockRecord.emptyFields`). */
    emptyFields: readonly string[];
    forge?: StatblockFields['forge'];
  } | null> {
    const read = await readStatblockRecord(this.app, statblockPath, wholeOnly);
    if (!read) return null;
    const { record, meanings, emptyFields, forge } = read;
    const displayKey = meanings['display-name'];
    const difficulty = difficultyLabel(record, meanings);
    return {
      // The name the statblock goes by on its card (`statblockDisplayName`); `name` stays its identity
      name: frontmatterLabel(displayKey === undefined ? undefined : record[displayKey]) ?? frontmatterLabel(record.name) ?? t('link.unknown'),
      ...(difficulty !== undefined && { difficulty }),
      record,
      meanings,
      emptyFields,
      ...(forge ? { forge } : {}),
    };
  }
  
  /**
   * Normalizes a resource path for comparison by extracting the essential file path.
   */
  private normalizeResourcePath(path: string): string {
    if (!path) return '';
    
    // Handle resource URLs (app://) - extract the actual file path
    if (path.startsWith('app://')) {
      // Find the start of the actual file path (after the protocol and ID)
      // Pattern: app://[hash]/[actual-path]?[timestamp]
      const match = path.match(/app:\/\/[^/]+\/(.+?)(?:\?.*)?$/);
      if (match && match[1]) {
        const extractedPath = match[1];
        // Check if it contains atlas-vtt path - find the LAST occurrence to handle nested paths
        if (extractedPath.includes('/atlas-vtt/')) {
          // Find the last atlas-vtt anchor point to handle paths like /test-vault/atlas-vtt/
          const atlasIndex = extractedPath.lastIndexOf('/atlas-vtt/');
          if (atlasIndex !== -1) {
            const normalizedPath = extractedPath.substring(atlasIndex + 1); // Remove leading slash
            return normalizedPath;
          }
        }
        
        // Also check for atlas-vtt without leading slash
        if (extractedPath.includes('atlas-vtt/')) {
          const atlasIndex = extractedPath.lastIndexOf('atlas-vtt/');
          if (atlasIndex !== -1) {
            const normalizedPath = extractedPath.substring(atlasIndex);
            return normalizedPath;
          }
        }
        
        // If no atlas-vtt anchor, return as-is (might already be normalized)
        return extractedPath;
      }
    }
    
    // For regular paths, ensure they start with atlas-vtt/ if they don't already
    let normalized = path;
    if (normalized.startsWith('/')) {
      normalized = normalized.substring(1);
    }
    
    return normalized;
  }
  
  /**
   * Compares two paths to determine if they reference the same file.
   * Handles resource URLs vs file paths and timestamp differences.
   */
  public arePathsEquivalent(path1: string, path2: string): boolean {
    if (!path1 || !path2) return path1 === path2;
    
    const normalized1 = this.normalizeResourcePath(path1);
    const normalized2 = this.normalizeResourcePath(path2);
    
    const result = normalized1 === normalized2;
    return result;
  }
  
  /**
   * The token asset named by an Asset ID, or by unique artwork in any path format;
   * null when no asset or more than one candidate matches.
   */
  async findAssetByAnyPath(path: string, assetId?: string): Promise<TokenAsset | null> {
    if (assetId) {
      const exact = await this.assetService.getAssetById(assetId);
      return exact?.type === 'token' ? exact : null;
    }
    const matches = await this.findAssetsByAnyPath(path);
    return matches.length === 1 ? matches[0] : null;
  }

  /** Every library token asset whose artwork resolves to this path, in library order. */
  private async findAssetsByAnyPath(path: string): Promise<TokenAsset[]> {
    const tokenAssets = await this.assetService.getTokenAssets();
    return tokenAssets.filter((asset) => asset.imagePath && this.arePathsEquivalent(asset.imagePath, path));
  }

  /** Legacy placed tokens may follow this Asset only when no other Asset shares its artwork. */
  private async canMatchLegacyInstances(path: string, exactAsset?: TokenAsset | null): Promise<boolean> {
    const matches = await this.findAssetsByAnyPath(path);
    const ids = new Set(matches.map((asset) => asset.id));
    if (exactAsset) ids.add(exactAsset.id);
    return ids.size <= 1;
  }
  
  /**
   * Cleanup method
   */
  destroy(): void {
    this.removeAllListeners();
    TokenStatblockLinkService.instance = null;
  }
}
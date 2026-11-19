import { TFile, type App, type EventRef, type Plugin, type TAbstractFile } from 'obsidian';
import type { AtlasSheetInstance } from '../api/sheets/types';
import { frontmatterOfText, frontmatterSource, hasForgeFrontmatterMarkerInText, hasForgeStatblockMetadata } from '../statblocks/notes/statblockSource';
import { forgeStatblockLinkFromFrontmatter, type ForgeStatblockTemplateLink } from '../statblocks/notes/forgeStatblockLink';
import { FORGE_SHEET_PROVIDER_ID } from '../services/providerStatblockPreview';

/** Workspace event emitted after Atlas has observed a Forge-native note change. */
export const FORGE_STATBLOCK_NOTE_CHANGED_EVENT = 'atlas-vtt:forge-statblock-note-changed';

export type ForgeStatblockNoteChangeKind = 'updated' | 'invalid' | 'unlinked' | 'unreadable' | 'renamed' | 'deleted' | 'restored';

/**
 * A note-level change notification. The note contents are deliberately not included: the Forge
 * provider remains the owner of parsing and normalized sheet data, and resolves it through
 * `getSheet(sourceId)` when a later synchronization stage asks for it.
 */
export interface ForgeStatblockNoteChange {
  readonly path: string;
  /** Previous vault path when the note was renamed. */
  readonly oldPath?: string;
  /** The Forge adapter convention: the vault-relative Markdown note path is its opaque sourceId. */
  readonly sourceId: string;
  readonly kind: ForgeStatblockNoteChangeKind;
  readonly templateLink?: ForgeStatblockTemplateLink;
  /** Monotonic for this observer lifetime; lets consumers discard stale asynchronous work. */
  readonly sequence: number;
}

export interface ForgeStatblockSceneInstances {
  readonly sceneId: string;
  readonly instances: readonly AtlasSheetInstance[];
}

export interface ForgeStatblockInstanceDependency {
  readonly sceneId: string;
  readonly instanceId: string;
  readonly tokenId?: string;
}

/**
 * Find every persisted Forge instance that depends on one note. A scene identifier is retained
 * with each match so later synchronization can update every open scene without conflating
 * independent token instances that happen to share a note.
 */
export function findForgeStatblockNoteDependencies(
  scenes: readonly ForgeStatblockSceneInstances[],
  notePath: string,
): readonly ForgeStatblockInstanceDependency[] {
  if (typeof notePath !== 'string' || !notePath.trim()) return Object.freeze([]);
  const matches: ForgeStatblockInstanceDependency[] = [];
  for (const scene of scenes) {
    if (!scene.sceneId) continue;
    for (const instance of scene.instances) {
      if (instance.sceneId !== scene.sceneId
        || instance.source.providerId !== FORGE_SHEET_PROVIDER_ID
        || instance.source.sourceId !== notePath) continue;
      matches.push(Object.freeze({
        sceneId: scene.sceneId,
        instanceId: instance.id,
        ...(instance.tokenId !== undefined ? { tokenId: instance.tokenId } : {}),
      }));
    }
  }
  matches.sort((a, b) => a.sceneId.localeCompare(b.sceneId) || a.instanceId.localeCompare(b.instanceId));
  return Object.freeze(matches);
}

/**
 * Observes Forge note creation, modification, rename, deletion and restoration. It does not resolve
 * templates, read Forge fields, mutate sheet instances, or touch token Resources; those remain
 * separate synchronization stages.
 *
 * Vault modify and metadata-cache changed may describe the same save. Events are coalesced per
 * microtask, asynchronous reads are generation-checked, and unchanged file contents are emitted
 * only once. Deleted paths remain dormant so restoring the note to the same path can revalidate
 * its persisted instances without recreating or discarding their snapshots.
 */
export class ForgeStatblockNoteObserver {
  private readonly refs: Array<{ source: { offref(ref: EventRef): void }; ref: EventRef }> = [];
  private readonly pending = new Map<string, number>();
  private readonly generations = new Map<string, number>();
  private readonly knownForgePaths = new Set<string>();
  private readonly deletedForgePaths = new Set<string>();
  private readonly pendingRenames = new Map<string, string>();
  private readonly lastSignatures = new Map<string, string>();
  private readonly sequences = new Map<string, number>();
  private scheduled = false;
  private destroyed = false;

  constructor(
    private readonly app: App,
    private readonly onChange: (change: ForgeStatblockNoteChange) => void,
    private readonly getTrackedSourcePaths: () => Iterable<string> = () => [],
  ) {
    const track = (source: { offref(ref: EventRef): void }, ref: EventRef): void => {
      this.refs.push({ source, ref });
    };
    // Cache-only startup scan lets deletion/rename events be recognized even when the note is
    // referenced only by a closed map and no Atlas view currently exposes its sourceId.
    this.rememberIndexedForgeNotes();
    this.rememberTrackedPaths();
    track(app.vault, app.vault.on('create', (file: TAbstractFile) => this.created(file)));
    track(app.vault, app.vault.on('modify', (file: TAbstractFile) => this.schedule(file)));
    track(app.vault, app.vault.on('rename', (file: TAbstractFile, oldPath: string) => this.renamed(file, oldPath)));
    track(app.vault, app.vault.on('delete', (file: TAbstractFile) => this.deleted(file)));
    track(app.metadataCache, app.metadataCache.on('changed', (file: TFile) => this.schedule(file)));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const { source, ref } of this.refs) source.offref(ref);
    this.refs.length = 0;
    this.pending.clear();
    this.generations.clear();
    this.knownForgePaths.clear();
    this.deletedForgePaths.clear();
    this.pendingRenames.clear();
    this.lastSignatures.clear();
    this.sequences.clear();
  }

  private rememberIndexedForgeNotes(): void {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (frontmatterSource(frontmatter)?.kind === 'forge' || hasForgeStatblockMetadata(frontmatter)) {
        this.knownForgePaths.add(file.path);
      }
    }
  }

  private created(file: TAbstractFile): void {
    if (file instanceof TFile && file.extension.toLowerCase() === 'md') this.schedule(file);
  }

  private renamed(file: TAbstractFile, oldPath: string): void {
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') return;
    const wasForge = this.knownForgePaths.has(oldPath);
    this.generations.set(oldPath, (this.generations.get(oldPath) ?? 0) + 1);
    this.pending.delete(oldPath);
    this.deletedForgePaths.delete(oldPath);
    this.knownForgePaths.delete(oldPath);
    this.lastSignatures.delete(oldPath);
    this.sequences.delete(oldPath);
    this.rememberTrackedPaths();
    if (!wasForge && !this.knownForgePaths.has(file.path)) return;

    this.knownForgePaths.add(file.path);
    this.pendingRenames.set(file.path, oldPath);
    this.lastSignatures.delete(file.path);
    this.schedule(file);
  }

  private deleted(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') return;
    this.rememberTrackedPaths();
    const path = file.path;
    if (!this.knownForgePaths.has(path)) return;
    this.generations.set(path, (this.generations.get(path) ?? 0) + 1);
    this.pending.delete(path);
    this.pendingRenames.delete(path);
    this.deletedForgePaths.add(path);
    this.lastSignatures.delete(path);
    this.publish(path, 'deleted', undefined, 'deleted');
  }

  private schedule(file: TAbstractFile): void {
    if (this.destroyed || !(file instanceof TFile) || file.extension.toLowerCase() !== 'md') return;
    this.rememberTrackedPaths();
    const path = file.path;
    const generation = (this.generations.get(path) ?? 0) + 1;
    this.generations.set(path, generation);
    this.pending.set(path, generation);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { void this.flush(); });
  }

  private async flush(): Promise<void> {
    this.scheduled = false;
    if (this.destroyed) return;
    const batch = [...this.pending.entries()];
    this.pending.clear();
    await Promise.all(batch.map(([path, generation]) => this.inspect(path, generation)));
    // A path may have changed again while cachedRead was pending.
    if (!this.destroyed && this.pending.size > 0 && !this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => { void this.flush(); });
    }
  }

  private async inspect(path: string, generation: number): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') return;

    // Most Markdown files are not Forge notes. Use the fast metadata-cache discriminator first;
    // known Forge paths are also read so removal of the marker is observable.
    const cachedFrontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const cachedSource = frontmatterSource(cachedFrontmatter);
    const cachedHasForgeMarker = hasForgeStatblockMetadata(cachedFrontmatter);
    if (cachedSource?.kind !== 'forge' && !cachedHasForgeMarker && !this.knownForgePaths.has(path)) return;

    let text: string;
    try {
      text = await this.app.vault.cachedRead(file);
    } catch {
      if (this.isCurrent(path, generation)) {
        const oldPath = this.pendingRenames.get(path);
        this.pendingRenames.delete(path);
        this.publish(path, 'unreadable', undefined, this.contentRevision(path), oldPath);
      }
      return;
    }
    if (!this.isCurrent(path, generation)) return;

    const frontmatter = frontmatterOfText(text);
    const source = frontmatterSource(frontmatter);
    if (source?.kind === 'forge') {
      this.knownForgePaths.add(path);
      const templateLink = forgeStatblockLinkFromFrontmatter(frontmatter);
      const oldPath = this.pendingRenames.get(path);
      this.pendingRenames.delete(path);
      const restored = this.deletedForgePaths.delete(path);
      if (templateLink) this.publish(path, oldPath ? 'renamed' : restored ? 'restored' : 'updated', templateLink, fingerprint(text), oldPath);
      return;
    }

    if (hasForgeFrontmatterMarkerInText(text) || hasForgeStatblockMetadata(frontmatter)) {
      this.knownForgePaths.add(path);
      this.deletedForgePaths.delete(path);
      this.pendingRenames.delete(path);
      this.publish(path, 'invalid', undefined, fingerprint(text));
      return;
    }

    this.deletedForgePaths.delete(path);
    this.pendingRenames.delete(path);
    if (this.knownForgePaths.delete(path)) this.publish(path, 'unlinked', undefined, fingerprint(text));
  }

  private rememberTrackedPaths(): void {
    try {
      for (const path of this.getTrackedSourcePaths()) {
        if (typeof path === 'string' && path.trim()) this.knownForgePaths.add(path);
      }
    } catch (error) {
      console.error('[Atlas] Reading tracked Forge sheet source paths failed:', error);
    }
  }

  private isCurrent(path: string, generation: number): boolean {
    return !this.destroyed && this.generations.get(path) === generation;
  }

  private publish(path: string, kind: ForgeStatblockNoteChangeKind, templateLink?: ForgeStatblockTemplateLink, revision = this.contentRevision(path), oldPath?: string): void {
    if (this.destroyed) return;
    const signatureKind = kind === 'renamed' || kind === 'restored' ? 'updated' : kind;
    const signature = `${signatureKind}:${templateLink?.templateId ?? ''}:${templateLink?.templatePath ?? ''}:${revision}`;
    if (this.lastSignatures.get(path) === signature) return;
    this.lastSignatures.set(path, signature);
    const sequence = (this.sequences.get(path) ?? 0) + 1;
    this.sequences.set(path, sequence);
    const change: ForgeStatblockNoteChange = Object.freeze({
      path,
      ...(oldPath ? { oldPath } : {}),
      sourceId: path,
      kind,
      ...(templateLink ? { templateLink: Object.freeze({ ...templateLink }) } : {}),
      sequence,
    });
    try {
      this.onChange(change);
    } catch (error) {
      console.error(`[Atlas] Publishing Forge note change for ${path} failed:`, error);
    }
  }

  /** Cheap stable hash; note text itself is never retained or exposed to event consumers. */
  private contentRevision(path: string): string {
    const file = this.app.vault.getFileByPath(path);
    if (!(file instanceof TFile)) return 'missing';
    const mtime = Number.isFinite(file.stat?.mtime) ? file.stat.mtime : 0;
    const size = Number.isFinite(file.stat?.size) ? file.stat.size : 0;
    return `${mtime}:${size}`;
  }
}

function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

/** Register the lifecycle observer before Atlas views load; subscribers consume public workspace events. */
export function registerForgeStatblockNoteObserver(
  plugin: Plugin,
  getTrackedSourcePaths: () => Iterable<string> = () => [],
): void {
  const observer = new ForgeStatblockNoteObserver(plugin.app, (change) => {
    plugin.app.workspace.trigger(FORGE_STATBLOCK_NOTE_CHANGED_EVENT, change);
  }, getTrackedSourcePaths);
  plugin.register(() => observer.destroy());
}

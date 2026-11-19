import { TFile, type App, type EventRef, type Plugin, type TAbstractFile } from 'obsidian';
import type { AtlasSheetInstance } from '../api/sheets/types';
import { isPlainRecord } from '../statblocks/values/fieldValueOf';
import {
  forgeStatblockLinkFromFrontmatter,
  type ForgeStatblockTemplateLink,
} from '../statblocks/notes/forgeStatblockLink';
import { FORGE_TEMPLATE_FORMAT, FORGE_TEMPLATE_VERSION, MAX_FORGE_TEMPLATE_FILE_BYTES } from '../statblocks/notes/forgeStatblockTemplateReader';
import { FORGE_SHEET_PROVIDER_ID } from '../services/providerStatblockPreview';

/** Workspace event emitted after Atlas observes a Forge `.forgetemplate` change. */
export const FORGE_STATBLOCK_TEMPLATE_CHANGED_EVENT = 'atlas-vtt:forge-statblock-template-changed';

export type ForgeStatblockTemplateChangeKind = 'created' | 'updated' | 'renamed' | 'deleted' | 'invalid' | 'unreadable';
export type ForgeStatblockTemplateInvalidReason = 'too-large' | 'invalid-json' | 'invalid-document' | 'unsupported-format' | 'unsupported-version' | 'missing-template-id';

export interface ForgeStatblockTemplateNoteReference {
  readonly notePath: string;
  readonly link: ForgeStatblockTemplateLink;
}

export interface ForgeStatblockTemplateNoteDependency {
  readonly notePath: string;
  readonly templatePath: string;
  readonly templateId: string;
  /** Stable-ID matches are candidates; later resolution must still handle duplicate IDs as ambiguous. */
  readonly matchedBy: 'path' | 'id' | 'path-and-id';
}

export interface ForgeStatblockTemplateSceneInstances {
  readonly sceneId: string;
  readonly instances: readonly AtlasSheetInstance[];
}

export interface ForgeStatblockTemplateInstanceDependency {
  readonly notePath: string;
  readonly sceneId: string;
  readonly instanceId: string;
  readonly tokenId?: string;
}

export interface ForgeStatblockTemplateChange {
  readonly path: string;
  readonly oldPath?: string;
  readonly templateId?: string;
  readonly kind: ForgeStatblockTemplateChangeKind;
  readonly reason?: ForgeStatblockTemplateInvalidReason;
  readonly revision: string;
  readonly sequence: number;
  readonly noteDependencies: readonly ForgeStatblockTemplateNoteDependency[];
  /** Only instances in currently loaded Atlas scene(s) are included at this stage. */
  readonly instanceDependencies: readonly ForgeStatblockTemplateInstanceDependency[];
}

interface PendingTemplateChange {
  file: TFile;
  kind: 'created' | 'updated' | 'renamed';
  readonly oldPaths: Set<string>;
}

interface TemplateIdentityResult {
  readonly templateId?: string;
  readonly reason?: ForgeStatblockTemplateInvalidReason;
  readonly revision?: string;
}

const TEMPLATE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{6}$/;

/** Read only the template identity. Full parsing/rendering stays with the Forge provider. */
async function readTemplateIdentity(app: App, file: TFile): Promise<TemplateIdentityResult> {
  const fileSize = file.stat?.size;
  const fileMtime = file.stat?.mtime;
  if (typeof fileSize === 'number' && Number.isFinite(fileSize) && fileSize > MAX_FORGE_TEMPLATE_FILE_BYTES) {
    return { reason: 'too-large', revision: `too-large:${fileSize}` };
  }
  let text: string;
  try {
    text = await app.vault.cachedRead(file);
  } catch {
    return { revision: `unreadable:${fileMtime ?? 0}:${fileSize ?? 0}` };
  }
  const revision = fingerprintTemplateText(text);
  if (new TextEncoder().encode(text).byteLength > MAX_FORGE_TEMPLATE_FILE_BYTES) return { reason: 'too-large', revision };

  let parsed: unknown;
  try {
    const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    parsed = JSON.parse(source) as unknown;
  } catch {
    return { reason: 'invalid-json', revision };
  }
  if (!isPlainRecord(parsed)) return { reason: 'invalid-document', revision };
  if (parsed.format !== FORGE_TEMPLATE_FORMAT) return { reason: 'unsupported-format', revision };
  if (typeof parsed.id !== 'string' || !TEMPLATE_ID_PATTERN.test(parsed.id)) return { reason: 'missing-template-id', revision };
  if (parsed.version !== FORGE_TEMPLATE_VERSION) return { templateId: parsed.id, reason: 'unsupported-version', revision };
  return { templateId: parsed.id, revision };
}

/** Stable content fingerprint; raw template contents are not retained or published. */
function fingerprintTemplateText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

/**
 * Find notes that point to a changed template by their recorded path or stable template ID.
 * Path matches are exact; ID matches are candidates and must be resolved with the normal resolver
 * before any source is refreshed because duplicate template IDs are intentionally ambiguous.
 */
export function findForgeStatblockTemplateNoteDependencies(
  notes: readonly ForgeStatblockTemplateNoteReference[],
  target: { readonly path: string; readonly oldPath?: string; readonly templateId?: string },
): readonly ForgeStatblockTemplateNoteDependency[] {
  const paths = new Set([target.path, target.oldPath].filter((path): path is string => typeof path === 'string' && path.length > 0));
  const dependencies: ForgeStatblockTemplateNoteDependency[] = [];
  for (const note of notes) {
    const pathMatch = paths.has(note.link.templatePath);
    const idMatch = !!target.templateId && note.link.templateId === target.templateId;
    if (!pathMatch && !idMatch) continue;
    dependencies.push(Object.freeze({
      notePath: note.notePath,
      templatePath: note.link.templatePath,
      templateId: note.link.templateId,
      matchedBy: pathMatch && idMatch ? 'path-and-id' : pathMatch ? 'path' : 'id',
    }));
  }
  dependencies.sort((a, b) => a.notePath.localeCompare(b.notePath));
  return Object.freeze(dependencies);
}

/** Map dependent note paths to independent Atlas instances without merging equal source documents. */
export function findForgeStatblockTemplateInstanceDependencies(
  scenes: readonly ForgeStatblockTemplateSceneInstances[],
  noteDependencies: readonly ForgeStatblockTemplateNoteDependency[],
): readonly ForgeStatblockTemplateInstanceDependency[] {
  const notePaths = new Set(noteDependencies.map((dependency) => dependency.notePath));
  const result: ForgeStatblockTemplateInstanceDependency[] = [];
  for (const scene of scenes) {
    if (!scene.sceneId) continue;
    for (const instance of scene.instances) {
      if (instance.sceneId !== scene.sceneId || instance.source.providerId !== FORGE_SHEET_PROVIDER_ID
        || !notePaths.has(instance.source.sourceId)) continue;
      result.push(Object.freeze({
        notePath: instance.source.sourceId,
        sceneId: scene.sceneId,
        instanceId: instance.id,
        ...(instance.tokenId !== undefined ? { tokenId: instance.tokenId } : {}),
      }));
    }
  }
  result.sort((a, b) => a.sceneId.localeCompare(b.sceneId) || a.notePath.localeCompare(b.notePath) || a.instanceId.localeCompare(b.instanceId));
  return Object.freeze(result);
}

/**
 * Observes `.forgetemplate` create/modify/rename/delete events and maintains a lightweight index
 * of Forge v2 note frontmatter. It never parses fields/layouts for rendering, mutates vault files,
 * refreshes sheet definitions, or changes Resources.
 */
export class ForgeStatblockTemplateObserver {
  private readonly refs: Array<{ source: { offref(ref: EventRef): void }; ref: EventRef }> = [];
  private readonly noteLinks = new Map<string, ForgeStatblockTemplateLink>();
  private readonly knownTemplateIds = new Map<string, string>();
  private readonly identityReads = new Map<string, Promise<void>>();
  private templateIdentityScan: Promise<void> | null = null;
  private templateIdentityIndexComplete = false;
  private readonly pending = new Map<string, PendingTemplateChange>();
  private readonly generations = new Map<string, number>();
  private readonly sequences = new Map<string, number>();
  private readonly signatures = new Map<string, string>();
  private scheduled = false;
  private destroyed = false;

  constructor(
    private readonly app: App,
    private readonly onChange: (change: ForgeStatblockTemplateChange) => void,
    private readonly getSceneInstances: () => readonly ForgeStatblockTemplateSceneInstances[] = () => [],
  ) {
    const track = (source: { offref(ref: EventRef): void }, ref: EventRef): void => { this.refs.push({ source, ref }); };

    for (const file of app.vault.getMarkdownFiles()) this.indexNote(file);
    track(app.metadataCache, app.metadataCache.on('changed', (file: TFile) => this.indexNote(file)));
    track(app.vault, app.vault.on('create', (file: TAbstractFile) => this.created(file)));
    track(app.vault, app.vault.on('modify', (file: TAbstractFile) => this.modified(file)));
    track(app.vault, app.vault.on('rename', (file: TAbstractFile, oldPath: string) => this.renamed(file, oldPath)));
    track(app.vault, app.vault.on('delete', (file: TAbstractFile) => this.deleted(file)));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const { source, ref } of this.refs) source.offref(ref);
    this.refs.length = 0;
    this.noteLinks.clear();
    this.knownTemplateIds.clear();
    this.identityReads.clear();
    this.templateIdentityScan = null;
    this.pending.clear();
    this.generations.clear();
    this.sequences.clear();
    this.signatures.clear();
  }

  private indexNote(file: TFile): void {
    if (this.destroyed || file.extension.toLowerCase() !== 'md') return;
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const link = forgeStatblockLinkFromFrontmatter(frontmatter);
    if (link) {
      this.noteLinks.set(file.path, Object.freeze({ ...link }));
      this.rememberTemplateIdentityForLink(link);
    } else this.noteLinks.delete(file.path);
  }

  /** Seed path identities for linked templates and ID identities when a saved path is stale. */
  private rememberTemplateIdentityForLink(link: ForgeStatblockTemplateLink): void {
    if (this.destroyed) return;
    const candidate = this.app.vault.getAbstractFileByPath(link.templatePath);
    if (candidate instanceof TFile && candidate.extension.toLowerCase() === 'forgetemplate') {
      this.readKnownTemplateIdentity(candidate);
      return;
    }
    this.ensureTemplateIdentityIndex();
  }

  /** Scan stale-path candidates once per observer, with bounded concurrency across all notes. */
  private ensureTemplateIdentityIndex(): void {
    if (this.destroyed || this.templateIdentityScan || this.templateIdentityIndexComplete) return;
    const candidates = this.app.vault.getFiles().filter((file) => file.extension.toLowerCase() === 'forgetemplate');
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (!this.destroyed) {
        const index = cursor++;
        const file = candidates[index];
        if (!file) return;
        const generation = this.generations.get(file.path) ?? 0;
        const identity = await readTemplateIdentity(this.app, file);
        if (this.destroyed) return;
        const currentFile = this.app.vault.getFileByPath(file.path);
        if ((this.generations.get(file.path) ?? 0) !== generation || !currentFile
          || currentFile.extension.toLowerCase() !== 'forgetemplate') continue;
        if (identity.templateId) this.knownTemplateIds.set(file.path, identity.templateId);
      }
    };
    const workerCount = Math.min(4, candidates.length);
    const scan = Promise.all(Array.from({ length: workerCount }, () => worker()))
      .then(() => {
        if (!this.destroyed) this.templateIdentityIndexComplete = true;
      })
      .catch((error: unknown) => {
        console.error('[Atlas] Indexing Forge template IDs for stale note links failed:', error);
      })
      .finally(() => {
        if (this.templateIdentityScan === scan) this.templateIdentityScan = null;
      });
    this.templateIdentityScan = scan;
  }

  private readKnownTemplateIdentity(file: TFile): void {
    if (this.destroyed || this.identityReads.has(file.path)) return;
    const path = file.path;
    const generation = this.generations.get(path) ?? 0;
    const reading = readTemplateIdentity(this.app, file).then((identity) => {
      if (this.destroyed || !identity.templateId || (this.generations.get(path) ?? 0) !== generation) return;
      const currentFile = this.app.vault.getFileByPath(path);
      if (currentFile && currentFile.extension.toLowerCase() === 'forgetemplate') {
        this.knownTemplateIds.set(path, identity.templateId);
      }
    }).catch((error: unknown) => {
      console.error(`[Atlas] Indexing Forge template identity for ${path} failed:`, error);
    }).finally(() => {
      if (this.identityReads.get(path) === reading) this.identityReads.delete(path);
    });
    this.identityReads.set(path, reading);
  }

  private created(file: TAbstractFile): void {
    if (file instanceof TFile && file.extension.toLowerCase() === 'md') this.indexNote(file);
    if (file instanceof TFile && file.extension.toLowerCase() === 'forgetemplate') this.scheduleTemplate(file, 'created');
  }

  private modified(file: TAbstractFile): void {
    if (file instanceof TFile && file.extension.toLowerCase() === 'forgetemplate') this.scheduleTemplate(file, 'updated');
  }

  private renamed(file: TAbstractFile, oldPath: string): void {
    if (file instanceof TFile && file.extension.toLowerCase() === 'md') {
      this.noteLinks.delete(oldPath);
      this.indexNote(file);
    }
    const wasTemplate = oldPath.toLowerCase().endsWith('.forgetemplate');
    const isTemplate = file instanceof TFile && file.extension.toLowerCase() === 'forgetemplate';
    if (!wasTemplate && !isTemplate) return;
    const previousId = this.knownTemplateIds.get(oldPath);
    this.invalidatePath(oldPath);
    this.knownTemplateIds.delete(oldPath);
    if (isTemplate) this.scheduleTemplate(file, 'renamed', oldPath);
    else this.publish({ path: file.path, oldPath, ...(previousId ? { templateId: previousId } : {}), kind: 'renamed', revision: 'renamed' });
  }

  private deleted(file: TAbstractFile): void {
    if (file instanceof TFile && file.extension.toLowerCase() === 'md') this.noteLinks.delete(file.path);
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'forgetemplate') return;
    const templateId = this.knownTemplateIds.get(file.path);
    this.invalidatePath(file.path);
    this.knownTemplateIds.delete(file.path);
    this.publish({ path: file.path, ...(templateId ? { templateId } : {}), kind: 'deleted', revision: 'deleted' });
  }

  private scheduleTemplate(file: TFile, kind: 'created' | 'updated' | 'renamed', oldPath?: string): void {
    if (this.destroyed) return;
    const key = file.path;
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    const pending = this.pending.get(key);
    if (pending) {
      pending.file = file;
      // Preserve the strongest lifecycle information when create/modify/rename events are coalesced.
      if (kind === 'renamed' || pending.kind !== 'renamed' && kind === 'created') pending.kind = kind;
      if (oldPath) pending.oldPaths.add(oldPath);
    } else {
      this.pending.set(key, { file, kind, oldPaths: new Set(oldPath ? [oldPath] : []) });
    }
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { void this.flush(); });
  }

  private invalidatePath(path: string): void {
    this.generations.set(path, (this.generations.get(path) ?? 0) + 1);
    this.pending.delete(path);
  }

  private async flush(): Promise<void> {
    this.scheduled = false;
    if (this.destroyed) return;
    const batch = [...this.pending.entries()];
    this.pending.clear();
    await Promise.all(batch.map(async ([path, entry]) => {
      const generation = this.generations.get(path) ?? 0;
      const identity = await readTemplateIdentity(this.app, entry.file);
      if (this.destroyed || this.generations.get(path) !== generation) return;
      const previousId = this.knownTemplateIds.get(path);
      if (identity.templateId) this.knownTemplateIds.set(path, identity.templateId);
      const templateId = identity.templateId ?? previousId;
      const kind = identity.reason ? 'invalid' : identity.templateId ? entry.kind : 'unreadable';
      const oldPaths = [...entry.oldPaths];
      if (oldPaths.length === 0) {
        this.publish({
          path,
          ...(templateId ? { templateId } : {}),
          kind,
          ...(identity.reason ? { reason: identity.reason } : {}),
          revision: this.revisionFor(entry.file, identity, previousId),
        });
      } else {
        for (const oldPath of oldPaths) {
          const oldTemplateId = this.knownTemplateIds.get(oldPath);
          const resolvedTemplateId = templateId ?? oldTemplateId;
          this.publish({
            path,
            oldPath,
            ...(resolvedTemplateId ? { templateId: resolvedTemplateId } : {}),
            kind: identity.reason ? 'invalid' : identity.templateId ? 'renamed' : 'unreadable',
            ...(identity.reason ? { reason: identity.reason } : {}),
            revision: this.revisionFor(entry.file, identity, previousId),
          });
        }
      }
    }));
    if (!this.destroyed && this.pending.size > 0 && !this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => { void this.flush(); });
    }
  }

  private revisionFor(file: TFile, identity: TemplateIdentityResult, previousId?: string): string {
    const fileMtime = file.stat?.mtime;
    const fileSize = file.stat?.size;
    const mtime = typeof fileMtime === 'number' && Number.isFinite(fileMtime) ? fileMtime : 0;
    const size = typeof fileSize === 'number' && Number.isFinite(fileSize) ? fileSize : 0;
    const observed = identity.revision ?? `${identity.templateId ?? identity.reason ?? 'unreadable'}:${mtime}:${size}`;
    return `${observed}:${previousId ?? ''}`;
  }

  private publish(input: {
    path: string;
    oldPath?: string;
    templateId?: string;
    kind: ForgeStatblockTemplateChangeKind;
    reason?: ForgeStatblockTemplateInvalidReason;
    revision: string;
  }): void {
    if (this.destroyed) return;
    const noteDependencies = findForgeStatblockTemplateNoteDependencies(
      [...this.noteLinks.entries()].map(([notePath, link]) => ({ notePath, link })),
      { path: input.path, ...(input.oldPath ? { oldPath: input.oldPath } : {}), ...(input.templateId ? { templateId: input.templateId } : {}) },
    );
    let scenes: readonly ForgeStatblockTemplateSceneInstances[] = [];
    try { scenes = this.getSceneInstances(); }
    catch (error) { console.error('[Atlas] Reading scene instances for a Forge template change failed:', error); }
    const instanceDependencies = findForgeStatblockTemplateInstanceDependencies(scenes, noteDependencies);
    const signature = `${input.kind}:${input.path}:${input.oldPath ?? ''}:${input.templateId ?? ''}:${input.reason ?? ''}:${input.revision}:${noteDependencies.map((dependency) => dependency.notePath).join('|')}`;
    const sequenceKey = input.path || input.oldPath || '';
    if (this.signatures.get(sequenceKey) === signature) return;
    this.signatures.set(sequenceKey, signature);
    const sequence = (this.sequences.get(sequenceKey) ?? 0) + 1;
    this.sequences.set(sequenceKey, sequence);
    const change: ForgeStatblockTemplateChange = Object.freeze({
      path: input.path,
      ...(input.oldPath ? { oldPath: input.oldPath } : {}),
      ...(input.templateId ? { templateId: input.templateId } : {}),
      kind: input.kind,
      ...(input.reason ? { reason: input.reason } : {}),
      revision: input.revision,
      sequence,
      noteDependencies,
      instanceDependencies,
    });
    try { this.onChange(change); }
    catch (error) { console.error(`[Atlas] Publishing Forge template change for ${input.path} failed:`, error); }
  }
}

/** Register once per Atlas plugin; views and providers consume only the public workspace event. */
export function registerForgeStatblockTemplateObserver(
  plugin: Plugin,
  getSceneInstances: () => readonly ForgeStatblockTemplateSceneInstances[] = () => [],
): void {
  const observer = new ForgeStatblockTemplateObserver(plugin.app, (change) => {
    plugin.app.workspace.trigger(FORGE_STATBLOCK_TEMPLATE_CHANGED_EVENT, change);
  }, getSceneInstances);
  plugin.register(() => observer.destroy());
}


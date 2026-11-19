/**
 * The one answer to "is this note a statblock?", for vault notes and for note
 * text that is not in the vault (a bundle under review).
 *
 * - `atlas`: a native statblock, `statblock: true` with an `atlas-template` id.
 * - `forge`: a Forge-native v2 note with validated `statblock-forge` metadata.
 * - `fs-frontmatter`: `statblock: true` (or `"true"`) without an Atlas template or a Forge v2 link; Fantasy
 *   Statblocks' watcher parses such a note into its bestiary.
 * - `fs-fence`: a ```statblock fence, or `statblock: inline`, which tells
 *   Fantasy Statblocks to parse the note's fence. The fence may name a bestiary
 *   creature (`creature:` / `monster:`), point at another note (`note:`) or
 *   define the creature inline. `statblock: <layout name>` only picks a layout
 *   and is no marker.
 */

import type { App, TFile } from 'obsidian';
import { parseNoteYaml } from '../../services/noteYaml';
import type { StatblockSource } from '../model/resolvedTypes';
import type { TemplateId } from '../model/templateTypes';
import { isPlainRecord } from '../values/fieldValueOf';
import { FORGE_STATBLOCK_LINK_FORMAT, FORGE_STATBLOCK_LINK_KEY, forgeStatblockLinkFromFrontmatter } from './forgeStatblockLink';
import { cacheFrontmatter } from './frontmatterBounds';

export type FrontmatterRecord = Readonly<Record<string, unknown>>;

/** A ```statblock fence, capturing its body. */
const STATBLOCK_FENCE = /^[ \t]*(?:```+|~~~+)\s*statblock\s*$([\s\S]*?)^[ \t]*(?:```+|~~~+)\s*$/m;
/** The frontmatter key naming a native statblock's template. */
export const TEMPLATE_KEY = 'atlas-template';
/** The language of the fence that shows a native note's own statblock inside the note (D14). */
export const STATBLOCK_FENCE_LANGUAGE = 'atlas-statblock';

/** The params of the first ```statblock fence, or null when the text has none. */
export function parseStatblockFence(content: string): Record<string, unknown> | null {
  const match = STATBLOCK_FENCE.exec(content);
  if (!match) return null;
  try {
    const params: unknown = parseNoteYaml(match[1] ?? '');
    return isPlainRecord(params) ? params : {};
  } catch {
    // A malformed fence is still a statblock fence; Fantasy Statblocks renders an error for it rather than ignoring it.
    return {};
  }
}

/** The frontmatter of note text as the metadata cache reads it; null without one or when it is no YAML map. */
export function frontmatterOfText(text: string): FrontmatterRecord | null {
  const yaml = cacheFrontmatter(text);
  if (yaml === null) return null;
  try {
    const frontmatter: unknown = parseNoteYaml(yaml);
    return isPlainRecord(frontmatter) ? frontmatter : null;
  } catch {
    return null;
  }
}


/**
 * Whether the raw frontmatter declares the reserved Forge link key, even when the YAML is malformed.
 * This lets source detection refuse a Fantasy Statblocks fallback without trusting or executing broken YAML.
 */
export function hasForgeFrontmatterMarkerInText(text: string): boolean {
  const yaml = cacheFrontmatter(text);
  return yaml !== null && /^(?:statblock-forge|['"]statblock-forge['"])[ \t]*:/m.test(yaml);
}

/** Whether this is the legacy Forge publication that Atlas owns through its exported template. */
function isAtlasPublishedForgeNote(frontmatter: FrontmatterRecord): boolean {
  const templateId = frontmatter[TEMPLATE_KEY];
  const link = frontmatter[FORGE_STATBLOCK_LINK_KEY];
  return (frontmatter.statblock === true || frontmatter.statblock === 'true')
    && typeof templateId === 'string' && templateId.trim() !== ''
    && isPlainRecord(link)
    && link.format === FORGE_STATBLOCK_LINK_FORMAT
    && link.version === 1
    && typeof link.atlasTemplateId === 'string'
    && link.atlasTemplateId.trim() === templateId.trim();
}

/** What the frontmatter alone decides: Atlas, Forge, or Fantasy Statblocks frontmatter, else null. */
export function frontmatterSource(frontmatter: FrontmatterRecord | null | undefined): StatblockSource | null {
  const hasForgeLink = !!frontmatter && Object.hasOwn(frontmatter, FORGE_STATBLOCK_LINK_KEY);
  if (frontmatter && hasForgeLink) {
    // Forge v1 notes published through Atlas remain Atlas-native only when the backlink
    // exactly identifies the Atlas template. All other Forge markers are not Fantasy notes.
    if (isAtlasPublishedForgeNote(frontmatter)) {
      const templateId = frontmatter[TEMPLATE_KEY] as string;
      return { kind: 'atlas', templateId: templateId.trim() };
    }

    // A valid Atlas ID plus a non-publication Forge marker is a conflicting hybrid; do not
    // guess which plugin owns it. A v2 note must not be mistaken for an Atlas or FS note.
    const atlasTemplateId = frontmatter[TEMPLATE_KEY];
    if (typeof atlasTemplateId === 'string' && atlasTemplateId.trim() !== '') return null;

    const link = forgeStatblockLinkFromFrontmatter(frontmatter);
    return link ? { kind: 'forge', templateId: link.templateId, templatePath: link.templatePath } : null;
  }

  const marker = frontmatter?.statblock;
  if (marker !== true && marker !== 'true') return null;
  const templateId = frontmatter?.[TEMPLATE_KEY];
  if (typeof templateId === 'string' && templateId.trim() !== '') return { kind: 'atlas', templateId: templateId.trim() };
  return { kind: 'fs-frontmatter' };
}

/** Whether frontmatter contains Forge metadata that is not a valid Atlas-published v1 note. */
export function hasForgeStatblockMetadata(frontmatter: FrontmatterRecord | null | undefined): boolean {
  return !!frontmatter
    && Object.hasOwn(frontmatter, FORGE_STATBLOCK_LINK_KEY)
    && !isAtlasPublishedForgeNote(frontmatter);
}

/** A fence in the text, else `statblock: inline` with nothing to read, else null. */
function fenceSource(frontmatter: FrontmatterRecord | null | undefined, text: string): StatblockSource | null {
  const params = parseStatblockFence(text);
  if (params) return { kind: 'fs-fence', params };
  return frontmatter?.statblock === 'inline' ? { kind: 'fs-fence', params: {} } : null;
}

/** The statblock of note text that is not in the vault, or null when it defines none. */
export function statblockSourceFromText(text: string): StatblockSource | null {
  const frontmatter = frontmatterOfText(text);
  const source = frontmatterSource(frontmatter);
  // A malformed Forge link must not fall through and be misclassified as a Fantasy Statblocks fence.
  if (source || hasForgeStatblockMetadata(frontmatter) || hasForgeFrontmatterMarkerInText(text)) return source;
  return fenceSource(frontmatter, text);
}

/** The frontmatter the metadata cache holds for a note; never Fantasy Statblocks' bestiary copy. */
export function cachedFrontmatter(app: App, file: TFile): FrontmatterRecord | undefined {
  return app.metadataCache.getFileCache(file)?.frontmatter;
}

/** The template a native statblock names, from the metadata cache; null for every other note. */
export function cachedTemplateId(app: App, file: TFile): TemplateId | null {
  const source = frontmatterSource(cachedFrontmatter(app, file));
  return source?.kind === 'atlas' ? source.templateId : null;
}

/**
 * The statblock of a vault note, or null when it defines none. Frontmatter
 * markers are read from the metadata cache; when the frontmatter does not
 * decide, the file is read to check for a raw Forge marker or a Fantasy fence.
 */
export async function statblockSourceOf(app: App, file: TFile): Promise<StatblockSource | null> {
  if (file.extension !== 'md') return null;
  const frontmatter = cachedFrontmatter(app, file);
  const source = frontmatterSource(frontmatter);
  // A malformed Forge link is still Forge-owned metadata, not a Fantasy Statblocks fallback.
  if (source || hasForgeStatblockMetadata(frontmatter)) return source;
  const text = await app.vault.cachedRead(file);
  if (hasForgeFrontmatterMarkerInText(text)) return null;
  return fenceSource(frontmatter, text);
}

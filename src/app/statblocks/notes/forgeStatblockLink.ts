/**
 * The versioned frontmatter contract used by Forge-native statblock notes.
 *
 * This reader validates only the versioned note-to-template contract. The
 * generic source detector consumes this result, while template lookup and
 * value resolution remain in the Forge-specific adapter. Keeping those steps
 * separate prevents Atlas and Fantasy Statblocks from claiming Forge notes.
 */

import { isPlainRecord } from '../values/fieldValueOf';

export const FORGE_STATBLOCK_LINK_KEY = 'statblock-forge';
export const FORGE_STATBLOCK_LINK_FORMAT = 'statblock-forge-template-link';
export const FORGE_NATIVE_STATBLOCK_LINK_VERSION = 2;

/** The Forge-native (not Atlas-published) note-to-template reference. */
export interface ForgeStatblockTemplateLink {
  format: typeof FORGE_STATBLOCK_LINK_FORMAT;
  version: typeof FORGE_NATIVE_STATBLOCK_LINK_VERSION;
  templatePath: string;
  templateId: string;
}

/** Normalize a vault-relative path using the same rules as Forge's link writer. */
export function normalizeForgeTemplatePath(path: string): string | null {
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  if (!normalized.toLowerCase().endsWith('.forgetemplate')) return null;
  return normalized;
}

/**
 * Read only Forge-native v2 links from cached frontmatter.
 *
 * Forge v1 links are published Atlas statblocks and remain on Atlas' existing
 * `statblock: true` + `atlas-template` path. A v2 link must not also carry an
 * `atlas-template` marker, matching Forge's own reader.
 */
export function forgeStatblockLinkFromFrontmatter(frontmatter: unknown): ForgeStatblockTemplateLink | null {
  if (!isPlainRecord(frontmatter) || frontmatter['atlas-template'] !== undefined) return null;
  const value: unknown = frontmatter[FORGE_STATBLOCK_LINK_KEY];
  if (!isPlainRecord(value)
    || value.format !== FORGE_STATBLOCK_LINK_FORMAT
    || value.version !== FORGE_NATIVE_STATBLOCK_LINK_VERSION
    || typeof value.templatePath !== 'string'
    || typeof value.templateId !== 'string'
    || value.atlasTemplateId !== undefined) return null;

  const templatePath = normalizeForgeTemplatePath(value.templatePath);
  const templateId = value.templateId.trim();
  if (!templatePath || !templateId) return null;

  return {
    format: FORGE_STATBLOCK_LINK_FORMAT,
    version: FORGE_NATIVE_STATBLOCK_LINK_VERSION,
    templatePath,
    templateId,
  };
}

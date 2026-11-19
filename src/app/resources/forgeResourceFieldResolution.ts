/** Resolve Forge Field keys and Resource-specific meanings without changing the general statblock contract. */

import { forgeNumericResourceFields } from './forgeNumericResourceFields';
import type { ForgeStatblockFieldDescriptor, ForgeStatblockFieldExtractionWarning } from '../statblocks/notes/forgeStatblockFieldTypes';
import type { FieldMeanings } from '../statblocks/resolve/fieldMeanings';

export interface ForgeResourceFieldSource {
  fieldDescriptors: readonly ForgeStatblockFieldDescriptor[];
  fieldExtractionWarnings?: readonly ForgeStatblockFieldExtractionWarning[];
  /** Current template Fields omitted by the note; Resource sync can treat them as explicitly empty. */
  missingFieldKeys?: readonly string[];
}

export type ForgeResourceFieldPathResult =
  | { status: 'resolved'; path: string; via: 'current-key' | 'former-key' | 'forge-tracking-maximum' | 'passthrough' }
  | { status: 'ambiguous'; requestedPath: string; candidateKeys: readonly string[] }
  | { status: 'unsupported'; requestedPath: string; fieldKey: string; reason: 'not-resource-compatible' | 'invalid-tracking' | 'invalid-tracking-maximum' };

const normalizeFieldKey = (key: string): string => key.toLowerCase().replace(/[\s_-]/g, '');

function warningFor(
  source: ForgeResourceFieldSource,
  fieldKey: string,
  property: string,
): boolean {
  return (source.fieldExtractionWarnings ?? []).some((warning) => warning.fieldKey === fieldKey && warning.property === property);
}

function matchesCurrentKey(key: string, source: ForgeResourceFieldSource): ForgeStatblockFieldDescriptor[] {
  const exact = source.fieldDescriptors.filter((field) => field.key === key);
  if (exact.length > 0) return exact;
  const normalized = normalizeFieldKey(key);
  return source.fieldDescriptors.filter((field) => normalizeFieldKey(field.key) === normalized);
}

function matchesFormerKey(key: string, source: ForgeResourceFieldSource): ForgeStatblockFieldDescriptor[] {
  const exact = source.fieldDescriptors.filter((field) => field.formerKeys.includes(key));
  if (exact.length > 0) return exact;
  const normalized = normalizeFieldKey(key);
  return source.fieldDescriptors.filter((field) => field.formerKeys.some((former) => normalizeFieldKey(former) === normalized));
}

function uniqueCurrentDescriptor(key: string, source: ForgeResourceFieldSource): ForgeStatblockFieldDescriptor | null {
  const matches = matchesCurrentKey(key, source);
  return matches.length === 1 ? matches[0] ?? null : null;
}

function exactCurrentDescriptor(key: string, source: ForgeResourceFieldSource): ForgeStatblockFieldDescriptor | null {
  const matches = source.fieldDescriptors.filter((field) => field.key === key);
  return matches.length === 1 ? matches[0] ?? null : null;
}

/** An explicitly semantic HP Text/Markdown Field can be empty even though it is not a numeric candidate yet. */
function isEmptyHitPointsField(
  field: ForgeStatblockFieldDescriptor,
  record: Readonly<Record<string, unknown>>,
  source: ForgeResourceFieldSource,
): boolean {
  if (field.atlasMeaning !== 'hit-points' || (field.type !== 'text' && field.type !== 'markdown')) return false;
  if (warningFor(source, field.key, 'formula') || warningFor(source, field.key, 'tracks')) return false;
  const value = record[field.key];
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * Forge's Number `tracks.max` points at the maximum Field. An absent or unresolved reference falls
 * back to the tracked Field itself, matching Forge 0.3.0. A reference to a valid Number Field is
 * accepted only when that target also passes Atlas' scalar Resource compatibility checks.
 */
function resourceKeyForDescriptor(
  field: ForgeStatblockFieldDescriptor,
  record: Readonly<Record<string, unknown>>,
  source: ForgeResourceFieldSource,
): { key: string; via: 'current-key' | 'forge-tracking-maximum' }
  | { reason: 'not-resource-compatible' | 'invalid-tracking' | 'invalid-tracking-maximum' } {
  if (field.type === 'number' && field.config.kind === 'numeric') {
    if (warningFor(source, field.key, 'tracks')) return { reason: 'invalid-tracking' };
    const configuredMaximum = field.config.settings.tracking?.maximumFieldKey;
    if (configuredMaximum && configuredMaximum !== field.key) {
      // Forge's runtime uses current Field keys for tracks.max; unlike Resource definitions,
      // tracks.max is not resolved through Former Keys.
      const maximum = exactCurrentDescriptor(configuredMaximum, source);
      if (!maximum || maximum.type !== 'number' || maximum.config.kind !== 'numeric') {
        // This matches Forge's own fallback to the tracked Field when tracks.max is stale.
      } else {
        const candidate = forgeNumericResourceFields(source.fieldDescriptors, record, source.fieldExtractionWarnings)
          .some((item) => item.path === maximum.key);
        if (!candidate) return { reason: 'invalid-tracking-maximum' };
        return { key: maximum.key, via: 'forge-tracking-maximum' };
      }
    }
  }

  const candidate = forgeNumericResourceFields(source.fieldDescriptors, record, source.fieldExtractionWarnings)
    .some((item) => item.path === field.key);
  return candidate || isEmptyHitPointsField(field, record, source)
    ? { key: field.key, via: 'current-key' }
    : { reason: 'not-resource-compatible' };
}

/**
 * Resolve a configured Resource path against a Forge template. Current keys win over Former Keys;
 * a unique Former Key is redirected to its current Field key. A tracked Number current Field is
 * redirected to its configured maximum Field, never treated as a maximum itself.
 */
export function resolveForgeResourceFieldPath(
  path: string,
  record: Readonly<Record<string, unknown>>,
  source: ForgeResourceFieldSource,
): ForgeResourceFieldPathResult {
  const [head, ...tail] = path.split('.');
  if (!head) return { status: 'resolved', path, via: 'passthrough' };

  let matches = matchesCurrentKey(head, source);
  let via: 'current-key' | 'former-key' = 'current-key';
  if (matches.length === 0) {
    matches = matchesFormerKey(head, source);
    via = 'former-key';
  }
  if (matches.length === 0) return { status: 'resolved', path, via: 'passthrough' };
  if (matches.length > 1) {
    return { status: 'ambiguous', requestedPath: path, candidateKeys: matches.map((field) => field.key) };
  }

  const field = matches[0]!;
  const resolved = resourceKeyForDescriptor(field, record, source);
  if ('reason' in resolved) {
    return { status: 'unsupported', requestedPath: path, fieldKey: field.key, reason: resolved.reason };
  }

  const suffix = tail.length > 0 ? `.${tail.join('.')}` : '';
  return {
    status: 'resolved',
    path: `${resolved.key}${suffix}`,
    via: resolved.via === 'forge-tracking-maximum' ? resolved.via : (via === 'former-key' ? 'former-key' : 'current-key'),
  };
}

/**
 * Meaning map used only by Atlas Resource reads. If the Forge `hit-points` Field tracks a separate
 * Number maximum, point Resource lookups at that maximum while leaving display/filter meanings
 * unchanged everywhere else. If that maximum is unsafe, remove the Resource meaning rather than
 * silently reading the current value as the maximum.
 */
export function forgeResourceMeanings(
  meanings: FieldMeanings,
  record: Readonly<Record<string, unknown>>,
  source: ForgeResourceFieldSource,
): FieldMeanings {
  const hitPointsKey = meanings['hit-points'];
  if (!hitPointsKey) return meanings;
  const field = uniqueCurrentDescriptor(hitPointsKey, source);
  if (!field) return meanings;

  const resolved = resourceKeyForDescriptor(field, record, source);
  if ('reason' in resolved) {
    const next = { ...meanings };
    delete next['hit-points'];
    return next;
  }
  if (resolved.key === hitPointsKey) return meanings;
  return { ...meanings, 'hit-points': resolved.key };
}
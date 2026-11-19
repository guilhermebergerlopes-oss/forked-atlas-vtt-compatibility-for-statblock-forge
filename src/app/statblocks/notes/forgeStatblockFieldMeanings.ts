/** Translate Forge Field meanings into the semantic contract consumed by Atlas. */

import type { FieldKey, FieldMeaning } from '../model/templateTypes';
import type { ForgeStatblockFieldDescriptor, ForgeStatblockFieldMeaning } from './forgeStatblockFieldTypes';

/**
 * Forge 0.3.0 and Atlas intentionally share these identifiers. Keep the crosswalk explicit so
 * a future Forge meaning cannot silently become an Atlas meaning merely because it looks similar.
 * `speed` is Atlas-only in this integration version and is therefore not inferred here.
 */
export const FORGE_TO_ATLAS_FIELD_MEANING = {
  'hit-points': 'hit-points',
  armor: 'armor',
  rating: 'rating',
  size: 'size',
  'creature-type': 'creature-type',
  senses: 'senses',
  initiative: 'initiative',
  traits: 'traits',
  description: 'description',
  'display-name': 'display-name',
} as const satisfies Readonly<Record<ForgeStatblockFieldMeaning, FieldMeaning>>;

export function atlasMeaningForForgeMeaning(meaning: ForgeStatblockFieldMeaning): FieldMeaning {
  return FORGE_TO_ATLAS_FIELD_MEANING[meaning];
}

export interface ForgeStatblockAtlasMeaningMap {
  /** Meaning keyed by Forge Field key, useful when building Atlas TemplateFields. */
  byFieldKey: Readonly<Record<FieldKey, FieldMeaning>>;
  /** Atlas ResolvedStatblock-compatible map: semantic meaning -> Field key. */
  meanings: Readonly<Partial<Record<FieldMeaning, FieldKey>>>;
}

/**
 * Builds the Atlas meaning map from already validated, unique Forge Field descriptors.
 * Ambiguous meanings are excluded instead of selecting an arbitrary Field. The extractor is
 * responsible for reporting those source-template conflicts in its warnings.
 */
export function mapForgeStatblockFieldMeanings(
  fields: readonly ForgeStatblockFieldDescriptor[],
): ForgeStatblockAtlasMeaningMap {
  const counts = new Map<FieldMeaning, number>();
  const candidates: Array<{ key: FieldKey; meaning: FieldMeaning }> = [];

  for (const field of fields) {
    if (!field.semanticMeaning) continue;
    const meaning = atlasMeaningForForgeMeaning(field.semanticMeaning);
    candidates.push({ key: field.key, meaning });
    counts.set(meaning, (counts.get(meaning) ?? 0) + 1);
  }

  const byFieldKeyEntries: Array<[FieldKey, FieldMeaning]> = [];
  const meanings: Partial<Record<FieldMeaning, FieldKey>> = {};
  for (const candidate of candidates) {
    if (counts.get(candidate.meaning) !== 1) continue;
    byFieldKeyEntries.push([candidate.key, candidate.meaning]);
    meanings[candidate.meaning] = candidate.key;
  }

  // Object.fromEntries creates data properties (including safe `__proto__` keys) on a plain object.
  const byFieldKey = Object.fromEntries(byFieldKeyEntries) as Record<FieldKey, FieldMeaning>;
  return { byFieldKey, meanings };
}

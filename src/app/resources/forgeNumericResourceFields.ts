/** Numeric Forge Fields that can safely supply an Atlas Resource maximum. */

import { parseResourceValue } from './resourceFields';
import type {
  ForgeStatblockFieldDescriptor,
  ForgeStatblockFieldExtractionWarning,
} from '../statblocks/notes/forgeStatblockFieldTypes';

export type ForgeNumericResourceFieldType = 'number' | 'rating' | 'text' | 'markdown';

/** A source Field after Forge's type/configuration has been checked for Atlas Resource compatibility. */
export interface ForgeNumericResourceField {
  /** Current Forge Field key; Former Keys have already been resolved by the note adapter. */
  path: string;
  label: string;
  fieldType: ForgeNumericResourceFieldType;
  /** The Field is the unique hit-points meaning, or the configured maximum of that Field. */
  recommended?: true;
}

function hasUnsafeNumericConfig(
  field: ForgeStatblockFieldDescriptor,
  warnings: readonly ForgeStatblockFieldExtractionWarning[],
): boolean {
  if (field.config.kind === 'numeric' && Boolean(field.config.settings.formula?.trim())) return true;
  // An invalid/truncated formula is not represented in the safe config. Do not treat its raw
  // stored value as authoritative when the source template says a formula setting was present.
  // Invalid Number tracking config also makes current-vs-maximum identity uncertain.
  return warnings.some((warning) => warning.fieldKey === field.key
    && (warning.property === 'formula' || (field.type === 'number' && warning.property === 'tracks')));
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function hasNumericStoredValue(value: unknown): boolean {
  return isNonNegativeNumber(value);
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * A Number Field with `tracks.maximumFieldKey` is the tracked current value, not the maximum
 * Atlas reads. Forge's maximum is the separately named Number Field. If that reference is absent
 * or invalid Forge falls back to the tracked Field itself, so that Field remains eligible.
 */
function trackedCurrentKeys(fields: readonly ForgeStatblockFieldDescriptor[]): Set<string> {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const result = new Set<string>();
  for (const field of fields) {
    if (field.type !== 'number' || field.config.kind !== 'numeric') continue;
    const maximumKey = field.config.settings.tracking?.maximumFieldKey;
    if (!maximumKey || maximumKey === field.key) continue;
    const maximumField = byKey.get(maximumKey);
    if (maximumField?.type === 'number' && maximumField.config.kind === 'numeric') result.add(field.key);
  }
  return result;
}

/**
 * Identify scalar Forge Fields which Atlas can safely read as Resource maxima.
 *
 * - Number is numeric by definition, including an empty template value. Formula-backed values
 *   are excluded because Atlas deliberately does not evaluate Forge's formula engine.
 * - Rating is representational as well as numeric, so it is eligible only when this note's
 *   resolved value is already a non-negative number. Fraction strings such as `1/4` remain text.
 * - Text/Markdown is considered only for the unique `hit-points` meaning and only when the
 *   current value parses as an Atlas Resource quantity.
 * - Scores, Entries Parts, Pairs, Dice, Choice, Counters and Checkboxes are structured or
 *   non-scalar sources; they are not flattened into a scalar Resource path here.
 *
 * The caller unions results across linked statblocks. A Rating therefore becomes available when
 *   at least one linked note actually stores a numeric Rating, while other notes may leave it blank.
 */
export function forgeNumericResourceFields(
  fields: readonly ForgeStatblockFieldDescriptor[],
  values: Readonly<Record<string, unknown>>,
  warnings: readonly ForgeStatblockFieldExtractionWarning[] = [],
): ForgeNumericResourceField[] {
  const currentKeys = trackedCurrentKeys(fields);
  const maximumForHitPoints = new Set<string>();
  const byKey = new Map(fields.map((field) => [field.key, field]));
  for (const field of fields) {
    if (field.atlasMeaning !== 'hit-points' || field.config.kind !== 'numeric') continue;
    const maximumKey = field.config.settings.tracking?.maximumFieldKey;
    if (!maximumKey || maximumKey === field.key || currentKeys.has(maximumKey)) continue;
    const maximumField = byKey.get(maximumKey);
    if (maximumField?.type === 'number' && maximumField.config.kind === 'numeric') maximumForHitPoints.add(maximumKey);
  }

  const result: ForgeNumericResourceField[] = [];
  const add = (field: ForgeStatblockFieldDescriptor, fieldType: ForgeNumericResourceFieldType): void => {
    if (result.some((candidate) => candidate.path === field.key)) return;
    result.push({
      path: field.key,
      label: field.label,
      fieldType,
      ...((field.atlasMeaning === 'hit-points' || maximumForHitPoints.has(field.key)) ? { recommended: true as const } : {}),
    });
  };

  for (const field of fields) {
    if (currentKeys.has(field.key) || hasUnsafeNumericConfig(field, warnings)) continue;
    const value = values[field.key];
    if (field.type === 'number' && field.config.kind === 'numeric') {
      // Empty values remain selectable because this is a template-defined numeric Field.
      if (isBlank(value) || hasNumericStoredValue(value)) add(field, 'number');
      continue;
    }
    if (field.type === 'rating' && field.config.kind === 'numeric') {
      // Do not parse `1/4` as an Atlas current/max pair: for Forge Rating it is a rank/fraction.
      if (isNonNegativeNumber(value)) add(field, 'rating');
      continue;
    }
    if ((field.type === 'text' || field.type === 'markdown')
      && field.atlasMeaning === 'hit-points'
      && typeof value === 'string'
      && parseResourceValue(value) !== null) {
      add(field, field.type);
    }
  }

  return result;
}

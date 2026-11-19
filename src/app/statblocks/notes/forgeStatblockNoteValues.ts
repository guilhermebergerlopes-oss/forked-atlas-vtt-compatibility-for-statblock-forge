/** Map values written in a Forge statblock note's frontmatter to its template Field keys. */

import { boundedFields, STATBLOCK_LIMITS } from '../../creatures/statblockValues';
import { isPlainRecord } from '../values/fieldValueOf';
import type {
  ForgeStatblockCheckboxOption,
  ForgeStatblockFieldDescriptor,
} from './forgeStatblockFieldTypes';
import {
  convertForgeStatblockFieldValue,
  type ForgeStatblockFieldValueConversionWarning,
} from './forgeStatblockFieldValueConverter';

const FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const CHECKBOX_OPTION_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const RESERVED_FIELD_KEYS = new Set([
  'tags', 'statblock-forge', '__forgeconditions', '__forgeconditionvalues', '__proto__', 'prototype', 'constructor',
]);

export type ForgeStatblockNoteValueMappingFailure =
  | 'frontmatter-not-object'
  | 'too-many-fields'
  | 'invalid-field-schema'
  | 'duplicate-field-key';

export interface ForgeStatblockNoteValueMapping {
  /** Values selected by the current template keys, copied within Atlas' statblock read limits. */
  values: Readonly<Record<string, unknown>>;
  /** Current Field keys that had a value in the note; null counts as a present value. */
  presentKeys: readonly string[];
  /** Current Field keys with no value in the note. */
  missingKeys: readonly string[];
  /** The actual frontmatter key used for each present current Field key. */
  sourceKeys: Readonly<Record<string, string>>;
  /** Current Field keys with more than one populated current/former key; sourceKeys records the winner. */
  ambiguousKeys: readonly string[];
  /** Scalar or collection values retained because they could not be safely normalized to an Atlas-compatible shape. */
  conversionWarnings: readonly ForgeStatblockFieldValueConversionWarning[];
}

export type ForgeStatblockNoteValueMappingResult =
  | { status: 'ready'; mapping: ForgeStatblockNoteValueMapping }
  | { status: 'invalid'; reason: ForgeStatblockNoteValueMappingFailure };

function hasNoteValue(frontmatter: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(frontmatter, key) && frontmatter[key] !== undefined;
}

function validCheckboxOptions(options: readonly ForgeStatblockCheckboxOption[]): boolean {
  const owners = new Set<string>();
  for (const option of options) {
    if (!option || typeof option.key !== 'string' || !CHECKBOX_OPTION_KEY_PATTERN.test(option.key)
      || !Array.isArray(option.aliases)) return false;
    const key = option.key.toLowerCase();
    if (owners.has(key)) return false;
    owners.add(key);
    for (const alias of option.aliases) {
      if (typeof alias !== 'string' || !CHECKBOX_OPTION_KEY_PATTERN.test(alias)) return false;
      const normalizedAlias = alias.toLowerCase();
      if (owners.has(normalizedAlias)) return false;
      owners.add(normalizedAlias);
    }
  }
  return true;
}

/**
 * Resolve renamed checkbox option keys without interpreting any other part of the Field value.
 * This mirrors Forge's key/alias rules while retaining non-boolean or unknown properties.
 */
function resolveCheckboxOptionAliases(
  raw: unknown,
  options: readonly ForgeStatblockCheckboxOption[],
): unknown {
  if (!isPlainRecord(raw) || options.length === 0 || !validCheckboxOptions(options)) return raw;

  const value: Record<string, unknown> = { ...raw };
  const originalEntries = Object.entries(raw);
  for (const option of options) {
    const currentValue = value[option.key];
    const aliases = new Set(option.aliases.map((alias) => alias.toLowerCase()));
    const matchingBooleanAliases = originalEntries.filter(([key, candidate]) =>
      aliases.has(key.toLowerCase()) && typeof candidate === 'boolean');

    // An existing malformed current value makes the row ambiguous. Keep it and its aliases
    // together rather than replacing one value with another during a compatibility migration.
    if (Object.hasOwn(value, option.key) && currentValue !== undefined && typeof currentValue !== 'boolean') continue;

    if (typeof currentValue !== 'boolean' && matchingBooleanAliases.length > 0) {
      // Forge checks the note object's property order when several legacy aliases are present.
      value[option.key] = matchingBooleanAliases[0]![1];
    }

    // Remove only valid boolean aliases. Unexpected value shapes remain available for recovery.
    for (const [key] of matchingBooleanAliases) delete value[key];
  }
  return value;
}

/**
 * Select each Field's current key, falling back to its Forge `formerKeys` in saved order.
 * Current keys always win. Checkboxes aliases are migrated first, then supported scalar and
 * collection Field values are normalized to Atlas conventions; unsupported types remain intact.
 */
export function mapForgeStatblockNoteValues(
  frontmatter: unknown,
  fields: readonly ForgeStatblockFieldDescriptor[],
): ForgeStatblockNoteValueMappingResult {
  if (!isPlainRecord(frontmatter)) return { status: 'invalid', reason: 'frontmatter-not-object' };
  if (fields.length > STATBLOCK_LIMITS.entries) return { status: 'invalid', reason: 'too-many-fields' };

  // Reserve every current key first so no Field's former key can shadow another Field's key.
  const currentKeys = new Set<string>();
  for (const field of fields) {
    if (!field || typeof field.key !== 'string' || !FIELD_KEY_PATTERN.test(field.key)
      || RESERVED_FIELD_KEYS.has(field.key.toLowerCase()) || field.key in Object.prototype) {
      return { status: 'invalid', reason: 'invalid-field-schema' };
    }
    const normalizedKey = field.key.toLowerCase();
    if (currentKeys.has(normalizedKey)) return { status: 'invalid', reason: 'duplicate-field-key' };
    currentKeys.add(normalizedKey);
  }

  const seenFormerKeys = new Set<string>();
  for (const field of fields) {
    const formerKeys = field.formerKeys;
    if (!Array.isArray(formerKeys) || formerKeys.length > STATBLOCK_LIMITS.entries) {
      return { status: 'invalid', reason: 'invalid-field-schema' };
    }
    for (const formerKey of formerKeys) {
      if (typeof formerKey !== 'string' || !FIELD_KEY_PATTERN.test(formerKey)
        || RESERVED_FIELD_KEYS.has(formerKey.toLowerCase()) || formerKey in Object.prototype) {
        return { status: 'invalid', reason: 'invalid-field-schema' };
      }
      const normalizedFormerKey = formerKey.toLowerCase();
      if (currentKeys.has(normalizedFormerKey) || seenFormerKeys.has(normalizedFormerKey)) {
        return { status: 'invalid', reason: 'duplicate-field-key' };
      }
      seenFormerKeys.add(normalizedFormerKey);
    }
  }

  const selected: Record<string, unknown> = {};
  const presentKeys: string[] = [];
  const missingKeys: string[] = [];
  const sourceKeys: Record<string, string> = {};
  const ambiguousKeys: string[] = [];
  const selectedFields = new Map<string, ForgeStatblockFieldDescriptor>();

  for (const field of fields) {
    const candidates = [field.key, ...(field.formerKeys ?? [])];
    const populatedCandidates = candidates.filter((key) => hasNoteValue(frontmatter, key));
    const sourceKey = populatedCandidates[0];
    if (sourceKey === undefined) {
      missingKeys.push(field.key);
      continue;
    }

    selected[field.key] = frontmatter[sourceKey];
    presentKeys.push(field.key);
    sourceKeys[field.key] = sourceKey;
    selectedFields.set(field.key, field);
    if (populatedCandidates.length > 1) ambiguousKeys.push(field.key);
  }

  // Bound and copy values before applying any nested migration. This prevents a large or cyclic
  // checkbox object from being spread before Atlas' existing read-budget policy has run.
  const values = boundedFields(selected);
  const conversionWarnings: ForgeStatblockFieldValueConversionWarning[] = [];
  for (const [fieldKey, field] of selectedFields) {
    if (field.type === 'checkboxes') {
      if (field.config.kind === 'checkboxes' && field.config.valid !== false) {
        values[fieldKey] = resolveCheckboxOptionAliases(values[fieldKey], field.config.options);
      }
    }

    const converted = convertForgeStatblockFieldValue(field, values[fieldKey]);
    values[fieldKey] = converted.value;
    if (converted.warning) conversionWarnings.push(converted.warning);
  }

  return {
    status: 'ready',
    mapping: { values, presentKeys, missingKeys, sourceKeys, ambiguousKeys, conversionWarnings },
  };
}

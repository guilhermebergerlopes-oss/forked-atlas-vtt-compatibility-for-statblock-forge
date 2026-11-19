/** Convert Forge Field values into the corresponding Atlas-compatible value shapes. */

import { isPlainRecord } from '../values/fieldValueOf';
import { choiceText, readChoice, unreadProblem, type ChoiceShape } from '../values/choicePicks';
import { splitEscapedList, splitListText } from '../values/listText';
import { isRegainFormula } from '../values/counterRegain';
import { writtenRoll } from '../../tools/textRolls';
import type { ForgeStatblockEntryPart, ForgeStatblockFieldDescriptor } from './forgeStatblockFieldTypes';

export type ForgeStatblockFieldValueConversionType =
  | 'number' | 'rating' | 'choice' | 'text' | 'list' | 'entries' | 'pairs' | 'scores' | 'spells'
  | 'counters' | 'checkboxes';
export type ForgeStatblockFieldValueConversionCode =
  | 'invalid-number'
  | 'invalid-rating-shape'
  | 'invalid-choice'
  | 'invalid-choice-config'
  | 'unsupported-text-shape'
  | 'invalid-list-shape'
  | 'invalid-entries-shape'
  | 'invalid-entry-part-value'
  | 'invalid-pairs-shape'
  | 'invalid-scores-shape'
  | 'invalid-spells-shape'
  | 'invalid-counters-shape'
  | 'invalid-counter-row'
  | 'invalid-counter-regain'
  | 'invalid-checkboxes-shape'
  | 'invalid-checkbox-value';

export interface ForgeStatblockFieldValueConversionWarning {
  fieldKey: string;
  type: ForgeStatblockFieldValueConversionType;
  code: ForgeStatblockFieldValueConversionCode;
}

export interface ForgeStatblockFieldValueConversion {
  value: unknown;
  warning?: ForgeStatblockFieldValueConversionWarning;
}

function warning(
  field: ForgeStatblockFieldDescriptor,
  code: ForgeStatblockFieldValueConversionCode,
): ForgeStatblockFieldValueConversionWarning {
  return { fieldKey: field.key, type: field.type as ForgeStatblockFieldValueConversionType, code };
}

function preserve(
  field: ForgeStatblockFieldDescriptor,
  raw: unknown,
  code: ForgeStatblockFieldValueConversionCode,
): ForgeStatblockFieldValueConversion {
  return { value: raw, warning: warning(field, code) };
}

const COUNTER_TEMPLATE_MAX_KEY = 'templateMax';

interface CounterValueRow extends Record<string, unknown> {
  name: string;
  max: number;
  used: number;
}

function validCounterValueRow(raw: unknown): raw is Record<string, unknown> & { name: string; max: number; used?: number } {
  if (!isPlainRecord(raw) || typeof raw.name !== 'string' || !Number.isInteger(raw.max) || Number(raw.max) < 0) return false;
  const used = raw.used === undefined ? 0 : raw.used;
  if (!Number.isInteger(used) || Number(used) < 0 || Number(used) > Number(raw.max)) return false;
  if (raw.reset !== undefined && raw.reset !== null && typeof raw.reset !== 'string') return false;
  if (raw.regain !== undefined && raw.regain !== null && typeof raw.regain !== 'string') return false;
  return true;
}

function sameCounterName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** Forge replaces the generated first label with the first configured preset name. */
function normalizedCounterName(name: string, index: number, presets: readonly { name: string }[]): string {
  const firstPreset = presets[0];
  const isLegacyPlaceholder = index === 0 && (!name.trim() || /^counter\s+1$/i.test(name.trim()));
  return isLegacyPlaceholder && firstPreset?.name.trim() ? firstPreset.name : name;
}

/**
 * Find the template row a stored Forge Counter row represents. Forge first matches by name and
 * then uses the same position when a row's name no longer matches any preset. This is also the
 * identity rule Atlas uses when it merges newly added template rows into an existing value.
 */
function counterPresetForRow(
  row: CounterValueRow,
  index: number,
  rows: readonly CounterValueRow[],
  presets: readonly { name: string; maximum: number }[],
): { name: string; maximum: number } | undefined {
  const namedMatches = presets.filter((preset) => sameCounterName(row.name, preset.name));
  if (namedMatches.length === 1) return namedMatches[0];
  if (namedMatches.length > 1 || presets.some((preset) => sameCounterName(row.name, preset.name))) return undefined;

  const atPlace = presets[index];
  if (!atPlace || rows.some((candidate) => sameCounterName(candidate.name, atPlace.name))) return undefined;
  return atPlace;
}

/**
 * Forge stores Counters as rows of { name, max, used, reset?, regain? }. Atlas uses the same
 * structure plus `templateMax`, which records that a maximum came from the matching template
 * preset. Adding it only when name/position and max agree preserves live template updates while
 * leaving per-statblock maximum overrides alone.
 */
function countersValue(field: ForgeStatblockFieldDescriptor, raw: unknown): ForgeStatblockFieldValueConversion {
  if (raw === null || raw === undefined) return { value: raw };
  if (!Array.isArray(raw)) return preserve(field, raw, 'invalid-counters-shape');
  if (raw.some((row) => !validCounterValueRow(row))) return preserve(field, raw, 'invalid-counter-row');

  const presets = field.config.kind === 'counters' && field.config.presetsValid !== false
    ? field.config.presets : [];
  const rows: CounterValueRow[] = raw.map((row, index) => {
    const normalized: CounterValueRow = {
      ...row,
      name: normalizedCounterName(row.name, index, presets),
      used: row.used === undefined ? 0 : Number(row.used),
    };
    // This is Atlas-owned bookkeeping, not a Forge field. Never trust a value supplied by a note.
    delete normalized[COUNTER_TEMPLATE_MAX_KEY];
    return normalized;
  });
  let invalidRegain = false;

  rows.forEach((row, index) => {
    if (typeof row.regain === 'string' && !isRegainFormula(row.regain)) invalidRegain = true;
    const preset = counterPresetForRow(row, index, rows, presets);
    if (preset && row.max === preset.maximum) row[COUNTER_TEMPLATE_MAX_KEY] = row.max;
  });

  return invalidRegain
    ? { value: rows, warning: warning(field, 'invalid-counter-regain') }
    : { value: rows };
}

/**
 * Checkboxes is a sparse boolean map. Missing option keys mean unchecked, just as Forge's
 * `checkboxOptionIsEnabled` treats them. Keep unknown values/properties for forward compatibility;
 * only flag configured option values that are neither true nor false.
 */
function checkboxesValue(field: ForgeStatblockFieldDescriptor, raw: unknown): ForgeStatblockFieldValueConversion {
  if (raw === null || raw === undefined) return { value: raw };
  if (!isPlainRecord(raw)) return preserve(field, raw, 'invalid-checkboxes-shape');
  if (field.config.kind !== 'checkboxes' || field.config.valid === false) return { value: raw };

  const hasInvalidOptionValue = field.config.options.some((option) =>
    Object.hasOwn(raw, option.key) && typeof raw[option.key] !== 'boolean');
  return hasInvalidOptionValue
    ? { value: raw, warning: warning(field, 'invalid-checkbox-value') }
    : { value: raw };
}

/** Forge Number editors save finite numbers; quoted numeric YAML is normalized the same way. */
function numberValue(field: ForgeStatblockFieldDescriptor, raw: unknown): ForgeStatblockFieldValueConversion {
  if (raw === null) return { value: null };
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw } : preserve(field, raw, 'invalid-number');
  if (typeof raw !== 'string') return preserve(field, raw, 'invalid-number');

  const text = raw.trim();
  if (text === '') return { value: null };
  const normalized = text.includes(',') && !text.includes('.') ? text.replace(',', '.') : text;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? { value: parsed } : preserve(field, raw, 'invalid-number');
}

/** Rating is text-like in Forge: numeric values become numbers, fractions and labels stay text. */
function ratingValue(field: ForgeStatblockFieldDescriptor, raw: unknown): ForgeStatblockFieldValueConversion {
  if (raw === null) return { value: null };
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw } : preserve(field, raw, 'invalid-rating-shape');
  if (typeof raw === 'boolean') return { value: String(raw) };
  if (typeof raw !== 'string') return preserve(field, raw, 'invalid-rating-shape');

  const trimmed = raw.trim().replace(/[−–]/g, '-');
  const fraction = trimmed.replace(/\s+/g, '').match(/^(-?\d+)\/([1-9]\d*)$/);
  if (fraction) return { value: `${fraction[1]}/${fraction[2]}` };

  const normalized = trimmed.includes(',') && !trimmed.includes('.') ? trimmed.replace(',', '.') : trimmed;
  if (normalized !== '') {
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return { value: parsed };
  }
  return { value: trimmed };
}

function scalarText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null;
  if (typeof raw === 'boolean') return String(raw);
  return null;
}

/** Forge Text values are entered as text; scalar YAML values display as their string form. */
function textValue(field: ForgeStatblockFieldDescriptor, raw: unknown): ForgeStatblockFieldValueConversion {
  if (raw === null || typeof raw === 'string') return { value: raw };
  if (typeof raw === 'number' && !Number.isFinite(raw)) return preserve(field, raw, 'unsupported-text-shape');
  if (typeof raw === 'number' || typeof raw === 'boolean') return { value: String(raw) };
  return preserve(field, raw, 'unsupported-text-shape');
}

function listItemText(value: unknown): string | null {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

/** Forge List saves string arrays; a legacy inline value is split at unescaped commas/newlines. */
function listValue(field: ForgeStatblockFieldDescriptor, raw: unknown): ForgeStatblockFieldValueConversion {
  if (raw === null || raw === undefined) return { value: raw };
  if (typeof raw === 'string') return { value: splitEscapedList(raw) };
  if (typeof raw === 'number' && Number.isFinite(raw) || typeof raw === 'boolean') {
    return { value: splitEscapedList(String(raw)) };
  }
  if (!Array.isArray(raw)) return preserve(field, raw, 'invalid-list-shape');

  const items: string[] = [];
  for (const item of raw) {
    const text = listItemText(item);
    if (text === null) return preserve(field, raw, 'invalid-list-shape');
    if (text !== '') items.push(text);
  }
  return { value: items };
}

function parseEntryNumber(raw: unknown): { value: unknown; valid: boolean } {
  if (typeof raw === 'number') return { value: raw, valid: Number.isFinite(raw) };
  if (typeof raw !== 'string') return { value: raw, valid: false };
  const text = raw.trim().replace(/[−–]/g, '-');
  if (!text) return { value: raw, valid: true };
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return { value: text, valid: false };
  const numeric = Number(text);
  return Number.isFinite(numeric) ? { value: numeric, valid: true } : { value: raw, valid: false };
}

function convertEntryPart(
  part: ForgeStatblockEntryPart,
  raw: unknown,
): { value: unknown; warning: boolean } {
  // Entry Counter Parts are not top-level Counters Fields; Atlas has no native Entry Part counter value type, so keep their boolean-array shape intact.
  if (part.type === 'counter' || !part.supported) return { value: raw, warning: false };
  if (part.type === 'number') {
    const converted = parseEntryNumber(raw);
    return { value: converted.value, warning: !converted.valid };
  }
  if (part.type === 'list') {
    if (typeof raw === 'string') return { value: splitListText(raw), warning: false };
    if (Array.isArray(raw)) {
      const items: string[] = [];
      for (const item of raw) {
        const text = listItemText(item);
        if (text === null) return { value: raw, warning: true };
        if (text) items.push(text);
      }
      return { value: items, warning: false };
    }
    if (typeof raw === 'number' && Number.isFinite(raw) || typeof raw === 'boolean') {
      return { value: splitListText(String(raw)), warning: false };
    }
    return { value: raw, warning: true };
  }
  if (part.type === 'text' || part.type === 'dice' || part.type === 'choice') {
    if (typeof raw === 'string') return { value: raw.trim(), warning: false };
    if (typeof raw === 'number' && Number.isFinite(raw) || typeof raw === 'boolean') {
      return { value: String(raw), warning: false };
    }
    return { value: raw, warning: true };
  }
  return { value: raw, warning: false };
}

function convertEntryRecord(
  field: ForgeStatblockFieldDescriptor,
  raw: Record<string, unknown>,
): { value: Record<string, unknown>; warning: boolean } {
  if (field.config.kind !== 'entries') return { value: raw, warning: false };
  const value: Record<string, unknown> = { ...raw };
  let hasWarning = false;
  for (const part of field.config.settings.parts) {
    if (!Object.hasOwn(value, part.key)) continue;
    const converted = convertEntryPart(part, value[part.key]);
    value[part.key] = converted.value;
    hasWarning ||= converted.warning;
  }
  return hasWarning ? { value: raw, warning: true } : { value, warning: false };
}

/** Entries keep their configured name/text keys and unknown properties; only declared Parts are normalized. */
function entriesValue(field: ForgeStatblockFieldDescriptor, raw: unknown): ForgeStatblockFieldValueConversion {
  if (raw === null || raw === undefined) return { value: raw };
  if (isPlainRecord(raw)) {
    const converted = convertEntryRecord(field, raw);
    return converted.warning
      ? { value: raw, warning: warning(field, 'invalid-entry-part-value') }
      : { value: converted.value };
  }
  if (!Array.isArray(raw)) {
    // Legacy plain-text entries are a supported Atlas shape and are kept intact.
    return typeof raw === 'string' ? { value: raw } : preserve(field, raw, 'invalid-entries-shape');
  }

  let hasWarning = false;
  const value = raw.map((entry) => {
    if (!isPlainRecord(entry)) return entry;
    const converted = convertEntryRecord(field, entry);
    hasWarning ||= converted.warning;
    return converted.value;
  });
  return hasWarning ? { value, warning: warning(field, 'invalid-entry-part-value') } : { value };
}

function pairNumberFromText(raw: string): number | null {
  const text = raw.trim().replace(/[\u2212\u2013]/g, '-');
  if (!/^[+\-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function pairFromText(text: string): unknown {
  const source = text.trim();
  if (!source) return source;
  const explicit = source.match(/^(.+?)\s*:\s*(.+)$/);
  if (explicit) {
    const key = explicit[1]!.replace(/\\([\\,:])/g, '$1').trim();
    const rawValue = explicit[2]!.trim();
    if (key && /\p{L}/u.test(key)) {
      const numeric = pairNumberFromText(rawValue);
      if (numeric !== null) return { [key]: numeric };
      const formula = writtenRoll(rawValue);
      if (formula) return { [key]: formula };
    }
    return source;
  }

  // Mirror Forge's left-to-right label/value split. Numeric values are tested
  // before dice formulas, so a signed bonus stays numeric while `2d8 + 3`
  // remains one roll expression.
  for (let split = source.indexOf(' '); split > 0; split = source.indexOf(' ', split + 1)) {
    const key = source.slice(0, split).trim();
    const rawValue = source.slice(split + 1).trim();
    if (!key || !/\p{L}/u.test(key) || !rawValue) continue;
    const numeric = pairNumberFromText(rawValue);
    if (numeric !== null) return { [key]: numeric };
    const formula = writtenRoll(rawValue);
    if (formula) return { [key]: formula };
  }
  return source;
}

/** Text and legacy string rows become Atlas-readable pairs; already structured values keep their shape. */
function pairsValue(field: ForgeStatblockFieldDescriptor, raw: unknown): ForgeStatblockFieldValueConversion {
  if (raw === null || raw === undefined) return { value: raw };
  if (typeof raw === 'string') return { value: splitEscapedList(raw).map(pairFromText) };
  if (isPlainRecord(raw)) return { value: raw };
  if (!Array.isArray(raw)) return preserve(field, raw, 'invalid-pairs-shape');

  let hasInvalid = false;
  const value = raw.map((item) => {
    if (typeof item === 'string') return pairFromText(item);
    if (isPlainRecord(item)) return item;
    hasInvalid = true;
    return item;
  });
  return hasInvalid ? preserve(field, raw, 'invalid-pairs-shape') : { value };
}

function tableCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function tableRow(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(tableCell);
  return [tableCell(value)];
}

/** Normalize Scores cells to the scalar cell values consumed by Atlas' table renderer. */
function scoresValue(field: ForgeStatblockFieldDescriptor, raw: unknown): ForgeStatblockFieldValueConversion {
  if (raw === null || raw === undefined) return { value: raw };
  if (Array.isArray(raw)) {
    // A list of one-key records is a supported named-column representation; keep it intact.
    if (raw.every((item) => isPlainRecord(item))) return { value: raw };
    if (raw.some(Array.isArray)) return { value: raw.map(tableRow) };
    if (raw.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
      return { value: raw.map(tableCell) };
    }
    return preserve(field, raw, 'invalid-scores-shape');
  }
  if (isPlainRecord(raw)) {
    if (Array.isArray(raw.rows) && (raw.columns === undefined || Array.isArray(raw.columns))) {
      const value: Record<string, unknown> = { ...raw, rows: raw.rows.map(tableRow) };
      if (Array.isArray(raw.columns)) value.columns = raw.columns.map((column) => String(tableCell(column) ?? ''));
      return { value };
    }
    // Records keyed by the template's slot keys are already native Atlas Scores values.
    return { value: raw };
  }
  return preserve(field, raw, 'invalid-scores-shape');
}

function spellValueText(raw: unknown, depth = 0): string {
  if (raw === null || raw === undefined || depth >= 32) return '';
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : '';
  if (typeof raw === 'boolean') return String(raw);
  if (Array.isArray(raw)) {
    return raw.map((item) => spellValueText(item, depth + 1)).filter(Boolean).join(', ');
  }
  if (isPlainRecord(raw)) {
    return Object.entries(raw).map(([key, item]) => {
      const text = spellValueText(item, depth + 1);
      return text ? `${key}: ${text}` : key;
    }).join(', ');
  }
  return '';
}

/** Spells use Atlas' native header strings and one-key level records. */
function spellsValue(field: ForgeStatblockFieldDescriptor, raw: unknown): ForgeStatblockFieldValueConversion {
  if (raw === null || raw === undefined) return { value: raw };
  const entries = Array.isArray(raw)
    ? raw
    : isPlainRecord(raw)
      ? Object.entries(raw).map(([level, spells]) => ({ [level]: spells }))
      : [raw];
  const value: unknown[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (text) value.push(text);
      continue;
    }
    if (isPlainRecord(entry)) {
      for (const [level, rawSpells] of Object.entries(entry)) {
        const key = level.trim();
        const spells = spellValueText(rawSpells);
        if (key && spells) value.push({ [key]: spells });
      }
      continue;
    }
    const text = spellValueText(entry);
    if (text) value.push(text);
  }
  return { value };
}

/** Apply Atlas-compatible conversions while retaining values that cannot be safely normalized. */
export function convertForgeStatblockFieldValue(
  field: ForgeStatblockFieldDescriptor,
  raw: unknown,
): ForgeStatblockFieldValueConversion {
  switch (field.type) {
    case 'number':
      return numberValue(field, raw);
    case 'rating':
      return ratingValue(field, raw);
    case 'text':
      return textValue(field, raw);
    case 'choice': {
      if (raw === null || raw === '') return { value: raw };
      const settings = field.config.kind === 'choice' ? field.config.settings : null;
      if (!settings || settings.valid === false) return preserve(field, raw, 'invalid-choice-config');
      const text = scalarText(raw);
      if (text === null) return preserve(field, raw, 'invalid-choice');
      const constraints: ChoiceShape = {
        options: settings.options,
        several: settings.several,
        numbered: settings.numbered,
        open: settings.allowOther,
        ...(settings.unit !== undefined ? { unit: settings.unit } : {}),
      };

      if (!constraints.several && !constraints.numbered) {
        const wanted = text.trim().toLowerCase();
        const option = constraints.options?.find((candidate) => candidate.trim().toLowerCase() === wanted);
        if (option !== undefined) return { value: option };
        return constraints.open || (constraints.options?.length ?? 0) === 0
          ? { value: text.trim() }
          : preserve(field, raw, 'invalid-choice');
      }

      const read = readChoice(constraints, text);
      if ((constraints.options?.length ?? 0) > 0 && unreadProblem(constraints, read.unread) !== null) {
        return preserve(field, raw, 'invalid-choice');
      }
      return { value: choiceText(constraints, read) };
    }
    case 'list':
      return listValue(field, raw);
    case 'entries':
      return entriesValue(field, raw);
    case 'pairs':
      return pairsValue(field, raw);
    case 'scores':
      return scoresValue(field, raw);
    case 'spells':
      return spellsValue(field, raw);
    case 'counters':
      return countersValue(field, raw);
    case 'checkboxes':
      return checkboxesValue(field, raw);
    default:
      return { value: raw };
  }
}

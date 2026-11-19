/** Read only the known interpretation settings attached to Forge Fields. */

import { isPlainRecord } from '../values/fieldValueOf';
import type { ForgeStatblockTemplateField } from './forgeStatblockTemplateReader';
import type {
  ForgeStatblockCheckboxOption,
  ForgeStatblockChoiceSettings,
  ForgeStatblockCounterPreset,
  ForgeStatblockEntriesSettings,
  ForgeStatblockFieldConfig,
  ForgeStatblockFieldExtractionWarning,
  ForgeStatblockNumericSettings,
  ForgeStatblockScoreColumn,
  ForgeStatblockEntryPart,
} from './forgeStatblockFieldTypes';

const PART_TYPES = new Set(['text', 'number', 'dice', 'list', 'choice', 'counter']);
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const OPTION_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_OPTIONS = 500;
const MAX_SETTING_TEXT = 500;

function optionalString(value: unknown, maximum = MAX_SETTING_TEXT): string | undefined {
  return typeof value === 'string' && value.length <= maximum ? value : undefined;
}

function stringList(
  value: unknown,
  fieldKey: string,
  property: string,
  warnings: ForgeStatblockFieldExtractionWarning[],
): string[] {
  if (!Array.isArray(value)) {
    warnings.push({ fieldKey, code: 'invalid-config', property });
    return [];
  }
  if (value.length > MAX_OPTIONS) warnings.push({ fieldKey, code: 'truncated-config', property });
  const result: string[] = [];
  for (const item of value.slice(0, MAX_OPTIONS)) {
    if (typeof item === 'string' && item.length <= MAX_SETTING_TEXT) result.push(item);
    else warnings.push({ fieldKey, code: 'invalid-config', property });
  }
  return result;
}

function numericConfig(
  field: ForgeStatblockTemplateField,
  warnings: ForgeStatblockFieldExtractionWarning[],
): ForgeStatblockFieldConfig {
  const settings: ForgeStatblockNumericSettings = {};
  if (field.unit !== undefined) {
    const unit = optionalString(field.unit, 120);
    if (unit === undefined) warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'unit' });
    else if (unit) settings.unit = unit;
  }
  if (field.formula !== undefined) {
    const formula = optionalString(field.formula, 500);
    if (formula === undefined) warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'formula' });
    else if (formula.trim()) settings.formula = formula;
  }
  if (field.type === 'number' && field.tracks !== undefined) {
    if (!isPlainRecord(field.tracks) || (field.tracks.counts !== 'up' && field.tracks.counts !== 'down')
      || (field.tracks.max !== undefined && (typeof field.tracks.max !== 'string' || !KEY_PATTERN.test(field.tracks.max)))) {
      warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'tracks' });
    } else {
      settings.tracking = {
        direction: field.tracks.counts,
        ...(typeof field.tracks.max === 'string' ? { maximumFieldKey: field.tracks.max } : {}),
      };
    }
  }
  return { kind: 'numeric', settings };
}

function choiceConfig(field: ForgeStatblockTemplateField, warnings: ForgeStatblockFieldExtractionWarning[]): ForgeStatblockFieldConfig {
  let valid = true;
  if (Array.isArray(field.options)) {
    const seen = new Set<string>();
    for (const option of field.options) {
      if (typeof option !== 'string') continue;
      const normalized = option.trim().toLowerCase();
      if (!normalized) continue;
      if (seen.has(normalized)) valid = false;
      seen.add(normalized);
    }
    if (!valid) warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'options' });
  }
  if (field.options !== undefined && (!Array.isArray(field.options)
    || field.options.length > MAX_OPTIONS
    || field.options.some((option) => typeof option !== 'string' || option.length > MAX_SETTING_TEXT))) valid = false;
  const options = field.options === undefined ? [] : stringList(field.options, field.key, 'options', warnings);
  const unit = optionalString(field.unit, 120);
  if (field.unit !== undefined && unit === undefined) {
    warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'unit' });
    valid = false;
  }
  for (const property of ['several', 'numbered', 'open'] as const) {
    if (field[property] !== undefined && typeof field[property] !== 'boolean') {
      warnings.push({ fieldKey: field.key, code: 'invalid-config', property });
      valid = false;
    }
  }
  const settings: ForgeStatblockChoiceSettings = {
    options,
    several: field.several === true,
    numbered: field.numbered === true,
    allowOther: field.open === true,
    ...(valid ? {} : { valid: false }),
  };
  if (unit) settings.unit = unit;
  return { kind: 'choice', settings };
}

function entryPartConfig(
  raw: unknown,
  fieldKey: string,
  warnings: ForgeStatblockFieldExtractionWarning[],
): ForgeStatblockEntryPart | null {
  if (!isPlainRecord(raw) || typeof raw.key !== 'string' || !KEY_PATTERN.test(raw.key)
    || typeof raw.label !== 'string' || typeof raw.type !== 'string') {
    warnings.push({ fieldKey, code: 'invalid-config', property: 'entry.extras' });
    return null;
  }
  const part: ForgeStatblockEntryPart = {
    key: raw.key,
    label: raw.label.slice(0, 200),
    type: raw.type,
    supported: PART_TYPES.has(raw.type),
  };
  if (raw.options !== undefined) part.options = stringList(raw.options, fieldKey, `entry.extras.${raw.key}.options`, warnings);
  if (typeof raw.several === 'boolean') part.several = raw.several;
  else if (raw.several !== undefined) warnings.push({ fieldKey, code: 'invalid-config', property: `entry.extras.${raw.key}.several` });
  if (typeof raw.max === 'number' && Number.isFinite(raw.max) && Number.isInteger(raw.max) && raw.max >= 0 && raw.max <= 99) part.max = raw.max;
  else if (raw.max !== undefined) warnings.push({ fieldKey, code: 'invalid-config', property: `entry.extras.${raw.key}.max` });
  if (raw.look === 'pips' || raw.look === 'checkboxes') part.look = raw.look;
  else if (raw.look !== undefined) warnings.push({ fieldKey, code: 'invalid-config', property: `entry.extras.${raw.key}.look` });
  return part;
}

function entriesConfig(field: ForgeStatblockTemplateField, warnings: ForgeStatblockFieldExtractionWarning[]): ForgeStatblockFieldConfig {
  const entry = isPlainRecord(field.entry) ? field.entry : {};
  if (field.entry !== undefined && !isPlainRecord(field.entry)) {
    warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'entry' });
  }
  const nameKey = typeof entry.nameKey === 'string' && KEY_PATTERN.test(entry.nameKey) ? entry.nameKey : 'name';
  const textKey = typeof entry.textKey === 'string' && KEY_PATTERN.test(entry.textKey) ? entry.textKey : 'desc';
  if (entry.nameKey !== undefined && nameKey === 'name' && entry.nameKey !== 'name') warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'entry.nameKey' });
  if (entry.textKey !== undefined && textKey === 'desc' && entry.textKey !== 'desc') warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'entry.textKey' });
  const parts: ForgeStatblockEntryPart[] = [];
  if (entry.extras !== undefined && !Array.isArray(entry.extras)) {
    warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'entry.extras' });
  } else if (Array.isArray(entry.extras)) {
    for (const raw of entry.extras.slice(0, MAX_OPTIONS)) {
      const part = entryPartConfig(raw, field.key, warnings);
      if (part) parts.push(part);
    }
    if (entry.extras.length > MAX_OPTIONS) warnings.push({ fieldKey: field.key, code: 'truncated-config', property: 'entry.extras' });
  }
  const settings: ForgeStatblockEntriesSettings = { nameKey, textKey, parts };
  return { kind: 'entries', settings };
}

function scoresConfig(field: ForgeStatblockTemplateField, warnings: ForgeStatblockFieldExtractionWarning[]): ForgeStatblockFieldConfig {
  const labels = field.slots === undefined ? [] : stringList(field.slots, field.key, 'slots', warnings);
  const keys = field.slotKeys === undefined ? [] : stringList(field.slotKeys, field.key, 'slotKeys', warnings);
  if (keys.length > 0 && keys.length < labels.length) {
    warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'slotKeys.missing' });
  }
  const columns = labels.map((label, index): ForgeStatblockScoreColumn => {
    const key = keys[index];
    if (key !== undefined && !KEY_PATTERN.test(key)) warnings.push({ fieldKey: field.key, code: 'invalid-config', property: `slotKeys.${index}` });
    return { label, ...(key !== undefined && KEY_PATTERN.test(key) ? { key } : {}) };
  });
  return { kind: 'scores', columns };
}

function countersConfig(field: ForgeStatblockTemplateField, warnings: ForgeStatblockFieldExtractionWarning[]): ForgeStatblockFieldConfig {
  const presets: ForgeStatblockCounterPreset[] = [];
  let presetsValid = true;
  if (field.counterRows !== undefined && !Array.isArray(field.counterRows)) {
    warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'counterRows' });
    presetsValid = false;
  } else if (Array.isArray(field.counterRows)) {
    for (const raw of field.counterRows.slice(0, MAX_OPTIONS)) {
      if (!isPlainRecord(raw) || (raw.name !== undefined && typeof raw.name !== 'string')
        || typeof raw.max !== 'number' || !Number.isInteger(raw.max) || raw.max < 0 || raw.max > 99) {
        warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'counterRows' });
        presetsValid = false;
        continue;
      }
      const preset: ForgeStatblockCounterPreset = {
        name: typeof raw.name === 'string' ? raw.name.slice(0, 200) : '',
        maximum: raw.max,
      };
      if (typeof raw.regain === 'string' && raw.regain.length <= 500) preset.regainFormula = raw.regain;
      else if (raw.regain !== undefined && raw.regain !== null) warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'counterRows.regain' });
      presets.push(preset);
    }
    if (field.counterRows.length > MAX_OPTIONS) {
      warnings.push({ fieldKey: field.key, code: 'truncated-config', property: 'counterRows' });
      presetsValid = false;
    }
  }
  if (field.showCounterValue !== undefined && typeof field.showCounterValue !== 'boolean') {
    warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'showCounterValue' });
  }
  return {
    kind: 'counters', presets, showNumericValues: field.showCounterValue === true,
    ...(presetsValid ? {} : { presetsValid: false }),
  };
}

function checkboxesConfig(field: ForgeStatblockTemplateField, warnings: ForgeStatblockFieldExtractionWarning[]): ForgeStatblockFieldConfig {
  const options: ForgeStatblockCheckboxOption[] = [];
  let valid = true;
  if (field.options !== undefined && !Array.isArray(field.options)) {
    warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'options' });
    valid = false;
  } else if (Array.isArray(field.options)) {
    for (const raw of field.options.slice(0, MAX_OPTIONS)) {
      if (!isPlainRecord(raw) || typeof raw.key !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(raw.key)
        || typeof raw.label !== 'string') {
        warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'options' });
        valid = false;
        continue;
      }
      const aliases: string[] = [];
      if (raw.aliases !== undefined && !Array.isArray(raw.aliases)) {
        warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'options.aliases' });
        valid = false;
      } else if (Array.isArray(raw.aliases)) {
        for (const alias of raw.aliases.slice(0, MAX_OPTIONS)) {
          if (typeof alias === 'string' && OPTION_KEY_PATTERN.test(alias)) aliases.push(alias);
          else {
            warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'options.aliases' });
            valid = false;
          }
        }
      }
      options.push({ key: raw.key, label: raw.label.slice(0, 200), aliases });
    }
    if (field.options.length > MAX_OPTIONS) {
      warnings.push({ fieldKey: field.key, code: 'truncated-config', property: 'options' });
      valid = false;
    }
  }

  // Forge preserves a Checkboxes value verbatim when its option keys/aliases are ambiguous.
  const owners = new Set<string>();
  let hasCollision = false;
  for (const option of options) {
    const key = option.key.toLowerCase();
    if (owners.has(key)) hasCollision = true;
    owners.add(key);
    for (const alias of option.aliases) {
      const normalizedAlias = alias.toLowerCase();
      if (owners.has(normalizedAlias)) hasCollision = true;
      owners.add(normalizedAlias);
    }
  }
  if (hasCollision) {
    valid = false;
    warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'options' });
  }
  return { kind: 'checkboxes', options, valid };
}

/** Return the supported configuration subset for a Field type. */
export function readForgeFieldConfig(
  field: ForgeStatblockTemplateField,
  warnings: ForgeStatblockFieldExtractionWarning[],
): ForgeStatblockFieldConfig {
  switch (field.type) {
    case 'number':
    case 'rating': return numericConfig(field, warnings);
    case 'choice': return choiceConfig(field, warnings);
    case 'entries': return entriesConfig(field, warnings);
    case 'scores': return scoresConfig(field, warnings);
    case 'counters': return countersConfig(field, warnings);
    case 'checkboxes': return checkboxesConfig(field, warnings);
    default: return { kind: 'none' };
  }
}

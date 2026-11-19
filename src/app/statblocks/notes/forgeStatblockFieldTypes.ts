/** Stable normalized Field contracts shared by the Forge adapter stages. */

import type { FieldKey, FieldMeaning } from '../model/templateTypes';
import type { ForgeLayoutReadResult } from './forgeStatblockTemplateReader';
import { isPlainRecord } from '../values/fieldValueOf';

export type ForgeStatblockFieldType =
  | 'text' | 'markdown' | 'number' | 'rating' | 'dice' | 'choice' | 'list'
  | 'scores' | 'entries' | 'pairs' | 'image' | 'spells' | 'counters' | 'checkboxes';

export type ForgeStatblockFieldMeaning =
  | 'hit-points' | 'armor' | 'rating' | 'size' | 'creature-type'
  | 'senses' | 'initiative' | 'traits' | 'description' | 'display-name';

export type ForgeStatblockFieldCategory =
  | 'value' | 'metric' | 'collections' | 'table' | 'resources' | 'text' | 'image';

export interface ForgeStatblockNumericSettings {
  unit?: string;
  /** Kept as source text; Atlas does not evaluate Forge formulas in this step. */
  formula?: string;
  tracking?: { direction: 'up' | 'down'; maximumFieldKey?: string };
}

export interface ForgeStatblockChoiceSettings {
  options: string[];
  several: boolean;
  numbered: boolean;
  allowOther: boolean;
  unit?: string;
  /** False when Forge's saved choice settings were malformed or truncated. */
  valid?: boolean;
}

export interface ForgeStatblockEntryPart {
  key: string;
  label: string;
  type: string;
  supported: boolean;
  options?: string[];
  several?: boolean;
  max?: number;
  look?: 'pips' | 'checkboxes';
}

export interface ForgeStatblockEntriesSettings {
  nameKey: string;
  textKey: string;
  parts: ForgeStatblockEntryPart[];
}

export interface ForgeStatblockScoreColumn {
  label: string;
  key?: string;
}

export interface ForgeStatblockCounterPreset {
  name: string;
  maximum: number;
  regainFormula?: string;
}

export interface ForgeStatblockCheckboxOption {
  key: string;
  label: string;
  aliases: string[];
}

export type ForgeStatblockFieldConfig =
  | { kind: 'none' }
  | { kind: 'numeric'; settings: ForgeStatblockNumericSettings }
  | { kind: 'choice'; settings: ForgeStatblockChoiceSettings }
  | { kind: 'entries'; settings: ForgeStatblockEntriesSettings }
  | { kind: 'scores'; columns: ForgeStatblockScoreColumn[] }
  | { kind: 'counters'; presets: ForgeStatblockCounterPreset[]; showNumericValues: boolean; presetsValid?: boolean }
  | { kind: 'checkboxes'; options: ForgeStatblockCheckboxOption[]; valid?: boolean };

export interface ForgeStatblockFieldDescriptor {
  /** Original order in template.fields; useful for stable display and diagnostics. */
  index: number;
  /** Stable Forge Field ID, preserved across key/label renames when sidecar metadata is available. */
  stableId?: string;
  key: string;
  label: string;
  type: ForgeStatblockFieldType;
  /** Raw Forge meaning; semanticMeaning is set only when it is known and unique. */
  meaning?: string;
  semanticMeaning?: ForgeStatblockFieldMeaning;
  /** The validated equivalent used by Atlas; absent for unknown or ambiguous meanings. */
  atlasMeaning?: FieldMeaning;
  formerKeys: string[];
  category: ForgeStatblockFieldCategory;
  /** True only for an ordinary Image Field pinned by the Forge template. */
  pinnedImage: boolean;
  config: ForgeStatblockFieldConfig;
}

export interface ForgeStatblockFieldExtractionWarning {
  fieldKey: string;
  code: 'unknown-meaning' | 'duplicate-meaning' | 'duplicate-field-id' | 'invalid-config' | 'truncated-config';
  property: string;
}

export interface ForgeStatblockFieldExtraction {
  fields: ForgeStatblockFieldDescriptor[];
  /** Atlas-compatible semantic meaning -> Field key map. */
  meanings: Readonly<Partial<Record<FieldMeaning, FieldKey>>>;
  warnings: ForgeStatblockFieldExtractionWarning[];
}

export const FIELD_MEANINGS: ReadonlySet<ForgeStatblockFieldMeaning> = new Set([
  'hit-points', 'armor', 'rating', 'size', 'creature-type', 'senses',
  'initiative', 'traits', 'description', 'display-name',
]);

const DEFAULT_CATEGORY: Readonly<Record<ForgeStatblockFieldType, ForgeStatblockFieldCategory>> = {
  text: 'value', number: 'value', rating: 'value', dice: 'value', choice: 'value',
  markdown: 'text', list: 'collections', scores: 'table', entries: 'collections',
  pairs: 'collections', image: 'image', spells: 'collections', counters: 'resources', checkboxes: 'resources',
};

const CATEGORY_ALIASES: Readonly<Record<string, ForgeStatblockFieldCategory>> = {
  abilities: 'collections', counters: 'resources', checkboxes: 'resources',
  tags: 'collections', pairs: 'collections', spells: 'collections',
};

function categorySupportsType(category: ForgeStatblockFieldCategory, type: ForgeStatblockFieldType): boolean {
  switch (category) {
    case 'value':
    case 'metric': return ['text', 'number', 'rating', 'dice', 'choice'].includes(type);
    case 'collections': return ['entries', 'list', 'pairs', 'spells'].includes(type);
    case 'table': return type === 'scores';
    case 'resources': return type === 'counters' || type === 'checkboxes';
    case 'text': return type === 'markdown';
    case 'image': return type === 'image';
  }
}

/** Resolve Forge's saved Field category, falling back to the category implied by its type. */
export function forgeStatblockFieldCategory(
  type: ForgeStatblockFieldType,
  key: string,
  layout: ForgeLayoutReadResult | undefined,
): ForgeStatblockFieldCategory {
  if (layout?.status === 'available' && isPlainRecord(layout.document.fieldKinds)) {
    const saved = layout.document.fieldKinds[key];
    if (typeof saved === 'string') {
      const normalized = CATEGORY_ALIASES[saved] ?? saved;
      if (['value', 'metric', 'collections', 'table', 'resources', 'text', 'image'].includes(normalized)
        && categorySupportsType(normalized as ForgeStatblockFieldCategory, type)) {
        return normalized as ForgeStatblockFieldCategory;
      }
    }
  }
  return DEFAULT_CATEGORY[type];
}

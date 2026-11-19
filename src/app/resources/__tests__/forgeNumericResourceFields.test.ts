import { describe, expect, it } from 'vitest';
import type {
  ForgeStatblockFieldDescriptor,
  ForgeStatblockFieldExtractionWarning,
} from '../../statblocks/notes/forgeStatblockFieldTypes';
import { forgeNumericResourceFields } from '../forgeNumericResourceFields';

function numericField(
  key: string,
  type: 'number' | 'rating' = 'number',
  options: { formula?: string; maximumFieldKey?: string; meaning?: 'hit-points' } = {},
): ForgeStatblockFieldDescriptor {
  return {
    index: 0,
    key,
    label: key.toUpperCase(),
    type,
    ...(options.meaning ? { semanticMeaning: options.meaning, atlasMeaning: options.meaning } : {}),
    formerKeys: [],
    category: 'value',
    pinnedImage: false,
    config: {
      kind: 'numeric',
      settings: {
        ...(options.formula ? { formula: options.formula } : {}),
        ...(options.maximumFieldKey ? { tracking: { direction: 'down', maximumFieldKey: options.maximumFieldKey } } : {}),
      },
    },
  } as ForgeStatblockFieldDescriptor;
}

function plainField(
  key: string,
  type: ForgeStatblockFieldDescriptor['type'],
  options: { meaning?: 'hit-points'; config?: ForgeStatblockFieldDescriptor['config'] } = {},
): ForgeStatblockFieldDescriptor {
  return {
    index: 0,
    key,
    label: key.toUpperCase(),
    type,
    ...(options.meaning ? { semanticMeaning: options.meaning, atlasMeaning: options.meaning } : {}),
    formerKeys: [],
    category: 'value',
    pinnedImage: false,
    config: options.config ?? { kind: 'none' },
  } as ForgeStatblockFieldDescriptor;
}

describe('forgeNumericResourceFields', () => {
  it('offers scalar Number Fields, including empty template values', () => {
    const fields = [numericField('hp', 'number', { meaning: 'hit-points' }), numericField('mana')];
    expect(forgeNumericResourceFields(fields, { hp: 18, mana: null })).toEqual([
      { path: 'hp', label: 'HP', fieldType: 'number', recommended: true },
      { path: 'mana', label: 'MANA', fieldType: 'number' },
    ]);
  });

  it('excludes formula-backed Number and Rating Fields because Atlas does not evaluate Forge formulas', () => {
    const fields = [numericField('derivedHp', 'number', { formula: '@level * 5' }), numericField('rank', 'rating', { formula: '@level' })];
    expect(forgeNumericResourceFields(fields, { derivedHp: 25, rank: 4 })).toEqual([]);
  });

  it('excludes a Number Field used as a tracked current value when it names a separate Number maximum', () => {
    const current = numericField('currentHp', 'number', { maximumFieldKey: 'maximumHp', meaning: 'hit-points' });
    const maximum = numericField('maximumHp');
    expect(forgeNumericResourceFields([current, maximum], { currentHp: 8, maximumHp: 20 })).toEqual([
      { path: 'maximumHp', label: 'MAXIMUMHP', fieldType: 'number', recommended: true },
    ]);
  });

  it('keeps a self-tracked Number Field eligible when the maximum reference is absent or invalid', () => {
    const self = numericField('hp', 'number', { maximumFieldKey: 'missingField', meaning: 'hit-points' });
    expect(forgeNumericResourceFields([self], { hp: 20 })).toEqual([
      { path: 'hp', label: 'HP', fieldType: 'number', recommended: true },
    ]);
  });

  it('offers Rating only when the resolved value is a real non-negative number', () => {
    const fields = [numericField('level', 'rating'), numericField('cr', 'rating'), numericField('title', 'rating')];
    expect(forgeNumericResourceFields(fields, { level: 3, cr: '1/4', title: 'Veteran' })).toEqual([
      { path: 'level', label: 'LEVEL', fieldType: 'rating' },
    ]);
  });

  it('does not offer negative or malformed numeric values as resource maxima', () => {
    const fields = [numericField('negative'), numericField('malformed')];
    expect(forgeNumericResourceFields(fields, { negative: -2, malformed: 'not a number' })).toEqual([]);
  });

  it('allows a scalar Text/Markdown field only when its unique meaning is hit-points and its value is a Resource quantity', () => {
    const hpText = plainField('hpText', 'text', { meaning: 'hit-points' });
    const prose = plainField('prose', 'markdown', { meaning: 'hit-points' });
    const unrelated = plainField('description', 'text');
    expect(forgeNumericResourceFields([hpText, prose, unrelated], {
      hpText: '12/27', prose: 'A tough creature', description: '20',
    })).toEqual([
      { path: 'hpText', label: 'HPTEXT', fieldType: 'text', recommended: true },
    ]);
  });

  it('excludes Scores, Counters, Checkboxes, Dice, Choice and collection-shaped Fields', () => {
    const fields = [
      plainField('scores', 'scores', { config: { kind: 'scores', columns: [{ label: 'STR', key: 'str' }] } }),
      plainField('counters', 'counters'),
      plainField('checks', 'checkboxes'),
      plainField('damage', 'dice'),
      plainField('choice', 'choice'),
      plainField('entries', 'entries'),
      plainField('pairs', 'pairs'),
    ];
    expect(forgeNumericResourceFields(fields, {
      scores: [[12]], counters: [{ name: 'Uses', max: 3, used: 0 }], checks: { active: true },
      damage: '2d6+1', choice: '12', entries: [{ cost: 2 }], pairs: { fire: 2 },
    })).toEqual([]);
  });

  it('excludes a formula whose configuration could not be read safely', () => {
    const field = numericField('formulaHp');
    const warnings: ForgeStatblockFieldExtractionWarning[] = [
      { fieldKey: 'formulaHp', code: 'invalid-config', property: 'formula' },
    ];
    expect(forgeNumericResourceFields([field], { formulaHp: 20 }, warnings)).toEqual([]);
  });

  it('excludes Number Fields with invalid tracking config because their current/maximum role is uncertain', () => {
    const field = numericField('currentHp', 'number', { meaning: 'hit-points' });
    const warnings: ForgeStatblockFieldExtractionWarning[] = [
      { fieldKey: 'currentHp', code: 'invalid-config', property: 'tracks' },
    ];
    expect(forgeNumericResourceFields([field], { currentHp: 8 }, warnings)).toEqual([]);
  });

  it('does not treat object-shaped malformed Text values as scalar Resource candidates', () => {
    const hpText = plainField('hpText', 'text', { meaning: 'hit-points' });
    expect(forgeNumericResourceFields([hpText], { hpText: { current: 12, max: 27 } })).toEqual([]);
  });
});

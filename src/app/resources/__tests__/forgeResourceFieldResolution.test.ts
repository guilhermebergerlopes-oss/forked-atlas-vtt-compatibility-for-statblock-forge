import { describe, expect, it } from 'vitest';
import {
  forgeResourceMeanings,
  resolveForgeResourceFieldPath,
  type ForgeResourceFieldSource,
} from '../forgeResourceFieldResolution';
import type { ForgeStatblockFieldDescriptor, ForgeStatblockFieldExtractionWarning } from '../../statblocks/notes/forgeStatblockFieldTypes';
import type { FieldMeanings } from '../../statblocks/resolve/fieldMeanings';

function numberField(
  key: string,
  options: {
    formerKeys?: string[];
    meaning?: 'hit-points';
    maximumFieldKey?: string;
    formula?: string;
  } = {},
): ForgeStatblockFieldDescriptor {
  return {
    index: 0,
    key,
    label: key,
    type: 'number',
    ...(options.meaning ? { semanticMeaning: options.meaning, atlasMeaning: options.meaning } : {}),
    formerKeys: options.formerKeys ?? [],
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

function source(
  fields: readonly ForgeStatblockFieldDescriptor[],
  warnings: readonly ForgeStatblockFieldExtractionWarning[] = [],
): ForgeResourceFieldSource {
  return { fieldDescriptors: fields, fieldExtractionWarnings: warnings };
}

const HP_MEANINGS: FieldMeanings = { 'hit-points': 'currentHp' };

describe('Forge Resource Field key and meaning resolution', () => {
  it('prefers a current Field key over another Field Former Key', () => {
    const forge = source([
      numberField('hp'),
      numberField('vitality', { formerKeys: ['hp'] }),
    ]);

    expect(resolveForgeResourceFieldPath('hp', { hp: 14, vitality: 8 }, forge)).toEqual({
      status: 'resolved', path: 'hp', via: 'current-key',
    });
  });

  it('resolves a unique Former Key case-insensitively and ignores separators', () => {
    const forge = source([numberField('maximumHp', { formerKeys: ['old_hp'] })]);

    expect(resolveForgeResourceFieldPath('OLD-HP', { maximumHp: 18 }, forge)).toEqual({
      status: 'resolved', path: 'maximumHp', via: 'former-key',
    });
  });

  it('resolves every key in a multi-rename history to the current Field', () => {
    const forge = source([numberField('essence', { formerKeys: ['focus', 'mana', 'energy'] })]);

    for (const former of ['focus', 'mana', 'energy']) {
      expect(resolveForgeResourceFieldPath(former, { essence: 18 }, forge)).toEqual({
        status: 'resolved', path: 'essence', via: 'former-key',
      });
    }
  });

  it('refuses a normalized Former Key collision between distinct old spellings', () => {
    const forge = source([
      numberField('primaryPower', { formerKeys: ['old_hp'] }),
      numberField('secondaryPower', { formerKeys: ['old-hp'] }),
    ]);

    expect(resolveForgeResourceFieldPath('old hp', { primaryPower: 10, secondaryPower: 20 }, forge)).toEqual({
      status: 'ambiguous',
      requestedPath: 'old hp',
      candidateKeys: ['primaryPower', 'secondaryPower'],
    });
  });

  it('refuses an ambiguous Former Key rather than choosing a Field', () => {
    const forge = source([
      numberField('health', { formerKeys: ['oldHp'] }),
      numberField('vitality', { formerKeys: ['oldHp'] }),
    ]);

    expect(resolveForgeResourceFieldPath('oldHp', { health: 12, vitality: 16 }, forge)).toEqual({
      status: 'ambiguous', requestedPath: 'oldHp', candidateKeys: ['health', 'vitality'],
    });
  });

  it('preserves a dotted suffix after resolving the root Field key', () => {
    const forge = source([numberField('attributes', { formerKeys: ['stats'] })]);

    expect(resolveForgeResourceFieldPath('stats.0', { attributes: [10] }, forge)).toEqual({
      status: 'resolved', path: 'attributes.0', via: 'former-key',
    });
  });

  it('redirects the hit-points meaning to the configured maximum Number Field', () => {
    const forge = source([
      numberField('currentHp', { meaning: 'hit-points', maximumFieldKey: 'maximumHp' }),
      numberField('maximumHp'),
    ]);
    const record = { currentHp: 8, maximumHp: 20 };

    expect(forgeResourceMeanings(HP_MEANINGS, record, forge)).toEqual({ 'hit-points': 'maximumHp' });
    expect(resolveForgeResourceFieldPath('currentHp', record, forge)).toEqual({
      status: 'resolved', path: 'maximumHp', via: 'forge-tracking-maximum',
    });
  });

  it('uses Forge fallback when tracks.max no longer names a current Number Field', () => {
    const forge = source([numberField('currentHp', { meaning: 'hit-points', maximumFieldKey: 'deletedMaximum' })]);

    expect(forgeResourceMeanings(HP_MEANINGS, { currentHp: 18 }, forge)).toEqual(HP_MEANINGS);
    expect(resolveForgeResourceFieldPath('currentHp', { currentHp: 18 }, forge)).toEqual({
      status: 'resolved', path: 'currentHp', via: 'current-key',
    });
  });

  it('does not resolve tracks.max through a Former Key', () => {
    const forge = source([
      numberField('currentHp', { meaning: 'hit-points', maximumFieldKey: 'oldMaximum' }),
      numberField('maximumHp', { formerKeys: ['oldMaximum'] }),
    ]);

    expect(forgeResourceMeanings(HP_MEANINGS, { currentHp: 8, maximumHp: 20 }, forge)).toEqual(HP_MEANINGS);
  });

  it('blocks an invalid tracking configuration', () => {
    const forge = source(
      [numberField('currentHp', { meaning: 'hit-points' })],
      [{ fieldKey: 'currentHp', code: 'invalid-config', property: 'tracks' }],
    );

    expect(resolveForgeResourceFieldPath('currentHp', { currentHp: 8 }, forge)).toEqual({
      status: 'unsupported', requestedPath: 'currentHp', fieldKey: 'currentHp', reason: 'invalid-tracking',
    });
    expect(forgeResourceMeanings(HP_MEANINGS, { currentHp: 8 }, forge)).toEqual({});
  });

  it('does not fall back to current HP when a configured maximum is formula-backed', () => {
    const forge = source([
      numberField('currentHp', { meaning: 'hit-points', maximumFieldKey: 'maximumHp' }),
      numberField('maximumHp', { formula: '@level * 5' }),
    ]);

    expect(resolveForgeResourceFieldPath('currentHp', { currentHp: 8, maximumHp: 20 }, forge)).toEqual({
      status: 'unsupported', requestedPath: 'currentHp', fieldKey: 'currentHp', reason: 'invalid-tracking-maximum',
    });
    expect(forgeResourceMeanings(HP_MEANINGS, { currentHp: 8, maximumHp: 20 }, forge)).toEqual({});
  });

  it('does not treat Checkboxes option aliases as scalar Field aliases', () => {
    const checkboxes: ForgeStatblockFieldDescriptor = {
      index: 0,
      key: 'conditions',
      label: 'Conditions',
      type: 'checkboxes',
      semanticMeaning: 'hit-points',
      atlasMeaning: 'hit-points',
      formerKeys: [],
      category: 'resources',
      pinnedImage: false,
      config: { kind: 'checkboxes', valid: true, options: [{ key: 'wounded', label: 'Wounded', aliases: ['hp'] }] },
    };
    const forge = source([checkboxes]);

    expect(resolveForgeResourceFieldPath('conditions', { conditions: { hp: true } }, forge)).toEqual({
      status: 'unsupported', requestedPath: 'conditions', fieldKey: 'conditions', reason: 'not-resource-compatible',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const linkedStatblock = readFileSync(new URL('../LinkedStatblock.tsx', import.meta.url), 'utf8');
const english = readFileSync(new URL('../../../i18n/locales/en/statblockEditor.ts', import.meta.url), 'utf8');
const russian = readFileSync(new URL('../../../i18n/locales/ru/statblockEditor.ts', import.meta.url), 'utf8');

describe('Forge-native statblock preview fallback', () => {
  it('does not ask users to create a second Atlas-native statblock', () => {
    expect(linkedStatblock).toContain("t('statblockEditor.forgeRendererUnavailable')");
    expect(english).toContain('no Atlas template is required');
    expect(russian).toContain('шаблон Atlas не требуется');
  });

  it('explains that the Forge renderer must be connected', () => {
    expect(english).toContain('Make sure Statblock Forge is enabled');
    expect(russian).toContain('Statblock Forge включён');
  });
});

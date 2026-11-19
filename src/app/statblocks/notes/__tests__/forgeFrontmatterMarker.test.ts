import { describe, expect, it } from 'vitest';
import { hasForgeFrontmatterMarkerInText } from '../statblockSource';

describe('hasForgeFrontmatterMarkerInText', () => {
  it('detects the Forge link marker in a valid frontmatter block', () => {
    expect(hasForgeFrontmatterMarkerInText('---\nstatblock-forge:\n  format: statblock-forge-template-link\n---\nBody')).toBe(true);
  });

  it('detects the marker even when its YAML value is malformed', () => {
    expect(hasForgeFrontmatterMarkerInText('---\nstatblock-forge: [broken\nstatblock: true\n---\nBody')).toBe(true);
  });

  it('does not treat a marker in the note body as frontmatter metadata', () => {
    expect(hasForgeFrontmatterMarkerInText('Body\nstatblock-forge: not metadata')).toBe(false);
  });

  it('does not treat a marker outside a closed frontmatter block as metadata', () => {
    expect(hasForgeFrontmatterMarkerInText('---\nstatblock-forge: [broken')).toBe(false);
  });
});

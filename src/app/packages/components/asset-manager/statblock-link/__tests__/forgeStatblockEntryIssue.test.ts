import { describe, expect, it } from 'vitest';
import { canLinkForgeStatblockEntryIssue, forgeStatblockEntryIssue } from '../forgeStatblockEntryIssue';
import type { ForgeResolvedStatblockResolutionResult } from '../../../../../statblocks/notes/forgeStatblockResolvedData';

const link = {
  format: 'statblock-forge-template-link' as const,
  version: 2 as const,
  templatePath: 'Templates/Goblin.forgetemplate',
  templateId: 'goblin-template',
};

const result = (value: unknown): ForgeResolvedStatblockResolutionResult => value as ForgeResolvedStatblockResolutionResult;

describe('Forge Asset Manager resolution diagnostics', () => {
  it('keeps a missing template distinguishable from a missing note', () => {
    expect(forgeStatblockEntryIssue(result({ status: 'template-resolution-failed', resolution: { status: 'missing', link } })))
      .toEqual({ kind: 'template-missing', expectedPath: link.templatePath, templateId: link.templateId });
  });

  it('lists every candidate when a stable template ID is ambiguous', () => {
    const candidates = ['Archive/Goblin.forgetemplate', 'Templates/Goblin Copy.forgetemplate'];
    expect(forgeStatblockEntryIssue(result({ status: 'template-resolution-failed', resolution: { status: 'ambiguous', link, candidates } })))
      .toEqual({ kind: 'template-ambiguous', candidates, templateId: link.templateId });
  });

  it('shows an invalid template reason without dropping its note', () => {
    expect(forgeStatblockEntryIssue(result({ status: 'invalid-template', path: link.templatePath, reason: 'unsupported-version' })))
      .toEqual({ kind: 'template-invalid', reason: 'unsupported-version', path: link.templatePath });
  });

  it('reports a uniquely recovered template path without rewriting the stored link', () => {
    expect(forgeStatblockEntryIssue(result({
      status: 'ready',
      data: { forge: { templatePathWasMoved: true, link, templatePath: 'New Folder/Goblin.forgetemplate', templateId: link.templateId } },
    }))).toEqual({
      kind: 'template-moved',
      from: link.templatePath,
      path: 'New Folder/Goblin.forgetemplate',
      templateId: link.templateId,
    });
  });

  it('does not add a warning to a valid template resolved at its saved path', () => {
    expect(forgeStatblockEntryIssue(result({ status: 'ready', data: { forge: { templatePathWasMoved: false } } }))).toBeNull();
  });

  it('distinguishes invalid note values from template read errors', () => {
    expect(forgeStatblockEntryIssue(result({ status: 'invalid-note-values', reason: 'duplicate-field-key' })))
      .toEqual({ kind: 'note-values-invalid', reason: 'duplicate-field-key' });
  });

  it('reports an invalid resolved statblock separately from the template file', () => {
    expect(forgeStatblockEntryIssue(result({ status: 'invalid-resolved-statblock', issues: ['invalid-meaning-map'] })))
      .toEqual({ kind: 'resolved-statblock-invalid', issues: ['invalid-meaning-map'] });
  });

  it('reports malformed Forge link metadata distinctly', () => {
    expect(forgeStatblockEntryIssue(result({ status: 'invalid-forge-link' }))).toEqual({ kind: 'invalid-link' });
  });
});

describe('Forge Asset Manager link safety', () => {
  it('allows a valid note and a uniquely recovered template', () => {
    expect(canLinkForgeStatblockEntryIssue(null)).toBe(true);
    expect(canLinkForgeStatblockEntryIssue({ kind: 'template-moved', from: 'Old.forgetemplate', path: 'New.forgetemplate', templateId: 'id' })).toBe(true);
  });

  it('blocks new links to missing, ambiguous, invalid, or malformed Forge sources', () => {
    expect(canLinkForgeStatblockEntryIssue({ kind: 'template-missing', expectedPath: 'Old.forgetemplate', templateId: 'id' })).toBe(false);
    expect(canLinkForgeStatblockEntryIssue({ kind: 'template-ambiguous', candidates: ['A.forgetemplate', 'B.forgetemplate'], templateId: 'id' })).toBe(false);
    expect(canLinkForgeStatblockEntryIssue({ kind: 'template-invalid', reason: 'unsupported-version' })).toBe(false);
    expect(canLinkForgeStatblockEntryIssue({ kind: 'note-values-invalid', reason: 'invalid-field-schema' })).toBe(false);
    expect(canLinkForgeStatblockEntryIssue({ kind: 'resolved-statblock-invalid', issues: ['invalid-meaning-map'] })).toBe(false);
    expect(canLinkForgeStatblockEntryIssue({ kind: 'invalid-link' })).toBe(false);
  });
});

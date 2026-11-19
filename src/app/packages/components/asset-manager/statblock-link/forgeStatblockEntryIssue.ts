import type { ForgeResolvedStatblockResolutionResult } from '../../../../statblocks/notes/forgeStatblockResolvedData';

/** A recoverable Forge condition shown in the Asset Manager instead of hiding the note. */
export type ForgeStatblockEntryIssue =
  | { kind: 'template-moved'; from: string; path: string; templateId: string }
  | { kind: 'template-missing'; expectedPath: string; templateId: string }
  | { kind: 'template-ambiguous'; candidates: readonly string[]; templateId: string }
  | { kind: 'template-invalid'; reason: string; templateId?: string; path?: string }
  | { kind: 'note-values-invalid'; reason: string }
  | { kind: 'resolved-statblock-invalid'; issues: readonly string[] }
  | { kind: 'invalid-link' };

/** Turn the Forge adapter's precise resolution result into a stable, UI-safe status. */
export function forgeStatblockEntryIssue(
  result: ForgeResolvedStatblockResolutionResult,
): ForgeStatblockEntryIssue | null {
  if (result.status === 'ready') {
    return result.data.forge.templatePathWasMoved
      ? {
        kind: 'template-moved',
        from: result.data.forge.link.templatePath,
        path: result.data.forge.templatePath,
        templateId: result.data.forge.templateId,
      }
      : null;
  }
  if (result.status === 'invalid-forge-link') return { kind: 'invalid-link' };
  if (result.status === 'template-resolution-failed') {
    const { resolution } = result;
    if (resolution.status === 'missing') {
      return {
        kind: 'template-missing',
        expectedPath: resolution.link.templatePath,
        templateId: resolution.link.templateId,
      };
    }
    if (resolution.status === 'ambiguous') {
      return {
        kind: 'template-ambiguous',
        candidates: resolution.candidates,
        templateId: resolution.link.templateId,
      };
    }
    return {
      kind: 'template-invalid',
      reason: resolution.reason,
      templateId: resolution.link.templateId,
      ...(resolution.path ? { path: resolution.path } : {}),
    };
  }
  if (result.status === 'invalid-template') {
    return { kind: 'template-invalid', reason: result.reason, path: result.path };
  }
  if (result.status === 'invalid-resolved-statblock') {
    return { kind: 'resolved-statblock-invalid', issues: result.issues };
  }
  if (result.status === 'invalid-note-values') {
    return { kind: 'note-values-invalid', reason: result.reason };
  }
  return null;
}

/** Only a template recovered uniquely by stable ID is safe to link without repair. */
export function canLinkForgeStatblockEntryIssue(issue: ForgeStatblockEntryIssue | null | undefined): boolean {
  return !issue || issue.kind === 'template-moved';
}

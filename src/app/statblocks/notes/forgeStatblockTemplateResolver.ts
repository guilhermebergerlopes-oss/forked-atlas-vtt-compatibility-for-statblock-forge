/** Resolve a Forge-native statblock link to its `.forgetemplate` source. */

import { TFile, type App } from 'obsidian';
import { isPlainRecord } from '../values/fieldValueOf';
import { MAX_FORGE_TEMPLATE_FILE_BYTES } from './forgeStatblockTemplateReader';
import {
  FORGE_STATBLOCK_LINK_FORMAT,
  FORGE_NATIVE_STATBLOCK_LINK_VERSION,
  normalizeForgeTemplatePath,
  type ForgeStatblockTemplateLink,
} from './forgeStatblockLink';

export type ForgeTemplateInspectionFailure =
  | 'invalid-json'
  | 'invalid-document'
  | 'unsupported-format'
  | 'missing-template-id'
  | 'read-failed'
  | 'too-large';

export type ForgeTemplateResolutionInvalidReason = ForgeTemplateInspectionFailure
  | 'invalid-link'
  | 'path-is-not-a-file'
  | 'wrong-extension'
  | 'template-id-mismatch';

export type ForgeStatblockTemplateResolution =
  | {
    status: 'found';
    file: TFile;
    link: ForgeStatblockTemplateLink;
    resolvedBy: 'path' | 'id';
    pathWasMoved: boolean;
  }
  | { status: 'missing'; link: ForgeStatblockTemplateLink }
  | { status: 'ambiguous'; link: ForgeStatblockTemplateLink; candidates: string[] }
  | {
    status: 'invalid';
    link: ForgeStatblockTemplateLink;
    reason: ForgeTemplateResolutionInvalidReason;
    path?: string;
  };

interface TemplateIdentity {
  id: string;
}

type TemplateInspection =
  | { valid: true; identity: TemplateIdentity }
  | { valid: false; reason: ForgeTemplateInspectionFailure };

/** Read only the stable identity needed at this stage; full template parsing belongs to 1.3. */
function inspectForgeTemplateIdentity(text: string): TemplateInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { valid: false, reason: 'invalid-json' };
  }

  if (!isPlainRecord(parsed)) return { valid: false, reason: 'invalid-document' };
  if (parsed.format !== 'atlas-statblock-template') return { valid: false, reason: 'unsupported-format' };
  if (typeof parsed.id !== 'string' || !parsed.id.trim()) return { valid: false, reason: 'missing-template-id' };
  return { valid: true, identity: { id: parsed.id.trim() } };
}

async function inspectTemplateFile(app: App, file: TFile): Promise<TemplateInspection> {
  if (file.extension.toLowerCase() !== 'forgetemplate') return { valid: false, reason: 'unsupported-format' };
  if (Number.isFinite(file.stat?.size) && file.stat.size > MAX_FORGE_TEMPLATE_FILE_BYTES) {
    return { valid: false, reason: 'too-large' };
  }
  try {
    return inspectForgeTemplateIdentity(await app.vault.cachedRead(file));
  } catch {
    return { valid: false, reason: 'read-failed' };
  }
}

/** Resolve by the recorded path first, then recover a moved template by its stable ID. */
export async function resolveForgeStatblockTemplate(
  app: App,
  link: ForgeStatblockTemplateLink,
): Promise<ForgeStatblockTemplateResolution> {
  const path = typeof link.templatePath === 'string' ? normalizeForgeTemplatePath(link.templatePath) : null;
  const templateId = typeof link.templateId === 'string' ? link.templateId.trim() : '';
  if (link.format !== FORGE_STATBLOCK_LINK_FORMAT
    || link.version !== FORGE_NATIVE_STATBLOCK_LINK_VERSION
    || !path || !templateId) {
    return { status: 'invalid', link, reason: 'invalid-link' };
  }

  const requestedFile = app.vault.getAbstractFileByPath(path);
  let requestedPathFailure: Exclude<ForgeTemplateResolutionInvalidReason, 'invalid-link'> | undefined;
  const inspections = new Map<string, Promise<TemplateInspection>>();
  const inspect = (file: TFile): Promise<TemplateInspection> => {
    const existing = inspections.get(file.path);
    if (existing) return existing;
    const reading = inspectTemplateFile(app, file);
    inspections.set(file.path, reading);
    return reading;
  };

  if (requestedFile) {
    if (!(requestedFile instanceof TFile)) {
      requestedPathFailure = 'path-is-not-a-file';
    } else if (requestedFile.extension.toLowerCase() !== 'forgetemplate') {
      requestedPathFailure = 'wrong-extension';
    } else {
      const result = await inspect(requestedFile);
      if (!result.valid) requestedPathFailure = result.reason;
      else if (result.identity.id === templateId) {
        return { status: 'found', file: requestedFile, link, resolvedBy: 'path', pathWasMoved: false };
      } else {
        requestedPathFailure = 'template-id-mismatch';
      }
    }
  }

  const candidates = app.vault.getFiles().filter((candidate) => candidate.extension.toLowerCase() === 'forgetemplate'
    && !(requestedFile instanceof TFile && candidate.path === requestedFile.path));
  const results = await Promise.all(candidates.map(async (candidate) => ({ file: candidate, result: await inspect(candidate) })));
  const matches = results.filter(({ result }) => result.valid && result.identity.id === templateId).map(({ file }) => file);

  if (matches.length === 1) {
    return { status: 'found', file: matches[0]!, link, resolvedBy: 'id', pathWasMoved: true };
  }
  if (matches.length > 1) {
    return { status: 'ambiguous', link, candidates: matches.map((file) => file.path).sort((a, b) => a.localeCompare(b)) };
  }
  if (requestedPathFailure) {
    return { status: 'invalid', link, reason: requestedPathFailure, path };
  }
  return { status: 'missing', link };
}

/** Assemble Forge note values and Field metadata into the Atlas ResolvedStatblock data shape. */

import type { App } from 'obsidian';
import type { ResolvedStatblock } from '../model/resolvedTypes';
import { isPlainRecord } from '../values/fieldValueOf';
import { extractForgeStatblockFields } from './forgeStatblockFieldExtractor';
import type {
  ForgeStatblockFieldDescriptor,
  ForgeStatblockFieldExtractionWarning,
} from './forgeStatblockFieldTypes';
import type { ForgeStatblockFieldValueConversionWarning } from './forgeStatblockFieldValueConverter';
import {
  FORGE_STATBLOCK_LINK_FORMAT,
  FORGE_NATIVE_STATBLOCK_LINK_VERSION,
  normalizeForgeTemplatePath,
  type ForgeStatblockTemplateLink,
  forgeStatblockLinkFromFrontmatter,
  FORGE_STATBLOCK_LINK_KEY,
} from './forgeStatblockLink';
import {
  type ForgeStatblockNoteValueMapping,
  type ForgeStatblockNoteValueMappingFailure,
  mapForgeStatblockNoteValues,
} from './forgeStatblockNoteValues';
import {
  readForgeStatblockTemplate,
  FORGE_TEMPLATE_FORMAT,
  FORGE_TEMPLATE_VERSION,
  type ForgeLayoutReadResult,
  type ForgeStatblockTemplateDocument,
  type ForgeTemplateReadFailure,
} from './forgeStatblockTemplateReader';
import {
  resolveForgeStatblockTemplate,
  type ForgeStatblockTemplateResolution,
} from './forgeStatblockTemplateResolver';

/**
 * Forge-owned templates deliberately have no Atlas TemplateLayout. The Forge renderer remains
 * authoritative, so this is the data portion of ResolvedStatblock; Step 1.6 adds the Forge source
 * discriminator to ResolvedStatblock and attaches it at the global resolver boundary.
 */
export type ForgeResolvedStatblockShape = Omit<ResolvedStatblock, 'source'>;

export interface ForgeResolvedStatblockDiagnostics {
  missingFieldKeys: readonly string[];
  /** Actual note keys used after Former Keys fallback. */
  sourceKeys: Readonly<Record<string, string>>;
  /** Fields with multiple populated current/former keys; the current key remains authoritative. */
  ambiguousFieldKeys: readonly string[];
  fieldExtractionWarnings: readonly ForgeStatblockFieldExtractionWarning[];
  fieldValueWarnings: readonly ForgeStatblockFieldValueConversionWarning[];
  templateWarnings: readonly string[];
}

export interface ForgeResolvedStatblockData {
  /** Atlas-compatible ResolvedStatblock fields, meanings, path and template ownership metadata. */
  statblock: ForgeResolvedStatblockShape;
  /** Forge remains the source of truth for this template and its rendering metadata. */
  forge: {
    link: ForgeStatblockTemplateLink;
    templateId: string;
    templatePath: string;
    templateResolvedBy: 'path' | 'id';
    templatePathWasMoved: boolean;
    template: ForgeStatblockTemplateDocument;
    layout: ForgeLayoutReadResult;
    fieldDescriptors: readonly ForgeStatblockFieldDescriptor[];
  };
  diagnostics: ForgeResolvedStatblockDiagnostics;
}

export type ForgeResolvedStatblockValidationIssue =
  | 'invalid-note-path'
  | 'invalid-template-identity'
  | 'invalid-template-format'
  | 'invalid-template-version'
  | 'invalid-template-resolution'
  | 'invalid-template-name'
  | 'invalid-field-descriptors'
  | 'invalid-resolved-fields'
  | 'invalid-meaning-map'
  | 'invalid-value-diagnostics'
  | 'unexpected-atlas-source';

export type ForgeResolvedStatblockBuildResult =
  | { status: 'ready'; data: ForgeResolvedStatblockData }
  | { status: 'invalid-note-values'; reason: ForgeStatblockNoteValueMappingFailure }
  | { status: 'invalid-resolved-statblock'; issues: readonly ForgeResolvedStatblockValidationIssue[] };

export type ForgeResolvedStatblockResolutionResult =
  | ForgeResolvedStatblockBuildResult
  | { status: 'not-forge-note' }
  | { status: 'invalid-forge-link' }
  | {
    status: 'template-resolution-failed';
    resolution: Exclude<ForgeStatblockTemplateResolution, { status: 'found' }>;
  }
  | { status: 'invalid-template'; path: string; reason: ForgeTemplateReadFailure };

export interface BuildForgeResolvedStatblockInput {
  /** Vault-relative path of the Markdown statblock note. */
  path: string;
  /** Basename of the resolved .forgetemplate file, used for Atlas' template facet. */
  templateName: string;
  /** Actual resolved template file path (may differ from the path in the note link after a move). */
  templatePath: string;
  templateResolvedBy: 'path' | 'id';
  templatePathWasMoved: boolean;
  link: ForgeStatblockTemplateLink;
  template: ForgeStatblockTemplateDocument;
  layout: ForgeLayoutReadResult;
  frontmatter: unknown;
  templateWarnings?: readonly string[];
}

function fallbackNameFromPath(path: string): string {
  const basename = path.replace(/\\/g, '/').split('/').pop() ?? path;
  return basename.replace(/\.md$/i, '').trim() || path;
}

function resolvedName(fields: Readonly<Record<string, unknown>>, path: string): string {
  const value = fields.name;
  return typeof value === 'string' && value.trim() ? value : fallbackNameFromPath(path);
}

/**
 * Validate the shape before any downstream consumer receives it. Warnings about malformed individual
 * values stay advisory; structural mismatches make the adapter result invalid.
 */
export function validateForgeResolvedStatblockData(
  data: ForgeResolvedStatblockData,
): readonly ForgeResolvedStatblockValidationIssue[] {
  const issues: ForgeResolvedStatblockValidationIssue[] = [];
  const statblock = data.statblock as ForgeResolvedStatblockShape & Record<string, unknown>;
  const { forge, diagnostics } = data;
  const descriptors = Array.isArray(forge.fieldDescriptors) ? forge.fieldDescriptors : [];
  const templateRecord = isPlainRecord(forge.template) ? forge.template : null;
  const linkRecord = isPlainRecord(forge.link) ? forge.link : null;

  if (typeof statblock.path !== 'string' || !statblock.path.trim() || statblock.path.length > 1024) {
    issues.push('invalid-note-path');
  }
  if (templateRecord?.format !== FORGE_TEMPLATE_FORMAT) issues.push('invalid-template-format');
  if (templateRecord?.version !== FORGE_TEMPLATE_VERSION) issues.push('invalid-template-version');
  if (forge.templateResolvedBy !== 'path' && forge.templateResolvedBy !== 'id') {
    issues.push('invalid-template-resolution');
  }
  if (typeof forge.templatePathWasMoved !== 'boolean'
    || (forge.templateResolvedBy === 'path' && forge.templatePathWasMoved)
    || (forge.templateResolvedBy === 'id' && !forge.templatePathWasMoved)) {
    issues.push('invalid-template-resolution');
  }
  if (!templateRecord || !Array.isArray(templateRecord.fields)) issues.push('invalid-field-descriptors');

  const linkedTemplatePath = linkRecord && typeof linkRecord.templatePath === 'string'
    ? normalizeForgeTemplatePath(linkRecord.templatePath) : null;
  const linkedTemplateId = linkRecord && typeof linkRecord.templateId === 'string'
    ? linkRecord.templateId : null;
  if (!linkRecord || linkRecord.format !== FORGE_STATBLOCK_LINK_FORMAT
    || linkRecord.version !== FORGE_NATIVE_STATBLOCK_LINK_VERSION
    || !linkedTemplatePath || !linkedTemplateId
    || linkedTemplateId !== forge.templateId || templateRecord?.id !== forge.templateId
    || linkedTemplateId.trim() !== linkedTemplateId
    || typeof forge.templatePath !== 'string'
    || normalizeForgeTemplatePath(forge.templatePath) !== forge.templatePath) {
    issues.push('invalid-template-identity');
  }
  if (typeof statblock.lookName !== 'string' || !statblock.lookName.trim()) issues.push('invalid-template-name');
  const templateFields = templateRecord && Array.isArray(templateRecord.fields)
    ? templateRecord.fields as ForgeStatblockTemplateDocument['fields'] : [];
  if (!Array.isArray(forge.fieldDescriptors) || descriptors.length !== templateFields.length) {
    issues.push('invalid-field-descriptors');
  } else {
    const currentKeys = new Set<string>();
    const stableIds = new Set<string>();
    for (const [index, field] of descriptors.entries()) {
      if (!field || typeof field.key !== 'string' || !field.key.trim()
        || field.key !== templateFields[index]?.key
        || field.label !== templateFields[index]?.label
        || field.type !== templateFields[index]?.type
        || field.index !== index
        || currentKeys.has(field.key.toLowerCase())) {
        issues.push('invalid-field-descriptors');
        break;
      }
      currentKeys.add(field.key.toLowerCase());
      if (field.stableId) {
        if (stableIds.has(field.stableId)) {
          issues.push('invalid-field-descriptors');
          break;
        }
        stableIds.add(field.stableId);
      }
    }
  }

  const resolvedFieldsValid = isPlainRecord(statblock.fields)
    && typeof statblock.fields.name === 'string' && Boolean(statblock.fields.name.trim());
  if (!resolvedFieldsValid) {
    issues.push('invalid-resolved-fields');
  } else {
    const descriptorKeys = new Set(descriptors.filter((field) => field && typeof field.key === 'string').map((field) => field.key));
    // `name` is also the identity fallback used by Atlas when a Forge template has no Name Field.
    for (const key of Object.keys(statblock.fields)) {
      if (!descriptorKeys.has(key) && key !== 'name') {
        issues.push('invalid-resolved-fields');
        break;
      }
    }
  }

  if (statblock.template !== null || statblock.templateStatus !== null || 'source' in statblock) {
    // Forge owns the renderer, and this pre-1.6 adapter must not counterfeit an Atlas/FS source.
    issues.push('unexpected-atlas-source');
  }

  if (!isPlainRecord(statblock.meanings)) {
    issues.push('invalid-meaning-map');
  } else {
    const fieldsByKey = new Map(descriptors.filter((field) => field && typeof field.key === 'string').map((field) => [field.key, field]));
    for (const [meaning, key] of Object.entries(statblock.meanings)) {
      const descriptor = typeof key === 'string' ? fieldsByKey.get(key) : undefined;
      if (!descriptor || descriptor.atlasMeaning !== meaning) {
        issues.push('invalid-meaning-map');
        break;
      }
    }
  }

  const sourceKeys = isPlainRecord(diagnostics.sourceKeys) ? diagnostics.sourceKeys : {};
  const present = new Set(Object.keys(sourceKeys));
  const missing = new Set(diagnostics.missingFieldKeys);
  const ambiguous = new Set(diagnostics.ambiguousFieldKeys);
  const sourceMapValid = Object.entries(sourceKeys).every(([key, sourceKey]) =>
    descriptors.some((field) => field.key === key) && typeof sourceKey === 'string' && sourceKey.length > 0);
  const missingKeysValid = diagnostics.missingFieldKeys.every((key) => descriptors.some((field) => field.key === key))
    && missing.size === diagnostics.missingFieldKeys.length;
  const ambiguousKeysValid = diagnostics.ambiguousFieldKeys.every((key) => present.has(key))
    && ambiguous.size === diagnostics.ambiguousFieldKeys.length;
  const presentValuesRetained = resolvedFieldsValid
    && [...present].every((key) => Object.hasOwn(statblock.fields, key));
  if (!sourceMapValid || !missingKeysValid || !ambiguousKeysValid
    || present.size + missing.size !== descriptors.length
    || descriptors.some((field) => present.has(field.key) === missing.has(field.key))
    || !presentValuesRetained
    || !Array.isArray(diagnostics.fieldExtractionWarnings)
    || !Array.isArray(diagnostics.fieldValueWarnings)
    || !Array.isArray(diagnostics.templateWarnings)) {
    issues.push('invalid-value-diagnostics');
  }

  return [...new Set(issues)];
}

/**
 * Pure 1.5.7 adapter. It assembles the values and metadata already interpreted by 1.5.1–1.5.6 into
 * the ResolvedStatblock data contract without manufacturing an Atlas template or a fake source.
 */
export function buildForgeResolvedStatblockData(
  input: BuildForgeResolvedStatblockInput,
): ForgeResolvedStatblockBuildResult {
  const extraction = extractForgeStatblockFields(input.template, input.layout);
  const mapped = mapForgeStatblockNoteValues(input.frontmatter, extraction.fields);
  if (mapped.status !== 'ready') return { status: 'invalid-note-values', reason: mapped.reason };

  const mapping: ForgeStatblockNoteValueMapping = mapped.mapping;
  const fields: Record<string, unknown> = { ...mapping.values };
  fields.name = resolvedName(fields, input.path);

  const statblock: ForgeResolvedStatblockShape = {
    path: input.path,
    fields,
    template: null,
    templateStatus: null,
    lookName: input.templateName,
    meanings: extraction.meanings,
  };
  const data: ForgeResolvedStatblockData = {
    statblock,
    forge: {
      link: input.link,
      templateId: input.template.id,
      templatePath: input.templatePath,
      templateResolvedBy: input.templateResolvedBy,
      templatePathWasMoved: input.templatePathWasMoved,
      template: input.template,
      layout: input.layout,
      fieldDescriptors: extraction.fields,
    },
    diagnostics: {
      missingFieldKeys: mapping.missingKeys,
      sourceKeys: mapping.sourceKeys,
      ambiguousFieldKeys: mapping.ambiguousKeys,
      fieldExtractionWarnings: extraction.warnings,
      fieldValueWarnings: mapping.conversionWarnings,
      templateWarnings: [...(input.templateWarnings ?? [])],
    },
  };
  const issues = validateForgeResolvedStatblockData(data);
  return issues.length > 0 ? { status: 'invalid-resolved-statblock', issues } : { status: 'ready', data };
}

/**
 * Full read-only 1.5.7 pipeline: link → resolved template file → validated template → extracted Fields
 * → Former Keys/aliases and type conversions → ResolvedStatblock data shape.
 */
export async function resolveForgeStatblockData(
  app: App,
  path: string,
  frontmatter: unknown,
): Promise<ForgeResolvedStatblockResolutionResult> {
  const link = forgeStatblockLinkFromFrontmatter(frontmatter);
  if (!link) {
    return isPlainRecord(frontmatter) && Object.hasOwn(frontmatter, FORGE_STATBLOCK_LINK_KEY)
      && frontmatter['atlas-template'] === undefined
      ? { status: 'invalid-forge-link' }
      : { status: 'not-forge-note' };
  }

  const resolution = await resolveForgeStatblockTemplate(app, link);
  if (resolution.status !== 'found') return { status: 'template-resolution-failed', resolution };

  const read = await readForgeStatblockTemplate(app, resolution.file, link);
  if (read.status !== 'ready') {
    return { status: 'invalid-template', path: resolution.file.path, reason: read.reason };
  }

  const built = buildForgeResolvedStatblockData({
    path,
    templateName: resolution.file.basename,
    templatePath: resolution.file.path,
    templateResolvedBy: resolution.resolvedBy,
    templatePathWasMoved: resolution.pathWasMoved,
    link,
    template: read.template,
    layout: read.forgeLayout,
    frontmatter,
    templateWarnings: read.warnings,
  });
  return built;
}

/** Read and validate a Forge-native `.forgetemplate` without modifying it. */

import type { App, TFile } from 'obsidian';
import { isPlainRecord } from '../values/fieldValueOf';
import type { ForgeStatblockTemplateLink } from './forgeStatblockLink';

export const FORGE_TEMPLATE_FORMAT = 'atlas-statblock-template';
export const FORGE_TEMPLATE_VERSION = 1;
export const FORGE_TEMPLATE_METADATA_KEY = 'statblockForge';
export const FORGE_TEMPLATE_METADATA_FORMAT = 'statblock-forge-metadata';
export const FORGE_TEMPLATE_METADATA_VERSION = 1;
export const FORGE_LAYOUT_FORMAT = 'statblock-forge-layout';
export const FORGE_LAYOUT_VERSION = 1;

/** A source template may include a sizeable Compendium, but must remain bounded before parsing. */
export const MAX_FORGE_TEMPLATE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_JSON_DEPTH = 100;
const MAX_JSON_NODES = 500_000;
const MAX_BLOCK_DEPTH = 64;
const FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const RESERVED_FIELD_KEYS = new Set([
  'tags', 'statblock-forge', '__forgeconditions', '__forgeconditionvalues', '__proto__', 'prototype', 'constructor',
]);
const FORGE_FIELD_TYPES = new Set([
  'text', 'markdown', 'number', 'rating', 'dice', 'choice', 'list', 'scores',
  'entries', 'pairs', 'image', 'spells', 'counters', 'checkboxes',
]);

export interface ForgeStatblockTemplateField extends Record<string, unknown> {
  key: string;
  label: string;
  type: string;
}

export interface ForgeStatblockTemplateBlock extends Record<string, unknown> {
  id: string;
  type: string;
}

export interface ForgeStatblockTemplateDocument extends Record<string, unknown> {
  format: typeof FORGE_TEMPLATE_FORMAT;
  version: typeof FORGE_TEMPLATE_VERSION;
  id: string;
  fields: ForgeStatblockTemplateField[];
  layout: Record<string, unknown> & { blocks: ForgeStatblockTemplateBlock[] };
}

export type ForgeLayoutReadResult =
  | { status: 'available'; document: Record<string, unknown> }
  | { status: 'missing' }
  | { status: 'unsupported-version'; version: number }
  | { status: 'invalid'; reason: 'invalid-metadata' | 'invalid-layout' | 'template-id-mismatch' };

export type ForgeTemplateReadFailure =
  | 'wrong-extension'
  | 'too-large'
  | 'invalid-json'
  | 'invalid-document'
  | 'unsupported-format'
  | 'unsupported-template-version'
  | 'missing-template-id'
  | 'template-id-mismatch'
  | 'invalid-fields'
  | 'unsupported-field-type'
  | 'duplicate-field-key'
  | 'invalid-layout'
  | 'invalid-block-tree'
  | 'duplicate-block-id'
  | 'too-deep'
  | 'too-complex'
  | 'read-failed';

export type ForgeStatblockTemplateReadResult =
  | {
    status: 'ready';
    file: TFile;
    template: ForgeStatblockTemplateDocument;
    forgeLayout: ForgeLayoutReadResult;
    warnings: string[];
  }
  | { status: 'invalid'; file: TFile; reason: ForgeTemplateReadFailure };

interface JsonBudgetResult {
  valid: boolean;
  reason?: 'too-deep' | 'too-complex';
}

/** Iterative budget check: hostile nesting cannot recurse this validator's call stack. */
function checkJsonBudget(root: unknown): JsonBudgetResult {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) return { valid: false, reason: 'too-complex' };
    if (current.depth > MAX_JSON_DEPTH) return { valid: false, reason: 'too-deep' };
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
    } else if (isPlainRecord(current.value)) {
      for (const item of Object.values(current.value)) pending.push({ value: item, depth: current.depth + 1 });
    }
  }
  return { valid: true };
}

function validFieldList(value: unknown): ForgeStatblockTemplateField[] | ForgeTemplateReadFailure {
  if (!Array.isArray(value)) return 'invalid-fields';
  const identities = new Set<string>();
  for (const rawField of value) {
    if (!isPlainRecord(rawField)
      || typeof rawField.key !== 'string'
      || typeof rawField.label !== 'string'
      || typeof rawField.type !== 'string'
      || !FIELD_KEY_PATTERN.test(rawField.key)) return 'invalid-fields';

    const normalizedKey = rawField.key.toLowerCase();
    if (RESERVED_FIELD_KEYS.has(normalizedKey)) return 'invalid-fields';
    if (identities.has(normalizedKey)) return 'duplicate-field-key';
    identities.add(normalizedKey);

    if (!FORGE_FIELD_TYPES.has(rawField.type)) return 'unsupported-field-type';
    if (rawField.formerKeys !== undefined) {
      if (!Array.isArray(rawField.formerKeys)
        || !rawField.formerKeys.every((former): former is string => typeof former === 'string' && FIELD_KEY_PATTERN.test(former))) {
        return 'invalid-fields';
      }
      for (const former of rawField.formerKeys) {
        const normalizedFormer = former.toLowerCase();
        if (RESERVED_FIELD_KEYS.has(normalizedFormer) || identities.has(normalizedFormer)) return 'duplicate-field-key';
        identities.add(normalizedFormer);
      }
    }
  }
  return value as ForgeStatblockTemplateField[];
}

function validBlockTree(value: unknown): ForgeStatblockTemplateBlock[] | ForgeTemplateReadFailure {
  if (!Array.isArray(value)) return 'invalid-layout';
  const pending: Array<{ blocks: unknown[]; depth: number }> = [{ blocks: value, depth: 0 }];
  const ids = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    if (current.depth > MAX_BLOCK_DEPTH) return 'too-deep';
    for (const rawBlock of current.blocks) {
      if (!isPlainRecord(rawBlock) || typeof rawBlock.id !== 'string' || !rawBlock.id.trim()
        || typeof rawBlock.type !== 'string' || !rawBlock.type.trim()) return 'invalid-block-tree';
      if (ids.has(rawBlock.id)) return 'duplicate-block-id';
      ids.add(rawBlock.id);
      if (rawBlock.blocks !== undefined) {
        if (!Array.isArray(rawBlock.blocks)) return 'invalid-block-tree';
        pending.push({ blocks: rawBlock.blocks, depth: current.depth + 1 });
      }
    }
  }
  return value as ForgeStatblockTemplateBlock[];
}

function readForgeLayout(rawTemplate: Record<string, unknown>, templateId: string): ForgeLayoutReadResult {
  const metadata = rawTemplate[FORGE_TEMPLATE_METADATA_KEY];
  if (metadata === undefined) return { status: 'missing' };
  if (!isPlainRecord(metadata) || metadata.format !== FORGE_TEMPLATE_METADATA_FORMAT
    || typeof metadata.version !== 'number' || !Number.isSafeInteger(metadata.version) || !isPlainRecord(metadata.layout)) {
    return { status: 'invalid', reason: 'invalid-metadata' };
  }
  if (metadata.version !== FORGE_TEMPLATE_METADATA_VERSION) {
    return { status: 'unsupported-version', version: metadata.version };
  }
  const layout = metadata.layout;
  if (layout.format !== FORGE_LAYOUT_FORMAT || !Number.isSafeInteger(layout.version) || !isPlainRecord(layout.blocks)) {
    return { status: 'invalid', reason: 'invalid-layout' };
  }
  if (layout.version !== FORGE_LAYOUT_VERSION) {
    return { status: 'unsupported-version', version: layout.version as number };
  }
  if (layout.templateId !== templateId) return { status: 'invalid', reason: 'template-id-mismatch' };
  return { status: 'available', document: layout };
}

/** Pure parser for the root Atlas template and Forge-owned sidecar metadata. */
export function parseForgeStatblockTemplateText(
  text: string,
  expectedTemplateId?: string,
): Omit<Extract<ForgeStatblockTemplateReadResult, { status: 'ready' }>, 'file'> | { status: 'invalid'; reason: ForgeTemplateReadFailure } {
  if (new TextEncoder().encode(text).byteLength > MAX_FORGE_TEMPLATE_FILE_BYTES) {
    return { status: 'invalid', reason: 'too-large' };
  }

  let parsed: unknown;
  try {
    const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    parsed = JSON.parse(source) as unknown;
  } catch {
    return { status: 'invalid', reason: 'invalid-json' };
  }

  const budget = checkJsonBudget(parsed);
  if (!budget.valid) return { status: 'invalid', reason: budget.reason ?? 'too-complex' };
  if (!isPlainRecord(parsed)) return { status: 'invalid', reason: 'invalid-document' };
  if (parsed.format !== FORGE_TEMPLATE_FORMAT) return { status: 'invalid', reason: 'unsupported-format' };
  if (parsed.version !== FORGE_TEMPLATE_VERSION) return { status: 'invalid', reason: 'unsupported-template-version' };
  if (typeof parsed.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{6}$/.test(parsed.id)) {
    return { status: 'invalid', reason: 'missing-template-id' };
  }
  if (expectedTemplateId !== undefined && parsed.id !== expectedTemplateId) {
    return { status: 'invalid', reason: 'template-id-mismatch' };
  }

  const fields = validFieldList(parsed.fields);
  if (!Array.isArray(fields)) return { status: 'invalid', reason: fields };
  if (!isPlainRecord(parsed.layout)) return { status: 'invalid', reason: 'invalid-layout' };
  const blocks = validBlockTree(parsed.layout.blocks);
  if (!Array.isArray(blocks)) return { status: 'invalid', reason: blocks };

  const template = parsed as unknown as ForgeStatblockTemplateDocument;
  const forgeLayout = readForgeLayout(parsed, template.id);
  const warnings: string[] = [];
  if (forgeLayout.status === 'missing') warnings.push('Forge layout metadata is missing; native field data remains readable, but the original Forge appearance is unavailable.');
  else if (forgeLayout.status === 'unsupported-version') warnings.push(`Forge layout metadata version ${forgeLayout.version} is not supported by this Atlas integration.`);
  else if (forgeLayout.status === 'invalid') warnings.push(`Forge layout metadata is unavailable (${forgeLayout.reason}).`);

  return { status: 'ready', template, forgeLayout, warnings };
}

/** Read and validate a resolved `.forgetemplate`; this function is read-only. */
export async function readForgeStatblockTemplate(
  app: App,
  file: TFile,
  link?: Pick<ForgeStatblockTemplateLink, 'templateId'>,
): Promise<ForgeStatblockTemplateReadResult> {
  if (file.extension.toLowerCase() !== 'forgetemplate') return { status: 'invalid', file, reason: 'wrong-extension' };
  if (Number.isFinite(file.stat?.size) && file.stat.size > MAX_FORGE_TEMPLATE_FILE_BYTES) {
    return { status: 'invalid', file, reason: 'too-large' };
  }
  let text: string;
  try {
    text = await app.vault.cachedRead(file);
  } catch {
    return { status: 'invalid', file, reason: 'read-failed' };
  }
  const parsed = parseForgeStatblockTemplateText(text, link?.templateId);
  return { ...parsed, file };
}

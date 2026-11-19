/** Extract a safe, normalized view of Forge Field definitions for Atlas adapters. */

import type {
  ForgeLayoutReadResult,
  ForgeStatblockTemplateDocument,
  ForgeStatblockTemplateField,
} from './forgeStatblockTemplateReader';
import { readForgeFieldConfig } from './forgeStatblockFieldConfigReader';
import { atlasMeaningForForgeMeaning, mapForgeStatblockFieldMeanings } from './forgeStatblockFieldMeanings';
import {
  FIELD_MEANINGS,
  forgeStatblockFieldCategory,
  type ForgeStatblockFieldDescriptor,
  type ForgeStatblockFieldExtraction,
  type ForgeStatblockFieldMeaning,
} from './forgeStatblockFieldTypes';

function fieldDescriptor(
  field: ForgeStatblockTemplateField,
  index: number,
  forgeLayout: ForgeLayoutReadResult | undefined,
  warnings: ForgeStatblockFieldExtraction['warnings'],
): Omit<ForgeStatblockFieldDescriptor, 'semanticMeaning' | 'stableId'> & { recognizedMeaning?: ForgeStatblockFieldMeaning; candidateStableId?: string } {
  const rawMeaning = typeof field.meaning === 'string' && field.meaning.length <= 80 ? field.meaning : undefined;
  const recognizedMeaning = rawMeaning && FIELD_MEANINGS.has(rawMeaning as ForgeStatblockFieldMeaning)
    ? rawMeaning as ForgeStatblockFieldMeaning : undefined;
  if (rawMeaning && !recognizedMeaning) warnings.push({ fieldKey: field.key, code: 'unknown-meaning', property: 'meaning' });
  if (field.meaning !== undefined && rawMeaning === undefined) warnings.push({ fieldKey: field.key, code: 'invalid-config', property: 'meaning' });

  const formerKeys = Array.isArray(field.formerKeys)
    ? [...new Set(field.formerKeys.filter((key): key is string => typeof key === 'string'))]
    : [];
  const layoutDocument = forgeLayout?.status === 'available' ? forgeLayout.document : undefined;
  const fieldIds = layoutDocument && typeof layoutDocument.fieldIds === 'object' && layoutDocument.fieldIds !== null
    && !Array.isArray(layoutDocument.fieldIds) ? layoutDocument.fieldIds as Record<string, unknown> : undefined;
  const stableIdCandidate = fieldIds ? [field.key, ...formerKeys]
    .map((key) => fieldIds[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 100)?.trim() : undefined;
  const pinnedImageFields = layoutDocument?.pinnedImageFields;
  const pinnedImage = field.type === 'image' && field.key !== 'image' && Array.isArray(pinnedImageFields)
    && [field.key, ...formerKeys].some((key) => pinnedImageFields.includes(key));
  return {
    index,
    ...(stableIdCandidate ? { candidateStableId: stableIdCandidate } : {}),
    key: field.key,
    label: field.label,
    type: field.type as ForgeStatblockFieldDescriptor['type'],
    ...(rawMeaning ? { meaning: rawMeaning } : {}),
    ...(recognizedMeaning ? { recognizedMeaning } : {}),
    formerKeys,
    category: forgeStatblockFieldCategory(field.type as ForgeStatblockFieldDescriptor['type'], field.key, forgeLayout),
    pinnedImage,
    config: readForgeFieldConfig(field, warnings),
  };
}

/** Extracts stable Field metadata/configuration without reading sample or statblock instance values. */
export function extractForgeStatblockFields(
  template: ForgeStatblockTemplateDocument,
  forgeLayout?: ForgeLayoutReadResult,
): ForgeStatblockFieldExtraction {
  const warnings: ForgeStatblockFieldExtraction['warnings'] = [];
  const descriptors = template.fields.map((field, index) => fieldDescriptor(field, index, forgeLayout, warnings));
  const meaningCounts = new Map<ForgeStatblockFieldMeaning, number>();
  for (const field of descriptors) {
    if (!field.recognizedMeaning) continue;
    meaningCounts.set(field.recognizedMeaning, (meaningCounts.get(field.recognizedMeaning) ?? 0) + 1);
  }
  const stableIdCounts = new Map<string, number>();
  for (const field of descriptors) {
    if (!field.candidateStableId) continue;
    stableIdCounts.set(field.candidateStableId, (stableIdCounts.get(field.candidateStableId) ?? 0) + 1);
  }
  const fields = descriptors.map(({ recognizedMeaning, candidateStableId, ...field }): ForgeStatblockFieldDescriptor => {
    const stableIdIsUnique = candidateStableId !== undefined && stableIdCounts.get(candidateStableId) === 1;
    if (candidateStableId && !stableIdIsUnique) {
      warnings.push({ fieldKey: field.key, code: 'duplicate-field-id', property: 'fieldIds' });
    }
    const stableId = stableIdIsUnique ? candidateStableId : undefined;
    const uniqueMeaning = recognizedMeaning && meaningCounts.get(recognizedMeaning) === 1 ? recognizedMeaning : undefined;
    if (recognizedMeaning && !uniqueMeaning) {
      warnings.push({ fieldKey: field.key, code: 'duplicate-meaning', property: 'meaning' });
    }
    return {
      ...field,
      ...(stableId ? { stableId } : {}),
      ...(uniqueMeaning ? {
        semanticMeaning: uniqueMeaning,
        atlasMeaning: atlasMeaningForForgeMeaning(uniqueMeaning),
      } : {}),
    };
  });
  const meaningMapping = mapForgeStatblockFieldMeanings(fields);
  return { fields, meanings: meaningMapping.meanings, warnings };
}

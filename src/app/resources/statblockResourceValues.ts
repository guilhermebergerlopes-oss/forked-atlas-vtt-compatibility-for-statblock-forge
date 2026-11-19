import { isHitPointsKey, parseResourceValue, resolveField } from './resourceFields';
import { forgeResourceMeanings, resolveForgeResourceFieldPath, type ForgeResourceFieldSource } from './forgeResourceFieldResolution';
import { holdsValue } from './resourceValues';
import type { ResourceDefinition, ResourceValue } from './resourceTypes';
import { NO_MEANINGS, type FieldMeanings } from '../statblocks/resolve/fieldMeanings';

/**
 * The starting value a statblock gives one resource, or null when its field holds no quantity.
 * `meanings` are those of the statblock's template: hit points under another key are found by them.
 */
function resourceReadTarget(
  record: Readonly<Record<string, unknown>>,
  field: string,
  meanings: FieldMeanings,
  forge?: ForgeResourceFieldSource,
): { path: string; meanings: FieldMeanings } | null {
  if (!forge) return { path: field, meanings };

  const resolved = resolveForgeResourceFieldPath(field, record, forge);
  if (resolved.status !== 'resolved') return null;
  const resourceMeanings = forgeResourceMeanings(meanings, record, forge);
  let path = resolved.path;

  // A conventional `hp`/`health` definition may follow the Forge hit-points meaning even when
  // that Field has a different current key. Point straight at the adjusted meaning key so an
  // unrelated raw frontmatter property cannot shadow the validated Forge Field.
  if (resolved.via === 'passthrough') {
    const [head, ...tail] = field.split('.');
    const meaningKey = resourceMeanings['hit-points'];
    if (!head || !isHitPointsKey(head) || !meaningKey) return null;
    path = [meaningKey, ...tail].join('.');
  }

  return { path, meanings: resourceMeanings };
}

/** The value at a Resource's resolved source path; unresolved Forge paths remain distinct from empty Fields. */
export type StatblockResourceFieldValue =
  | { status: 'resolved'; value: unknown }
  | { status: 'unresolved' };

export function statblockResourceFieldValue(
  record: Readonly<Record<string, unknown>>,
  definition: ResourceDefinition,
  meanings: FieldMeanings = NO_MEANINGS,
  forge?: ForgeResourceFieldSource,
): StatblockResourceFieldValue {
  const target = resourceReadTarget(record, definition.field, meanings, forge);
  if (!target) return { status: 'unresolved' };
  return { status: 'resolved', value: resolveField(record, target.path, target.meanings) };
}

export function statblockResourceValue(
  record: Readonly<Record<string, unknown>>,
  definition: ResourceDefinition,
  meanings: FieldMeanings = NO_MEANINGS,
  forge?: ForgeResourceFieldSource,
): ResourceValue | null {
  const source = statblockResourceFieldValue(record, definition, meanings, forge);
  if (source.status !== 'resolved') return null;
  // A bare maximum starts full or empty by direction; a stated current ("12/27") is kept.
  const parsed = parseResourceValue(source.value, definition.direction === 'fills');
  return parsed && holdsValue(definition, parsed) ? parsed : null;
}

export function startingResources(
  record: Readonly<Record<string, unknown>>,
  definitions: readonly ResourceDefinition[],
  meanings: FieldMeanings = NO_MEANINGS,
  forge?: ForgeResourceFieldSource,
): Record<string, ResourceValue> {
  const values: Record<string, ResourceValue> = {};
  for (const definition of definitions) {
    const value = statblockResourceValue(record, definition, meanings, forge);
    if (value) values[definition.key] = value;
  }
  return values;
}

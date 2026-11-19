/**
 * The statblock fields the Resources tab offers as chips: what the
 * collection's role templates define first, then what its statblocks hold.
 */

import type { StatblockTemplate, TemplateField } from '../statblocks/model/templateTypes';
import { discoverResourceFields } from './resourceFields';
import type { ForgeNumericResourceField } from './forgeNumericResourceFields';

/** A statblock field a resource can read. */
export interface FieldSuggestion {
  /** Dotted path, as a resource definition names it (`hp`, `stats.0`). */
  path: string;
  /** The template's name for it ("Hit Points", "STR"); unset for a field found only in statblocks. */
  label?: string;
  /** One of a scores field's slots: an ability score, read as one when picked. */
  score?: boolean;
  /** What a template means as this setting itself (its initiative field): offered before the rest. */
  recommended?: true;
  /** This path is also defined by a validated Forge Field on a linked statblock. */
  source?: 'forge';
}

/** The paths of a field that hold a quantity: each slot of a Scores field, a number, or the hit points whatever their type. */
function quantityPaths(field: TemplateField): FieldSuggestion[] {
  if (field.type === 'scores') return (field.slots ?? []).map((slot, index) => ({ path: `${field.key}.${index}`, label: slot }));
  return field.type === 'number' || field.meaning === 'hit-points' ? [{ path: field.key, label: field.label }] : [];
}

/**
 * The fields of the templates that hold a quantity, each path once (the first template names it):
 * every template's hit points first, as the resource most collections track, then its other
 * quantities in form order.
 */
export function templateResourceFields(templates: readonly StatblockTemplate[]): FieldSuggestion[] {
  const offered = new Map<string, FieldSuggestion>();
  const offer = (fields: readonly TemplateField[]): void => {
    for (const suggestion of fields.flatMap(quantityPaths)) if (!offered.has(suggestion.path)) offered.set(suggestion.path, suggestion);
  };
  offer(templates.flatMap((template) => template.fields.filter((field) => field.meaning === 'hit-points')));
  for (const template of templates) offer(template.fields);
  return [...offered.values()];
}

/** The minimal shape of a linked statblock needed by the Resource source selector. */
export interface ResourceFieldStatblock {
  fields: Readonly<Record<string, unknown>>;
  forge?: {
    fieldDescriptors: readonly { key: string }[];
    resourceFields: readonly ForgeNumericResourceField[];
  };
}

/**
 * The chips of the Resources tab: role-template quantities first, then validated Forge Fields,
 * then other concrete quantities found in non-Forge statblocks. Forge records are deliberately
 * omitted from generic discovery: otherwise a formula-backed or otherwise unsafe Forge Field
 * could sneak back into the selector merely because its stored value happens to be numeric.
 */
export function resourceFieldSuggestions(
  templates: readonly StatblockTemplate[],
  statblocks: readonly ResourceFieldStatblock[],
): FieldSuggestion[] {
  const offered = new Map<string, FieldSuggestion>();
  for (const suggestion of templateResourceFields(templates)) offered.set(suggestion.path, suggestion);

  // A key shared by linked Forge templates is offered only when every Forge Field with that key
  // passed the per-note compatibility check. A textual Rating or formula-backed Number must not
  // become selectable merely because another linked Forge note uses the same key numerically.
  const forgeFields = new Map<string, { field: ForgeNumericResourceField | null; seen: number; eligible: number }>();
  const unsafeForgeKeys = new Set<string>();
  const nonForgeRecords: Readonly<Record<string, unknown>>[] = [];
  for (const statblock of statblocks) {
    if (!statblock.forge) {
      nonForgeRecords.push(statblock.fields);
      continue;
    }
    const candidates = new Map(statblock.forge.resourceFields.map((field) => [field.path, field]));
    for (const key of new Set(statblock.forge.fieldDescriptors.map((field) => field.key))) {
      const current = forgeFields.get(key);
      const candidate = candidates.get(key);
      if (!current) {
        forgeFields.set(key, { field: candidate ?? null, seen: 1, eligible: candidate ? 1 : 0 });
      } else {
        current.seen++;
        if (candidate) {
          current.eligible++;
          if (candidate.recommended && !current.field?.recommended) current.field = candidate;
          else if (!current.field) current.field = candidate;
        }
      }
      if (!candidate) unsafeForgeKeys.add(key);
    }
  }

  // Offer only keys that are eligible in every linked Forge note which defines them.
  const orderedForgeFields = [...forgeFields.entries()]
    .filter(([key, item]) => item.field !== null && item.eligible === item.seen && !unsafeForgeKeys.has(key))
    .map(([, item]) => item.field!)
    .map((field, index) => ({ field, index }))
    .sort((a, b) => Number(Boolean(b.field.recommended)) - Number(Boolean(a.field.recommended)) || a.index - b.index)
    .map(({ field }) => field);

  for (const field of orderedForgeFields) {
    const current = offered.get(field.path);
    offered.set(field.path, {
      ...current,
      path: field.path,
      label: current?.label ?? field.label,
      ...(current?.recommended || field.recommended ? { recommended: true as const } : {}),
      source: 'forge',
    });
  }

  for (const path of discoverResourceFields(nonForgeRecords)) {
    if (!offered.has(path)) offered.set(path, { path });
  }
  return [...offered.values()];
}

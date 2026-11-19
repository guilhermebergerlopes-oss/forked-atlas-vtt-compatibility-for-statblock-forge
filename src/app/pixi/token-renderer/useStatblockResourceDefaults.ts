import { useMemo } from 'react';
import { useCreatureIndex } from '../../creatures/useCreatureIndex';
import type { ResourceDefinition, ResourceValue } from '../../resources/resourceTypes';
import { startingResources } from '../../resources/statblockResourceValues';
import type { StatblockLink } from './useStatblockSenses';

const NO_DEFAULTS: Record<string, ResourceValue> = {};

export interface StatblockResourceDefaults {
  /** Resource values the linked statblock currently supplies. */
  values: Record<string, ResourceValue>;
  /** False only while the linked note has not yet been resolved by CreatureIndex. */
  resolved: boolean;
}

const NO_LINK_DEFAULTS: StatblockResourceDefaults = { values: NO_DEFAULTS, resolved: true };
const PENDING_DEFAULTS: StatblockResourceDefaults = { values: NO_DEFAULTS, resolved: false };

/**
 * What the linked statblock gives each resource, read through the resolver, so renamed keys and
 * the template's meanings count (a Draw Steel monster's Stamina is its hit points). The resolved
 * flag distinguishes a source that has no Resource default from a note that has not been indexed
 * yet, so clearing an override cannot delete a held value merely because loading is incomplete.
 */
export function useStatblockResourceDefaults(link: StatblockLink | null, definitions: readonly ResourceDefinition[]): StatblockResourceDefaults {
  const path = link?.path;
  const paths = useMemo(() => (path ? [path] : []), [path]);
  const creatures = useCreatureIndex(link?.app ?? null, paths);
  const creature = path ? creatures.get(path) : undefined;
  return useMemo(
    () => {
      if (!path) return NO_LINK_DEFAULTS;
      if (creature === undefined) return PENDING_DEFAULTS;
      return {
        values: creature ? startingResources(creature.fields, definitions, creature.meanings, creature.forge) : NO_DEFAULTS,
        resolved: true,
      };
    },
    [creature, definitions, path],
  );
}

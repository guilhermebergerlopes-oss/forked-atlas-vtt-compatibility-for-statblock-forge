import type { Character } from '../../types';

export type StatblockNameEditable = Partial<Pick<Character, 'name' | 'statblockPath' | 'statblockName' | 'statblockNameOverridden'>>;

export interface StatblockNameEditUpdates {
  name: string | undefined;
  statblockName?: string | null | undefined;
  statblockNameOverridden: true | undefined;
}

/**
 * Name edits made in Atlas are explicit instance-level choices. Keep the last source name as
 * the comparison point so entering that value again resumes following the linked statblock.
 * An empty name is also an intentional override: it suppresses the source-name fallback.
 */
export function statblockNameEditUpdates(
  token: StatblockNameEditable,
  rawName: string,
): StatblockNameEditUpdates {
  const name = rawName.trim();
  if (!token.statblockPath) {
    return { name: name || undefined, statblockNameOverridden: undefined };
  }

  const baseline = token.statblockName ?? token.name ?? null;
  const followsSource = name !== '' && baseline !== null && name === baseline;
  return {
    name: name || undefined,
    ...(token.statblockName == null && baseline !== null ? { statblockName: baseline } : {}),
    statblockNameOverridden: followsSource ? undefined : true,
  };
}

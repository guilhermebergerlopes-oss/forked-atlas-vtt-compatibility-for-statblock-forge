import { TFile, type App } from 'obsidian';
import type { BestiaryLookup } from '../../../../creatures/linkedCreature';
import type { FantasyStatblocksCreature } from '../../../../services/FantasyStatblocksService';
import {
  cachedFrontmatter,
  frontmatterSource,
  hasForgeFrontmatterMarkerInText,
  hasForgeStatblockMetadata,
  statblockSourceOf,
} from '../../../../statblocks/notes/statblockSource';
import { NO_MEANINGS } from '../../../../statblocks/resolve/fieldMeanings';
import { readStatblock } from '../../../../statblocks/resolve/readStatblock';
import { resolveForgeStatblockData } from '../../../../statblocks/notes/forgeStatblockResolvedData';
import { forgeStatblockEntryIssue } from './forgeStatblockEntryIssue';
import { workSlices } from '../../../../utils/workSlices';
import { statblockEntry, statblockEntryOrigin, type StatblockEntry, type StatblockEntryOrigin } from './statblockEntries';

/** An entry read from its note. */
export interface NoteEntry extends StatblockEntry {
  /** A native statblock: its own note is read, never the bestiary's copy of it. */
  native: boolean;
}

/** Whether a Fantasy bestiary row is actually backed by an Atlas- or Forge-owned note.
 *
 * The bestiary's copy may not include every Forge frontmatter property, so
 * consult the note's cached frontmatter as the source of truth as well.
 */
export function isNativeCreature(app: App, creature: FantasyStatblocksCreature): boolean {
  const fromCreature = frontmatterSource(creature)?.kind;
  if (fromCreature === 'atlas' || fromCreature === 'forge') return true;
  if (typeof creature.path !== 'string' || !creature.path) return false;
  const file = app.vault.getAbstractFileByPath(creature.path);
  if (!(file instanceof TFile) || file.extension !== 'md') return false;
  const frontmatter = cachedFrontmatter(app, file);
  const fromNote = frontmatterSource(frontmatter)?.kind;
  return fromNote === 'atlas' || fromNote === 'forge' || hasForgeStatblockMetadata(frontmatter);
}

/** The note frontmatter, not the bestiary's possibly stale copy, determines its visible origin. */
function noteOrigin(app: App, file: TFile): StatblockEntryOrigin {
  return statblockEntryOrigin(frontmatterSource(cachedFrontmatter(app, file)));
}


/**
 * The vault's statblock notes a token can link to that the bestiary does not
 * describe: every native statblock, with its template's meanings, and the
 * notes Fantasy Statblocks never parsed (```statblock fences, frontmatter with
 * "auto parse" off, any note while the plugin is missing). Forge-native notes
 * are treated like Atlas-native notes and take precedence over a stale bestiary copy.
 * A note whose statblock cannot be read is listed under its file name. An aborted read
 * stops at the next note.
 */
export async function statblockNoteEntries(app: App, bestiary: BestiaryLookup, signal?: AbortSignal): Promise<NoteEntry[]> {
  const entries: NoteEntry[] = [];
  const pause = workSlices();
  for (const file of app.vault.getMarkdownFiles()) {
    await pause();
    if (signal?.aborted) break;
    const frontmatter = cachedFrontmatter(app, file);
    const source = frontmatterSource(frontmatter);
    let forgeMetadata = hasForgeStatblockMetadata(frontmatter);
    // A stale Fantasy bestiary row can survive a broken YAML edit. When the cache cannot
    // classify that note as Atlas/Forge, inspect the raw header before accepting the copy.
    if (!forgeMetadata && !frontmatter && bestiary.byPath.has(file.path)) {
      try {
        forgeMetadata = hasForgeFrontmatterMarkerInText(await app.vault.cachedRead(file));
      } catch {
        // An unreadable raw note cannot prove that a stale bestiary row is Forge-owned.
      }
    }
    const origin = forgeMetadata ? 'forge' : noteOrigin(app, file);
    const native = origin !== 'fantasy';
    if (!native && (bestiary.byPath.has(file.path) || !(await statblockSourceOf(app, file)))) continue;

    // Keep Forge-native notes in the list even when their template cannot currently be resolved.
    // This exposes the exact failure (missing, ambiguous, or invalid) instead of reducing it to an
    // unreadable preview or silently dropping the note from the Asset Manager.
    if (origin === 'forge') {
      const result = await resolveForgeStatblockData(app, file.path, frontmatter ?? {});
      const resolved = result.status === 'ready' ? result.data.statblock : null;
      const issue = forgeStatblockEntryIssue(result) ?? (source?.kind !== 'forge' ? { kind: 'invalid-link' as const } : null);
      entries.push({
        ...statblockEntry(file.path, resolved?.fields ?? {}, resolved?.meanings ?? NO_MEANINGS, file.basename, origin, issue ?? undefined),
        native: true,
      });
      continue;
    }

    const statblock = await readStatblock(app, file.path, bestiary);
    entries.push({
      ...statblockEntry(file.path, statblock?.fields ?? {}, statblock?.meanings ?? NO_MEANINGS, file.basename, origin),
      native,
    });
  }
  return entries;
}

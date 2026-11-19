/**
 * The one resolver: a statblock note as every consumer reads it, with the
 * template it renders with (§4.10, §5.3, §6.1).
 *
 * - Atlas-native notes read their frontmatter and Atlas template. Forge-native
 *   v2 notes are resolved by Forge's adapter and never enter the Fantasy
 *   Statblocks bestiary path.
 * - Fantasy Statblocks' statblocks keep `linkedCreatureFor`'s order. While the
 *   plugin is loaded it renders them (no template); while it is missing,
 *   frontmatter and inline fences render with the auto template, and a fence
 *   that only names a creature or another note cannot be read at all.
 */

import { TFile, type App } from 'obsidian';
import {
  bestiaryLookup,
  frontmatterCreature,
  linkedCreatureFor,
  type BestiaryLookup,
} from '../../creatures/linkedCreature';
import { layoutForCreature, type FantasyStatblocksCreature } from '../../services/FantasyStatblocksService';
import { autoTemplate } from '../model/autoTemplate';
import type { ResolveContext, ResolvedStatblock, StatblockSource, TemplateLookup } from '../model/resolvedTypes';
import { withHeaderFields } from '../model/templateHeader';
import { cachedFrontmatter, hasForgeStatblockMetadata, statblockSourceOf, type FrontmatterRecord } from '../notes/statblockSource';
import { resolveForgeStatblockData } from '../notes/forgeStatblockResolvedData';
import type { ForgeStatblockFieldDescriptor, ForgeStatblockFieldExtractionWarning } from '../notes/forgeStatblockFieldTypes';
import { withReferencesFilled } from '../values/fillReferences';
import { statblockLookup } from '../values/statblockLookup';
import { NO_MEANINGS, meaningsOf, withFormerKeysAliased } from './fieldMeanings';

export type AtlasSource = Extract<StatblockSource, { kind: 'atlas' }>;
export type FenceSource = Extract<StatblockSource, { kind: 'fs-fence' }>;
type FantasyStatblockSource = Extract<StatblockSource, { kind: 'fs-frontmatter' | 'fs-fence' }>;
export type StatblockRecord = Readonly<Record<string, unknown>>;

export interface VaultResolveContext extends ResolveContext {
  /** One bestiary lookup for many notes (`CreatureIndex` builds one per batch); read anew when absent. */
  bestiary?: BestiaryLookup;
}

/** A native statblock: its template from the lookup (former keys aliased, meanings read), else the auto template. */
export function resolveNative(
  path: string,
  source: AtlasSource,
  frontmatter: FrontmatterRecord,
  templates: TemplateLookup,
): ResolvedStatblock {
  const found = templates.get(source.templateId);
  if (!found) {
    const fields = frontmatterCreature(frontmatter, path);
    return { path, source, fields, template: autoTemplate(fields), templateStatus: 'missing', lookName: null, meanings: NO_MEANINGS };
  }
  const fields = frontmatterCreature(withFormerKeysAliased(frontmatter, found.template.fields), path);
  const { fields: templateFields } = withHeaderFields(found.template);
  const shownFields = withReferencesFilled(fields, templateFields, statblockLookup(found.template, fields, templateFields));
  return {
    path,
    source,
    fields,
    template: found.template,
    templateStatus: found.status,
    lookName: found.name,
    meanings: meaningsOf(found.template.fields),
    ...(shownFields !== fields && { shownFields }),
  };
}

/** A Fantasy Statblocks statblock: the plugin renders it while loaded, the auto template while it is missing. */
export function resolveFantasy(
  path: string,
  source: FantasyStatblockSource,
  creature: StatblockRecord,
  fantasy: { loaded: boolean; layoutName: string | null },
): ResolvedStatblock {
  return fantasy.loaded
    ? { path, source, fields: creature, template: null, templateStatus: null, lookName: fantasy.layoutName, meanings: NO_MEANINGS }
    : { path, source, fields: creature, template: autoTemplate(creature), templateStatus: 'auto', lookName: null, meanings: NO_MEANINGS };
}

/**
 * A fence read without Fantasy Statblocks: its own YAML with the auto
 * template, where it defines fields. A fence that only names a bestiary
 * creature or another note gives null: only the plugin can read it.
 */
export function resolveInlineFence(path: string, source: FenceSource): ResolvedStatblock | null {
  if (autoTemplate(source.params).fields.length === 0) return null;
  return resolveFantasy(path, source, frontmatterCreature(source.params, path), { loaded: false, layoutName: null });
}

/** The layout a creature asks for by name, as Fantasy Statblocks reads `layout`. */
export function requestedLayout(creature: StatblockRecord): string | null {
  return typeof creature.layout === 'string' ? creature.layout : null;
}

/** The FS layout a creature renders with: the plugin's match, else the name it asks for. */
export function fantasyLayoutName(app: App, creature: FantasyStatblocksCreature): string | null {
  return layoutForCreature(app, creature)?.name ?? requestedLayout(creature);
}

/** The Forge metadata needed by consumers which must inspect the source Field definitions. */
export interface ForgeStatblockResolutionMetadata {
  fieldDescriptors: readonly ForgeStatblockFieldDescriptor[];
  fieldExtractionWarnings: readonly ForgeStatblockFieldExtractionWarning[];
  /** Template Fields absent from the note; distinct from unknown properties. */
  missingFieldKeys: readonly string[];
}

/** A resolved statblock plus source-owned metadata that is intentionally not part of ResolvedStatblock. */
export interface StatblockResolutionDetails {
  statblock: ResolvedStatblock;
  /** Present only for a valid Forge-native note. The Forge template itself remains Forge-owned. */
  forge?: ForgeStatblockResolutionMetadata;
}

/** What a creature the predicate did not find came from: the bestiary's parse of the note, else a creature of its name. */
function bestiarySource(path: string, creature: StatblockRecord, bestiary: BestiaryLookup): FantasyStatblockSource {
  if (bestiary.byPath.has(path)) return { kind: 'fs-frontmatter' };
  return { kind: 'fs-fence', params: { creature: creature.name } };
}

/** Resolve a vault note and retain the minimal Forge-owned metadata needed by source-aware consumers. */
export async function resolveStatblockWithDetails(
  app: App,
  path: string,
  context: VaultResolveContext,
): Promise<StatblockResolutionDetails | null> {
  const file = app.vault.getAbstractFileByPath(path);
  const note = file instanceof TFile ? file : null;
  const frontmatter = note ? cachedFrontmatter(app, note) : undefined;
  const source = note ? await statblockSourceOf(app, note) : null;

  if (note && source?.kind === 'forge') {
    const result = await resolveForgeStatblockData(app, path, frontmatter ?? {});
    if (result.status !== 'ready') return null;
    return {
      statblock: { ...result.data.statblock, source },
      forge: {
        fieldDescriptors: result.data.forge.fieldDescriptors,
        fieldExtractionWarnings: result.data.diagnostics.fieldExtractionWarnings,
        missingFieldKeys: result.data.diagnostics.missingFieldKeys,
      },
    };
  }
  // Do not let a malformed Forge-native link fall through to Fantasy Statblocks' bestiary lookup.
  if (note && !source && hasForgeStatblockMetadata(frontmatter)) return null;
  if (note && source?.kind === 'atlas') return { statblock: resolveNative(path, source, frontmatter ?? {}, context.templates) };
  // Keep the Fantasy resolver's input type limited to Fantasy Statblocks sources.
  if (source && source.kind !== 'fs-frontmatter' && source.kind !== 'fs-fence') return null;

  const bestiary = context.bestiary ?? bestiaryLookup(app);
  const loaded = bestiary.api !== null;
  const creature = await linkedCreatureFor(app, path, source, bestiary);
  if (!creature) {
    const inline = !loaded && source?.kind === 'fs-fence' ? resolveInlineFence(path, source) : null;
    return inline ? { statblock: inline } : null;
  }
  return {
    statblock: resolveFantasy(path, source ?? bestiarySource(path, creature, bestiary), creature, {
      loaded,
      layoutName: loaded ? fantasyLayoutName(app, creature) : null,
    }),
  };
}

/** The statblock of a vault note, or null when it defines none Atlas can read. */
export async function resolveStatblock(app: App, path: string, context: VaultResolveContext): Promise<ResolvedStatblock | null> {
  return (await resolveStatblockWithDetails(app, path, context))?.statblock ?? null;
}

import { App, TFile } from 'obsidian';
import type { TokenEntity } from '../types';
import type { ResourceDefsProvider } from '../resources/resourceTypes';
import type { TokenStatblockLinkService } from '../services/TokenStatblockLinkService';
import { buildStatblockLinkUpdates } from '../pixi/token-renderer/statblockFrontmatter';
import { parseNoteYaml } from '../services/noteYaml';
import { effectiveStatblockPath } from '../characters/statblockLinkPrecedence';

/** Reads linked note fields used when a token sprite is first created. */
export async function statblockTokenAppearance(
  app: App,
  token: TokenEntity,
  links: Pick<TokenStatblockLinkService, 'getStatblockLinkedToToken' | 'readStatblockRecord'>,
  resourceDefsProvider: ResourceDefsProvider,
): Promise<TokenEntity> {
  let character: TokenEntity = token;

  // A path stored on this placed character is its instance-level choice. Only when
  // it has none do we inherit the exact library Asset ID's default link.
  if (token.imagePath && token.kind === 'character' && effectiveStatblockPath(token.statblockPath, null) === null) {
    const linkedStatblockPath = await links.getStatblockLinkedToToken(token.imagePath, token.assetId);
    if (linkedStatblockPath) {
      character = { ...token, statblockPath: linkedStatblockPath };

      try {
        // Read through the resolver, as every linked token is: renamed keys and a template's meanings count.
        const statblock = await links.readStatblockRecord(linkedStatblockPath);
        if (statblock) {
          character = { ...character, ...buildStatblockLinkUpdates(statblock, token.name, resourceDefsProvider(), token.resources, token.kind === 'character' && token.statblockNameOverridden === true) };
        }
      } catch (error) {
        console.error(`[TokenRenderer] Failed to load statblock data for token ${token.id}:`, error);
      }
    }
  }

  // Enhance character with statblock name if needed
  return enhanceCharacterWithStatblockName(app, character);
}

/**
 * Enhance character object with statblock name for nameplate display
 */
async function enhanceCharacterWithStatblockName(app: App, character: TokenEntity): Promise<TokenEntity> {
  // A custom name wins over the statblock name; without a statblock there is nothing to load
  if (character.kind !== 'character' || character.name || !character.statblockPath) {
    return character;
  }

  const statblockPath = character.statblockPath;

  try {
    const file = app.vault.getAbstractFileByPath(statblockPath);
    if (!(file instanceof TFile)) {
      console.warn(`[TokenRenderer] Statblock file not found: ${statblockPath}`);
      return character;
    }

    const content = await app.vault.read(file);
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

    if (!match) {
      console.warn(`[TokenRenderer] Invalid statblock format in file: ${statblockPath}`);
      return character;
    }

    const statblockData: unknown = parseNoteYaml(match[1]!);
    if (!statblockData || typeof statblockData !== 'object') {
      console.warn(`[TokenRenderer] Failed to parse YAML in statblock: ${statblockPath}`);
      return character;
    }

    const name = 'name' in statblockData ? statblockData.name : undefined;
    return {
      ...character,
      statblockName: typeof name === 'string' && name ? name : null
    };
  } catch (error) {
    console.error(`[TokenRenderer] Error loading statblock at ${statblockPath}:`, error);
    return character;
  }
}


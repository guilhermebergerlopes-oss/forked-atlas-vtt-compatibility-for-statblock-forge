import { requestUrl } from 'obsidian';
import { isReleaseVersion } from '../changelog/version';
import { isRecord } from '../utils/guards';
import { FORK_MANIFEST_URL, FORK_PLUGIN_ID } from './forkReleaseConfig';

/** The fork's own manifest URL; deliberately unset until its release repository exists. */
export const MANIFEST_URL = FORK_MANIFEST_URL;
const PLUGIN_ID = FORK_PLUGIN_ID;
/** A manifest is a few hundred bytes; anything far larger is not one. */
const MAX_MANIFEST_LENGTH = 64 * 1024;

export type FetchText = (url: string) => Promise<{ status: number; text: string }>;

/** Obsidian's `requestUrl`, which answers errors with their status instead of throwing. */
export const obsidianFetch: FetchText = async (url) => {
  const response = await requestUrl({ url, throw: false });
  return { status: response.status, text: response.text };
};

/**
 * The release this fork's own Obsidian manifest would install now, or null when
 * no fork release source is configured, the manifest is invalid, or the
 * installed Obsidian is too old. It never consults the upstream Atlas manifest.
 * The optional URL is exposed for deterministic tests; production uses the
 * fork-only URL configured above.
 */
export async function readPublishedVersion(
  fetch: FetchText,
  appSupports: (minAppVersion: string) => boolean,
  manifestUrl: string | null = MANIFEST_URL,
): Promise<string | null> {
  if (!manifestUrl) return null;
  try {
    const { status, text } = await fetch(manifestUrl);
    if (status !== 200 || text.length > MAX_MANIFEST_LENGTH) return null;
    const manifest: unknown = JSON.parse(text);
    if (!isRecord(manifest)) return null;
    const { id, version, minAppVersion } = manifest;
    if (id !== PLUGIN_ID || !isReleaseVersion(version)) return null;
    if (typeof minAppVersion === 'string' && !appSupports(minAppVersion)) return null;
    return version;
  } catch {
    return null;
  }
}

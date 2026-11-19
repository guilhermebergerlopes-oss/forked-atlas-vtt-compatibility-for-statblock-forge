/**
 * Release endpoints belong to the fork, never to the upstream Atlas repository.
 * Set these only after the fork has its own public GitHub repository and (if
 * submitted) its own Obsidian community-plugin listing. Until then, update
 * polling and update notices remain disabled rather than pointing users at
 * releases of a different plugin.
 */
export const FORK_PLUGIN_ID = 'forked-atlas-vtt-compatibility-for-statblock-forge';
export const FORK_MANIFEST_URL: string | null = null;
export const FORK_RELEASES_URL: string | null = null;
export const FORK_PLUGIN_PAGE_URL: string | null = null;

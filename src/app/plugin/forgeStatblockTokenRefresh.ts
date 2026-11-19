import type { App } from 'obsidian';

/** Workspace event consumed by each open map's StatblockTokenSync after a Forge snapshot refresh. */
export const FORGE_STATBLOCK_TOKEN_REFRESH_EVENT = 'atlas-vtt:forge-statblock-token-refresh';

export interface ForgeStatblockTokenRefreshEvent {
  readonly sceneId: string;
  /** Forge provider sourceId; for Forge v2 this is the vault-relative note path. */
  readonly sourceId: string;
  /** Atlas sheet instances successfully refreshed before token reconciliation was requested. */
  readonly refreshedInstanceIds: readonly string[];
  readonly reason: 'template';
}

export function isForgeStatblockTokenRefreshEvent(value: unknown): value is ForgeStatblockTokenRefreshEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return typeof event.sceneId === 'string' && event.sceneId.trim().length > 0
    && typeof event.sourceId === 'string' && event.sourceId.trim().length > 0
    && event.reason === 'template'
    && Array.isArray(event.refreshedInstanceIds)
    && event.refreshedInstanceIds.length > 0
    && event.refreshedInstanceIds.every((id) => typeof id === 'string' && id.trim().length > 0);
}

/**
 * Notify map-local token synchronizers only after Atlas has committed at least one new sheet
 * snapshot. The event carries identifiers, never provider-owned Field contents.
 */
export function notifyForgeStatblockTokenRefresh(
  app: Pick<App, 'workspace'>,
  sceneId: string,
  sourceId: string,
  refreshedInstanceIds: readonly string[],
): void {
  const uniqueIds = [...new Set(refreshedInstanceIds.filter((id) => typeof id === 'string' && id.trim().length > 0))];
  if (!sceneId.trim() || !sourceId.trim() || uniqueIds.length === 0) return;
  const event: ForgeStatblockTokenRefreshEvent = Object.freeze({
    sceneId,
    sourceId,
    refreshedInstanceIds: Object.freeze(uniqueIds),
    reason: 'template',
  });
  app.workspace.trigger(FORGE_STATBLOCK_TOKEN_REFRESH_EVENT, event);
}

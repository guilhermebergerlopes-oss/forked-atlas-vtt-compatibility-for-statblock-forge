import type { AtlasPublicAPI, AtlasSheetInstance, AtlasSheetRenderSession } from '../api/sheets/types';

/** Stable provider ID used by Forge-native v2 statblock notes. */
export const FORGE_SHEET_PROVIDER_ID = 'statblock-forge';

/** Public Atlas API plus the persistent sheet instance selected for a preview. */
export interface ProviderStatblockPreviewBinding {
  readonly sceneId: string;
  readonly tokenId: string;
  readonly sourceId: string;
}

export interface ProviderStatblockPreviewRequest {
  readonly api: AtlasPublicAPI;
  readonly instanceId: string;
  /** Revalidated immediately before mounting so a stale hover cannot display a relinked sheet. */
  readonly expectedBinding?: ProviderStatblockPreviewBinding;
}


/** Revalidates a preview's original token-note association before an incremental update. */
export function isProviderStatblockPreviewRequestCurrent(request: ProviderStatblockPreviewRequest): boolean {
  try {
    const instance = request.api.sheets.getInstance(request.instanceId);
    if (!instance || instance.source.providerId !== FORGE_SHEET_PROVIDER_ID) return false;
    const expected = request.expectedBinding;
    return !expected || (
      instance.sceneId === expected.sceneId
      && instance.tokenId === expected.tokenId
      && instance.source.sourceId === expected.sourceId
    );
  } catch {
    return false;
  }
}

/**
 * Mount a provider-owned statblock in a preview window only when its instance
 * and renderer are still available. Availability is rechecked at the point of
 * use so plugin load/unload order cannot leave a stale positive result cached.
 */
export function startProviderStatblockPreview(
  request: ProviderStatblockPreviewRequest,
  mountPoint: HTMLElement,
): AtlasSheetRenderSession | null {
  const instance = request.api.sheets.getInstance(request.instanceId);
  if (!instance || instance.source.providerId !== FORGE_SHEET_PROVIDER_ID || !isProviderStatblockPreviewRequestCurrent(request)) return null;

  const provider = request.api.sheets.getProviderDescriptor(instance.source.providerId);
  if (!provider?.capabilities.includes('rendering')) return null;

  return request.api.sheets.renderInstance({
    instanceId: instance.id,
    mountPoint,
    variant: 'preview',
  });
}


export type ProviderStatblockPreviewResolution =
  | { readonly status: 'ready'; readonly request: ProviderStatblockPreviewRequest; readonly instance: AtlasSheetInstance }
  | { readonly status: 'missing' | 'ambiguous' | 'provider-unavailable' | 'api-unavailable' };

/**
 * Resolve the one Forge sheet instance explicitly attached to the hovered token and linked note.
 * The Forge adapter convention uses the vault-relative Markdown note path as its catalog sourceId;
 * the generic Atlas API continues to treat sourceId as opaque. Multiple matches are never guessed.
 */
export function resolveForgeStatblockPreviewForToken(
  api: AtlasPublicAPI | null | undefined,
  sceneId: string | null | undefined,
  tokenId: string,
  notePath: string,
): ProviderStatblockPreviewResolution {
  if (!api || !sceneId || !tokenId || !notePath) return { status: 'api-unavailable' };

  let instances: readonly AtlasSheetInstance[];
  let provider: ReturnType<AtlasPublicAPI['sheets']['getProviderDescriptor']>;
  try {
    instances = api.sheets.getInstances(sceneId);
    provider = api.sheets.getProviderDescriptor(FORGE_SHEET_PROVIDER_ID);
  } catch {
    return { status: 'api-unavailable' };
  }

  if (!provider?.capabilities.includes('rendering')) return { status: 'provider-unavailable' };

  const candidates = instances.filter((instance) =>
    instance.sceneId === sceneId
    && instance.tokenId === tokenId
    && instance.source.providerId === FORGE_SHEET_PROVIDER_ID
    && instance.source.sourceId === notePath,
  );

  if (candidates.length === 0) return { status: 'missing' };
  if (candidates.length !== 1) return { status: 'ambiguous' };

  return {
    status: 'ready',
    instance: candidates[0]!,
    request: {
      api,
      instanceId: candidates[0]!.id,
      expectedBinding: { sceneId, tokenId, sourceId: notePath },
    },
  };
}

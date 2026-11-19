/** Public, provider-neutral contracts for sheets and statblock dice supplied to Atlas by other plugins. */

import type { AdvantageSide, DiceSet, RollingDice } from '../../types/diceSetTypes';

/** The public API major version. A consumer must check this before using the API. */
export const ATLAS_PUBLIC_API_VERSION = 1 as const;

/** Optional surfaces consumers may check before calling a corresponding API operation. */
export const ATLAS_PUBLIC_API_CAPABILITIES = Object.freeze([
  'sheets.contract',
  'sheets.provider-registration',
  'sheets.catalog',
  'sheets.source-resolution',
  'sheets.instances',
  'sheets.rendering',
] as const);
export type AtlasPublicAPICapability = (typeof ATLAS_PUBLIC_API_CAPABILITIES)[number] | 'dice.statblock-rolls' | 'dice.statblock-history';

/** JSON-compatible metadata only; providers must not pass functions, DOM nodes, or class instances. */
export type AtlasJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly AtlasJsonValue[]
  | { readonly [key: string]: AtlasJsonValue };

/** Host-selected presentation profile; the provider controls the visual content within that profile. */
export type AtlasSheetVariant = 'full' | 'preview' | 'feed';

/** Stable identity of a sheet in the provider's own catalog. */
export interface AtlasSheetSourceRef {
  readonly providerId: string;
  readonly sourceId: string;
}

/** A lightweight catalog item; listing a source must not require loading its complete sheet. */
export interface AtlasSheetSourceDescriptor extends AtlasSheetSourceRef {
  readonly name: string;
  readonly description?: string;
  readonly revision?: string;
  readonly metadata?: Readonly<Record<string, AtlasJsonValue>>;
}

/** Optional operations implemented by one currently registered provider. */
export type AtlasSheetProviderCapability = 'catalog' | 'rendering';

export interface AtlasSheetProviderDescriptor {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** Snapshot derived by Atlas from the optional methods present at registration time. */
  readonly capabilities: readonly AtlasSheetProviderCapability[];
}

export interface AtlasSheetCatalogRequest {
  readonly query?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface AtlasSheetCatalogPage {
  readonly items: readonly AtlasSheetSourceDescriptor[];
  readonly nextCursor?: string;
}

/**
 * A normalized field value supplied by a provider. Only finite scalar numbers explicitly marked
 * resourceCompatible may feed Atlas Collection Resources. Ratings, formulas, counters, arrays,
 * and other compound values must not be represented as resource-compatible scalar numbers.
 */
export type AtlasSheetFieldValue =
  | {
      readonly key: string;
      readonly label: string;
      readonly valueType: 'number';
      readonly value: number;
      readonly resourceCompatible?: true;
    }
  | {
      readonly key: string;
      readonly label: string;
      readonly valueType: 'text';
      readonly value: string;
    }
  | {
      readonly key: string;
      readonly label: string;
      readonly valueType: 'boolean';
      readonly value: boolean;
    }
  | {
      readonly key: string;
      readonly label: string;
      readonly valueType: 'unsupported';
    };

/** Provider-neutral, read-only snapshot of a sheet's data at a particular source revision. */
export interface AtlasSheetDefinition extends AtlasSheetSourceRef {
  readonly name: string;
  readonly revision?: string;
  readonly fields: readonly AtlasSheetFieldValue[];
  readonly metadata?: Readonly<Record<string, AtlasJsonValue>>;
}

/** The token information exposed to a renderer is intentionally limited and read-only. */
export interface AtlasSheetTokenContext {
  readonly tokenId: string;
  readonly name: string;
  readonly imagePath: string;
}

export interface AtlasSheetRenderContext {
  /** Unique identity for this mounted presentation; stable across updates, new after a remount. */
  readonly renderId: string;
  /**
   * Dedicated DOM node created and owned by Atlas as a child of the supplied mountPoint.
   * Atlas does not create an iframe or ShadowRoot, nor apply a CSS reset or host styles that
   * constrain the provider's card. Normal Atlas UI mount points are in Obsidian's main light DOM,
   * so the provider's already-loaded stylesheet can reach the rendered descendants. The provider
   * may append descendants and decorate this
   * element with classList/inline theme properties, but must not remove, replace, reparent, or
   * take ownership of the container. Use classList.add/remove rather than replacing className.
   * `data-atlas-sheet-*` attributes and the base class `atlas-sheet-render-container` are reserved
   * for Atlas and must not be changed by providers.
   */
  readonly container: HTMLElement;
  /** Atlas-owned persistent instance and scene identities. */
  readonly instanceId: string;
  readonly sceneId: string;
  /** Presentation profile selected by Atlas, not by the provider. */
  readonly variant: AtlasSheetVariant;
  /** Limited, read-only identity and appearance data for the associated token, when present. */
  readonly token?: AtlasSheetTokenContext;
  /**
   * Session-lifetime cancellation signal. Atlas aborts it when the session is superseded, its
   * instance/container is removed, the provider unregisters, or the Atlas API is disposed. The
   * same signal and renderId are supplied to every update for this mounted presentation.
   */
  readonly signal: AbortSignal;
}

/** Lifecycle phase attached to a structured renderer failure reported by Atlas. */
export type AtlasSheetRenderFailurePhase = 'mount' | 'update' | 'dispose';

/**
 * A mounted provider presentation. Atlas owns the handle and controls its lifetime.
 * `update` is an optional in-place optimization; `dispose` is always required.
 */
export interface AtlasSheetRenderHandle {
  /**
   * Apply a newer source snapshot to the existing presentation. Calls for one handle are
   * serialized by Atlas; Atlas does not start a second update while the previous update is pending.
   * The context keeps the same renderId, container, instanceId, sceneId, and session signal, with
   * current token/profile data. Rejecting means the update failed and the presentation must be
   * treated as unusable; Atlas ends that render session rather than keeping stale UI active.
   */
  update?(definition: AtlasSheetDefinition, context: AtlasSheetRenderContext): void | Promise<void>;
  /**
   * Synchronously release listeners, observers, subscriptions, timers, and provider-owned DOM
   * descendants. Do not return a Promise; Atlas invokes this synchronously and does not await
   * thenables. Atlas calls this at most once for a returned handle, after aborting its session. Implementations must be idempotent and safe while cancelled
   * asynchronous work is settling. The Atlas-owned container must remain in place.
   */
  dispose(): void;
}

export interface AtlasSheetProvider {
  /** Stable, lowercase plugin-scoped identifier, e.g. `statblock-forge`. */
  readonly id: string;
  readonly name: string;
  /** Provider implementation version, independent from Atlas API version. */
  readonly version: string;
  /** Optional paginated catalog used by Atlas surfaces such as the Asset Manager. */
  listSheets?(request: AtlasSheetCatalogRequest): Promise<AtlasSheetCatalogPage>;
  /** Resolve a source into a normalized snapshot. Return null when it no longer exists. */
  getSheet(sourceId: string): Promise<AtlasSheetDefinition | null>;
  /**
   * Optional rendering implementation invoked by Atlas. The API and lifecycle are owned by
   * Atlas; a provider only supplies this callback and its returned handle. Omit for data-only
   * providers. The definition and context are read-only Atlas snapshots.
   */
  render?(
    definition: AtlasSheetDefinition,
    context: AtlasSheetRenderContext,
  ): AtlasSheetRenderHandle | Promise<AtlasSheetRenderHandle>;
}


/** Request for Atlas to mount one persistent sheet instance into a host-owned parent element. */
export interface AtlasSheetRenderRequest {
  readonly instanceId: string;
  /** Parent element supplied by Atlas UI; Atlas creates and owns a dedicated child container. */
  readonly mountPoint: HTMLElement;
  readonly variant: AtlasSheetVariant;
}

/** Atlas-owned render session returned immediately; `ready` settles when the provider mount settles. */
export type AtlasSheetRenderUpdateResult = 'updated' | 'remount-required';

export interface AtlasSheetRenderSession {
  readonly renderId: string;
  /** Rejects with render-failure for provider errors or render-cancelled when Atlas ends a pending mount. */
  readonly ready: Promise<void>;
  /**
   * Push the latest Atlas-owned instance snapshot and token context to the mounted provider.
   * Updates for one session are serialized. Returns `remount-required` when the provider handle
   * has no in-place update callback; callers should dispose and create a new render session. A
   * rejected update ends the session because its visual state can no longer be trusted.
   */
  update(): Promise<AtlasSheetRenderUpdateResult>;
  /** Abort the session, remove the Atlas-owned container, and synchronously dispose a mounted handle. May throw render-failure/dispose after cleanup. */
  dispose(): void;
}

export interface AtlasSheetInstance {
  readonly id: string;
  readonly sceneId: string;
  readonly source: AtlasSheetSourceRef;
  readonly tokenId?: string;
  readonly sourceRevision?: string;
  /** Last valid snapshot, retained so the instance remains identifiable if its provider is absent. */
  readonly lastKnownDefinition: AtlasSheetDefinition;
}

export interface AtlasCreateSheetInstanceRequest {
  readonly sceneId: string;
  readonly source: AtlasSheetSourceRef;
  /** Optional id of an existing token in sceneId; Atlas validates and owns this association. */
  readonly tokenId?: string;
}

export type AtlasSheetErrorCode =
  | 'api-version-mismatch'
  | 'provider-already-registered'
  | 'invalid-provider'
  | 'provider-not-found'
  | 'source-not-found'
  | 'instance-not-found'
  | 'instance-changed'
  | 'token-not-found'
  | 'scene-not-found'
  | 'invalid-definition'
  | 'invalid-resource-field'
  | 'provider-failure'
  | 'render-failure'
  | 'render-cancelled'
  | 'invalid-render-target'
  | 'operation-not-supported'
  | 'api-unavailable';

export interface AtlasSheetAPIError extends Error {
  readonly code: AtlasSheetErrorCode;
  readonly message: string;
  readonly providerId?: string;
  readonly sourceId?: string;
  readonly instanceId?: string;
  readonly tokenId?: string;
  /** Present for render-failure and identifies which provider lifecycle callback failed. */
  readonly renderPhase?: AtlasSheetRenderFailurePhase;
}

/** Public operations implemented by Atlas; this file defines the contract only. */
export interface AtlasSheetAPI {
  /** Register a provider. The returned function unregisters it and is safe to call repeatedly. */
  registerProvider(provider: AtlasSheetProvider): () => void;
  /** Return a stable snapshot of currently registered provider descriptors. */
  listProviders(): readonly AtlasSheetProviderDescriptor[];
  /**
   * Return one provider's current descriptor, or null when it is not registered. This is the
   * preferred availability check before using a provider-specific integration. The rendering
   * capability is provider-specific and distinct from Atlas' global `sheets.rendering` support.
   */
  getProviderDescriptor(providerId: string): AtlasSheetProviderDescriptor | null;
  /** List one provider's catalog. Providers without listSheets return an empty page. */
  listSheets(providerId: string, request: AtlasSheetCatalogRequest): Promise<AtlasSheetCatalogPage>;
  /** Resolve the latest provider snapshot without creating or linking an instance. */
  getDefinition(source: AtlasSheetSourceRef): Promise<AtlasSheetDefinition | null>;
  /** Create an Atlas-owned instance in an open, loaded scene; optionally bind it to an existing token. */
  createInstance(request: AtlasCreateSheetInstanceRequest): Promise<AtlasSheetInstance>;
  /** Mount an instance using its registered provider renderer into an Atlas-owned child container. */
  renderInstance(request: AtlasSheetRenderRequest): AtlasSheetRenderSession;
  /** Attach an existing instance to an existing token in the currently loaded scene. Multiple instances may share a token. */
  attachToToken(instanceId: string, tokenId: string): Promise<AtlasSheetInstance>;
  /** Remove only the token association; preserve the sheet instance. */
  detachFromToken(instanceId: string): Promise<AtlasSheetInstance>;
  getInstance(instanceId: string): AtlasSheetInstance | null;
  getInstances(sceneId: string): readonly AtlasSheetInstance[];
  /**
   * Resolve the current provider definition for an instance in the currently loaded scene and
   * replace only its last-known snapshot and source revision. Token binding and token Resources
   * are not changed. Resource reconciliation is a separate host-owned synchronization step.
   * Concurrent refreshes of the same instance are serialized; stale source relinks are rejected.
   */
  refreshInstance(instanceId: string): Promise<AtlasSheetInstance>;
  /** Remove the Atlas-owned instance and its association; never delete the source or token. */
  removeInstance(instanceId: string): Promise<void>;
}

/** The part of a dice set another plugin may select for a statblock roll. */
export type AtlasPublicDiceSet = DiceSet;

/** Identifies the Forge statblock that requested a roll; it never implies a scene or token origin. */
export interface AtlasPublicStatblockDiceSource {
  readonly statblockPath: string;
  readonly tokenName?: string;
  readonly abilityName?: string;
}

export interface AtlasPublicStatblockRollingDiceRequest {
  readonly source: AtlasPublicStatblockDiceSource;
  readonly set?: AtlasPublicDiceSet;
}

export interface AtlasPublicStatblockRollRequest extends AtlasPublicStatblockRollingDiceRequest {
  readonly formula: string;
  readonly advantage?: AdvantageSide;
}

/** Stable receipt returned to the calling plugin; the full roll remains Atlas-owned for display. */
export interface AtlasPublicDiceRollReceipt {
  readonly id: string;
  readonly formula: string;
  readonly total: number;
  readonly timestamp: number;
}

/** A small, immutable history record; the full dice result remains owned by Atlas. */
export interface AtlasPublicDiceRollHistoryEntry extends AtlasPublicDiceRollReceipt {
  readonly statblockPath: string;
  readonly tokenName?: string;
  readonly abilityName?: string;
  readonly advantage?: AdvantageSide;
  /** False when an old scene log lacks the original unregistered custom dice-set definition. */
  readonly repeatable?: boolean;
}

export interface AtlasPublicDiceRollHistoryRequest {
  readonly statblockPath: string;
  /** Maximum number of newest records to return (1–50; defaults to 10). */
  readonly limit?: number;
}

export interface AtlasPublicDiceRollRepeatRequest {
  readonly id: string;
}

/** Only the dice and advantage rules needed to construct menus and default bonus formulas. */
export type AtlasPublicRollingDice = Pick<RollingDice, 'dice' | 'advantage' | 'disadvantage'>;

/** Atlas-owned statblock dice operations; history is an optional, separately advertised capability. */
export interface AtlasPublicDiceAPI {
  rollStatblock(request: AtlasPublicStatblockRollRequest): AtlasPublicDiceRollReceipt | null;
  rollingDiceForStatblock(request: AtlasPublicStatblockRollingDiceRequest): AtlasPublicRollingDice | null;
  getStatblockRollHistory?(request: AtlasPublicDiceRollHistoryRequest): readonly AtlasPublicDiceRollHistoryEntry[];
  repeatStatblockRoll?(request: AtlasPublicDiceRollRepeatRequest): AtlasPublicDiceRollReceipt | null;
}

/** Stable top-level shape exposed by the Atlas plugin to other Obsidian plugins. */
export interface AtlasPublicAPI {
  readonly apiVersion: typeof ATLAS_PUBLIC_API_VERSION;
  readonly capabilities: readonly AtlasPublicAPICapability[];
  readonly sheets: AtlasSheetAPI;
  readonly dice: AtlasPublicDiceAPI;
}

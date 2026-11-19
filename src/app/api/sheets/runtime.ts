import {
  ATLAS_PUBLIC_API_CAPABILITIES,
  ATLAS_PUBLIC_API_VERSION,
  type AtlasCreateSheetInstanceRequest,
  type AtlasJsonValue,
  type AtlasPublicAPI,
  type AtlasPublicDiceAPI,
  type AtlasSheetAPI,
  type AtlasSheetAPIError,
  type AtlasSheetCatalogPage,
  type AtlasSheetCatalogRequest,
  type AtlasSheetDefinition,
  type AtlasSheetFieldValue,
  type AtlasSheetProvider,
  type AtlasSheetProviderDescriptor,
  type AtlasSheetProviderCapability,
  type AtlasSheetSourceDescriptor,
  type AtlasSheetSourceRef,
  type AtlasSheetInstance,
  type AtlasSheetRenderContext,
  type AtlasSheetRenderHandle,
  type AtlasSheetRenderRequest,
  type AtlasSheetRenderSession,
  type AtlasSheetRenderFailurePhase,
  type AtlasSheetTokenContext,
  type AtlasSheetRenderUpdateResult,
} from './types';

export interface AtlasSheetSceneInstanceStore {
  readonly sceneId: string;
  getInstances(): Readonly<Record<string, AtlasSheetInstance>>;
  /** Checks token existence without exposing mutable token records to sheet providers. */
  hasToken(tokenId: string): boolean;
  /** Returns only the small, read-only appearance context permitted to sheet renderers. */
  getTokenContext?(tokenId: string): AtlasSheetTokenContext | null;
  replaceInstances(instances: Record<string, AtlasSheetInstance>): void;
}

export interface AtlasPublicAPIRuntimeOptions {
  /** Resolve only a currently loaded scene; sceneId is the scene file path used by Atlas. */
  resolveScene(sceneId: string): AtlasSheetSceneInstanceStore | null;
  /** The currently active, loaded scene, used by getInstance(instanceId). */
  getCurrentScene(): AtlasSheetSceneInstanceStore | null;
  /** Host logging hook for renderer failures, including cleanup failures during unregister/unload. */
  onRenderError?(error: AtlasSheetAPIError): void;
  /** Atlas-owned statblock roller and rules resolver; absent only in isolated API tests/host shims. */
  dice?: AtlasPublicDiceAPI;
}

export interface AtlasPublicAPIRuntime {
  readonly api: AtlasPublicAPI;
  /** Invalidates the facade and releases provider registrations when the host plugin unloads. */
  dispose(): void;
}

function apiError(code: AtlasSheetAPIError['code'], message: string, providerId?: string, sourceId?: string, instanceId?: string, renderPhase?: AtlasSheetRenderFailurePhase, tokenId?: string): AtlasSheetAPIError {
  const error = new Error(message) as AtlasSheetAPIError;
  error.name = 'AtlasSheetAPIError';
  Object.defineProperty(error, 'code', { value: code, enumerable: true });
  if (providerId !== undefined) Object.defineProperty(error, 'providerId', { value: providerId, enumerable: true });
  if (sourceId !== undefined) Object.defineProperty(error, 'sourceId', { value: sourceId, enumerable: true });
  if (instanceId !== undefined) Object.defineProperty(error, 'instanceId', { value: instanceId, enumerable: true });
  if (renderPhase !== undefined) Object.defineProperty(error, 'renderPhase', { value: renderPhase, enumerable: true });
  if (tokenId !== undefined) Object.defineProperty(error, 'tokenId', { value: tokenId, enumerable: true });
  return error;
}

const PROVIDER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_CATALOG_LIMIT = 100;
const MAX_METADATA_DEPTH = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateProvider(provider: AtlasSheetProvider): void {
  if (!provider || typeof provider !== 'object') throw apiError('invalid-provider', 'A sheet provider must be an object.');
  if (typeof provider.id !== 'string' || !PROVIDER_ID_PATTERN.test(provider.id)) {
    throw apiError('invalid-provider', 'Provider id must be a lowercase, hyphen-separated identifier.', typeof provider.id === 'string' ? provider.id : undefined);
  }
  if (typeof provider.name !== 'string' || provider.name.trim().length === 0) throw apiError('invalid-provider', 'Provider name must be a non-empty string.', provider.id);
  if (typeof provider.version !== 'string' || provider.version.trim().length === 0) throw apiError('invalid-provider', 'Provider version must be a non-empty string.', provider.id);
  if (typeof provider.getSheet !== 'function') throw apiError('invalid-provider', 'Provider must implement getSheet(sourceId).', provider.id);
  if (provider.listSheets !== undefined && typeof provider.listSheets !== 'function') throw apiError('invalid-provider', 'Provider listSheets must be a function when supplied.', provider.id);
  if (provider.render !== undefined && typeof provider.render !== 'function') throw apiError('invalid-provider', 'Provider render must be a function when supplied.', provider.id);
}

function cloneJsonValue(value: unknown, seen = new Set<object>(), depth = 0): AtlasJsonValue {
  if (depth > MAX_METADATA_DEPTH) throw new Error('Metadata nesting exceeds the supported limit.');
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') throw new Error('Metadata must contain JSON-compatible values only.');
  if (seen.has(value)) throw new Error('Metadata cannot contain circular references.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => cloneJsonValue(item, seen, depth + 1))) as unknown as AtlasJsonValue;
    if (!isRecord(value)) throw new Error('Metadata cannot contain class instances or non-plain objects.');
    const result: Record<string, AtlasJsonValue> = Object.create(null) as Record<string, AtlasJsonValue>;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) throw new Error('Metadata cannot contain undefined values.');
      result[key] = cloneJsonValue(item, seen, depth + 1);
    }
    return Object.freeze(result);
  } finally { seen.delete(value); }
}

function cloneMetadata(value: unknown): Readonly<Record<string, AtlasJsonValue>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Metadata must be a plain object.');
  return cloneJsonValue(value) as Readonly<Record<string, AtlasJsonValue>>;
}

function validateCatalogRequest(request: AtlasSheetCatalogRequest): AtlasSheetCatalogRequest {
  if (!isRecord(request)) throw apiError('invalid-definition', 'Catalog request must be an object.');
  if (!Number.isInteger(request.limit) || (request.limit as number) < 1 || (request.limit as number) > MAX_CATALOG_LIMIT) {
    throw apiError('invalid-definition', `Catalog limit must be an integer between 1 and ${MAX_CATALOG_LIMIT}.`);
  }
  if (request.query !== undefined && typeof request.query !== 'string') throw apiError('invalid-definition', 'Catalog query must be a string when supplied.');
  if (request.cursor !== undefined && (typeof request.cursor !== 'string' || request.cursor.length === 0)) throw apiError('invalid-definition', 'Catalog cursor must be a non-empty string when supplied.');
  return Object.freeze({
    limit: request.limit as number,
    ...(typeof request.query === 'string' && request.query.trim() ? { query: request.query.trim() } : {}),
    ...(typeof request.cursor === 'string' ? { cursor: request.cursor } : {}),
  });
}

function normalizeDescriptor(value: unknown, providerId: string): AtlasSheetSourceDescriptor {
  if (!isRecord(value) || value.providerId !== providerId || typeof value.sourceId !== 'string' || !value.sourceId.trim()
    || typeof value.name !== 'string' || !value.name.trim()) throw new Error('Catalog item must include the matching providerId and non-empty sourceId and name.');
  if (value.description !== undefined && typeof value.description !== 'string') throw new Error('Catalog description must be a string.');
  if (value.revision !== undefined && typeof value.revision !== 'string') throw new Error('Catalog revision must be a string.');
  const metadata = cloneMetadata(value.metadata);
  return Object.freeze({
    providerId, sourceId: value.sourceId, name: value.name.trim(),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(typeof value.revision === 'string' ? { revision: value.revision } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  });
}

function normalizeDefinition(value: unknown, source: AtlasSheetSourceRef): AtlasSheetDefinition {
  if (!isRecord(value) || value.providerId !== source.providerId || value.sourceId !== source.sourceId
    || typeof value.name !== 'string' || !value.name.trim() || !Array.isArray(value.fields)) throw new Error('Definition identity, name, or fields are invalid.');
  if (value.revision !== undefined && typeof value.revision !== 'string') throw new Error('Definition revision must be a string.');
  const keys = new Set<string>();
  const fields: AtlasSheetFieldValue[] = value.fields.map((field: unknown) => {
    if (!isRecord(field) || typeof field.key !== 'string' || !field.key.trim() || typeof field.label !== 'string' || !field.label.trim()) throw new Error('Each field must have a non-empty key and label.');
    if (keys.has(field.key)) throw new Error(`Duplicate field key: ${field.key}`);
    keys.add(field.key);
    switch (field.valueType) {
      case 'number':
        if (typeof field.value !== 'number' || !Number.isFinite(field.value)) throw new Error(`Numeric field "${field.key}" must contain a finite number.`);
        if (field.resourceCompatible !== undefined && field.resourceCompatible !== true) throw new Error(`Numeric field "${field.key}" has an invalid resourceCompatible flag.`);
        return Object.freeze({ key: field.key, label: field.label, valueType: 'number' as const, value: field.value, ...(field.resourceCompatible === true ? { resourceCompatible: true as const } : {}) });
      case 'text':
        if (typeof field.value !== 'string') throw new Error(`Text field "${field.key}" must contain a string.`);
        return Object.freeze({ key: field.key, label: field.label, valueType: 'text' as const, value: field.value });
      case 'boolean':
        if (typeof field.value !== 'boolean') throw new Error(`Boolean field "${field.key}" must contain a boolean.`);
        return Object.freeze({ key: field.key, label: field.label, valueType: 'boolean' as const, value: field.value });
      case 'unsupported': return Object.freeze({ key: field.key, label: field.label, valueType: 'unsupported' as const });
      default: throw new Error(`Field "${field.key}" has an unsupported valueType.`);
    }
  });
  const metadata = cloneMetadata(value.metadata);
  return Object.freeze({
    providerId: source.providerId, sourceId: source.sourceId, name: value.name.trim(), fields: Object.freeze(fields),
    ...(typeof value.revision === 'string' ? { revision: value.revision } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  });
}

interface ProviderRegistration {
  readonly provider: AtlasSheetProvider;
  readonly registration: symbol;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** Optional callbacks are snapshotted so the advertised capabilities cannot drift after registration. */
  readonly getSheet: AtlasSheetProvider['getSheet'];
  readonly listSheets?: AtlasSheetProvider['listSheets'];
  readonly render?: AtlasSheetProvider['render'];
  readonly capabilities: readonly AtlasSheetProviderCapability[];
}

interface RenderSessionRecord {
  readonly renderId: string;
  readonly providerId: string;
  readonly sourceId: string;
  readonly instanceId: string;
  readonly sceneId: string;
  readonly variant: AtlasSheetRenderRequest['variant'];
  readonly registration: symbol;
  readonly controller: AbortController;
  readonly container: HTMLElement;
  readonly mountPoint: HTMLElement;
  readonly resolveReady: () => void;
  readonly rejectReady: (error: AtlasSheetAPIError) => void;
  readonly ready: Promise<void>;
  handle: AtlasSheetRenderHandle | null;
  updateQueue: Promise<void>;
  readySettled: boolean;
  closed: boolean;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  return typeof (value as { then?: unknown }).then === 'function';
}

function canAppendRenderContainer(value: unknown): value is HTMLElement {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<HTMLElement>;
  const ownerDocument = candidate.ownerDocument;
  return candidate.nodeType === 1
    && typeof candidate.appendChild === 'function'
    && !!ownerDocument
    && typeof ownerDocument.createElement === 'function';
}

function renderFailure(record: Pick<RenderSessionRecord, 'providerId' | 'sourceId' | 'instanceId'>, phase: AtlasSheetRenderFailurePhase, detail: string): AtlasSheetAPIError {
  return apiError('render-failure', `Provider \"${record.providerId}\" failed during render ${phase} for instance \"${record.instanceId}\": ${detail}`, record.providerId, record.sourceId, record.instanceId, phase);
}

function cancellationError(record: Pick<RenderSessionRecord, 'providerId' | 'sourceId' | 'instanceId'>): AtlasSheetAPIError {
  return apiError('render-cancelled', `Rendering of instance \"${record.instanceId}\" was cancelled by Atlas.`, record.providerId, record.sourceId, record.instanceId);
}

/** Call a provider disposer once and convert all violations into a structured lifecycle error. */
function disposeProviderHandle(
  handle: unknown,
  record: Pick<RenderSessionRecord, 'providerId' | 'sourceId' | 'instanceId'>,
): AtlasSheetAPIError | null {
  if ((typeof handle !== 'object' && typeof handle !== 'function') || handle === null) return null;
  try {
    const disposer = (handle as { dispose?: unknown }).dispose;
    if (typeof disposer !== 'function') return null;
    const result: unknown = disposer.call(handle);
    if (isThenable(result)) {
      // The public contract requires synchronous disposal. Contain any later rejection.
      void Promise.resolve(result).catch(() => undefined);
      return renderFailure(record, 'dispose', 'dispose() returned a Promise-like value; disposal must be synchronous.');
    }
    return null;
  } catch (error) {
    return renderFailure(record, 'dispose', error instanceof Error ? error.message : String(error));
  }
}

function isAtlasRenderContainerIntact(record: RenderSessionRecord, expectedState: 'mounting' | 'mounted' = 'mounting'): boolean {
  const { container } = record;
  return container.parentNode === record.mountPoint
    && container.classList.contains('atlas-sheet-render-container')
    && container.dataset.atlasSheetRenderId === record.renderId
    && container.dataset.atlasSheetProviderId === record.providerId
    && container.dataset.atlasSheetSourceId === record.sourceId
    && container.dataset.atlasSheetVariant === record.variant
    && container.dataset.atlasSheetRenderState === expectedState;
}

function renderContextFor(
  record: RenderSessionRecord,
  instance: AtlasSheetInstance,
  scene: AtlasSheetSceneInstanceStore,
): AtlasSheetRenderContext {
  let token: AtlasSheetTokenContext | undefined;
  if (instance.tokenId && scene.getTokenContext) {
    try {
      const current = scene.getTokenContext(instance.tokenId);
      if (current && current.tokenId === instance.tokenId) {
        token = Object.freeze({
          tokenId: current.tokenId,
          name: typeof current.name === 'string' ? current.name : '',
          imagePath: typeof current.imagePath === 'string' ? current.imagePath : '',
        });
      }
    } catch { /* Token appearance is optional; a provider can still render from the sheet snapshot. */ }
  }
  return Object.freeze({
    renderId: record.renderId,
    container: record.container,
    instanceId: record.instanceId,
    sceneId: record.sceneId,
    variant: record.variant,
    ...(token ? { token } : {}),
    signal: record.controller.signal,
  });
}

function validateRenderHandle(value: unknown): string | null {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return 'render() must return an object with a callable dispose().';
  try {
    const candidate = value as { dispose?: unknown; update?: unknown };
    if (typeof candidate.dispose !== 'function') return 'render() must return an object with a callable dispose().';
    if (candidate.update !== undefined && typeof candidate.update !== 'function') return 'A supplied update property must be callable.';
    return null;
  } catch (error) {
    return `The returned render handle could not be inspected: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Atlas-owned provider registry, source resolution, persistent instances, and initial render mounting. */
export function createAtlasPublicAPI(options?: AtlasPublicAPIRuntimeOptions): AtlasPublicAPIRuntime {
  let disposed = false;
  const providers = new Map<string, ProviderRegistration>();
  const renderSessions = new Map<string, RenderSessionRecord>();
  /** Serialize refreshes per instance so an older note read cannot overwrite a newer one. */
  const refreshQueues = new Map<string, Promise<AtlasSheetInstance>>();
  const unavailable = (): AtlasSheetAPIError => disposed
    ? apiError('api-unavailable', 'Atlas public API is no longer available because the plugin has unloaded.')
    : apiError('operation-not-supported', 'The Atlas sheet API operation has not been implemented yet.');

  const reportRenderError = (error: AtlasSheetAPIError): void => {
    try { options?.onRenderError?.(error); } catch { /* A host logger must not interfere with renderer cleanup. */ }
  };

  const disposeHandleAndReport = (handle: unknown, record: RenderSessionRecord): AtlasSheetAPIError | null => {
    const failure = disposeProviderHandle(handle, record);
    if (failure) reportRenderError(failure);
    return failure;
  };

  const requireProvider = (providerId: string): AtlasSheetProvider => {
    if (disposed) throw unavailable();
    if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) throw apiError('provider-not-found', 'A valid provider id is required.', typeof providerId === 'string' ? providerId : undefined);
    const entry = providers.get(providerId);
    if (!entry) throw apiError('provider-not-found', `Sheet provider "${providerId}" is not registered.`, providerId);
    return entry.provider;
  };

  const endRenderSession = (record: RenderSessionRecord, readyError: AtlasSheetAPIError = cancellationError(record)): AtlasSheetAPIError | null => {
    if (record.closed) return null;
    record.closed = true;
    renderSessions.delete(record.renderId);
    record.controller.abort();
    // The visual surface disappears immediately, before provider cleanup is invoked.
    record.container.parentNode?.removeChild(record.container);
    const handle = record.handle;
    record.handle = null;
    const disposeError = handle ? disposeHandleAndReport(handle, record) : null;
    if (!record.readySettled) {
      record.readySettled = true;
      record.rejectReady(readyError);
    }
    return disposeError;
  };

  const cancelRegistrationSessions = (registration: symbol): void => {
    for (const session of [...renderSessions.values()]) {
      if (session.registration !== registration) continue;
      // Provider unload is best-effort: a broken disposer must not block other sessions.
      endRenderSession(session);
    }
  };

  const cancelInstanceSessions = (instanceId: string): void => {
    for (const session of [...renderSessions.values()]) {
      if (session.instanceId !== instanceId) continue;
      endRenderSession(session);
    }
  };

  const registerProvider = (provider: AtlasSheetProvider): (() => void) => {
    if (disposed) throw unavailable();
    validateProvider(provider);
    if (providers.has(provider.id)) throw apiError('provider-already-registered', `A sheet provider with id "${provider.id}" is already registered.`, provider.id);
    const providerId = provider.id;
    const registration = Symbol(providerId);
    const capabilities: AtlasSheetProviderCapability[] = [];
    if (typeof provider.listSheets === 'function') capabilities.push('catalog');
    if (typeof provider.render === 'function') capabilities.push('rendering');
    providers.set(providerId, {
      provider,
      registration,
      id: providerId,
      name: provider.name,
      version: provider.version,
      getSheet: provider.getSheet,
      ...(typeof provider.listSheets === 'function' ? { listSheets: provider.listSheets } : {}),
      ...(typeof provider.render === 'function' ? { render: provider.render } : {}),
      capabilities: Object.freeze(capabilities),
    });
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      if (providers.get(providerId)?.registration === registration) providers.delete(providerId);
      cancelRegistrationSessions(registration);
    };
  };

  const describeProvider = (entry: ProviderRegistration): AtlasSheetProviderDescriptor => Object.freeze({
    id: entry.id,
    name: entry.name,
    version: entry.version,
    capabilities: entry.capabilities,
  });

  const listProviders = (): readonly AtlasSheetProviderDescriptor[] => {
    if (disposed) throw unavailable();
    return Object.freeze([...providers.values()].map((entry) => describeProvider(entry)));
  };

  const getProviderDescriptor = (providerId: string): AtlasSheetProviderDescriptor | null => {
    if (disposed) throw unavailable();
    if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) {
      throw apiError('provider-not-found', 'A valid provider id is required.', typeof providerId === 'string' ? providerId : undefined);
    }
    const entry = providers.get(providerId);
    return entry ? describeProvider(entry) : null;
  };

  const listSheets = async (providerId: string, rawRequest: AtlasSheetCatalogRequest) => {
    const provider = requireProvider(providerId);
    const entry = providers.get(providerId);
    const request = validateCatalogRequest(rawRequest);
    if (!entry?.listSheets) return Object.freeze({ items: Object.freeze([]) });
    let page: unknown;
    try { page = await entry.listSheets.call(provider, request); }
    catch (error) { throw apiError('provider-failure', `Provider "${providerId}" failed while listing sheets: ${error instanceof Error ? error.message : String(error)}`, providerId); }
    try {
      if (!isRecord(page) || !Array.isArray(page.items)) throw new Error('Catalog page must contain an items array.');
      if (page.nextCursor !== undefined && (typeof page.nextCursor !== 'string' || !page.nextCursor)) throw new Error('Catalog nextCursor must be a non-empty string when supplied.');
      const items = page.items.map((item) => normalizeDescriptor(item, providerId));
      const ids = new Set<string>();
      for (const item of items) {
        if (ids.has(item.sourceId)) throw new Error(`Duplicate sourceId in catalog page: ${item.sourceId}`);
        ids.add(item.sourceId);
      }
      if (items.length > request.limit) throw new Error('Provider returned more catalog items than the requested limit.');
      const normalized: AtlasSheetCatalogPage = Object.freeze({ items: Object.freeze(items), ...(typeof page.nextCursor === 'string' ? { nextCursor: page.nextCursor } : {}) });
      return normalized;
    } catch (error) { throw apiError('invalid-definition', `Provider "${providerId}" returned an invalid catalog page: ${error instanceof Error ? error.message : String(error)}`, providerId); }
  };

  const getDefinition = async (source: AtlasSheetSourceRef): Promise<AtlasSheetDefinition | null> => {
    if (disposed) throw unavailable();
    if (!isRecord(source) || typeof source.providerId !== 'string' || !PROVIDER_ID_PATTERN.test(source.providerId)
      || typeof source.sourceId !== 'string' || !source.sourceId.trim()) throw apiError('invalid-definition', 'A source reference requires a valid providerId and non-empty sourceId.');
    const entry = providers.get(source.providerId);
    if (!entry) throw apiError('provider-not-found', `Sheet provider "${source.providerId}" is not registered.`, source.providerId, source.sourceId);
    let definition: unknown;
    try { definition = await entry.getSheet.call(entry.provider, source.sourceId); }
    catch (error) { throw apiError('provider-failure', `Provider "${source.providerId}" failed while resolving source "${source.sourceId}": ${error instanceof Error ? error.message : String(error)}`, source.providerId, source.sourceId); }
    if (definition === null) return null;
    try { return normalizeDefinition(definition, source); }
    catch (error) { throw apiError('invalid-definition', `Provider "${source.providerId}" returned an invalid definition for source "${source.sourceId}": ${error instanceof Error ? error.message : String(error)}`, source.providerId, source.sourceId); }
  };

  const requireScene = (sceneId: string): AtlasSheetSceneInstanceStore => {
    if (disposed) throw unavailable();
    if (typeof sceneId !== 'string' || !sceneId.trim()) throw apiError('scene-not-found', 'A valid scene id is required.');
    const scene = options?.resolveScene(sceneId) ?? null;
    if (!scene || scene.sceneId !== sceneId) throw apiError('scene-not-found', `Scene "${sceneId}" is not currently loaded in Atlas.`);
    return scene;
  };

  const freezeInstance = (instance: AtlasSheetInstance): AtlasSheetInstance => {
    let definition: AtlasSheetDefinition;
    try {
      definition = normalizeDefinition(instance.lastKnownDefinition, instance.source);
    } catch (error) {
      throw apiError('invalid-definition', `Stored sheet instance "${instance.id}" has an invalid last-known definition: ${error instanceof Error ? error.message : String(error)}`, instance.source?.providerId, instance.source?.sourceId, instance.id);
    }
    return Object.freeze({
      id: instance.id,
      sceneId: instance.sceneId,
      source: Object.freeze({ providerId: instance.source.providerId, sourceId: instance.source.sourceId }),
      ...(instance.tokenId !== undefined ? { tokenId: instance.tokenId } : {}),
      ...(instance.sourceRevision !== undefined ? { sourceRevision: instance.sourceRevision } : {}),
      lastKnownDefinition: definition,
    });
  };

  const readInstances = (scene: AtlasSheetSceneInstanceStore): readonly AtlasSheetInstance[] => Object.freeze(
    Object.values(scene.getInstances()).map((instance) => freezeInstance(instance)),
  );

  const createInstance = async (request: AtlasCreateSheetInstanceRequest): Promise<AtlasSheetInstance> => {
    if (disposed) throw unavailable();
    if (!isRecord(request) || typeof request.sceneId !== 'string' || !request.sceneId.trim()
      || !isRecord(request.source) || typeof request.source.providerId !== 'string' || typeof request.source.sourceId !== 'string') {
      throw apiError('invalid-definition', 'Instance creation requires a sceneId and valid source reference.');
    }
    if (request.tokenId !== undefined && (typeof request.tokenId !== 'string' || !request.tokenId.trim())) {
      throw apiError('invalid-definition', 'A supplied tokenId must be a non-empty string.', undefined, undefined, undefined, undefined, typeof request.tokenId === 'string' ? request.tokenId : undefined);
    }
    const scene = requireScene(request.sceneId);
    if (request.tokenId !== undefined && !scene.hasToken(request.tokenId)) {
      throw apiError('token-not-found', `Token "${request.tokenId}" was not found in scene "${request.sceneId}".`, request.source.providerId, request.source.sourceId, undefined, undefined, request.tokenId);
    }
    const definition = await getDefinition(request.source);
    if (!definition) throw apiError('source-not-found', `Sheet source "${request.source.sourceId}" no longer exists.`, request.source.providerId, request.source.sourceId);
    if (disposed) throw unavailable();
    if (scene.sceneId !== request.sceneId) throw apiError('scene-not-found', `Scene "${request.sceneId}" changed while the sheet source was being resolved.`);
    if (request.tokenId !== undefined && !scene.hasToken(request.tokenId)) {
      throw apiError('token-not-found', `Token "${request.tokenId}" no longer exists in scene "${request.sceneId}".`, definition.providerId, definition.sourceId, undefined, undefined, request.tokenId);
    }
    const current = scene.getInstances();
    let id = crypto.randomUUID();
    while (id in current) id = crypto.randomUUID();
    const instance = freezeInstance({
      id,
      sceneId: request.sceneId,
      source: Object.freeze({ providerId: definition.providerId, sourceId: definition.sourceId }),
      ...(request.tokenId !== undefined ? { tokenId: request.tokenId } : {}),
      ...(definition.revision !== undefined ? { sourceRevision: definition.revision } : {}),
      lastKnownDefinition: definition,
    });
    scene.replaceInstances({ ...current, [id]: instance });
    return instance;
  };

  const renderInstance = (request: AtlasSheetRenderRequest): AtlasSheetRenderSession => {
    if (disposed) throw unavailable();
    if (!isRecord(request) || typeof request.instanceId !== 'string' || !request.instanceId.trim()) {
      throw apiError('invalid-definition', 'A render request requires a non-empty instanceId.');
    }
    if (!canAppendRenderContainer(request.mountPoint)) {
      throw apiError('invalid-render-target', 'The render request must provide an HTML element that can host an Atlas-owned child container.');
    }
    if (request.variant !== 'full' && request.variant !== 'preview' && request.variant !== 'feed') {
      throw apiError('invalid-definition', 'A render request requires a supported presentation variant.');
    }

    const scene = options?.getCurrentScene() ?? null;
    if (!scene) throw apiError('scene-not-found', 'There is no currently loaded Atlas scene.');
    const storedInstance = scene.getInstances()[request.instanceId];
    if (!storedInstance) throw apiError('instance-not-found', `Sheet instance "${request.instanceId}" was not found.`, undefined, undefined, request.instanceId);
    const instance = freezeInstance(storedInstance);
    if (scene.sceneId !== instance.sceneId) throw apiError('scene-not-found', `Sheet instance "${instance.id}" no longer belongs to the currently loaded scene.`, instance.source.providerId, instance.source.sourceId, instance.id);
    const entry = providers.get(instance.source.providerId);
    if (!entry) throw apiError('provider-not-found', `Sheet provider "${instance.source.providerId}" is not registered.`, instance.source.providerId, instance.source.sourceId, instance.id);
    if (typeof entry.render !== 'function') throw apiError('operation-not-supported', `Sheet provider "${instance.source.providerId}" does not provide a renderer.`, instance.source.providerId, instance.source.sourceId, instance.id);

    let renderId = crypto.randomUUID();
    while (renderSessions.has(renderId)) renderId = crypto.randomUUID();
    let container: HTMLElement;
    try {
      container = request.mountPoint.ownerDocument.createElement('div');
      container.className = 'atlas-sheet-render-container';
      container.dataset.atlasSheetRenderId = renderId;
      container.dataset.atlasSheetRenderState = 'mounting';
      container.dataset.atlasSheetProviderId = instance.source.providerId;
      container.dataset.atlasSheetSourceId = instance.source.sourceId;
      container.dataset.atlasSheetVariant = request.variant;
      container.setAttribute('aria-busy', 'true');
      request.mountPoint.appendChild(container);
    } catch (error) {
      throw apiError('invalid-render-target', `Atlas could not create a render container in the supplied element: ${error instanceof Error ? error.message : String(error)}`);
    }

    let resolveReady!: () => void;
    let rejectReady!: (error: AtlasSheetAPIError) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // A consumer may intentionally ignore ready; mark it handled while preserving its rejection for awaiters.
    void ready.catch(() => undefined);
    const record: RenderSessionRecord = {
      renderId, providerId: instance.source.providerId, sourceId: instance.source.sourceId, instanceId: instance.id, variant: request.variant,
      registration: entry.registration, sceneId: instance.sceneId, controller: new AbortController(), container, mountPoint: request.mountPoint, resolveReady, rejectReady, ready,
      handle: null, updateQueue: Promise.resolve(), readySettled: false, closed: false,
    };
    renderSessions.set(renderId, record);
    const context = renderContextFor(record, instance, scene);

    let mountResult: AtlasSheetRenderHandle | Promise<AtlasSheetRenderHandle>;
    try { mountResult = entry.render.call(entry.provider, instance.lastKnownDefinition, context); }
    catch (error) {
      const failure = renderFailure(record, 'mount', error instanceof Error ? error.message : String(error));
      reportRenderError(failure);
      endRenderSession(record, failure);
      return Object.freeze({ renderId, ready, update: async () => { throw cancellationError(record); }, dispose: () => { endRenderSession(record); } });
    }

    void Promise.resolve(mountResult).then((handle: unknown) => {
      const stillRegistered = providers.get(record.providerId)?.registration === record.registration;
      if (record.closed || record.controller.signal.aborted || disposed || !stillRegistered) {
        // A provider may finish a mount after unregister/unload. Never activate it; dispose the late handle.
        disposeHandleAndReport(handle, record);
        return;
      }
      if (!isAtlasRenderContainerIntact(record)) {
        disposeHandleAndReport(handle, record);
        const failure = renderFailure(record, 'mount', 'The provider removed, reparented, or changed Atlas-reserved render-container identity.');
        endRenderSession(record, failure);
        return;
      }
      const invalidHandle = validateRenderHandle(handle);
      if (invalidHandle) {
        disposeHandleAndReport(handle, record);
        const failure = renderFailure(record, 'mount', invalidHandle);
        reportRenderError(failure);
        endRenderSession(record, failure);
        return;
      }
      record.handle = handle as AtlasSheetRenderHandle;
      record.container.dataset.atlasSheetRenderState = 'mounted';
      record.container.setAttribute('aria-busy', 'false');
      if (!record.readySettled) {
        record.readySettled = true;
        record.resolveReady();
      }
    }).catch((error: unknown) => {
      if (record.closed || record.controller.signal.aborted) return;
      const failure = renderFailure(record, 'mount', error instanceof Error ? error.message : String(error));
      reportRenderError(failure);
      endRenderSession(record, failure);
    });

    const updateRenderSession = (): Promise<AtlasSheetRenderUpdateResult> => {
      const performUpdate = async (): Promise<AtlasSheetRenderUpdateResult> => {
        if (record.closed || disposed || record.controller.signal.aborted) throw cancellationError(record);
        await record.ready;
        if (record.closed || disposed || record.controller.signal.aborted) throw cancellationError(record);

        const scene = options?.resolveScene(record.sceneId) ?? null;
        if (!scene || scene.sceneId !== record.sceneId) {
          const failure = apiError('scene-not-found', `Scene "${record.sceneId}" is no longer loaded while updating render session "${record.renderId}".`, record.providerId, record.sourceId, record.instanceId);
          endRenderSession(record, cancellationError(record));
          throw failure;
        }
        const storedInstance = scene.getInstances()[record.instanceId];
        if (!storedInstance) {
          const failure = apiError('instance-not-found', `Sheet instance "${record.instanceId}" was removed while its preview was open.`, record.providerId, record.sourceId, record.instanceId);
          endRenderSession(record, cancellationError(record));
          throw failure;
        }
        const instance = freezeInstance(storedInstance);
        if (instance.sceneId !== record.sceneId || instance.source.providerId !== record.providerId || instance.source.sourceId !== record.sourceId) {
          endRenderSession(record, cancellationError(record));
          throw cancellationError(record);
        }
        if (providers.get(record.providerId)?.registration !== record.registration) {
          endRenderSession(record, cancellationError(record));
          throw cancellationError(record);
        }
        const handle = record.handle;
        if (!handle) throw cancellationError(record);
        let updateMethod: AtlasSheetRenderHandle['update'];
        try { updateMethod = handle.update; }
        catch (error) {
          const failure = renderFailure(record, 'update', error instanceof Error ? error.message : String(error));
          reportRenderError(failure);
          endRenderSession(record, failure);
          throw failure;
        }
        if (typeof updateMethod !== 'function') return 'remount-required';
        if (!isAtlasRenderContainerIntact(record, 'mounted')) {
          const failure = renderFailure(record, 'update', 'The provider changed the Atlas-owned render container before an update.');
          reportRenderError(failure);
          endRenderSession(record, failure);
          throw failure;
        }

        const context = renderContextFor(record, instance, scene);
        try {
          await updateMethod.call(handle, instance.lastKnownDefinition, context);
        } catch (error) {
          if (record.closed || record.controller.signal.aborted) throw cancellationError(record);
          const failure = renderFailure(record, 'update', error instanceof Error ? error.message : String(error));
          reportRenderError(failure);
          endRenderSession(record, failure);
          throw failure;
        }
        if (record.closed || record.controller.signal.aborted) throw cancellationError(record);
        if (!isAtlasRenderContainerIntact(record, 'mounted')) {
          const failure = renderFailure(record, 'update', 'The provider removed, reparented, or changed Atlas-reserved render-container identity during update.');
          reportRenderError(failure);
          endRenderSession(record, failure);
          throw failure;
        }
        return 'updated';
      };

      // Promise chaining serializes provider callbacks. Each operation reads the latest scene
      // snapshot only when its turn begins, so rapid token or source changes do not overlap.
      const operation = record.updateQueue.then(performUpdate, performUpdate);
      record.updateQueue = operation.then(() => undefined, () => undefined);
      return operation;
    };

    return Object.freeze({
      renderId,
      ready,
      update: updateRenderSession,
      dispose: () => {
        const failure = endRenderSession(record);
        if (failure) throw failure;
      },
    });
  };

  const getInstance = (instanceId: string): AtlasSheetInstance | null => {
    if (disposed) throw unavailable();
    if (typeof instanceId !== 'string' || !instanceId) return null;
    const scene = options?.getCurrentScene() ?? null;
    if (!scene) return null;
    const instance = scene.getInstances()[instanceId];
    return instance ? freezeInstance(instance) : null;
  };

  const getInstances = (sceneId: string): readonly AtlasSheetInstance[] => readInstances(requireScene(sceneId));

  const refreshInstanceNow = async (instanceId: string): Promise<AtlasSheetInstance> => {
    if (disposed) throw unavailable();
    if (typeof instanceId !== 'string' || !instanceId.trim()) throw apiError('instance-not-found', 'A valid instance id is required.');
    const scene = options?.getCurrentScene() ?? null;
    if (!scene) throw apiError('scene-not-found', 'There is no currently loaded Atlas scene.');
    const sceneId = scene.sceneId;
    const storedBefore = scene.getInstances()[instanceId];
    if (!storedBefore) throw apiError('instance-not-found', `Sheet instance "${instanceId}" was not found in the current scene.`, undefined, undefined, instanceId);
    if (storedBefore.sceneId !== sceneId) throw apiError('scene-not-found', `Sheet instance "${instanceId}" no longer belongs to the currently loaded scene.`, storedBefore.source.providerId, storedBefore.source.sourceId, instanceId);

    const source = Object.freeze({ providerId: storedBefore.source.providerId, sourceId: storedBefore.source.sourceId });
    const registration = providers.get(source.providerId)?.registration;
    if (!registration) throw apiError('provider-not-found', `Sheet provider "${source.providerId}" is not registered.`, source.providerId, source.sourceId, instanceId);
    const definition = await getDefinition(source);
    // An unregister/unload that races a provider response takes precedence over a null
    // source result: the provider is no longer available to authoritatively resolve it.
    if (disposed) throw unavailable();
    if (providers.get(source.providerId)?.registration !== registration) {
      throw apiError('provider-not-found', `Sheet provider "${source.providerId}" was unregistered while the instance was refreshing.`, source.providerId, source.sourceId, instanceId);
    }
    if (!definition) throw apiError('source-not-found', `Sheet source "${source.sourceId}" no longer exists. The last valid snapshot was preserved.`, source.providerId, source.sourceId, instanceId);
    const currentScene = options?.getCurrentScene() ?? null;
    if (!currentScene || currentScene.sceneId !== sceneId || scene.sceneId !== sceneId) {
      throw apiError('scene-not-found', `Scene "${sceneId}" is no longer the currently loaded scene.`, source.providerId, source.sourceId, instanceId);
    }
    const current = currentScene.getInstances();
    const storedNow = current[instanceId];
    if (!storedNow) throw apiError('instance-not-found', `Sheet instance "${instanceId}" was removed while refreshing.`, source.providerId, source.sourceId, instanceId);
    if (storedNow.sceneId !== sceneId || storedNow.source.providerId !== source.providerId || storedNow.source.sourceId !== source.sourceId) {
      // A user relinked or replaced this instance while provider data was resolving. Do not
      // let the stale note read overwrite the new source or its independent token association.
      throw apiError('instance-changed', `Sheet instance "${instanceId}" changed source while refreshing; the stale provider result was discarded.`, source.providerId, source.sourceId, instanceId);
    }

    const { sourceRevision: _oldRevision, ...withoutOldRevision } = storedNow;
    const refreshed = freezeInstance({
      ...withoutOldRevision,
      ...(definition.revision !== undefined ? { sourceRevision: definition.revision } : {}),
      lastKnownDefinition: definition,
    });
    currentScene.replaceInstances({ ...current, [instanceId]: refreshed });
    return refreshed;
  };

  const refreshInstance = (instanceId: string): Promise<AtlasSheetInstance> => {
    if (disposed) return Promise.reject(unavailable());
    if (typeof instanceId !== 'string' || !instanceId.trim()) return Promise.reject(apiError('instance-not-found', 'A valid instance id is required.'));
    const previous = refreshQueues.get(instanceId);
    const operation = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => refreshInstanceNow(instanceId));
    refreshQueues.set(instanceId, operation);
    void operation.then(
      () => { if (refreshQueues.get(instanceId) === operation) refreshQueues.delete(instanceId); },
      () => { if (refreshQueues.get(instanceId) === operation) refreshQueues.delete(instanceId); },
    );
    return operation;
  };

  const attachToToken = async (instanceId: string, tokenId: string): Promise<AtlasSheetInstance> => {
    if (disposed) throw unavailable();
    if (typeof instanceId !== 'string' || !instanceId.trim()) throw apiError('instance-not-found', 'A valid instance id is required.');
    if (typeof tokenId !== 'string' || !tokenId.trim()) throw apiError('invalid-definition', 'A non-empty tokenId is required.', undefined, undefined, instanceId);
    const scene = options?.getCurrentScene() ?? null;
    if (!scene) throw apiError('scene-not-found', 'There is no currently loaded Atlas scene.');
    const current = scene.getInstances();
    const stored = current[instanceId];
    if (!stored) throw apiError('instance-not-found', `Sheet instance "${instanceId}" was not found in the current scene.`, undefined, undefined, instanceId);
    if (stored.sceneId !== scene.sceneId) throw apiError('scene-not-found', `Sheet instance "${instanceId}" no longer belongs to the currently loaded scene.`, stored.source.providerId, stored.source.sourceId, instanceId);
    if (!scene.hasToken(tokenId)) throw apiError('token-not-found', `Token "${tokenId}" was not found in scene "${scene.sceneId}".`, stored.source.providerId, stored.source.sourceId, instanceId, undefined, tokenId);
    if (stored.tokenId === tokenId) return freezeInstance(stored);
    const attached = freezeInstance({ ...stored, tokenId });
    scene.replaceInstances({ ...current, [instanceId]: attached });
    return attached;
  };

  const detachFromToken = async (instanceId: string): Promise<AtlasSheetInstance> => {
    if (disposed) throw unavailable();
    if (typeof instanceId !== 'string' || !instanceId.trim()) throw apiError('instance-not-found', 'A valid instance id is required.');
    const scene = options?.getCurrentScene() ?? null;
    if (!scene) throw apiError('scene-not-found', 'There is no currently loaded Atlas scene.');
    const current = scene.getInstances();
    const stored = current[instanceId];
    if (!stored) throw apiError('instance-not-found', `Sheet instance "${instanceId}" was not found in the current scene.`, undefined, undefined, instanceId);
    if (stored.sceneId !== scene.sceneId) throw apiError('scene-not-found', `Sheet instance "${instanceId}" no longer belongs to the currently loaded scene.`, stored.source.providerId, stored.source.sourceId, instanceId);
    if (stored.tokenId === undefined) return freezeInstance(stored);
    const { tokenId: _tokenId, ...unbound } = stored;
    const detached = freezeInstance(unbound);
    scene.replaceInstances({ ...current, [instanceId]: detached });
    return detached;
  };

  const removeInstance = async (instanceId: string): Promise<void> => {
    if (disposed) throw unavailable();
    if (typeof instanceId !== 'string' || !instanceId) throw apiError('instance-not-found', 'A valid instance id is required.');
    const scene = options?.getCurrentScene() ?? null;
    if (!scene) throw apiError('scene-not-found', 'There is no currently loaded Atlas scene.');
    const current = scene.getInstances();
    if (!scene.sceneId || !(instanceId in current)) throw apiError('instance-not-found', `Sheet instance "${instanceId}" was not found.`, undefined, undefined, instanceId);
    const next = { ...current };
    delete next[instanceId];
    scene.replaceInstances(next);
    cancelInstanceSessions(instanceId);
  };

  const sheets: AtlasSheetAPI = {
    registerProvider, listProviders, getProviderDescriptor, listSheets, getDefinition,
    createInstance, renderInstance,
    attachToToken,
    detachFromToken,
    getInstance,
    getInstances,
    refreshInstance,
    removeInstance,
  };
  const dice: AtlasPublicDiceAPI = {
    rollStatblock: (request) => disposed ? null : options?.dice?.rollStatblock(request) ?? null,
    rollingDiceForStatblock: (request) => disposed ? null : options?.dice?.rollingDiceForStatblock(request) ?? null,
    getStatblockRollHistory: (request) => disposed
      ? Object.freeze([])
      : options?.dice?.getStatblockRollHistory?.(request) ?? Object.freeze([]),
    repeatStatblockRoll: (request) => disposed ? null : options?.dice?.repeatStatblockRoll?.(request) ?? null,
  };
  const capabilities = Object.freeze([
    ...ATLAS_PUBLIC_API_CAPABILITIES,
    ...(options?.dice ? ['dice.statblock-rolls' as const] : []),
    ...(options?.dice?.getStatblockRollHistory && options?.dice?.repeatStatblockRoll
      ? ['dice.statblock-history' as const]
      : []),
  ]);
  const api = Object.freeze({
    apiVersion: ATLAS_PUBLIC_API_VERSION,
    capabilities,
    sheets: Object.freeze(sheets),
    dice: Object.freeze(dice),
  }) satisfies AtlasPublicAPI;
  return { api, dispose: () => { if (disposed) return; disposed = true; for (const session of [...renderSessions.values()]) endRenderSession(session); renderSessions.clear(); refreshQueues.clear(); providers.clear(); } };
}

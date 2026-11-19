import { App, WorkspaceLeaf, TFile, EventRef } from 'obsidian';
import { EventEmitter } from 'events';
import type { FederatedPointerEvent } from 'pixi.js';
import type { NotePin } from '../types';
import { toTokenVitals, type TokenVitals } from './statblockVitalsSync';
import { NotePreviewWindow } from './NotePreviewWindow';
import { StatblockPreviewWindow } from './StatblockPreviewWindow';
import { isStatblockNote, statblockNoteKnown } from '../statblocks/resolve/statblockNote';
import { statblockSourceOf } from '../statblocks/notes/statblockSource';
import type { AtlasPublicAPI } from '../api/sheets/types';
import { resolveForgeStatblockPreviewForToken } from './providerStatblockPreview';
import { MapLinkPreview } from './MapLinkPreview';
import { EncounterFolderPreview } from './EncounterFolderPreview';
import { isEncounterFolderLink } from '../links/atlasLinkTargets';
import { linkedEncounterFolder } from '../encounters/encounterFolders';
import { encountersInFolder, placeEncounter, rollEncounterFolder } from '../encounters/encounterFolderRoll';
import { atlasViewOfStore } from '../plugin/atlasLeaves';
import type { AtlasView } from '../atlas-view';
import { linkedFilePath, linkedMapPath, linkedSceneFile } from './sceneLinks';
import { runInBackground } from '../utils/backgroundTask';
import { t } from '../i18n';
import { findAtlasLeafByViewId } from '../utils/atlasLeafLookup';
import { readPinnedNotePreviews } from '../stores/pinnedNotePreviewSlice';
import { isModHeld } from '../keyboard/modKey';
import type { ViewAtlasStore } from '../storeFactory';
import type { TokenRollContext } from '../types/diceRollOrigin';
import { captureRollContext } from '../tools/diceRollOrigins';
import { mapTokens } from '../tokens/offMap';
import { shallow } from 'zustand/vanilla/shallow';

/**
 * A hovered token presented to the preview system like a pin on its linked
 * statblock note. The vitals travel with it so the statblock preview can mirror them.
 */
export interface TokenPreviewAnchor extends TokenVitals {
  id: string;
  notePath: string;
  x: number;
  y: number;
  type: 'token';
}

/** What a hover preview is anchored to: a map pin or a token. */
export type PreviewAnchor = NotePin | TokenPreviewAnchor;

/** The part of an anchor a preview window keeps; all a reopened pinned preview has. */
export type PreviewAnchorRef = Pick<PreviewAnchor, 'id' | 'notePath'>;

// Common interface for preview windows
export interface IPreviewWindow {
  notePath: string;
  element: HTMLElement | null;
  originatingPin?: PreviewAnchorRef | null;
  setPosition(x: number, y: number): void;
  getIsPinned(): boolean;
  /** True while the window is fading out and must not be reused for a new hover. */
  isClosing?(): boolean;
  hide(force?: boolean): void;
}

/** Preview windows cycle below this so they stay under the asset manager (50). */
const MAX_PREVIEW_Z_INDEX = 45;

/**
 * Owns a map view's CMD/Ctrl+hover preview windows. Pinned note previews are
 * saved with the map and reopen, where they were left, whenever it loads.
 */
export class NotePreviewUIManager {
  private app: App;
  private eventBus: EventEmitter;
  private store: ViewAtlasStore;
  private viewId: string;
  /** Set while the asset manager covers the map and the previews are hidden. */
  private suspended = false;
  /** The manager may be destroyed while vault reads are still resolving. */
  private destroyed = false;
  /**
   * Set from the moment another map starts loading until it has loaded. The
   * store then no longer holds the previews' map, so nothing may be saved into it.
   */
  private mapUnloading = false;
  private activePreviews: Map<string, IPreviewWindow> = new Map();
  /** Deduplicates first-hover creation when modifier-key events arrive together. */
  private readonly forgeInstanceCreations = new Map<string, Promise<void>>();
  private isModifierKeyDown = false;
  /** Counts `hideAllUnpinnedPreviews`, so a preview decided after a read knows it was hidden or replaced meanwhile. */
  private hideCount = 0;
  private lastHoveredPinId: string | null = null;
  /**
   * Element under the pointer, kept until it leaves; replayed on each CMD/Ctrl press. A
   * hovered token keeps the scene it was hovered in, which rolls from its statblock name.
   */
  private currentHover: {
    pin: PreviewAnchor;
    screenX: number;
    screenY: number;
    sourceLeaf: WorkspaceLeaf | null;
    originContext: TokenRollContext | undefined;
  } | null = null;
  private boundHideAllUnpinnedPreviewsOnBlur!: () => void;
  private boundHandleKeyDown!: (e: KeyboardEvent) => void;
  private boundHandleKeyUp!: (e: KeyboardEvent) => void;
  private boundHandleFocus!: () => void;
  /** The map view's container, once `setViewElement` was called. */
  private viewEl: HTMLElement | null = null;
  private activeLeafChangeRef: EventRef | null = null;
  private layoutChangeRef: EventRef | null = null;
  private zIndexCounter = 5; // stay below asset manager (50) and Obsidian overlays (~1000)

  private readonly onPinHoverPreview = (data: {
    pin: PreviewAnchor;
    screenX: number;
    screenY: number;
    pixiEvent?: FederatedPointerEvent;
    sourceLeaf?: WorkspaceLeaf | null;
  }): void => {
    if (this.destroyed || this.mapUnloading) return;
    this.lastHoveredPinId = data.pin.id;

    let modifierKeyDown = this.isModifierKeyDown;
    if (data.pixiEvent) modifierKeyDown = isModHeld(data.pixiEvent);

    this.currentHover = {
      pin: data.pin, screenX: data.screenX, screenY: data.screenY, sourceLeaf: data.sourceLeaf ?? null,
      originContext: 'type' in data.pin && data.pin.type === 'token'
        ? captureRollContext(this.viewId, this.store.getState(), [data.pin.id])
        : undefined,
    };
    if (modifierKeyDown) this.showPreviewFor(this.currentHover);
  };

  private readonly onPinHidePreview = (data: { pin: PreviewAnchor }): void => {
    if (this.destroyed) return;
    if (this.lastHoveredPinId === data.pin.id) this.lastHoveredPinId = null;
    if (this.currentHover?.pin.id === data.pin.id) this.currentHover = null;
    if (!this.isModifierKeyDown) this.hidePreview(data.pin.id, false);
  };

  private readonly onCloseActivePreview = (notePath: string): void => {
    if (!this.destroyed) this.hidePreview(notePath);
  };

  private readonly onMapUnloading = (): void => {
    if (this.destroyed) return;
    // Persist pinned note previews before replacing the scene, then close all
    // windows. Statblock provider sessions are aborted synchronously by
    // StatblockPreviewWindow.hide(), before the fade-out removes the DOM.
    this.savePinnedPreviewStates();
    this.mapUnloading = true;
    this.hideCount++;
    this.isModifierKeyDown = false;
    this.forgetHover();
    this.closeAllPreviews();
  };

  private readonly onMapLoaded = (): void => {
    if (this.destroyed) return;
    this.mapUnloading = false;
    this.forgetHover();
    this.restorePinnedPreviews();
  };

  constructor(app: App, eventBus: EventEmitter, store: ViewAtlasStore, viewId: string, private readonly sheetsAPI?: AtlasPublicAPI | null) {
    this.app = app;
    this.eventBus = eventBus;
    this.store = store;
    this.viewId = viewId;

    // Styles are loaded via styles/main.scss → note-preview-window.scss
    this.boundHideAllUnpinnedPreviewsOnBlur = () => this.hideAllUnpinnedPreviews();
    this.initializeGlobalListeners();
  }

  private initializeGlobalListeners(): void {
    this.eventBus.on('pin-hover-preview', this.onPinHoverPreview);
    this.eventBus.on('pin-hide-preview', this.onPinHidePreview);

    // Bind methods to preserve 'this' context
    this.boundHandleKeyDown = this.handleKeyDown.bind(this);
    this.boundHandleKeyUp = this.handleKeyUp.bind(this);
    this.boundHandleFocus = () => { if (!this.destroyed) this.isModifierKeyDown = false; };
    
    document.addEventListener('keydown', this.boundHandleKeyDown);
    document.addEventListener('keyup', this.boundHandleKeyUp);
    window.addEventListener('blur', this.boundHideAllUnpinnedPreviewsOnBlur);
    // Reset modifier key state when window gains focus to avoid stuck state
    window.addEventListener('focus', this.boundHandleFocus);

    // The pin's note opens in the workspace, which replaces its hover preview; a pinned one stays as it was left
    this.eventBus.on('close-active-preview', this.onCloseActivePreview);
    this.eventBus.on('map-unloading', this.onMapUnloading);
    this.eventBus.on('map-loaded', this.onMapLoaded);

    // Leaving the map closes hover previews; pinned ones live in the map's leaf and hide with it
    this.activeLeafChangeRef = this.app.workspace.on('active-leaf-change', (leaf: WorkspaceLeaf | null) => {
      if (this.destroyed) return;
      if (!leaf) return;
      // Every map view listens to CMD/Ctrl on the whole document, another map's leaf included
      if (leaf !== findAtlasLeafByViewId(this.app.workspace, this.viewId)) {
        this.forgetHover();
      }
      const viewType = leaf.view?.getViewType?.();
      if (viewType !== 'atlas-vtt' && viewType !== 'atlas-vtt-player') {
        this.hideAllUnpinnedPreviews();
      }
      this.showStatblocksWithMap();
    });
    // A closed or moved tab can show or hide the map without another leaf becoming active
    this.layoutChangeRef = this.app.workspace.on('layout-change', () => {
      if (!this.destroyed) this.showStatblocksWithMap();
    });
  }

  /**
   * Statblock previews hang in the document, not in the map's leaf, so a pinned
   * one shows only while its map does, as a pinned note in the leaf would.
   */
  private showStatblocksWithMap(): void {
    const statblocks = [...this.activePreviews.values()].filter((preview) => preview instanceof StatblockPreviewWindow);
    if (statblocks.length === 0) return;
    const mapShown = !this.suspended
      && findAtlasLeafByViewId(this.app.workspace, this.viewId)?.view.containerEl.isShown() === true;
    for (const preview of statblocks) {
      if (mapShown) preview.element?.show();
      else preview.element?.hide();
    }
  }

  /**
   * Hover events only fire when the hovered element changes, so the remembered
   * hover must be dropped explicitly once its map is out of sight. Otherwise
   * every later CMD/Ctrl press replays its preview over another map or tab.
   */
  private forgetHover(): void {
    this.currentHover = null;
    this.lastHoveredPinId = null;
  }

  /**
   * Replaces the previous map's previews with the ones pinned on the map that
   * just loaded, at the position and size they were saved with.
   */
  private restorePinnedPreviews(): void {
    this.closeAllPreviews();
    const state = this.store.getState();
    if (state.isPlayerView) return;

    const sourceLeaf = findAtlasLeafByViewId(this.app.workspace, this.viewId);
    for (const saved of readPinnedNotePreviews(state.pinnedNotePreviews)) {
      const preview = new NotePreviewWindow(
        this.app,
        saved.notePath,
        { id: saved.anchorId, notePath: saved.notePath },
        this,
        undefined,
        sourceLeaf,
        saved,
      );
      this.trackNotePreview(preview);
      if (this.suspended) preview.element?.hide();
    }
  }

  /**
   * Saves a pinned preview's position, size, scroll and cursor with the map,
   * or forgets it once unpinned.
   */
  public handlePreviewStateChanged(preview: NotePreviewWindow): void {
    const state = this.store.getState();
    if (this.mapUnloading || state.isPlayerView || !preview.originatingPin) return;
    const pinned = preview.toPinnedNotePreview();
    if (!pinned) {
      state.removePinnedNotePreview(preview.originatingPin.id);
      return;
    }
    // Scrolling reports often; only real changes reach the store and the map file
    const saved = state.pinnedNotePreviews[pinned.anchorId];
    if (JSON.stringify(saved) !== JSON.stringify(pinned)) state.savePinnedNotePreview(pinned);
  }

  /** Records how every pinned note is left, before the map's state is saved. */
  public savePinnedPreviewStates(): void {
    this.activePreviews.forEach((preview) => {
      if (preview instanceof NotePreviewWindow) preview.saveStateNow();
    });
  }

  /** The user closed the preview, so it must not reopen with the map. */
  public handlePreviewDismissed(preview: NotePreviewWindow): void {
    if (preview.originatingPin) this.store.getState().removePinnedNotePreview(preview.originatingPin.id);
  }

  private showPreviewFor(hover: NonNullable<typeof this.currentHover>): void {
    if (this.destroyed || this.mapUnloading) return;
    runInBackground(
      this.showOrCreatePreview(hover.pin, hover.screenX, hover.screenY, hover.sourceLeaf, hover.originContext),
      'Showing note preview',
    );
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (this.destroyed) return;
    if (isModHeld(e)) {
      const justPressed = !this.isModifierKeyDown;
      this.isModifierKeyDown = true;
      if (justPressed && this.currentHover) {
        this.showPreviewFor(this.currentHover);
      }
    } else if (e.key === 'Escape') {
        this.hideAllUnpinnedPreviews(); // Or all previews including pinned ones
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    if (this.destroyed) return;
    if (!isModHeld(e)) {
      this.isModifierKeyDown = false;
      // Always hide all unpinned previews when modifier is released
      this.hideAllUnpinnedPreviews();
    }
  }
  
  /**
   * Forgets a window that closed. Matched by instance, not by key: a window
   * fading out may finish after a new one for the same anchor took its key.
   */
  public handlePreviewClosed(preview: IPreviewWindow): void {
    for (const [key, tracked] of this.activePreviews) {
      if (tracked === preview) this.activePreviews.delete(key);
    }
  }

  /**
   * Ask an enabled Forge plugin to connect to this Atlas API now. This closes
   * the startup-order gap where Forge loaded first, Atlas loaded afterwards,
   * and no workspace transition occurred to trigger Forge's registration retry.
   */
  private requestForgeProviderRegistration(): void {
    try {
      this.app.workspace.trigger('statblock-forge-atlas-provider-registration-requested');
    } catch {
      // Atlas may be unloading; the caller will retain the normal fallback.
    }
  }

  /** Create the provider instance on first Ctrl-hover, without guessing ambiguous bindings. */
  private async ensureForgeSheetInstance(sceneId: string, tokenId: string, sourceId: string): Promise<void> {
    const api = this.sheetsAPI;
    if (!api) return;
    const key = `${sceneId}::${tokenId}::${sourceId}`;
    const pending = this.forgeInstanceCreations.get(key);
    if (pending) return pending;

    const operation = (async (): Promise<void> => {
      try {
        const provider = api.sheets.getProviderDescriptor('statblock-forge');
        if (!provider?.capabilities.includes('rendering')) return;
        const existing = api.sheets.getInstances(sceneId).filter((instance) =>
          instance.sceneId === sceneId
          && instance.tokenId === tokenId
          && instance.source.providerId === 'statblock-forge'
          && instance.source.sourceId === sourceId,
        );
        if (existing.length > 0) return;
        await api.sheets.createInstance({
          sceneId,
          source: { providerId: 'statblock-forge', sourceId },
          tokenId,
        });
      } catch (error) {
        console.warn('[Atlas] Could not create the Forge sheet instance for this token:', error);
      }
    })();

    this.forgeInstanceCreations.set(key, operation);
    try { await operation; }
    finally { if (this.forgeInstanceCreations.get(key) === operation) this.forgeInstanceCreations.delete(key); }
  }

  public async showOrCreatePreview(
    pin: PreviewAnchor,
    screenX: number,
    screenY: number,
    sourceLeaf?: WorkspaceLeaf | null,
    /** The scene a hovered token was hovered in; a statblock opened for it rolls for that scene. */
    originContext?: TokenRollContext,
  ): Promise<void> {
    if (this.destroyed || this.mapUnloading) return;

    // First, check if we already have a preview for this exact pin
    const existingPreviewForPin = Array.from(this.activePreviews.values()).find(
      p => p.originatingPin?.id === pin.id && p.isClosing?.() !== true
    );
    
    if (existingPreviewForPin) {
      // If it's unpinned, update its position
      if (!existingPreviewForPin.getIsPinned()) {
        existingPreviewForPin.setPosition(screenX, screenY);
        this.raiseZIndex(existingPreviewForPin);
      } else {
        // If it's pinned, just bring it to front without moving
        this.raiseZIndex(existingPreviewForPin);
      }
      return;
    }

    // Hide all unpinned previews before creating a new one
    this.hideAllUnpinnedPreviews();
    
    if (isEncounterFolderLink(pin.notePath)) {
      await this.showEncounterFolderPreview(pin, screenX, screenY, sourceLeaf);
      return;
    }

    // Scene links → lightweight tooltip with thumbnail + "Open Map" button; nothing for a scene not in this collection
    if (linkedMapPath(pin.notePath)) {
      const scene = linkedSceneFile(this.app, this.store.getState().mapPath, pin.notePath);
      const mapPreview = scene ? new MapLinkPreview(this.app, scene, pin, this, { x: screenX, y: screenY }, this.previewDocument(sourceLeaf)) : null;
      if (mapPreview?.element) {
        this.activePreviews.set(`${pin.notePath}::${pin.id}`, mapPreview);
        this.raiseZIndex(mapPreview);
      }
      return;
    }

    // A token whose note is a statblock gets the statblock preview
    const file = this.app.vault.getAbstractFileByPath(linkedFilePath(pin.notePath));
    if (file instanceof TFile && 'type' in pin && pin.type === 'token') {
      // Only a note whose statblock is in a fence is read; a hide or another hover meanwhile wins.
      // The same predicate as the asset manager's and the DM screen's, so all three draw a note alike.
      const hides = this.hideCount;
      const sceneAtHover = this.store.getState();
      const sceneIdAtHover = sceneAtHover.mapLoaded ? sceneAtHover.mapPath : null;
      const [source, isStatblock] = await Promise.all([
        statblockSourceOf(this.app, file),
        Promise.resolve(statblockNoteKnown(this.app, file)).then((known) => known || isStatblockNote(this.app, file)),
      ]);
      if (this.destroyed || this.mapUnloading || hides !== this.hideCount) return;

      if (isStatblock) {
        // The token's current link is authoritative. An async note read must not mount a stale
        // provider instance after the token was relinked or its scene changed meanwhile.
        const latestState = this.store.getState();
        const latestToken = latestState.mapLoaded ? mapTokens(latestState.objects)[pin.id] : null;
        const latestStatblockPath = latestToken && 'statblockPath' in latestToken && typeof latestToken.statblockPath === 'string'
          ? latestToken.statblockPath
          : undefined;
        const latestLinkedPath = latestStatblockPath ? linkedFilePath(latestStatblockPath) : null;
        const linkedPath = linkedFilePath(pin.notePath);
        const stillSameSceneAndLink = !!sceneIdAtHover
          && latestState.mapLoaded
          && latestState.mapPath === sceneIdAtHover
          && latestLinkedPath === linkedPath;
        // Use the same API snapshot supplied to this map's ServiceManager, as in
        // 0.17.2 (the last confirmed-working Ctrl-hover path). The handshake only
        // asks Forge to register against this Atlas instance; it does not replace
        // the API object used to resolve and render the sheet.
        let providerResolution: ReturnType<typeof resolveForgeStatblockPreviewForToken> | null = null;
        if (source?.kind === 'forge' && stillSameSceneAndLink) {
          this.requestForgeProviderRegistration();
          providerResolution = resolveForgeStatblockPreviewForToken(this.sheetsAPI, sceneIdAtHover, pin.id, linkedPath);
        }
        if (providerResolution?.status === 'missing' && sceneIdAtHover && stillSameSceneAndLink && this.sheetsAPI) {
          await this.ensureForgeSheetInstance(sceneIdAtHover, pin.id, linkedPath);
          // A provider read can outlive the hover. Recheck the scene, token link and hide epoch.
          const afterCreateState = this.store.getState();
          const afterCreateToken = afterCreateState.mapLoaded ? mapTokens(afterCreateState.objects)[pin.id] : null;
          const afterCreatePath = afterCreateToken && 'statblockPath' in afterCreateToken
            && typeof afterCreateToken.statblockPath === 'string'
            ? linkedFilePath(afterCreateToken.statblockPath)
            : null;
          if (this.destroyed || this.mapUnloading || hides !== this.hideCount
            || !afterCreateState.mapLoaded || afterCreateState.mapPath !== sceneIdAtHover
            || afterCreatePath !== linkedPath) return;
          providerResolution = resolveForgeStatblockPreviewForToken(this.sheetsAPI, sceneIdAtHover, pin.id, linkedPath);
        }
        const providerRender = providerResolution?.status === 'ready' ? providerResolution.request : undefined;
        if (providerResolution && providerResolution.status !== 'ready' && providerResolution.status !== 'missing') {
          // An unavailable provider or ambiguous mapping deliberately uses the existing
          // source-aware LinkedStatblock path. Do not guess another instance.
          console.debug(`[Atlas] Forge provider preview not selected (${providerResolution.status}); using the native fallback.`);
        }
        const statblockPreview = new StatblockPreviewWindow(
          this.app, 
          pin.notePath, 
          pin,
          this, 
          { x: screenX, y: screenY },
          undefined,
          this.viewId,
          originContext,
          this.previewDocument(sourceLeaf),
          providerRender,
        );
        
        if (statblockPreview.element) {
          // A pinned preview stays open while the token changes on the map; a move changes nothing it shows.
          statblockPreview.followVitals((show) => this.store.subscribe(
            (state) => {
              const token = mapTokens(state.objects)[pin.id];
              return token ? toTokenVitals(token) : null;
            },
            show,
            { equalityFn: shallow },
          ));
          if (providerRender) {
            statblockPreview.followProviderData((refresh) => this.store.subscribe(
              (state) => state.sheetInstances[providerRender.instanceId]?.lastKnownDefinition ?? null,
              refresh,
            ));
          }
          const previewKey = `${pin.notePath}::${pin.id}`;
          this.activePreviews.set(previewKey, statblockPreview);
          this.raiseZIndex(statblockPreview);
          statblockPreview.element.addEventListener('mousedown', () => this.raiseZIndex(statblockPreview));
        } else {
          console.warn('[NotePreviewUIManager] Statblock preview element is null');
        }
        return;
      }
    }
    
    // Create a normal note preview window
    this.trackNotePreview(new NotePreviewWindow(
      this.app,
      pin.notePath,
      pin,
      this,
      { x: screenX, y: screenY },
      sourceLeaf ?? null,
    ));
  }

  /** The card of a pin that rolls encounters; nothing for a pin on a scene outside every collection. */
  private async showEncounterFolderPreview(pin: PreviewAnchor, screenX: number, screenY: number, sourceLeaf?: WorkspaceLeaf | null): Promise<void> {
    if (this.destroyed || this.mapUnloading) return;
    const folder = linkedEncounterFolder(this.store.getState().mapPath, pin.notePath);
    if (!folder) return;
    const hides = this.hideCount;
    const encounters = await encountersInFolder(this.app, folder);
    // A hide or another hover while the encounters were read wins
    if (this.destroyed || this.mapUnloading || hides !== this.hideCount) return;
    const view = (): AtlasView | null => atlasViewOfStore(this.app, this.store);
    const preview = new EncounterFolderPreview({
      folder,
      encounters,
      pin,
      position: { x: screenX, y: screenY },
      doc: this.previewDocument(sourceLeaf),
      roll: () => runInBackground(rollEncounterFolder(this.app, view(), folder), `Rolling an encounter from ${folder}`, t('pin.encounters.failed')),
      place: (encounter) => runInBackground(placeEncounter(this.app, view(), encounter), `Placing ${encounter.name}`, t('pin.encounters.failed')),
      onClosed: (closed) => this.handlePreviewClosed(closed),
    });
    this.activePreviews.set(`${pin.notePath}::${pin.id}`, preview);
  }

  private trackNotePreview(preview: NotePreviewWindow): void {
    const anchor = preview.originatingPin;
    if (!preview.element || !anchor) return;
    // Keyed by note path and pin ID so several pins of one note can each have a preview
    this.activePreviews.set(`${anchor.notePath}::${anchor.id}`, preview);
    this.raiseZIndex(preview);
    preview.element.addEventListener('mousedown', () => this.raiseZIndex(preview));
  }

  /**
   * Incremental z-index raise so the focused preview stays on top
   */
  private raiseZIndex(preview: IPreviewWindow): void {
    this.zIndexCounter = (this.zIndexCounter + 1) % MAX_PREVIEW_Z_INDEX;
    if (this.zIndexCounter < 5) this.zIndexCounter = 5; // maintain minimum

    if (preview.element) {
      preview.element.style.zIndex = `${this.zIndexCounter}`;
    }
  }

  private findPreview(notePathOrPinId: string): IPreviewWindow | undefined {
    for (const [key, p] of this.activePreviews.entries()) {
      if (p.originatingPin?.id === notePathOrPinId || p.notePath === notePathOrPinId || key === notePathOrPinId) {
        return p;
      }
    }
    return undefined;
  }

  public hidePreview(notePathOrPinId: string, force: boolean = false): void {
    if (this.destroyed) return;
    const preview = this.findPreview(notePathOrPinId);
    if (preview) {
      if (!preview.getIsPinned() || force) {
        preview.hide();
        // Note: The preview will call handlePreviewClosed which will remove it from the map
      }
    }
  }

  public hideAllUnpinnedPreviews(excludeNotePath?: string | null): void {
    if (this.destroyed) return;
    this.hideCount++;
    this.activePreviews.forEach((preview) => {
      if (preview.notePath === excludeNotePath && this.isModifierKeyDown) return; // Don't hide if it's the current hover target & mod down
      if (!preview.getIsPinned()) {
        preview.hide();
      }
    });
  }
  
  /** Closes every window, pinned ones included, without forgetting what the map saved. */
  private closeAllPreviews(): void {
    this.activePreviews.forEach((preview) => preview.hide(true));
    this.activePreviews.clear();
  }

  /**
   * Clears previews out of the way while the asset manager covers the map:
   * hover previews close, pinned ones are only hidden until `resumePreviews`.
   */
  public suspendPreviews(): void {
    this.suspended = true;
    this.hideAllUnpinnedPreviews();
    this.activePreviews.forEach((preview) => preview.element?.hide());
  }

  /** Shows the pinned previews hidden by `suspendPreviews` again. */
  public resumePreviews(): void {
    this.suspended = false;
    this.activePreviews.forEach((preview) => preview.element?.show());
    this.showStatblocksWithMap();
  }

  /** Gives the manager the map view's element, which pinned statblock previews keep within. */
  public setViewElement(containerEl: HTMLElement): void {
    this.viewEl = containerEl;
  }

  /** The map view's element, once the view has given it (`setViewElement`). */
  public mapViewElement(): HTMLElement | null {
    return this.viewEl;
  }

  /** The document a preview opens in: that of the leaf it was hovered in (a note in a popout has its own), else the map view's. */
  private previewDocument(sourceLeaf: WorkspaceLeaf | null | undefined): Document {
    return (sourceLeaf?.view.containerEl ?? this.viewEl)?.doc ?? document;
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.hideCount++;
    this.mapUnloading = true;
    this.isModifierKeyDown = false;
    this.forgetHover();
    this.eventBus.off('pin-hover-preview', this.onPinHoverPreview);
    this.eventBus.off('pin-hide-preview', this.onPinHidePreview);
    this.eventBus.off('close-active-preview', this.onCloseActivePreview);
    this.eventBus.off('map-unloading', this.onMapUnloading);
    this.eventBus.off('map-loaded', this.onMapLoaded);
    document.removeEventListener('keydown', this.boundHandleKeyDown);
    document.removeEventListener('keyup', this.boundHandleKeyUp);
    window.removeEventListener('blur', this.boundHideAllUnpinnedPreviewsOnBlur);
    window.removeEventListener('focus', this.boundHandleFocus);
    if (this.activeLeafChangeRef) {
      this.app.workspace.offref(this.activeLeafChangeRef);
      this.activeLeafChangeRef = null;
    }
    if (this.layoutChangeRef) {
      this.app.workspace.offref(this.layoutChangeRef);
      this.layoutChangeRef = null;
    }
    this.closeAllPreviews();
    this.viewEl = null;
  }
}

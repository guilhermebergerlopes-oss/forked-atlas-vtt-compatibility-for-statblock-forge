import 'obsidian';
import type { EventRef } from 'obsidian';
import type { ForgeStatblockTemplateChange } from '../forgeStatblockTemplateObserver';
import type { ForgeStatblockNoteChange } from '../forgeStatblockNoteObserver';
import type { ForgeStatblockTokenRefreshEvent } from '../forgeStatblockTokenRefresh';

declare module 'obsidian' {
  interface Workspace {
    /** Triggered by Atlas VTT when asset metadata changed and open asset lists should reload. */
    on(name: 'atlas-vtt:refresh-assets', callback: () => unknown, ctx?: unknown): EventRef;
    /** Triggered by Atlas VTT when a scene's thumbnail was written; open lists showing scenes should refresh it. */
    on(name: 'atlas-vtt:scene-thumbnail-updated', callback: (mapPath: string) => unknown, ctx?: unknown): EventRef;
    /** Triggered by Atlas VTT when a map view finished opening a scene; lists of recent scenes should reorder. */
    on(name: 'atlas-vtt:scene-opened', callback: (sceneId: string) => unknown, ctx?: unknown): EventRef;
    /** Triggered by Atlas VTT when a collection's settings (conditions, grid defaults, widgets…) changed. */
    on(name: 'atlas-vtt:collection-settings-changed', callback: (collectionId: string) => unknown, ctx?: unknown): EventRef;
    /** Triggered by Atlas VTT when the statblock beside a note appeared or went (`NoteStatblockPanel`). */
    on(name: 'atlas-vtt:statblock-panel-changed', callback: () => unknown, ctx?: unknown): EventRef;
    /** Triggered by Atlas VTT when a Forge-native Markdown note is changed or ceases to be a valid Forge source. */
    on(name: 'atlas-vtt:forge-statblock-note-changed', callback: (change: ForgeStatblockNoteChange) => unknown, ctx?: unknown): EventRef;
    /** Triggered by Atlas VTT after a Forge `.forgetemplate` is created, changed, moved, deleted, or becomes invalid. */
    on(name: 'atlas-vtt:forge-statblock-template-changed', callback: (change: ForgeStatblockTemplateChange) => unknown, ctx?: unknown): EventRef;
    /** Triggered after a validated Forge sheet snapshot refresh so open maps can reconcile linked tokens. */
    on(name: 'atlas-vtt:forge-statblock-token-refresh', callback: (change: ForgeStatblockTokenRefreshEvent) => unknown, ctx?: unknown): EventRef;
  }
}

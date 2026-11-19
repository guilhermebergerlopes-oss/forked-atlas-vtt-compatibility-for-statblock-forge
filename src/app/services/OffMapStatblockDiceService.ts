import { EventEmitter } from 'events';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { App } from 'obsidian';
import { ATLAS_VIEW_TYPE } from '../atlasViewType';
import type {
  AtlasPublicDiceRollHistoryEntry,
  AtlasPublicDiceRollHistoryRequest,
  AtlasPublicDiceRollReceipt,
  AtlasPublicDiceRollRepeatRequest,
  AtlasPublicRollingDice,
  AtlasPublicStatblockRollRequest,
  AtlasPublicStatblockRollingDiceRequest,
} from '../api/sheets/types';
import { AtlasUIContext, type AtlasUIContextValue } from '../react/root/AtlasUIContext';
import { DiceRollDisplay, type DiceRollSubscription } from '../react/components/dice/DiceRollDisplay';
import type { DiceRollResult } from '../types/diceTypes';
import type { DiceSet } from '../types/diceSetTypes';
import { parseStoredDiceSet } from '../gameSystems/diceSetValidation';
import { diceSetOfCollection, diceSetsOf } from './diceSets/collectionDiceSets';
import { collectionIdOfPath } from './assetPaths';
import { DiceTool } from '../tools/DiceTool';
import { offlineDiceInputs } from './offlineDiceInputs';
import { portalHost } from '../host/portalHost';

type RollListener = Parameters<DiceRollSubscription>[0];

interface AtlasMapDiceToolLike {
  rollDice(
    formula: string,
    source?: DiceRollResult['source'],
    origin?: unknown,
    options?: { set?: DiceSet; advantage?: 'advantage' | 'disadvantage' },
  ): DiceRollResult | null;
  rollingDice?(set?: DiceSet): ReturnType<DiceTool['rollingDice']>;
}

interface AtlasMapStoreLike {
  getState?: () => { diceLog?: DiceRollResult[] };
}

interface AtlasMapViewLike {
  containerEl?: HTMLElement & { isShown?: () => boolean };
  atlasStore?: AtlasMapStoreLike;
  getStore?: () => AtlasMapStoreLike;
  serviceManager?: {
    getToolController?: () => { getDiceTool?: () => AtlasMapDiceToolLike | null | undefined } | null | undefined;
    getStore?: () => AtlasMapStoreLike;
  };
}

interface RetainedStatblockRoll {
  entry: AtlasPublicDiceRollHistoryEntry;
  request: AtlasPublicStatblockRollRequest | null;
}

const MAX_STATBLOCK_HISTORY = 50;

/**
 * The public statblock dice service. It uses a visible map DiceTool when one
 * is available, otherwise the app-wide roller and overlay. Both paths share
 * the same parser and dice-set rules and deliberately create no token origin.
 */
export class OffMapStatblockDiceService {
  private readonly eventBus = new EventEmitter();
  private readonly tool: DiceTool;
  private collectionId: string | null = null;
  private readonly listeners = new Set<RollListener>();
  private readonly waiting: DiceRollResult[] = [];
  private readonly statblockHistory: RetainedStatblockRoll[] = [];
  private host: HTMLElement | null = null;
  private root: Root | null = null;
  private disposed = false;

  constructor(private readonly app: App, private readonly displayRolls = true) {
    this.tool = new DiceTool(
      this.eventBus,
      () => diceSetOfCollection(this.app, this.collectionId),
      offlineDiceInputs(),
    );
    this.eventBus.on('dice-rolled', this.onDiceRolled);
  }

  /** Rolls through Atlas' visible map tool when possible, otherwise its app-wide display. */
  rollStatblock(request: AtlasPublicStatblockRollRequest): AtlasPublicDiceRollReceipt | null {
    if (this.disposed || !this.validSource(request?.source) || typeof request.formula !== 'string'
      || request.formula.trim().length === 0 || request.formula.length > 2048) return null;

    const set = this.resolveSet(request.set);
    if (request.set && !set) return null;
    this.collectionId = collectionIdOfPath(request.source.statblockPath);
    const tokenName = this.cleanSourceName(request.source.tokenName);
    const abilityName = this.cleanSourceName(request.source.abilityName);
    const source: NonNullable<DiceRollResult['source']> = {
      type: 'statblock',
      statblockPath: request.source.statblockPath,
      ...(tokenName ? { tokenName } : {}),
      ...(abilityName ? { abilityName } : {}),
    };
    const options = set || request.advantage
      ? { ...(set ? { set } : {}), ...(request.advantage ? { advantage: request.advantage } : {}) }
      : undefined;
    // Visible map rolls stay in the map's persisted dice log. Hidden/no-map rolls
    // use the app-wide layer rather than disappearing behind an inactive tab.
    const mapTool = this.visibleMapDiceTool();
    const result = mapTool
      ? (options ? mapTool.rollDice(request.formula, source, undefined, options) : mapTool.rollDice(request.formula, source))
      : (options ? this.tool.rollDice(request.formula, source, undefined, options) : this.tool.rollDice(request.formula, source));
    if (!result) return null;
    this.rememberStatblockRoll(request, result);
    return Object.freeze({ id: result.id, formula: result.formula, total: result.total, timestamp: result.timestamp });
  }

  /** Gets collection or explicitly selected set rules for Forge's bonus and advantage menus. */
  rollingDiceForStatblock(request: AtlasPublicStatblockRollingDiceRequest): AtlasPublicRollingDice | null {
    if (this.disposed || !this.validSource(request?.source)) return null;
    const set = this.resolveSet(request.set);
    if (request.set && !set) return null;
    this.collectionId = collectionIdOfPath(request.source.statblockPath);
    try {
      const rules = this.visibleMapDiceTool()?.rollingDice?.(set) ?? this.tool.rollingDice(set);
      return Object.freeze({
        dice: Object.freeze(rules.dice.map((die) => Object.freeze({ count: die.count, sides: die.sides }))),
        ...(rules.advantage ? { advantage: Object.freeze({ ...rules.advantage }) } : {}),
        ...(rules.disadvantage ? { disadvantage: Object.freeze({ ...rules.disadvantage }) } : {}),
      });
    } catch {
      return null;
    }
  }

  /** Returns recent rolls for one statblock, newest first, up to the public limit. */
  getStatblockRollHistory(request: AtlasPublicDiceRollHistoryRequest): readonly AtlasPublicDiceRollHistoryEntry[] {
    if (this.disposed || !request || typeof request.statblockPath !== 'string' || !request.statblockPath.trim()) {
      return Object.freeze([]);
    }
    const path = request.statblockPath.trim();
    const requestedLimit = request.limit ?? 10;
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(MAX_STATBLOCK_HISTORY, requestedLimit)) : 10;
    this.hydrateHistoryFromOpenMapLogs();
    const entries = this.statblockHistory
      .filter(({ entry }) => entry.statblockPath === path)
      .sort((left, right) => right.entry.timestamp - left.entry.timestamp)
      .slice(0, limit)
      .map(({ entry }) => Object.freeze({ ...entry }));
    return Object.freeze(entries);
  }

  /** Repeats a retained roll, preserving its statblock, formula, dice set and advantage. */
  repeatStatblockRoll(request: AtlasPublicDiceRollRepeatRequest): AtlasPublicDiceRollReceipt | null {
    if (this.disposed || !request || typeof request.id !== 'string' || !request.id.trim()) return null;
    this.hydrateHistoryFromOpenMapLogs();
    const retained = this.statblockHistory.find(({ entry }) => entry.id === request.id);
    if (!retained?.request) return null;
    return this.rollStatblock(retained.request);
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.eventBus.off('dice-rolled', this.onDiceRolled);
    this.listeners.clear();
    this.waiting.length = 0;
    this.statblockHistory.length = 0;
    this.root?.unmount();
    this.root = null;
    this.host?.remove();
    this.host = null;
    this.eventBus.removeAllListeners();
  }

  private readonly onDiceRolled = (result: DiceRollResult): void => {
    if (this.disposed) return;
    if (this.listeners.size === 0) {
      this.waiting.push(result);
      // A burst of rolls before React subscribes should not grow without bound.
      if (this.waiting.length > 20) this.waiting.shift();
    } else {
      for (const listener of this.listeners) listener(result, { muted: false });
    }
    if (this.displayRolls) this.mountDisplay();
  };

  private readonly subscribe: DiceRollSubscription = (onRoll) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(onRoll);
    for (const result of this.waiting.splice(0)) onRoll(result, { muted: false });
    return () => { this.listeners.delete(onRoll); };
  };

  private mountDisplay(): void {
    if (this.root || this.disposed) return;
    this.host = portalHost().createDiv({ cls: 'atlas-vtt-plugin atlas-off-map-dice-root' });
    this.root = createRoot(this.host);
    const context: AtlasUIContextValue = { app: this.app, view: null, pixiApp: null, renderer: null };
    this.root.render(createElement(AtlasUIContext.Provider, {
      value: context,
      // Preserve the 0.17.0 upstream display settings.
      children: createElement(DiceRollDisplay, { subscribe: this.subscribe, cardSounds: true }),
    }));
  }

  private visibleMapDiceTool(): AtlasMapDiceToolLike | null {
    try {
      const workspace = this.app.workspace as unknown as {
        getLeavesOfType?: (viewType: string) => Array<{ view?: unknown }>;
      };
      if (typeof workspace?.getLeavesOfType !== 'function') return null;
      for (const leaf of workspace.getLeavesOfType(ATLAS_VIEW_TYPE)) {
        const view = leaf.view as AtlasMapViewLike | undefined;
        const candidate = view?.serviceManager?.getToolController?.()?.getDiceTool?.();
        if (!candidate || typeof candidate.rollDice !== 'function') continue;
        const shown = typeof view.containerEl?.isShown === 'function' ? view.containerEl.isShown() : true;
        if (shown) return candidate;
      }
    } catch {
      // Broken/hidden map lookup falls back to the app-wide roller.
    }
    return null;
  }

  /** Rehydrate visible map history from Atlas' persisted scene logs after service reload. */
  private hydrateHistoryFromOpenMapLogs(): void {
    try {
      const workspace = this.app.workspace as unknown as {
        getLeavesOfType?: (viewType: string) => Array<{ view?: unknown }>;
      };
      if (typeof workspace?.getLeavesOfType !== 'function') return;
      const known = new Set(this.statblockHistory.map(({ entry }) => entry.id));
      for (const leaf of workspace.getLeavesOfType(ATLAS_VIEW_TYPE)) {
        const view = leaf.view as AtlasMapViewLike | undefined;
        const log = view?.atlasStore?.getState?.().diceLog
          ?? view?.getStore?.().getState?.().diceLog
          ?? view?.serviceManager?.getStore?.().getState?.().diceLog
          ?? [];
        for (const result of log) {
          const source = result?.source;
          if (!result || !source || source.type !== 'statblock' || typeof source.statblockPath !== 'string'
            || !source.statblockPath.trim() || known.has(result.id)) continue;
          const set = result.diceSet
            ? diceSetsOf(this.app).find((entry) => entry.id === result.diceSet?.id)
            : undefined;
          const request: AtlasPublicStatblockRollRequest = {
            formula: result.formula,
            source: {
              statblockPath: source.statblockPath,
              ...(source.tokenName ? { tokenName: source.tokenName } : {}),
              ...(source.abilityName ? { abilityName: source.abilityName } : {}),
            },
            ...(result.advantage ? { advantage: result.advantage } : {}),
            ...(set ? { set } : {}),
          };
          // Scene logs retain only the dice-set ID/name. If a custom set is no
          // longer registered, do not replay it with different collection rules.
          this.rememberStatblockRoll(request, result, !result.diceSet || Boolean(set));
          known.add(result.id);
        }
      }
    } catch {
      // App-wide history still works while this plugin session remains active.
    }
  }

  private rememberStatblockRoll(request: AtlasPublicStatblockRollRequest, result: DiceRollResult, repeatable = true): void {
    const source = result.source;
    const entry: AtlasPublicDiceRollHistoryEntry = Object.freeze({
      id: result.id,
      formula: result.formula,
      total: result.total,
      timestamp: result.timestamp,
      statblockPath: source?.statblockPath ?? request.source.statblockPath,
      ...(source?.tokenName ?? request.source.tokenName ? { tokenName: source?.tokenName ?? request.source.tokenName } : {}),
      ...(source?.abilityName ?? request.source.abilityName ? { abilityName: source?.abilityName ?? request.source.abilityName } : {}),
      ...(result.advantage ? { advantage: result.advantage } : {}),
      repeatable,
    });
    // Keep a defensive copy so later template edits cannot change a history replay.
    const retainedRequest: AtlasPublicStatblockRollRequest | null = repeatable ? {
      formula: request.formula,
      source: { ...request.source },
      ...(request.advantage ? { advantage: request.advantage } : {}),
      ...(request.set ? { set: this.cloneDiceSet(request.set) } : {}),
    } : null;
    const existing = this.statblockHistory.findIndex(({ entry: current }) => current.id === entry.id);
    if (existing >= 0) this.statblockHistory.splice(existing, 1);
    this.statblockHistory.unshift({ entry, request: retainedRequest });
    if (this.statblockHistory.length > MAX_STATBLOCK_HISTORY) this.statblockHistory.length = MAX_STATBLOCK_HISTORY;
  }

  private cloneDiceSet(set: DiceSet): DiceSet {
    return {
      ...set,
      dice: set.dice.map((die) => ({ ...die })),
      ...(set.advantage ? { advantage: { ...set.advantage } } : {}),
      ...(set.disadvantage ? { disadvantage: { ...set.disadvantage } } : {}),
      ...(set.explode ? { explode: { ...set.explode } } : {}),
    };
  }

  private validSource(source: AtlasPublicStatblockRollRequest['source'] | AtlasPublicStatblockRollingDiceRequest['source'] | undefined): source is AtlasPublicStatblockRollRequest['source'] {
    return Boolean(source && typeof source.statblockPath === 'string'
      && source.statblockPath.trim().length > 0 && source.statblockPath.length <= 2048);
  }

  private cleanSourceName(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const clean = value.trim();
    return clean.length > 0 && clean.length <= 256 ? clean : undefined;
  }

  private resolveSet(set: DiceSet | undefined): DiceSet | undefined {
    if (!set) return undefined;
    const registered = diceSetsOf(this.app).find((entry) => entry.id === set.id);
    if (registered) return registered;
    return parseStoredDiceSet(set) ?? undefined;
  }
}

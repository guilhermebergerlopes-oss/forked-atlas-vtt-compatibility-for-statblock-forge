import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const previewManager = readFileSync(new URL('../NotePreviewUIManager.ts', import.meta.url), 'utf8');
const serviceManager = readFileSync(new URL('../ServiceManager.ts', import.meta.url), 'utf8');

describe('Forge provider API discovery for Ctrl-hover previews', () => {
  it('preserves the constructor API snapshot used by the working 0.17.2 preview path', () => {
    expect(serviceManager).toContain('plugin?.publicAPI ?? null)');
    expect(serviceManager).not.toContain('() => plugin?.publicAPI ?? null');
    expect(previewManager).toContain('private readonly sheetsAPI?: AtlasPublicAPI | null');
  });

  it('resolves through the API snapshot passed to the map service, as in 0.17.2', () => {
    expect(previewManager).toContain('resolveForgeStatblockPreviewForToken(this.sheetsAPI, sceneIdAtHover, pin.id, linkedPath)');
    expect(previewManager).not.toContain('getCurrentSheetsAPI');
  });

  it('requests on-demand Forge registration before resolving the provider for Ctrl-hover', () => {
    expect(previewManager).toContain("this.app.workspace.trigger('statblock-forge-atlas-provider-registration-requested')");
    expect(previewManager).toContain('this.requestForgeProviderRegistration();');
    const requestIndex = previewManager.indexOf('this.requestForgeProviderRegistration();');
    const resolveIndex = previewManager.indexOf('providerResolution = resolveForgeStatblockPreviewForToken(this.sheetsAPI, sceneIdAtHover, pin.id, linkedPath)');
    expect(requestIndex).toBeGreaterThanOrEqual(0);
    expect(resolveIndex).toBeGreaterThan(requestIndex);
  });

  it('creates or reuses the token sheet instance when the provider exists but the instance is missing', () => {
    expect(previewManager).toContain("providerResolution?.status === 'missing'");
    expect(previewManager).toContain('await this.ensureForgeSheetInstance(sceneIdAtHover, pin.id, linkedPath)');
    expect(previewManager).toContain('providerResolution = resolveForgeStatblockPreviewForToken(this.sheetsAPI, sceneIdAtHover, pin.id, linkedPath)');
  });
});


describe('Fork identity', () => {
  it('uses the requested display-name slug consistently as the plugin ID', () => {
    expect(forkIdSource).toContain("export const FORK_PLUGIN_ID = 'forked-atlas-vtt-compatibility-for-statblock-forge'");
    expect(manifest).toContain("\"id\": \"forked-atlas-vtt-compatibility-for-statblock-forge\"");
    expect(manifest).toContain("\"name\": \"Forked Atlas VTT Compatibility for Statblock Forge\"");
  });
});

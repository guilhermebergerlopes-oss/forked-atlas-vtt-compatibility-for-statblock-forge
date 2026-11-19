import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calculateProviderPreviewWindowWidth, clearProviderPreviewWindowWidth, setProviderPreviewWindowWidth } from '../providerPreviewWidth';

function previewHarness(sheetWidth: string, insets = ['12px', '12px', '1px', '1px']) {
  const renderContainer = { dataset: { forgeSheetWidth: sheetWidth } };
  const mountPoint = {
    querySelector: (selector: string) => selector === '.atlas-sheet-render-container' ? renderContainer : null,
  };
  const style = {
    width: '',
    maxWidth: '',
    removeProperty(property: string) {
      if (property === 'width') this.width = '';
      if (property === 'max-width') this.maxWidth = '';
    },
  };
  const preview = {
    style,
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => ({
          paddingLeft: insets[0], paddingRight: insets[1],
          borderLeftWidth: insets[2], borderRightWidth: insets[3],
        }),
      },
    },
  };
  return { preview, mountPoint, style };
}

describe('provider preview width', () => {
  it('adds the Atlas preview frame insets to the configured sheet width', () => {
    expect(calculateProviderPreviewWindowWidth(560, 26, 1200)).toBe(586);
  });

  it('caps the outer preview width only when the available viewport is narrower', () => {
    expect(calculateProviderPreviewWindowWidth(560, 26, 500)).toBe(500);
  });

  it('sets the preview window to the provider sheet width plus its frame', () => {
    const harness = previewHarness('560');
    expect(setProviderPreviewWindowWidth(
      harness.preview as unknown as HTMLElement,
      harness.mountPoint as unknown as HTMLElement,
      1200,
    )).toBe(586);
    expect(harness.style.width).toBe('586px');
    expect(harness.style.maxWidth).toBe('1200px');
  });

  it('does not apply a width when the provider has not exposed one', () => {
    const harness = previewHarness('not-a-number');
    expect(setProviderPreviewWindowWidth(
      harness.preview as unknown as HTMLElement,
      harness.mountPoint as unknown as HTMLElement,
      1200,
    )).toBeNull();
    expect(harness.style.width).toBe('');
  });

  it('clears the provider width when falling back from a provider render', () => {
    const harness = previewHarness('560');
    setProviderPreviewWindowWidth(
      harness.preview as unknown as HTMLElement,
      harness.mountPoint as unknown as HTMLElement,
      1200,
    );
    clearProviderPreviewWindowWidth(harness.preview as unknown as HTMLElement);
    expect(harness.style.width).toBe('');
    expect(harness.style.maxWidth).toBe('');
  });

  it('synchronizes provider width and height after the render session is ready', () => {
    const source = readFileSync(new URL('../StatblockPreviewWindow.ts', import.meta.url), 'utf8');
    expect(source).toContain('setProviderPreviewWindowWidth(element, mountPoint, maxWindowWidth)');
    expect(source).toContain('setProviderPreviewWindowHeight(element, mountPoint, maxWindowHeight)');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calculateProviderPreviewWindowHeight, setProviderPreviewWindowHeight } from '../providerPreviewScroll';

interface MockBox {
  scrollHeight: number;
  firstElementChild?: MockBox | null;
  querySelector?: (selector: string) => MockBox | null;
  getBoundingClientRect: () => { height: number };
}

function box(scrollHeight: number): MockBox {
  return { scrollHeight, getBoundingClientRect: () => ({ height: scrollHeight }) };
}

function previewHarness(contentHeight: number, insets = '10px', maximumHeight = 500) {
  const body = box(contentHeight);
  const card = box(contentHeight);
  card.querySelector = (selector) => selector === '.atlas-statblock-body' ? body : null;
  const renderContainer = box(contentHeight);
  renderContainer.firstElementChild = card;
  const mountPoint = {
    querySelector: (selector: string) => selector === '.atlas-sheet-render-container' ? renderContainer : null,
  };
  const style = { height: '123px', maxHeight: '456px' };
  const preview = {
    style,
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => ({
          paddingTop: insets,
          paddingBottom: insets,
          borderTopWidth: '1px',
          borderBottomWidth: '1px',
        }),
      },
    },
  };
  return { preview, mountPoint, style, maximumHeight };
}

describe('provider preview height constraint', () => {
  it('uses the natural statblock height when the sheet fits', () => {
    expect(calculateProviderPreviewWindowHeight(300, 22, 500)).toBe(322);
  });

  it('caps a long statblock at the available window height', () => {
    expect(calculateProviderPreviewWindowHeight(1200, 22, 500)).toBe(500);
  });

  it('measures the rendered body after clearing the previous window constraint', () => {
    const harness = previewHarness(1200);
    const height = setProviderPreviewWindowHeight(
      harness.preview as unknown as HTMLElement,
      harness.mountPoint as unknown as HTMLElement,
      harness.maximumHeight,
    );
    expect(height).toBe(500);
    expect(harness.style.height).toBe('500px');
    expect(harness.style.maxHeight).toBe('500px');
  });

  it('preserves the natural size for a short statblock and includes the preview frame insets', () => {
    const harness = previewHarness(300, '10px', 500);
    const height = setProviderPreviewWindowHeight(
      harness.preview as unknown as HTMLElement,
      harness.mountPoint as unknown as HTMLElement,
      harness.maximumHeight,
    );
    expect(height).toBe(322);
    expect(harness.style.height).toBe('322px');
  });

  it('waits for the provider render session before measuring output', () => {
    const source = readFileSync(new URL('../StatblockPreviewWindow.ts', import.meta.url), 'utf8');
    expect(source).toContain('session.ready.then(() =>');
    expect(source).toContain('this.syncProviderPreviewWindowHeight();');
  });

  it('does nothing until Atlas has a provider render container and card', () => {
    const harness = previewHarness(300);
    const emptyMount = { querySelector: () => null };
    expect(setProviderPreviewWindowHeight(
      harness.preview as unknown as HTMLElement,
      emptyMount as unknown as HTMLElement,
      harness.maximumHeight,
    )).toBeNull();
    expect(harness.style.height).toBe('123px');
  });
});

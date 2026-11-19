// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { scrollOnCtrlWheel } from '../previewWheel';

function setDimension(element: HTMLElement, key: 'clientHeight' | 'scrollHeight' | 'clientWidth' | 'scrollWidth', value: number): void {
  Object.defineProperty(element, key, { configurable: true, value });
}

function makeScrollBox(className: string): HTMLDivElement {
  const box = document.createElement('div');
  box.className = className;
  box.style.overflow = 'auto';
  setDimension(box, 'clientHeight', 100);
  setDimension(box, 'scrollHeight', 500);
  setDimension(box, 'clientWidth', 100);
  setDimension(box, 'scrollWidth', 100);
  return box;
}

describe('Ctrl+wheel statblock preview scrolling', () => {
  let stop: (() => void) | null = null;
  let preview: HTMLDivElement | null = null;

  afterEach(() => {
    stop?.();
    stop = null;
    preview?.remove();
    preview = null;
  });

  it('scrolls the Forge statblock body for a long provider-rendered sheet', () => {
    preview = document.createElement('div');
    const viewport = makeScrollBox('atlas-statblock-body');
    const card = document.createElement('div');
    const word = document.createElement('span');
    word.textContent = 'long statblock';
    card.append(word);
    viewport.append(card);
    preview.append(viewport);
    document.body.append(preview);
    stop = scrollOnCtrlWheel(preview);

    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 120 });
    word.dispatchEvent(event);

    expect(viewport.scrollTop).toBe(120);
    expect(event.defaultPrevented).toBe(true);
  });

  it('passes scrolling to the Forge statblock body after a nested area reaches its end', () => {
    preview = document.createElement('div');
    const viewport = makeScrollBox('atlas-statblock-body');
    const inner = makeScrollBox('nested-statblock-table');
    const word = document.createElement('span');
    inner.append(word);
    viewport.append(inner);
    preview.append(viewport);
    document.body.append(preview);
    inner.scrollTop = inner.scrollHeight - inner.clientHeight;
    stop = scrollOnCtrlWheel(preview);

    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 120 });
    word.dispatchEvent(event);

    expect(inner.scrollTop).toBe(400);
    expect(viewport.scrollTop).toBe(120);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves ordinary wheel input to the browser', () => {
    preview = document.createElement('div');
    const viewport = makeScrollBox('atlas-statblock-body');
    const word = document.createElement('span');
    viewport.append(word);
    preview.append(viewport);
    document.body.append(preview);
    stop = scrollOnCtrlWheel(preview);

    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: false, deltaY: 120 });
    word.dispatchEvent(event);

    expect(viewport.scrollTop).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });
});

/**
 * The provider renderer creates the statblock after Atlas has opened the hover window.
 * Measure its intrinsic height only after the provider is ready, then give the flex
 * preview window a definite height so the provider's own statblock body can shrink
 * and become the actual scrollport. A max-height alone is not a reliable flex basis
 * in Chromium's WebView when the parent itself has an automatic height.
 */
export function calculateProviderPreviewWindowHeight(
  contentHeight: number,
  verticalInsets: number,
  maximumHeight: number,
): number {
  const naturalHeight = Math.max(0, contentHeight) + Math.max(0, verticalInsets);
  return Math.max(0, Math.min(naturalHeight, Math.max(0, maximumHeight)));
}

export function setProviderPreviewWindowHeight(
  preview: Pick<HTMLElement, 'style' | 'ownerDocument'>,
  mountPoint: Pick<HTMLElement, 'querySelector'> | null,
  maximumHeight: number,
): number | null {
  if (!mountPoint) return null;

  const renderContainer = mountPoint.querySelector<HTMLElement>('.atlas-sheet-render-container');
  const card = renderContainer?.firstElementChild as HTMLElement | null | undefined;
  if (!renderContainer || !card) return null;

  // Remove the previous constraint before measuring. Otherwise scrollHeight may
  // describe the old, already-clamped viewport rather than the full statblock.
  preview.style.height = 'auto';
  preview.style.maxHeight = '';

  const body = card.querySelector<HTMLElement>('.atlas-statblock-body');
  const contentHeight = Math.max(
    renderContainer.scrollHeight,
    card.scrollHeight,
    body?.scrollHeight ?? 0,
    renderContainer.getBoundingClientRect().height,
    card.getBoundingClientRect().height,
  );
  const style = preview.ownerDocument.defaultView?.getComputedStyle(preview as HTMLElement);
  const verticalInsets = [style?.paddingTop, style?.paddingBottom, style?.borderTopWidth, style?.borderBottomWidth]
    .reduce((sum, value) => sum + (Number.parseFloat(value ?? '') || 0), 0);
  const height = calculateProviderPreviewWindowHeight(contentHeight, verticalInsets, maximumHeight);

  preview.style.maxHeight = `${maximumHeight}px`;
  preview.style.height = `${height}px`;
  return height;
}

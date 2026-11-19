/**
 * Uses the Forge provider's effective sheet width to size Atlas' Ctrl-hover window.
 * Atlas preview padding and borders are included so the inner statblock keeps its
 * configured pixel width. The viewport cap applies only when the sheet cannot fit.
 */
export function calculateProviderPreviewWindowWidth(
  sheetWidth: number,
  horizontalInsets: number,
  maximumWidth: number,
): number {
  const naturalWidth = Math.max(0, sheetWidth) + Math.max(0, horizontalInsets);
  return Math.max(0, Math.min(naturalWidth, Math.max(0, maximumWidth)));
}

export function setProviderPreviewWindowWidth(
  preview: Pick<HTMLElement, 'style' | 'ownerDocument'>,
  mountPoint: Pick<HTMLElement, 'querySelector'> | null,
  maximumWidth: number,
): number | null {
  if (!mountPoint) return null;
  const renderContainer = mountPoint.querySelector<HTMLElement>('.atlas-sheet-render-container');
  if (!renderContainer) return null;
  const sheetWidth = Number(renderContainer.dataset.forgeSheetWidth);
  if (!Number.isFinite(sheetWidth) || sheetWidth <= 0) return null;

  const style = preview.ownerDocument.defaultView?.getComputedStyle(preview as HTMLElement);
  const horizontalInsets = [
    style?.paddingLeft,
    style?.paddingRight,
    style?.borderLeftWidth,
    style?.borderRightWidth,
  ].reduce((sum, value) => sum + (Number.parseFloat(value ?? '') || 0), 0);
  const width = calculateProviderPreviewWindowWidth(sheetWidth, horizontalInsets, maximumWidth);
  preview.style.maxWidth = `${Math.max(0, maximumWidth)}px`;
  preview.style.width = `${width}px`;
  return width;
}

export function clearProviderPreviewWindowWidth(preview: Pick<HTMLElement, 'style'> | null): void {
  preview?.style.removeProperty('width');
  preview?.style.removeProperty('max-width');
}

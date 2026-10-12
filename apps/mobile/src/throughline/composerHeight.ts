/** Device-local editor height; the existing composer still owns its card and feed inset. */
export const DEFAULT_COMPOSER_EDITOR_HEIGHT = 170;
export const MIN_COMPOSER_EDITOR_HEIGHT = 96;
export function isComposerEditorHeight(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 24 && value <= 10000;
}
export function composerHeightBounds(
  windowHeight: number,
  keyboardHeight: number,
  reservedHeight: number,
) {
  const max = Math.max(24, windowHeight - keyboardHeight - reservedHeight);
  return { min: Math.min(MIN_COMPOSER_EDITOR_HEIGHT, max), max };
}
export function clampComposerHeight(
  value: number | undefined,
  bounds: ReturnType<typeof composerHeightBounds>,
) {
  const height = isComposerEditorHeight(value) ? value : DEFAULT_COMPOSER_EDITOR_HEIGHT;
  return Math.min(bounds.max, Math.max(bounds.min, height));
}
export function dragComposerHeight(
  startHeight: number,
  dy: number,
  bounds: ReturnType<typeof composerHeightBounds>,
) {
  return Math.min(bounds.max, Math.max(bounds.min, startHeight - dy));
}

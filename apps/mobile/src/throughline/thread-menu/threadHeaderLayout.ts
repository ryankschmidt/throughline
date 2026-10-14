// One iOS header button: a 44-point glass button plus the 8-point gap UIKit leaves between items.
const HEADER_BUTTON_SLOT = 52;
const HEADER_EDGE_MARGINS = 32;
const MIN_TITLE_WIDTH = 72;
const MAX_TITLE_WIDTH = 260;

/**
 * Width for the compact thread title beside the thread menu: the room the header buttons
 * leave, so the title reads as far as it can (desktop shows it whole). `leadingButtons` is
 * the slots reserved before the title (the back or Home button); the thread menu after the
 * title is reserved here.
 */
export function compactThreadTitleWidth(input: {
  readonly windowWidth: number;
  readonly leadingButtons: number;
  readonly trailingButtons: number;
}): number {
  const room =
    input.windowWidth -
    HEADER_EDGE_MARGINS -
    (input.leadingButtons + 1 + input.trailingButtons) * HEADER_BUTTON_SLOT;
  return Math.max(MIN_TITLE_WIDTH, Math.min(MAX_TITLE_WIDTH, Math.floor(room)));
}

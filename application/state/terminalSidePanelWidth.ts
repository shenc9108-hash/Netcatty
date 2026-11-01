export const TERMINAL_SIDE_PANEL_MIN_WIDTH = 280;
export const TERMINAL_SIDE_PANEL_MAX_WIDTH = 1200;
export const TERMINAL_SIDE_PANEL_MIN_TERMINAL_WIDTH = 320;
export const TERMINAL_SIDE_PANEL_TOOL_BUTTON_WIDTH = 28;
export const TERMINAL_SIDE_PANEL_TOOLBAR_RESERVED_WIDTH = 200;

export function getTerminalSidePanelAvailableWidth(
  terminalLayerWidth: number,
  occupiedSiblingWidth: number,
): number {
  return Math.max(0, terminalLayerWidth - occupiedSiblingWidth);
}

/**
 * A phone viewport cannot host a side panel and a terminal side by side: reserving
 * TERMINAL_SIDE_PANEL_MIN_TERMINAL_WIDTH (320px) next to TERMINAL_SIDE_PANEL_MIN_WIDTH
 * (280px) needs 600px before either pane is usable. On Android the bridge stacks the
 * panel above the terminal instead, so the panel is allowed the full surface width.
 */
function isPhoneViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return document.documentElement.classList.contains('android')
    || window.innerWidth <= 600;
}

export function getTerminalSidePanelMaxWidth(availableSurfaceWidth: number): number {
  if (isPhoneViewport()) {
    // Panel and terminal are stacked, so nothing has to be reserved beside it.
    return Math.max(TERMINAL_SIDE_PANEL_MIN_WIDTH, Math.min(TERMINAL_SIDE_PANEL_MAX_WIDTH, availableSurfaceWidth));
  }
  const availableWidth = availableSurfaceWidth - TERMINAL_SIDE_PANEL_MIN_TERMINAL_WIDTH;
  return Math.max(
    TERMINAL_SIDE_PANEL_MIN_WIDTH,
    Math.min(TERMINAL_SIDE_PANEL_MAX_WIDTH, availableWidth),
  );
}

export function clampTerminalSidePanelWidth(
  width: number,
  availableSurfaceWidth: number,
  contentMinimumWidth = TERMINAL_SIDE_PANEL_MIN_WIDTH,
): number {
  // Stacks above the terminal on phones, so it may use the whole surface.
  if (isPhoneViewport()) {
    return Math.max(0, Math.min(availableSurfaceWidth, Math.max(width, TERMINAL_SIDE_PANEL_MIN_WIDTH)));
  }
  const maximumWidth = getTerminalSidePanelMaxWidth(availableSurfaceWidth);
  const minimumWidth = Math.min(
    maximumWidth,
    Math.max(TERMINAL_SIDE_PANEL_MIN_WIDTH, contentMinimumWidth),
  );
  return Math.max(minimumWidth, Math.min(maximumWidth, width));
}

export function getTerminalSidePanelMaxShownTools(panelWidth: number): number {
  return Math.max(
    1,
    Math.floor(
      (panelWidth - TERMINAL_SIDE_PANEL_TOOLBAR_RESERVED_WIDTH)
      / TERMINAL_SIDE_PANEL_TOOL_BUTTON_WIDTH,
    ),
  );
}

export const TERMINAL_SIDE_PANEL_MIN_HEIGHT = 200;
export const TERMINAL_SIDE_PANEL_MAX_HEIGHT = 1200;
export const TERMINAL_SIDE_PANEL_MIN_TERMINAL_HEIGHT = 240;
// Shared tab toolbar rendered above the pane tree (`h-9`).
export const TERMINAL_SIDE_PANEL_TOOLBAR_HEIGHT = 36;

export function getTerminalSidePanelAvailableHeight(
  terminalLayerHeight: number,
  occupiedSiblingHeight: number,
): number {
  return Math.max(0, terminalLayerHeight - occupiedSiblingHeight);
}

export function getTerminalSidePanelMaxHeight(availableSurfaceHeight: number): number {
  const availableHeight = availableSurfaceHeight - TERMINAL_SIDE_PANEL_MIN_TERMINAL_HEIGHT;
  return Math.max(
    0,
    Math.min(TERMINAL_SIDE_PANEL_MAX_HEIGHT, availableHeight),
  );
}

export function clampTerminalSidePanelHeight(
  height: number,
  availableSurfaceHeight: number,
  contentMinimumHeight = TERMINAL_SIDE_PANEL_MIN_HEIGHT,
): number {
  const maximumHeight = getTerminalSidePanelMaxHeight(availableSurfaceHeight);
  const minimumHeight = Math.min(
    maximumHeight,
    Math.max(TERMINAL_SIDE_PANEL_MIN_HEIGHT, contentMinimumHeight),
  );
  return Math.max(minimumHeight, Math.min(maximumHeight, height));
}

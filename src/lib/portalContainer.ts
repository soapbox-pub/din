/**
 * Where menus, dialogs, and other overlays mount: the desktop's layer
 * (index.html's `#shell`), so they stay visible and usable while it's a
 * modal dialog for a fullscreen web page (PageFullscreenHost.tsx). Falls
 * back to `<body>` where there's no such layer (tests).
 */
export function portalContainer(): HTMLElement {
  return document.getElementById('shell') ?? document.body;
}

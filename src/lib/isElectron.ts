/**
 * Whether Electron's <webview> tag is available in this renderer.
 *
 * The tag is only registered when the host BrowserWindow sets
 * `webPreferences.webviewTag: true` (see electron/main.cjs). In a plain web
 * browser (e.g. `make dev-browser`) it is absent, so the web browser app
 * falls back to an <iframe>.
 *
 * We detect it via the userAgent rather than probing the custom element,
 * because the element is registered lazily and reliably reported through the
 * Electron UA token.
 */
export function isWebviewAvailable(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /\bElectron\//.test(navigator.userAgent);
}

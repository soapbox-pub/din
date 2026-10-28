/**
 * window.dinos: the desktop's bridge to Electron, one namespace per area
 * (electron/preload.cjs). It exists only in the desktop's main frame, and
 * only inside Electron. Each namespace's type is declared next to the
 * src/lib/ file that wraps it, by augmenting `Dinos`. docs/dinos/README.md.
 */
declare global {
  interface Dinos {
    readonly version: 1;
  }

  interface Window {
    dinos?: Dinos;
  }
}

export {};

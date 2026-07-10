import type { DetailedHTMLProps, HTMLAttributes } from 'react';

/**
 * JSX typing for Electron's <webview> tag, used by the web browser app when
 * running inside the Electron shell (webPreferences.webviewTag). Only the
 * attributes the shell actually sets are declared.
 */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          src?: string;
          partition?: string;
          allowpopups?: boolean;
        },
        HTMLElement
      >;
    }
  }
}

export {};

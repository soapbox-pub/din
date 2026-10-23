import { createContext, useContext } from 'react';

/** The id of the app whose window this content is in. Provided by Window. */
export const WindowAppContext = createContext<string | null>(null);

/** The hosting window's app id; `null` outside a Window. */
export function useWindowAppId(): string | null {
  return useContext(WindowAppContext);
}

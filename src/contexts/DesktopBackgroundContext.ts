import { createContext, useContext } from 'react';

/** A picture for the desktop: a local file, or an https URL. */
export type DesktopBackgroundSource = { path: string } | { url: string };

export interface DesktopBackgroundContextValue {
  /** Ask for a picture with the file picker and make it the background. */
  chooseBackground(): Promise<void>;
  /**
   * Make a picture the desktop background. A local file going into a synced
   * profile theme is only uploaded once the user agrees.
   */
  setBackground(source: DesktopBackgroundSource): Promise<void>;
}

export const DesktopBackgroundContext = createContext<DesktopBackgroundContextValue | undefined>(
  undefined,
);

/** Set the desktop background. Must be used within the Desktop. */
export function useDesktopBackground(): DesktopBackgroundContextValue {
  const ctx = useContext(DesktopBackgroundContext);
  if (!ctx) {
    throw new Error('useDesktopBackground must be used within a Desktop');
  }
  return ctx;
}

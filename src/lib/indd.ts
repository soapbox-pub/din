/**
 * Typed access to the InDesign bridge exposed by the Electron preload
 * (`window.dinos.indd`, see electron/preload.cjs + electron/indd.mts), which reads
 * an INDD file into an IDML package. In a plain browser it is absent.
 */

export interface InddConversion {
  /** The IDML package (a ZIP file). */
  idml: Uint8Array;
  /** InDesign's previews of linked graphics, by the `Self` of each graphic. */
  previews: { graphics: string[]; data: Uint8Array }[];
  /** What didn't convert exactly. */
  warnings: string[];
}

export interface InddBridge {
  convert(bytes: Uint8Array, name: string): Promise<InddConversion>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    indd?: InddBridge;
  }
}

/** The InDesign bridge, or undefined when running outside the Electron shell. */
export function getInddBridge(): InddBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.indd;
}

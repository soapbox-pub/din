/**
 * The Web Browser's query stripping, for the desktop: the list and the
 * stripper live with the main process's (electron/tracking-params.mts), which
 * takes tracking tokens off a page's request before it's sent; the address
 * bar takes them off what it shows with the same.
 */
export { stripTrackingParams } from '../../electron/tracking-params.mts';

// What the built-in ad blocker's background page gets from the filter
// engine (bundled by scripts/build-adblock-engine.mjs), and the query
// stripping it does whatever the blocker's settings (electron/tracking-params.mts).
export { FiltersEngine, Request } from '@ghostery/adblocker';
export { stripTrackingParams } from '../electron/tracking-params.mts';

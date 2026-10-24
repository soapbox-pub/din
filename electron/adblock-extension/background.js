// Background page of Din's built-in ad blocker (see electron/adblock.mts).
//
// Network blocking for the browser's persistent session happens here, through
// chrome.webRequest, so it coexists with other installed extensions: a
// session.webRequest listener in the main process would switch theirs off.
// The main process owns the filter lists and settings; it hands this page a
// serialized engine and the settings over the `dinAdblock` bridge
// (electron/adblock-preload.cjs), and this page reports back what it blocked.
//
// Electron gives every request a tabId of -1, so pages are told apart by
// documentId instead: a top document's requests name the site it's on (their
// initiator), and a frame's requests name their parent's document, which
// leads back to a top one. That site is what the user's allowlist is keyed
// on, and what blocked requests are reported against.
//
// `DinAdblockEngine` comes from engine.js (scripts/build-adblock-engine.mjs).

/* global chrome, DinAdblockEngine, dinAdblock */
'use strict';

const { FiltersEngine, Request } = DinAdblockEngine;

/** @type {InstanceType<typeof FiltersEngine> | null} */
let engine = null;
let enabled = true;
/** Hostnames the user turned blocking off for. */
let allowlist = new Set();

/** The site each document is part of, by documentId. */
const documentSites = new Map();
const MAX_DOCUMENTS = 5000;

/** URLs blocked in each top document, by documentId (to count each once). */
const blockedIn = new Map();

/** Blocked URLs not yet reported to the main process, by site. */
const unreported = new Map();
let reportTimer = 0;

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function remember(map, key, value) {
  map.set(key, value);
  if (map.size > MAX_DOCUMENTS) map.delete(map.keys().next().value);
}

/** The site a request's page is on, and the top document it belongs to. */
function pageOf(details) {
  if (details.type === 'main_frame') return { site: hostnameOf(details.url), top: '' };
  const parent = details.parentDocumentId && documentSites.get(details.parentDocumentId);
  const page = parent ?? {
    site: hostnameOf(details.initiator ?? ''),
    top: details.frameId === 0 ? (details.documentId ?? '') : '',
  };
  if (details.documentId && !documentSites.has(details.documentId)) {
    remember(documentSites, details.documentId, page);
  }
  return page;
}

function applySettings(settings) {
  enabled = settings.enabled;
  allowlist = new Set(settings.allowlist);
}

async function loadEngine() {
  const serialized = await dinAdblock.engine();
  engine = serialized ? FiltersEngine.deserialize(serialized) : null;
}

function requestOf(details) {
  return Request.fromRawDetails({
    requestId: details.requestId,
    url: details.url,
    sourceUrl: details.initiator,
    type: details.type,
  });
}

function reportBlocked({ site, top }, url) {
  if (!site) return;
  if (top) {
    let urls = blockedIn.get(top);
    if (!urls) {
      urls = new Set();
      remember(blockedIn, top, urls);
    }
    if (urls.has(url)) return;
    urls.add(url);
  }
  if (!unreported.has(site)) unreported.set(site, []);
  unreported.get(site).push(url);
  if (reportTimer) return;
  reportTimer = setTimeout(() => {
    reportTimer = 0;
    dinAdblock.reportBlocked([...unreported]);
    unreported.clear();
  }, 250);
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type === 'main_frame' || !enabled || !engine) return {};
    const page = pageOf(details);
    if (allowlist.has(page.site)) return {};
    const { match, redirect } = engine.match(requestOf(details));
    if (redirect) {
      reportBlocked(page, details.url);
      return { redirectUrl: redirect.dataUrl };
    }
    if (match) {
      reportBlocked(page, details.url);
      return { cancel: true };
    }
    return {};
  },
  { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
  ['blocking'],
);

// Filters can add a Content-Security-Policy to documents (`$csp`). Every
// top-level response's COOP also goes to the pop-up blocker (popups.mts),
// blocking on or off: a session.webRequest listener there would switch this
// one off.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.type === 'main_frame' && (details.statusCode < 300 || details.statusCode >= 400)) {
      const coop = details.responseHeaders?.find((h) => h.name.toLowerCase() === 'cross-origin-opener-policy');
      dinAdblock.reportDocument(details.url, coop?.value ?? null);
    }
    if (!enabled || !engine || allowlist.has(pageOf(details).site)) return {};
    const policy = engine.getCSPDirectives(requestOf(details));
    if (!policy) return {};
    const responseHeaders = details.responseHeaders ?? [];
    responseHeaders.push({ name: 'Content-Security-Policy', value: policy });
    return { responseHeaders };
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame', 'sub_frame'] },
  ['blocking', 'responseHeaders'],
);

dinAdblock.onSettings(applySettings);
dinAdblock.onEngineChanged(() => {
  loadEngine().catch((error) => console.error('adblock: engine reload failed', error));
});

dinAdblock
  .settings()
  .then(applySettings)
  .then(loadEngine)
  .catch((error) => console.error('adblock: startup failed', error));

// Builds the ad blocker's filter engine (electron/adblock.mts), as an
// Electron utility process: downloading the lists and parsing their tens of
// thousands of rules takes seconds of CPU, which would stall input routing
// in the main process.
//
// The lists come from Ghostery's CDN, which is what Ghostery's own extension
// reads: uBlock Origin's and EasyList's lists, mirrored about once a day
// from upstream and with scriptlet arguments already normalized for this engine,
// plus the scriptlet code that goes with them. (@ghostery/adblocker's
// `adsAndTrackingLists` point at a copy in its GitHub repo instead, which is
// refreshed by hand and was two months behind - long enough for YouTube to
// get past every one of its rules.)
//
// Ghostery's CDN mirrors uBlock filters' year lists but not the rest of what
// its filters.txt `!#include`s, so those come from uBlock Origin's own host
// (UPSTREAM): filters-general.txt is where uBO keeps its defenses against
// Ad-Shield and other ad reinjectors (gamebanana.com's, say), and without it
// those sites' ads came back as fast as the engine blocked them.
//
// Writes the serialized engine to the path given as the first argument, and
// the list revisions it was built from beside it. Exits 0 once a new engine
// is there, 2 if the lists haven't changed since the last build (the engine's
// mtime is bumped so it counts as fresh), 1 on failure. The main process
// reads the engine from there.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { CosmeticFilter, FiltersEngine } from '@ghostery/adblocker';

const CDN = 'https://cdn.ghostery.com/adblocker/resources';

/** Where uBlock Origin itself fetches uAssets' lists, in the order it tries them. */
const UPSTREAM_MIRRORS = [
  'https://ublockorigin.github.io/uAssets/filters',
  'https://ublockorigin.pages.dev/filters',
];

/**
 * The lists uBlock filters (filters.txt) includes that Ghostery's CDN lacks.
 * (filters-mobile.txt, the other, is only for uBO on phones.)
 */
const UPSTREAM = ['filters-general.txt', 'ubo-link-shorteners.txt'];

/** uBlock Origin's default lists, as Ghostery names them. */
const LISTS = [
  'ublock-filters',
  'ublock-filters-2020',
  'ublock-filters-2021',
  'ublock-filters-2022',
  'ublock-filters-2023',
  'ublock-filters-2024',
  'ublock-filters-2025',
  'ublock-filters-2026',
  'ublock-badware',
  'ublock-privacy',
  'ublock-abuse',
  'ublock-unbreak',
  'ublock-quick-fixes',
  'easylist',
  'easyprivacy',
  'plowe-0',
];
const RESOURCES = 'ublock-resources-json';

/**
 * What the lists' `!#if` directives see: uBlock Origin on Chromium. Without
 * this the engine keeps both sides of every `!#if`, and on YouTube that runs
 * a Firefox-only json-prune on JSON.parse that YouTube catches.
 */
const ENV: [string, boolean][] = [
  ['ext_ublock', true],
  ['env_chromium', true],
  ['cap_user_stylesheet', true],
];

const out = process.argv[2];
const revisionsFile = `${out}.revisions`;

async function fetchOk(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      throw new Error(`${url}: HTTP ${response.status}`);
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/** The latest revision of a list, or null if the CDN doesn't have it. */
async function latestRevision(name: string): Promise<string | null> {
  try {
    const { revisions } = (await (await fetchOk(`${CDN}/${name}/metadata.json`)).json()) as { revisions?: unknown };
    const latest = Array.isArray(revisions) ? revisions.at(-1) : undefined;
    return typeof latest === 'string' && /^[0-9a-f]+$/.test(latest) ? latest : null;
  } catch (error) {
    // A list that's gone (a year's list retired, say) isn't worth failing
    // over; the core ones are checked below.
    console.error(`adblock: no revision for ${name}:`, error);
    return null;
  }
}

async function download(name: string, revision: string): Promise<string> {
  return (await fetchOk(`${CDN}/${name}/${revision}/list.txt`)).text();
}

/**
 * A scriptlet's arguments as Ghostery's CDN gives them: unquoted and
 * percent-encoded, as the engine decodes each with decodeURIComponent (an
 * argument with a `%` in it, or a `|`-separated regexp next to commas, would
 * otherwise reach the scriptlet mangled, or throw).
 */
function normalizeScriptlets(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const at = line.indexOf('+js(');
      if (at === -1 || line.startsWith('!') || !/#@?#\+js\($/.test(line.slice(0, at + 4))) return line;
      const parsed = CosmeticFilter.parse(line)?.parseScript();
      if (!parsed) return line;
      return `${line.slice(0, at)}+js(${[parsed.name, ...parsed.args.map(encodeURIComponent)].join(', ')})`;
    })
    .join('\n');
}

/**
 * An upstream list, normalized, and its revision (a hash of it), or null if
 * no mirror has it: it's worth more to keep blocking with the rest.
 */
async function upstreamList(file: string): Promise<{ text: string; revision: string } | null> {
  for (const mirror of UPSTREAM_MIRRORS) {
    try {
      const text = normalizeScriptlets(await (await fetchOk(`${mirror}/${file}`)).text());
      return { text, revision: crypto.createHash('sha256').update(text).digest('hex') };
    } catch (error) {
      console.error(`adblock: couldn't fetch ${file} from ${mirror}:`, error);
    }
  }
  return null;
}

try {
  const names = [...LISTS, RESOURCES];
  const [cdnRevisions, upstream] = await Promise.all([
    Promise.all(names.map(async (name) => [name, await latestRevision(name)] as const)),
    Promise.all(UPSTREAM.map(async (file) => [file, await upstreamList(file)] as const)),
  ]);
  const revisions = Object.fromEntries(
    cdnRevisions.filter((entry): entry is readonly [string, string] => entry[1] !== null),
  );
  for (const name of [RESOURCES, 'ublock-filters', 'ublock-quick-fixes', 'easylist']) {
    if (!revisions[name]) throw new Error(`${name} is unavailable`);
  }
  const upstreamLists: string[] = [];
  for (const [file, list] of upstream) {
    if (!list) continue;
    revisions[file] = list.revision;
    upstreamLists.push(list.text);
  }

  // The environment is part of what was built, so changing it rebuilds.
  const key = JSON.stringify({ ...revisions, env: ENV });
  let previous = '';
  try {
    previous = fs.readFileSync(revisionsFile, 'utf8');
  } catch {
    // First build.
  }
  if (previous === key && fs.existsSync(out)) {
    const now = new Date();
    fs.utimesSync(out, now, now);
    process.exit(2);
  }

  const lists = await Promise.all(
    LISTS.filter((name) => revisions[name]).map((name) => download(name, revisions[name])),
  );
  const resources = await download(RESOURCES, revisions[RESOURCES]);
  const engine = FiltersEngine.parse([...lists, ...upstreamLists].join('\n'), {
    enableMutationObserver: true,
    loadCosmeticFilters: true,
    loadNetworkFilters: true,
    loadPreprocessors: true,
  });
  engine.updateEnv(new Map(ENV));
  engine.updateResources(resources, revisions[RESOURCES]);

  const partial = `${out}.partial`;
  fs.writeFileSync(partial, engine.serialize());
  fs.renameSync(partial, out);
  fs.writeFileSync(revisionsFile, key);
  process.exit(0);
} catch (error) {
  console.error('adblock: building the filter engine failed:', error);
  process.exit(1);
}

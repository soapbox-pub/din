---
name: nostr-dev
description: Core Nostr protocol development guide — choosing between existing NIPs and custom kinds, kind ranges (regular/replaceable/addressable), tag and content field design, event validation, the useNostr/useAuthor/useNostrPublish hooks, querying with TanStack Query, login with LoginArea, NIP-19 identifier basics, and the security model. Load whenever building or modifying any Nostr feature (events, queries, publishing, profiles, custom kinds).
---

# Nostr Protocol Integration

This project uses **Nostrify** (`@nostrify/react`) as its Nostr protocol framework, combined with TanStack Query for data fetching.

## When to reuse an existing NIP vs. create a new kind

1. **Always review existing NIPs first.** Use the NIP index tool, then read candidate NIPs in detail. The goal is to find the closest existing solution.
2. **Prefer extending existing NIPs** over creating custom kinds, even if it requires minor schema compromises. Custom kinds fragment the ecosystem.
3. **When existing NIPs are close but not perfect**, use the existing kind as the base and add domain-specific tags. Document extensions in `NIP.md`.
4. **Only generate a new kind** when no existing NIP covers the core functionality, the data structure is fundamentally different, or the use case needs different storage characteristics (regular/replaceable/addressable).
5. **If a tool to generate a new kind number is available, you MUST use it** — don't pick an arbitrary number.
6. **Custom kinds MUST include a NIP-31 `alt` tag** with a human-readable description.

## Kind Ranges

- **Regular** (1000 ≤ kind < 10000): stored permanently by relays. Notes, articles, etc.
- **Replaceable** (10000 ≤ kind < 20000): only the latest event per `pubkey+kind` is stored. Profile metadata, contact lists.
- **Addressable** (30000 ≤ kind < 40000): identified by `pubkey+kind+d-tag`; only the latest per combo is stored. Articles, long-form content.

Kinds below 1000 are "legacy"; their storage behavior is per-kind (e.g. kind 1 is regular, kind 3 is replaceable).

## Tag Design Principles

- **Kind = schema, tags = semantics.** Don't create new kinds just to represent a different category of the same data.
- **Relays only index single-letter tags.** Use `t` for categories so filters like `'#t': ['electronics']` work at the relay level. Multi-letter tags (`product_type`, etc.) force inefficient client-side filtering.
- **Filter at the relay.** Pass tag filters in the query rather than fetching everything and filtering in JS.
- **For community/niche apps**, tag events with a `t` and query by it: `createEvent({ kind: 1, content, tags: [['t', 'farming']] })`, then `nostr.query([{ kinds: [1], '#t': ['farming'] }])`. Don't do this for generic platforms.

## Content Field Design

- **Use `content` for** large freeform text or existing industry-standard JSON formats (GeoJSON, FHIR, Tiled). Kind 0 is the one exception where structured JSON goes in `content`.
- **Use tags for** queryable metadata and structured data — anything you might filter on.
- **Empty content is fine.** `content: ""` is idiomatic for tag-only events.
- If you need to filter by a field, it **must** be a tag — relays don't index content.

## NIP.md

`NIP.md` documents any custom kinds/schemas this project defines. If the file doesn't exist, this project has no custom kinds. **Whenever you generate a new kind or change a custom schema, create or update `NIP.md`.**

## Nostr Security Model

**CRITICAL:** Nostr private keys (`nsec`) are stored **in plaintext in `localStorage`**. Any JavaScript running on the origin can steal them. A single XSS = permanent, unrecoverable key theft across every Nostr client the user ever touches. **Treat XSS mitigation as the top-priority security concern.**

- **Never** use `dangerouslySetInnerHTML`, `innerHTML`, or `document.write` with event data, URL params, or other untrusted strings.
- **CSP is defense-in-depth**, not primary defense. `index.html` ships a restrictive CSP (`script-src 'self'`, `default-src 'none'`). Never relax it with `'unsafe-eval'`, `'unsafe-inline'` on `script-src`, or wildcard sources.
- **Sanitize every event-sourced URL** (`sanitizeUrl()` — https-only allowlist) before using it as `href`, `src`, iframe `src`, or CSS `url()`.
- **Sanitize every event-sourced string interpolated into CSS**. A malicious `font-family` or `url()` value can break out of the CSS context and inject rules.

Beyond XSS, Nostr is permissionless — signatures prove authorship, not trustworthiness. Filter by `authors` whenever trust is implied:

- **Admin/moderator/owner queries** — filter by trusted pubkeys.
- **Addressable events (kinds 30000–39999)** and **user-owned replaceable events** — filter by `authors`; the `d` tag alone is not a trust boundary.
- **Routes for addressable/replaceable events** — include the author in the URL (e.g. `/article/:npub/:slug`) so the filter can constrain on author.
- **Public UGC** (kind 1 notes, reactions, public feeds, discovery) — author filtering NOT required.

```ts
// ❌ Anyone can spoof this event
nostr.query([{ kinds: [30078], '#d': ['app-organizers'], limit: 1 }]);
// ✅ Only trust admin authors
nostr.query([{ kinds: [30078], authors: ADMIN_PUBKEYS, '#d': ['app-organizers'], limit: 1 }]);
```

For the full threat model — CSP walkthrough, `sanitizeUrl` / `sanitizeCssString` implementations, NIP-72 community moderation, and the pre-merge checklist — load the **`nostr-security`** skill.

## The `useNostr` Hook

```ts
import { useNostr } from '@nostrify/react';

function useCustomHook() {
  const { nostr } = useNostr();
  // nostr.query(filters) / nostr.event(event) / nostr.req(filters)
}
```

By default `nostr` uses the app's connection pool (reads from one relay, publishes to all configured). For targeted single-relay or relay-group calls, load the **`nostr-relay-pools`** skill.

## Querying with TanStack Query

Combine `useNostr` with `useQuery` in custom hooks:

```ts
function usePosts() {
  const { nostr } = useNostr();
  return useQuery({
    queryKey: ['posts'],
    queryFn: async (c) => nostr.query([{ kinds: [1], limit: 15 }], { signal: c.signal }),
  });
}
```

**Efficient query design** — minimize round-trips:

- **Combine kinds** in one filter: `{ kinds: [1, 6, 16], '#e': [eventId] }` and split by kind in JS. Don't run three parallel queries for repost variants.
- **Use multiple filter objects** in one query when different tag filters are needed.
- **Raise `limit`** when combining so you still get enough of each kind.
- Each query costs relay capacity and may count against rate limits.

**Event validation** — for kinds with required tags or strict schemas, filter query results through a validator:

```ts
function isValidCalendarEvent(event: NostrEvent): boolean {
  if (![31922, 31923].includes(event.kind)) return false;
  const d = event.tags.find(([n]) => n === 'd')?.[1];
  const title = event.tags.find(([n]) => n === 'title')?.[1];
  const start = event.tags.find(([n]) => n === 'start')?.[1];
  return Boolean(d && title && start);
}

const events = (await nostr.query([{ kinds: [31922, 31923], limit: 15 }]))
  .filter(isValidCalendarEvent);
```

Validation is optional for loose kinds (kind 1), but strongly recommended for custom kinds and kinds with required tags.

## The `useAuthor` Hook

Fetch profile metadata (kind 0) for a pubkey:

```tsx
import type { NostrEvent, NostrMetadata } from '@nostrify/nostrify';
import { useAuthor } from '@/hooks/useAuthor';

function Post({ event }: { event: NostrEvent }) {
  const author = useAuthor(event.pubkey);
  const metadata: NostrMetadata | undefined = author.data?.metadata;

  const displayName = metadata?.name ?? 'Anonymous';
  const profileImage = metadata?.picture;
  // ...
}
```

The `NostrMetadata` type (from `@nostrify/nostrify`) covers the standard kind-0 fields: `name`, `display_name`, `about`, `picture`, `banner`, `website`, `nip05`, `lud06`, `lud16`, `bot`. Read the type definition from the package if you need the exact field list.

## The `useNostrPublish` Hook

Publishes events (auto-adds a `client` tag). Always guard with `useCurrentUser`:

```tsx
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';

export function MyComponent() {
  const { user } = useCurrentUser();
  const { mutate: createEvent } = useNostrPublish();

  if (!user) return <span>You must be logged in.</span>;

  return (
    <button onClick={() => createEvent({ kind: 1, content: 'hello' })}>
      Publish
    </button>
  );
}
```

## Nostr Login

Use the `LoginArea` component (already in the project). It renders a single "Join" button when logged out (opens an `AuthDialog` supporting signup, extension, nsec, and remote signer) and becomes an account switcher when logged in. **Do not wrap it in conditional logic.**

```tsx
import { LoginArea } from '@/components/auth/LoginArea';

<LoginArea className="max-w-60" />
```

`LoginArea` is inline-flex by default. Pass `flex` or `w-full` to expand it; otherwise set a sensible `max-w-*`.

**Social apps should include a profile/account menu in the main navigation** for access to settings, profile editing, and logout — don't only show `LoginArea` in logged-out states.

## NIP-19 Identifiers

Nostr uses bech32-encoded identifiers (`npub1`, `nprofile1`, `note1`, `nevent1`, `naddr1`, `nsec1`). **All NIP-19 identifiers are routed at the URL root (`/:nip19`)**, handled by `src/pages/NIP19Page.tsx` — never nest them under `/note/`, `/profile/`, etc.

**Filters only accept hex.** Always decode before querying:

```ts
import { nip19 } from 'nostr-tools';

const decoded = nip19.decode(value);
if (decoded.type !== 'naddr') throw new Error('Unsupported identifier');
const { kind, pubkey, identifier } = decoded.data;

nostr.query([{
  kinds: [kind],
  authors: [pubkey],        // critical for addressable events
  '#d': [identifier],
}]);
```

Never treat `nsec1` or unknown prefixes as anything but a 404.

**For full details** (identifier-type comparison, populating `NIP19Page`, building NIP-19 links, security patterns), load the **`nip19-routing`** skill.

## Related Skills

These are specialized workflows — load the matching skill when needed:

- **`file-uploads`** — `useUploadFile` + Blossom + NIP-94 `imeta` tags.
- **`nostr-encryption`** — NIP-44 / NIP-04 via the user's signer (DMs, gift wraps, private content).
- **`nostr-relay-pools`** — `nostr.relay(url)` / `nostr.group([urls])` for targeted queries.
- **`nostr-security`** — full threat model, sanitization helpers, pre-merge checklist.
- **`nip19-routing`** — the root `/:nip19` route and identifier handling in depth.

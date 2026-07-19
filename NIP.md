# Din Nostr Schemas

This document describes how Din uses Nostr to store desktop state. Din does
not define any new event kinds; it builds on existing NIPs.

## Encrypted App Data (NIP-78, kind 30078)

Din stores per-user desktop state as [NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md)
"Arbitrary custom app data" events (kind 30078, addressable). All of Din's
`d` tags live under the reverse-DNS namespace `computer.din.*`, per NIP-78's
uniqueness recommendation.

### Encryption

The `content` field is always **NIP-44 encrypted to the user's own pubkey**
(encrypt-to-self). Relays only ever see opaque ciphertext. The plaintext is a
versioned JSON envelope:

```json
{ "v": 1, "data": <arbitrary JSON value> }
```

- `v` — envelope version, currently always `1`.
- `data` — the stored value; its schema depends on the `d` tag (see below).

If the user's signer does not support NIP-44, Din keeps the data local-only
and never publishes plaintext.

### Synchronization semantics

- **Addressable / last-write-wins:** relays keep only the latest event per
  `pubkey + kind + d`. Din reconciles local and remote copies by comparing
  the event `created_at` to the local cache timestamp; the newer copy wins.
- **Author-filtered reads:** Din only ever queries these events with
  `authors: [user.pubkey]` — the `d` tag alone is never treated as a trust
  boundary.
- Din also caches each value locally (keyed by pubkey) so the desktop works
  offline; sync is opportunistic.

### Keys currently in use

| `d` tag | `data` schema | Purpose |
|---|---|---|
| `computer.din.settings` | `{ "theme": "light" \| "dark" \| "system", "useAppBlossomServers": boolean }` | Desktop settings that roam across devices |
| `computer.din.pinned-apps` | `string[]` (app IDs) | Apps pinned to the taskbar |
| `computer.din.web-apps` | `{ "id": string, "name": string, "url": string, "icon"?: string }[]` | Websites installed as desktop apps (PWA-style); `url` and `icon` are https URLs |
| `computer.din.browser-history` | `{ "url": string, "title": string \| null, "visitedAt": number, "visits": number }[]` | Web browser history (unique https URLs, most recent first; `visitedAt` is Unix seconds), powering address-bar autocomplete |

### Example event

```json
{
  "kind": 30078,
  "pubkey": "<user pubkey>",
  "created_at": 1767225600,
  "tags": [["d", "computer.din.settings"]],
  "content": "<NIP-44 ciphertext of {\"v\":1,\"data\":{\"theme\":\"dark\",\"useAppBlossomServers\":true}}>",
  "sig": "..."
}
```

## Other kinds Din reads/writes (standard usage, no extensions)

| Kind | NIP | Usage |
|---|---|---|
| 0 | NIP-01 | Profile metadata (published on signup) |
| 10002 | NIP-65 | Relay list; read on login, published from Settings → Nostr & Storage |
| 10063 | BUD-03 | Blossom server list; read on login, published from Settings → Nostr & Storage |
| 16767 | Profile Themes | Active profile theme; read-only, applied as the OS theme |
| 22242 | NIP-42 | Relay authentication |

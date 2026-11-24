# `window.nostr` on web pages

Browser tabs, installed web apps and nsites get a NIP-07 `window.nostr`
(`electron/nostr-preload.cjs`). It holds no keys: every call goes through
main, which reads the caller's origin from its frame, to the desktop's
signer (`NostrBridgeHost`), which decides, asks the user when it has to, and
signs. Din's own apps get theirs from `window.din` instead
([din/theme-and-account.md](din/theme-and-account.md)) and act as the
desktop's account.

## Din's account, and the accounts a site holds

`window.nostr`'s own methods act as the account signed in to Din, as they
always have: switching Din's account switches them. Pages aren't told: no
account-change event is widely used (nostr-login's `nlAuth` is about its own
logins, and Alby's `window.nostr.on('accountChanged')` is in few live
clients).
A client that wants to hold its accounts itself, and keep acting as one
while the user switches Din, feature-detects `getSigner` and uses the two
additions.

```ts
interface NostrProvider extends NostrSigner {
  // NIP-07, as Din's account
  getPublicKey(): Promise<string>
  signEvent(event): Promise<NostrEvent>
  getRelays(): Promise<Record<string, { read: boolean; write: boolean }>>
  nip04: { encrypt(pubkey, plaintext); decrypt(pubkey, ciphertext) }
  nip44: { encrypt(pubkey, plaintext); decrypt(pubkey, ciphertext) }
  signPsbt(psbtHex: string): Promise<string>

  // Din's additions
  requestPublicKey(): Promise<string>             // the user gives the site an account
  getSigner(pubkey: string): Promise<NostrSigner> // pinned to an account the site holds
}
```

- **`getPublicKey()`** asks the first time a site wants Din's account
  ([How Din asks](#how-din-asks)), and after that answers unasked.
- A site **holds** an account once that account is connected to it: by
  `getPublicKey()` while it was Din's, or by `requestPublicKey()`.
- **`requestPublicKey()`** always asks: the user
  picks one of the accounts signed in to Din, and it resolves with its key.
  Picking one the site already holds just returns it.
- **`getSigner(pubkey)`** never asks. It resolves with a plain NIP-07 signer
  that always acts as `pubkey`, whatever Din's account is, and whose
  `getPublicKey()` answers at once; or it rejects with `NotFoundError` if the
  site doesn't hold it. A client keeps the keys it was given and calls this
  for each on load.
- What a site may do without asking is remembered per site **and per
  account** (`src/lib/signerPermissions.ts`, kept with each account).

```ts
if ('getSigner' in window.nostr) {
  const pubkey = await window.nostr.requestPublicKey() // "Add account"
  const signer = await window.nostr.getSigner(pubkey)  // later, and on load
}
```

## Service workers

A site's service worker has the same provider as `self.nostr`: tabs',
installed web apps' and nsites' alike, from `nostr-preload.cjs` registered as
a service-worker preload too, its calls answered by the worker's own IPC in
main, which reads the origin from the worker's scope. It acts as its pages
do, so a worker can sign with every window of its site closed: it can
connect its site, ask for an account, and use `getSigner(pubkey)` for any
account the site holds. What its site's remembered answers don't settle is
asked as a notification (below).

Din apps' workers get `self.nostr` from `din-app-worker-preload.cjs`
([din/background.md](din/background.md)), shaped like their
`window.nostr`.

## How Din asks

A question asked right after the user pressed something in the site's page
(main checks it, not just the page's word) is a dialog. Any other, a page
asking on load or from a background tab, a worker, a bunker client, is a
notification first: clicking it brings up the dialog, its Don't allow
button or dismissing it is a no. So a site can call `getPublicKey()` on load
without putting a dialog over itself, and nothing takes the screen while the
user is elsewhere. A no that wasn't remembered keeps the tab (or the site's
workers) from asking again until the page navigates or the user clicks in
one of the site's pages, and a site may ask at most 5 questions in 30
seconds.

## Errors

Rejections are `DOMException`s, so a client can tell them apart by `name`:

| `name` | Means | The client should |
|---|---|---|
| `NotFoundError` | The site doesn't hold that account (`getSigner`): never given, disconnected, or signed out of Din | Drop the account |
| `NotAllowedError` | The user (or what they remembered) said no, or Din won't ask now | Keep the account; only this failed |
| `TypeError` | A malformed call: a bad key, an event whose `pubkey` isn't the signer's | Fix the call |

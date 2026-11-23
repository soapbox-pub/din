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
always have: switching Din's account switches them, and pages hear about it
(the `nlAuth` event with `{ type: 'accountChanged' }` that nostr-login uses).
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

- **`getPublicKey()`** asks the first time a site wants Din's account (after
  a click on the page), and after that answers unasked.
- A site **holds** an account once that account is connected to it: by
  `getPublicKey()` while it was Din's, or by `requestPublicKey()`.
- **`requestPublicKey()`** always asks, and only after a click: the user
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

## Errors

Rejections are `DOMException`s, so a client can tell them apart by `name`:

| `name` | Means | The client should |
|---|---|---|
| `NotFoundError` | The site doesn't hold that account (`getSigner`): never given, disconnected, or signed out of Din | Drop the account |
| `NotAllowedError` | The user (or what they remembered) said no, or Din won't ask now | Keep the account; only this failed |
| `TypeError` | A malformed call: a bad key, an event whose `pubkey` isn't the signer's | Fix the call |

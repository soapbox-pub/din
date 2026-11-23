# `window.nostr` on web pages

Browser tabs, installed web apps and nsites get a NIP-07 `window.nostr`
(`electron/nostr-preload.cjs`). It holds no keys: every call goes through
main, which reads the caller's origin from its frame, to the desktop's
signer (`NostrBridgeHost`), which decides, asks the user when it has to, and
signs. Din's own apps get theirs from `window.din` instead
([din/theme-and-account.md](din/theme-and-account.md)) and act as the
desktop's account.

## A site holds the identities it was given

A site acts only as accounts the user gave it, one at a time, and none of
them changes underneath it. Switching Din's account changes nothing a site
holds.

```ts
interface NostrProvider extends NostrSigner {
  // NIP-07, as the first account the site was given
  getPublicKey(): Promise<string>
  signEvent(event): Promise<NostrEvent>
  getRelays(): Promise<Record<string, { read: boolean; write: boolean }>>
  nip04: { encrypt(pubkey, plaintext); decrypt(pubkey, ciphertext) }
  nip44: { encrypt(pubkey, plaintext); decrypt(pubkey, ciphertext) }
  signPsbt(psbtHex: string): Promise<string>

  // Din's additions
  requestPublicKey(): Promise<string>             // the user gives the site one more account
  getSigner(pubkey: string): Promise<NostrSigner> // pinned to an account the site holds
}
```

- **`getPublicKey()`** asks the first time (after a click on the page), with
  a choice of account when more than one is signed in to Din, and after
  that answers with the same key unasked. That account is the one the
  provider's own methods act as, recorded per site on this device
  (`src/lib/siteIdentities.ts`).
- **`requestPublicKey()`** always asks, and only after a click: the user
  picks a signed-in account to give the site, and it resolves with its key.
  Picking one the site already holds just returns it.
- **`getSigner(pubkey)`** never asks. It resolves with a plain NIP-07 signer
  that always acts as `pubkey`, whose `getPublicKey()` answers at once, or
  rejects with `NotFoundError` if the site doesn't hold it. A client keeps
  the keys it was given and calls this for each on load.
- What a site may do without asking is remembered per site **and per
  account** (`src/lib/signerPermissions.ts`, kept with each account).

## Errors

Rejections are `DOMException`s, so a client can tell them apart by `name`:

| `name` | Means | The client should |
|---|---|---|
| `NotFoundError` | The site doesn't hold that account: never given, disconnected, or signed out of Din | Drop the account |
| `NotAllowedError` | The user (or what they remembered) said no, or Din won't ask now | Keep the account; only this failed |
| `TypeError` | A malformed call: a bad key, an event whose `pubkey` isn't the signer's | Fix the call |

When the site's first account goes, the provider's own methods reject with
`NotFoundError` rather than act as another, and the next `getPublicKey()`
asks again, which to an old client looks like being signed out.

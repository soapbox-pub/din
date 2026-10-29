# Theme, account and notifications

> **Status: in place**, except the Dock badge (`setBadge` is accepted and
> shows nothing yet). Apps still in the desktop's tree read the theme from
> its CSS, the account from `useCurrentUser` and `useAppContext`, and
> notify through `notify()`.

## `din.theme`

An app should look like part of the desktop. `window.din` takes care of it:
on the hello and on every change it writes the desktop's design tokens onto
the app's `:root` as the same CSS custom properties Din uses
(`--background`, `--foreground`, `--primary`, `--radius`, …), sets
`color-scheme` and the `dark` class, and loads the fonts. Tailwind classes
and shadcn/ui components then match without any code.

For anything drawn by hand (canvases, terminals, charts):

```ts
const { scheme, tokens, fonts, zoom, reducedMotion } = din.theme.current;
din.theme.onChange((t) => terminal.setTheme(xtermThemeFrom(t.tokens)));
```

| Field | |
|---|---|
| `scheme` | `light` or `dark` |
| `tokens` | Every design token, without the `--` |
| `fonts` | `{ sans, mono }` font stacks |
| `zoom` | The interface zoom. The desktop already scales the webview; canvas apps use it for crisp pixels |
| `reducedMotion` | Also reflected in `prefers-reduced-motion` |

A profile theme (the signed-in user's colors) arrives as tokens like any
other; apps don't need to know.

## `din.account` (permission `account`)

```ts
din.account.pubkey;    // hex, or null when signed out
din.account.relays;    // NIP-65: [{ url, read, write }]
din.account.blossom;   // Blossom server URLs
din.account.onChange(() => reload());
```

Without the permission, `pubkey` is null and the lists are empty.

### Signing (permission `nostr`)

`din.account.nostr` is a NIP-07 signer backed by Din's: `getPublicKey`,
`signEvent`, `nip04` and `nip44`. `window.din` also installs it as
`window.nostr`, so Nostrify and other NIP-07 libraries work unchanged.
For built-in apps, whose code is Din's own and reviewed, requests go
straight to the signed-in user's signer, as they did when the apps lived
in the desktop. (nsites, when they get `window.din`, will go through
Din's signer prompts as websites do.)

Apps query relays themselves (`@nostrify/nostrify`'s pool, from the app's
own origin). The desktop's NostrProvider connection isn't shared; a
small app opening a few sockets is fine, and keeps a hung relay query in
one app from affecting another.

## `din.notifications`

Toasts (`transient: true`) need no permission; notifications that go to
the notification center, and the Dock badge, need `notifications`.

```ts
await din.notifications.show('Export finished', {
  body: 'holiday.pdf is in Documents.',
  tag: 'export',
  actions: [{ id: 'open', label: 'Open' }],
});
din.notifications.onAction(({ tag, action }) => { if (action === 'open') openExport(); });

din.notifications.show('Saved', { transient: true });   // a toast, not kept in the center
din.notifications.setBadge(unread);                       // a number on the Dock tile
```

Notifications carry the app's name and icon, respect Do Not Disturb, and
clicking one focuses the app's window before `onAction`.

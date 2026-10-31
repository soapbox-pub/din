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
| `icons` | The icon theme's file-type icons by name, or `{}` |

A profile theme (the signed-in user's colors) arrives as tokens like any
other; apps don't need to know.

`icons` holds file-type icons from the system's icon theme, as data URLs
keyed by freedesktop icon name (`folder`, `image-x-generic`,
`text-x-generic`, …; the list is `FILE_ICON_NAMES` in
`src/shared/themeIcons.ts`). It's empty while Din shows its own icons (the
"Din" theme, which is DinOS's default), and leaves out names the theme doesn't have, so draw your own icon when a
name is missing. `FileIcon` (`src/shared/FileIcon.tsx`) already does.

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

## Notifications, the Dock badge, and `din.toast`

Notifications are the web's own API: `new Notification()`, its click and
close events and `close()`, and `navigator.setAppBadge()` /
`clearAppBadge()` for the Dock tile. Din backs them with its notification
center, so they carry the app's name and icon and respect Do Not Disturb.
They need the `notifications` permission: without it,
`Notification.permission` is `'denied'` and setting a badge rejects.

```ts
const n = new Notification('Export finished', {
  body: 'holiday.pdf is in Documents.',
  tag: 'export',                                 // replaces an earlier one with this tag
});
n.onclick = () => openExport();                  // Din has focused the window already
n.close();                                       // seen to some other way: take it down

navigator.setAppBadge(unread);                   // a number on the Dock tile
navigator.setAppBadge();                         // a plain mark
navigator.clearAppBadge();                       // back to counting unread notifications

din.toast('Saved', { body: 'holiday.pdf' });     // a toast, never kept in the center
```

Clicking a notification focuses the app's window before its click event.
As in Chrome's service workers, `actions: [{ action, title }]` adds
buttons, on `new Notification()` too; a button's click event carries its
`action`. Close a notification once the user has seen to what it was
about (opened the message, looked at the pane), so the notification
center and the Dock only count what's still news. A tile shows the badge
the app set, else its count of unread notifications.

Toasts need no permission: there's no web API for them, so `din.toast`
is Din's.

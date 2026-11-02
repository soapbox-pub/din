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
const { scheme, tokens, fonts } = din.theme.current;
din.theme.onChange((t) => terminal.setTheme(xtermThemeFrom(t.tokens)));
```

| Field | |
|---|---|
| `scheme` | `light` or `dark` |
| `tokens` | Every design token, without the `--` |
| `fonts` | `{ sans, mono }` font stacks |
| `icons` | The icon theme's file-type icons by name, or `{}` |

The interface zoom is the page's own `devicePixelRatio`: the desktop
scales the webview, so a canvas sized by it is crisp.

Settings → Accessibility reaches apps as the web's media features, as it
does every web page, in stylesheets and `matchMedia` alike: Reduce motion
is `prefers-reduced-motion: reduce`, Reduce transparency (or Increase
contrast) `prefers-reduced-transparency: reduce`, and Increase contrast
`prefers-contrast: more` (`electron/accessibility.mts`). With Increase
contrast the tokens already carry the stronger borders and text. The
runtime also marks the app's `:root` with them (`data-reduce-motion`,
`data-reduce-transparency`, `data-increase-contrast`), as the desktop's
own root is, which Din's stylesheet and `prefersReducedMotion()`
(`src/shared/reducedMotion.ts`) follow, and Tailwind's `motion-safe:` and
`motion-reduce:` with them. Framed in a plain browser, apps see only the
browser's own preferences. Text size reaches the app as
`--din-text-scale`, which Tailwind's `text-xs` to `text-2xl` are
multiplied by. Size text with those classes and it grows with the setting.

A profile theme (the signed-in user's colors) arrives as tokens like any
other; apps don't need to know.

`icons` holds file-type icons from the system's icon theme, as data URLs
keyed by freedesktop icon name (`folder`, `image-x-generic`,
`text-x-generic`, …; the list is `FILE_ICON_NAMES` in
`src/shared/themeIcons.ts`). It's empty while Din shows its own icons (the
"Din" theme, which is DinOS's default), and leaves out names the theme doesn't have, so draw your own icon when a
name is missing. `FileIcon` (`src/shared/FileIcon.tsx`) already does.

## The account: `window.nostr` (permission `nostr`)

Who's signed in is NIP-07, as on any Nostr web page: `window.nostr` is a
signer backed by Din's, with `getPublicKey`, `signEvent`, `nip04` and
`nip44`, so Nostrify and other NIP-07 libraries work unchanged.
`getPublicKey()` rejects while nobody is signed in. NIP-07 has no event for
another account signing in, so ask again when the window comes back to the
front (React Query's `refetchOnWindowFocus`). The user's relays and media
servers are their own events, fetched like any other: the newest kind
10002 (NIP-65) and kind 10063 (Blossom) by their pubkey, from well-known
relays (Calendar's `src/apps/calendar/calendar/nostr.ts`).
For built-in apps, whose code is Din's own and reviewed, requests go
straight to the signed-in user's signer, as they did when the apps lived
in the desktop. (nsites, when they get `window.din`, will go through
Din's signer prompts as websites do.)

Apps query relays themselves (`@nostrify/nostrify`'s pool, from the app's
own origin). The desktop's NostrProvider connection isn't shared; a
small app opening a few sockets is fine, and keeps a hung relay query in
one app from affecting another.

## Notifications, the Dock badge, and toasts

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
```

Clicking a notification focuses the app's window before its click event.
As in Chrome's service workers, `actions: [{ action, title }]` adds
buttons, on `new Notification()` too; a button's click event carries its
`action`. Close a notification once the user has seen to what it was
about (opened the message, looked at the pane), so the notification
center and the Dock only count what's still news. A tile shows the badge
the app set, else its count of unread notifications.

Every other kind of app works the same way. Installed web apps and nsites
get `navigator.setAppBadge()` in their pages and service workers (so a push
can badge a closed app), and keep the badge until they clear it; a site in
a browser tab that isn't installed has no tile, and its badge goes nowhere,
as in Chrome. Linux apps badge their tiles with Unity's
`com.canonical.Unity.LauncherEntry` signal, the badge going when the app
quits. A built-in app's badge goes with its window.

### Toasts

Feedback on what the user just did in the window ("Password copied",
"Couldn't send the text") is the app's own, drawn in its window: the web
has no API for it, and it isn't Din's to show. Din's apps use `toast()`
from `@/shared/toast`, which `startApp` gives every app a place for
(`src/shared/Toaster.tsx`):

```ts
toast('Password copied', { body: 'It’s taken off the clipboard in 90 seconds.' });
toast('Couldn’t send the text', { body: reason, destructive: true });
```

One shows at a time, at the bottom centre of the window, for 4 seconds
(8 for a `destructive` one, which is also read out at once). An app with
a bar along its bottom puts a `<ToastViewport className="…">` in its
layout where they should go instead; Messages and the Assistant put theirs
just above where the user writes. Anything that should outlast the window,
or reach the user while they're elsewhere, is a `Notification`.

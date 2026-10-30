---
name: din-widget
description: Make a widget for Din's desktop: a small, single-page napplet (NIP-5D) that sits over the wallpaper and reaches the desktop only through window.napplet. Use when the user wants a desktop widget, or to publish one to Nostr.
---

# Making a Din widget

A widget is a **napplet** ([NIP-5D](https://github.com/nostr-protocol/nips/pull/2303)):
one self-contained HTML page in a sandboxed iframe. It has no network, no
`localStorage`, no `window.din` and no `window.nostr`; it gets only the
domains it declares, on `window.napplet`.

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>Hello</title>
    <meta name="description" content="Says hello.">
    <meta name="napplet-id" content="hello">
    <meta name="napplet-requires" content="theme storage">
  </head>
  <body>
    <p id="out"></p>
    <script>
      napplet.theme?.get().then((t) => (document.body.style.color = t.colors.text));
    </script>
  </body>
</html>
```

- **Domains**: `theme`, `identity` (pubkey, profile, follows, relays),
  `storage` (per widget, or `storage.instance` per copy), `resource`
  (`bytes(url)`: the desktop fetches https for it). List them in
  `napplet-requires` / `napplet-optional`.
- **One file.** Din inlines classic `<script src>`, stylesheets and images
  from inside the folder; nothing else loads (no module imports, nothing from
  the web). Bundle anything bigger into one file (e.g. Vite with
  `vite-plugin-singlefile`).
- **Transparent**: Din draws nothing behind it. Leave `color-scheme` unset to
  stay see-through. Lay out for any size; the user resizes it on a grid.

## Running it

- `din widget ./folder` puts it on the desktop (`--size small|medium|large`).
  If it asks for `identity`, `resource` or `storage`, the desktop shows its
  permission screen and the command waits for the user to answer, so tell
  them to look. One that asks for nothing goes on at once.
- Once it's there, it reloads whenever a file in the folder changes; don't
  add it again. To see it, screenshot the screen
  (`WAYLAND_DISPLAY=din-shell grim /tmp/screen.png`) and look.
- Its menu (right-click it) has Size, Reload, About This Widget… (its
  permissions) and **Publish to Nostr…**, which uploads it and signs a
  kind 35129 manifest. Publishing is the user's to do.

## References

- `/etc/din/docs/widgets.md` on DinOS (`docs/widgets.md` in a Din checkout):
  the sandbox, folders, publishing, and each domain's messages
- `/etc/din/napplet.ts` (`src/widgets/shared/napplet.ts`): `window.napplet`, typed
- The built-in widgets in a Din checkout, `src/widgets/`, are worked examples

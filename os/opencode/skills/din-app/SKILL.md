---
name: din-app
description: Make an app for Din, the desktop DinOS runs: a web page with a manifest that opens in its own window and talks to the desktop through window.din. Use when the user wants a new app, or to run or test one in a Din window.
---

# Making a Din app

A Din app is a folder with an `index.html` and a `manifest.webmanifest`. Din
opens it in a window of its own and defines `window.din` before the page's
scripts run, so plain HTML works with no build step; any framework works too,
built into the folder.

```html
<link rel="manifest" href="./manifest.webmanifest">
<script type="module">
  await din.ready;
  din.window.setTitle('Hello');
</script>
```

```json
{
  "name": "Hello",
  "icons": [{ "src": "/icon.png", "sizes": "512x512", "type": "image/png" }],
  "din": {
    "window": { "size": { "width": 480, "height": 360 } },
    "permissions": []
  }
}
```

Every app has its window, menus, files the user hands it, drag and drop, the
theme, its own storage and the network. Anything more (`account`, `nostr`
for `window.nostr`, `fs`, `notifications`, …) goes in `din.permissions`.

## Running it

- `din apps run ./folder` opens it in a window and prints its console in the terminal
  (`--origin <name>` keeps its storage between runs, `--detach` returns at once,
  `--url http://localhost:5173` runs a dev server with HMR).
- To keep it, the user adds the folder in the App Store (**Add from a
  Folder…**). It's then in the launcher at `din+file://…` and reloads
  whenever a file in the folder changes, so `vite build --watch` into it
  shows up at once. Only the user can do this step.

## References

Docs are in `/etc/din/docs/` on DinOS (`docs/` in a Din checkout):

- `din/README.md`: `window.din`, the start of the API docs (`din/*.md`)
- `din/manifest.md`, `din/permissions.md`: the manifest and what to ask for
- `din-command.md`: the `din` command and apps from folders
- `building-an-app.md`: a worked example (a built-in app, in Din's own tree)
- `/etc/din/din.d.ts` (`src/sdk/din.d.ts`): the API's types, the source of truth

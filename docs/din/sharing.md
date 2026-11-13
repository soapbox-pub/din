# Sharing

> **Status: in place for built-in apps.** `navigator.share` and
> `din.app.share` in `din://` apps, the desktop's share sheet
> (`src/components/desktop/ShareSheetHost.tsx`, `src/lib/share.ts`),
> built-in apps as share targets, and `din share`. Not yet: installed
> websites and nsites as targets (their manifests' `share_target`, read when
> they're installed), `navigator.share` on web pages in the Web Browser, and
> people and conversations as targets of their own (Android's sharing
> shortcuts).

Sharing is Android's: anything can have a Share button, the desktop shows a
share sheet of the apps that take what's shared, and the user picks one.
Din uses the web's own names for both halves, so the same app works as an
nsite or a PWA: the [Web Share API](https://w3c.github.io/web-share/) to
share, and [Web Share Target](https://w3c.github.io/web-share-target/) to
be shared to.

## Sharing something

```ts
await navigator.share({ title: 'Trip photos', text: 'From Saturday', url: 'https://example.com/album', files: [photo] });
```

- It takes a click or a key press, as on the web: the page's
  `navigator.userActivation`, and the desktop checks the window had input in
  the last three seconds (or a pick from its Din menus).
- The sheet points at what was pressed (or else what has focus), so a
  Share button needs nothing more.
- It resolves once the user picks an app or one of the sheet's actions, and
  rejects with an `AbortError` when they close the sheet. The app learns
  nothing about where it went.
- `navigator.canShare(data)` says whether the data could be shared (a URL
  that isn't `javascript:`, `data:`, `blob:`, `file:` or `about:`; files
  that are `File`s). Whether an app takes it is the sheet's business.
- Files cross as their bytes, up to 256 MB in all, and are kept in
  `~/.cache/din/shared/<random>/` for the app they go to (cleared after a
  day). An app that holds the files as handles (Files) shares them as
  themselves instead, without reading them:

```ts
await din.app.share({ title: 'report.pdf' }, [handle]);
```

The desktop's own UI calls `requestShare(data, { anchor })` from
`src/lib/share.ts` (the Web Browser's Share button and menu item), and the
`din` command `din share`.

### Where there's a Share

| Where | What it shares |
|---|---|
| The Web Browser's address bar and menu | The page's address and title |
| Files' right-click menu (files, not folders) | The files, as themselves |
| `din share [files…] [--text] [--url] [--title] [--to app]` | Anything; `--to` skips the sheet |

## The sheet

A glass popover (`ShareSheetHost`) with what's shared at its top (a
picture's thumbnail, or a kind of thing's icon, and its name), the apps that
take it as a grid, those picked lately first, and the sheet's own actions:
**Copy** (the text and link; files go on Din's file clipboard, read-only) and
**Save to Downloads** for files. The app that shared isn't offered. A new
share replaces one still open.

## Being shared to

An app says what it takes in its manifest, as the web does:

```json
"share_target": {
  "action": "/?new",
  "method": "POST",
  "enctype": "multipart/form-data",
  "params": {
    "title": "subject",
    "text": "text",
    "url": "url",
    "files": [{ "name": "attachments", "accept": ["image/*", ".pdf"] }]
  }
}
```

- **Which shares it's offered for.** One with files: when every file is
  taken by some entry of `files` (a MIME type, a family as `image/*`, `*/*`,
  or an extension). One without: when it has a place for the title, the
  text or the link. A link goes in the text where `url` isn't named, as
  Android does it.
- **How a built-in app hears it.** In `launchQueue`, as any launch: the
  `targetURL` is `action`, with the title, text and link in its query under
  the names `params` gives them, and a `shareNonce` that's new with each
  share; the files are the launch's files, granted read-only. `method` and
  `enctype` are for websites; Din's apps all hear a share the same way. A
  single-instance app's open window hears it in place of its last launch,
  not merged into it. `din.app.opener` is the app that shared, or null for
  the desktop.
- What's shared is untrusted input from another app: show it, put it in a
  draft, never act on it unasked.
- Param names the desktop's launches use (`path`, `paths`, `readOnlyPaths`,
  `opener`, `shortcut`, `shareNonce`, `window`) can't be targets'; a
  manifest naming one isn't offered.

| App | Takes | Opens |
|---|---|---|
| Messages | Text and links | A new message with it written in |
| Mail | Anything, files as attachments | A new message: the title as its subject, the text and link as its body |

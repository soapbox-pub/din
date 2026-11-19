# Sharing

> **Status: in place.** `navigator.share` and `din.app.share` in `din://`
> apps, the desktop's share sheet (`src/components/desktop/ShareSheetHost.tsx`,
> `src/lib/share.ts`), built-in apps, installed nsites and installed
> websites as share targets (GET and POST, files included), and `din share`.
> Not yet: `navigator.share` on web pages in the Web Browser, and people and
> conversations as targets of their own (Android's sharing shortcuts).

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
  Share button needs nothing more. It points only inside the sharer's own
  window, and says which app is sharing, so an app can't pass its share off
  as another's.
- It resolves once the user picks an app or one of the sheet's actions, and
  rejects with an `AbortError` when they close the sheet. The app learns
  nothing about where it went.
- `navigator.canShare(data)` says whether the data could be shared (a URL
  that isn't `javascript:`, `data:`, `blob:`, `file:` or `about:`; files
  that are `File`s). Whether an app takes it is the sheet's business.
- Files cross as their bytes, up to 256 MB and 100 files in all, and are
  kept in `~/.cache/din/shared/<random>/` for the app they go to (cleared
  after a day, or as soon as the sheet is closed without a pick). The
  desktop checks the link, the sizes and the files again itself: an app
  can skip its runtime. An app that holds the files as handles (Files)
  shares them as themselves instead, without reading them:

```ts
await din.app.share({ title: 'report.pdf' }, [handle]);
```

The desktop's own UI calls `requestShare(data, { anchor })` from
`src/lib/share.ts` (the Web Browser's Share button and menu item), and the
`din` command `din share`.

### Where there's a Share

| Where | What it shares |
|---|---|
| The Web Browser's address bar and menu | The page's address and title; with a video playing, the video or its sound as a file instead |
| Files' right-click menu (files, not folders) | The files, as themselves |
| `din share [files…] [--text] [--url] [--title] [--as video\|audio] [--to app]` | Anything; `--to` skips the sheet |

## The sheet

A glass popover (`ShareSheetHost`) with what's shared at its top (a
picture's thumbnail, or a kind of thing's icon, and its name), the apps that
take it as a grid, those picked lately first, and the sheet's own actions:
**Copy** (the text and link; files go on Din's file clipboard, read-only) and
**Save to Downloads** for files. The app that shared isn't offered. A new
share replaces one still open.

### Send as

A share can come with other ways to send it (`alternatives` in
`requestShare`, each a `ShareAlternative`), and the sheet then has a **Send
as** control: Link (the share as it is) and each of them, the last one
chosen remembered (`rememberAs`). An alternative's file doesn't exist until
an app is picked: the sheet offers the apps that take its `sample`, then
makes it (`prepare`) with its progress where the apps were and a Cancel,
and gives the app a share of the file and the title (`deliverAlternative`).
Closed meanwhile, the sheet lets it carry on and the share still goes.
Its Save to Downloads is the alternative's own (`save`).

The Web Browser's Share offers **Video** (with a quality: Best, 1080p,
720p, 480p) and **Audio** for a page yt-dlp knows by its address as a
video's, or one with something playing or paused (`src/lib/videoShare.ts`).
The address is checked offline against yt-dlp's site extractors, those that
give a video rather than a playlist (`isVideoPage` in
`electron/video-download.mts`, one long-lived Python helper loading
yt-dlp's module), so an Instagram reel, which starts muted, offers its video
before it's heard; `din share --url` offers the same for such a page. Picked,
yt-dlp fetches it as Download Video does, into
`~/.cache/din/shared/<random>/` (`forShare` in
`electron/video-download.mts`), its progress in the sheet alone (it isn't a
download, so never on the browser's download shelf), so an app like Armada
is POSTed the MP4 itself. Save to Downloads there is
Download Video, which also stays in the browser's menu.

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
- Only the sheet (and `din share`) makes a share: an app's `window.open` of
  another app loses any `shareNonce` it names, so an app can trust that a
  launch with one came from the user's pick. Mail attaches a launch's files
  only for a share, and not again when Din reopens the window.

### Installed websites and nsites

An installed website (a PWA) or nsite whose web app manifest has a
`share_target` is offered for what it takes, and gets a share as a browser
delivers one to an installed PWA. Its window goes to `action` (resolved
against the manifest, and only ever on the app's own origin or host):

- **GET** (the default, or `application/x-www-form-urlencoded` with POST
  for a body): the title, text and link in the query (or the body) under
  the names `params` gives them. Ditto and Armada take them this way at
  `/share`. No files: only a multipart POST carries them.
- **POST** with `multipart/form-data`: the fields, and each file under the
  first of `params.files` whose `accept` takes it, as a form would submit
  them. The window loads the site first, then POSTs to `action` from it
  (`shareRequestBody`; `<webview>.loadURL` with `postData`, each file a
  part the engine reads from disk as the request goes, so nothing holds it
  in memory and it can be any size). A website's service worker or server
  answers it. The body is kept in memory only until the window takes it
  (`takePostShare`, by the token in its `share` launch param): a window Din
  reopens after a restart doesn't send it again.

An nsite has no server, so only its service worker can take a POST: the
window waits up to five seconds for one to be active for `action`
(`navigator.serviceWorker.getRegistration`), and without one it goes to
`action` with the title, text and link in the query, and the user hears the
files didn't go. A POST its service worker lets through anyway reaches the
`nsite:` handler, which sends it on as that same GET (`shareAsGet` in
`electron/nsite.mts`, a 303), its files dropped; any other POST to an nsite
is refused (405).

Where it's read:

- An nsite's, with the site's other app details when it's installed or
  updated (`share` in the nsite store's app info: `pickShareTarget` in
  `src/lib/nsiteAppInfo.ts`, checked again by `parseShareTarget` in
  `electron/nsite-store.mts`).
- A website's, from its manifest when it's installed (`collectManifest` in
  `BrowserView`), kept as `share` in its `web-apps` entry (`NIP.md`) and
  checked again whenever it's read back (`src/lib/webShareTarget.ts`). A
  website installed before Din read it is offered once it's installed again.

### Built-in apps that take shares

| App | Takes | Opens |
|---|---|---|
| Messages | Text and links | A new message with it written in |
| Mail | Anything, files as attachments | A new message: the title as its subject, the text and link as its body |

## Highlights

A highlight is a passage the user posts to Nostr as themselves (NIP-84, kind
9802), with the paragraph it's in and where it's from. The desktop's composer
(`src/components/desktop/HighlightBridgeHost.tsx`, `src/lib/highlights.ts`)
shows the passage in its paragraph and where it's from, takes an optional
comment, and posts nothing until the user presses Post.

```ts
const id = await din.app.highlight({ text, context, source: 'Claude Opus 5.5' });
```

- `text` is the passage; `context` what's around it, kept only when it holds
  `text` word for word, as NIP-84 has it. The Assistant highlights a reply as
  its Markdown: text selected as drawn is found in the reply's Markdown
  (`src/shared/highlightText.ts`, its emphasis, code and link marks and its
  lists' and quotes' markers allowed between the words), and `text` is the
  slice that draws it, widened to whole marks and links, with the whole reply
  (up to 20,000 characters, else the paragraphs around it) as `context`.
- `source` is where it's from, by name, published as a plain-text `r` tag
  (NIP-84 allows text as well as URLs there, nostr-protocol/nips#2454). An
  app can't name a page as the source: only the Web Browser does that, from
  the tab's own address, as an `i` tag and an `r` tag.
- It takes a click or a key press, as sharing does. It resolves with the
  posted event's id, or null when the user cancels, and rejects when nobody
  is signed in.
- Once it's posted, the desktop's notification opens it as a `nostr:` link
  (an nevent) when clicked, or with its Open: in the default app for
  highlights, or the Open With chooser.

| Where | What it highlights |
|---|---|
| The Web Browser's right-click menu on selected text | The selection, from the page (its URL and title) |
| The Assistant's right-click menu on text selected in a reply | The selection as the reply's Markdown, in the whole reply, from the model that wrote it |
| `din nostr highlight "…" --url … \| --source …` | Anything |

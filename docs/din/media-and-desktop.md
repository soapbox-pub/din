# Media, the desktop and dictation

> **Status: in place.**

## What's playing: the Media Session API

An app that plays sound or video tells Din what's playing with the web's
Media Session, and hears Din's media controls (the volume menu's) and the
media keys through its action handlers, as a page in a browser does. No
permission: web pages in the Web Browser are heard the same way.

```ts
navigator.mediaSession.metadata = new MediaMetadata({ title: 'So What', artist: 'Miles Davis', artwork: [{ src: cover }] });
navigator.mediaSession.playbackState = 'playing';
navigator.mediaSession.setActionHandler('play', play);
navigator.mediaSession.setActionHandler('nexttrack', next);   // Next shows
navigator.mediaSession.metadata = null;                       // nothing playing: the controls go
```

The desktop lists it among what's playing (`src/lib/nowPlaying.ts`), next
to web pages and native apps, and the media keys pick among them as for
any other source. The runtime reads the session (`src/sdk/standards.ts`):

- The title falls back to `document.title`, the subtitle is the artist
  (or the album), and the artwork is the last picture, read into a data:
  URL when it's the app's own file or a blob:, up to 512 KB.
- Playing is `playbackState`, or, while that's `none`, whether the page's
  `<audio>` and `<video>` play.
- Play shows with a `play` handler or a media element, Previous and Next
  with their handlers. An action with no handler acts on the page's media
  elements, as a browser's controls do: Pause pauses them, Play plays the
  last one paused.
- **No metadata, but a `play` handler:** stopped with something ready to
  play (Media Player with a queue). It isn't listed, but a play key
  pressed with nothing else playing calls the handler.

## Printing: `window.print()`

An app prints as a web page does, with no permission: `window.print()`
opens Din's print dialog (in a plain browser, the browser's). Called on the
app's own window it prints the page as it's drawn. Called on a frame's
window it prints just that frame, which is how an app prints something
other than what it shows, as sites print receipts:

- a document the app drew, as a whole HTML page in a `srcdoc` frame, its
  styles and pictures inline: Din draws it again, with scripts off and
  nothing from the web;
- a file (a PDF, a picture, text), in a `blob:` frame: Din prints the file
  itself, so a PDF prints as the PDF. The frame's `title` names it in the
  dialog.

`src/shared/print.ts` does both for Din's apps: `printDocument(html,
title)` and `printFile(file)`. The frame needs the app's CSP to allow it
(`frame-src about:` for a document; `frame-src blob:` and `object-src blob:`
for a file). `print()` returns at once; anything that goes wrong is shown in
the dialog.

## `din.desktop` (permissions `wallpaper` and `cursor`)

```ts
await din.desktop.setWallpaper(pictureHandle);
await din.desktop.setCursor(themeHandle);
```

The desktop's own rules apply: a picture going into a synced profile
theme is only uploaded once the user agrees.

`setCursor` installs the cursor theme in a file (a .CurXPTheme,
.CursorFX, .cape, a Windows pack or an archive of a theme) and makes it
the pointer, as Settings' Import does: it's converted in the cursor
converter's sandbox and checked before anything is written. It rejects
with a message to show when the file isn't a theme Din can read, or when
Din can't change the cursor on this system.

## `din.dictation`

Din's speech to text, typed into the field focused in the app. Text
fields need nothing: the dictation key already types into whatever has
focus in an app. This is for an app's own mic button:

```ts
if (din.dictation.available) {
  micButton.onclick = () => (din.dictation.status === 'listening' ? din.dictation.finish() : din.dictation.start());
  din.dictation.onStatus((s) => micButton.classList.toggle('on', s === 'listening'));
}
```

`start({ held: true })` listens until `finish()` (push to talk);
otherwise it stops at a pause. `din.dictation.here` says whether what's
being dictated goes into this window, from its button or Din's dictation
key, so a mic button can light up either way.

## `din.assistant` (permission `assistant`)

For apps that show the assistant (the Assistant, CAD's palette). The
desktop keeps Din's settings for it and announces requests, questions and
finished turns, so it needs to know what an app shows:

```ts
din.assistant.settings;                   // { enabled, directory, colorfulReplies, model }
din.assistant.onSettingsChange(apply);
din.assistant.setSettings({ model });     // or { enabled: true }
din.assistant.follow(sessionID);          // started or written in here: Din says when it finishes
din.assistant.setViewing(sessionID);      // this window shows it (null: none)
din.assistant.unread;                     // conversations with unread notifications
din.assistant.onUnreadChange(mark);
```

`unread` lists the conversations behind the app's Dock badge: their
notifications are still in the notification center, unread. The
Assistant puts a dot by each in its list and tabs (`useUnreadSessions`).

A conversation Din follows is announced when it finishes, unless the
window in front shows it; requests and questions likewise. The shared
hooks in `src/hooks/useAssistant.ts` do this in both documents
(`followDinSession`, `useMarkViewedSession`, the stored model).

### Asking the Assistant for something (no permission)

Any app can open the Assistant with an **intent**: launch params naming
what it wants done, as data. What the agent is told about an intent is
written in the Assistant (`src/apps/assistant/intents.ts`), never by the
app, which fills in only its fields:

```ts
const nonce = Date.now();
await din.app.open('assistant', {
  intent: 'studio.edit',
  directory: take.path,        // the conversation works here
  prompt: 'A vertical clip with captions',
  title: take.title,
  nonce, intentNonce: nonce,   // this launch's own (params merge into the last launch's)
});
```

The conversation starts at once, with the intent's context ahead of the
request (shown in it as "From Studio: Take 3"), only when `launch.opener`
is an app the intent trusts. For any other app, a new conversation opens in
the folder with the request in the composer, for the user to send.

| Intent | Trusts | Fields |
|---|---|---|
| `studio.edit` | Studio | `directory` (a take's folder), `prompt`, `title`; the agent is pointed at the `studio` skill |

## `din.system.capture` (permission `capture`)

Studio's recordings and live streams (`src/lib/capture.ts` has the
types, `electron/capture.mts` the work). The app records in its own page,
with the camera, the microphone and the screen the permission gives it,
and hands the bytes to main as they come:

```ts
const { take } = await capture.begin({ scene, aspect, canvas, screen: { audio: false } });
const writer = await capture.open(take, '.program.webm');
recorder.ondataavailable = async (e) => capture.write(writer, new Uint8Array(await e.data.arrayBuffer()));
// …
await capture.close(writer);
const saved = await capture.end({ startedAt, durationMs, tracks: { program: { file: '.program.webm', start: startedAt } }, switches, markers });
```

`begin` makes the take's folder and starts recording the screen (with its
pointer, by wf-recorder) and resolves once its first frame is in, with
when that was. `end` stops it, turns the WebM tracks into MP4s, writes
`take.json` with every track's place on the take's clock, and starts the
transcript. The take's format is the `studio` skill's to explain
(`os/opencode/skills/studio`).

Going live: `streamStart(destination)`, then `streamWrite` the WebM
(H.264 and Opus) as it's encoded; main copies the picture and turns the
sound into AAC for RTMP. Destinations are saved with `saveDestination`,
and their stream keys never come back. `onState` says what's recording and
what's live, as the menu bar shows it.

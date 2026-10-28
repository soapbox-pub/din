# Media, the desktop and dictation

> **Status: in place.**

## `din.media` (permission `media-session`)

An app that plays sound or video tells Din what's playing, and hears Din's
media controls (the volume menu's) and the media keys:

```ts
din.media.setSession({
  title: 'So What', subtitle: 'Miles Davis', artwork: coverDataUrl,
  playing: true, canPlay: true, canPrevious: true, canNext: true,
});
din.media.onAction((action) => player[action]());   // play, pause, nexttrack, previoustrack
din.media.setSession(null);                          // nothing playing: the controls go
```

The desktop lists it among what's playing (`src/lib/nowPlaying.ts`), next
to web pages and native apps, and the media keys pick among them as for
any other source. `play` also comes when a play key is pressed with
nothing else playing, if the session `canPlay`. Artwork is a data: or
https URL: the desktop can't load the app's own files.

Plain `<audio>` and `<video>` in an app aren't seen by the desktop on
their own; an app that wants media keys says so with a session.

## `din.desktop` (permission `wallpaper`)

```ts
await din.desktop.setWallpaper(pictureHandle);
```

The desktop's own rules apply: a picture going into a synced profile
theme is only uploaded once the user agrees.

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
otherwise it stops at a pause.

# `din.inputMethod`: being a keyboard

> **Status: in place on Din Phone**, whose keyboard, Din Keyboard, is an
> app like any other. Din's desktop shows no on-screen keyboard yet; when it
> does (the compositor's `zwp_input_method_v2`, with `text-input-v3` for
> the apps), it answers the same API, so the same keyboard runs on both.

A keyboard is a web page with a manifest, as every Din app is. Its
manifest asks for `input-method`:

```json
{
  "name": "Din Keyboard",
  "start_url": "/",
  "din": { "permissions": ["input-method"] }
}
```

The host shows it where a keyboard goes, when a field takes focus in any
app, and `din.inputMethod` is the field and its editing. Everything else a
keyboard needs is the web's own.

## What's the web's

| A keyboard needs | It uses |
|---|---|
| To know it's shown or put away | `document.visibilityState` and `visibilitychange` |
| Its size, and the screen's | `innerWidth`/`innerHeight` (its window), `screen.width`/`height`, and `screen.avail*`: the part of the screen clear of system bars, so the keys stay clear of a navigation bar (the bottom inset is `screen.height - screen.availTop - screen.availHeight`) |
| To be taller, for popups over the app | `resizeTo(width, height)`; `screen.availHeight` or more is the whole screen, for effects drawn over the app. `din.inputMethod.setInset()` says how much of it is keys |
| A color to start in, next time it's slow to load | `<meta name="theme-color">` |
| To say it's drawn | `din.app.ready()` |
| The system's look | `prefers-color-scheme`, `prefers-reduced-motion`, and `din.theme`'s `background`, `foreground` and `primary` tokens (Material You's on Din Phone) |
| The clipboard, to keep a history | `navigator.clipboard.readText()`/`writeText()`, and `clipboardchange`, which fires for text copied in any app. Clips the system marks sensitive (passwords) fire nothing |
| Voice typing | `SpeechRecognition`, with `interimResults` for the words as they're heard ([media-and-desktop.md](media-and-desktop.md#dictation-speechrecognition)) |
| A key's feel | `navigator.vibrate(ms)`. On Din Phone a vibration of 30 ms or less is the phone's crisp click, its length the click's strength (1–30); 1–4 ms is a lighter tick; patterns and longer ones vibrate as asked |
| A key's sound | Web Audio |
| Settings, learned words | `localStorage`, IndexedDB |
| Its log | `console`, which the host keeps (`adb logcat -s DinKeyboard` on Din Phone) |

## `din.inputMethod`

The types are `DinInputMethod`, `InputField`, `InputText` and
`InputSelection` in [`src/sdk/din.d.ts`](../../src/sdk/din.d.ts). Without
the permission, every call but the listeners throws `DinPermissionError`.

### The field

`din.inputMethod.field` is the field being typed in, or null, and
`onFieldChange` hears another one come (with its text around the
selection, if the host could read it at once, and whether it's the same
field restarted). The field is described in the words a page uses for its
own `<input>`, whatever the app is written in:

| Member | Like | |
|---|---|---|
| `type` | `type` | `text`, `search`, `email`, `url`, `tel`, `password`, `number`, `date`, `time`, `datetime-local` |
| `inputMode` | `inputmode` | the keys it wants: `numeric` (digits), `decimal`, `tel`, `email`, `url`, `search`, `text`, `none` |
| `enterKeyHint` | `enterkeyhint` | `enter` (a new line when `multiline`, a plain Enter key otherwise), or the field's action: `done`, `go`, `next`, `previous`, `search`, `send` |
| `enterKeyLabel` | | the app's own word for its action ("Post"), when it gave one |
| `autocapitalize` | `autocapitalize` | `none`, `sentences`, `words`, `characters` |
| `spellcheck` | `spellcheck` | offer words as they're typed |
| `autocorrect` | `autocorrect` | correct words as they're finished |
| `multiline` | `<textarea>` | |
| `private` | | learn nothing and keep nothing: a password, a private window, or the app asked |
| `keysOnly` | | no text to see or edit (a terminal): type with `sendKey()` and `insertText()` |
| `lang` | `lang` | the languages the app expects, most likely first; often none |
| `placeholder`, `app` | | the field's placeholder; the app it's in, as the host names apps |

On Din Phone these come from Android's `EditorInfo` (its `inputType` and
`imeOptions` bits, `hintLocales`, `actionLabel`).

### Reading

A keyboard can't ask the app anything synchronously: every read is a trip
through the host and the app. So it keeps its own copy of the text near
the cursor, changes it as it edits, and checks it against what the app
reports:

- `selection` and `onSelectionChange`: the selection, and the text being
  composed, as the app reports them after each change, the keyboard's or
  not;
- `getText({ before, after })`: the text around the selection (1000 UTF-16
  units either side by default), and where the selection is, or null;
- `onCaretChange`: where the caret is, in the keyboard's CSS pixels
  (negative `y` is above its window), while anything listens.

### Editing

Positions are UTF-16 units from the field's start. Edits made in the same
task go to the field as one change (one undo step, one selection reported
after), in order:

| | |
|---|---|
| `insertText(text)` | in place of what's being composed, or else of the selection; the caret after it |
| `setComposition(text)` | the same, as what's being composed now (underlined, to be replaced whole) |
| `setCompositionRange(start, end)` | compose text already in the field (a word to suggest for) |
| `finishComposition()` | leave what's being composed as it is |
| `deleteSurroundingText(before, after)` | either side of the selection |
| `setSelectionRange(start, end)` | |
| `sendKey(key, modifiers)` | a key pressed and released, by `KeyboardEvent.key`'s name (`Backspace`, `Enter`, `ArrowLeft`…): for what has no text, or to leave what a key does to the app (a chip deleted, the field before) |
| `performAction()` | the field's `enterKeyHint` |

### The keyboard

- `setInset(height)`: how much of the bottom of the screen is keys. Apps
  are laid out above it and touches in it are the keyboard's; the rest of
  a taller window (`resizeTo()`) takes only touches that began in the keys.
- `hide()`: put the keyboard away.
- `showPicker()`: the system's choice of keyboards.
- `buttons` and `onButtonsChange`: which of the buttons a system puts under
  a keyboard (one to put it away, one to choose another keyboard) it leaves
  to the keyboard, to draw in the bottom of its window, below
  `screen.availHeight`, where the system would have. Din Phone has Android
  16 and later leave both to the keyboard (the switcher only while there's
  another keyboard to switch to); before that, Android draws its own and
  they're false.

The system's own settings for keyboards (which are on) are
`window.open('din://settings/?section=keyboard')`, and for voice typing
`section=dictation`, as any app opens Settings.

## Hosts

**Din Phone** (`android/…/keyboard/` there) hosts a keyboard in a WebView in
an Android input method service, in a process of its own. Before the
keyboard's scripts run it puts Din's runtime in the page, with a transport
over the service (`din/phone/keyboard.ts` there), which turns Android's
`EditorInfo`, selection updates, clipboard, vibration, speech and window
into the above.

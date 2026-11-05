---
name: studio
description: Edit recordings made with Din's Studio app into finished videos. A project is a folder in ~/Videos/Studio with project.json (its takes and clips in order, which to use, trims and notes) and a takes/ folder; each take has take.json, transcript.json and separate program, screen, camera and microphone tracks. Use when asked to cut, combine, caption, reframe (vertical for TikTok, Reels or Shorts), shorten, or make clips, YouTube videos or chapters from a Studio project, take or recording.
---

# Editing a Studio project

Studio records the person and their screen so you can do the editing. The
user records as many takes as they need into a **project**, brings in clips
they already have, puts them in order and leaves out the ones that didn't
work, then asks you to make something from it. A project is a folder,
`~/Videos/Studio/<date> <title>/`. `din studio projects` lists them, and
`din studio project "<project>"` shows one's takes in order (`--json` for
the details). Work with FFmpeg (`ffmpeg`, `ffprobe`), and Python for
anything that needs a script.

**Never change or delete the recorded files.** Put everything you make in
the project's `edits/` folder, which Studio shows under the project. Give
files names that say what they are: `edits/tiktok-captions.mp4`,
`edits/youtube.mp4`, `edits/youtube-chapters.txt`.

## What's in a project

| Path | What it is |
|---|---|
| `project.json` | The takes and clips in the order they go, and how to use each. Read it first |
| `takes/<name>/` | One take or clip each, as below |
| `edits/` | Yours |

### project.json

```json
{
  "format": "din-studio-project", "version": 1,
  "title": "How I set up my desk", "created": "2026-11-04T14:02:11.000Z",
  "items": [
    { "take": "intro", "keep": true },
    { "take": "Take 1", "keep": false },
    { "take": "Take 2", "keep": true, "in": 4.2, "out": 181.5, "note": "the second half is the good part" },
    { "take": "Take 3", "keep": true }
  ]
}
```

- `items` is the order the user wants, first to last. `take` names a folder
  in `takes/`.
- `keep: false`: the user left it out. Don't use it unless they ask.
- `in` / `out`: the part of it to use, in seconds on that take's clock (as
  its take.json and transcript.json). Missing means from its start, or to
  its end. Inside that part, still cut mistakes and pauses as below.
- `note`: what the user said about it. Follow it.
- A folder in `takes/` that `items` doesn't name goes at the end, in the
  order it was made (Studio lists it so).

Unless the user asks for something else, what you make is the kept items,
in order, each cut cleanly, joined into one video.

## What's in a take

A take is a recording made in Studio. A **clip** is a file the user brought
in: its take.json has `"imported": "<the file's name>"` and only a
`program` track (the file, copied in as `clip.<ext>`), with no scene,
switches or markers. Its transcript is of its own sound.

| File | What it is |
|---|---|
| `take.json` | What was recorded and how the tracks line up. Read it first |
| `program.mp4` | The picture as the user saw it in Studio, with the layout baked in, and the sound |
| `clip.<ext>` | A clip's file, as the user had it |
| `screen.mp4` | The screen at full resolution with the pointer, when it was recorded. Has the computer's sound when `tracks.screen.audio` is `"computer"` |
| `camera.mp4` | The camera alone, with no sound. `mirrored` says whether the user saw it flipped |
| `mic.ogg` | The microphone alone (Opus) |
| `transcript.json` | Every word spoken, with its start and end |
| `poster.jpg` | A frame from the start |

A track can be missing: a camera-only take has no screen, and if FFmpeg
wasn't there when it was saved, tracks are `.webm` instead of `.mp4`/`.ogg`
(`tracks.<name>.file` always names the real file). Takes from before
projects sit right in `~/Videos/Studio/<date> Take <n>/` with their own
`edits/`; Studio makes one into a project when it's opened.

### take.json

```json
{
  "format": "din-studio-take", "version": 1,
  "title": "Take 3", "created": "2026-11-01T14:32:05.000Z",
  "status": "ready", "duration": 312.4,
  "scene": "screen-camera", "aspect": "16:9",
  "canvas": { "width": 1920, "height": 1080 },
  "tracks": {
    "program": { "file": "program.mp4", "start": 0, "width": 1920, "height": 1080, "audio": "voice" },
    "camera": { "file": "camera.mp4", "start": 0, "width": 1920, "height": 1080, "mirrored": false },
    "mic": { "file": "mic.ogg", "start": 0, "audio": "voice" },
    "screen": { "file": "screen.mp4", "start": -0.183, "width": 2560, "height": 1600, "pointer": true, "audio": null }
  },
  "switches": [
    { "time": 0, "scene": "screen-camera",
      "camera": { "x": 0.75, "y": 0.62, "width": 0.17, "height": 0.3, "shape": "circle" },
      "screen": { "x": 0, "y": 0.0, "width": 1, "height": 1 } }
  ],
  "markers": [{ "time": 41.2, "kind": "retake" }, { "time": 97.0, "kind": "highlight" }],
  "transcript": { "file": "transcript.json", "status": "done" }
}
```

**One clock.** Every time in `take.json` and `transcript.json` is seconds on
the take's clock, which starts with `program.mp4`. A track's `start` is
where its own second 0 falls on that clock, so take-clock time `t` is
second `t - start` of the track. `screen.mp4` usually starts a fraction of
a second before the take (a negative `start`): to line it up, skip
`-start` seconds of it (`-ss 0.183`). The screen is lined up to within a
frame or two; if the pointer and speech look off, nudge it.

- `switches`: each time the user changed the scene or moved the camera,
  where the camera and the screen were on the canvas (fractions of
  `canvas`), and the camera's shape. Rebuild the user's layout from these
  when composing from the separate tracks.
- `markers`: what the user pressed while recording. `highlight` is a moment
  they want kept (a good clip starts near it). `retake` means **what they
  just said went wrong and they'll say it again**: cut from the start of
  the sentence that went wrong (usually the last sentence before the
  marker, sometimes two; look for the words repeated after it) up to where
  they start again. Retakes are rarely marked at the exact moment; use the
  transcript to find the real boundaries.
- `status`: `interrupted` means the take was cut off (Din quit); what was
  recorded is there. `finishing` means it's still being saved, or a clip
  still being copied in: wait for `ready`.
- `transcript.status`: `working` while it's being made (wait for it,
  checking `take.json`), `failed` or `none` with no transcript. Make one
  with `din studio transcribe "<take folder>"`, which waits until it's done.

### transcript.json

```json
{
  "language": "en",
  "text": "So today I want to show you…",
  "sentences": [{ "start": 0.42, "end": 3.1, "text": "So today I want to show you how this works." }],
  "words": [{ "start": 0.42, "end": 0.61, "text": "So" }, …]
}
```

Words have their punctuation attached. A gap of more than about 0.8 s
between words is a pause.

## Doing the work

1. Read `project.json`, then each kept take's `take.json` and transcript.
   Say back briefly what you plan to cut and make before a long render, if
   the request was vague.
2. For each kept take, in order, decide what to keep as a list of
   `[start, end]` ranges on its clock, inside its `in`/`out`: drop
   retakes, false starts, filler ("um", "uh" as whole words), and pauses
   longer than about 0.6 s (leave ~0.15 s of air at each cut). Cut at word
   boundaries from the transcript, never mid-word. When the user said the
   same thing in two takes, keep the better one (usually the later) and say
   so.
3. Render each take's ranges from `program.mp4` (a clip's `clip.<ext>`)
   when the user's layout is what they want. Compose from `screen.mp4` and
   `camera.mp4` when the shape changes (vertical from a landscape take) or
   the layout should differ.
4. Join the pieces in order (below). Takes and clips can differ in size,
   frame rate and sound: bring every piece to one size, rate and sound
   format first.
5. Check the result with `ffprobe`, and look at a few frames
   (`ffmpeg -ss 10 -i out.mp4 -frames:v 1 /tmp/check.jpg`) before
   reporting. Tell the user what you made and where.

### Cutting ranges out of one file

Build the filter from the keep list (a script is easiest for many cuts):

```sh
ffmpeg -i program.mp4 -filter_complex "
  [0:v]trim=0.40:12.80,setpts=PTS-STARTPTS[v0];[0:a]atrim=0.40:12.80,asetpts=PTS-STARTPTS[a0];
  [0:v]trim=15.10:41.00,setpts=PTS-STARTPTS[v1];[0:a]atrim=15.10:41.00,asetpts=PTS-STARTPTS[a1];
  [v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]" \
  -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart edits/cut.mp4
```

### Joining takes and clips

Cut each piece to its own file (`/tmp/piece-01.mp4`, …) with the same
size, frame rate and sound, then join them. A piece from a clip or a take
of another shape is fitted with padding (or cropped, if the user wants it
to fill):

```sh
ffmpeg -i clip.mov -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1" \
  -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -ar 48000 -ac 2 /tmp/piece-01.mp4
```

A clip with no sound needs silence to join with the rest: add
`-f lavfi -t <its length> -i anullsrc=r=48000:cl=stereo` as an input and
`-map 0:v -map 1:a`. Then list the pieces and join them without
re-encoding:

```sh
printf "file '/tmp/piece-%02d.mp4'\n" 1 2 3 > /tmp/pieces.txt
ffmpeg -f concat -safe 0 -i /tmp/pieces.txt -c copy -movflags +faststart edits/video.mp4
```

The GPU encodes much faster on long videos:
`-vaapi_device /dev/dri/renderD128` before `-i`, `,format=nv12,hwupload` at
the end of the video chain, and `-c:v h264_vaapi -qp 20` instead of libx264.

### Vertical (9:16) from a landscape take

The classic layout: the screen across the top, the face filling the rest.
With `screen.start = -0.183`, skip 0.183 s of the screen to line it up:

```sh
ffmpeg -ss 0.183 -i screen.mp4 -i camera.mp4 -i mic.ogg -filter_complex "
  [0:v]scale=1080:-2[s];
  [1:v]scale=1080:1245:force_original_aspect_ratio=increase,crop=1080:1245[c];
  [s][c]vstack=inputs=2,crop=1080:1920:0:0,setsar=1[v]" \
  -map "[v]" -map 2:a -shortest -c:v libx264 -crf 19 -preset medium -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart edits/vertical.mp4
```

Work out the camera's height as `1920 - screen height` for the screen's real
shape (a 16:10 screen is 675 tall at 1080 wide). Flip the camera with
`hflip` if `mirrored` is true and the user wants it as they saw it.
Camera-only takes are cropped to the middle: `crop=ih*9/16:ih,scale=1080:1920`.
Zooming into the part of the screen being talked about (`crop` around the
pointer's area) often reads better on a phone than the whole screen.

### Captions

Short-form captions are 1 to 4 words at a time, big, bold and centered in
the lower middle. Write an ASS file from the transcript's words, then burn
it in with libass:

```
[Script Info]
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginV
Style: Cap,Inter,92,&H00FFFFFF,&H00000000,&H64000000,1,1,6,0,2,560

[Events]
Format: Layer, Start, End, Style, Text
Dialogue: 0,0:00:00.42,0:00:01.10,Cap,So today I want
```

```sh
ffmpeg -i edits/vertical.mp4 -vf "subtitles=edits/captions.ass" -c:v libx264 -crf 19 -c:a copy edits/vertical-captions.mp4
```

Times in the captions must be on the edited video's clock: shift each word
by what was cut before it, and by the length of the pieces before its
take's. For YouTube, also write an `.srt` beside the
video rather than burning captions in.

### Sound

- Even out the level for posting: `-af loudnorm=I=-14:TP=-1:LRA=11`.
- `mic.ogg` is the voice alone, cleaner to work from than the program's
  sound when the computer's sound was mixed in (`tracks.program.audio` is
  `"voice+computer"`).

### Chapters and descriptions

For YouTube, write `edits/youtube-chapters.txt` (`0:00 Intro`, one per
line, the first at 0:00, at least three, each 10 s or longer) from the
transcript's sentences, on the edited video's clock, and a short
description if asked.

import { getFsBridge, type FsBridge } from '@/lib/fs';
import { CAMERA_FOLDER, cameraItemKind, EFFECTS } from '@/shared/cameraEffects';
import { CommandError, type Area, type CommandContext, type Param } from './types';
import { call, command, need } from './util';

/**
 * `din camera`: what Camera has taken, and taking more as its shutter does.
 * Taking happens in Camera's window (it has the camera), so those commands
 * open Camera with an `action`, which it takes as its shutter's press, and
 * wait for what it saves in ~/Pictures/Camera.
 */

interface Taken {
  name: string;
  path: string;
  kind: 'photo' | 'video';
  modified: string;
}

const files = () => need(getFsBridge(), 'Files');

async function folder(fs: FsBridge): Promise<string> {
  return `${(await call(fs.homedir())).replace(/\/$/, '')}/${CAMERA_FOLDER}`;
}

/** What's in the folder, newest first. */
async function taken(fs: FsBridge): Promise<Taken[]> {
  const dir = await folder(fs);
  const listing = await fs.readdir(dir).catch(() => null);
  if (!listing) return [];
  return listing.entries
    .flatMap((e) => {
      const kind = e.kind === 'file' ? cameraItemKind(e.name) : null;
      return kind ? [{ name: e.name, path: `${dir}/${e.name}`, kind, mtime: e.mtimeMs ?? 0 }] : [];
    })
    .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))
    .map(({ mtime, ...t }) => ({ ...t, modified: new Date(mtime).toISOString() }));
}

/** Wait for something new in the folder, up to `ms`. */
async function newOne(fs: FsBridge, before: Set<string>, kind: 'photo' | 'video', ms: number): Promise<Taken | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const fresh = (await taken(fs)).find((t) => t.kind === kind && !before.has(t.path));
    if (fresh) return fresh;
  }
  return null;
}

/** Tell Camera to do something, as its shutter would. */
function act(ctx: CommandContext, action: string, params: Record<string, unknown> = {}): void {
  ctx.actions.open('camera', { ...params, action, nonce: Date.now() });
}

const EFFECT: Param = { name: 'effect', type: 'string', optional: true, choices: EFFECTS.map((e) => e.id), help: 'The effect to take it with (default: the one Camera has on); see din camera effects' };
const COUNTDOWN: Param = { name: 'countdown', type: 'boolean', optional: true, help: 'Count 3, 2, 1 first, or with --no-countdown, take it at once (default: as Camera is set)' };

/** Recording started from here, to know which new file is its video. */
let recordingSince: Set<string> | null = null;

export const cameraArea: Area = {
  name: 'camera',
  summary: 'Camera: take photos and videos with the computer’s camera, with effects, into ~/Pictures/Camera',
  commands: [
    command('camera', 'photos', 'The photos and videos Camera has taken, newest first', [], async () => {
      const list = await taken(files());
      return { data: list, text: list.length ? list.map((t) => [t.name, t.kind, t.modified, t.path].join('\t')).join('\n') : 'Nothing taken yet' };
    }),
    command('camera', 'effects', 'The effects Camera can take with', [], () => ({
      data: EFFECTS.map(({ id, name }) => ({ id, name })),
      text: EFFECTS.map((e) => `${e.id}\t${e.name}`).join('\n'),
    })),
    command(
      'camera',
      'take',
      'Take a photo (or four, as one picture) as Camera’s shutter does, and print where it was saved',
      [{ name: 'four', type: 'boolean', optional: true, help: 'Take four in a row, saved as one picture two by two' }, EFFECT, COUNTDOWN],
      async (args, ctx) => {
        const fs = files();
        const before = new Set((await taken(fs)).map((t) => t.path));
        act(ctx, 'take', { mode: args.optBool('four') ? 'four-up' : 'photo', effect: args.optString('effect'), countdown: args.optBool('countdown') });
        ctx.progress?.({ text: 'Taking a photo' });
        const photo = await newOne(fs, before, 'photo', 30_000);
        if (!photo) throw new CommandError('Camera didn’t take a photo (is there a camera?)');
        return { data: photo, text: photo.path };
      },
    ),
    command('camera', 'record', 'Start recording a video, as Camera’s shutter does in video; din camera stop ends it', [EFFECT, COUNTDOWN], async (args, ctx) => {
      recordingSince = new Set((await taken(files())).map((t) => t.path));
      act(ctx, 'record', { effect: args.optString('effect'), countdown: args.optBool('countdown') });
      return { text: 'Recording; din camera stop ends it' };
    }),
    command('camera', 'stop', 'Stop recording, save the video and print where', [], async (_args, ctx) => {
      const fs = files();
      const before = recordingSince ?? new Set((await taken(fs)).map((t) => t.path));
      recordingSince = null;
      act(ctx, 'stop');
      ctx.progress?.({ text: 'Saving the video' });
      const video = await newOne(fs, before, 'video', 60_000);
      if (!video) throw new CommandError('Camera wasn’t recording');
      return { data: video, text: video.path };
    }),
  ],
};

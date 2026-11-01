import { getCaptureBridge, type CaptureBridge, type TakeInfo } from '@/lib/capture';
import { formatRecordingTime } from '@/lib/screenRecorder';
import { CommandError, type Area, type CommandContext, type Param } from './types';
import { call, command, need, pick } from './util';

/**
 * `din studio`: Studio's takes (electron/capture.mts), and recording and
 * going live as its buttons do. Recording happens in Studio's window (it has
 * the camera), so those commands open Studio with an `action`, which it
 * takes as its own buttons' presses.
 */

const capture = () => need(getCaptureBridge(), 'Studio');
const TAKE: Param = { name: 'take', type: 'string', positional: true, help: 'The take, by its folder, name or title' };

async function take(query: string): Promise<TakeInfo> {
  const takes = await call(capture().takes());
  return pick(takes, query.replace(/\/+$/, ''), (t) => [t.path, t.name, t.title], 'take');
}

function describe(t: TakeInfo): string {
  const state = t.status === 'ready' ? (t.transcript === 'working' ? 'transcribing' : '') : t.status;
  return [t.title, formatRecordingTime(t.duration * 1000), t.path, state].filter(Boolean).join('\t');
}

/** Tell Studio to do something, as its own buttons would. */
function act(ctx: CommandContext, action: string, params: Record<string, unknown> = {}): void {
  ctx.actions.open('studio', { ...params, action, nonce: Date.now() });
}

/** Wait for a change in what Studio is doing, up to `ms`. */
async function until(bridge: CaptureBridge, done: (state: Awaited<ReturnType<CaptureBridge['status']>>['state']) => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (done((await call(bridge.status())).state)) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

export const studioArea: Area = {
  name: 'studio',
  summary: 'Studio: record yourself and the screen, go live, and the takes to edit',
  commands: [
    command('studio', 'takes', 'The takes in ~/Videos/Studio, newest first', [], async () => {
      const takes = await call(capture().takes());
      return { data: takes, text: takes.length ? takes.map(describe).join('\n') : 'No takes yet' };
    }),
    command(
      'studio',
      'record',
      'Start a take, after Studio’s countdown; `din studio stop` ends it',
      [
        { name: 'scene', type: 'string', optional: true, choices: ['screen-camera', 'camera', 'screen'], help: 'What to record (default: what Studio shows)' },
        { name: 'aspect', type: 'string', optional: true, choices: ['16:9', '9:16', '1:1'], help: 'The picture’s shape (default: what Studio shows)' },
      ],
      async (args, ctx) => {
        const bridge = capture();
        if ((await call(bridge.status())).state.recording) throw new CommandError('Studio is already recording');
        act(ctx, 'record', { scene: args.optString('scene'), aspect: args.optString('aspect') });
        if (!(await until(bridge, (s) => s.recording !== null, 20_000))) throw new CommandError('Studio didn’t start recording');
        const { recording } = (await call(bridge.status())).state;
        return { data: recording, text: `Recording ${recording?.title ?? ''} to ${recording?.take ?? ''}` };
      },
    ),
    command('studio', 'stop', 'End the take and save it', [], async (_args, ctx) => {
      const bridge = capture();
      const { recording } = (await call(bridge.status())).state;
      if (!recording) throw new CommandError('Studio isn’t recording');
      act(ctx, 'stop');
      if (!(await until(bridge, (s) => s.recording === null, 60_000))) throw new CommandError('Studio didn’t stop recording');
      const saved = await call(bridge.take(recording.take));
      if (!saved) throw new CommandError('The take was thrown away');
      return { data: saved, text: saved.path };
    }),
    command(
      'studio',
      'mark',
      'Mark this moment in the take: a highlight, or with --retake, that what was just said should go',
      [{ name: 'retake', type: 'boolean', optional: true, help: 'Mark a mistake to cut instead' }],
      async (args, ctx) => {
        if (!(await call(capture().status())).state.recording) throw new CommandError('Studio isn’t recording');
        act(ctx, 'mark', { kind: args.optBool('retake') ? 'retake' : 'highlight' });
      },
    ),
    command('studio', 'transcribe', 'Write a take’s transcript.json again, every word with its time', [TAKE], async (args, ctx) => {
      const t = await take(args.string('take'));
      ctx.progress?.({ text: `Transcribing ${t.title}…` });
      await call(capture().transcribe(t.path));
      return { data: { path: `${t.path}/transcript.json` }, text: `${t.path}/transcript.json` };
    }),
    command('studio', 'destinations', 'Where Studio can go live', [], async () => {
      const list = await call(capture().destinations());
      return {
        data: list,
        text: list.length ? list.map((d) => `${d.name}\t${d.server}${d.hasKey ? '' : '\t(no stream key)'}`).join('\n') : 'No destinations yet: add one in Studio’s Go Live',
      };
    }),
    command(
      'studio',
      'go-live',
      'Start streaming what Studio shows (asks on screen first)',
      [{ name: 'to', type: 'string', optional: true, help: 'The destination, by name (default: the one used last)' }],
      async (args, ctx) => {
        const bridge = capture();
        const state = (await call(bridge.status())).state;
        if (state.live) throw new CommandError(`Already live on ${state.live.destination}`);
        const list = await call(bridge.destinations());
        if (list.length === 0) throw new CommandError('No destinations yet: add one in Studio’s Go Live');
        const to = args.optString('to');
        const destination = to ? pick(list, to, (d) => [d.id, d.name], 'destination') : undefined;
        const name = destination?.name ?? 'the destination Studio used last';
        const ok = await ctx.confirm({
          title: `Go live on ${destination?.name ?? 'your stream'}?`,
          description: `A command asked to start streaming what Studio shows, camera and microphone included, to ${name}. Anyone watching there will see it.`,
          action: 'Go Live',
        });
        if (!ok) throw new CommandError('You didn’t allow it');
        act(ctx, 'live', { destination: destination?.id });
        if (!(await until(bridge, (s) => s.live !== null, 30_000))) throw new CommandError('Studio didn’t go live');
        return { data: (await call(bridge.status())).state.live, text: `Live on ${destination?.name ?? 'your stream'}` };
      },
    ),
    command('studio', 'end-live', 'Stop streaming', [], async () => {
      const bridge = capture();
      if (!(await call(bridge.status())).state.live) throw new CommandError('Studio isn’t live');
      await call(bridge.streamStop());
    }),
  ],
};

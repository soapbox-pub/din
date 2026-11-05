import { getCaptureBridge, type CaptureBridge, type ProjectInfo, type ProjectItem, type TakeInfo } from '@/lib/capture';
import { formatRecordingTime } from '@/lib/screenRecorder';
import { CommandError, type Area, type CommandContext, type Param } from './types';
import { call, command, need, pick } from './util';

/**
 * `din studio`: Studio's projects and their takes and clips
 * (electron/capture.mts), and recording and
 * going live as its buttons do. Recording happens in Studio's window (it has
 * the camera), so those commands open Studio with an `action`, which it
 * takes as its own buttons' presses.
 */

const capture = () => need(getCaptureBridge(), 'Studio');
const TAKE: Param = { name: 'take', type: 'string', positional: true, help: 'The take or clip, by its folder, or its name or title (in --project, or the newest that matches)' };
const PROJECT: Param = { name: 'project', type: 'string', positional: true, help: 'The project, by its folder, name or title' };
const IN_PROJECT: Param = { name: 'project', type: 'string', optional: true, help: 'The project it’s in, by its folder, name or title' };

async function project(query: string): Promise<ProjectInfo> {
  const projects = await call(capture().projects());
  return pick(projects, query.replace(/\/+$/, ''), (p) => [p.path, p.name, p.title], 'project');
}

/** A project to change: a take from before projects is made into one first. */
async function openProject(query: string): Promise<ProjectInfo> {
  const p = await project(query);
  return p.single ? call(capture().openProject(p.path)) : p;
}

async function take(query: string, inProject?: string): Promise<TakeInfo> {
  const takes = inProject ? (await project(inProject)).items.map((i) => i.take) : await call(capture().takes());
  return pick(takes, query.replace(/\/+$/, ''), (t) => [t.path, t.name, t.title], 'take');
}

function describeProject(p: ProjectInfo): string {
  const kept = p.items.filter((i) => i.keep).length;
  return [p.title, `${kept} of ${p.items.length} in the edit`, p.path].join('\t');
}

function describeItem(item: ProjectItem, n: number): string {
  const t = item.take;
  const trim = item.in !== null || item.out !== null ? `from ${formatRecordingTime((item.in ?? 0) * 1000)} to ${formatRecordingTime((item.out ?? t.duration) * 1000)}` : '';
  return [
    `${n}.`,
    t.title,
    t.kind === 'clip' ? 'clip' : '',
    formatRecordingTime(t.duration * 1000),
    item.keep ? '' : 'left out',
    trim,
    item.note ? `note: ${item.note}` : '',
  ].filter(Boolean).join('\t');
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
  summary: 'Studio: record yourself and the screen into projects, bring clips in, arrange them for the Assistant to edit, and go live',
  commands: [
    command('studio', 'projects', 'The projects in ~/Videos/Studio, the one added to last first', [], async () => {
      const projects = await call(capture().projects());
      return { data: projects, text: projects.length ? projects.map(describeProject).join('\n') : 'No projects yet' };
    }),
    command('studio', 'project', 'A project’s takes and clips, in the order they go, with what’s left out, trims and notes', [PROJECT], async (args) => {
      const p = await project(args.string('project'));
      return { data: p, text: [p.title, p.path, ...p.items.map((item, i) => describeItem(item, i + 1))].join('\n') };
    }),
    command(
      'studio',
      'new-project',
      'Start a project, which Studio records into from now on',
      [{ name: 'title', type: 'string', positional: true, optional: true, help: 'Its name (default: New Project)' }],
      async (args, ctx) => {
        const made = await call(capture().createProject(args.optString('title')));
        act(ctx, 'project', { project: made.path });
        return { data: made, text: made.path };
      },
    ),
    command(
      'studio',
      'rename-project',
      'Rename a project (its folder keeps its name)',
      [PROJECT, { name: 'title', type: 'string', positional: true, help: 'The new name' }],
      async (args) => {
        const p = await openProject(args.string('project'));
        await call(capture().updateProject(p.path, { title: args.string('title') }));
      },
    ),
    command('studio', 'takes', 'Every take and clip, newest first; or one project’s, in its order', [{ ...IN_PROJECT, help: 'Only this project’s' }], async (args) => {
      const inProject = args.optString('project');
      const takes = await call(capture().takes(inProject ? (await project(inProject)).path : undefined));
      return { data: takes, text: takes.length ? takes.map(describe).join('\n') : 'No takes yet' };
    }),
    command(
      'studio',
      'arrange',
      'Say how a project’s edit uses a take or clip: in or left out, where it goes, the part to use, a note for the Assistant',
      [
        TAKE,
        IN_PROJECT,
        { name: 'use', type: 'boolean', optional: true, help: 'Use it in the edit, or with --no-use, leave it out' },
        { name: 'position', type: 'integer', optional: true, min: 1, help: 'Its place in the order, from 1' },
        { name: 'in', type: 'number', optional: true, min: 0, help: 'Where the part to use starts, in seconds (0 for its start)' },
        { name: 'out', type: 'number', optional: true, min: 0, help: 'Where it ends, in seconds (0 for its end)' },
        { name: 'note', type: 'string', optional: true, help: 'A note for the Assistant ("" to clear it)' },
      ],
      async (args) => {
        const t = await take(args.string('take'), args.optString('project'));
        if (!t.project) throw new CommandError(`${t.title} is from before projects: open it in Studio, or name it with din studio project, first`);
        const bridge = capture();
        let p = await call(bridge.project(t.project));
        if (!p) throw new CommandError('No such project');
        const position = args.optNumber('position');
        if (position !== undefined) {
          const order = p.items.map((i) => i.take.name).filter((n) => n !== t.name);
          order.splice(Math.min(order.length, position - 1), 0, t.name);
          p = await call(bridge.updateProject(p.path, { order }));
        }
        const edge = (name: 'in' | 'out') => {
          const value = args.optNumber(name);
          return value === undefined ? {} : { [name]: value > 0 ? value : null };
        };
        const item = { name: t.name, keep: args.optBool('use'), note: args.optString('note'), ...edge('in'), ...edge('out') };
        if (item.keep !== undefined || item.note !== undefined || args.has('in') || args.has('out')) p = await call(bridge.updateProject(p.path, { item }));
        const index = p.items.findIndex((i) => i.take.path === t.path);
        return { data: p.items[index], text: describeItem(p.items[index]!, index + 1) };
      },
    ),
    command(
      'studio',
      'import',
      'Bring video or sound files into a project as clips (copied in, then transcribed)',
      [PROJECT, { name: 'files', type: 'path', positional: true, rest: true, help: 'The files' }],
      async (args, ctx) => {
        const files = args.list('files');
        if (files.length === 0) throw new CommandError('Name a file to bring in', 'usage');
        const bridge = capture();
        if (!bridge.importFile) throw new CommandError('Bringing files in isn’t available here');
        const p = await openProject(args.string('project'));
        const added: TakeInfo[] = [];
        for (const file of files) {
          ctx.progress?.({ text: `Adding ${file.split('/').pop()}…` });
          const clip = await call(bridge.importFile(p.path, file));
          if (clip) added.push(clip);
        }
        return { data: added, text: added.map((c) => c.path).join('\n') };
      },
    ),
    command(
      'studio',
      'record',
      'Start a take, after Studio’s countdown; `din studio stop` ends it',
      [
        { name: 'project', type: 'string', optional: true, help: 'The project to record into (default: the one Studio has open, or a new one)' },
        { name: 'scene', type: 'string', optional: true, choices: ['screen-camera', 'camera', 'screen'], help: 'What to record (default: what Studio shows)' },
        { name: 'aspect', type: 'string', optional: true, choices: ['16:9', '9:16', '1:1'], help: 'The picture’s shape (default: what Studio shows)' },
      ],
      async (args, ctx) => {
        const bridge = capture();
        if ((await call(bridge.status())).state.recording) throw new CommandError('Studio is already recording');
        const into = args.optString('project');
        act(ctx, 'record', { scene: args.optString('scene'), aspect: args.optString('aspect'), project: into ? (await openProject(into)).path : undefined });
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

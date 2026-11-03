import { describeFeature, getFeaturesBridge, removalConsequence, type FeatureState } from '@/lib/features';
import { CommandError, type Area, type Param } from './types';
import { call, command, need, pick } from './util';

/**
 * `din features`: Settings → Optional Features, DinOS's parts kept off the
 * disk until wanted (electron/features.mts), installed and removed with the
 * same bridge calls its buttons make.
 */

const features = () => need(getFeaturesBridge(), 'Optional features');
const FEATURE: Param = { name: 'feature', type: 'string', positional: true, help: 'The feature, by id or name (din features list)' };

async function list(): Promise<FeatureState[]> {
  const state = await call(features().state());
  if (!state.available) throw new CommandError('This computer has no optional features');
  return state.features;
}

async function feature(query: string): Promise<FeatureState> {
  return pick(await list(), query, (f) => [f.id, f.title], 'feature');
}

export const featuresArea: Area = {
  name: 'features',
  summary: 'Optional features: Wine, QEMU, Whisper and more, installed when wanted',
  commands: [
    command('features', 'list', 'Each optional feature, and whether it’s installed', [], async () => {
      const all = await list();
      return { data: all, text: all.map((f) => `${f.id}\t${f.title}\t${describeFeature(f)}`).join('\n') };
    }),
    command('features', 'install', 'Install a feature, or every one with “all”', [FEATURE], async (args, ctx) => {
      const query = args.string('feature');
      const all = query.toLowerCase() === 'all';
      const f = all ? null : await feature(query);
      // What's downloading now, as Settings shows it.
      const stop = features().onChanged((state) => {
        const busy = state.features.find((x) => x.busy && x.busy.action === 'install' && x.busy.phase !== 'waiting');
        if (!busy?.busy) return;
        const text = `${busy.title}: ${describeFeature(busy)}`;
        ctx.progress?.(busy.busy.progress !== null ? { text, percent: Math.round(busy.busy.progress * 100) } : { text });
      });
      try {
        if (!f) {
          await call(features().installAll());
          return { text: 'Every optional feature is installed' };
        }
        await call(features().install(f.id));
        return { text: `${f.title} is installed` };
      } finally {
        stop();
      }
    }),
    command('features', 'remove', 'Remove a feature and free its space', [FEATURE], async (args, ctx) => {
      const f = await feature(args.string('feature'));
      if (!f.installed) return { text: `${f.title} isn’t installed` };
      const ok = await ctx.confirm({
        title: `Remove ${f.title}?`,
        description: `A command asked to remove it. ${removalConsequence(f)}`,
        action: 'Remove',
        destructive: true,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      await call(features().remove(f.id));
      return { text: `${f.title} is removed` };
    }),
  ],
};

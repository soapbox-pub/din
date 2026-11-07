import { getGamesBridge, type Game } from '@/lib/games';
import { CommandError, type Area, type Param } from './types';
import { call, command, need, pick } from './util';

/**
 * `din games`: the Games app's library (electron/games.mts), and playing a
 * game full screen as its Play button does.
 */

const games = () => need(getGamesBridge(), 'Games');
const GAME: Param = { name: 'game', type: 'string', positional: true, help: 'The game, by title or id' };
const SYSTEM: Param = { name: 'system', type: 'string', optional: true, help: 'Its system, by folder name (snes, gba, n64…)' };

async function game(query: string, system?: string): Promise<Game> {
  const { games: list } = await call(games().library());
  const within = system ? list.filter((g) => g.system === system.toLowerCase()) : list;
  if (system && !within.length) throw new CommandError(`No games for “${system}”`);
  return pick(within, query, (g) => [g.id, g.title], 'game');
}

function hours(seconds: number): string {
  if (seconds < 60) return 'not played';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

export const gamesArea: Area = {
  name: 'games',
  summary: 'Games in ~/roms: list them, play one, quit it',
  commands: [
    command('games', 'systems', 'The systems with games, how many each has, and whether they play', [], async () => {
      const { systems } = await call(games().library());
      return {
        data: systems,
        text: systems.length
          ? systems.map((s) => `${s.id}\t${s.name}\t${s.count}\t${s.playable ? 'plays' : (s.unavailable ?? '')}`).join('\n')
          : 'No games: put them in ~/roms, a folder for each system (snes, gba, n64…)',
      };
    }),
    command(
      'games',
      'list',
      'The games, A to Z',
      [SYSTEM, { name: 'favorites', type: 'boolean', optional: true, help: 'Only favorites' }, { name: 'recent', type: 'boolean', optional: true, help: 'Recently played first, only those played' }],
      async (args) => {
        const { games: all } = await call(games().library());
        const system = args.optString('system')?.toLowerCase();
        let list = all.filter((g) => (!system || g.system === system) && (!args.optBool('favorites') || g.favorite));
        if (args.optBool('recent')) list = list.filter((g) => g.lastPlayed).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0));
        return {
          data: list,
          text: list.length ? list.map((g) => `${g.id}\t${g.title}\t${hours(g.playTime)}${g.favorite ? '\t★' : ''}`).join('\n') : 'No games',
        };
      },
    ),
    command(
      'games',
      'play',
      'Play a game full screen, where it was left; quits whatever’s being played',
      [GAME, SYSTEM, { name: 'fresh', type: 'boolean', optional: true, help: 'Start from the beginning' }],
      async (args) => {
        const g = await game(args.string('game'), args.optString('system'));
        await call(games().play(g.id, { fresh: args.optBool('fresh') }));
        return { data: g, text: `Playing ${g.title}` };
      },
    ),
    command('games', 'quit', 'Quit the game being played, keeping where it was', [], async () => {
      const { running } = await call(games().status());
      if (!running) return { data: null, text: 'Nothing’s being played' };
      await call(games().stop());
      return { data: running, text: `Quit ${running.title}` };
    }),
    command('games', 'status', 'What’s being played, and whether the emulators are installed', [], async () => {
      const status = await call(games().status());
      return {
        data: status,
        text: [status.installed ? 'Emulators installed' : 'Emulators not installed', status.running ? `Playing ${status.running.title}` : 'Nothing’s being played'].join('\n'),
      };
    }),
    command(
      'games',
      'favorite',
      'Make a game a favorite, or not',
      [GAME, SYSTEM, { name: 'off', type: 'boolean', optional: true, help: 'No longer a favorite' }],
      async (args) => {
        const g = await game(args.string('game'), args.optString('system'));
        await call(games().setFavorite(g.id, !args.optBool('off')));
      },
    ),
    command('games', 'start-over', 'Forget where a game was left, so it starts from the beginning (its saves stay)', [GAME, SYSTEM], async (args, ctx) => {
      const g = await game(args.string('game'), args.optString('system'));
      const ok = await ctx.confirm({
        title: `Start ${g.title} over?`,
        description: 'Where you left it is forgotten. Saves you made in the game stay.',
        action: 'Start Over',
        destructive: true,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      await call(games().forgetResume(g.id));
    }),
  ],
};

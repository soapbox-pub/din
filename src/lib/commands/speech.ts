import { cancelSpeech, getSpeechState, hasSpeechBridge, refreshSpeech, speak, SPEECH_NEEDS_FEATURE } from '@/lib/speech';
import { speakableText } from '@/shared/speakable';
import { CommandError, type Area } from './types';
import { bare, command, pick } from './util';

/**
 * `din speak`: text read aloud in Din's voice (src/lib/speech.ts), the one
 * the assistant reads its replies in, waiting its turn behind anything
 * already being said.
 */

/** Whose the command line's utterances are. */
const OWNER = { name: 'din speak' };

async function voices() {
  if (!hasSpeechBridge()) throw new CommandError('Speech isn’t available here');
  await refreshSpeech();
  const state = getSpeechState();
  if (!state.available) throw new CommandError(SPEECH_NEEDS_FEATURE);
  return state.voices;
}

export const speakArea: Area = {
  name: 'speak',
  summary: 'Read text aloud in Din’s voice (the Speech optional feature)',
  commands: [
    bare(command('speak', 'say', 'Say text aloud, Markdown read as a person would, and finish once it’s said', [
      { name: 'text', type: 'string', positional: true, rest: true, help: 'What to say' },
      { name: 'voice', type: 'string', optional: true, help: 'A voice, by id or name (din speak voices); Settings’ otherwise' },
      { name: 'markdown', type: 'boolean', optional: true, help: 'Read the text as Markdown: no code blocks, links by their words' },
    ], async (args) => {
      const raw = args.list('text').join(' ').trim();
      if (!raw) throw new CommandError('Nothing to say', 'usage');
      const all = await voices();
      const query = args.optString('voice');
      const voice = query ? pick(all, query, (v) => [v.id, v.name], 'voice').id : undefined;
      const text = args.optBool('markdown') ? speakableText(raw) : raw;
      await new Promise<void>((resolve, reject) =>
        speak({
          text,
          voice,
          owner: OWNER,
          onEnd: resolve,
          onError: (error, message) => (error === 'canceled' || error === 'interrupted' ? resolve() : reject(new CommandError(message))),
        }),
      );
      return { text: '' };
    })),
    command('speak', 'stop', 'Stop speaking, and drop what’s waiting to be said', [], () => {
      cancelSpeech();
      return { text: 'Stopped' };
    }),
    command('speak', 'voices', 'The voices Din can speak in', [], async () => {
      const all = await voices();
      return { data: all, text: all.map((v) => `${v.id}\t${v.name}\t${v.lang}`).join('\n') };
    }),
  ],
};

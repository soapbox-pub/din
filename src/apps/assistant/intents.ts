import type { Launch } from '@/shared/launch';

/**
 * What other apps can open the Assistant for, as a launch param:
 *
 *   window.open(appLink('assistant', { intent: 'studio.edit', directory, prompt, title, nonce, intentNonce: nonce }))
 *
 * An app sends data, never instructions: what the agent is told about an
 * intent is written here, and an app fills in only its fields. A
 * conversation starts on its own only for the apps an intent trusts (by
 * `din.app.opener`, which the desktop sets); for any other, the message waits
 * in the composer for the user to send. `intentNonce` must equal `nonce`,
 * since launch params are merged into the last launch's.
 */

export interface LaunchIntent {
  /** The folder the conversation works in. */
  directory: string;
  /** The user's request, as they typed it in the app. */
  prompt: string;
  /** Given to the agent ahead of the request, when the opener is trusted; null when it isn't. */
  context: { text: string; description: string } | null;
}

interface IntentKind {
  /** Apps that may start the conversation without the user sending it. */
  openers: readonly string[];
  context(fields: { directory: string; title: string }): { text: string; description: string };
}

const INTENTS: Record<string, IntentKind> = {
  'studio.edit': {
    openers: ['studio'],
    context: ({ directory, title }) => ({
      description: `From Studio: ${title}`,
      text: [
        `The user made the project “${title}” in Studio, Din’s recorder, and asks you to make something from it.`,
        `The project is the folder you’re working in (${directory}): project.json lists its takes and clips in the order they go, which ones to use, and the user’s trims and notes. Each is a folder in takes/, whose take.json says what each track is and lines them up on one clock, and whose transcript.json has every word spoken with its time.`,
        'Load the studio skill before you start: it explains the project and its takes, and how to edit them with ffmpeg.',
        'Put what you make in the project’s edits folder, and leave the recorded files as they are.',
      ].join('\n'),
    }),
  },
};

/**
 * The intent a launch carries, if it's one of this launch's own and well
 * formed. `opener` is `din.app.opener`; a window Din reopened keeps its last
 * params, whose intent was carried out then.
 */
export function intentOf({ params }: Pick<Launch, 'params'>, opener: string | null, reopened = false): LaunchIntent | null {
  if (reopened) return null;
  const kind = typeof params.intent === 'string' ? INTENTS[params.intent] : undefined;
  if (!kind || params.nonce === undefined || params.intentNonce !== params.nonce) return null;
  const { directory, prompt, title } = params;
  if (typeof directory !== 'string' || !directory.startsWith('/') || typeof prompt !== 'string' || !prompt.trim()) return null;
  const name = typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : directory.split('/').pop() || directory;
  return {
    directory,
    prompt: prompt.slice(0, 20_000),
    context: opener && kind.openers.includes(opener) ? kind.context({ directory, title: name }) : null,
  };
}

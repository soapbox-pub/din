import { secretName, type PromptAttachment } from '@/lib/assistant';
import { getFsBridge } from '@/lib/fs';

/**
 * Files OpenCode hands the model itself, by their names: pictures and PDFs
 * (its to-llm-message.ts). It tells what a file is from its first bytes
 * alone, and leaves out, without a word, anything it can't send: audio,
 * archives, documents. Those, and text (which it would paste in whole),
 * go as their paths instead, for the agent to open with its tools.
 */
const MODEL_READS = /\.(png|jpe?g|gif|webp|pdf)$/i;

/** Names of recordings and other sound, which play in their chips. */
export const AUDIO_NAME = /\.(ogg|oga|opus|webm|weba|wav|mp3|m4a|aac|flac)$/i;

/** How a path goes in the message, the way OpenCode names one it attaches. */
const ATTACHED = 'Attached file: ';

/** Where recordings are kept, under home: they outlast the conversation's restarts. */
export const RECORDINGS_DIR = '.local/share/din/assistant/recordings';

/** A file:// URL for a path, each segment escaped. */
export function fileUri(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** The local path of a `file:` URI, or null. */
export function pathOfFileUri(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return null;
  }
}

/** A path as an attachment, named for its file. */
export function attachmentOf(path: string): PromptAttachment {
  return { uri: fileUri(path), name: path.split('/').pop() || path };
}

/** How a secret goes in the message: its name, and how to use it. */
const ATTACHED_SECRET = 'Attached secret: $';
const SECRET_NOTE = ' (an environment variable of this conversation’s shell commands; use it by reference and never print its value)';
const SECRET_LINE = /^Attached secret: \$([A-Za-z_][A-Za-z0-9_]*)\b/;

/** Whether the model gets a file itself (a pasted picture, a picture or PDF on disk), not its path. */
function modelReads(file: PromptAttachment): boolean {
  if (secretName(file) !== null) return false;
  const path = pathOfFileUri(file.uri);
  return path === null || MODEL_READS.test(path);
}

/**
 * A message as it's sent: files the model reads stay attached, and the rest
 * are named at the end of the text, one `Attached file: <path>` line each.
 * Secrets are named there too (`Attached secret: $NAME`) and stay among the
 * files, whose values `assistantApi.prompt` hands to the conversation.
 */
export function withAttachedPaths(text: string, files: PromptAttachment[]): { text: string; files: PromptAttachment[] } {
  const lines = files.flatMap((f) => {
    if (modelReads(f)) return [];
    const secret = secretName(f);
    return [secret !== null ? ATTACHED_SECRET + secret + SECRET_NOTE : ATTACHED + pathOfFileUri(f.uri)!];
  });
  if (lines.length === 0) return { text, files };
  const block = lines.join('\n');
  return { text: text ? `${text}\n\n${block}` : block, files: files.filter((f) => modelReads(f) || secretName(f) !== null) };
}

/**
 * A sent message's text without the paths and secrets `withAttachedPaths`
 * put at its end, and those: shown as attachments again, and back in the
 * composer as such when it's undone.
 */
export function splitAttachedPaths(text: string): { text: string; paths: string[]; secrets: string[] } {
  const lines = text.split('\n');
  const paths: string[] = [];
  const secrets: string[] = [];
  for (;;) {
    const last = lines.at(-1);
    if (last === undefined) break;
    const secret = SECRET_LINE.exec(last);
    if (secret) secrets.unshift(secret[1]);
    else if (last.startsWith(`${ATTACHED}/`)) paths.unshift(last.slice(ATTACHED.length));
    else break;
    lines.pop();
  }
  if ((paths.length === 0 && secrets.length === 0) || (lines.length > 0 && lines.at(-1) !== '')) return { text, paths: [], secrets: [] };
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return { text: lines.join('\n'), paths, secrets };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Keep a recording in RECORDINGS_DIR, named for when it ended; resolves to its path. */
export async function saveRecording(audio: Blob, extension: string): Promise<string> {
  const fs = getFsBridge();
  if (!fs) throw new Error('Recordings need Din’s desktop app');
  const dir = `${await fs.homedir()}/${RECORDINGS_DIR}`;
  await fs.mkdir(dir);
  const d = new Date();
  const name = `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.${extension}`;
  const path = `${dir}/${name}`;
  await fs.writeFile(path, new Uint8Array(await audio.arrayBuffer()));
  return path;
}

/** Whether this window may record: a microphone, Din's files to keep it in, and (in an app) the permission. */
export async function canRecordAudio(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined' || !getFsBridge()) return false;
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return status.state !== 'denied';
  } catch {
    return true;
  }
}

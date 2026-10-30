import '../shared/base.css';
import './style.css';
import { followShape, followTheme, napplet } from '../shared/napplet';

followTheme();
followShape();

const root = document.querySelector<HTMLElement>('.profile')!;
const banner = document.querySelector<HTMLElement>('.banner')!;
const avatar = document.querySelector<HTMLElement>('.avatar')!;
const name = document.querySelector<HTMLElement>('.name')!;
const nip05 = document.querySelector<HTMLElement>('.nip05')!;
const about = document.querySelector<HTMLElement>('.about')!;
const follows = document.querySelector<HTMLElement>('.follows')!;

/** A short npub-ish label for a pubkey with no name. */
function shortKey(pubkey: string): string {
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

/** A picture from the web through the desktop (NAP-RESOURCE), as a blob: URL, or null. */
async function picture(url: string | undefined): Promise<string | null> {
  if (!url || !/^https:\/\//.test(url) || !napplet.resource) return null;
  try {
    const blob = await napplet.resource.bytes(url);
    if (!blob.type.startsWith('image/')) return null;
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

const shown: string[] = [];

/** Show a picture as an element's background, once it's loaded. */
async function showPicture(el: HTMLElement, url: string | undefined): Promise<void> {
  const src = await picture(url);
  for (const old of shown.splice(0)) URL.revokeObjectURL(old);
  el.style.backgroundImage = src ? `url("${src}")` : '';
  el.classList.toggle('has-picture', !!src);
  if (src) shown.push(src);
}

function initials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return letters.map((w) => [...w][0] ?? '').join('').toUpperCase() || '?';
}

async function load(): Promise<void> {
  const identity = napplet.identity;
  if (!identity) {
    root.dataset.state = 'unavailable';
    name.textContent = 'Profile unavailable';
    return;
  }
  root.dataset.state = 'loading';
  const pubkey = await identity.getPublicKey().catch(() => '');
  if (!pubkey) {
    root.dataset.state = 'signed-out';
    avatar.textContent = '';
    name.textContent = 'Not signed in';
    nip05.textContent = '';
    about.textContent = 'Sign in to Din to see your profile here.';
    follows.textContent = '';
    return;
  }
  const [profile, following] = await Promise.all([
    identity.getProfile().catch(() => null),
    identity.getFollows().catch(() => null),
  ]);
  const label = profile?.displayName || profile?.name || shortKey(pubkey);
  root.dataset.state = 'ready';
  avatar.textContent = initials(label);
  void showPicture(avatar, profile?.picture);
  void showPicture(banner, profile?.banner);
  name.textContent = label;
  nip05.textContent = profile?.nip05?.replace(/^_@/, '') ?? '';
  about.textContent = profile?.about ?? '';
  follows.textContent = following ? `Following ${following.length.toLocaleString()}` : '';
}

void load();
napplet.identity?.onChanged(() => void load());

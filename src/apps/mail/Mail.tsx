import { lazy, Suspense, useMemo } from 'react';
import { parseMailto } from '@/lib/mailto';
import { restoredState, windowLaunch, type Launch } from '@/shared/launch';
import { blankSeed, escapeHtml, parseAddresses, type ComposeSeed } from './mail/format';
import { Viewer } from './mail/Viewer';
import { savedCompose } from './mail/restore';
import './mail/mail.css';

/** A message being written: its editor (TipTap) loads only in a window that writes one, not the viewer. */
const Compose = lazy(() => import('./mail/Compose').then((m) => ({ default: m.Compose })));

/**
 * A window is a viewer (mailboxes, list, message) or, launched with
 * `{ compose: ComposeSeed }`, `{ mailto }`, `new` (the New Message shortcut's)
 * or a share (its `share_target`'s, the files attached), a message being written.
 */
function seedOf(launch: Launch): ComposeSeed | null {
  const { params } = launch;
  if (params.compose && typeof params.compose === 'object') return { ...blankSeed(null), ...(params.compose as Partial<ComposeSeed>) };
  if (typeof params.mailto === 'string') {
    const m = parseMailto(params.mailto);
    return {
      ...blankSeed(null),
      to: parseAddresses(m.to.join(',')),
      cc: parseAddresses(m.cc.join(',')),
      bcc: parseAddresses(m.bcc.join(',')),
      subject: m.subject,
      html: m.body ? `<p>${escapeHtml(m.body).replace(/\r?\n/g, '<br>')}</p>` : '',
    };
  }
  if (typeof params.shareNonce === 'string') return sharedSeed(params);
  if ('new' in params) return blankSeed(null);
  return null;
}

/** A message started with what was shared to Mail (its `share_target`): the title as its subject, the text and link as its body. */
function sharedSeed(params: Record<string, unknown>): ComposeSeed {
  const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
  const body = text(params.text);
  const url = text(params.url);
  let link = '';
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') link = `<p><a href="${escapeHtml(u.href)}">${escapeHtml(u.href)}</a></p>`;
    else if (url) link = `<p>${escapeHtml(url)}</p>`;
  } catch {
    if (url) link = `<p>${escapeHtml(url)}</p>`;
  }
  return {
    ...blankSeed(null),
    subject: text(params.subject).slice(0, 500),
    html: (body ? `<p>${escapeHtml(body).replace(/\r?\n/g, '<br>')}</p>` : '') + link,
  };
}

export function Mail() {
  // A message being written comes back as it was left, not as it was started.
  const saved = useMemo(() => savedCompose(restoredState()), []);
  const seed = useMemo(() => (saved ? { ...blankSeed(null), ...saved.seed } : seedOf(windowLaunch())), [saved]);
  return seed ? (
    <Suspense>
      <Compose seed={seed} restored={saved ? { dirty: saved.dirty } : null} files={saved ? undefined : windowLaunch().files} />
    </Suspense>
  ) : (
    <Viewer />
  );
}

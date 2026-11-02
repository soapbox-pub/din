import { useMemo } from 'react';
import { parseMailto } from '@/lib/mailto';
import { restoredState, windowLaunch, type Launch } from '@/shared/launch';
import { blankSeed, escapeHtml, parseAddresses, type ComposeSeed } from './mail/format';
import { Compose } from './mail/Compose';
import { Viewer } from './mail/Viewer';
import { savedCompose } from './mail/restore';
import './mail/mail.css';

/**
 * A window is a viewer (mailboxes, list, message) or, launched with
 * `{ compose: ComposeSeed }`, `{ mailto }` or `new` (the New Message shortcut's), a
 * message being written.
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
  if ('new' in params) return blankSeed(null);
  return null;
}

export function Mail() {
  // A message being written comes back as it was left, not as it was started.
  const saved = useMemo(() => savedCompose(restoredState()), []);
  const seed = useMemo(() => (saved ? { ...blankSeed(null), ...saved.seed } : seedOf(windowLaunch())), [saved]);
  return seed ? <Compose seed={seed} restored={saved ? { dirty: saved.dirty } : null} /> : <Viewer />;
}

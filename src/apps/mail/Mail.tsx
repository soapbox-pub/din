import { useMemo } from 'react';
import { useDin } from '@/sdk/react';
import { parseMailto } from '@/lib/mailto';
import type { LaunchContext } from '@/sdk/din';
import { blankSeed, escapeHtml, parseAddresses, type ComposeSeed } from './mail/format';
import { Compose } from './mail/Compose';
import { Viewer } from './mail/Viewer';
import { savedCompose } from './mail/restore';
import './mail/mail.css';

/**
 * A window is a viewer (mailboxes, list, message) or, launched with
 * `{ compose: ComposeSeed }`, `{ mailto }` or the New Message shortcut, a
 * message being written.
 */
function seedOf(launch: LaunchContext): ComposeSeed | null {
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
  if (launch.shortcut === 'compose') return blankSeed(null);
  return null;
}

export function Mail() {
  const din = useDin();
  // A message being written comes back as it was left, not as it was started.
  const saved = useMemo(() => savedCompose(din.app.launch.state), [din]);
  const seed = useMemo(() => (saved ? { ...blankSeed(null), ...saved.seed } : seedOf(din.app.launch)), [din, saved]);
  return seed ? <Compose seed={seed} restored={saved ? { dirty: saved.dirty } : null} /> : <Viewer />;
}

import { lazy, Suspense, useMemo } from 'react';
import { parseMailto } from '@/lib/mailto';
import { restoredState, wasReopened, windowLaunch, type Launch } from '@/shared/launch';
import { blankSeed, escapeHtml, parseAddresses, type ComposeSeed } from './mail/format';
import { Viewer } from './mail/Viewer';
import { SettingsWindow } from './mail/AccountSettings';
import { RuleWindow } from './mail/RuleWindow';
import type { RuleSeed } from './mail/api';
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
  if (params.compose && typeof params.compose === 'object') {
    const seed = { ...blankSeed(null), ...(params.compose as Partial<ComposeSeed>) };
    // Another app's message is what a mailto: link could say: who, what,
    // and words. Bringing another message's attachments along, carrying on
    // a draft or marking a message answered is only Mail's own windows'.
    const opener = window.din?.app.opener ?? null;
    if (opener !== null && opener !== 'mail') return { ...seed, forwardFrom: null, draftUid: null, answering: null };
    return seed;
  }
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

/**
 * Files to attach as the message starts: only what was shared to Mail, and
 * only the first time. Any app can open Mail with files it holds, which
 * must not come ready to send; a window Din reopened had them already.
 */
function sharedFiles(launch: Launch): readonly FileSystemHandle[] | undefined {
  return typeof launch.params.shareNonce === 'string' && !wasReopened() ? launch.files : undefined;
}

export function Mail() {
  // A window opened for Mail's settings (openMailSettings), not a mailbox.
  const settings = useMemo(() => {
    const { params } = windowLaunch();
    return params.window === 'settings' ? { account: typeof params.account === 'string' ? params.account : null, section: params.section === 'rules' ? ('rules' as const) : null } : null;
  }, []);
  // A rule being made or edited (openRuleWindow).
  const rule = useMemo((): RuleSeed | null => {
    const { params } = windowLaunch();
    if (params.window !== 'rule' || typeof params.accountId !== 'string') return null;
    return {
      accountId: params.accountId,
      rule: typeof params.rule === 'string' ? params.rule : undefined,
      conditions: Array.isArray(params.conditions) ? (params.conditions as RuleSeed['conditions']) : undefined,
    };
  }, []);
  // A message being written comes back as it was left, not as it was started.
  const saved = useMemo(() => savedCompose(restoredState()), []);
  const seed = useMemo(() => (saved ? { ...blankSeed(null), ...saved.seed } : seedOf(windowLaunch())), [saved]);
  // What's written to start the message with (din mail send/reply --compose), above the signature.
  const written = useMemo(() => {
    const { params } = windowLaunch();
    return !saved && params.compose && typeof params.text === 'string' ? params.text : undefined;
  }, [saved]);
  if (settings) return <SettingsWindow initial={settings.account} section={settings.section} />;
  if (rule) return <RuleWindow seed={rule} />;
  return seed ? (
    <Suspense>
      <Compose seed={seed} written={written} restored={saved ? { dirty: saved.dirty } : null} files={saved ? undefined : sharedFiles(windowLaunch())} />
    </Suspense>
  ) : (
    <Viewer />
  );
}

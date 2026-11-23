// The inbox tabs Mail guesses for mail that isn't on Gmail
// (electron/mail-categories.mts), from the kinds of mail an inbox gets.

import { describe, expect, it } from 'vitest';
import { categorize, isAutomatedAddress } from '../mail-categories.mts';

const BULK = new Map([['list-unsubscribe', ['<https://example.com/u>']]]);

function tab(address: string, subject: string, fields: Map<string, string[]> | null = new Map()) {
  return categorize(fields, { name: '', address }, subject);
}

describe('categorize', () => {
  it('keeps mail from people in Primary', () => {
    expect(tab('jane@example.org', 'Re: Lunch on Friday?')).toBe('primary');
    expect(tab('j.smith@university.edu', 'Request for an interview')).toBe('primary');
    expect(tab('sam@gmail.com', 'Fwd: the invoice you asked about')).toBe('primary');
  });

  it('keeps a service’s notifications in Primary, even sent as a mailing list', () => {
    const list = new Map([['list-id', ['<repo.example>']], ['list-post', ['<mailto:reply@example>']]]);
    expect(tab('notifications@github.com', 'Re: [org/repo] Fix the build (PR #12)', list)).toBe('primary');
    expect(tab('noreply@github.com', '[GitHub] A workflow will be disabled')).toBe('primary');
  });

  it('keeps threads the user is part of in Primary, not ones they only watch', () => {
    const cc = (reason: string) => [{ name: '', address: 'alex@example.org' }, { name: '', address: `${reason}@noreply.github.com` }];
    const subject = 'Re: [org/repo] Fix the build (PR #12)';
    expect(categorize(BULK, { name: 'jane', address: 'notifications@github.com' }, subject, cc('mention'))).toBe('primary');
    expect(categorize(BULK, { name: 'jane', address: 'notifications@github.com' }, subject, cc('author'))).toBe('primary');
    expect(categorize(BULK, { name: 'jane', address: 'notifications@github.com' }, subject, cc('subscribed'))).toBe('primary');
    expect(categorize(BULK, { name: 'jane', address: 'notifications@github.com' }, subject, cc('push'))).toBe('primary');
    const gitlab = (reason: string) => new Map([...BULK, ['x-gitlab-notificationreason', [reason]]]);
    expect(tab('gitlab@mg.gitlab.com', 'Re: Project | Uploads fail (#338)', gitlab('mentioned'))).toBe('primary');
    expect(tab('gitlab@mg.gitlab.com', 'Re: Project | Uploads fail (#338)', gitlab(''))).toBe('primary');
  });

  it('keeps sign-ins in Primary, from any sender', () => {
    expect(tab('no-reply@getalby.com', 'Alby one-time login code: NIWH5E', BULK)).toBe('primary');
    expect(tab('no-reply@getalby.com', 'Alby: Login from new location or device')).toBe('primary');
    expect(tab('no-reply@instacart.com', '016360 is your Instacart verification code')).toBe('primary');
    expect(tab('no-reply@hs.email.nextdoor.com', 'Your login code is 901454', BULK)).toBe('primary');
    expect(tab('info@opencollective.com', 'Open Collective: Sign In')).toBe('primary');
    expect(tab('gitlab@mg.gitlab.com', 'Verify your identity')).toBe('primary');
    expect(tab('noreply@uber.com', 'New device sign-in')).toBe('primary');
    expect(tab('noreply@patient-message.com', 'Confirm your upcoming appointment')).toBe('primary');
    expect(tab('bot@notifications.heroku.com', 'Remember to Register a Backup MFA Verification Method')).toBe('primary');
    expect(tab('news@email.store.example', 'Sign in to save 20% off today', BULK)).toBe('promotions');
  });

  it('keeps a mailing list people write to in Primary', () => {
    const list = new Map([['list-id', ['<dev.lists.example.org>']], ['list-post', ['<mailto:dev@lists.example.org>']]]);
    expect(tab('someone@example.org', 'Re: [dev] Release plans', list)).toBe('primary');
  });

  it('keeps receipts, orders and account notices in Primary without bulk headers', () => {
    expect(tab('notifications@stripe.com', 'Payment of $22.00 from a customer')).toBe('primary');
    expect(tab('hello@bank.example', 'A vendor has charged your account $115.54')).toBe('primary');
    expect(tab('hello@bank.example', 'Your company received $20.44 from a client')).toBe('primary');
    expect(tab('shipment-tracking@amazon.com', 'Shipped 1 item: Computers')).toBe('primary');
    expect(tab('digitalorder-update@amazon.com', 'Your recent purchase')).toBe('primary');
    expect(tab('auto-confirm@amazon.com', 'Ordered 1 item')).toBe('primary');
    expect(tab('renewals@registrar.example', 'example.com will expire in 15 days')).toBe('primary');
    expect(tab('wordpress@site.example', '[Site] Please moderate: "Hello world!"')).toBe('primary');
    expect(tab('googleplay-noreply@google.com', 'Developer Program Policy Update')).toBe('primary');
    expect(tab('no-reply@mail.exchange.example', 'Price Alert: Bitcoin is down 5%')).toBe('primary');
    expect(tab('no_reply@email.apple.com', 'Your App Review Feedback')).toBe('primary');
  });

  it('puts marketing in Promotions, whoever it says it’s from', () => {
    expect(tab('support@shop.example', 'Classic Ocarina Restock', BULK)).toBe('promotions');
    expect(tab('support@shop.example', 'Blackout sale is approaching...', BULK)).toBe('promotions');
    expect(tab('notifications@mail.credit.example', 'Future you is going to love this', BULK)).toBe('promotions');
    expect(tab('noreply@broker.example', 'New: Earn a 2.50% bonus on deposits')).toBe('promotions');
    expect(tab('newsletter@mail.exchange.example', 'Why AI firms are racing to raise billions')).toBe('promotions');
    expect(tab('news@email.store.example', 'Save Big on Booster Bundles!', BULK)).toBe('promotions');
  });

  it('keeps bulk receipts in Primary', () => {
    expect(tab('orders@grocer.example', 'Your order is confirmed for October 31', BULK)).toBe('primary');
  });

  it('puts social networks in Social', () => {
    expect(tab('no-reply@rs.email.nextdoor.com', 'One neighbor has their decorations up', BULK)).toBe('social');
    expect(tab('messages-noreply@linkedin.com', 'People near you are solving this puzzle')).toBe('social');
  });
});

describe('isAutomatedAddress', () => {
  it('knows the addresses nobody reads', () => {
    expect(isAutomatedAddress('no-reply@example.com')).toBe(true);
    expect(isAutomatedAddress('do-not-reply@example.com')).toBe(true);
    expect(isAutomatedAddress('googleplay-noreply@google.com')).toBe(true);
    expect(isAutomatedAddress('reply+ABC123@reply.github.com')).toBe(true);
    expect(isAutomatedAddress('MAILER-DAEMON@example.com')).toBe(true);
    expect(isAutomatedAddress('jane@example.org')).toBe(false);
    expect(isAutomatedAddress('replies@example.org')).toBe(false);
  });
});

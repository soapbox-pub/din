import { describePhone, getPhoneDesktopBridge, type PhoneConversation, type PhoneDevice } from '@/lib/phone';
import { formatAddress, phoneDigits } from '@/shared/phone';
import { CommandError, type Area, type Param } from './types';
import { call, command, need, pick } from './util';

/**
 * `din phone`: the phones in Settings → Phone and their texts, as Messages
 * shows them (electron/phone.mts). Sending a text asks on screen first: it
 * can't be taken back. Pairing a phone is Bluetooth's (`din bluetooth pair`).
 */

const phone = () => need(getPhoneDesktopBridge(), 'Phones');
const PHONE: Param = { name: 'phone', type: 'string', optional: true, help: 'Which phone, by name (needed with more than one)' };
const CONVERSATION: Param = { name: 'conversation', type: 'string', positional: true, help: 'A contact’s name or a number' };

async function device(query: string | undefined): Promise<PhoneDevice> {
  const { phones } = await call(phone().state());
  if (phones.length === 0) throw new CommandError('No phones yet; add one in Settings → Phone');
  if (query) return pick(phones, query, (p) => [p.id, p.name], 'phone');
  if (phones.length > 1) throw new CommandError('There’s more than one phone; say which with --phone');
  return phones[0];
}

async function conversation(query: string, phoneId: string): Promise<PhoneConversation> {
  const list = await call(phone().conversations(phoneId));
  const digits = phoneDigits(query);
  const byNumber = digits.length >= 7 ? list.filter((c) => c.addresses.some((a) => phoneDigits(a) === digits)) : [];
  if (byNumber.length === 1) return byNumber[0];
  return pick(list, query, (c) => [c.threadId, c.name], 'conversation');
}

function time(ms: number): string {
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export const phoneArea: Area = {
  name: 'phone',
  summary: 'Phones and their text messages: list, read, send',
  commands: [
    command('phone', 'list', 'The phones, and whether each is connected', [], async () => {
      const state = await call(phone().state());
      const phones = state.phones.map((p) => ({ name: p.name, id: p.id, kind: p.kind, status: describePhone(p), unread: p.unread, error: p.error }));
      return {
        data: { phones, candidates: state.candidates },
        text: phones.length
          ? phones.map((p) => `${p.name}  ${p.status}${p.unread ? `  ${p.unread} unread` : ''}${p.error ? `\n  ${p.error}` : ''}`).join('\n')
          : 'No phones yet; add one in Settings → Phone',
      };
    }),
    command('phone', 'conversations', 'Conversations, newest first', [PHONE], async (args) => {
      const p = await device(args.optString('phone'));
      const list = await call(phone().conversations(p.id));
      return {
        data: list.map((c) => ({ name: c.name, addresses: c.addresses, unread: c.unread, last: c.last.body, time: c.last.time })),
        text: list.length
          ? list.map((c) => `${c.unread ? '*' : ' '} ${c.name}  ${time(c.last.time)}\n    ${c.last.outgoing ? 'You: ' : ''}${c.last.body.replace(/\s+/g, ' ').slice(0, 80)}`).join('\n')
          : 'No conversations yet',
      };
    }),
    command('phone', 'messages', 'A conversation’s messages', [CONVERSATION, PHONE, { name: 'limit', type: 'integer', optional: true, min: 1, max: 1000, help: 'How many of the newest (default: 30)' }], async (args) => {
      const p = await device(args.optString('phone'));
      const c = await conversation(args.string('conversation'), p.id);
      const messages = (await call(phone().messages(p.id, c.threadId))).slice(-(args.optNumber('limit') ?? 30));
      return {
        data: messages,
        text: [`${c.name} (${c.addresses.map(formatAddress).join(', ')})`, ...messages.map((m) => `[${time(m.time)}] ${m.outgoing ? 'You' : m.sender ?? c.name}: ${m.body}${m.images.length ? ` [${m.images.length} picture${m.images.length === 1 ? '' : 's'}]` : ''}${m.status === 'failed' ? ' (not sent)' : ''}`)].join('\n'),
      };
    }),
    command('phone', 'send', 'Send a text (asks on screen first)', [
      { name: 'to', type: 'string', positional: true, help: 'A contact’s name, a conversation, or a number' },
      { name: 'text', type: 'string', positional: true, rest: true, help: 'What to send' },
      PHONE,
    ], async (args, ctx) => {
      const p = await device(args.optString('phone'));
      const body = args.list('text').join(' ').trim();
      if (!body) throw new CommandError('Missing text', 'usage');
      const to = args.string('to');
      let addresses: string[];
      let name: string;
      try {
        const c = await conversation(to, p.id);
        addresses = c.addresses;
        name = c.name;
      } catch (error) {
        const contacts = await call(phone().contacts(p.id));
        const contact = contacts.find((x) => x.name.toLowerCase() === to.toLowerCase());
        if (contact) {
          addresses = [contact.numbers[0]];
          name = contact.name;
        } else if (/^\+?[\d\s().-]{3,}$/.test(to)) {
          addresses = [to];
          name = formatAddress(to);
        } else throw error;
      }
      const ok = await ctx.confirm({
        title: `Send a text to ${name}?`,
        description: `“${body.length > 200 ? `${body.slice(0, 200)}…` : body}”, from ${p.name}.`,
        action: 'Send',
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      await call(phone().send(p.id, addresses, body));
      return { text: `Sent to ${name}` };
    }),
    command('phone', 'mark-read', 'Mark a conversation read', [CONVERSATION, PHONE], async (args) => {
      const p = await device(args.optString('phone'));
      const c = await conversation(args.string('conversation'), p.id);
      await call(phone().markRead(p.id, c.threadId));
    }),
    command('phone', 'refresh', 'Check a phone for new messages, connecting again if need be', [PHONE], async (args) => {
      await call(phone().refresh((await device(args.optString('phone'))).id));
    }),
    command('phone', 'disconnect', 'Stop talking to a phone until it’s connected again (din phone refresh)', [PHONE], async (args) => {
      await call(phone().disconnect((await device(args.optString('phone'))).id));
    }),
    command('phone', 'add', 'Add a phone paired in Bluetooth (din bluetooth pair) to read its texts here', [
      { name: 'name', type: 'string', positional: true, help: 'The phone’s name' },
    ], async (args) => {
      const bridge = phone();
      const { candidates } = await call(bridge.state());
      const candidate = pick(candidates, args.string('name'), (c) => [c.id, c.name], 'paired phone to add');
      await call(bridge.add(candidate.id));
      return { text: `Added ${candidate.name}` };
    }),
    command('phone', 'forget', 'Remove a phone and its messages from this computer (asks on screen first)', [
      { name: 'phone', type: 'string', positional: true, help: 'The phone, by name' },
    ], async (args, ctx) => {
      const p = await device(args.string('phone'));
      const ok = await ctx.confirm({
        title: `Forget ${p.name}?`,
        description: 'Its messages are deleted from this computer, and it stops showing up in Messages.',
        action: 'Forget',
        destructive: true,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      await call(phone().forget(p.id));
    }),
  ],
};

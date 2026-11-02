import type { Item } from './api';

/** Messages shown together in the list: one conversation, newest first. */
export interface Conversation {
  /** The newest message's key. */
  key: string;
  items: Item[];
  latest: Item;
  /** Any of it unread. */
  unread: boolean;
  /** Any of it starred. */
  flagged: boolean;
  hasAttachments: boolean;
}

/**
 * The list's messages grouped into conversations, as Gmail does: by the
 * server's thread id where it gives one, and by Message-ID, In-Reply-To
 * and References, each account apart. In the order of their newest message.
 */
export function groupConversations(items: Item[]): Conversation[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Shorten the path for the next lookup.
    while (parent.get(x) !== root) {
      const next = parent.get(x)!;
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  const add = (x: string) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  const union = (x: string, y: string) => {
    add(x);
    add(y);
    const a = find(x);
    const b = find(y);
    if (a !== b) parent.set(a, b);
  };

  for (const i of items) {
    const self = `m\u0000${i.key}`;
    add(self);
    const ids = [i.messageId, i.inReplyTo, ...(i.references ?? [])].filter((x): x is string => !!x);
    for (const id of ids) union(self, `id\u0000${i.accountId}\u0000${id}`);
    if (i.threadId) union(self, `t\u0000${i.accountId}\u0000${i.threadId}`);
  }

  const groups = new Map<string, Item[]>();
  for (const i of items) {
    const root = find(`m\u0000${i.key}`);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  }
  // Items come newest first, so each group is too, and groups come in the order of their newest.
  return [...groups.values()].map((list) => ({
    key: list[0].key,
    items: list,
    latest: list[0],
    unread: list.some((i) => !i.seen),
    flagged: list.some((i) => i.flagged),
    hasAttachments: list.some((i) => i.hasAttachments),
  }));
}

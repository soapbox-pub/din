// Mail's search on this computer (electron/mail.mts): what's typed in Mail's
// search field, or `din mail messages <search>`, as an FTS5 query over the
// search index in each account's stored copy (electron/mail-store.mts).
//
// Every word has to be there, in the subject, the sender, the recipients or
// the text, as the start of a word ("gle" finds Gleason), so the list
// narrows as the user types. "Quoted words" are a phrase, as typed; a word
// with a minus before it must not be there; and from:, to: and subject:
// look in just that, as Gmail's search does. Gmail's other operators
// (has:, in:, label:, before:, OR, braces…) are Gmail's to answer: those
// searches go to the server.
//
// Erasable syntax only, like the rest of electron/.

/** The index's column each operator looks in. */
const FIELDS: Record<string, string> = { from: 'sender', to: 'recipients', cc: 'recipients', bcc: 'recipients', subject: 'subject' };

/** A word, with its operator and minus, quoted or not. */
const TERM = /(-)?(?:([a-z]+):)?(?:"([^"]*)"?|(\S+))/gi;

/** Whether the tokenizer would find a word in it at all (an empty phrase matches nothing). */
const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * The FTS5 query for a search, or null when the stored copy can't answer
 * it: one of Gmail's operators it doesn't know, or only words to leave out.
 */
export function ftsQuery(query: string, gmail: boolean): string | null {
  const wanted: string[] = [];
  const unwanted: string[] = [];
  for (const m of query.matchAll(TERM)) {
    const [whole, minus, op, quoted, bare] = m;
    let field: string | undefined;
    let words = quoted ?? bare ?? '';
    if (op) {
      field = FIELDS[op.toLowerCase()];
      if (!field) {
        // Gmail's has:, in:, label:, after: and the like are Gmail's.
        if (gmail) return null;
        words = whole.replace(/^-/, '');
      }
    }
    if (gmail && !quoted && (/^(OR|AND|AROUND)$/.test(words) || /[{}()]/.test(words))) return null;
    if (!HAS_WORD.test(words)) continue;
    const phrase = `"${words.replace(/"/g, '""')}"${quoted === undefined ? '*' : ''}`;
    const term = field ? `${field} : ${phrase}` : phrase;
    (minus ? unwanted : wanted).push(term);
  }
  if (!wanted.length) return null;
  return unwanted.reduce((q, t) => `(${q}) NOT ${t}`, wanted.join(' AND '));
}

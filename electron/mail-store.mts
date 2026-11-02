// Mail's copy of an account's mail on this computer (electron/mail.mts), so
// Mail opens to its mailboxes and messages straight away, and reads them
// without a connection. One SQLite database per account in
// userData/mail/<account id>.db, holding:
//
//   - the folder list, as last listed;
//   - for each mailbox, its UIDVALIDITY, the HIGHESTMODSEQ its flags were
//     last brought up to date at, and every uid in it, newest first;
//   - the summary (envelope, flags, preview) of each message the list has
//     shown, by mailbox and uid;
//   - the messages that have been opened, as fetched (a big one without its
//     big attachments), up to BODY_BYTES in all, the least recently opened
//     going first.
//
// A mailbox whose UIDVALIDITY changes has its uids renumbered, so what's
// kept of it is thrown away.

import fs from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { MessageSummary } from '../src/lib/mail.ts';

const BODY_BYTES = 512 * 1024 * 1024;
/** Bigger messages aren't kept; they're fetched each time they're opened. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface StoredMailbox {
  validity: string;
  /** The HIGHESTMODSEQ the stored flags are current to, where the server has CONDSTORE. */
  modseq: string | null;
  /** Every uid in the mailbox, newest first. */
  uids: number[];
  /** When it was last brought up to date with the server. */
  synced: number;
}

export interface StoredSummary {
  summary: MessageSummary;
  /** Whether its preview has been read (it can still be null). */
  previewed: boolean;
}

export type Flags = Pick<MessageSummary, 'seen' | 'flagged' | 'answered' | 'draft'>;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mailbox (path TEXT PRIMARY KEY, validity TEXT NOT NULL, modseq TEXT, uids BLOB NOT NULL, synced INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS message (path TEXT NOT NULL, uid INTEGER NOT NULL, summary TEXT NOT NULL, previewed INTEGER NOT NULL, PRIMARY KEY (path, uid));
CREATE TABLE IF NOT EXISTS body (path TEXT NOT NULL, uid INTEGER NOT NULL, raw BLOB NOT NULL, opened INTEGER NOT NULL, PRIMARY KEY (path, uid));
`;

function packUids(uids: number[]): Uint8Array {
  return new Uint8Array(Uint32Array.from(uids).buffer);
}

function unpackUids(blob: Uint8Array): number[] {
  const copy = blob.slice();
  return [...new Uint32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4))];
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

/** Run over a long list a slice at a time, under SQLite's limit on variables. */
function chunks<T>(list: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function withoutPreview(s: MessageSummary): string {
  return JSON.stringify({ ...s, preview: null });
}

export class MailStore {
  file: string;
  db: DatabaseSync;

  constructor(file: string) {
    this.file = file;
    try {
      this.db = MailStore.open(file);
    } catch {
      // Unreadable: it's only a copy, so start again.
      MailStore.remove(file);
      this.db = MailStore.open(file);
    }
  }

  static open(file: string): DatabaseSync {
    const db = new DatabaseSync(file);
    try {
      db.exec(SCHEMA);
      fs.chmodSync(file, 0o600);
    } catch (error) {
      db.close();
      throw error;
    }
    return db;
  }

  static remove(file: string): void {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  box(path: string): StoredMailbox | null {
    const row = this.db.prepare('SELECT validity, modseq, uids, synced FROM mailbox WHERE path = ?').get(path) as
      | { validity: string; modseq: string | null; uids: Uint8Array; synced: number }
      | undefined;
    return row ? { validity: row.validity, modseq: row.modseq, uids: unpackUids(row.uids), synced: row.synced } : null;
  }

  setBox(path: string, box: StoredMailbox): void {
    this.db
      .prepare('INSERT INTO mailbox (path, validity, modseq, uids, synced) VALUES (?, ?, ?, ?, ?) ON CONFLICT (path) DO UPDATE SET validity = excluded.validity, modseq = excluded.modseq, uids = excluded.uids, synced = excluded.synced')
      .run(path, box.validity, box.modseq, packUids(box.uids), box.synced);
  }

  /** Forget a mailbox kept under another UIDVALIDITY; true when there was one. */
  checkValidity(path: string, validity: string): boolean {
    const row = this.db.prepare('SELECT validity FROM mailbox WHERE path = ?').get(path) as { validity: string } | undefined;
    if (!row || row.validity === validity) return false;
    this.forget(path);
    return true;
  }

  forget(path: string): void {
    this.transaction(() => {
      for (const table of ['mailbox', 'message', 'body']) this.db.prepare(`DELETE FROM ${table} WHERE path = ?`).run(path);
    });
  }

  /** Summaries kept for these uids. */
  summaries(path: string, uids: number[]): Map<number, StoredSummary> {
    const out = new Map<number, StoredSummary>();
    for (const some of chunks(uids)) {
      const rows = this.db
        .prepare(`SELECT uid, summary, previewed FROM message WHERE path = ? AND uid IN (${placeholders(some.length)})`)
        .all(path, ...some) as { uid: number; summary: string; previewed: number }[];
      for (const r of rows) out.set(r.uid, { summary: JSON.parse(r.summary) as MessageSummary, previewed: !!r.previewed });
    }
    return out;
  }

  /** Every summary kept from a mailbox, newest uid first, below `before` if it's set. */
  allSummaries(path: string, before?: number): MessageSummary[] {
    const rows = this.db
      .prepare('SELECT summary FROM message WHERE path = ? AND uid < ? ORDER BY uid DESC')
      .all(path, before ?? Number.MAX_SAFE_INTEGER) as { summary: string }[];
    return rows.map((r) => JSON.parse(r.summary) as MessageSummary);
  }

  storedUids(path: string): number[] {
    return (this.db.prepare('SELECT uid FROM message WHERE path = ? ORDER BY uid DESC').all(path) as { uid: number }[]).map((r) => r.uid);
  }

  /**
   * Keep these summaries, with the previews already read unless they come
   * with one. True when anything but a preview differs from what was kept.
   */
  putSummaries(path: string, list: MessageSummary[]): boolean {
    if (!list.length) return false;
    const kept = this.summaries(path, list.map((s) => s.uid));
    let changed = false;
    const put = this.db.prepare('INSERT INTO message (path, uid, summary, previewed) VALUES (?, ?, ?, ?) ON CONFLICT (path, uid) DO UPDATE SET summary = excluded.summary, previewed = excluded.previewed');
    this.transaction(() => {
      for (const s of list) {
        const old = kept.get(s.uid);
        if (!old || withoutPreview(old.summary) !== withoutPreview(s)) changed = true;
        const preview = s.preview ?? old?.summary.preview ?? null;
        put.run(path, s.uid, JSON.stringify({ ...s, preview }), old?.previewed || s.preview !== null ? 1 : 0);
      }
    });
    return changed;
  }

  setPreview(path: string, uid: number, preview: string | null): void {
    const row = this.db.prepare('SELECT summary FROM message WHERE path = ? AND uid = ?').get(path, uid) as { summary: string } | undefined;
    if (!row) return;
    const s = JSON.parse(row.summary) as MessageSummary;
    this.db.prepare('UPDATE message SET summary = ?, previewed = 1 WHERE path = ? AND uid = ?').run(JSON.stringify({ ...s, preview }), path, uid);
  }

  /** Change kept flags; true when any differed. */
  patchFlags(path: string, uids: number[], patch: Partial<Flags>): boolean {
    let changed = false;
    const update = this.db.prepare('UPDATE message SET summary = ? WHERE path = ? AND uid = ?');
    this.transaction(() => {
      for (const [uid, { summary }] of this.summaries(path, uids)) {
        const next = { ...summary, ...patch };
        if (withoutPreview(next) === withoutPreview(summary)) continue;
        changed = true;
        update.run(JSON.stringify(next), path, uid);
      }
    });
    return changed;
  }

  /** Messages gone from a mailbox: moved, deleted, expunged. */
  removeUids(path: string, uids: number[]): void {
    if (!uids.length) return;
    const gone = new Set(uids);
    this.transaction(() => {
      for (const some of chunks(uids)) {
        const args: SQLInputValue[] = [path, ...some];
        this.db.prepare(`DELETE FROM message WHERE path = ? AND uid IN (${placeholders(some.length)})`).run(...args);
        this.db.prepare(`DELETE FROM body WHERE path = ? AND uid IN (${placeholders(some.length)})`).run(...args);
      }
      const box = this.box(path);
      if (box) this.setBox(path, { ...box, uids: box.uids.filter((u) => !gone.has(u)) });
    });
  }

  body(path: string, uid: number): Buffer | null {
    const row = this.db.prepare('SELECT raw FROM body WHERE path = ? AND uid = ?').get(path, uid) as { raw: Uint8Array } | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE body SET opened = ? WHERE path = ? AND uid = ?').run(Date.now(), path, uid);
    return Buffer.from(row.raw);
  }

  putBody(path: string, uid: number, raw: Buffer): void {
    if (raw.byteLength > MAX_BODY_BYTES) return;
    this.db
      .prepare('INSERT INTO body (path, uid, raw, opened) VALUES (?, ?, ?, ?) ON CONFLICT (path, uid) DO UPDATE SET raw = excluded.raw, opened = excluded.opened')
      .run(path, uid, raw, Date.now());
    const { total } = this.db.prepare('SELECT COALESCE(SUM(length(raw)), 0) AS total FROM body').get() as { total: number };
    if (total <= BODY_BYTES) return;
    const rows = this.db.prepare('SELECT rowid AS id, length(raw) AS size FROM body ORDER BY opened ASC').all() as { id: number; size: number }[];
    let over = total - BODY_BYTES;
    const drop: number[] = [];
    for (const r of rows) {
      if (over <= 0) break;
      drop.push(r.id);
      over -= r.size;
    }
    for (const some of chunks(drop)) this.db.prepare(`DELETE FROM body WHERE rowid IN (${placeholders(some.length)})`).run(...some);
  }
}

import type { Torrent } from '@/lib/torrents';

/** Bytes as the Finder shows them: decimal units, three figures. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1000) return `${Math.max(0, Math.round(bytes || 0))} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')} ${units[unit]}`;
}

/** A rate, per second. */
export function formatRate(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond < 1) return '0 KB/s';
  if (bytesPerSecond < 1000) return '1 KB/s';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Seconds left, as a person says it: "3 minutes", "about 2 hours". */
export function formatEta(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return 'less than a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(seconds / 3600);
  if (hours < 48) return `about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(seconds / 86400);
  return `about ${days} days`;
}

/** A length of time spent: "2 hr 5 min". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ${hours % 24} hr`;
}

export function formatRatio(ratio: number | null): string {
  if (ratio === null) return '—';
  return ratio >= 100 ? Math.round(ratio).toString() : ratio.toFixed(2);
}

export function formatPercent(fraction: number): string {
  const pct = fraction * 100;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  if (pct >= 99.95 && pct < 100) return '99.9%';
  return `${pct.toFixed(pct < 10 && pct > 0 ? 1 : 0)}%`;
}

export function formatDate(seconds: number | null): string {
  if (!seconds) return '—';
  return new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** How long ago, briefly: "3 min ago". */
export function formatAgo(seconds: number): string {
  const ago = Math.max(0, Date.now() / 1000 - seconds);
  if (ago < 60) return 'just now';
  if (ago < 3600) return `${Math.round(ago / 60)} min ago`;
  if (ago < 86400) return `${Math.round(ago / 3600)} hr ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** What a transfer is doing, in a word or two: the list's colored status. */
export function stateLabel(t: Torrent): string {
  if (t.error && t.errorKind === 'local') return 'Error';
  if (t.metadataProgress !== null && t.state !== 'stopped') return 'Getting info';
  if (t.state === 'checking') return t.waiting ? 'Waiting to check' : 'Checking';
  if (t.state === 'stopped') return t.finished ? 'Done' : 'Paused';
  if (t.state === 'downloading') return t.waiting ? 'Queued' : 'Downloading';
  return t.waiting ? 'Queued to seed' : 'Seeding';
}

/** How much of it is here: "1.2 GB of 4.5 GB (26%)", or what it shared once done. */
export function progressLine(t: Torrent): string {
  if (t.metadataProgress !== null) return `Asking peers what’s in it (${formatPercent(t.metadataProgress)})`;
  if (t.state === 'checking' && t.checkProgress !== null) return `Checking what’s downloaded (${formatPercent(t.checkProgress)})`;
  if (t.finished) {
    const size = formatBytes(t.sizeBytes);
    return t.uploadedBytes > 0 ? `${size}, uploaded ${formatBytes(t.uploadedBytes)} (ratio ${formatRatio(t.ratio)})` : size;
  }
  return `${formatBytes(t.haveBytes)} of ${formatBytes(t.sizeBytes)} (${formatPercent(t.progress)})`;
}

/** What it's doing now: speeds and peers, or why it isn't. */
export function activityLine(t: Torrent): string {
  if (t.error) return t.error;
  if (t.state === 'stopped') return t.finished ? (t.doneAt ? `Finished ${formatAgo(t.doneAt)}` : 'Finished') : 'Paused';
  if (t.waiting) return t.state === 'checking' ? 'Waiting for another to be checked' : 'Waiting in line';
  if (t.state === 'checking') return '';
  if (t.state === 'downloading') {
    if (t.metadataProgress !== null) return t.peersConnected ? `Connected to ${plural(t.peersConnected, 'peer')}` : 'Looking for peers';
    if (t.peersSending === 0) return t.peersConnected ? `Connected to ${plural(t.peersConnected, 'peer')}, none sending` : 'Looking for peers';
    const eta = formatEta(t.eta);
    return [`From ${t.peersSending.toLocaleString()} of ${plural(Math.max(t.peersConnected, t.peersSending), 'peer')}`, eta && `${eta} left`].filter(Boolean).join(' · ');
  }
  return t.peersReceiving ? `To ${plural(t.peersReceiving, 'peer')}` : 'Seeding to no one right now';
}

export { plural };

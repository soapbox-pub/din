import { localFileUrl } from '@/lib/fs';

/**
 * What a song file says about itself: ID3 (v1 and v2.2-2.4) in MP3s, Vorbis
 * comments in FLAC, Ogg Vorbis and Opus, iTunes atoms in MP4/M4A, and RIFF
 * INFO in WAV, plus the stream's own duration, bitrate and sample rate
 * (Winamp shows kbps and kHz).
 *
 * Files are read in pieces through din-file:'s Range support, so a tag at
 * the end of a file (ID3v1, an MP4 whose moov comes last, an Ogg's last
 * page) costs a small read rather than the whole file.
 */
export interface TrackTags {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  year?: string;
  track?: number;
  disc?: number;
  comment?: string;
  lyrics?: string;
  /** Seconds. */
  duration?: number;
  /** Kilobits per second. */
  bitrate?: number;
  /** Hz. */
  sampleRate?: number;
  channels?: number;
  /** Embedded cover art. */
  picture?: { mime: string; data: Uint8Array };
}

/** Reads byte ranges of a file. */
export interface ByteSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** A local file, read through din-file: with Range requests. */
export async function fileSource(path: string): Promise<ByteSource> {
  const url = localFileUrl(path);
  const head = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  const total = /\/(\d+)$/.exec(head.headers.get('content-range') ?? '');
  const size = total ? Number(total[1]) : Number(head.headers.get('content-length') ?? 0);
  await head.body?.cancel();
  return {
    size,
    async read(offset, length) {
      const start = Math.max(0, Math.min(offset, size));
      const end = Math.min(size, start + length) - 1;
      if (end < start) return new Uint8Array(0);
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** An in-memory buffer as a source (tests, dropped files). */
export function bufferSource(data: Uint8Array): ByteSource {
  return {
    size: data.length,
    read: async (offset, length) => data.subarray(offset, offset + length),
  };
}

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');
const utf16le = new TextDecoder('utf-16le');
const utf16be = new TextDecoder('utf-16be');

const ascii = (b: Uint8Array, start: number, length: number) => latin1.decode(b.subarray(start, start + length));
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const le32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const be24 = (b: Uint8Array, i: number) => (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
const syncsafe = (b: Uint8Array, i: number) => (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];

const clean = (s: string) => s.replace(/\0+$/g, '').replace(/\0/g, ' / ').trim();

function setText(tags: TrackTags, key: 'title' | 'artist' | 'album' | 'albumArtist' | 'genre' | 'year' | 'comment' | 'lyrics', value: string) {
  const v = clean(value);
  if (v && !tags[key]) tags[key] = v;
}

function setNumber(tags: TrackTags, key: 'track' | 'disc', value: string) {
  const n = parseInt(value, 10);
  if (Number.isFinite(n) && n > 0 && !tags[key]) tags[key] = n;
}

/** The 80 ID3v1 genres and Winamp's extensions, for "(17)" style references. */
export const ID3_GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
  'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial',
  'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk',
  'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise',
  'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic',
  'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta',
  'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes',
  'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
  'Folk', 'Folk-Rock', 'National Folk', 'Swing', 'Fast Fusion', 'Bebop', 'Latin', 'Revival', 'Celtic', 'Bluegrass',
  'Avantgarde', 'Gothic Rock', 'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus', 'Easy Listening', 'Acoustic',
  'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove',
  'Satire', 'Slow Jam', 'Club', 'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul', 'Freestyle',
  'Duet', 'Punk Rock', 'Drum Solo', 'A Cappella', 'Euro-House', 'Dance Hall',
];

function genreName(value: string): string {
  return value.replace(/\((\d+)\)/g, (_, n: string) => ID3_GENRES[Number(n)] ?? '').replace(/^(\d+)$/, (_, n: string) => ID3_GENRES[Number(n)] ?? n).trim();
}

// ---------------------------------------------------------------------------
// ID3v2
// ---------------------------------------------------------------------------

/** Undo ID3 unsynchronisation (0xFF 0x00 → 0xFF). */
function deunsync(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  let j = 0;
  for (let i = 0; i < b.length; i++) {
    out[j++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

function decodeId3Text(b: Uint8Array, encoding: number): string {
  if (encoding === 0) return latin1.decode(b);
  if (encoding === 3) return utf8.decode(b);
  if (encoding === 2) return utf16be.decode(b);
  // UTF-16 with a BOM (each string of a list has its own).
  const parts: string[] = [];
  let i = 0;
  while (i < b.length) {
    let end = i;
    while (end + 1 < b.length && !(b[end] === 0 && b[end + 1] === 0)) end += 2;
    const chunk = b.subarray(i, end);
    if (chunk[0] === 0xfe && chunk[1] === 0xff) parts.push(utf16be.decode(chunk.subarray(2)));
    else if (chunk[0] === 0xff && chunk[1] === 0xfe) parts.push(utf16le.decode(chunk.subarray(2)));
    else parts.push(utf16le.decode(chunk));
    i = end + 2;
  }
  return parts.join('\0');
}

/** Where an encoded, null-terminated string ends (index of its terminator). */
function terminator(b: Uint8Array, start: number, encoding: number): number {
  if (encoding === 1 || encoding === 2) {
    for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
    return b.length;
  }
  const i = b.indexOf(0, start);
  return i === -1 ? b.length : i;
}

const ID3_TEXT: Record<string, 'title' | 'artist' | 'album' | 'albumArtist' | 'genre' | 'year'> = {
  TIT2: 'title', TT2: 'title',
  TPE1: 'artist', TP1: 'artist',
  TALB: 'album', TAL: 'album',
  TPE2: 'albumArtist', TP2: 'albumArtist',
  TCON: 'genre', TCO: 'genre',
  TYER: 'year', TYE: 'year', TDRC: 'year', TDOR: 'year',
};

function parseId3v2(b: Uint8Array, tags: TrackTags): void {
  const major = b[3];
  const flags = b[5];
  const size = syncsafe(b, 6);
  let body = b.subarray(10, 10 + size);
  if (major < 4 && flags & 0x80) body = deunsync(body);
  let i = 0;
  if (flags & 0x40) {
    // Extended header.
    i = major === 4 ? syncsafe(body, 0) : be32(body, 0) + 4;
  }
  const idLen = major === 2 ? 3 : 4;
  const headLen = major === 2 ? 6 : 10;
  while (i + headLen <= body.length) {
    const id = ascii(body, i, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const frameSize = major === 2 ? be24(body, i + 3) : major === 4 ? syncsafe(body, i + 4) : be32(body, i + 4);
    const frameFlags = major === 2 ? 0 : body[i + 9];
    let data = body.subarray(i + headLen, i + headLen + frameSize);
    i += headLen + frameSize;
    if (frameSize <= 0) continue;
    if (major === 4 && frameFlags & 0x02) data = deunsync(data);
    // Compressed or encrypted frames: skip.
    if (major === 4 && frameFlags & 0x0c) continue;
    if (major === 3 && frameFlags & 0xc0) continue;
    if (major === 4 && frameFlags & 0x01) data = data.subarray(4);

    const key = ID3_TEXT[id];
    if (key) {
      const text = decodeId3Text(data.subarray(1), data[0]);
      setText(tags, key, key === 'genre' ? genreName(clean(text)) : key === 'year' ? clean(text).slice(0, 4) : text);
    } else if (id === 'TRCK' || id === 'TRK') {
      setNumber(tags, 'track', decodeId3Text(data.subarray(1), data[0]));
    } else if (id === 'TPOS' || id === 'TPA') {
      setNumber(tags, 'disc', decodeId3Text(data.subarray(1), data[0]));
    } else if (id === 'TLEN' || id === 'TLE') {
      const ms = parseInt(clean(decodeId3Text(data.subarray(1), data[0])), 10);
      if (ms > 0 && !tags.duration) tags.duration = ms / 1000;
    } else if (id === 'COMM' || id === 'COM' || id === 'USLT' || id === 'ULT') {
      const enc = data[0];
      const descEnd = terminator(data, 4, enc);
      const text = decodeId3Text(data.subarray(descEnd + (enc === 1 || enc === 2 ? 2 : 1)), enc);
      setText(tags, id.startsWith('U') ? 'lyrics' : 'comment', text);
    } else if ((id === 'APIC' || id === 'PIC') && !tags.picture) {
      const enc = data[0];
      let p: number;
      let mime: string;
      if (id === 'PIC') {
        const format = ascii(data, 1, 3).toLowerCase();
        mime = format === 'png' ? 'image/png' : 'image/jpeg';
        p = 4;
      } else {
        const end = data.indexOf(0, 1);
        mime = ascii(data, 1, end - 1).toLowerCase() || 'image/jpeg';
        if (!mime.includes('/')) mime = `image/${mime === 'jpg' ? 'jpeg' : mime}`;
        p = end + 1;
      }
      p += 1; // Picture type.
      p = terminator(data, p, enc) + (enc === 1 || enc === 2 ? 2 : 1);
      if (p < data.length) tags.picture = { mime, data: data.slice(p) };
    }
  }
}

function parseId3v1(b: Uint8Array, tags: TrackTags): void {
  if (ascii(b, 0, 3) !== 'TAG') return;
  setText(tags, 'title', ascii(b, 3, 30));
  setText(tags, 'artist', ascii(b, 33, 30));
  setText(tags, 'album', ascii(b, 63, 30));
  setText(tags, 'year', ascii(b, 93, 4));
  if (b[125] === 0 && b[126] !== 0) {
    setText(tags, 'comment', ascii(b, 97, 28));
    if (!tags.track) tags.track = b[126];
  } else {
    setText(tags, 'comment', ascii(b, 97, 30));
  }
  if (b[127] < ID3_GENRES.length) setText(tags, 'genre', ID3_GENRES[b[127]]);
}

// ---------------------------------------------------------------------------
// MPEG audio frames (duration and bitrate)
// ---------------------------------------------------------------------------

const MPEG_BITRATES: Record<string, number[]> = {
  // [version][layer] → kbps by index
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MPEG_RATES: Record<number, number[]> = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

function parseMpegFrame(b: Uint8Array, audioBytes: number, tags: TrackTags): void {
  let i = 0;
  while (i + 4 < b.length && !(b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0 && (b[i + 1] & 0x06) !== 0 && b[i + 2] >> 4 !== 15 && b[i + 2] >> 4 !== 0)) i++;
  if (i + 4 >= b.length) return;
  const versionBits = (b[i + 1] >> 3) & 3;
  if (versionBits === 1) return;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
  const layer = 4 - ((b[i + 1] >> 1) & 3);
  const bitrate = MPEG_BITRATES[`${version === 1 ? 1 : 2}-${layer}`][b[i + 2] >> 4];
  const sampleRate = MPEG_RATES[version][(b[i + 2] >> 2) & 3];
  const channelMode = b[i + 3] >> 6;
  if (!sampleRate) return;
  tags.sampleRate = sampleRate;
  tags.channels = channelMode === 3 ? 1 : 2;
  const samplesPerFrame = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
  // A Xing/Info or VBRI header in the first frame counts the frames.
  const sideInfo = version === 1 ? (channelMode === 3 ? 17 : 32) : channelMode === 3 ? 9 : 17;
  const x = i + 4 + sideInfo;
  const tag = ascii(b, x, 4);
  let frames = 0;
  let bytes = 0;
  if ((tag === 'Xing' || tag === 'Info') && x + 16 <= b.length) {
    const flags = be32(b, x + 4);
    let p = x + 8;
    if (flags & 1) { frames = be32(b, p); p += 4; }
    if (flags & 2) bytes = be32(b, p);
  } else if (ascii(b, i + 36, 4) === 'VBRI') {
    bytes = be32(b, i + 36 + 10);
    frames = be32(b, i + 36 + 14);
  }
  if (frames > 0) {
    const duration = (frames * samplesPerFrame) / sampleRate;
    tags.duration ??= duration;
    tags.bitrate = Math.round(((bytes || audioBytes) * 8) / duration / 1000);
  } else if (bitrate) {
    tags.bitrate = bitrate;
    tags.duration ??= ((audioBytes - i) * 8) / (bitrate * 1000);
  }
}

// ---------------------------------------------------------------------------
// Vorbis comments and FLAC pictures
// ---------------------------------------------------------------------------

function parseFlacPicture(b: Uint8Array, tags: TrackTags): void {
  if (tags.picture || b.length < 32) return;
  let p = 4;
  const mimeLen = be32(b, p); p += 4;
  const mime = ascii(b, p, mimeLen); p += mimeLen;
  const descLen = be32(b, p); p += 4 + descLen;
  p += 16;
  const len = be32(b, p); p += 4;
  tags.picture = { mime: mime || 'image/jpeg', data: b.slice(p, p + len) };
}

function parseVorbisComments(b: Uint8Array, tags: TrackTags): void {
  let p = 0;
  const vendorLen = le32(b, p);
  p += 4 + vendorLen;
  const count = le32(b, p);
  p += 4;
  for (let n = 0; n < count && p + 4 <= b.length; n++) {
    const len = le32(b, p);
    p += 4;
    const entry = utf8.decode(b.subarray(p, p + len));
    p += len;
    const eq = entry.indexOf('=');
    if (eq < 0) continue;
    const key = entry.slice(0, eq).toUpperCase();
    const value = entry.slice(eq + 1);
    switch (key) {
      case 'TITLE': setText(tags, 'title', value); break;
      case 'ARTIST': setText(tags, 'artist', value); break;
      case 'ALBUM': setText(tags, 'album', value); break;
      case 'ALBUMARTIST': case 'ALBUM ARTIST': setText(tags, 'albumArtist', value); break;
      case 'GENRE': setText(tags, 'genre', value); break;
      case 'DATE': case 'YEAR': setText(tags, 'year', value.slice(0, 4)); break;
      case 'TRACKNUMBER': setNumber(tags, 'track', value); break;
      case 'DISCNUMBER': setNumber(tags, 'disc', value); break;
      case 'COMMENT': case 'DESCRIPTION': setText(tags, 'comment', value); break;
      case 'LYRICS': case 'UNSYNCEDLYRICS': setText(tags, 'lyrics', value); break;
      case 'METADATA_BLOCK_PICTURE':
        try {
          parseFlacPicture(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)), tags);
        } catch {
          // Not base64: ignore.
        }
        break;
    }
  }
}

async function parseFlac(src: ByteSource, start: number, tags: TrackTags): Promise<void> {
  let p = start + 4;
  for (let n = 0; n < 64; n++) {
    const head = await src.read(p, 4);
    if (head.length < 4) return;
    const last = head[0] & 0x80;
    const type = head[0] & 0x7f;
    const len = be24(head, 1);
    if (type === 0 || type === 4 || type === 6) {
      const block = await src.read(p + 4, len);
      if (type === 0) {
        const rate = (block[10] << 12) | (block[11] << 4) | (block[12] >> 4);
        const channels = ((block[12] >> 1) & 7) + 1;
        const samples = (block[13] & 0x0f) * 2 ** 32 + be32(block, 14);
        tags.sampleRate = rate;
        tags.channels = channels;
        if (rate && samples) {
          tags.duration = samples / rate;
          tags.bitrate = Math.round(((src.size - p) * 8) / tags.duration / 1000);
        }
      } else if (type === 4) parseVorbisComments(block, tags);
      else parseFlacPicture(block, tags);
    }
    p += 4 + len;
    if (last) return;
  }
}

/** The first two packets of an Ogg stream (identification and comments). */
function oggPackets(b: Uint8Array, want: number): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let chunks: Uint8Array[] = [];
  let p = 0;
  while (p + 27 <= b.length && packets.length < want) {
    if (ascii(b, p, 4) !== 'OggS') break;
    const segments = b[p + 26];
    const table = b.subarray(p + 27, p + 27 + segments);
    let q = p + 27 + segments;
    for (const lacing of table) {
      chunks.push(b.subarray(q, q + lacing));
      q += lacing;
      if (lacing < 255) {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const packet = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) { packet.set(c, o); o += c.length; }
        packets.push(packet);
        chunks = [];
        if (packets.length >= want) break;
      }
    }
    p = q;
  }
  return packets;
}

async function parseOgg(src: ByteSource, tags: TrackTags): Promise<void> {
  // Comment packets with cover art can be large.
  const head = await src.read(0, Math.min(src.size, 2 * 1024 * 1024));
  const [ident, comments] = oggPackets(head, 2);
  if (!ident) return;
  let granuleRate = 0;
  let preSkip = 0;
  if (ascii(ident, 1, 6) === 'vorbis') {
    tags.channels = ident[11];
    tags.sampleRate = le32(ident, 12);
    granuleRate = tags.sampleRate;
    const nominal = le32(ident, 20);
    if (nominal > 0 && nominal < 2e6) tags.bitrate = Math.round(nominal / 1000);
    if (comments && ascii(comments, 1, 6) === 'vorbis') parseVorbisComments(comments.subarray(7), tags);
  } else if (ascii(ident, 0, 8) === 'OpusHead') {
    tags.channels = ident[9];
    preSkip = ident[10] | (ident[11] << 8);
    tags.sampleRate = 48000;
    granuleRate = 48000;
    if (comments && ascii(comments, 0, 8) === 'OpusTags') parseVorbisComments(comments.subarray(8), tags);
  } else if (ascii(ident, 1, 4) === 'FLAC') {
    // Ogg FLAC: the STREAMINFO follows the mapping header.
    const info = ident.subarray(13 + 4);
    tags.sampleRate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
    tags.channels = ((info[12] >> 1) & 7) + 1;
    granuleRate = tags.sampleRate;
    if (comments) parseVorbisComments(comments.subarray(4), tags);
  }
  // The last page's granule position is the stream's length in samples.
  if (granuleRate) {
    const tailLen = Math.min(src.size, 65536);
    const tail = await src.read(src.size - tailLen, tailLen);
    for (let i = tail.length - 14; i >= 0; i--) {
      if (tail[i] === 0x4f && ascii(tail, i, 4) === 'OggS') {
        const granule = le32(tail, i + 6) + le32(tail, i + 10) * 2 ** 32;
        if (granule > 0) {
          tags.duration = (granule - preSkip) / granuleRate;
          if (!tags.bitrate) tags.bitrate = Math.round((src.size * 8) / tags.duration / 1000);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// MP4 / M4A
// ---------------------------------------------------------------------------

function mp4Children(b: Uint8Array, start: number, end: number): { type: string; start: number; end: number }[] {
  const out: { type: string; start: number; end: number }[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = be32(b, p);
    const type = ascii(b, p + 4, 4);
    let header = 8;
    if (size === 1) {
      size = be32(b, p + 8) * 2 ** 32 + be32(b, p + 12);
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header) break;
    out.push({ type, start: p + header, end: Math.min(end, p + size) });
    p += size;
  }
  return out;
}

function parseMoov(b: Uint8Array, tags: TrackTags, fileSize: number): void {
  const find = (start: number, end: number, path: string[]): { start: number; end: number } | null => {
    let range = { start, end };
    for (const name of path) {
      const child = mp4Children(b, range.start, range.end).find((c) => c.type === name);
      if (!child) return null;
      range = name === 'meta' ? { start: child.start + 4, end: child.end } : child;
    }
    return range;
  };
  const mvhd = find(0, b.length, ['mvhd']);
  if (mvhd) {
    const v = b[mvhd.start];
    const timescale = v === 1 ? be32(b, mvhd.start + 20) : be32(b, mvhd.start + 12);
    const duration = v === 1 ? be32(b, mvhd.start + 24) * 2 ** 32 + be32(b, mvhd.start + 28) : be32(b, mvhd.start + 16);
    if (timescale) {
      tags.duration = duration / timescale;
      tags.bitrate = Math.round((fileSize * 8) / tags.duration / 1000);
    }
  }
  // The audio sample description has the channel count and sample rate.
  for (const trak of mp4Children(b, 0, b.length).filter((c) => c.type === 'trak')) {
    const stsd = find(trak.start, trak.end, ['mdia', 'minf', 'stbl', 'stsd']);
    if (!stsd) continue;
    const entry = stsd.start + 8;
    const format = ascii(b, entry + 4, 4);
    if (format === 'mp4a' || format === 'alac' || format === 'Opus' || format === 'fLaC') {
      tags.channels = (b[entry + 24] << 8) | b[entry + 25];
      tags.sampleRate = (b[entry + 32] << 8) | b[entry + 33];
      break;
    }
  }
  const ilst = find(0, b.length, ['udta', 'meta', 'ilst']) ?? find(0, b.length, ['meta', 'ilst']);
  if (!ilst) return;
  for (const item of mp4Children(b, ilst.start, ilst.end)) {
    const data = mp4Children(b, item.start, item.end).find((c) => c.type === 'data');
    if (!data) continue;
    const kind = be32(b, data.start) & 0xffffff;
    const value = b.subarray(data.start + 8, data.end);
    const text = () => utf8.decode(value);
    switch (item.type) {
      case '\u00a9nam': setText(tags, 'title', text()); break;
      case '\u00a9ART': setText(tags, 'artist', text()); break;
      case '\u00a9alb': setText(tags, 'album', text()); break;
      case 'aART': setText(tags, 'albumArtist', text()); break;
      case '\u00a9gen': setText(tags, 'genre', text()); break;
      case 'gnre': if (value.length >= 2) setText(tags, 'genre', ID3_GENRES[((value[0] << 8) | value[1]) - 1] ?? ''); break;
      case '\u00a9day': setText(tags, 'year', text().slice(0, 4)); break;
      case '\u00a9cmt': setText(tags, 'comment', text()); break;
      case '\u00a9lyr': setText(tags, 'lyrics', text()); break;
      case 'trkn': if (value.length >= 4) tags.track ||= (value[2] << 8) | value[3]; break;
      case 'disk': if (value.length >= 4) tags.disc ||= (value[2] << 8) | value[3]; break;
      case 'covr':
        if (!tags.picture) tags.picture = { mime: kind === 14 ? 'image/png' : 'image/jpeg', data: value.slice() };
        break;
    }
  }
}

async function parseMp4(src: ByteSource, tags: TrackTags): Promise<void> {
  let p = 0;
  for (let n = 0; n < 64 && p + 8 <= src.size; n++) {
    const head = await src.read(p, 16);
    let size = be32(head, 0);
    const type = ascii(head, 4, 4);
    let header = 8;
    if (size === 1) {
      size = be32(head, 8) * 2 ** 32 + be32(head, 12);
      header = 16;
    } else if (size === 0) size = src.size - p;
    if (size < header) return;
    if (type === 'moov') {
      if (size > 64 * 1024 * 1024) return;
      parseMoov(await src.read(p + header, size - header), tags, src.size);
      return;
    }
    p += size;
  }
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

function parseWav(b: Uint8Array, size: number, tags: TrackTags): void {
  let p = 12;
  let byteRate = 0;
  while (p + 8 <= b.length) {
    const id = ascii(b, p, 4);
    const len = le32(b, p + 4);
    const body = p + 8;
    if (id === 'fmt ') {
      tags.channels = b[body + 2] | (b[body + 3] << 8);
      tags.sampleRate = le32(b, body + 4);
      byteRate = le32(b, body + 8);
      tags.bitrate = Math.round((byteRate * 8) / 1000);
    } else if (id === 'data' && byteRate) {
      tags.duration = Math.min(len, size - body) / byteRate;
    } else if (id === 'LIST' && ascii(b, body, 4) === 'INFO') {
      let q = body + 4;
      while (q + 8 <= body + len && q + 8 <= b.length) {
        const sub = ascii(b, q, 4);
        const subLen = le32(b, q + 4);
        const value = latin1.decode(b.subarray(q + 8, q + 8 + subLen));
        if (sub === 'INAM') setText(tags, 'title', value);
        else if (sub === 'IART') setText(tags, 'artist', value);
        else if (sub === 'IPRD') setText(tags, 'album', value);
        else if (sub === 'IGNR') setText(tags, 'genre', value);
        else if (sub === 'ICRD') setText(tags, 'year', value.slice(0, 4));
        else if (sub === 'ICMT') setText(tags, 'comment', value);
        q += 8 + subLen + (subLen & 1);
      }
    }
    p = body + len + (len & 1);
  }
}

// ---------------------------------------------------------------------------

/** Read everything Din can learn about a song from its bytes. */
export async function readTags(src: ByteSource): Promise<TrackTags> {
  const tags: TrackTags = {};
  if (src.size < 4) return tags;
  const CHUNK = 64 * 1024;
  let head = await src.read(0, Math.min(src.size, CHUNK));
  // ID3v2 may front any file (even FLAC), and there can be more than one.
  let offset = 0;
  for (;;) {
    if (ascii(head, 0, 3) !== 'ID3' || head.length < 10) break;
    const size = syncsafe(head, 6) + 10 + (head[5] & 0x10 ? 10 : 0);
    parseId3v2(size <= head.length ? head.subarray(0, size) : await src.read(offset, Math.min(size, 32 * 1024 * 1024)), tags);
    offset += size;
    head = await src.read(offset, CHUNK);
  }
  const magic = ascii(head, 0, 4);
  if (magic === 'fLaC') {
    await parseFlac(src, offset, tags);
  } else if (magic === 'OggS') {
    await parseOgg(src, tags);
  } else if (ascii(head, 4, 4) === 'ftyp') {
    await parseMp4(src, tags);
  } else if (magic === 'RIFF' && ascii(head, 8, 4) === 'WAVE') {
    parseWav(head, src.size, tags);
  } else {
    parseMpegFrame(head, src.size - offset, tags);
    if (src.size > 128) parseId3v1(await src.read(src.size - 128, 128), tags);
  }
  return tags;
}

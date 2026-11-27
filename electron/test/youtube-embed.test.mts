// A YouTube embed in an installed nsite or a Din app names its page in the
// Referer, or YouTube refuses to play it (error 153).

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ webContents: { getAllWebContents: () => [] } }));

import { addYouTubeEmbedReferrer, isYouTubeEmbedUrl, referrerForOrigin } from '../youtube-embed.mts';

const EMBED = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1';
const NSITE = 'nsite://2zrgjemvgxppn2jwgm61w6yrqqlcmm8njvhby68a9cj7ooo5phditto';

function headersFor(details: Parameters<typeof addYouTubeEmbedReferrer>[0], headers: Record<string, string> = {}) {
  addYouTubeEmbedReferrer(details, headers);
  return headers;
}

describe('youtube-embed', () => {
  it('knows YouTube embed URLs', () => {
    expect(isYouTubeEmbedUrl(EMBED)).toBe(true);
    expect(isYouTubeEmbedUrl('https://www.youtube.com/embed/x')).toBe(true);
    expect(isYouTubeEmbedUrl('https://www.youtube.com/watch?v=x')).toBe(false);
    expect(isYouTubeEmbedUrl('https://youtube.com.evil.example/embed/x')).toBe(false);
    expect(isYouTubeEmbedUrl('http://www.youtube.com/embed/x')).toBe(false);
  });

  it("gives Din's own schemes their origin", () => {
    expect(referrerForOrigin(NSITE)).toBe(`${NSITE}/`);
    expect(referrerForOrigin('din://calendar')).toBe('din://calendar/');
    expect(referrerForOrigin('https://ditto.pub')).toBeNull();
    expect(referrerForOrigin('null')).toBeNull();
    expect(referrerForOrigin(undefined)).toBeNull();
  });

  it("names an nsite's YouTube embed", () => {
    expect(headersFor({ url: EMBED, resourceType: 'subFrame', initiatorOrigin: NSITE })).toEqual({ Referer: `${NSITE}/` });
  });

  it("names it by the frame's parent when there's no initiator", () => {
    const frame = { parent: { origin: NSITE } } as unknown as Electron.WebFrameMain;
    expect(headersFor({ url: EMBED, resourceType: 'subFrame', frame })).toEqual({ Referer: `${NSITE}/` });
  });

  it('leaves a web Referer alone', () => {
    const headers = { referer: 'https://ditto.pub/' };
    expect(headersFor({ url: EMBED, resourceType: 'subFrame', initiatorOrigin: NSITE }, headers)).toEqual({ referer: 'https://ditto.pub/' });
  });

  it('leaves other requests and web pages alone', () => {
    expect(headersFor({ url: 'https://example.com/embed/x', resourceType: 'subFrame', initiatorOrigin: NSITE })).toEqual({});
    expect(headersFor({ url: EMBED, resourceType: 'script', initiatorOrigin: NSITE })).toEqual({});
    expect(headersFor({ url: EMBED, resourceType: 'subFrame', initiatorOrigin: 'https://ditto.pub' })).toEqual({});
    expect(headersFor({ url: EMBED, resourceType: 'subFrame' })).toEqual({});
  });
});

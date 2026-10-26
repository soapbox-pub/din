import { describe, expect, it } from 'vitest';
import { findMatches, matchesAll, parseQuery } from './settingsSearch';

const highlighted = (text: string, query: string) =>
  findMatches(text, parseQuery(query)).map(([start, end]) => text.slice(start, end));

describe('settings search', () => {
  it('ignores punctuation and spacing', () => {
    expect(highlighted('Wi-Fi', 'wifi')).toEqual(['Wi-Fi']);
    expect(highlighted('Date & Time', 'datetime')).toEqual(['Date & Time']);
    expect(highlighted('Night Light', 'nightlight')).toEqual(['Night Light']);
  });

  it('ignores case and accents', () => {
    expect(highlighted('Café Wi-Fi', 'CAFE')).toEqual(['Café']);
    expect(highlighted('Cafe\u0301', 'cafe')).toEqual(['Cafe\u0301']);
  });

  it('highlights every word of the query', () => {
    expect(highlighted('Show seconds in the menu bar', 'menu seconds')).toEqual(['seconds', 'menu']);
  });

  it('merges overlapping matches', () => {
    expect(highlighted('Bluetooth', 'blue tooth bluet')).toEqual(['Bluetooth']);
  });

  it('needs every word to match somewhere', () => {
    expect(matchesAll(['Sound', 'Mute'], parseQuery('sound mute'))).toBe(true);
    expect(matchesAll(['Sound', 'Mute'], parseQuery('sound wifi'))).toBe(false);
  });

  it('has nothing to search for in punctuation alone', () => {
    expect(parseQuery(' - & ')).toEqual([]);
  });
});

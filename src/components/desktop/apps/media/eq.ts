/**
 * The 10-band graphic equalizer's bands, presets, and Winamp's EQF preset
 * files. Gains are decibels, ±12, as both Winamp and Windows Media Player
 * show them.
 */

/** Centre frequencies (Hz): Windows Media Player's ISO bands. Winamp skins map onto them one to one. */
export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
/** What Winamp labels the same ten sliders. */
export const WINAMP_BAND_LABELS = ['60', '170', '310', '600', '1K', '3K', '6K', '12K', '14K', '16K'];

export const EQ_MAX_DB = 12;

export interface EqPreset {
  name: string;
  preamp: number;
  bands: number[];
}

const preset = (name: string, bands: number[], preamp = 0): EqPreset => ({
  name,
  preamp,
  bands: bands.map((b) => Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, b))),
});

/** Winamp's stock presets (which Windows Media Player's mostly share). */
export const EQ_PRESETS: EqPreset[] = [
  preset('Flat', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  preset('Acoustic', [4, 4, 3, 1, 1.5, 1.5, 3, 3.5, 3, 2]),
  preset('Classical', [0, 0, 0, 0, 0, 0, -7.2, -7.2, -7.2, -9.6]),
  preset('Club', [0, 0, 8, 5.6, 5.6, 5.6, 3.2, 0, 0, 0]),
  preset('Dance', [9.6, 7.2, 2.4, 0, 0, -5.6, -7.2, -7.2, 0, 0]),
  preset('Full Bass', [-8, 9.6, 9.6, 5.6, 1.6, -4, -8, -10.4, -11.2, -11.2]),
  preset('Full Bass & Treble', [7.2, 5.6, 0, -7.2, -4.8, 1.6, 8, 11.2, 12, 12]),
  preset('Full Treble', [-9.6, -9.6, -9.6, -4, 2.4, 11.2, 12, 12, 12, 12]),
  preset('Jazz', [4, 3, 1.5, 2, -1.5, -1.5, 0, 1.5, 3, 4]),
  preset('Laptop Speakers/Headphones', [4.8, 11.2, 5.6, -3.2, -2.4, 1.6, 4.8, 9.6, 12, 12]),
  preset('Large Hall', [10.4, 10.4, 5.6, 5.6, 0, -4.8, -4.8, -4.8, 0, 0]),
  preset('Live', [-4.8, 0, 4, 5.6, 5.6, 5.6, 4, 2.4, 2.4, 2.4]),
  preset('Party', [7.2, 7.2, 0, 0, 0, 0, 0, 0, 7.2, 7.2]),
  preset('Pop', [-1.6, 4.8, 7.2, 8, 5.6, 0, -2.4, -2.4, -1.6, -1.6]),
  preset('Rap', [5, 4, 1, 3, -1, -1, 1, 0, 2, 3]),
  preset('Reggae', [0, 0, 0, -5.6, 0, 6.4, 6.4, 0, 0, 0]),
  preset('Rock', [8, 4.8, -5.6, -8, -3.2, 4, 8.8, 11.2, 11.2, 11.2]),
  preset('Ska', [-2.4, -4.8, -4, 0, 4, 5.6, 8.8, 9.6, 11.2, 9.6]),
  preset('Soft', [4.8, 1.6, 0, -2.4, 0, 4, 8, 9.6, 11.2, 12]),
  preset('Soft Rock', [4, 4, 2.4, 0, -4, -5.6, -3.2, 0, 2.4, 8.8]),
  preset('Speech', [-3, -1, 0, 2, 4, 4, 3, 1, -1, -4]),
  preset('Techno', [8, 5.6, 0, -5.6, -4.8, 0, 8, 9.6, 9.6, 8.8]),
];

const EQF_HEADER = 'Winamp EQ library file v1.1\x1a!--';
const EQF_NAME_BYTES = 257;

const byteToDb = (b: number) => ((31.5 - Math.max(0, Math.min(63, b))) / 31.5) * EQ_MAX_DB;
const dbToByte = (db: number) => Math.max(0, Math.min(63, Math.round(31.5 - (db / EQ_MAX_DB) * 31.5)));

/** Presets in a Winamp .eqf (or winamp.q1) file. */
export function parseEqf(data: Uint8Array): EqPreset[] {
  const header = new TextDecoder('latin1').decode(data.subarray(0, EQF_HEADER.length));
  if (!header.startsWith('Winamp EQ library file')) throw new Error('Not a Winamp equalizer preset file');
  const presets: EqPreset[] = [];
  const entry = EQF_NAME_BYTES + 11;
  for (let p = EQF_HEADER.length; p + entry <= data.length; p += entry) {
    const nameBytes = data.subarray(p, p + EQF_NAME_BYTES);
    const end = nameBytes.indexOf(0);
    const name = new TextDecoder('latin1').decode(nameBytes.subarray(0, end === -1 ? undefined : end)).trim();
    const values = data.subarray(p + EQF_NAME_BYTES, p + entry);
    presets.push({
      name: name || 'Preset',
      bands: Array.from(values.subarray(0, 10), byteToDb),
      preamp: byteToDb(values[10]),
    });
  }
  return presets;
}

/** A Winamp .eqf file holding the given presets. */
export function writeEqf(presets: EqPreset[]): Uint8Array {
  const entry = EQF_NAME_BYTES + 11;
  const out = new Uint8Array(EQF_HEADER.length + presets.length * entry);
  for (let i = 0; i < EQF_HEADER.length; i++) out[i] = EQF_HEADER.charCodeAt(i);
  presets.forEach((p, n) => {
    const at = EQF_HEADER.length + n * entry;
    const name = p.name.slice(0, EQF_NAME_BYTES - 1);
    for (let i = 0; i < name.length; i++) out[at + i] = name.charCodeAt(i) & 0xff;
    p.bands.forEach((db, i) => (out[at + EQF_NAME_BYTES + i] = dbToByte(db)));
    out[at + EQF_NAME_BYTES + 10] = dbToByte(p.preamp);
  });
  return out;
}

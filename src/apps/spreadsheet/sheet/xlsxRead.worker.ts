/// <reference lib="webworker" />
/**
 * Unzips a workbook and scans its worksheets' cells and shared strings off
 * the main thread: on a big file these take long enough to freeze the whole
 * desktop.
 */
import { strFromU8 } from 'fflate';
import { OpcPackage } from '@/shared/office/ooxml';
import { rootName, scanSharedStrings, scanSheet, type ScannedSheet } from './xlsxScan';

export type ScanReply =
  | { ok: true; files: Map<string, Uint8Array>; sheets: Record<string, ScannedSheet>; strings: Record<string, string[]> }
  | { ok: false; error: string };

self.onmessage = (e: MessageEvent<{ bytes: ArrayBuffer }>) => {
  try {
    const pkg = OpcPackage.read(new Uint8Array(e.data.bytes));
    const sheets: Record<string, ScannedSheet> = {};
    const strings: Record<string, string[]> = {};
    for (const [path, data] of pkg.files) {
      if (!path.endsWith('.xml')) continue;
      const root = rootName(strFromU8(data.subarray(0, 4096)));
      if (root === 'worksheet') {
        const scanned = scanSheet(strFromU8(data));
        if (!scanned) continue;
        sheets[path] = scanned;
        pkg.setText(path, scanned.rest);
      } else if (root === 'sst') {
        strings[path] = scanSharedStrings(strFromU8(data));
        pkg.files.delete(path);
      }
    }
    const transfer = new Set<ArrayBuffer>();
    for (const data of pkg.files.values()) transfer.add(data.buffer as ArrayBuffer);
    for (const s of Object.values(sheets)) for (const a of [s.rows, s.cells, s.nums, s.fCell, s.fType]) transfer.add(a.buffer as ArrayBuffer);
    const reply: ScanReply = { ok: true, files: pkg.files, sheets, strings };
    self.postMessage(reply, [...transfer]);
  } catch (err) {
    const reply: ScanReply = { ok: false, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(reply);
  }
};

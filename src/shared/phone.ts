import type { PhoneAppBridge } from '@/lib/phone';

/** Messages' phone bridge (`din.system.phone`); types in src/lib/phone.ts. */
export function getPhoneBridge(): PhoneAppBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.din?.system.phone;
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanPhoneError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

/** The digits of a phone number, for matching (`+1 (555) 010-2000` and `5550102000` match). */
export function phoneDigits(address: string): string {
  const digits = address.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** A phone number as people write it, when it looks like a North American one; anything else as given. */
export function formatAddress(address: string): string {
  if (!/^[+\d\s().-]+$/.test(address)) return address;
  const digits = address.replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return address;
}

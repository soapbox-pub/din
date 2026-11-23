import type { ProgramSignerRequest } from '@/lib/programSigner';

/**
 * The window a program's request to sign as the user opens in
 * (src/components/desktop/apps/ProgramSignerWindow.tsx): hidden from the
 * launcher, one per request, opened by ProgramSignerHost from the request's
 * notification with a `request` launch param naming one of the requests
 * below. Never restored: what asked before a restart isn't waiting.
 */
export const PROGRAM_SIGNER_APP_ID = 'program-signer';

/** Requests waiting to be answered, by id, as the host last heard of them. */
const requests = new Map<number, ProgramSignerRequest>();

export function setProgramSignerRequest(request: ProgramSignerRequest): void {
  requests.set(request.requestId, request);
}

export function getProgramSignerRequest(id: number): ProgramSignerRequest | undefined {
  return requests.get(id);
}

/** It was answered or went away. */
export function forgetProgramSignerRequest(id: number): void {
  requests.delete(id);
}

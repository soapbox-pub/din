// Giac (the computer algebra system behind Xcas and the HP Prime), compiled
// to WebAssembly, runs here so a long computation never blocks the desktop.
// The Calculator can terminate this worker to break out of one (the TI-89's
// ON key), then starts another and restores the user's variables.

import { giacMessages } from './giacShim';
import Module from '@basthon/xcas-wasm';
import type { WorkerRequest, WorkerResponse, EvalResult } from './casProtocol';

type GiacModule = {
  onRuntimeInitialized?: () => void;
  calledRun?: boolean;
  cwrap: (name: string, ret: string, args: string[]) => (input: string) => string;
};

const giacModule = Module as unknown as GiacModule;

/** This worker's global scope (the DOM lib types `self` as a Window). */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

// The glue prints progress ("Trying integration by part") and errors to the
// console; keep them for the command that caused them instead.
const capture = (...args: unknown[]) => {
  giacMessages.push(args.map(String).join(' '));
};
console.log = capture;
console.warn = capture;
console.error = capture;

const ready = new Promise<(input: string) => string>((resolve) => {
  const done = () => resolve(giacModule.cwrap('caseval', 'string', ['string']));
  if (giacModule.calledRun) done();
  else giacModule.onRuntimeInitialized = done;
});

const ERROR_PREFIX = 'GIAC_ERROR:';

/** Giac's own error text, without the echo of the command it failed on. */
function cleanError(text: string): string {
  const lines = text.slice(ERROR_PREFIX.length).split('\n').map((line) => line.trim()).filter(Boolean);
  const errorLine = lines.find((line) => /error/i.test(line)) ?? lines[lines.length - 1] ?? 'Error';
  return errorLine.replace(/^.*?Error:\s*/i, '').trim() || 'Error';
}

/** A syntax error alert, made readable. */
function syntaxError(messages: string[]): string | undefined {
  const message = messages.find((m) => /syntax error/i.test(m));
  if (!message) return undefined;
  const match = /col (\d+)/.exec(message);
  return match ? `Syntax error near column ${match[1]}` : 'Syntax error';
}

/** Unquote a giac string literal ("a""b" style or \" escapes). */
function unquote(text: string): string {
  const s = text.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/""/g, '"').replace(/\\"/g, '"');
  }
  return s;
}

function run(caseval: (input: string) => string, code: string): { out: string; error?: string } {
  giacMessages.length = 0;
  let out: string;
  try {
    out = caseval(code);
  } catch (error) {
    return { out: '', error: String(error) };
  }
  const syntax = syntaxError(giacMessages);
  if (syntax) return { out, error: syntax };
  if (out.startsWith(ERROR_PREFIX)) return { out, error: cleanError(out) };
  return { out };
}

function evaluate(caseval: (input: string) => string, code: string, store: string, approx: boolean, simplify: boolean): EvalResult {
  const assigned = run(caseval, `${store}:=(${code})`);
  if (assigned.error) return { error: assigned.error, messages: [...giacMessages] };
  const messages = giacMessages.filter((m) => /warning|no checks|could not|assum/i.test(m) && !/declared as global/i.test(m));
  if (approx) run(caseval, `${store}:=evalf(${store})`);
  let exact = unquote(run(caseval, `string(${store})`).out);
  // A TI-89 simplifies every answer; giac leaves 5√2+3√2 and 4π/8 alone. Only
  // for constants, and only when it comes out shorter (or complex: a+bi), so
  // simplify() doesn't rewrite trig into half-angle tangents or undo forms.
  if (simplify && !approx && exact.length < 2000 && run(caseval, `lname(${store})`).out.trim() === '[]') {
    const simpler = run(caseval, `string(simplify(${store}))`);
    const text = unquote(simpler.out);
    if (!simpler.error && text && text !== exact && (text.length <= exact.length || /\bi\b/.test(exact))) {
      run(caseval, `${store}:=simplify(${store})`);
      exact = text;
    }
  }
  let decimal: string | undefined;
  const type = run(caseval, `type(${store})`).out.trim();
  // Exact numbers get their decimal value too, like a TI-89's ≈ key.
  if (!approx && /^(integer|rational|expression|real|complex)$/.test(type)) {
    const value = run(caseval, `string(evalf(${store}))`);
    if (!value.error) {
      const text = unquote(value.out);
      const numeric = /^-?[\d.]+(e[+-]?\d+)?$/.test(text) || /^-?[\d.]+(e[+-]?\d+)?[+-][\d.]*(e[+-]?\d+)?\*?i$/.test(text);
      if (numeric && text !== exact) decimal = text;
    }
  }
  return { exact, decimal, type, messages };
}

/** Values of `expr` at each point of `xs`, NaN where it isn't real. */
function sample(caseval: (input: string) => string, expr: string, variable: string, xs: number[]): number[] {
  run(caseval, `dinsamplefn:=unapply(${expr},${variable})`);
  return xs.map((x) => {
    const { out, error } = run(caseval, `evalf(dinsamplefn(${x}))`);
    if (error) return NaN;
    const value = Number(out.trim());
    return Number.isFinite(value) ? value : NaN;
  });
}

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const caseval = await ready;
  const request = event.data;
  let response: WorkerResponse;
  switch (request.type) {
    case 'eval':
      response = { id: request.id, type: 'eval', result: evaluate(caseval, request.code, request.store, request.approx, request.simplify) };
      break;
    case 'run': {
      const results = request.codes.map((code) => {
        const { out, error } = run(caseval, code);
        return error ? { error } : { out: unquote(out) };
      });
      response = { id: request.id, type: 'run', results };
      break;
    }
    case 'sample':
      response = { id: request.id, type: 'sample', values: sample(caseval, request.expr, request.variable, request.xs) };
      break;
  }
  scope.postMessage(response);
};

void ready.then(() => scope.postMessage({ type: 'ready' }));

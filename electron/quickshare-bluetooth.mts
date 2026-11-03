// Quick Share over Bluetooth (electron/quickshare.mts): Android phones find
// this computer by a Bluetooth LE advertisement and connect over RFCOMM.
// BlueZ hands those connections over as file descriptors, which Node can't
// receive, so a helper takes them (quickshare-bt.py, run with
// DIN_QUICKSHARE_PYTHON, which on DinOS has its D-Bus and GLib bindings) and
// passes each through to a Unix socket here, in a directory only this user
// can open, after a token only it was given and a line saying which device
// it is and whether its link has the pairing's key.
//
// The helper runs while there's something to advertise or a connection to
// pass through, and starts again if it stops while it's wanted.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const HELPER = path.join(import.meta.dirname, 'quickshare-bt.py');
const PYTHON = process.env.DIN_QUICKSHARE_PYTHON || 'python3';
/** How long to wait before starting the helper again when it stops while wanted. */
const RETRY_MS = 10_000;
/** The most a connection may send before its token and description. */
const MAX_HEADER = 4096;

export interface BluetoothPeer {
  /** Its Bluetooth address. */
  address: string;
  /** BlueZ has it paired. */
  paired: boolean;
  /** Its link is authenticated and encrypted: it has the pairing's key, so it is the paired device. */
  secured: boolean;
}

type Connected = (socket: net.Socket, peer: BluetoothPeer) => void;

let onConnection: Connected = (socket) => socket.destroy();
let helper: ChildProcess | null = null;
let server: net.Server | null = null;
let directory: string | null = null;
let token = '';
/** The adapter's address, once the helper is ready. */
let adapterAddress: string | null = null;
/** What to advertise, from the adapter's address; null for nothing. */
let advertisement: ((address: string) => Buffer) | null = null;
let retry: NodeJS.Timeout | null = null;
const sockets = new Set<net.Socket>();
/** The last thing the helper said went wrong, so it's logged once. */
let lastError = '';

function wanted(): boolean {
  return advertisement !== null || sockets.size > 0;
}

function tell(message: unknown): void {
  helper?.stdin?.write(`${JSON.stringify(message)}\n`);
}

function sendAdvertisement(): void {
  if (!helper || !adapterAddress) return;
  tell({ advertise: advertisement ? advertisement(adapterAddress).toString('hex') : null });
}

/** A connection from the helper: its token, then who it is, then Quick Share. */
function accepted(socket: net.Socket): void {
  let header = Buffer.alloc(0);
  const fail = () => socket.destroy();
  const onData = (chunk: Buffer) => {
    header = Buffer.concat([header, chunk]);
    const first = header.indexOf(10);
    const second = first < 0 ? -1 : header.indexOf(10, first + 1);
    if (second < 0) {
      if (header.length > MAX_HEADER) fail();
      return;
    }
    socket.off('data', onData);
    socket.pause();
    const given = header.subarray(0, first);
    const expected = Buffer.from(token);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return fail();
    let peer: BluetoothPeer;
    try {
      const raw = JSON.parse(header.subarray(first + 1, second).toString('utf8')) as Partial<BluetoothPeer>;
      if (typeof raw.address !== 'string' || !/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i.test(raw.address)) return fail();
      peer = { address: raw.address.toUpperCase(), paired: raw.paired === true, secured: raw.secured === true };
    } catch {
      return fail();
    }
    const rest = header.subarray(second + 1);
    if (rest.length) socket.unshift(rest);
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      if (!wanted()) stop();
    });
    onConnection(socket, peer);
  };
  socket.on('data', onData);
  socket.on('error', fail);
}

function listenHere(): Promise<string> {
  directory ??= fs.mkdtempSync(path.join(os.tmpdir(), 'din-quickshare-'));
  const file = path.join(directory, 'bluetooth.sock');
  fs.rmSync(file, { force: true });
  return new Promise((resolve, reject) => {
    const s = net.createServer(accepted);
    s.once('error', reject);
    s.listen(file, () => {
      s.off('error', reject);
      server = s;
      resolve(file);
    });
  });
}

async function start(): Promise<void> {
  if (helper || !wanted()) return;
  clearTimeout(retry ?? undefined);
  retry = null;
  let file: string;
  try {
    file = await listenHere();
  } catch (e) {
    console.warn('quickshare: can’t listen for Bluetooth connections', e);
    return;
  }
  if (helper || !wanted()) return;
  token = crypto.randomBytes(32).toString('hex');
  const child = spawn(PYTHON, [HELPER], { stdio: ['pipe', 'pipe', 'pipe'] });
  helper = child;
  let errors = '';
  let lines = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    lines += chunk;
    let end: number;
    while ((end = lines.indexOf('\n')) >= 0) {
      const line = lines.slice(0, end);
      lines = lines.slice(end + 1);
      let message: { ready?: { address?: unknown } };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.ready && typeof message.ready.address === 'string') {
        adapterAddress = message.ready.address;
        lastError = '';
        sendAdvertisement();
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    errors = (errors + chunk).slice(-2000);
  });
  child.stdin.on('error', () => {});
  child.on('error', (e) => {
    errors = e.message;
  });
  child.on('close', () => {
    if (helper !== child) return;
    helper = null;
    adapterAddress = null;
    const why = errors.trim().split('\n').pop() ?? '';
    if (why && why !== lastError) console.warn(`quickshare: the Bluetooth helper stopped: ${why}`);
    lastError = why;
    if (wanted()) retry = setTimeout(() => void start(), RETRY_MS);
    else stop();
  });
  tell({ socket: file, token });
}

function stop(): void {
  clearTimeout(retry ?? undefined);
  retry = null;
  const child = helper;
  helper = null;
  adapterAddress = null;
  child?.stdin?.end();
  if (child) setTimeout(() => child.kill(), 3000).unref();
  server?.close();
  server = null;
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = null;
}

/** Where connections go; quickshare.mts. */
export function onBluetooth(connected: Connected): void {
  onConnection = connected;
}

/**
 * Advertise what `build` makes from the adapter's address (built again each
 * time the helper starts), or stop advertising with null.
 */
export function advertiseOverBluetooth(build: ((address: string) => Buffer) | null): void {
  advertisement = build;
  if (build) {
    if (helper) sendAdvertisement();
    else void start();
  } else if (helper) {
    sendAdvertisement();
    if (!wanted()) stop();
  }
}

/** Bluetooth turned on, or BlueZ started again: try now rather than at the next retry. */
export function bluetoothMayWork(): void {
  if (!helper && wanted()) void start();
}

/** Din is quitting. */
export function quitBluetooth(): void {
  advertisement = null;
  for (const socket of sockets) socket.destroy();
  stop();
}

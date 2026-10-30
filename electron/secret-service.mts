// The login keyring, over the Secret Service (org.freedesktop.secrets).
//
// DinOS unlocks gnome-keyring's login keyring with the boot screen's
// password (din-keyring-unlock in os/configuration.nix), so a secret kept
// there is one the computer's password opens. Passwords (passwords.mts)
// keeps its vault's key there to open the vault at login.
//
// Only what Din needs: look an item up, store it, delete it. Never prompts:
// a locked keyring reads as `locked`, and storing into one fails, since a
// prompt would be a GTK window that Din's compositor doesn't show. Secrets
// travel in the "plain" session algorithm; the session bus is this user's
// own, and anything able to listen on it could ask for the secret anyway.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { DBusConnection, Variant } from './dbus.mts';
import { sessionBusAddress } from './native-display.mts';

const SERVICE = 'org.freedesktop.secrets';
const SERVICE_PATH = '/org/freedesktop/secrets';
const DEFAULT_COLLECTION = '/org/freedesktop/secrets/aliases/default';
const NO_PROMPT = '/';

export type SecretLookup =
  | { state: 'found'; secret: Buffer }
  | { state: 'missing' }
  | { state: 'locked' }
  | { state: 'unavailable' };

/** Run `fn` with a connection and an open plain session, or resolve null if there's no Secret Service. */
async function withSession<T>(fn: (bus: DBusConnection, session: string) => Promise<T>): Promise<T | null> {
  let bus: DBusConnection | null = null;
  try {
    bus = await DBusConnection.connect(await sessionBusAddress());
    if (!bus) return null;
    const [, session] = await bus.call({
      destination: SERVICE,
      path: SERVICE_PATH,
      interface: 'org.freedesktop.Secret.Service',
      member: 'OpenSession',
      signature: 'sv',
      body: ['plain', new Variant('s', '')],
    });
    return await fn(bus, String(session));
  } catch {
    return null;
  } finally {
    // Closing the connection closes the session with it.
    bus?.close();
  }
}

async function search(bus: DBusConnection, attributes: Record<string, string>): Promise<{ unlocked: string[]; locked: string[] }> {
  const [unlocked, locked] = await bus.call({
    destination: SERVICE,
    path: SERVICE_PATH,
    interface: 'org.freedesktop.Secret.Service',
    member: 'SearchItems',
    signature: 'a{ss}',
    body: [attributes],
  });
  return { unlocked: (unlocked as string[]) ?? [], locked: (locked as string[]) ?? [] };
}

/** The secret of the item with these attributes. */
export async function lookupSecret(attributes: Record<string, string>): Promise<SecretLookup> {
  const result = await withSession(async (bus, session): Promise<SecretLookup> => {
    const { unlocked, locked } = await search(bus, attributes);
    if (unlocked.length === 0) return locked.length > 0 ? { state: 'locked' } : { state: 'missing' };
    const [secret] = await bus.call({
      destination: SERVICE,
      path: unlocked[0],
      interface: 'org.freedesktop.Secret.Item',
      member: 'GetSecret',
      signature: 'o',
      body: [session],
    });
    const value = (secret as unknown[])[2];
    return Buffer.isBuffer(value) ? { state: 'found', secret: value } : { state: 'missing' };
  });
  return result ?? { state: 'unavailable' };
}

/** Store (or replace) an item in the default keyring. Resolves whether it was stored. */
export async function storeSecret(label: string, attributes: Record<string, string>, secret: Buffer): Promise<boolean> {
  const result = await withSession(async (bus, session) => {
    const properties = new Map<string, Variant>([
      ['org.freedesktop.Secret.Item.Label', new Variant('s', label)],
      ['org.freedesktop.Secret.Item.Attributes', new Variant('a{ss}', attributes)],
    ]);
    const [, prompt] = await bus.call({
      destination: SERVICE,
      path: DEFAULT_COLLECTION,
      interface: 'org.freedesktop.Secret.Collection',
      member: 'CreateItem',
      signature: 'a{sv}(oayays)b',
      body: [properties, [session, Buffer.alloc(0), secret, 'application/octet-stream'], true],
    });
    // A prompt means the keyring is locked; it's left unanswered.
    return prompt === NO_PROMPT;
  });
  return result ?? false;
}

/** Delete the items with these attributes, where the keyring is unlocked. */
export async function deleteSecret(attributes: Record<string, string>): Promise<void> {
  await withSession(async (bus) => {
    const { unlocked } = await search(bus, attributes);
    for (const item of unlocked) {
      await bus.call({
        destination: SERVICE,
        path: item,
        interface: 'org.freedesktop.Secret.Item',
        member: 'Delete',
      });
    }
  });
}

import { useState, type FormEvent } from 'react';
import { CircleCheck, FileKey, FileUp, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cleanPasswordsError, isKdbx, type PasswordsImportResult } from '@/lib/passwords';
import { fileTypes, pickFiles } from '@/shared/fileHandles';
import { cn } from '@/lib/utils';
import { EmptyState, FormWindow } from '@/shared/appChrome';
import { settingsGroup } from '@/shared/settingsChromeStyles';
import { announceImported, useBridge } from './vault';

const SOURCES: { name: string; how: string }[] = [
  { name: 'Google Passwords', how: 'passwords.google.com → Settings → Export passwords' },
  { name: 'Chrome, Edge, Brave', how: 'Settings → Passwords → Export passwords (CSV)' },
  { name: 'Firefox', how: 'Passwords → ⋯ → Export Passwords (CSV)' },
  { name: 'Apple Passwords, Safari', how: 'File → Export All Passwords (CSV)' },
  { name: 'KeePass, KeePassXC, Strongbox', how: 'the .kdbx file itself, with its password' },
  { name: 'Bitwarden', how: 'Tools → Export vault, as .json or .csv (unencrypted)' },
  { name: '1Password, LastPass, Proton Pass, Dashlane, NordPass', how: 'their CSV export' },
];

const IMPORT_TYPES = fileTypes([{ description: 'Password exports', extensions: ['.kdbx', '.csv', '.json'] }]);

/** A file picked to import. */
interface Picked {
  name: string;
  data: ArrayBuffer;
}

type Step =
  | { type: 'choose'; error?: string }
  | { type: 'kdbx'; file: Picked }
  | { type: 'done'; result: PasswordsImportResult; export: boolean };

async function pickOne(title: string, types = IMPORT_TYPES): Promise<Picked | null> {
  const [handle] = await pickFiles({ title, types, mode: 'read', confirmLabel: 'Import' });
  if (!handle) return null;
  const file = await handle.getFile();
  return { name: file.name, data: await file.arrayBuffer() };
}

function count(n: number, what: string): string {
  return `${n} ${what}${n === 1 ? '' : 's'}`;
}

/** The password (and key file) a KeePass file opens with. */
function KdbxForm({
  file,
  onBack,
  onDone,
}: {
  file: Picked;
  onBack: () => void;
  onDone: (result: PasswordsImportResult) => void;
}) {
  const bridge = useBridge();
  const [password, setPassword] = useState('');
  const [keyFile, setKeyFile] = useState<Picked | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!bridge || busy || (!password && !keyFile)) return;
    setBusy(true);
    setError(null);
    bridge.import(file.data, { name: file.name, password: password || undefined, keyFile: keyFile?.data }).then(onDone, (err: unknown) => {
      setError(cleanPasswordsError(err));
      setBusy(false);
    });
  };

  const chooseKeyFile = () =>
    void pickOne('Choose the Key File', []).then((picked) => picked && setKeyFile(picked), (err: unknown) => setError(cleanPasswordsError(err)));

  return (
    <form onSubmit={submit} className="contents">
      <FormWindow
        title={`Import “${file.name}”`}
        description="Enter the password this KeePass file opens with. Its items go in a folder of their own."
        footer={
          <>
            <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
              Back
            </Button>
            <Button type="submit" disabled={busy || (!password && !keyFile)}>
              {busy && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
              Import
            </Button>
          </>
        }
      >
      <Input
        type="password"
        autoComplete="off"
        autoFocus
        aria-label="The file’s password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-invalid={!!error}
      />
      <div className="flex items-center gap-2">
        {keyFile ? (
          <span className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-foreground/[0.06] px-3 py-1.5 text-sm">
            <FileKey className="size-4.5 shrink-0 text-ink-accent" strokeWidth={1.75} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{keyFile.name}</span>
            <Button type="button" variant="ghost" size="icon" className="size-6" aria-label="Don’t use a key file" onClick={() => setKeyFile(null)}>
              <X className="size-4" strokeWidth={1.75} />
            </Button>
          </span>
        ) : (
          <Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={chooseKeyFile}>
            <FileKey className="size-4.5" strokeWidth={1.75} aria-hidden />
            Use a Key File…
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="px-1 text-sm text-destructive">
          {error}
        </p>
      )}
      </FormWindow>
    </form>
  );
}

function Choose({ error, onPicked, busy }: { error?: string; onPicked: () => void; busy: boolean }) {
  return (
    <FormWindow
      title="Import Passwords"
      description="Bring in passwords from another app or browser. Passwords you already have aren’t added twice."
      footer={
        <Button onClick={onPicked} disabled={busy} autoFocus>
          {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <FileUp className="size-4.5" strokeWidth={1.75} aria-hidden />}
          Choose File…
        </Button>
      }
    >
      <ul className={cn(settingsGroup, 'text-sm')}>
        {SOURCES.map((s) => (
          <li key={s.name} className="px-4 py-2.5">
            <span className="font-medium">{s.name}</span>
            <span className="block text-xs text-muted-foreground">{s.how}</span>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="px-1 text-sm text-destructive">
          {error}
        </p>
      )}
    </FormWindow>
  );
}

function Done({ result, fromExport, onClose }: { result: PasswordsImportResult; fromExport: boolean; onClose: () => void }) {
  return (
    <FormWindow
      title="Import Passwords"
      footer={
        <Button onClick={onClose} autoFocus>
          Done
        </Button>
      }
    >
      <EmptyState icon={CircleCheck} title={result.added > 0 ? `Imported ${count(result.added, 'item')}` : 'Nothing new to import'} className="py-8">
        {result.source === 'CSV' ? 'From the CSV file.' : `From ${result.source}.`}
        {result.skipped > 0 && ` ${count(result.skipped, 'item')} ${result.skipped === 1 ? 'was' : 'were'} already in Passwords.`}
      </EmptyState>
      {fromExport && (
        <p className="flex gap-2 rounded-xl bg-warning/10 p-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <span>The file you exported holds your passwords unencrypted, for anyone who finds it. Delete it, and empty the Trash.</span>
        </p>
      )}
    </FormWindow>
  );
}

/**
 * Import, in a window of its own (opened with `{ window: 'import' }`): a
 * file picked, then a KeePass file's password, then what came in, which the
 * app's other windows hear (`announceImported`). What's in the file is read
 * in main (passwords.mts, passwords-import.mts).
 */
export function ImportWindow() {
  const bridge = useBridge();
  const [step, setStep] = useState<Step>({ type: 'choose' });
  const [busy, setBusy] = useState(false);

  const done = (result: PasswordsImportResult, fromExport: boolean) => {
    setStep({ type: 'done', result, export: fromExport });
    announceImported(result);
  };

  const choose = async () => {
    if (!bridge) return;
    let file: Picked | null;
    try {
      file = await pickOne('Import Passwords');
    } catch (err) {
      setStep({ type: 'choose', error: cleanPasswordsError(err) });
      return;
    }
    if (!file) return;
    if (isKdbx(new Uint8Array(file.data, 0, Math.min(4, file.data.byteLength)))) {
      setStep({ type: 'kdbx', file });
      return;
    }
    setBusy(true);
    try {
      done(await bridge.import(file.data, { name: file.name }), true);
    } catch (err) {
      setStep({ type: 'choose', error: cleanPasswordsError(err) });
    } finally {
      setBusy(false);
    }
  };

  if (step.type === 'kdbx') return <KdbxForm file={step.file} onBack={() => setStep({ type: 'choose' })} onDone={(result) => done(result, false)} />;
  if (step.type === 'done') return <Done result={step.result} fromExport={step.export} onClose={() => window.close()} />;
  return <Choose error={step.error} busy={busy} onPicked={() => void choose()} />;
}

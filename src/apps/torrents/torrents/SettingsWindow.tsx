import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, Folder, LoaderCircle, Turtle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cleanTorrentsError, type TorrentSettings, type TorrentsStatus } from '@/lib/torrents';
import { useDin, useWindowTitle } from '@/sdk/react';
import { FormWindow, PillButton, SegmentedControl } from '@/shared/appChrome';
import { pickFolder } from '@/shared/fileHandles';
import { settingsGroup } from '@/shared/settingsChromeStyles';
import { SettingsSubHeading } from '@/shared/settingsSection';
import { toast } from '@/shared/toast';
import { KEY, useBridge, useTorrents, useTorrentsStatus } from './bridge';

type Patch = Partial<Omit<TorrentSettings, 'peerPort'>>;

/** A number typed in, saved when it's left or Enter is pressed. */
function NumberField({ value, onCommit, min, max, step = 1, label, suffix, disabled }: {
  value: number;
  onCommit: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  label: string;
  suffix?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  // What's saved changed elsewhere: show it.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setText(String(value));
  }
  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n) || n < min || n > max) {
      setText(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Input
        type="number"
        inputMode="decimal"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        className="h-8 w-24 text-right text-sm tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </span>
  );
}

function Row({ title, detail, htmlFor, children }: { title: ReactNode; detail?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        {htmlFor ? (
          <Label htmlFor={htmlFor} className="cursor-pointer text-sm">
            {title}
          </Label>
        ) : (
          <p className="text-sm">{title}</p>
        )}
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  );
}

function PortCheck({ port }: { port: number }) {
  const bridge = useBridge();
  const [state, setState] = useState<'idle' | 'checking' | 'open' | 'closed' | 'failed'>('idle');
  const check = async () => {
    if (!bridge) return;
    setState('checking');
    try {
      setState((await bridge.testPort()) ? 'open' : 'closed');
    } catch {
      setState('failed');
    }
  };
  return (
    <Row
      title={`Port ${port}`}
      detail={
        state === 'open'
          ? 'Peers can reach this computer.'
          : state === 'closed'
            ? 'Peers can’t reach this computer on it, so it finds fewer of them. Forward it on your router, or let Torrents ask the router.'
            : state === 'failed'
              ? 'Couldn’t check: Transmission’s port checker didn’t answer.'
              : 'Where other peers reach this computer.'
      }
    >
      {state === 'open' && <CircleCheck className="size-4.5 text-success" aria-label="Open" />}
      {state === 'closed' && <CircleX className="size-4.5 text-destructive" aria-label="Closed" />}
      <PillButton size="sm" onClick={() => void check()} disabled={state === 'checking'}>
        {state === 'checking' && <LoaderCircle className="animate-spin" aria-hidden />}
        Check
      </PillButton>
    </Row>
  );
}

function Settings({ settings }: { settings: TorrentSettings }) {
  const bridge = useBridge();
  const din = useDin();
  const queryClient = useQueryClient();
  const save = (patch: Patch) => {
    if (!bridge) return;
    bridge.setSettings(patch).then(
      (next) => queryClient.setQueryData<TorrentsStatus>([...KEY, 'status'], (old) => (old ? { ...old, settings: next } : old)),
      (err: unknown) => toast('Torrents couldn’t change that', { body: cleanTorrentsError(err), destructive: true }),
    );
  };
  const chooseFolder = async () => {
    const folder = await pickFolder({ title: 'Download To', startIn: 'downloads', confirmLabel: 'Choose' });
    if (folder) save({ downloadDir: din.files.path(folder) });
  };

  return (
    <>
      <SettingsSubHeading className="mt-0">Downloads</SettingsSubHeading>
      <div className={settingsGroup}>
        <Row title="Download to" detail={<span className="break-all">{settings.downloadDir}</span>}>
          <Folder className="size-4.5 text-ink-accent" strokeWidth={1.75} aria-hidden />
          <PillButton size="sm" onClick={() => void chooseFolder()}>
            Change…
          </PillButton>
        </Row>
        <Row title="Start transfers when they’re added" htmlFor="start-added">
          <Switch id="start-added" checked={settings.startWhenAdded} onCheckedChange={(on) => save({ startWhenAdded: on })} />
        </Row>
        <Row title="Download only a few at once" detail="The rest wait their turn." htmlFor="queue">
          <NumberField
            label="How many at once"
            value={settings.downloadQueue.size}
            min={1}
            max={100}
            disabled={!settings.downloadQueue.enabled}
            onCommit={(size) => save({ downloadQueue: { ...settings.downloadQueue, size } })}
          />
          <Switch id="queue" checked={settings.downloadQueue.enabled} onCheckedChange={(enabled) => save({ downloadQueue: { ...settings.downloadQueue, enabled } })} />
        </Row>
      </div>

      <SettingsSubHeading>Speed</SettingsSubHeading>
      <div className={settingsGroup}>
        <Row title="Limit download speed" htmlFor="limit-down">
          <NumberField
            label="Download limit"
            value={settings.downloadLimit.kBps}
            min={1}
            max={10_000_000}
            suffix="KB/s"
            disabled={!settings.downloadLimit.enabled}
            onCommit={(kBps) => save({ downloadLimit: { ...settings.downloadLimit, kBps } })}
          />
          <Switch id="limit-down" checked={settings.downloadLimit.enabled} onCheckedChange={(enabled) => save({ downloadLimit: { ...settings.downloadLimit, enabled } })} />
        </Row>
        <Row title="Limit upload speed" htmlFor="limit-up">
          <NumberField
            label="Upload limit"
            value={settings.uploadLimit.kBps}
            min={1}
            max={10_000_000}
            suffix="KB/s"
            disabled={!settings.uploadLimit.enabled}
            onCommit={(kBps) => save({ uploadLimit: { ...settings.uploadLimit, kBps } })}
          />
          <Switch id="limit-up" checked={settings.uploadLimit.enabled} onCheckedChange={(enabled) => save({ uploadLimit: { ...settings.uploadLimit, enabled } })} />
        </Row>
      </div>
      <div className={settingsGroup}>
        <Row
          title={
            <span className="inline-flex items-center gap-2">
              <Turtle className="size-4.5 text-ink-accent" strokeWidth={1.75} aria-hidden />
              Turtle speed
            </span>
          }
          detail="Slower limits for when the connection’s wanted for something else. The turtle at the window’s foot turns it on."
          htmlFor="turtle"
        >
          <Switch id="turtle" checked={settings.altSpeed.enabled} onCheckedChange={(enabled) => save({ altSpeed: { ...settings.altSpeed, enabled } })} />
        </Row>
        <Row title="Download">
          <NumberField label="Turtle download limit" value={settings.altSpeed.downKBps} min={1} max={10_000_000} suffix="KB/s" onCommit={(downKBps) => save({ altSpeed: { ...settings.altSpeed, downKBps } })} />
        </Row>
        <Row title="Upload">
          <NumberField label="Turtle upload limit" value={settings.altSpeed.upKBps} min={1} max={10_000_000} suffix="KB/s" onCommit={(upKBps) => save({ altSpeed: { ...settings.altSpeed, upKBps } })} />
        </Row>
      </div>

      <SettingsSubHeading>Seeding</SettingsSubHeading>
      <div className={settingsGroup}>
        <Row title="Stop seeding at a ratio" detail="Once a transfer has uploaded this many times what it downloaded." htmlFor="ratio">
          <NumberField
            label="Ratio"
            value={settings.seedRatio.ratio}
            min={0.1}
            max={1000}
            step={0.1}
            disabled={!settings.seedRatio.enabled}
            onCommit={(ratio) => save({ seedRatio: { ...settings.seedRatio, ratio } })}
          />
          <Switch id="ratio" checked={settings.seedRatio.enabled} onCheckedChange={(enabled) => save({ seedRatio: { ...settings.seedRatio, enabled } })} />
        </Row>
      </div>

      <SettingsSubHeading>Network</SettingsSubHeading>
      <div className={settingsGroup}>
        <Row title="Encryption" detail="Required connects only to peers that encrypt, which hides what you share from your network but finds fewer peers.">
          <SegmentedControl
            label="Encryption"
            value={settings.encryption}
            onValueChange={(encryption) => save({ encryption })}
            options={[
              { value: 'preferred', label: 'Preferred' },
              { value: 'required', label: 'Required' },
              { value: 'allowed', label: 'Allowed' },
            ]}
          />
        </Row>
        <Row title="Ask the router to open the port" detail="With UPnP or NAT-PMP, so peers outside your network reach this computer." htmlFor="forward">
          <Switch id="forward" checked={settings.portForwarding} onCheckedChange={(portForwarding) => save({ portForwarding })} />
        </Row>
        <PortCheck port={settings.peerPort} />
      </div>
    </>
  );
}

/** Torrents' settings, in a window of its own (opened with `{ window: 'settings' }`). */
export function SettingsWindow() {
  const { data: status } = useTorrentsStatus();
  // Kept current with what the main window and `din torrents` change.
  useTorrents(!!status?.available);
  useWindowTitle('Torrents Settings');
  return (
    <FormWindow title="Torrents Settings">
      {status?.settings ? (
        <Settings settings={status.settings} />
      ) : status && !status.available ? (
        <p className="px-1 text-sm text-muted-foreground">{status.reason}</p>
      ) : (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
        </div>
      )}
    </FormWindow>
  );
}

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Disc3, ExternalLink, Monitor, Play, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import type { VmInfo, VmInstall } from '@/lib/vms';
import { useDin } from '@/sdk/react';
import { formatBytes } from './bridge';
import { OsBadge } from './fields';
import { SYSTEMS } from './systems';

/** Bytes a second, smoothed over the last several updates, for a time left. */
function useRate(received: number): number {
  const samples = useRef<{ t: number; b: number }[]>([]);
  const [rate, setRate] = useState(0);
  useEffect(() => {
    const now = Date.now();
    const list = samples.current;
    if (list.length && received < list[list.length - 1].b) list.length = 0;
    list.push({ t: now, b: received });
    while (list.length > 2 && now - list[0].t > 20_000) list.shift();
    const first = list[0];
    setRate(now > first.t + 1000 ? (received - first.b) / ((now - first.t) / 1000) : 0);
  }, [received]);
  return rate;
}

function timeLeft(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 90) return 'less than 2 minutes left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `about ${minutes} minutes left`;
  return `about ${Math.round(minutes / 60)} hours left`;
}

function describe(install: VmInstall, name: string, rate: number): { title: string; detail: string; value: number | null } {
  switch (install.phase) {
    case 'resolving':
      return { title: `Finding the newest ${name}…`, detail: '', value: null };
    case 'downloading': {
      const { receivedBytes: got, totalBytes: total } = install;
      const left = total && rate ? timeLeft((total - got) / rate) : '';
      return {
        title: `Downloading ${install.label || name}…`,
        detail: [total ? `${formatBytes(got)} of ${formatBytes(total)}` : formatBytes(got), left].filter(Boolean).join(' · '),
        value: total ? got / total : null,
      };
    }
    case 'verifying':
      return {
        title: 'Checking the download…',
        detail: 'Making sure it’s exactly what was published.',
        value: install.totalBytes ? install.receivedBytes / install.totalBytes : null,
      };
    case 'installing':
      return {
        title: `Setting up ${install.label || name}…`,
        detail: install.installer === 'macos' ? 'Apple’s installer takes over on the screen once it’s ready.' : 'It restarts by itself when it’s done.',
        value: install.installer === 'macos' ? null : install.progress,
      };
    case 'failed':
      return { title: `${name} couldn’t be installed`, detail: install.error ?? '', value: null };
  }
}

/**
 * A machine Din is installing: what it's doing and how far along, instead
 * of its screen (which can be shown). When it fails, how to get the system
 * by hand, and a way to go on from a disc image the user has.
 */
export function InstallCard({
  vm,
  onShowScreen,
  onStart,
  onRetry,
  onChooseIso,
  onCancel,
}: {
  vm: VmInfo;
  onShowScreen?: () => void;
  onStart: () => void;
  onRetry: () => void;
  onChooseIso: () => void;
  onCancel: () => void;
}) {
  const din = useDin();
  const install = vm.install!;
  const name = SYSTEMS.find((s) => s.id === install.installer)?.name ?? 'the system';
  const rate = useRate(install.phase === 'downloading' ? install.receivedBytes : 0);
  const { title, detail, value } = describe(install, name, rate);
  const failed = install.phase === 'failed';
  // An installer that was stopped part way through goes again from the start.
  const halted = install.phase === 'installing' && vm.state === 'stopped';

  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto">
      <div className="m-auto w-full max-w-md space-y-6 p-8 text-center">
        <OsBadge os={vm.config.os} system={install.installer} className="mx-auto size-20 rounded-3xl shadow-md" />
        <div className="space-y-2">
          <h2 className="text-xl font-semibold tracking-tight">{halted ? `${name} isn’t finished installing` : title}</h2>
          {failed ? (
            <div role="alert" className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-left text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              <p className="min-w-0 break-words">{detail}</p>
            </div>
          ) : (
            <p className="min-h-5 text-sm text-muted-foreground">{halted ? 'Start it to carry on: setup begins again.' : detail}</p>
          )}
        </div>

        {!failed && !halted && (
          <Progress
            value={value === null ? undefined : Math.round(value * 100)}
            aria-label={title}
            className={value === null ? 'motion-safe:animate-pulse' : undefined}
          />
        )}

        {failed && (
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              {install.installer === 'macos'
                ? 'If you have macOS’s recovery image (BaseSystem.dmg), you can choose it here. It still installs by itself.'
                : `You can download ${name} yourself from its website, then choose the disc image here. It still installs by itself.`}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {install.manualUrl && (
                <Button variant="outline" onClick={() => void din.app.openUrl(install.manualUrl)}>
                  <ExternalLink className="size-4" aria-hidden />
                  Get {name}
                </Button>
              )}
              <Button onClick={onChooseIso}>
                <Disc3 className="size-4" aria-hidden />
                Choose Disc Image…
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap justify-center gap-2">
          {halted && (
            <Button onClick={onStart}>
              <Play className="size-4" aria-hidden />
              Start
            </Button>
          )}
          {failed && (
            <Button variant="ghost" onClick={onRetry}>
              <RotateCcw className="size-4" aria-hidden />
              Try Again
            </Button>
          )}
          {onShowScreen && (
            <Button variant="ghost" onClick={onShowScreen}>
              <Monitor className="size-4" aria-hidden />
              Show Screen
            </Button>
          )}
          <Button variant="ghost" className="text-muted-foreground" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

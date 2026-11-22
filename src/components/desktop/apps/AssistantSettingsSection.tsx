import { useMutation } from '@tanstack/react-query';
import { ArrowUpCircle, AudioLines, Bot, CircleAlert, Download, Folder, Loader2, MessageSquareText, Palette, Play, RotateCw, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ProviderList } from '@/shared/assistant/Providers';
import { SkillsSettings } from '@/components/desktop/apps/AssistantSkillsSettings';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { useAppContext } from '@/hooks/useAppContext';
import { useAssistantStatus, useHomeDirectory, useSetAssistantEnabled } from '@/hooks/useAssistant';
import { useToast } from '@/hooks/useToast';
import { useFeatures } from '@/hooks/useFeatures';
import { useSpeech } from '@/hooks/useSpeech';
import type { AssistantSpeakReplies } from '@/contexts/AppContext';
import { cleanFeaturesError, describeFeature, findFeature, formatFeatureSize, getFeaturesBridge } from '@/lib/features';
import { cancelSpeech, defaultSpeechVoice, speak } from '@/lib/speech';
import { cleanAssistantError, getAssistantBridge, tildify } from '@/lib/assistant';
import { cn } from '@/lib/utils';
import { settingsCard, settingsGroup } from '@/shared/settingsChromeStyles';
import { SettingsSection } from '@/shared/settingsSection';
import { SettingsToken } from '@/shared/settingsChrome';
import { bundledIconProps } from '@/shared/iconSizes';

/**
 * Settings → Assistant: whether Din keeps OpenCode running, the state of
 * its server, the AI providers it may use, its skills and the folders
 * they're in (AssistantSkillsSettings), and below them where new
 * conversations work, how replies look, and when and in what voice they're
 * read aloud.
 */
export function AssistantSettingsSection() {
  const { config, updateConfig } = useAppContext();
  const setEnabled = useSetAssistantEnabled();
  const bridge = getAssistantBridge();

  return (
    <SettingsSection title="Assistant">

      {!bridge ? (
        <div className="px-8 py-12 text-center">
          <Bot className="mx-auto mb-4 size-8 text-muted-foreground/80" aria-hidden />
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            The assistant works through OpenCode on this computer, so it needs Din’s desktop app.
          </p>
        </div>
      ) : (
        <>
          <div className={cn(settingsCard, 'flex items-center justify-between gap-4 px-4 py-3')}>
            <div className="flex min-w-0 items-start gap-3">
              <img {...bundledIconProps('/icons/apps/assistant.png')} alt="" className="size-10 shrink-0 object-contain" />
              <div className="min-w-0">
                <Label htmlFor="assistant-enabled" className="cursor-pointer text-sm">
                  Assistant
                </Label>
                <p className="text-xs text-muted-foreground">
                  Keep OpenCode, the AI agent, running so you can ask it to do things on this computer: from the menu
                  bar, the Assistant app, or Super+A anywhere. It can read and change your files and run commands.
                </p>
              </div>
            </div>
            <Switch id="assistant-enabled" checked={config.assistantEnabled} onCheckedChange={setEnabled} />
          </div>

          {config.assistantEnabled && (
            <>
              <ServerStatus />
              <ProviderList />
              <SkillsSettings />
              {/* Smaller things, out of the way below the providers. */}
              <div className={settingsGroup}>
                <FolderSetting
                  value={config.assistantDirectory}
                  onChange={(assistantDirectory) => updateConfig((current) => ({ ...current, assistantDirectory }))}
                />
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <SettingsToken icon={Palette} />
                    <div className="min-w-0">
                      <Label htmlFor="assistant-colorful" className="cursor-pointer text-sm font-normal">
                        Colorful replies
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Color headings, bold and italic text, code, links and list markers in the agent’s replies.
                      </p>
                    </div>
                  </div>
                  <Switch
                    id="assistant-colorful"
                    checked={config.assistantColorfulReplies}
                    onCheckedChange={(assistantColorfulReplies) =>
                      updateConfig((current) => ({ ...current, assistantColorfulReplies }))
                    }
                  />
                </div>
              </div>
              <VoiceSettings />
            </>
          )}
        </>
      )}
    </SettingsSection>
  );
}

function ServerStatus() {
  const { data: status } = useAssistantStatus();
  const { toast } = useToast();
  const bridge = getAssistantBridge();
  const install = useMutation({ mutationFn: () => bridge!.install() });
  const restart = useMutation({ mutationFn: () => bridge!.restart() });
  const upgrade = useMutation({ mutationFn: () => bridge!.upgrade() });

  if (!status) return <Skeleton className="h-20 w-full rounded-xl" />;

  const updating = status.updating || upgrade.isPending;
  const state = status.installing
    ? { label: 'Installing OpenCode…', tone: 'muted' }
    : updating
      ? { label: `Updating OpenCode${status.update ? ` to ${status.update}` : ''}…`, tone: 'muted' }
      : !status.binary
        ? { label: status.version ? `OpenCode ${status.version} is too old` : 'OpenCode isn’t installed', tone: 'warn' }
        : status.running
          ? { label: status.connected ? 'Running' : 'Running, connecting…', tone: 'ok' }
          : status.error
            ? { label: 'Not running', tone: 'warn' }
            : { label: 'Starting…', tone: 'muted' };

  const fail = (title: string) => (error: unknown) =>
    toast({ title, description: cleanAssistantError(error), variant: 'destructive' });

  return (
    <div className={cn(settingsCard, 'space-y-3 px-4 py-3')}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium">
            <span
              aria-hidden
              className={cn(
                'size-2 rounded-full',
                state.tone === 'ok' && 'bg-success',
                state.tone === 'warn' && 'bg-warning',
                state.tone === 'muted' && 'bg-muted-foreground/50',
              )}
            />
            {state.label}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={status.binary ?? undefined}>
            {status.binary ? `OpenCode ${status.version ?? ''} · ${status.binary}` : 'OpenCode’s installer puts it in ~/.opencode, and Din offers its updates.'}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {status.binary && (status.update || updating) && (
            <Button
              size="sm"
              disabled={updating}
              title="Restarts OpenCode on the new version, stopping whatever the agent is doing"
              onClick={() => upgrade.mutate(undefined, { onError: fail('Couldn’t update OpenCode') })}
            >
              {updating ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ArrowUpCircle className="size-3.5" aria-hidden />}
              {status.update ? `Update to ${status.update}` : 'Update'}
            </Button>
          )}
          {!status.binary || (status.error && !status.running) ? (
            <Button
              size="sm"
              disabled={status.installing || install.isPending}
              onClick={() => install.mutate(undefined, { onError: fail('Couldn’t install OpenCode') })}
            >
              {(status.installing || install.isPending) && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              {status.binary ? 'Reinstall' : 'Install'}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={restart.isPending || updating}
              title="Stops whatever the agent is doing, in Din and in Terminals"
              onClick={() => restart.mutate(undefined, { onError: fail('Couldn’t restart OpenCode') })}
            >
              {restart.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RotateCw className="size-3.5" aria-hidden />}
              Restart
            </Button>
          )}
        </div>
      </div>
      {status.error && !status.running && (
        <p role="alert" className="flex items-start gap-2 text-xs text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="break-words">{status.error}</span>
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Conversations are OpenCode’s, so they’re shared with <code className="font-mono">opencode</code> in a Terminal.
      </p>
    </div>
  );
}

function FolderSetting({ value, onChange }: { value: string; onChange: (path: string) => void }) {
  const home = useHomeDirectory();
  const { pickFile } = useFilePicker();
  const current = value.trim() || home;

  const choose = async () => {
    const picked = await pickFile({ title: 'Start conversations in', confirmLabel: 'Choose', directory: true, initialPath: current }).catch(
      () => null,
    );
    if (picked) onChange(picked === home ? '' : picked);
  };

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <SettingsToken icon={Folder} />
        <div className="min-w-0">
          <p className="text-sm">Start conversations in</p>
          <p className="truncate text-xs text-muted-foreground" title={current}>
            {current ? tildify(current, home) : 'Your home folder'} · each new conversation can pick another
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {value && (
          <Button variant="ghost" size="sm" onClick={() => onChange('')}>
            Use home
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => void choose()}>
          Choose…
        </Button>
      </div>
    </div>
  );
}

const SPEAK_REPLIES: { value: AssistantSpeakReplies; label: string }[] = [
  { value: 'dictated', label: 'When I speak' },
  { value: 'always', label: 'Always' },
  { value: 'never', label: 'Never' },
];

/** Whose Settings' sample is, so playing another stops it. */
const SAMPLE = { name: 'settings' };

/**
 * When the assistant reads its replies aloud, and in which of Din's voices
 * (src/lib/speech.ts), with a sample; until the Speech optional feature is
 * installed, a way to install it.
 */
function VoiceSettings() {
  const { config, updateConfig } = useAppContext();
  const speech = useSpeech();
  const features = useFeatures();
  const { toast } = useToast();
  const feature = findFeature(features.data, 'speech');
  const voice = speech.voices.some((v) => v.id === config.speechVoice) ? config.speechVoice : defaultSpeechVoice();
  const playing = speech.current?.owner === SAMPLE;

  const play = (id: string) => {
    cancelSpeech(SAMPLE);
    const name = speech.voices.find((v) => v.id === id)?.name ?? 'Din';
    speak({ text: `Hi, I’m ${name}. This is how I’ll read the assistant’s replies to you.`, voice: id, owner: SAMPLE });
  };
  const install = () => {
    getFeaturesBridge()
      ?.install('speech')
      .catch((error: unknown) => toast({ title: 'Couldn’t install Speech', description: cleanFeaturesError(error), variant: 'destructive' }));
  };

  return (
    <div className={settingsGroup}>
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <SettingsToken icon={MessageSquareText} />
          <div className="min-w-0">
            <Label htmlFor="assistant-speak-replies" className="text-sm font-normal">
              Read replies aloud
            </Label>
            <p className="text-xs text-muted-foreground">
              When I speak: after a message you dictated. On a call, replies are always read aloud.
            </p>
          </div>
        </div>
        <Select
          value={config.assistantSpeakReplies ?? 'dictated'}
          onValueChange={(value) => updateConfig((current) => ({ ...current, assistantSpeakReplies: value as AssistantSpeakReplies }))}
        >
          <SelectTrigger id="assistant-speak-replies" size="sm" className="w-40 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SPEAK_REPLIES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {speech.available ? (
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <SettingsToken icon={AudioLines} />
            <div className="min-w-0">
              <Label htmlFor="speech-voice" className="text-sm font-normal">
                Voice
              </Label>
              <p className="text-xs text-muted-foreground">How Din sounds, for the assistant and apps that read aloud.</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="size-8 rounded-full"
              aria-label={playing ? 'Stop the sample' : 'Play a sample'}
              title={playing ? 'Stop' : 'Play a sample'}
              onClick={() => (playing ? cancelSpeech(SAMPLE) : play(voice))}
            >
              {playing ? <Square className="size-3.5 fill-current" aria-hidden /> : <Play className="size-4" aria-hidden />}
            </Button>
            <Select
              value={voice}
              onValueChange={(speechVoice) => {
                updateConfig((current) => ({ ...current, speechVoice }));
                play(speechVoice);
              }}
            >
              <SelectTrigger id="speech-voice" size="sm" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {speech.voices.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.name} · {v.lang === 'en-GB' ? 'British' : 'American'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : (
        feature && (
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <SettingsToken icon={AudioLines} />
              <div className="min-w-0">
                <p className="text-sm">Speech isn’t installed</p>
                <p className="text-xs text-muted-foreground">
                  Din’s voice, which reads replies aloud on this computer. {describeFeature(feature)}.
                </p>
              </div>
            </div>
            {!feature.busy && (
              <Button variant="outline" size="sm" className="shrink-0" onClick={install}>
                <Download className="size-4" aria-hidden />
                Install ({formatFeatureSize(feature.size)})
              </Button>
            )}
            {feature.busy && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
          </div>
        )
      )}
    </div>
  );
}

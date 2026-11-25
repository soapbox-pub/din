import { AppIcon } from '@/shared/AppIcon';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBitcoinLinks } from '@/hooks/useBitcoinLinks';
import { settingsGroup } from '@/shared/settingsChromeStyles';

/** The Select's value for "ask every time". */
const ASK = 'ask';

/**
 * Where bitcoin: links open: the app chosen with "Always" in Open With, or
 * asking every time when more than one app opens them (with one, it opens
 * them). `din wallet link-default` does the same.
 */
export function BitcoinLinkSettings() {
  const { handlers, defaultApp, setDefault } = useBitcoinLinks();
  const value = defaultApp?.id ?? ASK;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="px-1 text-sm font-semibold text-foreground/90">Bitcoin links</h3>
        <p className="px-1 text-xs text-muted-foreground">
          Where bitcoin: links open, to pay what they ask. Apps that open them say so in their web app manifest.
        </p>
      </div>

      <div className={settingsGroup}>
        <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-foreground">Open in</span>
            <span className="block text-xs text-muted-foreground">
              {handlers.length <= 1
                ? `${handlers[0]?.name ?? 'No app'} is the only app that opens them.`
                : defaultApp
                  ? `Every bitcoin: link opens in ${defaultApp.name}.`
                  : 'A link asks which app to use, with Just once or Always.'}
            </span>
          </span>
          {handlers.length > 1 && (
            <Select value={value} onValueChange={(id) => setDefault(id === ASK ? null : id)}>
              <SelectTrigger size="sm" className="w-44" aria-label="The app bitcoin: links open in">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ASK}>Ask every time</SelectItem>
                {handlers.map((app) => (
                  <SelectItem key={app.id} value={app.id}>
                    <AppIcon icon={app.icon} web={app.web} className="size-5 shrink-0 rounded" />
                    <span className="truncate">{app.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
    </div>
  );
}

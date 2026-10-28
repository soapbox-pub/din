import { useRef, useState } from 'react';
import { Loader2, Moon, Palette, Save, Sun, Trash2, Upload, Wallpaper } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { YourThemes } from '@/components/desktop/apps/YourThemes';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDesktopBackground } from '@/contexts/DesktopBackgroundContext';
import { useDesktopThemeEditor, type AppearanceMode } from '@/hooks/useDesktopTheme';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useToast } from '@/hooks/useToast';
import { useThemeActions, useThemeLibrary } from '@/hooks/useThemes';
import {
  isLocalBackground,
  sameThemeLook,
  type DesktopTheme,
  type ThemeFont,
} from '@/lib/profileTheme';
import { THEME_DESCRIPTION_MAX, THEME_TITLE_MAX } from '@/lib/themeDefinition';
import { CURATED_FONTS, THEME_FONT_CATEGORIES, previewFamily } from '@/lib/themeFonts';

const MODES: { value: AppearanceMode; name: string; icon: LucideIcon }[] = [
  { value: 'light', name: 'Light', icon: Sun },
  { value: 'dark', name: 'Dark', icon: Moon },
  { value: 'custom', name: 'Custom', icon: Palette },
];

const COLOR_ROLES: { role: keyof DesktopTheme['colors']; name: string }[] = [
  { role: 'background', name: 'Background' },
  { role: 'text', name: 'Text' },
  { role: 'primary', name: 'Accent' },
];

const HEX_COLOR = /^#[0-9a-f]{6}$/;

/**
 * Settings → Appearance's theme: built-in light or dark, or a custom one of
 * colors, fonts and a background picture, and whether the custom one is the
 * profile theme or this computer's own (see useDesktopThemeEditor). Below
 * them, the user's named themes (YourThemes); a custom theme can be saved
 * as one, and one of the user's own updated after editing.
 */
export function ThemeSettings() {
  const editor = useDesktopThemeEditor();
  const editorRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <p className="mb-3 text-sm text-muted-foreground">Theme</p>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Theme">
        {MODES.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={editor.mode === option.value}
            onClick={() => editor.setMode(option.value)}
            className={cn(
              'flex w-28 flex-col items-center gap-2 rounded-xl border p-4',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              editor.mode === option.value
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border/60 text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )}
          >
            <option.icon className="size-6" aria-hidden />
            <span className="text-sm">{option.name}</span>
          </button>
        ))}
      </div>

      {editor.theme && (
        <div ref={editorRef} className="scroll-mt-4">
          <CustomTheme theme={editor.theme} edit={editor.edit} />
        </div>
      )}

      {editor.canSync && (
        <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
          <div className="min-w-0">
            <Label htmlFor="sync-profile-theme" className="cursor-pointer text-sm">
              Sync with your profile theme
            </Label>
            <p className="text-xs text-muted-foreground">
              Your custom colors, fonts and background follow the theme on your Nostr profile, and
              changes here update it. Turn this off to give this computer a look of its own.
            </p>
          </div>
          <Switch
            id="sync-profile-theme"
            checked={editor.syncProfileTheme}
            onCheckedChange={editor.setSync}
          />
        </div>
      )}

      <YourThemes
        onEdit={() =>
          // The editor shows once the theme is worn, a render later.
          requestAnimationFrame(() =>
            editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
          )
        }
      />
    </>
  );
}

function CustomTheme({
  theme,
  edit,
}: {
  theme: DesktopTheme;
  edit: (theme: DesktopTheme) => void;
}) {
  const { chooseBackground } = useDesktopBackground();
  const background = theme.background;

  return (
    <div className="flex flex-col gap-4 rounded-md border bg-muted/20 p-3">
      <SaveThemeBar theme={theme} />

      <div>
        <p className="mb-2 text-sm text-foreground">Colors</p>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2">
          {COLOR_ROLES.map(({ role, name }) => (
            <ColorField
              key={role}
              name={name}
              value={theme.colors[role]}
              onChange={(color) => edit({ ...theme, colors: { ...theme.colors, [role]: color } })}
            />
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 text-sm text-foreground">Fonts</p>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-2">
          <FontField
            name="Text"
            value={theme.fonts.body}
            onChange={(font) => edit({ ...theme, fonts: { ...theme.fonts, body: font } })}
          />
          <FontField
            name="Titles"
            value={theme.fonts.title}
            onChange={(font) => edit({ ...theme, fonts: { ...theme.fonts, title: font } })}
          />
        </div>
      </div>

      <div>
        <p className="mb-2 text-sm text-foreground">Background picture</p>
        <div className="flex flex-wrap items-start gap-3">
          <div
            aria-hidden
            className="aspect-video w-40 shrink-0 overflow-hidden rounded-md border bg-cover bg-center"
            style={{
              backgroundColor: theme.colors.background,
              backgroundImage: background ? `url("${background.url}")` : undefined,
              backgroundSize: background?.mode === 'tile' ? 'auto' : 'cover',
              backgroundRepeat: background?.mode === 'tile' ? 'repeat' : 'no-repeat',
            }}
          />
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => void chooseBackground()}>
                <Wallpaper aria-hidden />
                {background ? 'Change Picture…' : 'Choose Picture…'}
              </Button>
              {background && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => edit({ ...theme, background: undefined })}
                >
                  <Trash2 aria-hidden />
                  Remove
                </Button>
              )}
            </div>
            {background && (
              <div className="flex gap-1" role="radiogroup" aria-label="Picture fit">
                {(['cover', 'tile'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={background.mode === mode}
                    onClick={() => edit({ ...theme, background: { ...background, mode } })}
                    className={cn(
                      'rounded-md border px-3 py-1 text-xs',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      background.mode === mode
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border/60 text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                    )}
                  >
                    {mode === 'cover' ? 'Fill screen' : 'Tile'}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ColorField({
  name,
  value,
  onChange,
}: {
  name: string;
  value: string;
  onChange: (color: string) => void;
}) {
  // What's typed, until it's a whole color.
  const [draft, setDraft] = useState<string | null>(null);
  const id = `theme-color-${name.toLowerCase()}`;

  return (
    <div className="flex items-center gap-2 rounded-md border bg-background/60 p-2">
      <input
        type="color"
        aria-label={`${name} color`}
        value={value}
        onChange={(e) => onChange(e.target.value.toLowerCase())}
        className="size-8 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
      />
      <div className="min-w-0 flex-1">
        <Label htmlFor={id} className="text-xs text-muted-foreground">
          {name}
        </Label>
        <Input
          id={id}
          value={draft ?? value}
          spellCheck={false}
          onChange={(e) => {
            const next = e.target.value.trim().toLowerCase();
            const color = next.startsWith('#') ? next : `#${next}`;
            if (HEX_COLOR.test(color)) {
              setDraft(null);
              onChange(color);
            } else {
              setDraft(e.target.value);
            }
          }}
          onBlur={() => setDraft(null)}
          className="h-7 px-2 font-mono text-xs"
        />
      </div>
    </div>
  );
}

const DEFAULT_FONT = 'default';

function FontField({
  name,
  value,
  onChange,
}: {
  name: string;
  value: ThemeFont | undefined;
  onChange: (font: ThemeFont | undefined) => void;
}) {
  // A font from elsewhere (one uploaded in Ditto, say) stays on offer.
  const other = value && !CURATED_FONTS.some((font) => font.url === value.url) ? value : null;

  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground">{name}</Label>
      <Select
        value={value?.url ?? DEFAULT_FONT}
        onValueChange={(url) => {
          if (url === DEFAULT_FONT) onChange(undefined);
          else if (url === other?.url) onChange(other);
          else {
            const font = CURATED_FONTS.find((f) => f.url === url);
            if (font) onChange({ family: font.family, url: font.url });
          }
        }}
      >
        <SelectTrigger aria-label={`${name} font`} className="h-8 text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="z-[10000] max-h-72">
          <SelectItem value={DEFAULT_FONT}>Default (Inter)</SelectItem>
          {other && (
            <SelectItem value={other.url}>
              <span style={{ fontFamily: `'${previewFamily(other)}'` }}>{other.family}</span>
            </SelectItem>
          )}
          {THEME_FONT_CATEGORIES.map((category) => (
            <SelectGroup key={category}>
              <SelectLabel>{category}</SelectLabel>
              {CURATED_FONTS.filter((font) => font.category === category).map((font) => (
                <SelectItem key={font.url} value={font.url}>
                  <span style={{ fontFamily: `'${previewFamily(font)}'` }}>{font.family}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Saving the custom theme worn as a named theme (kind 36767), or, when it's
 * one of the user's own that's been changed, updating that one.
 */
function SaveThemeBar({ theme }: { theme: DesktopTheme }) {
  const { user } = useCurrentUser();
  const editor = useDesktopThemeEditor();
  const library = useThemeLibrary();
  const actions = useThemeActions();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!user) return null;

  const source = theme.source;
  const editing =
    source?.pubkey === user.pubkey
      ? library.own.find((t) => t.identifier === source.identifier)
      : undefined;
  const changed = editing ? !sameThemeLook(editing.theme, theme) : false;

  const update = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      const published = await actions.publish({
        theme,
        title: editing.title,
        description: editing.description || undefined,
        identifier: editing.identifier,
      });
      editor.apply(published.theme);
      toast({ title: `${published.title} updated` });
    } catch (error) {
      toast({
        title: 'Couldn’t update the theme',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="mr-auto min-w-0 truncate text-sm text-foreground">
        {editing ? editing.title : theme.title || 'Custom theme'}
      </p>
      {editing && changed && (
        <Button type="button" size="sm" disabled={busy} onClick={() => void update()}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
          Update “{editing.title}”
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        variant={editing && changed ? 'secondary' : 'default'}
        onClick={() => setSaving(true)}
      >
        <Save aria-hidden />
        {editing ? 'Save as New Theme…' : 'Save as Theme…'}
      </Button>
      <SaveThemeDialog theme={theme} open={saving} onOpenChange={setSaving} />
    </div>
  );
}

function SaveThemeDialog({
  theme,
  open,
  onOpenChange,
}: {
  theme: DesktopTheme;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const editor = useDesktopThemeEditor();
  const actions = useThemeActions();
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const uploads = !!theme.background && isLocalBackground(theme.background.url);

  const save = async () => {
    const name = title.trim();
    if (!name) return;
    setBusy(true);
    try {
      const published = await actions.publish({
        theme,
        title: name,
        description: description.trim() || undefined,
      });
      editor.apply(published.theme);
      onOpenChange(false);
      setTitle('');
      setDescription('');
      toast({
        title: `${published.title} saved`,
        description: 'It’s in Your Themes, and others can find it in the App Store.',
      });
    } catch (error) {
      toast({
        title: 'Couldn’t save the theme',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Save as theme</DialogTitle>
            <DialogDescription>
              Your theme is published on Nostr under this name, where anyone can find it and try it
              on.
              {uploads &&
                ' Its background picture is on this computer, so it will be uploaded to your Blossom servers first.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="theme-title">Name</Label>
              <Input
                id="theme-title"
                value={title}
                maxLength={THEME_TITLE_MAX}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="theme-description">Description (optional)</Label>
              <Textarea
                id="theme-description"
                value={description}
                maxLength={THEME_DESCRIPTION_MAX}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !title.trim()}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AppConfigSchema } from '@/lib/appConfigSchema';
import type { AppConfig } from '@/contexts/AppContext';
import { AREAS, SECTION_AREAS, runCommandLine, runStructured } from './index';
import { CONFIG_FIELDS_ELSEWHERE, SETTING_FIELDS } from './settings';
import type { CommandContext } from './types';

function context(config: Partial<AppConfig> = {}): CommandContext & { config: AppConfig } {
  const ctx = {
    config: { tilingGap: 8, dockSize: 64, theme: 'light', ...config } as AppConfig,
    updateConfig: vi.fn((updater: (current: Partial<AppConfig>) => Partial<AppConfig>) => {
      ctx.config = updater(ctx.config) as AppConfig;
    }),
    windows: [],
    actions: {} as CommandContext['actions'],
    apps: {} as CommandContext['apps'],
    widgets: {} as CommandContext['widgets'],
    workspaces: {},
    monitors: [],
    pubkey: undefined,
    publish: vi.fn(),
    openUrl: vi.fn(),
    confirm: vi.fn(async () => false),
    cwd: '/home/din',
  };
  return ctx;
}

describe('the din command covers Din', () => {
  it('has an area, or a reason, for every Settings section', () => {
    const source = readFileSync('src/lib/settingsSections.ts', 'utf8');
    const union = /type SectionId =([^;]+);/.exec(source)?.[1] ?? '';
    const sections = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    expect(sections.length).toBeGreaterThan(10);
    for (const section of sections) {
      const area = SECTION_AREAS[section];
      expect(area, `Settings → ${section} has no din command area`).toBeDefined();
      if (typeof area === 'string') expect(AREAS.some((a) => a.name === area), `no area ${area}`).toBe(true);
    }
  });

  it('has a setting, or a reason, for every AppConfig field', () => {
    for (const field of Object.keys(AppConfigSchema.shape)) {
      const covered = SETTING_FIELDS.includes(field as keyof AppConfig) || field in CONFIG_FIELDS_ELSEWHERE;
      expect(covered, `AppConfig.${field} isn't a din setting`).toBe(true);
    }
  });

  it('names each command once, with unique params', () => {
    const paths = AREAS.flatMap((area) => area.commands.map((c) => c.path.join(' ')));
    expect(new Set(paths).size).toBe(paths.length);
    for (const area of AREAS) {
      expect(area.commands.filter((c) => c.bare).length).toBeLessThanOrEqual(1);
      for (const command of area.commands) {
        expect(command.path[0]).toBe(area.name);
        const names = command.params.map((p) => p.name);
        expect(new Set(names).size).toBe(names.length);
      }
    }
  });
});

describe('runCommandLine', () => {
  it('sets and reads a setting', async () => {
    const ctx = context();
    expect(await runCommandLine(['settings', 'set', 'dock.size', '80'], ctx)).toMatchObject({ ok: true, data: 80 });
    expect(ctx.config.dockSize).toBe(80);
    expect(await runCommandLine(['settings', 'get', 'windows.tiling'], context({ tilingEnabled: true }))).toMatchObject({ ok: true, text: 'on' });
    expect(await runCommandLine(['settings', 'set', 'windows.tiling', 'off'], ctx)).toMatchObject({ ok: true });
    expect(ctx.config.tilingEnabled).toBe(false);
  });

  it('turns away values a setting doesn’t take', async () => {
    const ctx = context();
    expect(await runCommandLine(['settings', 'set', 'dock.size', '9000'], ctx)).toMatchObject({ ok: false, usage: true });
    expect(await runCommandLine(['settings', 'set', 'appearance.theme', 'purple'], ctx)).toMatchObject({ ok: false, usage: true });
    expect(await runCommandLine(['settings', 'set', 'no.such', '1'], ctx)).toMatchObject({ ok: false, usage: true });
    expect(ctx.updateConfig).not.toHaveBeenCalled();
  });

  it('gives help, and usage errors for what it doesn’t know', async () => {
    const ctx = context();
    expect(await runCommandLine([], ctx)).toMatchObject({ ok: true });
    expect(await runCommandLine(['help', 'wifi'], ctx)).toMatchObject({ ok: true });
    expect(await runCommandLine(['wifi'], ctx)).toMatchObject({ ok: true });
    expect(await runCommandLine(['wifi', 'connect', '--help'], ctx)).toMatchObject({ ok: true });
    expect(await runCommandLine(['nope'], ctx)).toMatchObject({ ok: false, usage: true });
    expect(await runCommandLine(['wifi', 'nope'], ctx)).toMatchObject({ ok: false, usage: true });
    expect(await runCommandLine(['wifi', 'connect'], ctx)).toMatchObject({ ok: false, usage: true });
    expect(await runCommandLine(['wifi', 'connect', 'Home', '--nope'], ctx)).toMatchObject({ ok: false, usage: true });
  });

  it('runs an area’s own command bare', async () => {
    const ctx = context();
    expect(await runCommandLine(['open', 'https://example.com'], ctx)).toMatchObject({ ok: true });
    expect(ctx.openUrl).toHaveBeenCalledWith('https://example.com');
  });

  it('says a system part is missing rather than throwing', async () => {
    expect(await runCommandLine(['wifi', 'status'], context())).toMatchObject({ ok: false, usage: false, error: 'Wi-Fi isn’t available here' });
  });

  it('asks before restarting, and stops if told no', async () => {
    const ctx = context();
    const reboot = vi.fn();
    window.dinos = { ...window.dinos, power: { reboot } as unknown as NonNullable<Dinos['power']> } as Dinos;
    expect(await runCommandLine(['power', 'restart'], ctx)).toMatchObject({ ok: false });
    expect(ctx.confirm).toHaveBeenCalled();
    expect(reboot).not.toHaveBeenCalled();
  });
});

describe('runStructured', () => {
  it('checks structured arguments as the command line’s', async () => {
    const ctx = context();
    expect(await runStructured(['settings', 'set'], { key: 'dock.size', value: 100 }, ctx)).toMatchObject({ ok: true });
    expect(ctx.config.dockSize).toBe(100);
    expect(await runStructured(['settings', 'set'], { key: 'dock.size', value: 100, extra: 1 }, ctx)).toMatchObject({ ok: false, usage: true });
  });
});

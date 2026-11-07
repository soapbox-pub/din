// The game systems the Games app knows (electron/games.mts): the folders of
// ~/roms they're in, as RetroArch, EmulationStation and Batocera name them,
// what runs their games, and how each is set up to play well with nothing
// for the user to configure.
//
// Every core is in DinOS's Games feature (os/configuration.nix), one part
// each, all of them free software in the NixOS binary cache, so installing
// it only downloads. Where nixpkgs has two, the one picked plays the most
// games correctly at full speed on an ordinary laptop: Mesen and bsnes for
// Nintendo's 8 and 16-bit consoles, SameBoy and mGBA for its handhelds,
// Mupen64Plus-Next drawing with paraLLEl-RDP at twice the N64's resolution,
// melonDS DS with its two screens side by side, Flycast for the Dreamcast,
// which needs no BIOS, PCSX-ReARMed for the PlayStation, whose own BIOS
// stands in when there's none. Game Gear and Master System are SMS Plus GX
// and the Mega Drive BlastEm: Genesis Plus GX and PicoDrive aren't free,
// so they'd have to be built on the computer.
//
// Systems whose emulators aren't libretro cores (GameCube and Wii, 3DS,
// PS2, Switch) are listed, so their games show up, but can't be played yet.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

export interface SystemDef {
  id: string;
  /** Other folder names it goes by. */
  aliases?: string[];
  name: string;
  maker: string;
  year: number;
  /** Its folder in libretro-thumbnails, for box art. */
  thumbnails: string | null;
  /** File extensions its games come as, lowercase, without the dot. */
  extensions: string[];
  /** The libretro core that plays it (its file, without _libretro.so), or null when nothing does yet. */
  core: string | null;
  /**
   * Whether a game in a .zip or .7z goes to RetroArch as it is (which unpacks
   * it for a core that can't read one), or Din unpacks it first: a disc image
   * zipped, which a core that reads arcade zips (Flycast) would misread.
   */
  archives: boolean;
  /** Pixel art: scaled sharp (sharp-bilinear), never blurred or unevenly. */
  pixelArt: boolean;
  /** A BIOS it needs, from a "[BIOS] …" zip in its folder or from ~/roms/bios, as the core looks for it in the system folder. */
  bios?: { file: string; match: RegExp; required: boolean };
}

const ARCHIVES = ['zip', '7z'];

export const SYSTEMS: SystemDef[] = [
  { id: 'nes', aliases: ['famicom'], name: 'NES', maker: 'Nintendo', year: 1983, thumbnails: 'Nintendo - Nintendo Entertainment System', extensions: ['nes', 'unf', 'unif', ...ARCHIVES], core: 'mesen', archives: true, pixelArt: true },
  {
    id: 'fds', name: 'Famicom Disk System', maker: 'Nintendo', year: 1986, thumbnails: 'Nintendo - Family Computer Disk System', extensions: ['fds', ...ARCHIVES], core: 'mesen', archives: true, pixelArt: true,
    bios: { file: 'disksys.rom', match: /disk system/i, required: true },
  },
  { id: 'snes', aliases: ['sfc', 'superfamicom'], name: 'Super Nintendo', maker: 'Nintendo', year: 1990, thumbnails: 'Nintendo - Super Nintendo Entertainment System', extensions: ['sfc', 'smc', 'fig', 'swc', 'bs', ...ARCHIVES], core: 'bsnes', archives: true, pixelArt: true },
  { id: 'virtualboy', aliases: ['vb'], name: 'Virtual Boy', maker: 'Nintendo', year: 1995, thumbnails: 'Nintendo - Virtual Boy', extensions: ['vb', 'vboy', ...ARCHIVES], core: 'mednafen_vb', archives: true, pixelArt: true },
  { id: 'n64', name: 'Nintendo 64', maker: 'Nintendo', year: 1996, thumbnails: 'Nintendo - Nintendo 64', extensions: ['n64', 'z64', 'v64', ...ARCHIVES], core: 'mupen64plus_next', archives: true, pixelArt: false },
  { id: 'gb', name: 'Game Boy', maker: 'Nintendo', year: 1989, thumbnails: 'Nintendo - Game Boy', extensions: ['gb', ...ARCHIVES], core: 'sameboy', archives: true, pixelArt: true },
  { id: 'gbc', name: 'Game Boy Color', maker: 'Nintendo', year: 1998, thumbnails: 'Nintendo - Game Boy Color', extensions: ['gbc', 'gb', ...ARCHIVES], core: 'sameboy', archives: true, pixelArt: true },
  { id: 'gba', name: 'Game Boy Advance', maker: 'Nintendo', year: 2001, thumbnails: 'Nintendo - Game Boy Advance', extensions: ['gba', ...ARCHIVES], core: 'mgba', archives: true, pixelArt: true },
  { id: 'gamecube', aliases: ['gc', 'ngc'], name: 'GameCube', maker: 'Nintendo', year: 2001, thumbnails: 'Nintendo - GameCube', extensions: ['rvz', 'iso', 'gcm', 'gcz', 'ciso', 'wbfs', 'dol'], core: null, archives: false, pixelArt: false },
  { id: 'nds', name: 'Nintendo DS', maker: 'Nintendo', year: 2004, thumbnails: 'Nintendo - Nintendo DS', extensions: ['nds', ...ARCHIVES], core: 'melondsds', archives: true, pixelArt: false },
  { id: 'wii', name: 'Wii', maker: 'Nintendo', year: 2006, thumbnails: 'Nintendo - Wii', extensions: ['rvz', 'iso', 'wbfs', 'wad', 'gcz', 'ciso'], core: null, archives: false, pixelArt: false },
  { id: '3ds', aliases: ['n3ds'], name: 'Nintendo 3DS', maker: 'Nintendo', year: 2011, thumbnails: 'Nintendo - Nintendo 3DS', extensions: ['3ds', 'cci', 'cxi', 'cia', '3dsx', 'app'], core: null, archives: false, pixelArt: false },
  { id: 'switch', name: 'Nintendo Switch', maker: 'Nintendo', year: 2017, thumbnails: null, extensions: ['nsp', 'nsz', 'xci', 'xcz'], core: null, archives: false, pixelArt: false },
  { id: 'mastersystem', aliases: ['sms'], name: 'Master System', maker: 'Sega', year: 1986, thumbnails: 'Sega - Master System - Mark III', extensions: ['sms', ...ARCHIVES], core: 'smsplus', archives: true, pixelArt: true },
  { id: 'genesis', aliases: ['megadrive', 'md'], name: 'Genesis', maker: 'Sega', year: 1988, thumbnails: 'Sega - Mega Drive - Genesis', extensions: ['md', 'gen', 'smd', 'bin', ...ARCHIVES], core: 'blastem', archives: true, pixelArt: true },
  { id: 'gamegear', aliases: ['gg'], name: 'Game Gear', maker: 'Sega', year: 1990, thumbnails: 'Sega - Game Gear', extensions: ['gg', ...ARCHIVES], core: 'smsplus', archives: true, pixelArt: true },
  { id: 'dreamcast', aliases: ['dc'], name: 'Dreamcast', maker: 'Sega', year: 1998, thumbnails: 'Sega - Dreamcast', extensions: ['chd', 'cdi', 'gdi', 'cue', 'm3u', 'zip'], core: 'flycast', archives: false, pixelArt: false },
  { id: 'psx', aliases: ['ps1', 'playstation'], name: 'PlayStation', maker: 'Sony', year: 1994, thumbnails: 'Sony - PlayStation', extensions: ['chd', 'cue', 'pbp', 'm3u', 'ccd', 'iso', 'zip'], core: 'pcsx_rearmed', archives: false, pixelArt: true },
  { id: 'ps2', name: 'PlayStation 2', maker: 'Sony', year: 2000, thumbnails: 'Sony - PlayStation 2', extensions: ['chd', 'iso', 'cso', 'cue', 'gz'], core: null, archives: false, pixelArt: false },
  { id: 'pcengine', aliases: ['pce', 'tg16', 'turbografx16'], name: 'TurboGrafx-16', maker: 'NEC', year: 1987, thumbnails: 'NEC - PC Engine - TurboGrafx 16', extensions: ['pce', ...ARCHIVES], core: 'mednafen_pce_fast', archives: true, pixelArt: true },
  { id: 'ngp', name: 'Neo Geo Pocket', maker: 'SNK', year: 1998, thumbnails: 'SNK - Neo Geo Pocket', extensions: ['ngp', ...ARCHIVES], core: 'mednafen_ngp', archives: true, pixelArt: true },
  { id: 'ngpc', name: 'Neo Geo Pocket Color', maker: 'SNK', year: 1999, thumbnails: 'SNK - Neo Geo Pocket Color', extensions: ['ngc', 'ngpc', ...ARCHIVES], core: 'mednafen_ngp', archives: true, pixelArt: true },
  { id: 'wonderswan', aliases: ['ws'], name: 'WonderSwan', maker: 'Bandai', year: 1999, thumbnails: 'Bandai - WonderSwan', extensions: ['ws', ...ARCHIVES], core: 'mednafen_wswan', archives: true, pixelArt: true },
  { id: 'wonderswancolor', aliases: ['wsc'], name: 'WonderSwan Color', maker: 'Bandai', year: 2000, thumbnails: 'Bandai - WonderSwan Color', extensions: ['wsc', ...ARCHIVES], core: 'mednafen_wswan', archives: true, pixelArt: true },
  { id: 'atari2600', name: 'Atari 2600', maker: 'Atari', year: 1977, thumbnails: 'Atari - 2600', extensions: ['a26', 'bin', ...ARCHIVES], core: 'stella', archives: true, pixelArt: true },
  { id: 'atari7800', name: 'Atari 7800', maker: 'Atari', year: 1986, thumbnails: 'Atari - 7800', extensions: ['a78', 'bin', ...ARCHIVES], core: 'prosystem', archives: true, pixelArt: true },
];

const byFolder = new Map<string, SystemDef>();
for (const system of SYSTEMS) {
  byFolder.set(system.id, system);
  for (const alias of system.aliases ?? []) byFolder.set(alias, system);
}

/** The system a folder of ~/roms holds, by its name, or null. */
export function systemForFolder(name: string): SystemDef | null {
  return byFolder.get(name.toLowerCase()) ?? null;
}

export function systemById(id: string): SystemDef | null {
  return SYSTEMS.find((s) => s.id === id) ?? null;
}

/**
 * Core options a system plays best with, set where the user hasn't set them
 * (RetroArch keeps them all in one file; what they change in its menu stays).
 */
export const CORE_OPTIONS: Record<string, string> = {
  // Accurate, on the GPU through Vulkan, at twice the N64's resolution.
  'mupen64plus-rdp-plugin': 'parallel',
  'mupen64plus-rsp-plugin': 'parallel',
  'mupen64plus-parallel-rdp-upscaling': '2x',
  // A DS's two screens side by side fill a wide screen best; L3/R3 (or the
  // menu) switch to stacked, or one big and one small.
  'melonds_number_of_screen_layouts': '3',
  'melonds_screen_layout1': 'left-right',
  'melonds_screen_layout2': 'top-bottom',
  'melonds_screen_layout3': 'hybrid-top',
  // The Dreamcast drawn at twice its resolution.
  'reicast_internal_resolution': '1280x960',
};

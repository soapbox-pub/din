import type { ReactNode } from 'react';
import { Box, Terminal } from 'lucide-react';
import { AppleGlyph, FedoraGlyph, UbuntuGlyph, WindowsGlyph } from './glyphs';
import type { VmInstallerId, VmOs } from '@/lib/vms';

/** The systems Din installs by itself, in the order its gallery shows them. */
export const SYSTEMS: { id: VmInstallerId; name: string; maker: string }[] = [
  { id: 'windows', name: 'Windows 11', maker: 'Microsoft' },
  { id: 'macos', name: 'macOS', maker: 'Apple' },
  { id: 'ubuntu', name: 'Ubuntu', maker: 'Canonical' },
  { id: 'fedora', name: 'Fedora', maker: 'The Fedora Project' },
];

type Glyph = (p: { className?: string }) => ReactNode;

export const OS_STYLE: Record<VmOs, { icon: Glyph; className: string }> = {
  windows: { icon: WindowsGlyph, className: 'bg-gradient-to-b from-sky-500 to-blue-600' },
  linux: { icon: Terminal, className: 'bg-gradient-to-b from-amber-500 to-orange-600' },
  other: { icon: Box, className: 'bg-gradient-to-b from-zinc-400 to-zinc-600' },
};

/** The systems Din installs by itself, in their own colours. */
export const SYSTEM_STYLE: Record<VmInstallerId, { icon: Glyph; className: string }> = {
  windows: OS_STYLE.windows,
  macos: { icon: AppleGlyph, className: 'bg-gradient-to-b from-zinc-600 to-zinc-900' },
  ubuntu: { icon: UbuntuGlyph, className: 'bg-gradient-to-b from-orange-500 to-[#c34113]' },
  fedora: { icon: FedoraGlyph, className: 'bg-gradient-to-b from-[#3c6eb4] to-[#294172]' },
};

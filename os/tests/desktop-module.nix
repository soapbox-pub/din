# The desktop module (desktop-module.nix) evaluated on a plain NixOS: off,
# it adds nothing; on, Din is on the login screen and none of DinOS comes
# along; with enableSystemServices off, the system's services are its own.
# Builds the session package itself, not a machine.
{ pkgs, nixpkgs, module }:

let
  make = extra: (nixpkgs.lib.nixosSystem {
    system = pkgs.stdenv.hostPlatform.system;
    modules = [ module { system.stateVersion = "26.05"; fileSystems."/" = { device = "none"; fsType = "tmpfs"; }; boot.loader.grub.enable = false; } extra ];
  }).config;
  off = make { };
  on = make { services.desktopManager.din.enable = true; };
  bare = make { services.desktopManager.din = { enable = true; enableSystemServices = false; }; };
  package = on.services.desktopManager.din.package;
in
assert off.services.displayManager.sessionPackages == [ ];
assert on.services.displayManager.sessionPackages == [ package ];
assert package.providedSessions == [ "din" ];
assert !(on.users.users ? din);
assert !(on.systemd.services ? din-shell);
assert !(on.systemd.services ? din-update);
assert on.networking.networkmanager.enable;
assert !bare.networking.networkmanager.enable;
assert !bare.services.pipewire.enable;
pkgs.runCommand "din-desktop-module" { } ''
  test -x ${package}/bin/din-session
  test -x ${package}/bin/din
  grep -qx 'Exec=${package}/bin/din-session' ${package}/share/wayland-sessions/din.desktop
  touch $out
''

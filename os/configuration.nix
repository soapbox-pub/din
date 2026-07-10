{ config, pkgs, lib, ... }:

let
  # The Electron shell app, copied into the Nix store.
  shell-src = pkgs.runCommand "webos-shell-src" { } ''
    mkdir -p $out/share/webos-shell
    cp -r ${../shell}/. $out/share/webos-shell/
  '';

  # Launcher: Electron running the shell app on Wayland (cage provides the compositor).
  # --disable-gpu keeps the demo reliable in QEMU without virgl; remove it on real
  # hardware (and verify acceleration!).
  webos-shell = pkgs.writeShellScriptBin "webos-shell" ''
    exec ${pkgs.electron}/bin/electron \
      ${shell-src}/share/webos-shell \
      --ozone-platform=wayland \
      --disable-gpu
  '';
in
{
  networking.hostName = "webos";

  # Unprivileged user the shell runs as.
  users.users.web = {
    isNormalUser = true;
    description = "webOS shell user";
  };

  # cage: a Wayland compositor that runs exactly one fullscreen application.
  # This is the entire graphical stack - no X11, no display manager, no desktop.
  services.cage = {
    enable = true;
    user = "web";
    program = "${webos-shell}/bin/webos-shell";
  };

  # Serial console so `make run` shows boot logs in the terminal too.
  boot.kernelParams = [ "console=ttyS0" ];

  # Keep the image lean-ish.
  documentation.enable = false;
  environment.defaultPackages = [ ];

  # VM settings (only apply to the `nix build .#vm` variant).
  virtualisation.vmVariant = {
    virtualisation = {
      memorySize = 4096;
      cores = 4;
      graphics = true;
    };
  };

  system.stateVersion = "26.05";
}

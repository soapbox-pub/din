{ config, pkgs, lib, ... }:

let
  # Build the Vite/React shell from source (deps fetched via lockfile hash).
  shell-app = pkgs.buildNpmPackage {
    pname = "webos-shell";
    version = "0.1.0";
    src = ../shell;
    npmDepsHash = "sha256-zWr+6R6uWZD9hmnszjS7tfLPQJeK30R1A3ids9pH3GE=";

    # The package.json scripts run `npm i` (network); run vite directly instead.
    buildPhase = ''
      runHook preBuild
      npm exec -- vite build -l error
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out/share/webos-shell
      cp -r dist $out/share/webos-shell/dist
      install -m444 electron/main.cjs $out/share/webos-shell/main.cjs
      install -m444 electron/preload.cjs $out/share/webos-shell/preload.cjs
      install -m555 electron/pty-host.py $out/share/webos-shell/pty-host.py
      runHook postInstall
    '';
  };

  # Launcher: Electron running the shell host on Wayland (cage provides the
  # compositor). --disable-gpu keeps the demo reliable in QEMU without virgl;
  # remove it on real hardware (and verify acceleration!).
  # --enable-unsafe-swiftshader: with the GPU disabled, Chromium >=137 refuses
  # to create even software WebGL contexts without this flag. The Terminal app
  # needs WebGL for crisp box-drawing glyphs ("unsafe" = SwiftShader is not
  # security-maintained against untrusted WebGL content; acceptable for this
  # demo, revisit if the <webview> browser faces hostile sites in earnest).
  # python3 must be on PATH for the Terminal app's pty host (pty-host.py).
  webos-shell = pkgs.writeShellScriptBin "webos-shell" ''
    export PATH=${pkgs.python3}/bin:$PATH
    exec ${pkgs.electron}/bin/electron \
      ${shell-app}/share/webos-shell/main.cjs \
      --ozone-platform=wayland \
      --disable-gpu \
      --enable-unsafe-swiftshader
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

  # Emoji and broad Unicode coverage for web content.
  fonts.packages = with pkgs; [
    noto-fonts
    noto-fonts-color-emoji
  ];

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

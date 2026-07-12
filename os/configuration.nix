{ config, pkgs, lib, din, ... }:

let
  # The Din source tree (the repo root, via the flake's `din` input),
  # narrowed to just what the Vite/Electron build needs. The whitelist
  # keeps node_modules, dist, os/, VM disks, etc. out of the store.
  # `/. + toString din` normalizes the path (the input arrives as
  # `<flake>/os/..`, which would defeat the prefix match below). The
  # string context must be dropped for the append; cleanSourceWith
  # re-imports the tree, so no store reference is lost.
  din-root = /. + builtins.unsafeDiscardStringContext (toString din);
  din-src = lib.cleanSourceWith {
    name = "din-source";
    src = din-root;
    filter = path: _type:
      let
        rel = lib.removePrefix (toString din-root + "/") (toString path);
        top = builtins.head (lib.splitString "/" rel);
      in
      builtins.elem top [
        "package.json"
        "package-lock.json"
        "index.html"
        "vite.config.ts"
        "tsconfig.json"
        "components.json"
        "public"
        "src"
        "electron"
      ];
  };

  # Build the Vite/React desktop environment from source (deps fetched via
  # lockfile hash).
  din-app = pkgs.buildNpmPackage {
    pname = "din";
    version = "0.1.0";
    src = din-src;
    npmDepsHash = "sha256-W2/xr9qmsII6t/m6uNzg2sntGyuc9ylFROzz+As0GDw=";

    # The electron npm package (used by `npm run dev` on dev machines) tries
    # to download its binary in a postinstall hook; the VM uses nixpkgs
    # Electron instead, and there's no network in the build sandbox anyway.
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

    # The package.json scripts run `npm i` (network); run vite directly instead.
    buildPhase = ''
      runHook preBuild
      npm exec -- vite build -l error
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out/share/din
      cp -r dist $out/share/din/dist
      install -m444 electron/main.cjs $out/share/din/main.cjs
      install -m444 electron/preload.cjs $out/share/din/preload.cjs
      install -m555 electron/pty-host.py $out/share/din/pty-host.py

      # Runtime node modules for main.cjs's Chrome extension support
      # (electron-chrome-extensions + electron-chrome-web-store and their
      # transitive runtime deps). Resolved relative to main.cjs, so they
      # live in a node_modules directory beside it.
      mkdir -p $out/share/din/node_modules
      for dep in electron-chrome-extensions electron-chrome-web-store electron-chrome-context-menu debug ms adm-zip; do
        cp -r node_modules/$dep $out/share/din/node_modules/
      done
      runHook postInstall
    '';
  };

  # Launcher: Electron running the Din host on Wayland (cage provides the
  # compositor). --disable-gpu keeps the demo reliable in QEMU without virgl;
  # remove it on real hardware (and verify acceleration!).
  # --enable-unsafe-swiftshader: with the GPU disabled, Chromium >=137 refuses
  # to create even software WebGL contexts without this flag. The Terminal app
  # needs WebGL for crisp box-drawing glyphs ("unsafe" = SwiftShader is not
  # security-maintained against untrusted WebGL content; acceptable for this
  # demo, revisit if the <webview> browser faces hostile sites in earnest).
  # python3 must be on PATH for the Terminal app's pty host (pty-host.py),
  # and nmcli for the Settings app's WiFi bridge.
  din-launcher = pkgs.writeShellScriptBin "din" ''
    export PATH=${pkgs.python3}/bin:${pkgs.networkmanager}/bin:$PATH
    exec ${pkgs.electron}/bin/electron \
      ${din-app}/share/din/main.cjs \
      --ozone-platform=wayland \
      --disable-gpu \
      --enable-unsafe-swiftshader
  '';
in
{
  networking.hostName = "aladdin";

  # NetworkManager backs Din's WiFi settings panel (nmcli via the
  # Electron wifi bridge). Physical adapters (wired and wireless) are
  # picked up by NetworkManager automatically.
  networking.networkmanager.enable = true;

  # Unprivileged user Din runs as. `networkmanager` group membership
  # lets the WiFi settings panel control connections without polkit prompts.
  users.users.web = {
    isNormalUser = true;
    description = "Din desktop user";
    extraGroups = [ "networkmanager" ];
  };

  # cage: a Wayland compositor that runs exactly one fullscreen application.
  # This is the entire graphical stack - no X11, no display manager, no desktop.
  services.cage = {
    enable = true;
    user = "web";
    program = "${din-launcher}/bin/din";
  };

  # Emoji and broad Unicode coverage for web content.
  fonts.packages = with pkgs; [
    noto-fonts
    noto-fonts-color-emoji
  ];

  # Serial console so `npm run os:run` shows boot logs in the terminal too.
  boot.kernelParams = [ "console=ttyS0" ];

  # Keep the image lean-ish.
  documentation.enable = false;
  environment.defaultPackages = [ ];

  # VM settings (only apply to the `nix build ./os#vm` variant).
  virtualisation.vmVariant = {
    virtualisation = {
      memorySize = 4096;
      cores = 4;
      graphics = true;
    };
  };

  system.stateVersion = "26.05";
}

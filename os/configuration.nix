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
    npmDepsHash = "sha256-vFD0I+1EAx+/8U5LKVjZY7QhTmEUvfte51sg7lnqVJQ=";

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
  # Electron wifi bridge). Wired/QEMU networking keeps working through NM's
  # own DHCP handling.
  networking.networkmanager.enable = true;

  # ---------------------------------------------------------------------
  # Simulated WiFi (QEMU has no wireless hardware).
  #
  # mac80211_hwsim creates two virtual radios that share a simulated air:
  #   - wlan0: claimed by hostapd below to broadcast a WPA2 network
  #   - wlan1: left to NetworkManager - this is the adapter the Settings
  #     app scans/connects with
  # Remove this whole block on real hardware; a physical adapter will be
  # picked up by NetworkManager automatically.
  # ---------------------------------------------------------------------
  boot.kernelModules = [ "mac80211_hwsim" ];
  boot.extraModprobeConfig = ''
    options mac80211_hwsim radios=2
  '';

  # The AP-side radio belongs to hostapd, not NetworkManager.
  networking.networkmanager.unmanaged = [ "wlan0" ];

  services.hostapd = {
    enable = true;
    radios.wlan0 = {
      band = "2g";
      channel = 6;
      countryCode = "US";
      networks.wlan0 = {
        ssid = "Aladdin Demo";
        authentication = {
          mode = "wpa2-sha256";
          # Demo credential, shown in the README; fine to hardcode here.
          wpaPassword = "demopassword";
        };
      };
    };
  };

  # DHCP on the simulated AP so joining it yields an address (otherwise
  # NetworkManager would time out during activation). DNS is disabled
  # (port = 0); this dnsmasq only serves leases on wlan0.
  networking.interfaces.wlan0.ipv4.addresses = [
    { address = "192.168.42.1"; prefixLength = 24; }
  ];
  services.dnsmasq = {
    enable = true;
    resolveLocalQueries = false;
    settings = {
      port = 0;
      interface = "wlan0";
      bind-interfaces = true;
      dhcp-range = "192.168.42.10,192.168.42.100,12h";
    };
  };

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

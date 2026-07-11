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
  # python3 must be on PATH for the Terminal app's pty host (pty-host.py),
  # and nmcli for the Settings app's WiFi bridge.
  webos-shell = pkgs.writeShellScriptBin "webos-shell" ''
    export PATH=${pkgs.python3}/bin:${pkgs.networkmanager}/bin:$PATH
    exec ${pkgs.electron}/bin/electron \
      ${shell-app}/share/webos-shell/main.cjs \
      --ozone-platform=wayland \
      --disable-gpu \
      --enable-unsafe-swiftshader
  '';
in
{
  networking.hostName = "webos";

  # NetworkManager backs the shell's WiFi settings panel (nmcli via the
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
        ssid = "webOS Demo";
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

  # Unprivileged user the shell runs as. `networkmanager` group membership
  # lets the WiFi settings panel control connections without polkit prompts.
  users.users.web = {
    isNormalUser = true;
    description = "webOS shell user";
    extraGroups = [ "networkmanager" ];
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

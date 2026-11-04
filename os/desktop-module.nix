# Din as a desktop on any NixOS system, beside the ones already there:
#
#   services.desktopManager.din.enable = true;
#
# from os/flake.nix's nixosModules.din. It puts "Din" on the login screen,
# as scripts/session.mjs does on other Linuxes: Din's compositor on the
# screen, through the seat the display manager gives it, running Din. None
# of DinOS's own machinery comes along (its users, boot, updater, Installer,
# lock screen, optional features); the system stays the owner's. Built from
# the same derivations as DinOS (packages.nix), with the system's own nixpkgs.
#
# Based on hzrd149's NixOS desktop module.
{ din }:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.desktopManager.din;

  dinPackages = import ./packages.nix { inherit pkgs lib din; inherit (cfg) electron; };
  inherit (dinPackages) din-app din-compositor din-fd electron-hardened din-polkit-agent;

  # What Din runs, as on DinOS (configuration.nix's makeDinLauncher, which
  # says what each is for), less what's DinOS's alone.
  tools = with pkgs; [
    python3 networkmanager brightnessctl gammastep wireplumber pipewire
    pulseaudio wlr-randr xwayland xvfb setxkbmap glib.bin libarchive _7zz unar
    bubblewrap gzip xz bzip2 zstd poppler-utils jmtpfs ifuse libimobiledevice
  ] ++ lib.optional config.services.printing.enable config.services.printing.package;

  # Electron running Din's host, on the compositor.
  launcher = pkgs.writeShellScript "din-desktop" ''
    export PATH=${lib.makeBinPath tools}:/run/wrappers/bin:$PATH
    export XKB_CONFIG_ROOT=${pkgs.xkeyboard_config}/share/X11/xkb
    export DIN_COMPOSITOR=${din-compositor}/bin/din-compositor
    export DIN_FD_ADDON=${din-fd}/lib/libdin_fd.so
    export DIN_ASKPASS_SCRIPT=${./din-askpass.py}
    export DIN_POLKIT_AGENT=${din-polkit-agent}/bin/din-polkit-agent
    # Chromium dlopens libva for hardware video decoding, which Electron's
    # wrapper leaves off the library path.
    export LD_LIBRARY_PATH=${pkgs.libva-minimal.out}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
    # ANGLE on Vulkan on AMD GPUs, as on DinOS (makeDinLauncher says why).
    gpuFlags=()
    if [ "''${DIN_ANGLE_GL:-0}" != 1 ] && ${pkgs.gnugrep}/bin/grep -qx 0x1002 /sys/class/drm/card*/device/vendor 2>/dev/null; then
      gpuFlags=(--use-angle=vulkan)
    fi
    # Without the ambient CAP_WAKE_ALARM pam_systemd gives a seat's session
    # (makeDinLauncher again).
    exec ${pkgs.util-linux}/bin/setpriv --inh-caps=-all --ambient-caps=-all \
      ${electron-hardened}/bin/electron ${din-app}/share/din/main.mjs \
      --ozone-platform=wayland "''${gpuFlags[@]}" ${lib.escapeShellArgs cfg.extraElectronFlags}
  '';

  # The session the login screen starts: the compositor, running Din.
  session = pkgs.writeShellScript "din-session" ''
    export XDG_CURRENT_DESKTOP=Din XDG_SESSION_DESKTOP=din DESKTOP_SESSION=din
    export XDG_SESSION_TYPE=wayland
    # Din is the whole desktop (electron/native-display.mts,
    # desktop-settings.mts), and another Linux's login session, which it
    # logs out of (electron/login-session.mts).
    export DIN_DESKTOP_SESSION=1 DIN_LOGIN_SESSION=1
    # The keyboard layout the system is set to, until Din's Settings sets one.
    export XKB_DEFAULT_LAYOUT=${lib.escapeShellArg config.services.xserver.xkb.layout}
    export XKB_DEFAULT_MODEL=${lib.escapeShellArg config.services.xserver.xkb.model}
    export XKB_DEFAULT_VARIANT=${lib.escapeShellArg config.services.xserver.xkb.variant}
    export XKB_DEFAULT_OPTIONS=${lib.escapeShellArg config.services.xserver.xkb.options}
    # The user's services (the portals) are told which desktop this is, so
    # they pick Din's file chooser (xdg.portal below).
    ${pkgs.dbus}/bin/dbus-update-activation-environment --systemd XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP XDG_SESSION_TYPE
    # The pointer the compositor draws before Din sets its own, from GSettings.
    theme=$(${pkgs.dconf}/bin/dconf read /org/gnome/desktop/interface/cursor-theme 2>/dev/null || true)
    theme=''${theme#\'}
    theme=''${theme%\'}
    size=$(${pkgs.dconf}/bin/dconf read /org/gnome/desktop/interface/cursor-size 2>/dev/null || true)
    size=''${size##* }
    if [ -n "$theme" ]; then export XCURSOR_THEME="$theme"; fi
    case "$size" in ""|*[!0-9]*) ;; *) export XCURSOR_SIZE="$size" ;; esac
    exec ${din-compositor}/bin/din-compositor session -- ${launcher}
  '';

  package = pkgs.runCommand "din-desktop" {
    passthru.providedSessions = [ "din" ];
    meta.mainProgram = "din-session";
  } ''
    mkdir -p $out/bin $out/share/wayland-sessions
    ln -s ${session} $out/bin/din-session
    # The din command (docs/din-command.md), as on DinOS.
    cat > $out/bin/din <<EOF
    #!${pkgs.runtimeShell}
    ELECTRON_RUN_AS_NODE=1 exec ${electron-hardened}/libexec/electron/electron ${din-app}/share/din/din-cli.mjs "\$@"
    EOF
    chmod +x $out/bin/din
    cat > $out/share/wayland-sessions/din.desktop <<EOF
    [Desktop Entry]
    Name=Din
    Comment=The social computer
    Exec=$out/bin/din-session
    Type=Application
    DesktopNames=Din
    EOF
  '';
in
{
  options.services.desktopManager.din = {
    enable = lib.mkEnableOption "Din, the social computer, as a desktop on the login screen";

    package = lib.mkOption {
      type = lib.types.package;
      default = package;
      defaultText = lib.literalMD "Din, built from the flake's source";
      readOnly = true;
      description = "The session package: `din-session`, the `din` command and the login screen's entry.";
    };

    electron = lib.mkOption {
      type = lib.types.package;
      default = pkgs.electron_43;
      defaultText = lib.literalExpression "pkgs.electron_43";
      description = "The Electron Din runs on (43.7.8 or later; os/flake.nix says why).";
    };

    extraElectronFlags = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "--disable-gpu" ];
      description = "More arguments for Electron, such as software rendering on a machine whose GPU Din can't use.";
    };

    enableSystemServices = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Turn on what Din's Settings works through: NetworkManager,
        Bluetooth, UDisks, UPower, PipeWire and the login keyring. Each
        only by default, so the system's own setting wins.
      '';
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      assertions = [{
        assertion = pkgs.stdenv.hostPlatform.system == "x86_64-linux";
        message = "Din's desktop is built for x86_64-linux only.";
      }];
      services.displayManager.sessionPackages = [ cfg.package ];
      environment.systemPackages = [ cfg.package pkgs.adwaita-icon-theme ];
      hardware.graphics.enable = true;
      security.polkit.enable = true;
      programs.dconf.enable = true;
      # Brightness for the user, without root (Settings, the menu bar).
      services.udev.packages = [ pkgs.brightnessctl ];
      fonts.packages = with pkgs; [ noto-fonts noto-fonts-cjk-sans noto-fonts-color-emoji ];
      # The file chooser is Din's own (electron/file-chooser-portal.mts), as
      # on DinOS, but only in Din's session: another desktop keeps its own.
      xdg.portal = {
        enable = true;
        extraPortals = [
          pkgs.xdg-desktop-portal-gtk
          (pkgs.writeTextDir "share/xdg-desktop-portal/portals/din.portal" ''
            [portal]
            DBusName=org.freedesktop.impl.portal.desktop.din
            Interfaces=org.freedesktop.impl.portal.FileChooser
            UseIn=Din;
          '')
        ];
        config.din = {
          default = [ "gtk" ];
          "org.freedesktop.impl.portal.FileChooser" = [ "din" ];
        };
      };
    }
    (lib.mkIf cfg.enableSystemServices {
      networking.networkmanager.enable = lib.mkDefault true;
      hardware.bluetooth.enable = lib.mkDefault true;
      services.udisks2.enable = lib.mkDefault true;
      services.upower.enable = lib.mkDefault true;
      services.gnome.gnome-keyring.enable = lib.mkDefault true;
      security.rtkit.enable = lib.mkDefault true;
      services.pipewire = {
        enable = lib.mkDefault true;
        alsa.enable = lib.mkDefault true;
        pulse.enable = lib.mkDefault true;
      };
    })
  ]);
}

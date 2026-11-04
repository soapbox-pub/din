# A throwaway NixOS with Din on its login screen, for trying the desktop
# module (desktop-module.nix): `nix run ./os#desktop-vm`, then log in as
# tester (password din). Policy for this test machine only, not the module's.
{ pkgs, modulesPath, ... }:
{
  imports = [ (modulesPath + "/virtualisation/qemu-vm.nix") ];
  networking.hostName = "din-desktop-vm";
  system.stateVersion = "26.05";

  services.desktopManager.din.enable = true;
  # QEMU's GPU can't run Chromium's, nor hand the compositor's buffers to
  # Electron, so both draw on the CPU.
  services.desktopManager.din.extraElectronFlags = [ "--disable-gpu" "--enable-unsafe-swiftshader" ];
  environment.sessionVariables.DIN_COMPOSITOR_GPU = "0";

  services.xserver.enable = true;
  services.xserver.displayManager.lightdm.enable = true;
  services.displayManager.defaultSession = "din";

  users.users.tester = {
    isNormalUser = true;
    initialPassword = "din";
    extraGroups = [ "wheel" "networkmanager" "video" ];
  };

  # A GTK app and an X11 one, to try native apps on Din's display.
  environment.systemPackages = [ pkgs.gnome-text-editor pkgs.xterm ];

  virtualisation = {
    memorySize = 4096;
    cores = 4;
    diskSize = 16384;
    graphics = true;
    qemu.options = [ "-vga virtio" ];
  };
}

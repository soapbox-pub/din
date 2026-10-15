{
  description = "DinOS: the flagship OS of Din - a minimal NixOS that boots straight into the Din desktop environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

    # The Din desktop environment (the repository root).
    din = {
      url = "path:..";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, din }:
    let
      system = "x86_64-linux";
    in
    {
      nixosConfigurations.dinos = nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = { inherit din; };
        modules = [ ./configuration.nix ];
      };

      packages.${system} = {
        # The real product: a disk image for physical machines.
        # `nix build ./os#image` -> ./result/nixos.img; write it to a drive
        # (e.g. `dd if=result/nixos.img of=/dev/sdX bs=4M status=progress`)
        # and boot via UEFI. The root partition grows to fill the disk on
        # first boot. Written to a USB stick, it's a live system whose
        # Installer app puts DinOS on the computer's own disk.
        image = import "${nixpkgs}/nixos/lib/make-disk-image.nix" {
          inherit (self.nixosConfigurations.dinos) config pkgs;
          lib = nixpkgs.lib;
          format = "raw";
          partitionTableType = "efi";
          diskSize = "auto";
          # An appliance image doesn't need a nixpkgs channel copy on disk.
          copyChannel = false;
          # Mark the root partition as an x86-64 root, which is how the
          # initrd finds it (see fileSystems in configuration.nix).
          postVM = ''
            ${nixpkgs.legacyPackages.${system}.gptfdisk}/bin/sgdisk \
              --typecode=2:4f68bce3-e8cd-4db1-96e7-fbcaf984b709 $diskImage
          '';
        };

        # `nix build ./os#vm` -> ./result/bin/run-dinos-vm demos the same
        # system in a QEMU window.
        vm = self.nixosConfigurations.dinos.config.system.build.vm;

        default = self.packages.${system}.image;
      };
    };
}

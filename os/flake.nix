{
  description = "Aladdin: the flagship OS of Din - a minimal NixOS that boots straight into the Din desktop environment";

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
      nixosConfigurations.aladdin = nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = { inherit din; };
        modules = [ ./configuration.nix ];
      };

      packages.${system} = {
        # `nix build ./os#vm` -> ./result/bin/run-aladdin-vm launches QEMU
        vm = self.nixosConfigurations.aladdin.config.system.build.vm;
        default = self.packages.${system}.vm;
      };
    };
}

{ pkgs, modules, din }:

# The computer's accounts and password: nostrd holds the Nostr keys as its
# own user, Din's user reaches it through the link in its home, sudo asks for
# a password exactly when `din` has one, and the disk passphrase systemd
# leaves in root's keyring unlocks nostrd at boot.
# `nix build ./os#checks.x86_64-linux.accounts`
pkgs.testers.runNixOSTest {
  name = "dinos-accounts";
  node.specialArgs = { inherit din; };
  nodes.machine = {
    imports = modules;
    # Din itself isn't under test, and has no GPU here.
    services.cage.enable = pkgs.lib.mkForce false;
    users.users.stranger.isNormalUser = true;
    environment.systemPackages = [ pkgs.keyutils pkgs.cryptsetup ];
    virtualisation.memorySize = 2048;
  };

  testScript = ''
    machine.wait_for_unit("nostrd.service")
    machine.wait_for_unit("din-sudo.service")
    machine.wait_for_unit("systemd-tmpfiles-setup.service")

    import shlex

    def as_din(command):
        return machine.succeed("su - din -c " + shlex.quote(command))

    with subtest("din reaches nostrd at the usual NIP-5F path"):
        machine.succeed("test -L /home/din/.local/share/nostr/signer.sock")
        as_din("test -S ~/.local/share/nostr/signer.sock")
        pubkey = as_din("nostrd call generate_account").strip().strip('"')
        assert len(pubkey) == 64, pubkey
        as_din("nostrd call sign_event '{\"kind\":1,\"content\":\"hi\",\"tags\":[]}' | grep -q sig")

    with subtest("other users are turned away"):
        machine.fail("su - stranger -c 'nostrd call --socket /run/nostrd/signer.sock status'")

    with subtest("din can't read the store"):
        machine.fail("su - din -c 'cat /var/lib/nostrd/store.json'")

    with subtest("without a password, sudo doesn't ask"):
        machine.succeed("test -f /run/din/sudoers.d/no-password")
        as_din("sudo -n true")

    with subtest("with a password, sudo asks, except for Din's helpers"):
        machine.succeed("echo 'din:hunter22' | chpasswd")
        machine.succeed("systemctl restart din-sudo")
        machine.succeed("test ! -e /run/din/sudoers.d/no-password")
        machine.fail("su - din -c 'sudo -n true'")
        helper = machine.succeed("grep -o '/nix/store/[^,]*din-keyboard' /etc/sudoers").strip()
        machine.succeed(f"su - din -c 'sudo -n {helper} 2>&1 | grep -q usage'")

    with subtest("the disk passphrase in root's keyring unlocks nostrd"):
        as_din("printf 'hunter22\\n' | nostrd call --stdin set_password")
        as_din("nostrd call lock")
        as_din("nostrd call status | grep -q '\"locked\": true'")
        machine.succeed("keyctl add user cryptsetup hunter22 @u")
        machine.succeed("systemctl restart nostrd-unlock")
        as_din("nostrd call status | grep -q '\"locked\": false'")
        machine.fail("keyctl search @u user cryptsetup")

    with subtest("a wrong passphrase leaves it locked"):
        as_din("nostrd call lock")
        machine.succeed("keyctl add user cryptsetup wrong @u")
        machine.succeed("systemctl restart nostrd-unlock")
        as_din("nostrd call status | grep -q '\"locked\": true'")

    password = machine.succeed("grep -o '/nix/store/[^ ,]*-din-password/bin/din-password' /etc/sudoers | head -1").strip()
    script = machine.succeed(f"grep -o '/nix/store/[^ ]*din-password.py' {password}").strip()

    with subtest("changing the password needs the old one"):
        machine.fail(f"su - din -c \"printf 'nope\\nbattery-staple\\n' | sudo -n {password} change\"")
        machine.fail(f"su - din -c \"printf 'hunter22\\nshort\\n' | sudo -n {password} change\"")

    with subtest("it changes sudo's and nostrd's together"):
        as_din(f"printf 'hunter22\\nbattery-staple\\n' | sudo -n {password} change")
        as_din("echo battery-staple | sudo -S -k true")
        machine.fail("su - din -c 'echo hunter22 | sudo -S -k true'")
        as_din("printf 'battery-staple\\n' | nostrd call --stdin verify_password | grep -q true")

    with subtest("and the disk's"):
        machine.succeed(
            "truncate -s 64M /tmp/disk",
            "printf hunter22 | cryptsetup luksFormat --batch-mode --pbkdf pbkdf2 --pbkdf-force-iterations 1000 /tmp/disk -",
            f"${pkgs.python3}/bin/python3 -c \"import importlib.util as u; s = u.spec_from_file_location('p', '{script}'); m = u.module_from_spec(s); s.loader.exec_module(m); m.change_disk('/tmp/disk', 'hunter22', 'battery-staple')\"",
            "printf battery-staple | cryptsetup open --test-passphrase --key-file=- /tmp/disk",
        )
        machine.fail("printf hunter22 | cryptsetup open --test-passphrase --key-file=- /tmp/disk")

    with subtest("the store survives a restart, locked"):
        machine.succeed("systemctl restart nostrd")
        machine.wait_until_succeeds("su - din -c 'nostrd call status' | grep -q '\"locked\": true'")
        as_din(f"nostrd call get_public_key | grep -q {pubkey}")
  '';
}

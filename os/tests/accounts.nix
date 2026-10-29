{ pkgs, modules, din, deckmon }:

let
  # Din's end of din-askpass (electron/askpass.mts): answers each connection
  # with the next reply named, and writes down the command sudo was running.
  askpassStub = pkgs.writeText "askpass-stub.py" ''
    import json, socket, sys
    server = socket.socket(socket.AF_UNIX)
    server.bind(sys.argv[1])
    server.listen()
    for answer in sys.argv[2:]:
        conn, _ = server.accept()
        pid = json.loads(conn.makefile().readline())["pid"]
        with open(f"/proc/{pid}/cmdline") as cmdline, open(sys.argv[1] + ".asked", "a") as asked:
            asked.write(cmdline.read().replace("\0", " ").strip() + "\n")
        conn.sendall((json.dumps({"password": answer} if answer != "-" else {}) + "\n").encode())
        conn.close()
  '';
in

# The computer's accounts and password: nostrd holds the Nostr keys as its
# own user, Din's user reaches it through the link in its home, sudo asks for
# a password exactly when `din` has one, and the disk passphrase systemd
# leaves in root's keyring unlocks nostrd, the login keyring and GPG keys at
# boot.
# `nix build ./os#checks.x86_64-linux.accounts`
pkgs.testers.runNixOSTest {
  name = "dinos-accounts";
  node.specialArgs = { inherit din deckmon; };
  nodes.machine = {
    imports = modules;
    # Din itself isn't under test, and has no GPU here.
    systemd.services.din-shell.enable = pkgs.lib.mkForce false;
    users.users.stranger.isNormalUser = true;
    environment.systemPackages = [ pkgs.keyutils pkgs.cryptsetup pkgs.libsecret ];
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

    with subtest("typos at the boot screen don't keep it locked"):
        # systemd caches every passphrase typed, NUL-separated; the last opened the disk.
        machine.succeed("printf 'hunter2\\0hunter22' | keyctl padd user cryptsetup @u")
        machine.succeed("systemctl restart nostrd-unlock")
        as_din("nostrd call status | grep -q '\"locked\": false'")

    session = "export XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus; "
    lookup = session + "timeout 10 secret-tool lookup test 1"

    def restart_keyring_with(passphrase):
        machine.succeed("pkill -u din -f gnome-keyring-daemon")
        machine.wait_until_fails("pgrep -u din -f gnome-keyring-daemon")
        machine.succeed(f"printf '{passphrase}' | keyctl padd user cryptsetup @u")
        machine.succeed("systemctl restart din-keyring-unlock")
        machine.succeed("keyctl unlink $(keyctl search @u user cryptsetup) @u")

    with subtest("without a password, the keyring has none"):
        machine.wait_until_succeeds("test -f /home/din/.local/share/keyrings/login.keyring", timeout=30)
        as_din(session + "printf s3cret | secret-tool store --label=test test 1")
        assert as_din(lookup) == "s3cret"

    with subtest("the disk passphrase unlocks the keyring"):
        as_din(session + "printf '\\nhunter22\\n' | din-keyring change")
        restart_keyring_with("hunter22")
        assert as_din(lookup) == "s3cret"

    with subtest("a wrong one leaves it locked"):
        restart_keyring_with("wrong")
        machine.fail("su - din -c " + shlex.quote(lookup))
        as_din(session + "printf hunter22 | din-keyring unlock")
        assert as_din(lookup) == "s3cret"

    with subtest("typos at the boot screen don't count, and don't re-key it"):
        # systemd caches every passphrase typed, NUL-separated; the last opened the disk.
        restart_keyring_with("hunter2\\0hunter222\\0hunter22")
        assert as_din(lookup) == "s3cret"
        restart_keyring_with("hunter22")
        assert as_din(lookup) == "s3cret"

    def gpg_sign(key, passphrase=None):
        mode = f"--pinentry-mode loopback --passphrase {passphrase}" if passphrase else "--pinentry-mode error"
        return session + f"gpg --batch --no-autostart {mode} --local-user {key} --sign --output /dev/null --yes /dev/null"

    with subtest("the disk passphrase unlocks GPG keys that have it, and no others"):
        as_din(session + "gpg --batch --pinentry-mode loopback --passphrase hunter22 --quick-gen-key mine@test ed25519 sign never")
        as_din(session + "gpg --batch --pinentry-mode loopback --passphrase other123 --quick-gen-key other@test ed25519 sign never")
        machine.succeed("printf 'hunter2\\0hunter22' | keyctl padd user cryptsetup @u")
        machine.succeed("systemctl restart din-gpg-unlock")
        machine.succeed("keyctl unlink $(keyctl search @u user cryptsetup) @u")
        as_din(gpg_sign("mine@test"))
        machine.fail("su - din -c " + shlex.quote(gpg_sign("other@test")))
        # Long past gpg-agent's default max-cache-ttl, two hours, it's unlocked
        # still.
        machine.succeed("date -s '+10 years'")
        as_din(gpg_sign("mine@test"))

    password = machine.succeed("grep -o '/nix/store/[^ ,]*-din-password/bin/din-password' /etc/sudoers | head -1").strip()
    script = machine.succeed(f"grep -o '/nix/store/[^ ]*din-password.py' {password}").strip()

    with subtest("sudo stops asking given the password, and asks again"):
        machine.fail(f"su - din -c \"printf 'nope\\n' | sudo -n {password} sudo skip\"")
        machine.fail("su - din -c 'sudo -n true'")
        as_din(f"printf 'hunter22\\n' | sudo -n {password} sudo skip")
        assert as_din(f"sudo -n {password} sudo status").strip() == "skip"
        as_din("sudo -n true")
        as_din(f"sudo -n {password} sudo ask")
        assert as_din(f"sudo -n {password} sudo status").strip() == "ask"
        machine.fail("su - din -c 'sudo -n true'")

    with subtest("without a terminal, sudo asks Din"):
        as_din("mkdir -m 700 /tmp/rt")
        machine.succeed("su - din -c '${pkgs.python3}/bin/python3 ${askpassStub} /tmp/rt/din-askpass.sock hunter22 - >/dev/null 2>&1 &'")
        machine.wait_until_succeeds("test -S /tmp/rt/din-askpass.sock")
        no_tty = "XDG_RUNTIME_DIR=/tmp/rt setsid -w sudo -A -k true </dev/null"
        as_din(no_tty)
        machine.fail("su - din -c " + shlex.quote(no_tty))
        asked = machine.succeed("cat /tmp/rt/din-askpass.sock.asked").split("\n")[0]
        assert asked.split(" ", 1)[0].endswith("sudo") and asked.endswith(" -A -k true"), asked

    with subtest("changing the password needs the old one"):
        machine.fail(f"su - din -c \"printf 'nope\\nbattery-staple\\n' | sudo -n {password} change\"")
        machine.fail(f"su - din -c \"printf 'hunter22\\nshort\\n' | sudo -n {password} change\"")

    with subtest("it changes sudo's, nostrd's, the keyring's and the GPG key's together"):
        as_din(f"printf 'hunter22\\nbattery-staple\\n' | sudo -n {password} change")
        as_din("echo battery-staple | sudo -S -k true")
        machine.fail("su - din -c 'echo hunter22 | sudo -S -k true'")
        as_din("printf 'battery-staple\\n' | nostrd call --stdin verify_password | grep -q true")
        as_din(session + "printf battery-staple | din-keyring unlock")
        machine.fail("su - din -c " + shlex.quote(session + "printf hunter22 | din-keyring unlock"))
        as_din(gpg_sign("mine@test"))
        as_din(session + "gpgconf --reload gpg-agent")
        machine.fail("su - din -c " + shlex.quote(gpg_sign("mine@test", "hunter22")))
        as_din(gpg_sign("mine@test", "battery-staple"))
        as_din(gpg_sign("other@test", "other123"))

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

---
name: dinos
description: Change DinOS itself, the NixOS system this computer runs: packages, services, settings, or Din's own code, built from a Din checkout with nixos-rebuild. Use when the user wants to change the system, not just their files, or asks how DinOS is built or updated.
---

# Changing DinOS

DinOS is NixOS built from Din's repository: `os/flake.nix` (the
`nixosConfigurations.dinos` system) and `os/configuration.nix` (all of it).
There is no `/etc/nixos`; to change the system, change a Din checkout and
build from it.

1. Get a checkout to work in, if there isn't one:
   `git clone nostr://npub1q3sle0kvfsehgsuexttt3ugjd8xdklxfwwkh559wxckmzddywnws6cd26p/git.shakespeare.diy/din`
   (git-remote-nostr is installed). `/var/lib/dinos/src` is the updater's,
   owned by root: read it, never edit it.
2. Edit, then **commit**: the flake sees only git-tracked files.
3. `sudo nixos-rebuild boot --flake <checkout>/os#dinos`.
   **Always `boot`, never `switch`**: `switch` restarts `din-shell.service`,
   which is the whole desktop, including this terminal and the agent.
4. Ask the user to restart. Never reboot the computer yourself. Afterwards
   `readlink /run/current-system` should be the new build.

## Know before you build

- `sudo` asks the user for their password in a dialog or in this
  conversation; they may not see it at once, so give it a long timeout and
  batch root work into one `sudo sh -c '…'`.
- **Automatic updates build the official repository's branch and stage it
  over a local build.** Have the user turn them off (Settings → About →
  Update automatically), or follow a fork instead with
  `sudo din-update source <url> <branch>`.
- Changing npm dependencies means refreshing `npmDepsHash` in
  `os/configuration.nix` (see the README).
- If Din doesn't start, the user can hold Space at startup to pick an older
  system, or press Ctrl+Alt+F2 for a text login.
- Logs: `journalctl -b 0` (this boot), `-b -1` (the last);
  Din and its compositor under `journalctl -b -u din-shell`.

## References

In a Din checkout: `README.md` (architecture, DinOS, Nix details),
`os/configuration.nix` (its comments explain each part), `os/din-update.sh`
(how updates work), `AGENTS.md` (working on Din's code).

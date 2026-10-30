---
name: dinos
description: Change DinOS itself, the NixOS system this computer runs: packages, services, settings, or Din's own code, built from the user's copy of Din in ~/DinOS with nixos-rebuild. Use when the user wants to change or customize the system, not just their files, when a DinOS update failed and needs fixing, or when they ask how DinOS is built or updated.
---

# Changing DinOS

DinOS is NixOS built from Din's repository: `os/flake.nix` (the
`nixosConfigurations.dinos` system) and `os/configuration.nix` (all of it).
There is no `/etc/nixos`; to change the system, change a copy of Din and
build from it.

**That copy is `~/DinOS`**, the user's fork. Always work there, so updates
can find the changes and keep them. `/var/lib/dinos/src` is the updater's,
owned by root: read it, never edit it.

## Making a change

1. Get `~/DinOS` ready.
   - If it doesn't exist, clone the repository the system updates from.
     `sudo -n "$DIN_UPDATER" status` prints it (`url`, `branch`); by default
     that's `git clone nostr://npub1q3sle0kvfsehgsuexttt3ugjd8xdklxfwwkh559wxckmzddywnws6cd26p/git.shakespeare.diy/din ~/DinOS`
     (git-remote-nostr is installed). Its `origin` is that repository.
   - If it does, catch it up with the running system first. Updates merge
     into the user's changes as root and record the result on the
     checkout's `system` branch, so take that, then upstream:
     `git -C ~/DinOS pull --no-edit /var/lib/dinos/src system` and
     `git -C ~/DinOS pull --no-edit origin <branch>`.
2. Edit, then **commit** on its branch. The flake sees only git-tracked
   files, and a system built from uncommitted changes can't be kept by
   updates: they stop and say so. Merge, don't rebase or amend commits a
   system was built from; updates find the user's changes by those hashes.
3. `sudo nixos-rebuild boot --flake ~/DinOS/os#dinos`.
   **Always `boot`, never `switch`**: `switch` restarts `din-shell.service`,
   which is the whole desktop, including this terminal and the agent.
4. Ask the user to restart. Never reboot the computer yourself. Afterwards
   `readlink /run/current-system` should be the new build, and
   `/etc/din-revision` the commit you built.

## How updates treat a customized system

Leave automatic updates on. The updater (`os/din-update.sh`) sees that the
commit the newest system was built from (`/etc/din-revision`) isn't in the
branch it follows, and instead of building the branch over it, merges the
branch's new tip into that exact commit (taking it from `~/DinOS` if it
has to) and builds the merge. Settings → About shows the system as
customized.

When that can't work, the update fails with a reason, and Din offers
**Fix with assistant**, which starts a conversation asking you to:

- `conflict`: the user's changes conflict with the branch. In `~/DinOS`,
  pull `system` and `origin <branch>` as in step 1, resolve the conflicts
  keeping what the user's changes are for, commit, and build (step 3).
- `build`: they merge but don't build together. Same, then fix the build.
- `dirty`: the system was built with uncommitted changes. Commit them in
  `~/DinOS` (if they're there), merge the branch, and build.
- `missing`: the system's commit isn't in `~/DinOS`; it was built from
  somewhere else. Bring that commit into `~/DinOS` (`git fetch <that
  checkout> <commit>` and merge it), then build.

Once the new build is staged, the updater sees it already has the branch's
tip and has nothing to do.

## Sharing a fork

`~/DinOS` needn't be published. To let other computers follow it, push it
somewhere git can fetch over `nostr://` or `https://` (`ngit init` makes a
nostr repository) and, on each of them, set the source in Settings → About
or with `sudo "$DIN_UPDATER" source <url> <branch>`. Such a computer builds that
branch as its upstream, and merges its own `~/DinOS` changes into it the
same way.

## Know before you build

- `sudo` asks the user for their password in a dialog or in this
  conversation; they may not see it at once, so give it a long timeout and
  batch root work into one `sudo sh -c '…'`.
- Changing npm dependencies means refreshing `npmDepsHash` in
  `os/configuration.nix` (see the README).
- If Din doesn't start, the user can hold Space at startup to pick an older
  system, or press Ctrl+Alt+F2 for a text login.
- Logs: `journalctl -b 0` (this boot), `-b -1` (the last);
  Din and its compositor under `journalctl -b -u din-shell`, updates under
  `journalctl -u din-update`.

## References

In `~/DinOS`: `README.md` (architecture, DinOS, Nix details),
`os/configuration.nix` (its comments explain each part), `os/din-update.sh`
(how updates work), `AGENTS.md` (working on Din's code).

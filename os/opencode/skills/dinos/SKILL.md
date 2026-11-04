---
name: dinos
description: Change DinOS itself, the NixOS system this computer runs: packages, services, settings, or Din's own code, built from the user's copy of Din in ~/DinOS with `din update local`. Use when the user wants to change or customize the system, not just their files, when a DinOS update failed and needs fixing, or when they ask how DinOS is built or updated.
---

# Changing DinOS

DinOS is NixOS built from Din's repository: `os/flake.nix` (the
`nixosConfigurations.dinos` system) and `os/configuration.nix` (all of it).
There is no `/etc/nixos`; to change the system, change a copy of Din and
build from it.

The updater, `din-update`, is the running system's, and sudo knows it only
by its store path: `U=$(readlink -f /run/current-system/sw/bin/din-update)`,
then `sudo -n "$U" status` (JSON).

**That copy is `~/DinOS`**, the user's fork. Always work there, so updates
can find the changes and keep them. `/var/lib/dinos/src` is the updater's,
owned by root: read it, never edit it. `~/DinOS` may be a symlink to a
developer's own checkout of Din; work in it all the same.

## Making a change

1. Get `~/DinOS` ready.
   - If it doesn't exist, clone the repository the system updates from.
     `sudo -n "$U" status` prints it (`url`, `branch`); by default
     that's `git clone nostr://npub10qdp2fc9ta6vraczxrcs8prqnv69fru2k6s2dj48gqjcylulmtjsg9arpj/git.shakespeare.diy/din ~/DinOS`
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
3. `din update local` (or `din update local <branch-or-commit>`; the
   default is `main`). Din asks the user to allow it ("Allow the assistant
   to update Din?"), builds that commit of `~/DinOS` the way updates build
   (progress in Settings → About), adds it to the boot menu and switches to
   it. Give it a long timeout (an hour): the build, and the user, take a
   while. It prints what happened:
   - "It's live": done.
   - "Din is restarting": Din's own code changed, so Din restarts by
     itself a moment later, closing every app, this conversation included.
     The user approved that; the conversation is saved, and they pick it
     up after. Tell the user before you run it if there's anything left
     to say.
   - "It starts when the computer restarts": the kernel, initrd, kernel
     parameters, modules or firmware changed, which load only at startup.
     Ask the user to restart the computer; never reboot it yourself.

   A setting in `/etc` that a running service reads only at startup
   (PipeWire's, say) waits for that service to restart, which this can't
   see; restart that service (`systemctl --user restart pipewire` for a
   user one) if the user wants it now. **Never restart Din or din-shell
   yourself** any other way.

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
- `missing`: the system was built from a commit that's neither on the
  branch nor in `~/DinOS` (or there's no `~/DinOS`). The updater won't
  build the branch over it, since that could take the system back to an
  older Din. Find the checkout it was built from, bring the commit into
  `~/DinOS` (`git fetch <that checkout> <commit>` and merge it), then
  build. If the user would rather drop those changes, Settings → About
  offers "Use <branch> instead" (`sudo -n "$U" replace`); that's theirs to
  choose, not yours.

Once the new build is staged, the updater sees it already has the branch's
tip and has nothing to do. When the user's changes are taken upstream
(even rebased), the next update notices its merge is the same as the
branch's tip, builds the tip itself, and the system is no longer
customized.

## Sharing a fork

`~/DinOS` needn't be published. To let other computers follow it, push it
somewhere git can fetch over `nostr://` or `https://` (`ngit init` makes a
nostr repository) and, on each of them, set the source in Settings → About
or with `sudo "$U" source <url> <branch>`. Such a computer builds that
branch as its upstream, and merges its own `~/DinOS` changes into it the
same way.

## Know before you build

- `sudo` asks the user for their password in a dialog or in this
  conversation; they may not see it at once, so give it a long timeout and
  batch root work into one `sudo sh -c '…'`.
- Changing npm dependencies means refreshing `npmDepsHash` in
  `os/packages.nix` (see the README).
- If Din doesn't start, the user can hold Space at startup to pick an older
  system, or press Ctrl+Alt+F2 for a text login.
- Logs: `journalctl -b 0` (this boot), `-b -1` (the last);
  Din and its compositor under `journalctl -b -u din-shell`, updates under
  `journalctl -u din-update`.

## References

In `~/DinOS`: `README.md` (architecture, DinOS, Nix details),
`os/configuration.nix` (its comments explain each part), `os/din-update.sh`
(how updates work), `AGENTS.md` (working on Din's code).

---
name: nsite
description: Publish a static website to Nostr as an nsite (NIP-5A) with `ngit nsite publish`. Use when the user wants to deploy, publish or host a site, a built web app, or docs on Nostr and Blossom.
---

# Publishing an nsite

An nsite is a static website addressed by a Nostr pubkey
([NIP-5A](https://github.com/nostr-protocol/nips/blob/master/5A.md)): one
manifest event on relays maps each path to a sha256 hash, and the files
live on Blossom servers. Gateways such as `https://<npub>.nsite.lol` serve it.

DinOS comes with `ngit`, which publishes one. Don't install nsyte or another
tool for it. ngit signs through nostrd as the user's account, so there's no
key to set up.

```sh
npm run build                                   # ngit builds nothing itself
ngit nsite publish dist --title "My site" --json            # root site
ngit nsite publish dist --id docs --title "Docs" --json     # named site
```

- **Ask which before publishing.** Without `--id` it's the account's root
  site (kind 15128, one per account), and publishing **replaces whatever
  root site they already have**. `--id <name>` is a named site (kind
  35128), one of many alongside it.
- Pass the **build output**, not the source tree: every file in it is
  uploaded. Ship a `favicon.ico` or `favicon.svg` there; a single-page
  app wants `--fallback /index.html` (published as its `/404.html`, which
  gateways serve for paths that aren't there) so its routes load.
- Blossom servers and relays come from the account's own lists (kinds 10063
  and 10002); `--blossom-server` and `--relay` (repeatable) override them.
  `.nsite/config.json` (nsyte's format) is read when present.
- With `--json`, check `command_status`, `result.changed`,
  `result.blossom.problems[]` and `result.publication.relays[]`. After a
  failure, run the same command again: uploaded files are skipped.

`ngit nsite --help` has the rest, and
[ngit's guide](https://ngit.dev/releases/nsites) more.

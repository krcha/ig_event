# Dedicated social production v24 source snapshot

This branch preserves captured source for the existing `/api/social` media
service. `main` is the canonical current public web application. This snapshot
is not a replacement for `main`, a merge request, or authorization to deploy its
older frontend, admin, ingestion, moderation, or Convex code.

## Provenance and exact scope

The source was captured from
`/root/ig_event-releases/agenda-v24-publication-recovery-20261020` while the
service container `ig-event-web-agenda-v24-release` was active. Its copied `.git`
points at a missing `master` reference and has no valid remote. The original
source commit is **unknown**. This branch's new snapshot commit records the
capture; its parent does not establish the original source's Git ancestry.

The capture contains 710 actual files, 55,172,454 source/asset bytes. Each
captured file is preserved byte for byte and listed in
[the coverage manifest](docs/social-production-v24/coverage-manifest.json).
Capture selection used the canonical `9653eec1068af75b3322cc53145c4f503750fdc1`
tracked-source allowlist (711 eligible paths), files actually present there,
social API/library/build/QA additions, recursive literal import dependencies,
and curated social fonts/art/static assets. 99 known canonical paths were
absent. They are listed in the manifest and were not invented or copied over
from newer web code. In particular, newer reviewed data snapshots and current
public-map/Open now code do not describe this older service source.

This is not a complete image of every untracked first-party file on the server.
Noncanonical files outside that import/social capture scope were not included.
The coverage/provenance and runtime metadata added for this branch are separate
from the 710 captured files. `mainSha256` in the operator coverage manifest is a
comparison to the web source used during capture, not an original v24 Git ref.

Archive SHA-256:
`a1396960b4fc562cb2118b3ffa8d0cd406405304aef611e0326705bdad9ba4db`.
[Provenance metadata](docs/social-production-v24/provenance.json) records the
archive size and exact supplemental manifest/runtime-recipe hashes.

## Actual runtime and recovery inputs

The captured service uses image
`eventzeka-node-runtime:22.22.3-bookworm-reels-v1`, exact image ID
`sha256:3d30ba33a5a5a9ba7403814db0161c3048f0cf0475fad475c9e4160ba405d81c`.
Its actual command is `npm run start` in `/app`, with the source mounted read
only. The container exposes port 3000 through loopback `127.0.0.1:3124`; its
Traefik rule serves `/api/social` on the documented public hosts at priority
921. This preserves a dedicated media-generator role alongside the newer web
service; it does not mean this branch's public frontend is live or current.

[The sanitized runtime recipe](docs/social-production-v24/runtime-recipe.json)
records actual `docker inspect` command, mounts, network, restart policy,
router labels and environment **key names only**.
[Additional recovery metadata](docs/social-production-v24/runtime-recovery-extra.json)
records the actual healthcheck, user, filesystem, security and resource settings.
The old Compose path mentioned in container labels is absent; no fictional
Compose file or deployment recipe has been reconstructed from that stale label.

Runtime dependencies include ffmpeg/ffprobe in the pinned image,
`@napi-rs/canvas@0.1.100`, the v23 material/canvas dependency overlay, v17 shared
node_modules and the persistent writable `/var/cache/eventzeka-reels` mount.
Their exact observed mount paths and modes are in the recipe. Source includes
`ops/n8n/reels-runtime.Dockerfile`, package manifests/lock and curated font and
art assets. Dependency directories, private environment values, built `.next`
output and cache/media histories are deliberately excluded. Rebuilding this
historical service requires reviewing those external runtime inputs and
restoring private configuration through the normal operator process. This
snapshot alone does not prove a standalone reproducible rebuild.

## Validation and limits

All 710 per-file SHA-256 values and sizes match the captured archive. Independent
strong secret-pattern and forbidden-path scans found no matches; the capturing
operator also checked exact sensitive runtime values without disclosing them.
The largest Git blob is the 12,273,960-byte Unifont asset, below GitHub's blob
limits. Curated static media/fonts and their captured licenses remain intact.

A read-only lexical audit resolved 1,863 literal local imports, including
TypeScript `.js` references to the generated `.d.ts` source. No unresolved
literal local imports, undeclared bare runtime imports, or missing lockfile
dependency entries remained after standard framework marker handling. This
checks source presence; it does not execute scripts, prove computed imports,
verify every runtime filesystem read, or validate social publication behavior.
[Validation details](docs/social-production-v24/source-validation.json) record
the exact checks and their limits.

No install, build, release QA, backend deployment, API mutation, publication or
runtime change was performed to prepare this immutable capture. The current
web release's 126-check QA result does not apply to this historical snapshot.
Do not run its deployment or ingestion scripts against production merely
because the source is now versioned.

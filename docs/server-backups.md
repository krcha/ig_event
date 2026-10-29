# Event Zeka full server backups

Keep one verified full Event Zeka recovery archive on the VPS when rotating
backups under the single-backup policy. The archive is private and root-only;
database exports, filled environment files, sessions and credentials must stay
outside Git. Git contains source code, this runbook and sanitized receipts.

## Required contents

- Either a transaction-consistent Convex export with `--include-file-storage`
  (including component data), or a coordinated offline snapshot of the complete
  backend database, credentials, compiled modules, stored media and search state.
- The current Git `main` history and the actual production source directories.
  The website and social renderer can run different source versions; preserve
  both, along with their built assets and Linux dependency trees.
- The exact Docker images for the website, social renderer, Convex backend and
  dashboard, Instagram collector and n8n. Include container, image, mount,
  volume, network and routing inspection records.
- Compose files, private environment/secrets, backend instance credentials,
  ingestion scripts, systemd units/drop-ins and scheduler configuration.
- Instagram collector sessions and persistent state.
- Native exports of Event Zeka n8n workflows, their referenced encrypted
  credentials, encryption configuration and local assets. Preserve Event Zeka
  runtime settings without replacing a shared n8n database.
- An internal manifest, per-file SHA-256 checksums and recovery instructions.

For an offline snapshot, stop the backend before copying its database and
mutable files. Immutable stored file objects and compiled modules can be
hardlinked into a snapshot on the same filesystem while the backend is stopped.
Restart the backend before compression and hashing, then retain those snapshot
links until verification finishes. Exclude obsolete export blobs and temporary
files. Record the actual stopped window.

An online SQLite backup and a later object-store copy are only supplemental
artifacts. They are captured sequentially and do not constitute an atomic raw
volume snapshot.

## Create and verify

1. Inspect the actual containers, source paths, mounts, running ingestion,
   deployment locks, export status and available disk. Preserve host-key
   verification when connecting. Do not reuse old deployment operators.
2. Acquire the Event Zeka backup/deployment/ingestion locks. Leave enough disk
   for the new export, staging files and final archive. Keep the previous
   verified backup until all new verification has passed.
3. For a logical export, wait for a new completed export and verify its
   `include_storage` setting. Test every ZIP member's CRC, parse every table's
   JSONL, and reconcile stored-file counts with storage records. For an offline
   snapshot, capture the complete persistent backend while stopped, restart it,
   run SQLite integrity checks on the copied database, and verify the hash and
   size of every captured file against its archived copy. Cancel any abandoned
   logical export through the backend API.
4. Capture the remaining required contents into a private staging directory.
   Do not print environment values, tokens or session data. Save the exact
   source/image identities and the original mount and network configuration.
5. Verify the Git bundle and the integrity of the copied SQLite database.
   Hash every staged component, create the final archive, then read back every
   archived component and compare its bytes and SHA-256 with the manifest.
6. Hash the final archive and save an external checksum and verification
   receipt. Restrict the archive to mode `0600` and its directory to `0700`.

Integrity verification does not demonstrate a successful full application
restore. Record whether an isolated restore was actually performed.

## Rotate to one archive

After the new archive passes verification, inventory the exact old Event Zeka
backup paths and Convex export blobs. Delete only those reviewed paths, plus
the new export's redundant working copy and staging directory. Keep the final
archive, its checksum and small audit receipts. Do not delete live media,
release dependencies, named volumes or backups belonging to other apps.

Verify the remaining Event Zeka backup count, check that no temporary export
copies remain, record reclaimed bytes, and recheck container health and public
HTTP responses. Do not use broad Docker pruning to rotate application backups.

## Restore order

Restore first into an isolated host. Keep ingestion and publication disabled
until verification is complete.

1. Verify the outer archive checksum, extract it into a private directory and
   verify its internal `SHA256SUMS`.
2. Load the saved Docker images. Recover the Git bundle and production source,
   builds, dependencies, Compose files and private configuration. Recreate
   required networks and named volumes using the inspection records.
3. For an offline volume snapshot, restore its files into an empty named volume
   while the backend is stopped; verify every file before starting the exact
   captured backend image with its saved instance credentials and configuration.
   Its deployed functions and modules are included. For a logical export, start
   an empty isolated instance, deploy the matching backend source, then import
   the ZIP with the included CLI and `--replace-all --yes`. Confirm the target
   origin before running either command.
4. Start the matching website and social-renderer releases. Verify database
   records, media, public browsing, `/api/health` and authenticated admin access.
5. Recover the collector state. For n8n, restore encryption configuration first,
   import the saved credentials and workflows, then check domains, webhook URLs
   and publication settings before activating anything.
6. Restore scheduling only after the recovered application works end to end.

See [the October 29 backup receipt](backup-receipts/2026-10-29.md) for the most
recent completed archive and its verification results.

#!/usr/bin/env bash
# Guarded VPS runner for apply-reviewed-venue-dedupe-learning.mjs.
#
# Required environment pins:
#   EVENT_ZEKA_REVIEWED_RUNTIME_ROOT
#   EVENT_ZEKA_REVIEWED_SOURCE_MANIFEST_PATH
#   EVENT_ZEKA_REVIEWED_SOURCE_MANIFEST_SHA256
#   EVENT_ZEKA_REVIEWED_OPERATOR_SHA256
#   EVENT_ZEKA_REVIEWED_RUNTIME_ENV_PATH
#   EVENT_ZEKA_REVIEWED_RUNTIME_ENV_SHA256
#   EVENT_ZEKA_REVIEWED_NODE_BINARY_PATH
#   EVENT_ZEKA_REVIEWED_NODE_BINARY_SHA256
#   EVENT_ZEKA_REVIEWED_DEPLOY_SNAPSHOT_PATH
#   EVENT_ZEKA_REVIEWED_DEPLOY_SNAPSHOT_SHA256
#   EVENT_ZEKA_REVIEWED_CONTAINER
#
# Usage:
#   runner config dry-run
#   runner config apply PLAN SHA CONFIRMATION
#   runner config status PLAN SHA
#   runner events dry-run
#   runner events apply PLAN SHA CONFIRMATION
#   runner events status PLAN SHA
set -Eeuo pipefail
umask 077
export LC_ALL=C

readonly RUNNER_SCHEMA=event-zeka-reviewed-venue-dedupe-runner-v1
readonly PLAN_ENVELOPE_SCHEMA=event-zeka-reviewed-venue-dedupe-plan-envelope-v1
readonly CONFIG_PLAN_SCHEMA=event-zeka-reviewed-venue-dedupe-config-plan-v1
readonly EVENT_PLAN_SCHEMA=event-zeka-reviewed-venue-dedupe-event-plan-v1
readonly RESULT_SCHEMA=event-zeka-reviewed-venue-dedupe-result-v1
readonly TARGET_SET_VERSION=event-zeka-reviewed-venue-dedupe-learning-2026-08-27:v2
readonly CONFIG_CONFIRMATION=APPLY_EVENT_ZEKA_REVIEWED_VENUE_DEDUPE_CONFIG_2026_08_27_V2
readonly EVENT_CONFIRMATION=APPLY_EVENT_ZEKA_REVIEWED_VENUE_DEDUPE_EVENTS_2026_08_27_V2
readonly INGESTION_LOCK=/run/lock/ig-event-durable-daily.lock
readonly FOLLOWING_LOCK=/run/lock/ig-event-discover-following.lock

readonly RUNTIME_ROOT=${EVENT_ZEKA_REVIEWED_RUNTIME_ROOT-}
readonly SOURCE_MANIFEST=${EVENT_ZEKA_REVIEWED_SOURCE_MANIFEST_PATH-}
readonly SOURCE_MANIFEST_SHA256=${EVENT_ZEKA_REVIEWED_SOURCE_MANIFEST_SHA256-}
readonly OPERATOR_SHA256=${EVENT_ZEKA_REVIEWED_OPERATOR_SHA256-}
readonly RUNTIME_ENV=${EVENT_ZEKA_REVIEWED_RUNTIME_ENV_PATH-}
readonly RUNTIME_ENV_SHA256=${EVENT_ZEKA_REVIEWED_RUNTIME_ENV_SHA256-}
readonly NODE_BINARY=${EVENT_ZEKA_REVIEWED_NODE_BINARY_PATH-}
readonly NODE_BINARY_SHA256=${EVENT_ZEKA_REVIEWED_NODE_BINARY_SHA256-}
readonly DEPLOY_SNAPSHOT=${EVENT_ZEKA_REVIEWED_DEPLOY_SNAPSHOT_PATH-}
readonly DEPLOY_SNAPSHOT_SHA256=${EVENT_ZEKA_REVIEWED_DEPLOY_SNAPSHOT_SHA256-}
readonly CONTAINER=${EVENT_ZEKA_REVIEWED_CONTAINER-}
readonly OPERATOR="$RUNTIME_ROOT/scripts/apply-reviewed-venue-dedupe-learning.mjs"
readonly REGISTER_PATHS="$RUNTIME_ROOT/scripts/register-ts-paths.mjs"

PHASE=${1-}
MODE=${2-}
PLAN_FILE=${3-}
PLAN_SHA256=${4-}
CONFIRMATION=${5-}
AUDIT_DIR=
REVIEWED_PLAN_FILE_SHA256=
FINALIZED=0
FD7_OPEN=0
FD8_OPEN=0

usage() {
  cat >&2 <<EOF
Usage:
  $0 config dry-run
  $0 config apply CONFIG_PLAN PLAN_SHA256 $CONFIG_CONFIRMATION
  $0 config status CONFIG_PLAN PLAN_SHA256
  $0 events dry-run
  $0 events apply EVENT_PLAN PLAN_SHA256 $EVENT_CONFIRMATION
  $0 events status EVENT_PLAN PLAN_SHA256

Apply/status accepts only a plan emitted by a successful dry-run of this
runner under the same deployment, operator, environment, Node, and snapshot
pins. The SHA argument is the planSha256 inside the JSON envelope.
EOF
  exit 64
}

die() {
  local code=$1
  printf 'reviewed_venue_dedupe_runner_error=%s\n' "$code" >&2
  if [[ -n "$AUDIT_DIR" && -d "$AUDIT_DIR" ]]; then
    printf '%s\n' "$code" >>"$AUDIT_DIR/failure.txt" 2>/dev/null || true
  fi
  exit 1
}

sha256_of() {
  sha256sum -- "$1" | awk '{print $1}'
}

assert_protected_file() {
  local file=$1 exact_mode=${2-} owner mode mode_octal
  [[ "$file" == /* && -f "$file" && ! -L "$file" ]] || die "E_FILE:$file"
  [[ "$(readlink -f -- "$file")" == "$file" ]] || die "E_FILE_CANONICAL:$file"
  owner=$(stat -c '%U:%G' -- "$file")
  mode=$(stat -c '%a' -- "$file")
  [[ "$owner" == root:root && "$mode" =~ ^[0-7]{3,4}$ ]] || die "E_FILE_OWNER_MODE:$file"
  mode_octal=$((8#$mode))
  (( (mode_octal & 8#7022) == 0 )) || die "E_FILE_UNPROTECTED:$file"
  [[ -z "$exact_mode" || "$mode" == "$exact_mode" ]] || die "E_FILE_MODE:$file"
}

assert_release_file() {
  local file=$1 expected=$2 owner mode mode_octal
  [[ "$file" == "$RUNTIME_ROOT/"* && -f "$file" && ! -L "$file" ]] || die "E_RELEASE_FILE:$file"
  [[ "$(readlink -f -- "$file")" == "$file" ]] || die "E_RELEASE_FILE_CANONICAL:$file"
  owner=$(stat -c '%U:%G' -- "$file")
  mode=$(stat -c '%a' -- "$file")
  [[ "$owner" == root:root && "$mode" =~ ^[0-7]{3,4}$ ]] || die "E_RELEASE_FILE_OWNER_MODE:$file"
  mode_octal=$((8#$mode))
  (( (mode_octal & 8#7002) == 0 )) || die "E_RELEASE_FILE_UNPROTECTED:$file"
  [[ "$expected" =~ ^[a-f0-9]{64}$ && "$(sha256_of "$file")" == "$expected" ]] || die "E_RELEASE_FILE_SHA256:$file"
}

assert_protected_directory() {
  local directory=$1 exact_mode=${2-} owner mode mode_octal
  [[ "$directory" == /* && -d "$directory" && ! -L "$directory" ]] || die "E_DIRECTORY:$directory"
  [[ "$(readlink -f -- "$directory")" == "$directory" ]] || die "E_DIRECTORY_CANONICAL:$directory"
  owner=$(stat -c '%U:%G' -- "$directory")
  mode=$(stat -c '%a' -- "$directory")
  [[ "$owner" == root:root && "$mode" =~ ^[0-7]{3,4}$ ]] || die "E_DIRECTORY_OWNER_MODE:$directory"
  mode_octal=$((8#$mode))
  (( (mode_octal & 8#7022) == 0 )) || die "E_DIRECTORY_UNPROTECTED:$directory"
  [[ -z "$exact_mode" || "$mode" == "$exact_mode" ]] || die "E_DIRECTORY_MODE:$directory"
}

check_sha() {
  local expected=$1 file=$2 exact_mode=${3-}
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || die "E_EXPECTED_SHA256:$file"
  assert_protected_file "$file" "$exact_mode"
  [[ "$(sha256_of "$file")" == "$expected" ]] || die "E_SHA256:$file"
}

parse_command() {
  case "$PHASE:$MODE:$#" in
    config:dry-run:2|events:dry-run:2) ;;
    config:status:4|events:status:4) ;;
    config:apply:5)
      [[ "$CONFIRMATION" == "$CONFIG_CONFIRMATION" ]] || usage
      ;;
    events:apply:5)
      [[ "$CONFIRMATION" == "$EVENT_CONFIRMATION" ]] || usage
      ;;
    *) usage ;;
  esac
  if [[ "$MODE" != dry-run ]]; then
    [[ "$PLAN_FILE" == /* && "$PLAN_SHA256" =~ ^[a-f0-9]{64}$ ]] || usage
  fi
}

need_linux_root() {
  local command
  [[ "$(uname -s)" == Linux && "$EUID" -eq 0 ]] || die E_LINUX_ROOT
  for command in awk basename bash chmod cmp cp curl date dirname docker flock grep mktemp mv python3 readlink rm sha256sum sleep sort stat systemctl; do
    command -v "$command" >/dev/null || die "E_COMMAND:$command"
  done
}

validate_pins() {
  [[ "$RUNTIME_ROOT" == /* && "$SOURCE_MANIFEST" == /* && "$RUNTIME_ENV" == /* && "$NODE_BINARY" == /* && "$DEPLOY_SNAPSHOT" == /* ]] || die E_ABSOLUTE_DEPLOYMENT_PINS_REQUIRED
  [[ -n "$CONTAINER" && "$CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$ ]] || die E_CONTAINER_PIN
  for digest in "$SOURCE_MANIFEST_SHA256" "$OPERATOR_SHA256" "$RUNTIME_ENV_SHA256" "$NODE_BINARY_SHA256" "$DEPLOY_SNAPSHOT_SHA256"; do
    [[ "$digest" =~ ^[a-f0-9]{64}$ ]] || die E_SHA256_PIN
  done
}

check_artifacts() {
  assert_protected_directory "$RUNTIME_ROOT"
  check_sha "$SOURCE_MANIFEST_SHA256" "$SOURCE_MANIFEST"
  assert_release_file "$OPERATOR" "$OPERATOR_SHA256"
  check_sha "$RUNTIME_ENV_SHA256" "$RUNTIME_ENV" 600
  check_sha "$NODE_BINARY_SHA256" "$NODE_BINARY"
  [[ -x "$NODE_BINARY" ]] || die E_NODE_NOT_EXECUTABLE
  check_sha "$DEPLOY_SNAPSHOT_SHA256" "$DEPLOY_SNAPSHOT" 600
  python3 - "$DEPLOY_SNAPSHOT" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    if archive.testzip() is not None:
        raise SystemExit("deploy snapshot CRC failure")
    names = archive.namelist()
    if not names or not any(name.startswith("_storage/") for name in names):
        raise SystemExit("deploy snapshot lacks file storage")
PY
}

verify_source_tree() {
  (cd "$RUNTIME_ROOT" && sha256sum --quiet -c "$SOURCE_MANIFEST") || die E_SOURCE_HASH
  python3 - "$RUNTIME_ROOT" "$SOURCE_MANIFEST" <<'PY'
import os
import re
import stat
import sys

root = os.path.realpath(sys.argv[1])
manifest = os.path.realpath(sys.argv[2])
expected = []
with open(manifest, encoding="utf-8") as source:
    for raw in source:
        parts = raw.rstrip("\n").split("  ", 1)
        if (
            len(parts) != 2
            or not re.fullmatch(r"[a-f0-9]{64}", parts[0])
            or not parts[1]
            or parts[1].startswith("/")
            or ".." in parts[1].split("/")
        ):
            raise SystemExit("unsafe source manifest")
        expected.append(parts[1])
if len(expected) != len(set(expected)):
    raise SystemExit("duplicate source manifest path")

actual = []
for base, directories, files in os.walk(root, topdown=True, followlinks=False):
    directories.sort()
    files.sort()
    if base == root:
        directories[:] = [name for name in directories if name not in {".next", "node_modules"}]
    for name in directories:
        path = os.path.join(base, name)
        info = os.lstat(path)
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise SystemExit(f"unsafe source directory: {path}")
        if info.st_uid != 0 or info.st_gid != 0 or info.st_mode & 0o7002:
            raise SystemExit(f"unprotected source directory: {path}")
    for name in files:
        path = os.path.join(base, name)
        info = os.lstat(path)
        relative = os.path.relpath(path, root)
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise SystemExit(f"unsafe source file: {relative}")
        if info.st_uid != 0 or info.st_gid != 0 or info.st_mode & 0o7002:
            raise SystemExit(f"unprotected source file: {relative}")
        actual.append(relative)
if sorted(expected) != sorted(actual):
    raise SystemExit("source path set differs from manifest")
PY
}

assert_automation_ready() {
  local found expected unit
  found="$(systemctl list-unit-files --no-legend --no-pager 'ig-event-*.service' 'ig-event-*.timer' | awk '{print $1}' | sort -u)"
  expected="$(printf '%s\n' \
    ig-event-discover.service \
    ig-event-discover.timer \
    ig-event-durable-daily.service \
    ig-event-durable-daily.timer \
    ig-event-following-discovery.service \
    ig-event-following-discovery.timer \
    ig-event-ingest.service \
    ig-event-ingest.timer \
    ig-event-schedule-watchdog.service \
    ig-event-schedule-watchdog.timer | sort)"
  [[ "$found" == "$expected" ]] || die E_SYSTEMD_UNIT_SET
  for unit in ig-event-durable-daily.timer ig-event-following-discovery.timer; do
    [[ "$(systemctl is-enabled "$unit")" == enabled ]] || die "E_TIMER_NOT_ENABLED:$unit"
    [[ "$(systemctl is-active "$unit")" == active ]] || die "E_TIMER_NOT_ACTIVE:$unit"
  done
  for unit in ig-event-discover.service ig-event-durable-daily.service ig-event-following-discovery.service ig-event-ingest.service ig-event-schedule-watchdog.service; do
    [[ "$(systemctl is-active "$unit" 2>/dev/null || true)" == inactive ]] || die "E_SERVICE_ACTIVE:$unit"
  done
  for unit in ig-event-discover.timer ig-event-ingest.timer ig-event-schedule-watchdog.timer; do
    [[ "$(systemctl is-enabled "$unit" 2>/dev/null || true)" == disabled ]] || die "E_TIMER_ENABLED:$unit"
    [[ "$(systemctl is-active "$unit" 2>/dev/null || true)" == inactive ]] || die "E_TIMER_ACTIVE:$unit"
  done
}

assert_maintenance_window() {
  local now next_text next_epoch unit
  now=$(date +%s)
  for unit in ig-event-durable-daily.timer ig-event-following-discovery.timer; do
    next_text=$(systemctl show -p NextElapseUSecRealtime --value "$unit")
    [[ -n "$next_text" ]] || die "E_TIMER_NEXT_EMPTY:$unit"
    next_epoch=$(date -d "$next_text" +%s) || die "E_TIMER_NEXT_PARSE:$unit"
    [[ "$next_epoch" -ge $((now + 3600)) ]] || die "E_TIMER_MAINTENANCE_WINDOW:$unit"
  done
}

verify_container() {
  local state mounts
  state=$(docker inspect -f '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.RestartCount}}' "$CONTAINER") || die E_CONTAINER_INSPECT
  [[ "$state" == true\|healthy\|0 ]] || die E_CONTAINER_STATE
  mounts=$(docker inspect -f '{{range .Mounts}}{{printf "%s|%s|%t|%s\n" .Source .Destination .RW .Type}}{{end}}' "$CONTAINER")
  [[ $'\n'"$mounts"$'\n' == *$'\n'"$RUNTIME_ROOT|/app|false|bind"$'\n'* ]] || die E_CONTAINER_RUNTIME_MOUNT
}

acquire_locks() {
  [[ -d /run/lock && ! -L /run/lock && "$(stat -c '%U:%G' /run/lock)" == root:root ]] || die E_LOCK_DIRECTORY
  [[ ! -e "$INGESTION_LOCK" || ( -f "$INGESTION_LOCK" && ! -L "$INGESTION_LOCK" ) ]] || die E_INGESTION_LOCK_PATH
  [[ ! -e "$FOLLOWING_LOCK" || ( -f "$FOLLOWING_LOCK" && ! -L "$FOLLOWING_LOCK" ) ]] || die E_FOLLOWING_LOCK_PATH
  exec 7>"$INGESTION_LOCK"
  FD7_OPEN=1
  flock -n 7 || die E_INGESTION_LOCK_HELD
  exec 8>"$FOLLOWING_LOCK"
  FD8_OPEN=1
  flock -n 8 || die E_FOLLOWING_LOCK_HELD
}

release_locks() {
  if [[ "$FD8_OPEN" -eq 1 ]]; then flock -u 8 2>/dev/null || true; exec 8>&-; FD8_OPEN=0; fi
  if [[ "$FD7_OPEN" -eq 1 ]]; then flock -u 7 2>/dev/null || true; exec 7>&-; FD7_OPEN=0; fi
}

canonical_plan_sha256() {
  local file=$1
  "$NODE_BINARY" --input-type=module -e '
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const envelope = JSON.parse(readFileSync(process.argv[1], "utf8"));
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}
process.stdout.write(createHash("sha256").update(JSON.stringify(canonicalize(envelope.plan))).digest("hex") + "\n");
' "$file"
}

validate_plan_envelope() {
  local file=$1 phase=$2 expected_digest=${3-} embedded recomputed
  embedded=$(python3 - "$file" "$phase" "$expected_digest" <<'PY'
import json
import os
import re
import stat
import sys

path, phase, expected_digest = sys.argv[1:]
info = os.lstat(path)
if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or not 0 < info.st_size <= 8 * 1024 * 1024:
    raise SystemExit("unsafe plan file")
def no_duplicates(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON key: {key}")
        value[key] = item
    return value
with open(path, encoding="utf-8") as source:
    envelope = json.load(source, object_pairs_hook=no_duplicates)
if set(envelope) != {"schemaVersion", "planSha256", "plan"}:
    raise SystemExit("invalid plan envelope shape")
if envelope["schemaVersion"] != "event-zeka-reviewed-venue-dedupe-plan-envelope-v1":
    raise SystemExit("invalid plan envelope schema")
digest = envelope["planSha256"]
if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
    raise SystemExit("invalid plan digest")
if expected_digest and digest != expected_digest:
    raise SystemExit("reviewed plan digest mismatch")
plan = envelope["plan"]
schema = {
    "config": "event-zeka-reviewed-venue-dedupe-config-plan-v1",
    "events": "event-zeka-reviewed-venue-dedupe-event-plan-v1",
}[phase]
count = {"config": 12, "events": 7}[phase]
if not isinstance(plan, dict) or plan.get("phase") != phase or plan.get("schemaVersion") != schema:
    raise SystemExit("invalid plan phase/schema")
if plan.get("targetSetVersion") != "event-zeka-reviewed-venue-dedupe-learning-2026-08-27:v2":
    raise SystemExit("invalid plan target version")
operations = plan.get("operations")
if not isinstance(operations, list) or len(operations) != count:
    raise SystemExit("invalid plan operation count")
keys = [row.get("key") for row in operations if isinstance(row, dict)]
if len(keys) != count or any(not isinstance(key, str) for key in keys) or len(set(keys)) != count:
    raise SystemExit("invalid plan operation keys")
print(digest)
PY
  )
  recomputed=$(canonical_plan_sha256 "$file")
  [[ "$embedded" == "$recomputed" ]] || die E_PLAN_CANONICAL_DIGEST
  printf '%s\n' "$embedded"
}

verify_audit_manifest() {
  local directory=$1
  python3 - "$directory" <<'PY'
import hashlib
import os
import re
import stat
import sys

root = sys.argv[1]
manifest = os.path.join(root, "artifact-sha256.txt")
expected = {}
with open(manifest, encoding="utf-8") as source:
    for raw in source:
        parts = raw.rstrip("\n").split("  ", 1)
        if len(parts) != 2 or not re.fullmatch(r"[a-f0-9]{64}", parts[0]) or not re.fullmatch(r"[A-Za-z0-9._-]+", parts[1]) or parts[1] in expected:
            raise SystemExit("invalid audit manifest")
        expected[parts[1]] = parts[0]
if set(os.listdir(root)) - {"artifact-sha256.txt"} != set(expected):
    raise SystemExit("audit artifact set differs from manifest")
for name, digest in expected.items():
    path = os.path.join(root, name)
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        raise SystemExit("unsafe audit artifact")
    value = hashlib.sha256(open(path, "rb").read()).hexdigest()
    if value != digest:
        raise SystemExit("audit digest mismatch")
PY
}

require_line() {
  grep -Fqx -- "$2" "$1" || die "E_GATE:$2"
}

verify_reviewed_plan_context() {
  local directory gate outcome embedded
  [[ "$PLAN_FILE" == "$(readlink -f -- "$PLAN_FILE")" ]] || die E_PLAN_PATH_CANONICAL
  [[ "$(basename -- "$PLAN_FILE")" == "$PHASE-plan.json" ]] || die E_PLAN_FILENAME
  directory=$(dirname -- "$PLAN_FILE")
  case "$directory" in
    /root/backups/event-zeka-reviewed-venue-dedupe-"$PHASE"-dry-run-*) ;;
    *) die E_PLAN_AUDIT_DIRECTORY ;;
  esac
  assert_protected_directory "$directory" 700
  assert_protected_file "$PLAN_FILE" 600
  for gate in gate.txt outcome.txt artifact-sha256.txt; do assert_protected_file "$directory/$gate" 600; done
  verify_audit_manifest "$directory"
  gate="$directory/gate.txt"
  outcome="$directory/outcome.txt"
  REVIEWED_PLAN_FILE_SHA256=$(sha256_of "$PLAN_FILE")
  require_line "$gate" "schema_version=$RUNNER_SCHEMA"
  require_line "$gate" "phase=$PHASE"
  require_line "$gate" "mode=dry-run"
  require_line "$gate" "runtime_root=$RUNTIME_ROOT"
  require_line "$gate" "source_manifest=$SOURCE_MANIFEST"
  require_line "$gate" "source_manifest_sha256=$SOURCE_MANIFEST_SHA256"
  require_line "$gate" "operator_sha256=$OPERATOR_SHA256"
  require_line "$gate" "runtime_env=$RUNTIME_ENV"
  require_line "$gate" "runtime_env_sha256=$RUNTIME_ENV_SHA256"
  require_line "$gate" "node_binary=$NODE_BINARY"
  require_line "$gate" "node_binary_sha256=$NODE_BINARY_SHA256"
  require_line "$gate" "deploy_snapshot=$DEPLOY_SNAPSHOT"
  require_line "$gate" "deploy_snapshot_sha256=$DEPLOY_SNAPSHOT_SHA256"
  require_line "$gate" "container=$CONTAINER"
  require_line "$gate" "plan_sha256=$PLAN_SHA256"
  require_line "$gate" "plan_file_sha256=$REVIEWED_PLAN_FILE_SHA256"
  require_line "$outcome" outcome=success
  require_line "$outcome" exit_code=0
  embedded=$(validate_plan_envelope "$PLAN_FILE" "$PHASE" "$PLAN_SHA256")
  [[ "$embedded" == "$PLAN_SHA256" ]] || die E_PLAN_DIGEST
}

write_gate() {
  {
    printf 'schema_version=%s\n' "$RUNNER_SCHEMA"
    printf 'phase=%s\n' "$PHASE"
    printf 'mode=%s\n' "$MODE"
    printf 'runtime_root=%s\n' "$RUNTIME_ROOT"
    printf 'source_manifest=%s\n' "$SOURCE_MANIFEST"
    printf 'source_manifest_sha256=%s\n' "$SOURCE_MANIFEST_SHA256"
    printf 'operator_sha256=%s\n' "$OPERATOR_SHA256"
    printf 'runtime_env=%s\n' "$RUNTIME_ENV"
    printf 'runtime_env_sha256=%s\n' "$RUNTIME_ENV_SHA256"
    printf 'node_binary=%s\n' "$NODE_BINARY"
    printf 'node_binary_sha256=%s\n' "$NODE_BINARY_SHA256"
    printf 'deploy_snapshot=%s\n' "$DEPLOY_SNAPSHOT"
    printf 'deploy_snapshot_sha256=%s\n' "$DEPLOY_SNAPSHOT_SHA256"
    printf 'container=%s\n' "$CONTAINER"
    [[ -z "$PLAN_FILE" ]] || {
      printf 'reviewed_plan=%s\n' "$PLAN_FILE"
      printf 'plan_sha256=%s\n' "$PLAN_SHA256"
      printf 'plan_file_sha256=%s\n' "$REVIEWED_PLAN_FILE_SHA256"
    }
    printf 'started_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$AUDIT_DIR/gate.txt"
}

capture_state() {
  local label=$1
  docker inspect -f '{{.Name}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.RestartCount}}|{{.Config.Image}}' "$CONTAINER" >"$AUDIT_DIR/container-$label.txt"
  systemctl show -p Id -p LoadState -p ActiveState -p UnitFileState -p NextElapseUSecRealtime ig-event-durable-daily.timer ig-event-following-discovery.timer >"$AUDIT_DIR/timers-$label.txt"
}

finalize_audit() {
  local outcome=$1 exit_code=$2 file
  [[ -n "$AUDIT_DIR" && -d "$AUDIT_DIR" ]] || return 0
  {
    printf 'outcome=%s\n' "$outcome"
    printf 'exit_code=%s\n' "$exit_code"
    printf 'finished_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$AUDIT_DIR/outcome.txt"
  for file in "$AUDIT_DIR"/*; do [[ ! -f "$file" || -L "$file" ]] || chmod 0600 "$file"; done
  (
    cd "$AUDIT_DIR"
    for file in *; do
      [[ -f "$file" && ! -L "$file" && "$file" != artifact-sha256.txt ]] || continue
      sha256sum -- "$file"
    done
  ) >"$AUDIT_DIR/.artifact-sha256.tmp"
  chmod 0600 "$AUDIT_DIR/.artifact-sha256.tmp"
  mv -f "$AUDIT_DIR/.artifact-sha256.tmp" "$AUDIT_DIR/artifact-sha256.txt"
  chmod 0600 "$AUDIT_DIR/artifact-sha256.txt"
}

cleanup_on_exit() {
  local code=$?
  trap - EXIT INT TERM HUP
  set +e
  if [[ "$FINALIZED" -ne 1 && -n "$AUDIT_DIR" && -d "$AUDIT_DIR" ]]; then
    capture_state failure-after >/dev/null 2>&1 || true
    finalize_audit failure "$code" || true
  fi
  release_locks
  exit "$code"
}

run_operator() {
  local phase=$1 mode=$2 plan=${3-} digest=${4-} confirmation=${5-}
  local -a args=(--phase "$phase" --mode "$mode")
  if [[ -n "$plan" ]]; then
    args+=(--plan-file "$plan" --expected-plan-sha256 "$digest")
  fi
  [[ "$mode" != apply ]] || args+=(--confirm "$confirmation")
  (
    cd "$RUNTIME_ROOT"
    /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
      "$NODE_BINARY" --env-file="$RUNTIME_ENV" \
      --import "$REGISTER_PATHS" \
      --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
      --experimental-strip-types \
      "$OPERATOR" "${args[@]}"
  )
}

validate_result() {
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import json
import sys

path, phase, mode, digest = sys.argv[1:]
with open(path, encoding="utf-8") as source:
    value = json.load(source)
if value.get("schemaVersion") != "event-zeka-reviewed-venue-dedupe-result-v1" or value.get("phase") != phase or value.get("mode") != mode:
    raise SystemExit("invalid operator result identity")
mutations = value.get("productionMutations")
if not isinstance(mutations, int) or isinstance(mutations, bool) or mutations < 0:
    raise SystemExit("invalid mutation count")
if value.get("planSha256") != digest:
    raise SystemExit("invalid result plan digest")
if mode == "status":
    if mutations != 0 or value.get("complete") is not True:
        raise SystemExit("status is incomplete")
else:
    if value.get("status") != "complete":
        raise SystemExit("apply is incomplete")
    verification = value.get("verification", {})
    if phase == "config" and verification.get("complete") is not True:
        raise SystemExit("config verification is incomplete")
    if phase == "events" and (verification.get("events", {}).get("complete") is not True or verification.get("config", {}).get("complete") is not True):
        raise SystemExit("event verification is incomplete")
PY
}

copy_reviewed_plan() {
  local copy="$AUDIT_DIR/reviewed-$PHASE-plan.json"
  cp -- "$PLAN_FILE" "$copy"
  chmod 0600 "$copy"
  cmp -s -- "$PLAN_FILE" "$copy" || die E_PLAN_COPY
  [[ "$(sha256_of "$copy")" == "$REVIEWED_PLAN_FILE_SHA256" ]] || die E_PLAN_COPY_SHA256
  [[ "$(validate_plan_envelope "$copy" "$PHASE" "$PLAN_SHA256")" == "$PLAN_SHA256" ]] || die E_PLAN_COPY_DIGEST
  printf '%s\n' "$copy"
}

capture_reconciliation_status() {
  local plan=$1
  run_operator "$PHASE" status "$plan" "$PLAN_SHA256" >"$AUDIT_DIR/reconciliation-status.json" 2>"$AUDIT_DIR/reconciliation-status.stderr" || true
}

verify_public_after_apply() {
  local name url temporary attempt
  for name in health ready; do
    url="https://eventzeka.com/api/$name"
    temporary="$AUDIT_DIR/.public-$name.tmp"
    : >"$AUDIT_DIR/public-$name.stderr"
    for attempt in 1 2 3 4 5 6; do
      if curl --disable --fail --silent --show-error --max-time 20 "$url" >"$temporary" 2>>"$AUDIT_DIR/public-$name.stderr"; then
        mv "$temporary" "$AUDIT_DIR/public-$name.json"
        break
      fi
      [[ "$attempt" -eq 6 ]] || sleep 5
    done
    [[ -f "$AUDIT_DIR/public-$name.json" ]] || die "E_PUBLIC_$name"
  done
  python3 - "$AUDIT_DIR/public-health.json" "$AUDIT_DIR/public-ready.json" <<'PY'
import json
import sys
health = json.load(open(sys.argv[1], encoding="utf-8"))
ready = json.load(open(sys.argv[2], encoding="utf-8"))
if health.get("ok") is not True or health.get("service") != "ig-event" or ready.get("ok") is not True:
    raise SystemExit("public health/readiness is invalid")
PY
}

run_dry_run() {
  local plan="$AUDIT_DIR/$PHASE-plan.json" digest
  run_operator "$PHASE" dry-run >"$plan" 2>"$AUDIT_DIR/$PHASE-dry-run.stderr" || die "E_OPERATOR_DRY_RUN:$PHASE"
  chmod 0600 "$plan"
  digest=$(validate_plan_envelope "$plan" "$PHASE")
  PLAN_SHA256=$digest
  {
    printf 'plan_sha256=%s\n' "$digest"
    printf 'plan_file_sha256=%s\n' "$(sha256_of "$plan")"
  } >>"$AUDIT_DIR/gate.txt"
}

run_apply() {
  local copy output exit_code
  copy=$(copy_reviewed_plan)
  output="$AUDIT_DIR/$PHASE-apply.json"
  set +e
  run_operator "$PHASE" apply "$copy" "$PLAN_SHA256" "$CONFIRMATION" >"$output" 2>"$AUDIT_DIR/$PHASE-apply.stderr"
  exit_code=$?
  set -e
  if [[ "$exit_code" -ne 0 ]]; then
    capture_reconciliation_status "$copy"
    die "E_OPERATOR_APPLY:$PHASE:$exit_code"
  fi
  if ! validate_result "$output" "$PHASE" apply "$PLAN_SHA256"; then
    capture_reconciliation_status "$copy"
    die "E_OPERATOR_APPLY_RESULT:$PHASE"
  fi
  run_operator "$PHASE" status "$copy" "$PLAN_SHA256" >"$AUDIT_DIR/$PHASE-status-after.json" 2>"$AUDIT_DIR/$PHASE-status-after.stderr" || die "E_STATUS_AFTER_APPLY:$PHASE"
  validate_result "$AUDIT_DIR/$PHASE-status-after.json" "$PHASE" status "$PLAN_SHA256"
  verify_public_after_apply
}

run_status() {
  local copy
  copy=$(copy_reviewed_plan)
  run_operator "$PHASE" status "$copy" "$PLAN_SHA256" >"$AUDIT_DIR/$PHASE-status.json" 2>"$AUDIT_DIR/$PHASE-status.stderr" || die "E_OPERATOR_STATUS:$PHASE"
  validate_result "$AUDIT_DIR/$PHASE-status.json" "$PHASE" status "$PLAN_SHA256"
}

parse_command "$@"
need_linux_root
validate_pins
check_artifacts
verify_source_tree
assert_automation_ready
assert_maintenance_window
verify_container
if [[ "$MODE" != dry-run ]]; then verify_reviewed_plan_context; fi
acquire_locks
assert_automation_ready
assert_maintenance_window

AUDIT_DIR=$(mktemp -d "/root/backups/event-zeka-reviewed-venue-dedupe-$PHASE-$MODE-XXXXXXXX")
chmod 0700 "$AUDIT_DIR"
trap cleanup_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
write_gate
capture_state before

case "$MODE" in
  dry-run) run_dry_run ;;
  apply) run_apply ;;
  status) run_status ;;
esac

verify_source_tree
verify_container
assert_automation_ready
capture_state after
finalize_audit success 0
verify_audit_manifest "$AUDIT_DIR"
FINALIZED=1
release_locks
trap - EXIT INT TERM HUP

printf 'reviewed_venue_dedupe_runner_status=%s-%s-complete\n' "$PHASE" "$MODE"
printf 'audit_dir=%s\n' "$AUDIT_DIR"
if [[ "$MODE" == dry-run ]]; then
  printf 'reviewed_plan=%s/%s-plan.json\n' "$AUDIT_DIR" "$PHASE"
  printf 'plan_sha256=%s\n' "$PLAN_SHA256"
  printf 'plan_file_sha256=%s\n' "$(sha256_of "$AUDIT_DIR/$PHASE-plan.json")"
fi

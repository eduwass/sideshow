#!/usr/bin/env bash
#
# Back up (and restore) a private Sideshow SQLite workspace, verifiably.
#
# Why not `cp sideshow.db backup.db`: the server runs SQLite in WAL mode, so at
# any moment an arbitrary amount of committed data lives in the sidecar
# `sideshow.db-wal` and not in the `.db` file at all. The devbox service's WAL
# was 4.7 MB against a 14 MB database — a plain copy of the `.db` alone would
# silently lose every write in it, and copying the three files separately while
# the server is running gives you a torn set. `VACUUM INTO` runs inside a read
# transaction, so the copy it writes is a single consistent point-in-time image
# with the WAL already folded in, taken WITHOUT stopping the service.
#
# The source database is opened READ-ONLY throughout: a read-write connection
# could checkpoint or truncate the live WAL on close, i.e. the backup would
# mutate the thing it is backing up.
#
# Usage:
#   scripts/backup-sideshow.sh <source.db> <destination-dir> [--force]
#   scripts/backup-sideshow.sh --restore <backup.db> <target.db> [--force]
#   scripts/backup-sideshow.sh --help

set -euo pipefail

PROG="$(basename "$0")"

usage() {
  cat <<'USAGE'
Back up a Sideshow SQLite workspace with SQLite's own VACUUM INTO, then verify
the copy (integrity check + per-table row counts against the source).

  backup-sideshow.sh <source.db> <destination-dir> [--force]
      Writes <destination-dir>/<name>-<UTC timestamp>.db plus a .sha256 sidecar.

  backup-sideshow.sh --restore <backup.db> <target.db> [--force]
      Restores a backup to <target.db> and verifies it the same way.
      Stop the sideshow service first: `systemctl --user stop sideshow`.

  backup-sideshow.sh --help

Options:
  --force   Overwrite an existing destination file / restore target.
            Without it, an existing target is an error and nothing is written.

Exit status is non-zero if anything fails to verify. Uses the `sqlite3` CLI when
it is on PATH, otherwise Node's built-in `node:sqlite` (Node >= 22.18).
USAGE
}

die() {
  echo "$PROG: $*" >&2
  exit 1
}

# --- SQLite engine ------------------------------------------------------------
# One of two backends, chosen at runtime. Both speak the same two primitives:
# `sql_ro <db> <sql>` (read-only query, pipe-separated rows) and
# `db_copy <src> <dst>` (consistent copy via VACUUM INTO).

NODE_HELPER=""
cleanup() {
  if [ -n "$NODE_HELPER" ]; then rm -f "$NODE_HELPER"; fi
}
trap cleanup EXIT

ENGINE=""
select_engine() {
  if command -v sqlite3 >/dev/null 2>&1; then
    ENGINE="sqlite3"
    return
  fi
  command -v node >/dev/null 2>&1 || die "neither sqlite3 nor node is on PATH"
  ENGINE="node"
  NODE_HELPER="$(mktemp -t sideshow-backup-XXXXXX.mjs)"
  cat >"$NODE_HELPER" <<'HELPER'
import { DatabaseSync } from "node:sqlite";

const [mode, dbPath, arg] = process.argv.slice(2);
// Read-only so a backup can never checkpoint or truncate the live WAL.
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  if (mode === "copy") {
    db.prepare("VACUUM INTO ?").run(arg);
  } else if (mode === "query") {
    for (const row of db.prepare(arg).all()) {
      console.log(Object.values(row).join("|"));
    }
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} finally {
  db.close();
}
HELPER
}

# Escape a path for embedding in a single-quoted SQL string literal.
sql_quote() { printf "%s" "${1//\'/\'\'}"; }

sql_ro() {
  local db="$1" sql="$2"
  if [ "$ENGINE" = "sqlite3" ]; then
    sqlite3 -readonly -noheader -separator '|' "$db" "$sql"
  else
    node --disable-warning=ExperimentalWarning "$NODE_HELPER" query "$db" "$sql"
  fi
}

db_copy() {
  local src="$1" dst="$2"
  if [ "$ENGINE" = "sqlite3" ]; then
    sqlite3 -readonly "$src" "VACUUM INTO '$(sql_quote "$dst")'"
  else
    node --disable-warning=ExperimentalWarning "$NODE_HELPER" copy "$src" "$dst"
  fi
}

# --- verification -------------------------------------------------------------

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "no sha256sum or shasum on PATH"
  fi
}

integrity_check() {
  local db="$1" result
  result="$(sql_ro "$db" "PRAGMA integrity_check;")"
  [ "$result" = "ok" ] || die "integrity check failed for $db: $result"
}

# "table|rowcount" for every user table, sorted. Empty when a database has no
# tables at all, which is itself a difference worth catching.
table_counts() {
  local db="$1" tables sql=""
  tables="$(sql_ro "$db" \
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;")"
  [ -n "$tables" ] || return 0
  while IFS= read -r table; do
    [ -n "$table" ] || continue
    [ -n "$sql" ] && sql+=" UNION ALL "
    sql+="SELECT '$(sql_quote "$table")' AS t, count(*) AS n FROM \"$table\""
  done <<<"$tables"
  sql_ro "$db" "$sql ORDER BY t;"
}

# Compare the copy against the source's row counts. The source may be a LIVE
# database — a running sideshow keeps writing while VACUUM INTO reads — so the
# counts are sampled before and after the copy:
#
#   - source unchanged during the copy (a stopped or idle service, and always
#     true when verifying a restore): the copy must match EXACTLY;
#   - source moved during the copy: the copy is still a consistent snapshot, but
#     it is a snapshot of some instant inside that window, so each table's count
#     must land between the two samples. Anything outside is a real failure.
#
# Args: <copy> <counts before> <counts after>. Fails (non-zero) on any mismatch.
verify_copy() {
  local copy="$1" before="$2" after="$3"
  integrity_check "$copy"
  local copy_counts
  copy_counts="$(table_counts "$copy")"

  if [ "$before" = "$after" ]; then
    if [ "$copy_counts" != "$before" ]; then
      echo "$PROG: row counts in $copy do not match the source" >&2
      diff <(echo "$before") <(echo "$copy_counts") >&2 || true
      return 1
    fi
    local tables
    tables="$(echo "$copy_counts" | grep -c . || true)"
    echo "  verified: integrity_check ok, $tables tables with matching row counts"
    return 0
  fi

  echo "  note: the source changed while it was being copied (it is live)" >&2
  local table lo hi got
  while IFS='|' read -r table lo; do
    [ -n "$table" ] || continue
    hi="$(echo "$after" | awk -F'|' -v t="$table" '$1 == t { print $2 }')"
    got="$(echo "$copy_counts" | awk -F'|' -v t="$table" '$1 == t { print $2 }')"
    [ -n "$hi" ] || die "table $table disappeared from the source mid-backup"
    [ -n "$got" ] || die "table $table is missing from $copy"
    if [ "$hi" -lt "$lo" ]; then
      local swap="$lo"
      lo="$hi"
      hi="$swap"
    fi
    if [ "$got" -lt "$lo" ] || [ "$got" -gt "$hi" ]; then
      echo "$PROG: $table has $got rows in $copy, outside the source's $lo..$hi" >&2
      return 1
    fi
  done <<<"$before"
  echo "  verified: integrity_check ok, every table within the live source's range"
}

# Refuse to clobber unless --force; --force also clears the sidecars, because a
# stale -wal next to a fresh .db is a corrupt pair.
prepare_target() {
  local target="$1" force="$2"
  if [ -e "$target" ]; then
    [ "$force" = "1" ] || die "$target already exists (pass --force to overwrite)"
    rm -f "$target" "$target-wal" "$target-shm"
  elif [ -e "$target-wal" ] || [ -e "$target-shm" ]; then
    [ "$force" = "1" ] || die "$target-wal/-shm exist without $target (pass --force)"
    rm -f "$target-wal" "$target-shm"
  fi
}

# --- commands -----------------------------------------------------------------

do_backup() {
  local src="$1" dest_dir="$2" force="$3"
  [ -f "$src" ] || die "source database not found: $src"
  [ -r "$src" ] || die "source database is not readable: $src"
  mkdir -p "$dest_dir"

  local stamp name out
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  name="$(basename "$src")"
  name="${name%.db}"
  out="$dest_dir/$name-$stamp.db"
  prepare_target "$out" "$force"

  echo "$PROG: backing up $src -> $out (engine: $ENGINE)"
  if [ -f "$src-wal" ]; then
    echo "  source has a live WAL ($(wc -c <"$src-wal") bytes); VACUUM INTO folds it in"
  fi
  integrity_check "$src"
  local before after
  before="$(table_counts "$src")"
  db_copy "$src" "$out"
  after="$(table_counts "$src")"

  local sum
  sum="$(sha256_of "$out")"
  printf '%s  %s\n' "$sum" "$(basename "$out")" >"$out.sha256"

  # A copy that fails verification must not be left sitting in the backup
  # directory where someone could restore it at 3am.
  if ! verify_copy "$out" "$before" "$after"; then
    rm -f "$out" "$out.sha256"
    die "backup failed verification; removed $out"
  fi
  echo "  sha256: $sum"
  echo "  checksum file: $out.sha256"
  echo "$PROG: backup complete"
}

do_restore() {
  local backup="$1" target="$2" force="$3"
  [ -f "$backup" ] || die "backup not found: $backup"

  if [ -f "$backup.sha256" ]; then
    local expected actual
    expected="$(awk '{print $1}' <"$backup.sha256")"
    actual="$(sha256_of "$backup")"
    [ "$expected" = "$actual" ] ||
      die "checksum mismatch for $backup (expected $expected, got $actual)"
    echo "$PROG: checksum ok ($actual)"
  else
    echo "$PROG: warning: no $backup.sha256 sidecar; skipping checksum check" >&2
  fi

  integrity_check "$backup"
  prepare_target "$target" "$force"
  mkdir -p "$(dirname "$target")"

  echo "$PROG: restoring $backup -> $target (engine: $ENGINE)"
  echo "  the sideshow service must be stopped first (systemctl --user stop sideshow)"
  # A backup file is static, so both samples are the same and the comparison is
  # exact.
  local counts
  counts="$(table_counts "$backup")"
  db_copy "$backup" "$target"
  if ! verify_copy "$target" "$counts" "$counts"; then
    die "restored database failed verification; $target is NOT usable"
  fi
  echo "$PROG: restore complete"
}

# --- argument parsing ---------------------------------------------------------

FORCE=0
RESTORE=0
POSITIONAL=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --force)
      FORCE=1
      ;;
    --restore)
      RESTORE=1
      ;;
    --)
      shift
      while [ $# -gt 0 ]; do
        POSITIONAL+=("$1")
        shift
      done
      break
      ;;
    -*)
      die "unknown option: $1 (see --help)"
      ;;
    *)
      POSITIONAL+=("$1")
      ;;
  esac
  shift
done

[ "${#POSITIONAL[@]}" -eq 2 ] || {
  usage >&2
  exit 2
}

select_engine
if [ "$RESTORE" = "1" ]; then
  do_restore "${POSITIONAL[0]}" "${POSITIONAL[1]}" "$FORCE"
else
  do_backup "${POSITIONAL[0]}" "${POSITIONAL[1]}" "$FORCE"
fi

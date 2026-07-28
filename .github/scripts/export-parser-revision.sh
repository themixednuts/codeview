#!/usr/bin/env bash
set -euo pipefail

# Freshness should change only when graph/artifact output can change. Using the
# repository commit makes UI, workflow, and documentation edits reparse every
# published crate.
revision="$(
  {
    git ls-tree -r HEAD -- \
      Cargo.toml \
      codeview-core \
      codeview-rustdoc \
      codeview-cli/Cargo.toml \
      codeview-cli/src/cron/parse_one.rs \
      codeview-cli/src/cron/parse_shard.rs \
      codeview-cli/src/cron/seed_std.rs \
      codeview-cli/src/sysroot.rs \
      codeview-cli/src/publisher
    sha256sum Cargo.lock
  } |
    sha256sum |
    cut -d' ' -f1
)"

echo "PARSER_REVISION=$revision" >>"$GITHUB_ENV"
echo "parser revision: ${revision:0:12}"

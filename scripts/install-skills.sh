#!/usr/bin/env bash
# install-skills.sh — copy openclaw/ skills into your Claude Code skills
# directory, replacing the literal token `career-ops` (the bare command in
# every SKILL.md) with the absolute path to this repo's invocation shim
# `scripts/career-ops`. After install, Claude can invoke any skill from
# any working directory without needing `career-ops` in PATH.
#
# Usage:
#   ./scripts/install-skills.sh                       # → ~/.claude/skills/career-ops/
#   ./scripts/install-skills.sh /path/to/skills       # → /path/to/skills/career-ops/
#
# Idempotent: re-run after pulling repo updates or moving the repo.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$REPO_ROOT/openclaw"
SHIM="$REPO_ROOT/scripts/career-ops"
TARGET_BASE="${1:-$HOME/.claude/skills}"
TARGET_DIR="$TARGET_BASE/career-ops"

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "error: $SOURCE_DIR does not exist — run from the repo." >&2
  exit 1
fi
if [[ ! -x "$SHIM" ]]; then
  chmod +x "$SHIM"
fi

mkdir -p "$TARGET_DIR"

# Detect a portable in-place sed (BSD sed on macOS needs '' arg).
if sed --version >/dev/null 2>&1; then
  SED_INPLACE=(sed -i)
else
  SED_INPLACE=(sed -i '')
fi

# Escape the shim path for safe sed substitution (in case it contains / or &).
SHIM_ESCAPED=$(printf '%s\n' "$SHIM" | sed 's/[\/&]/\\&/g')

shopt -s nullglob
installed=0

for src in "$SOURCE_DIR"/*/; do
  name="$(basename "$src")"
  [[ -f "$src/SKILL.md" ]] || continue

  dst="$TARGET_DIR/$name"
  rm -rf "$dst"
  cp -R "$src" "$dst"

  # Substitute the bare invocation token with the absolute shim path.
  # Matches `career-ops <subcommand>` only when it appears at the start of
  # a line or after typical code-block leading characters.
  while IFS= read -r -d '' f; do
    "${SED_INPLACE[@]}" \
      -e "s/^career-ops /$SHIM_ESCAPED /g" \
      -e "s/\`career-ops /\`$SHIM_ESCAPED /g" \
      "$f"
  done < <(find "$dst" -type f -name '*.md' -print0)

  installed=$((installed + 1))
done

echo "✔ Installed $installed skill(s) → $TARGET_DIR"
echo "  Repo root:    $REPO_ROOT"
echo "  Invocation:   $SHIM <subcommand>"
echo
echo "Next: in Claude Code, ask something like 'find me grad python jobs this week'"
echo "and the agent will route to the right skill via the absolute path baked above."

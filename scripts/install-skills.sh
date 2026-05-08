#!/usr/bin/env bash
# Install career-ops openclaw skills into a Claude Code skills directory.
#
# Usage:
#   ./scripts/install-skills.sh                       # → ~/.claude/skills/career-ops/
#   ./scripts/install-skills.sh /path/to/skills       # → /path/to/skills/career-ops/
#
# Idempotent: re-run after pulling repo updates or moving the repo.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_BASE="${1:-$HOME/.claude/skills}"
TARGET_DIR="$TARGET_BASE/career-ops"

mkdir -p "$TARGET_DIR"

# Symlink each skill subdirectory.
shopt -s nullglob
linked=0
for skill_dir in "$REPO_ROOT/openclaw"/*/; do
  skill_name="$(basename "$skill_dir")"
  # Skip non-skill files (e.g. README.md at the openclaw root would not match this glob).
  [[ -f "$skill_dir/SKILL.md" ]] || continue

  link_target="$TARGET_DIR/$skill_name"
  rm -rf "$link_target"
  ln -s "$skill_dir" "$link_target"
  linked=$((linked + 1))
done

echo "✔ Installed $linked skill(s) → $TARGET_DIR"
echo "  Repo root: $REPO_ROOT"
echo
echo "Next: in Claude Code, ask something like 'find me grad python jobs this week'"
echo "and the agent will auto-route to the right skill."

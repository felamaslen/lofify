#!/usr/bin/env sh
# Regenerate code that is checked in (Drizzle SQL schema, Grats GraphQL
# schema, gql.tada output) and stage any resulting changes. Runs against
# the staged tree only: unstaged tracked changes and untracked files are
# stashed for the duration and restored at the end.
#
# Generated files are deliberately left out of the stash. Codegen
# rewrites them while the stash is held, so restoring stashed copies on
# top would conflict; since they are derived purely from the sources,
# the restore instead reruns codegen so the worktree reflects the
# restored sources again.

set -e

STASH_LABEL="lofify-precommit-codegen-$$"

stash_pushed=0
if [ -n "$(git status --porcelain)" ]; then
  if git stash push --keep-index --include-untracked --quiet -m "$STASH_LABEL" -- \
    ':(exclude)packages/backend/src/db/__generated__' \
    ':(exclude)packages/backend/src/graphql/__generated__' \
    ':(exclude)packages/web/src/graphql-env.d.ts'; then
    if git stash list --format='%gs' | head -1 | grep -q "$STASH_LABEL"; then
      stash_pushed=1
    fi
  fi
fi

restore() {
  if [ "$stash_pushed" = "1" ]; then
    stash_pushed=0
    git stash pop --quiet || true
    if ! pnpm codegen >/dev/null 2>&1; then
      echo "precommit-codegen: codegen rerun after restoring the stash failed; run 'pnpm codegen' to refresh the worktree" >&2
    fi
  fi
}
trap restore EXIT INT TERM

pnpm codegen

git add \
  packages/backend/src/db/__generated__ \
  packages/backend/src/graphql/__generated__ \
  packages/web/src/graphql-env.d.ts 2>/dev/null || true

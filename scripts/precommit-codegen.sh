#!/usr/bin/env sh
# Regenerate code that is checked in (Drizzle SQL schema, Grats GraphQL
# schema, gql.tada output) and stage any resulting changes. Runs against
# the staged tree only: unstaged tracked changes and untracked files are
# stashed for the duration and restored at the end.

set -e

STASH_LABEL="lofify-precommit-codegen-$$"

stash_pushed=0
if [ -n "$(git status --porcelain)" ]; then
  if git stash push --keep-index --include-untracked --quiet -m "$STASH_LABEL"; then
    if git stash list --format='%gs' | head -1 | grep -q "$STASH_LABEL"; then
      stash_pushed=1
    fi
  fi
fi

restore() {
  if [ "$stash_pushed" = "1" ]; then
    git stash pop --quiet || true
  fi
}
trap restore EXIT INT TERM

pnpm codegen

git add \
  packages/backend/src/db/__generated__ \
  packages/backend/src/graphql/__generated__ \
  packages/web/src/graphql-env.d.ts 2>/dev/null || true

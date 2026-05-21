# CLAUDE.md

Working notes for Claude. Read once at the start of a session and follow
without being reminded.

## Source of truth

- [`README.md`](./README.md) (root) and per-package READMEs are the
  human-facing docs. **Update them whenever you make a non-trivial
  change** — new script, new env var, new package, new module under
  `src/`, restructured directories, changed dev/prod workflow, etc.
  Trivial changes (typo fixes, internal refactors with no external
  surface) do not need a README update.

## Style

- British English in all prose (code, comments, docs, commit messages).
- Default to writing no code comments. Only add one when the *why* is
  non-obvious.
- JSDoc paragraph rule: no newlines inside a JSDoc comment except to
  separate paragraphs. Applies to both Drizzle and GraphQL schemas.

## Schema

- DB schema (Drizzle, TS): document every column/table with JSDoc unless
  the purpose is obvious from the name. Never reference implementation
  details that callers don't need to know.
- GraphQL schema (grats): document every type/field/argument with JSDoc
  unless obvious. Never reference implementation details or anything the
  client doesn't need to know.
- GraphQL nullability: mutations always return non-null; queries always
  return nullable.
- Mutation noop return type: `type Void { _: Boolean }`.

## Tests

- Use `fastify.inject` to drive GraphQL operations end-to-end.
- Do not import implementation modules from tests. Assert only on
  observable HTTP/GraphQL responses. Tests are behavioural.

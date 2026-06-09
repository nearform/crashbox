# Contributing to crashbox

Thanks for contributing! This guide covers the local dev workflow and how releases work.

## Dev workflow

Source is plain JavaScript with **JSDoc type annotations** (no TypeScript transpile step) —
`tsc` runs in declaration-only mode to emit `dist/*.d.ts` for publication. Tests are plain JS
run with `node --test`.

```sh
npm run check    # lint + type-check (JSDoc) + tests + format check — run this before opening a PR
npm run format   # auto-fix: prettier + eslint --fix
npm test         # node --test
npm run build    # emit dist/*.d.ts (declaration only)
```

Architecture notes and the empirical research log live in [`docs/`](.); deeper contributor notes
(including the supply-chain dependency policy and version-control rules) are in
[`AGENTS.md`](../AGENTS.md). The full API reference is in [`API.md`](./API.md).

## Releasing with Changesets

crashbox uses [Changesets](https://github.com/changesets/changesets) for versioning and publishing.
Releases are automated: merging to `main` publishes to npm over OIDC — no manual `npm publish`.

### Add a changeset to your PR

If your change affects published behavior (a fix, feature, or anything users will notice), add a
changeset:

```sh
npx changeset
```

This prompts you to pick a bump type and write a summary, then writes a markdown file under
`.changeset/`. **Commit that file with your PR.**

- **Bump type** — `patch` (fixes), `minor` (backwards-compatible features), `major` (breaking
  changes). crashbox is pre-1.0, so in practice changes are `patch` or `minor` today.
- **Summary** — write it for the changelog reader: what changed and why it matters, not the
  internal mechanics.

PRs with **no user-facing change** (docs, CI, tests, refactors) don't need a changeset. To make
that explicit, you can run `npx changeset` and choose an empty changeset.

Check what's pending at any time:

```sh
npx changeset status
```

### What happens on merge

1. When PRs with changesets land on `main`, the [Release workflow](../.github/workflows/release.yml)
   opens (or updates) a **"Version Packages"** PR. That PR consumes the pending changesets, bumps
   `version` in `package.json`, and updates `CHANGELOG.md`.
2. **Merging the "Version Packages" PR** triggers `changeset publish`, which publishes the new
   version to npm. Authentication uses GitHub OIDC ([trusted publishing](https://docs.npmjs.com/trusted-publishers/)),
   so no npm token is stored in the repo, and npm provenance is attached automatically.

### One-time bootstrap (maintainers)

The very first publish is manual, because OIDC trusted publishing can only be configured against a
package that already exists on npm:

1. Publish `0.0.1` manually: `npm run build && npm publish`.
2. On npm, configure the **trusted publisher** for `crashbox`: GitHub org/repo `nearform/crashbox`,
   workflow `release.yml`, environment `Production`.
3. In GitHub repo settings, create the **`Production`** environment so the release job's
   `environment: Production` resolves and matches the npm trusted-publisher config.

After that, every release flows through the automated path above.

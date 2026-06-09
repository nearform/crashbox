# AGENTS.md

Notes for AI agents (and humans) working in this repo.

## Architecture in one paragraph

Source is plain JavaScript (`src/*.js`) with **JSDoc type annotations**, not TypeScript.
`tsc` runs in declaration-only mode and emits `dist/*.d.ts` files for publication; no `.js`
transpilation happens. Runtime consumers load `src/index.js` (via `main`); TypeScript
consumers load `dist/index.d.ts` (via `types`). Tests are also plain JS, run with the
built-in `node --test` runner — no ts-node loader.

## Commands

```
npm run lint         # eslint
npm run check:types  # tsc -p tsconfig.check.json  (validates JSDoc on src + test)
npm run check:format # prettier checks
npm test             # node --test
npm run build        # tsc -p tsconfig.json  (emits dist/*.d.ts only)
npm run check        # lint + check:types + test + format check
npm run format       # prettier + eslint --fix
```

`check:types` and `build` use **two different tsconfigs**: `tsconfig.json` builds declarations from `src/` only; `tsconfig.check.json` extends it, sets `noEmit`, and adds `test/` to `include`.

## Dependencies — agents must NOT install (supply-chain policy)

**Never run `npm install`/`npm add`/`yarn add`/`pnpm add` or edit `dependencies`/`devDependencies`
in `package.json` yourself.** Supply-chain attacks via npm are common, so a human reviews and
installs every dependency.

When you need a package:

1. **Propose it** — a list with, per package: exact npm name, `dependency` vs `devDependency`, what
   it's for, where it's imported from, and a supply-chain note (types-only vs executable, popularity,
   install scripts). Then stop and let the human install it.
2. **Core has ZERO runtime dependencies** — a hard constraint. Anything you propose is a `devDep`
   unless the human explicitly decides otherwise.
3. **Prefer zero-dep** — hand-roll small helpers (e.g. browser-globals lists, trivial test fakes)
   rather than pulling a package, and say so when a dep is avoidable.
4. Test-only fakes (e.g. `happy-dom`) are `devDependencies` imported **only from
   `test/`**, never from `src/` (which must stay runtime-dep-free and browser-loadable).

## Version control — agents must NOT commit

**Never run git write commands** (`commit`, `add`/stage, `branch`, `push`, `tag`, `merge`, `rebase`,
`reset`) and **do not offer to commit.** The human owns all version control. Read-only git
(`status`, `diff`, `log`) is fine. Finish your work, report what changed, and leave a clean working
tree — the human handles commits. (Commits/pushes are also human-gated in `.claude/settings.json`.)

## Releases & versioning — use changesets, never bump by hand

Versioning and changelog are automated via **changesets** ([`.changeset/config.json`](.changeset/config.json))
and the [release workflow](.github/workflows/release.yml). **Do NOT** manually edit
`package.json` `version`, write or edit `CHANGELOG.md`, or run `npm version`/`git tag` — the
changesets action owns all of that.

To record a release-worthy change, add a changeset file under `.changeset/` (a markdown file with
frontmatter naming the package + semver bump, then a summary line) — or tell the human to run
`npx changeset`. On merge to `main`, the action opens/updates a "Version Packages" PR that bumps
the version and writes the changelog; merging that PR publishes to npm. See
[`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) for the walkthrough.

## Pitfalls

### `dist/` only contains `.d.ts` — that's intentional

`dist/index.d.ts` has lines like `export { ... } from "./split.js"`. Those `.js` strings
look broken (there is no `dist/split.js`), but they're not. TypeScript resolves `.js` in a
`.d.ts` to a sibling `.d.ts` (here: `dist/split.d.ts`); Node runtime resolution uses
`src/` via the `main` field. The two graphs are independent. Don't try to "fix" the paths
— verified working by a packed-tarball consumer test.

### JSDoc gotchas under `strict` + `checkJs`

- `// @ts-expect-error <reason>` works in `.js` files when `checkJs` is on. Use it for
  tests that intentionally pass bad arguments.
- Empty array literals need an explicit annotation: `/** @type {string[]} */ const x = []`.
  Otherwise strict mode flags them as implicit `any[]`.
- Arrow helpers like `text => text.split('')` need `/** @param {string} text */` —
  parameters can't be inferred from usage in strict mode.
- For type-predicate assertion functions, JSDoc supports the full TS syntax:
  `@returns {asserts x is keyof typeof Foo}`.

### Demo (`index.html`) imports from `src/`, not `dist/`

`index.html` does `import FOO from './src/index.js'`. The
[demo-page workflow](.github/workflows/demo-page.yml) copies `src/` (not `dist/`) into
`demo-public/`. There is no build step for the demo.

The demo's own stack constraints: the **entire** demo lives in `index.html` (no other JS/CSS
files); ESM modules only, with import maps for bare specifiers; external deps load from
`https://esm.sh/` (never added to `package.json`); UI is React + [htm](https://www.npmjs.com/package/htm);
styling is [PureCSS](https://pure-css.github.io/); icons are [Phosphor](https://phosphoricons.com/).

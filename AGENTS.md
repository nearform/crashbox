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
4. Test-only fakes (e.g. `fake-indexeddb`, `happy-dom`) are `devDependencies` imported **only from
   `test/`**, never from `src/` (which must stay runtime-dep-free and browser-loadable).

## Pitfalls

### Use the project's Node version

The default `node` on this machine is **v16**, which is too old for the toolchain
(eslint 10, npm 11, etc.) and will produce baffling errors. Always activate nvm against
the project's `.nvmrc` (`lts/*`) **before** running anything:

```sh
source ~/.nvm/nvm.sh && cd /PATH/TO/crashbox && nvm use
```

`nvm use` only finds `.nvmrc` when the CWD is inside the project, and each new `Bash` tool
invocation starts a fresh shell — so re-source nvm every time, or chain it inline:
`source ~/.nvm/nvm.sh && nvm use 2>/dev/null && <your command>`.

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

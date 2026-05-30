<!-- Use this file to provide workspace-specific custom instructions to Copilot. For more details, visit https://code.visualstudio.com/docs/copilot/copilot-customization#_use-a-githubcopilotinstructionsmd-file -->

This is a JavaScript library project for a local-first browser crash "black box" that survives hard tab kills (WebGPU, WASM, in-browser OOM) and surfaces the recovered state on next load (types via JSDoc annotations, validated by `tsc`). Prioritize robust persistence/recovery logic and a clean, configurable API.

## Demo

For our demo at `index.html`, we use the following stack:

- The entire demo should fit entirely in `index.html`. (No other JS or CSS files.)
- ESM modules only and import maps for bare dependencies.
- External dependencies should come from https://esm.sh/. Do not add any dependencies to `package.json`.
- Use React and [htm](https://www.npmjs.com/package/htm) for the app and UI.
- Use https://pure-css.github.io/ for styling.
- Use https://phosphoricons.com/ for icons.

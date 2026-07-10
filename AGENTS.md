# AGENTS.md

This is an Oh My Pi port of [lajarre/pi-vim](https://github.com/lajarre/pi-vim), published as `omp-vim`. It targets Oh My Pi's `@oh-my-pi/*` API and compiled-binary runtime. See the "Oh My Pi port" section in `README.md` for the concrete adaptations (native in-process clipboard, buffer/cursor engine rerouted onto the public `Editor` API, self-contained snapshot undo, settings read from `~/.omp`).

Treat exported internals as omp-vim-local unless documented otherwise.

Shipped source is `index.ts` plus the sibling `*.ts` lib modules; `tsconfig.json` scopes `typecheck` to those. The inherited `test/`, `script/`, and `doc/` trees still target the upstream `@earendil-works` API and the removed clipboard-subprocess design — they are NOT yet ported, so `npm test` / `npm run check` will fail until they are.

When adapting more behavior, prefer Oh My Pi's public `Editor` API (`setText`, `insertText`, `getLines`, `getCursor`, `moveTo*`) over reaching into editor internals — Oh My Pi keeps editor state private, so direct `state`/`cursorCol` access silently no-ops.

There is no automated npm publishing in this fork.

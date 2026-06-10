# AGENTS.md

This repo is not expected, for now, to be imported as a dependency; treat exported internals as pi-vim-local unless documented otherwise.

For every new or changed Vim-like feature, add curated nvim parity coverage in `test/nvim-parity*.ts` unless the behavior is intentionally not Vim-compatible. If it is an intentional divergence, make that explicit in tests and documentation.

Known nvim parity gaps may live as skipped tests. Apply the boy scout principle: when a branch touches the relevant behavior, unskip and fix nearby skipped parity cases alongside the branch's own change, or document why the gap remains out of scope. Do not batch unrelated parity fixes into a conflict-heavy branch.

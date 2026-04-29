# clipboard mirror policy spec

## context

`pi-vim` keeps an internal unnamed-register shadow and mirrors register writes to the OS clipboard best-effort. The current default mirrors every delete, change, and yank write. That matches the OS-backed unnamed-register default from the clipboard mirror work, but some users want deletes and changes to stay private while still keeping yanks convenient.

The policy must be persistent. Users should not need to pass command-line arguments every time they start Pi.

## goals

- Add durable user-facing configuration for clipboard write mirroring.
- Preserve current behavior by default.
- Support three write-mirror policies:
  - `all`: mirror every unnamed-register write.
  - `yank`: mirror yank writes only.
  - `never`: do not mirror unnamed-register writes.
- Keep internal unnamed-register writes synchronous under every policy.
- Keep `p` / `P` paste behavior unchanged: read OS clipboard first, then fall back to the internal shadow on read failure or timeout.
- Document the setting high in `README.md`, together with other configuration notes.

## non-goals

- Do not change missing-mode work such as visual mode, `R`, `~`, or delimited text objects.
- Do not change cursor-shape behavior.
- Do not rework platform clipboard backends.
- Do not add named registers.
- Do not change paste read policy.
- Do not require a CLI flag for normal use.

## configuration

Use a package-specific Pi settings key:

```json
{
  "piVim": {
    "clipboardMirror": "all"
  }
}
```

The setting may live in either persistent Pi settings file:

- `~/.pi/agent/settings.json`
- `.pi/settings.json`

Project settings follow Pi's normal merge behavior and override global settings.

`piVim` is intentionally package-specific. A generic `vim` key would be too broad and could collide with future Pi/core editor settings or other extensions.

## behavior

### policy values

| value | behavior |
|-------|----------|
| `all` | Mirror every unnamed-register write. This is the default and preserves current behavior. |
| `yank` | Mirror yanks only. Deletes and changes update only pi-vim's internal shadow. |
| `never` | Never mirror unnamed-register writes. The internal shadow still updates synchronously. |

Policy values should be documented in lowercase. The resolver normalizes surrounding whitespace and casing for tolerance, so `"YANK"` resolves to `yank`, but README examples use lowercase values.

### invalid settings

Invalid or wrongly typed values are safe:

1. resolve to `all`
2. warn once per extension startup through Pi UI when UI is available
3. include the invalid value and the valid values in the warning
4. render non-string invalid values safely, using a type label and JSON stringification when available
5. continue editing normally

## architecture

### settings reader

A small settings adapter reads merged Pi settings at extension startup and extracts `piVim.clipboardMirror`. Setting changes take effect after Pi reloads the extension or starts a new process; dynamic live reconfiguration is out of scope.

The implementation should prefer an official Pi settings surface if one is available. If extension context does not expose settings directly, use `SettingsManager.create(ctx.cwd)` behind a tiny adapter/seam so tests do not touch real user settings.

### policy model

Define a narrow policy model:

```ts
type ClipboardMirrorPolicy = "all" | "yank" | "never";
type RegisterWriteSource = "mutation" | "yank";
```

The resolver should be pure so tests can cover missing, valid, invalid, normalized, and wrong-type values without a real Pi runtime. It should return a resolved policy plus an optional diagnostic string; the settings adapter or extension startup code owns emitting any UI warning.

### editor integration

`ModalEditor` stores the resolved policy. The existing register write path remains the single mirror decision point:

```ts
writeToRegister(text, source = "mutation")
```

Buffer-mutating register writes use the default `mutation` source. This includes delete/change-style commands such as `d`, `c`, `x`, `s`, `D`, and `C`. Yank paths pass `source = "yank"` because they write the register without changing buffer text.

The method always updates `unnamedRegister` synchronously. It only enqueues OS clipboard mirroring if the current policy allows the write kind.

### data flow

```text
Pi starts extension
  -> pi-vim reads merged settings
  -> resolve piVim.clipboardMirror
  -> install ModalEditor factory with resolved policy

delete/change/yank command
  -> update internal unnamed-register shadow synchronously
  -> classify write as mutation or yank
  -> policy decides whether to enqueue clipboard mirror

p / P
  -> unchanged: OS clipboard first, shadow fallback
```

## testing

### resolver and config tests

Cover:

- missing setting -> `all`
- `all` -> `all`
- `yank` -> `yank`
- `never` -> `never`
- invalid string -> `all` plus warning
- wrong type -> `all` plus warning
- casing and whitespace normalization, for example `"YANK"` and `" yank "` -> `yank`

Extension harness tests should prove the installed editor receives the resolved policy from settings. Any settings-reader seam should be testable without reading or writing real user settings.

### editor behavior tests

Cover:

- `all`: delete, change, and yank writes enqueue clipboard mirroring.
- `yank`: yanks mirror; deletes and changes do not.
- `never`: no register writes mirror.
- all policies: internal register shadow updates synchronously.
- all policies: `p` / `P` can still read the OS clipboard.

## documentation

Update `README.md` in two places:

1. A high-up `configure` section near install/setup that shows the `piVim.clipboardMirror` settings JSON and all supported values.
2. The register/clipboard policy section that explains write mirroring is configurable while paste reads remain OS-backed by default.

Do not document a CLI flag as the normal user path.

## acceptance criteria

- Users can configure persistent clipboard mirror behavior through `~/.pi/agent/settings.json` or `.pi/settings.json`.
- Missing config preserves current behavior: `all`.
- `all`, `yank`, and `never` behave as documented.
- Invalid config warns when Pi UI is available and falls back to `all`.
- `p` / `P` paste behavior remains unchanged.
- README documents config high up and repeats the policy in the clipboard section.
- Tests cover each supported policy and settings resolution.
- Scope excludes missing modes, cursor-shape changes, platform backend changes, and unrelated cleanup.

# Configuration

## Home directory

`KEITH_HOME` (default `~/.keith/`):

```
~/.keith/
├─ config.toml        # all settings
├─ persona.md         # the Mind's persona (system prompt section 1), created by `keith setup`
├─ keith.db           # SQLite
├─ files/             # uploaded and generated files
├─ plugins/<id>/      # per-plugin private data (ctx.paths.data)
└─ logs/              # rotating JSON logs
```

Tests always set `KEITH_HOME` to a temporary directory.

## `config.toml`

Parsed with Bun's built-in TOML support and validated with a zod schema in `core/src/config`. Unknown keys are an error (typos fail loudly). Any string value may be `"env:NAME"`, which is resolved from the environment at load. Missing env vars are an error naming the key. Every key has a default (the values below, except `mind.timezone`, which defaults to the system time zone), so an empty file is valid. A missing file, invalid TOML or an invalid value is `CONFIG_INVALID` naming the key. Under `[plugins]`, the keys `enabled`, `required` and `stopTimeoutMs` belong to the core and every table is a plugin section; any other key is an error.

```toml
[server]
host = "127.0.0.1"
port = 4824

[mind]
name = "Keith"
timezone = "Asia/Jakarta"          # IANA; default = system timezone

[mind.turn]
maxSteps = 8
stallMs = 120000

[mind.task]
maxSteps = 20
maxPerPerson = 3
timeoutMs = 1800000

[mind.commitment]
ttlMs = 604800000                  # 7 days

[mind.arrival]
awayAfterMinutes = 240             # fractional values allowed (tests use small ones)
briefing = "on-greeting"           # "auto" | "on-greeting" | "off"
holdMs = 120000                    # on-greeting: how long to wait for the first input
graceMs = 1500                     # auto: wait for plugin deliveries before briefing

[mind.context]
recentMessages = 40

[memory]
coreMaxChars = 1500
# [memory.reflect]                 # planned (phase 4)
# idleMinutes = 20

[scheduler]
foreground = 4
delivery = 2
background = 2
tickMs = 30000

[models]                           # model refs: "<providerId>:<modelId>"
foreground = "deepseek:deepseek-flash"
background = "deepseek:deepseek-flash"
utility    = "deepseek:deepseek-flash"

[auth]
tokenTtlDays = 30

[plugins]
enabled  = ["@keith/provider-deepseek"]
required = ["@keith/provider-deepseek"]
stopTimeoutMs = 5000

[plugins."@keith/provider-deepseek"]
apiKey = "env:DEEPSEEK_API_KEY"

# To use OpenRouter instead of (or as well as) DeepSeek:
# enabled = ["@keith/provider-openrouter"]  and
# [plugins."@keith/provider-openrouter"]
# apiKey = "env:OPENROUTER_API_KEY"
# appTitle = "Keith"

[services]                         # optional: pick a winner when two plugins provide the same service
# weather = "@keith/tool-weather"
```

Each plugin section is validated by that plugin's own `config` schema. The core never interprets plugin sections.

### `keith setup`

`keith setup` asks which provider to use (DeepSeek or OpenRouter), enables only that plugin (also listed in `required`), asks for a model id (it offers a default, `deepseek-flash` or `~openai/gpt-sol-latest`, labelled as possibly outdated since vendor ids change), and maps all three roles to it. The API key is written as `env:DEEPSEEK_API_KEY` / `env:OPENROUTER_API_KEY`, never literally. Users split roles across models later by editing the file.

It also creates `KEITH_HOME` with `files/`, `plugins/` and `logs/`, writes `persona.md` from `defaultPersona(mind.name)`, applies the migrations, and creates the **owner** Person (name, username, password asked twice, at least 8 characters, hashed with `Bun.password`).

Running it again is safe: an existing `config.toml` or `persona.md` is kept as is, and when an owner exists it only offers to reset that owner's password. It never creates a second owner.

Answers are read from the terminal (raw mode, so the password is not echoed) or one per line from piped stdin. Code and tests drive it through a `Prompter` (`scriptedPrompter(answers)` in tests).

The first-party provider plugins (`@keith/provider-deepseek`, `@keith/provider-openrouter`) are dependencies of `@keith/core`, so the plugin host's `import()` of a name in `plugins.enabled` resolves them. Third-party plugins must be installed where the core can resolve them.

## Secrets

- Never store secrets in `config.toml` literally in shared examples. Use `env:`.
- The logger redacts any config value whose key matches `/key|token|secret|password/i`: every log field with such a key, at any depth, is written as `[redacted]`.
- An encrypted credential store is out of scope until a plugin needs per-person OAuth tokens. It needs an ADR then.

## Precedence

Config file < environment overrides < CLI flags (`keith start --port 5000 --host 0.0.0.0`).

Environment overrides use `KEITH__` plus the key path, with `__` between segments. Segments are matched to schema keys case-insensitively: `KEITH__SERVER__PORT=5000`, `KEITH__MIND__TURN__MAXSTEPS=12` → `mind.turn.maxSteps`. Values are parsed as JSON when possible, otherwise as strings (`KEITH__PLUGINS__ENABLED='["@keith/provider-openrouter"]'`). Plugin sections and `[services]` can't be overridden this way. Use `env:` inside them. A `KEITH__` variable that matches no key is an error. `env:` references are resolved after overrides, so an override may itself be `"env:NAME"`.

In code: `loadConfig({ home, flags })` reads `<home>/config.toml`; `parseConfig(table, { env, flags })` does the rest and is what tests use. `keithPaths(home)` gives the layout above. `DEFAULT_PERSONA_TEMPLATE` / `defaultPersona(name)` hold the default `persona.md` text that `keith setup` writes.

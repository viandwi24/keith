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

Parsed with Bun's built-in TOML support and validated with a zod schema in `core/src/config`. Unknown keys are an error (typos fail loudly). Any string value may be `"env:NAME"`, which is resolved from the environment at load. Missing env vars are an error naming the key.

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

`keith setup` asks which provider to use (DeepSeek or OpenRouter), enables only that plugin, asks for a model id (it offers a default, labelled as possibly outdated since vendor ids change), and maps all three roles to it. Users split roles across models later by editing the file.

Each plugin section is validated by that plugin's own `config` schema. The core never interprets plugin sections.

## Secrets

- Never store secrets in `config.toml` literally in shared examples. Use `env:`.
- The logger redacts any config value whose key matches `/key|token|secret|password/i`.
- An encrypted credential store is out of scope until a plugin needs per-person OAuth tokens. It needs an ADR then.

## Precedence

Config file < environment overrides < CLI flags (`keith start --port 5000`).

Environment overrides use `KEITH__` plus the key path, with `__` between segments. Segments are matched to schema keys case-insensitively: `KEITH__SERVER__PORT=5000`, `KEITH__MIND__TURN__MAXSTEPS=12` → `mind.turn.maxSteps`. Values are parsed as JSON when possible, otherwise as strings. Plugin sections can't be overridden this way. Use `env:` inside them.

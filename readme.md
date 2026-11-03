# Eara Bot - Internationalization

- [Contributing](./contributing.md)

## Publishing

The bot renders translations in-process from a bundle in the NATS JetStream
object store (bucket `i18n`, object `bundle`). It will not start without one,
so publish before starting the bot, locally (e.g. after `docker compose up`)
as well as in production:

```sh
cargo run -p eara-common --bin publish_i18n -- --nats-url nats://localhost:4222
```

- Packs `i18n/src/*.yaml` and `config/i18n-values.json` (paths relative to the repo root;
  override with `--src` / `--defaults`), versioned `--version` or `git rev-parse --short HEAD`.
- Loads the bundle first and exits non-zero on YAML errors or `$t` cycles. `--dry-run` stops there.
- Creates the bucket if missing. `NATS_URL` works in place of `--nats-url`.

Running bots pick up each publish within seconds; a bundle that fails to load is
logged and skipped. `dev i18n version` shows the active bundle and `dev i18n reload`
fetches it immediately.

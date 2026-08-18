# scripts

To install dependencies:

```bash
bun install
```

Translate `../src/en.bot.yaml` with an OpenRouter model:

```bash
OPENROUTER_API_KEY=... bun run translate.ts --model anthropic/claude-sonnet-4.6
```

Use `--locales de,fr` to limit locales and `--concurrency 4` to cap concurrent chunk requests across all languages. Interactive terminals show one live progress row per locale. Existing files are skipped unless `--force` is set.

This project was created using `bun init` in bun v1.2.13. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

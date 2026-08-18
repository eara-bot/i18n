import fs from "node:fs/promises";
import * as yaml from "@std/yaml";

type Locale = { code: string; name: string };
type PathPart = string | number;
export type ModelCorrection = { response: string; error: string };
type LanguageStatus =
  | "queued"
  | "running"
  | "writing"
  | "done"
  | "failed"
  | "skipped";
export type LanguageProgress = {
  code: string;
  name: string;
  total: number;
  completed: number;
  active: number;
  retries: number;
  status: LanguageStatus;
  detail?: string;
};
type OpenRouterResponse = {
  choices?: {
    message?: { content?: unknown };
    finish_reason?: string | null;
  }[];
  error?: { message?: string };
};

const SOURCE_URL = new URL("../src/en.bot.yaml", import.meta.url);
const SOURCE_DIR_URL = new URL("../src/", import.meta.url);
const LOCALES_URL = new URL("./all_locales.json", import.meta.url);
const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language" });
const CHUNK_SIZE = 40;
const MAX_CHUNK_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 120_000;
const PROGRESS_WIDTH = 16;
const PROTECTED_TOKEN =
  /<[^>\n]+>|\{\{[^{}]+\}\}|\$t\([^)]*\)|https?:\/\/[^\s)\]]+/g;

function collectStrings(
  value: unknown,
  path: PathPart[] = [],
  output: { path: PathPart[]; text: string }[] = [],
) {
  if (typeof value === "string") {
    output.push({ path, text: value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectStrings(item, [...path, index], output),
    );
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) =>
      collectStrings(item, [...path, key], output),
    );
  }

  return output;
}

export function chunkStrings(strings: string[], size: number) {
  if (!Number.isInteger(size) || size < 1)
    throw new Error("chunk size must be a positive integer");

  return Array.from({ length: Math.ceil(strings.length / size) }, (_, index) =>
    strings.slice(index * size, (index + 1) * size),
  );
}

export async function runConcurrently<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
) {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("concurrency must be a positive integer");

  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await task(items[index]!, index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
}

export function getLanguageStatus(
  progress: Pick<LanguageProgress, "completed" | "total" | "active">,
): LanguageProgress["status"] {
  if (progress.completed === progress.total) return "writing";
  return progress.active > 0 ? "running" : "queued";
}

const STATUS_MARK: Record<LanguageStatus, string> = {
  queued: "○",
  running: "●",
  writing: "◆",
  done: "✓",
  failed: "✗",
  skipped: "–",
};

export function formatLanguageRow(
  progress: LanguageProgress,
  labelWidth: number,
) {
  const filled = Math.round(
    (progress.completed / Math.max(progress.total, 1)) * PROGRESS_WIDTH,
  );
  const bar = `[${"█".repeat(filled)}${"░".repeat(PROGRESS_WIDTH - filled)}]`;
  const label = `${progress.code.padEnd(4)}${progress.name}`.padEnd(labelWidth);
  const chunks = `${progress.completed}/${progress.total}`.padStart(7);
  const activity =
    progress.status === "running" && progress.active
      ? ` · ${progress.active} active`
      : "";
  const retryLabel = progress.retries === 1 ? "retry" : "retries";
  const retries = progress.retries
    ? ` · ${progress.retries} ${retryLabel}`
    : "";
  const detail = progress.detail ? ` · ${progress.detail}` : "";

  return ` ${label} │ ${bar} │ ${chunks} │ ${STATUS_MARK[progress.status]} ${progress.status}${activity}${retries}${detail}`;
}

function createLanguageRenderer(progress: LanguageProgress[]) {
  const interactive = Boolean(process.stdout.isTTY);
  const useColor = interactive && !("NO_COLOR" in process.env);
  const labelWidth = Math.max(
    12,
    ...progress.map(({ code, name }) => `${code.padEnd(4)}${name}`.length),
  );
  const header = ` ${"LANGUAGE".padEnd(labelWidth)} │ ${"PROGRESS".padEnd(PROGRESS_WIDTH + 2)} │ ${"CHUNKS".padStart(7)} │ STATUS`;
  const separator = `${"─".repeat(labelWidth + 2)}┼${"─".repeat(PROGRESS_WIDTH + 4)}┼${"─".repeat(9)}┼${"─".repeat(30)}`;
  let initialized = false;

  const paint = (row: string, color: string) =>
    useColor ? `\x1b[${color}m${row}\x1b[0m` : row;

  const statusColor = (item: LanguageProgress) => {
    if (item.status === "done") return "1;32";
    if (item.status === "failed") return "1;31";
    if (item.retries) return "33";
    if (item.status === "running") return "36";
    if (item.status === "writing") return "34";
    return "2;37";
  };

  const render = (changed?: LanguageProgress) => {
    if (!progress.length) return;

    if (!interactive) {
      if (changed) {
        console.log(formatLanguageRow(changed, labelWidth));
      } else {
        console.log(header);
        console.log(separator);
        for (const item of progress)
          console.log(formatLanguageRow(item, labelWidth));
      }
      return;
    }

    const columns = process.stdout.columns || 120;
    const clip = (row: string) => row.slice(0, columns - 1);
    const rows = [
      paint(clip(header), "1;97"),
      paint(clip(separator), "2;37"),
      ...progress.map((item) =>
        paint(clip(formatLanguageRow(item, labelWidth)), statusColor(item)),
      ),
    ];

    process.stdout.write(
      `${initialized ? `\x1b[${rows.length}A` : ""}${rows.map((row) => `\x1b[2K\r${row}`).join("\n")}\n`,
    );
    initialized = true;
  };

  return { render };
}

function setAtPath(value: unknown, path: PathPart[], replacement: string) {
  let current = value as Record<PathPart, unknown>;

  for (const part of path.slice(0, -1))
    current = current[part] as Record<PathPart, unknown>;
  current[path.at(-1)!] = replacement;
}

function tokens(value: string) {
  return (value.match(PROTECTED_TOKEN) ?? []).sort((left, right) =>
    left.localeCompare(right),
  );
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`invalid ${label} JSON`, { cause: error });
  }
}

export function applyTranslations(source: unknown, translations: unknown) {
  const entries = collectStrings(source);
  if (!Array.isArray(translations) || translations.length !== entries.length) {
    throw new Error(
      `expected ${entries.length} translated strings, received ${Array.isArray(translations) ? translations.length : "non-array"}`,
    );
  }

  const output = structuredClone(source);
  entries.forEach((entry, index) => {
    const translated = translations[index];
    const location = entry.path.join(".");

    if (typeof translated !== "string")
      throw new Error(`non-string translation at "${location}"`);
    const expectedTokens = tokens(entry.text);
    const receivedTokens = tokens(translated);
    if (JSON.stringify(expectedTokens) !== JSON.stringify(receivedTokens)) {
      throw new Error(
        `placeholder mismatch at "${location}": expected ${JSON.stringify(expectedTokens)}, received ${JSON.stringify(receivedTokens)}`,
      );
    }

    setAtPath(output, entry.path, translated);
  });

  return output;
}

export function parseTranslations(content: string): unknown[] {
  const trimmed = content.trim();
  const json =
    trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)?.[1] ?? trimmed;
  const parsed = parseJson(json, "model response");

  if (!Array.isArray(parsed))
    throw new Error("model response must be a JSON array");
  return parsed;
}

export async function translateChunk(
  source: string[],
  attempts: number,
  request: (correction?: ModelCorrection) => Promise<string>,
  onRetry?: (message: string, attempt: number, withFeedback: boolean) => void,
) {
  if (!Number.isInteger(attempts) || attempts < 1)
    throw new Error("attempt count must be a positive integer");

  let correction: ModelCorrection | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: string | undefined;

    try {
      response = await request(correction);
      return applyTranslations(source, parseTranslations(response)) as string[];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (response !== undefined) correction = { response, error: message };
      if (attempt === attempts)
        throw new Error(`failed after ${attempts} attempts: ${message}`, {
          cause: error,
        });

      onRetry?.(message, attempt, response !== undefined);
    }
  }

  throw new Error("unreachable translation retry state");
}

async function complete(
  model: string,
  apiKey: string,
  locale: Locale,
  strings: string[],
  correction?: ModelCorrection,
) {
  const messages = [
    {
      role: "system",
      content:
        "Translate Discord music-bot UI text. Return only a valid JSON array containing exactly one translated string per input string, in the same order. Preserve the exact set and count of placeholders, $t(...) references, URLs, Discord tokens, emojis, Markdown markers, and newlines, but reorder placeholders as target-language grammar requires. Translate only human-readable English text.",
    },
    {
      role: "user",
      content: JSON.stringify({
        locale: `${LANGUAGE_NAMES.of(locale.code) ?? locale.name} (${locale.code})`,
        strings,
      }),
    },
  ];

  if (correction) {
    messages.push(
      { role: "assistant", content: correction.response },
      {
        role: "user",
        content: `Your response failed validation: ${correction.error}\nReturn a corrected JSON array only. Preserve the exact set and count of protected tokens; reordering them for target-language grammar is allowed.`,
      },
    );
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        reasoning: { effort: "none" },
        messages,
      }),
    },
  );

  const body = (await response.json()) as OpenRouterResponse;
  if (!response.ok)
    throw new Error(
      body.error?.message ?? `OpenRouter returned HTTP ${response.status}`,
    );

  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(
      `OpenRouter response contains no text completion (finish reason: ${choice?.finish_reason ?? "unknown"})`,
    );
  }
  return content;
}

function usage() {
  console.log(
    "Usage: bun run translate.ts --model <openrouter-model> [--locales de,fr] [--concurrency 4] [--force]",
  );
}

async function main() {
  const args = Bun.argv.slice(2);
  let model: string | undefined;
  let localeCodes: string | undefined;
  let concurrency = 4;
  let force = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];

    if (argument === "--help") {
      usage();
      return;
    } else if (argument === "--force") {
      force = true;
    } else if (
      argument === "--model" ||
      argument === "--locales" ||
      argument === "--concurrency"
    ) {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`missing value for ${argument}`);

      if (argument === "--model") model = value;
      else if (argument === "--locales") localeCodes = value;
      else {
        concurrency = Number(value);
        if (!Number.isInteger(concurrency) || concurrency < 1)
          throw new Error("--concurrency must be a positive integer");
      }
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!model) throw new Error("missing --model");
  if (!apiKey) throw new Error("missing OPENROUTER_API_KEY");

  const allLocales = parseJson(
    await fs.readFile(LOCALES_URL, "utf8"),
    "locale list",
  ) as Locale[];
  const requested = localeCodes?.split(",").filter(Boolean);
  const locales = allLocales.filter(
    ({ code }) => code !== "en" && (!requested || requested.includes(code)),
  );
  const unknown =
    requested?.filter(
      (code) => !allLocales.some((locale) => locale.code === code),
    ) ?? [];
  if (unknown.length)
    throw new Error(`unsupported locale(s): ${unknown.join(", ")}`);
  if (!locales.length) throw new Error("no target locales selected");

  const source = yaml.parse(await fs.readFile(SOURCE_URL, "utf8"));
  const strings = collectStrings(source).map(({ text }) => text);
  const chunks = chunkStrings(strings, CHUNK_SIZE);
  const states = await Promise.all(
    locales.map(async (locale) => {
      const outputUrl = new URL(`${locale.code}.bot.yaml`, SOURCE_DIR_URL);
      const skipped = !force && (await fs.exists(outputUrl));

      const progress: LanguageProgress = {
        code: locale.code,
        name: LANGUAGE_NAMES.of(locale.code) ?? locale.name,
        total: chunks.length,
        completed: 0,
        active: 0,
        retries: 0,
        status: skipped ? "skipped" : "queued",
      };

      return {
        locale,
        outputUrl,
        translations: new Array<string[]>(chunks.length),
        progress,
        error: undefined as string | undefined,
      };
    }),
  );
  const workStates = states.filter(
    ({ progress }) => progress.status !== "skipped",
  );
  const renderer = createLanguageRenderer(
    states.map(({ progress }) => progress),
  );

  console.log(
    `Translating ${workStates.length} languages with ${model}; ${concurrency} concurrent requests`,
  );
  renderer.render();

  const jobs = chunks.flatMap((_, chunkIndex) =>
    workStates.map((state) => ({ state, chunkIndex })),
  );

  await runConcurrently(jobs, concurrency, async ({ state, chunkIndex }) => {
    if (state.error) return;

    const chunk = chunks[chunkIndex]!;
    const { locale, progress } = state;
    progress.active++;
    progress.status = "running";
    progress.detail = `chunk ${chunkIndex + 1}/${chunks.length}`;
    renderer.render(progress);

    try {
      state.translations[chunkIndex] = await translateChunk(
        chunk,
        MAX_CHUNK_ATTEMPTS,
        (correction) => complete(model, apiKey, locale, chunk, correction),
        (_message, attempt, withFeedback) => {
          if (state.error) return;

          progress.retries++;
          progress.detail = `retrying chunk ${chunkIndex + 1} (${attempt}/${MAX_CHUNK_ATTEMPTS})${withFeedback ? " with feedback" : ""}`;
          renderer.render(progress);
        },
      );
      progress.completed++;
      if (!state.error) progress.detail = undefined;
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      progress.status = "failed";
      progress.detail = `chunk ${chunkIndex + 1} failed`;
    } finally {
      progress.active--;
      if (!state.error) progress.status = getLanguageStatus(progress);
      renderer.render(progress);
    }
  });

  const completed = await Promise.all(
    workStates.map(async (state) => {
      const { locale, outputUrl, translations, progress } = state;
      if (state.error) return false;

      progress.status = "writing";
      progress.detail = "writing YAML";
      renderer.render(progress);

      try {
        const translated = applyTranslations(source, translations.flat());
        const temporaryUrl = new URL(
          `${locale.code}.bot.yaml.tmp`,
          SOURCE_DIR_URL,
        );

        await fs.writeFile(temporaryUrl, yaml.stringify(translated));
        await fs.rename(temporaryUrl, outputUrl);
        progress.status = "done";
        progress.detail = undefined;
        renderer.render(progress);
        return true;
      } catch (writeError) {
        state.error =
          writeError instanceof Error ? writeError.message : String(writeError);
        progress.status = "failed";
        progress.detail = "write failed";
        renderer.render(progress);
        return false;
      }
    }),
  );

  for (const state of states) {
    if (state.error) console.error(`${state.locale.code}: ${state.error}`);
  }
  if (completed.includes(false)) process.exitCode = 1;
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exitCode = 1;
  });

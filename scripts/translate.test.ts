import { describe, expect, test } from "bun:test";
import {
  applyTranslations,
  chunkStrings,
  formatLanguageRow,
  getLanguageStatus,
  parseTranslations,
  runConcurrently,
  translateChunk,
} from "./translate";

describe("translation output", () => {
  test("splits large translations into bounded requests", () => {
    expect(chunkStrings(["one", "two", "three"], 2)).toEqual([
      ["one", "two"],
      ["three"],
    ]);
  });

  test("runs work up to the configured concurrency", async () => {
    let active = 0;
    let maximum = 0;
    const completed: number[] = [];

    await runConcurrently([0, 1, 2, 3], 2, async (item) => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      completed.push(item);
      active--;
    });

    expect(maximum).toBe(2);
    expect(completed.sort((left, right) => left - right)).toEqual([0, 1, 2, 3]);
  });

  test("shows partial languages as queued when no chunk is active", () => {
    expect(getLanguageStatus({ completed: 2, total: 5, active: 0 })).toBe(
      "queued",
    );
    expect(getLanguageStatus({ completed: 2, total: 5, active: 1 })).toBe(
      "running",
    );
  });

  test("formats one language progress row", () => {
    const row = formatLanguageRow(
      {
        code: "de",
        name: "German",
        total: 5,
        completed: 2,
        active: 2,
        retries: 1,
        status: "running",
      },
      12,
    );

    expect(row).toContain("de  German");
    expect(row).toContain("│");
    expect(row).toContain("2/5");
    expect(row).toContain("● running");
    expect(row).toContain("· 2 active");
    expect(row).toContain("· 1 retry");
  });

  test("retries rejected chunks with validation feedback", async () => {
    const corrections: unknown[] = [];
    const responses = ['["Hallo {{wrong}}"]', '["Hallo {{name}}"]'];

    const translated = await translateChunk(
      ["Hello {{name}}"],
      3,
      async (correction) => {
        corrections.push(correction);
        return responses.shift()!;
      },
    );

    expect(translated).toEqual(["Hallo {{name}}"]);
    expect(corrections).toEqual([
      undefined,
      {
        response: '["Hallo {{wrong}}"]',
        error:
          'placeholder mismatch at "0": expected ["{{name}}"], received ["{{wrong}}"]',
      },
    ]);
  });

  test("applies translated strings without mutating source", () => {
    const source = {
      greeting: "Hello {{name}}",
      nested: { status: "Playing" },
    };

    expect(applyTranslations(source, ["Bonjour {{name}}", "Lecture"])).toEqual({
      greeting: "Bonjour {{name}}",
      nested: { status: "Lecture" },
    });
    expect(source.greeting).toBe("Hello {{name}}");
  });

  test("allows placeholder reordering for target-language grammar", () => {
    expect(
      applyTranslations({ message: "{{user}} removed {{count}} tracks" }, [
        "{{count}} Titel wurden von {{user}} entfernt",
      ]),
    ).toEqual({ message: "{{count}} Titel wurden von {{user}} entfernt" });
  });

  test("rejects changed placeholders", () => {
    expect(() =>
      applyTranslations({ greeting: "Hello {{name}}" }, ["Bonjour {{nom}}"]),
    ).toThrow('placeholder mismatch at "greeting"');
  });

  test("parses plain or fenced JSON arrays", () => {
    expect(parseTranslations('["Bonjour"]')).toEqual(["Bonjour"]);
    expect(parseTranslations('```json\n["Bonjour"]\n```')).toEqual(["Bonjour"]);
  });
});

import fs from "node:fs/promises";
import * as colors from "@std/fmt/colors";
import * as yaml from "@std/yaml";

const ALL_LOCALES: { code: string, name: string }[] = JSON.parse(await fs.readFile("./all_locales.json", "utf8"));

const DEFAULT_LOCALE = "en";

const fileNames = await fs.readdir("../src");

const files = fileNames.map(it => {
    const parts = it.split('.');
    return { lang: parts[0]!, namespace: parts[1]! }
});

const namespaces = new Set(files.map(it => it.namespace));

const getKeys = (obj: Record<string, unknown>, prefix = "", keys: string[] = []): string[] => {
    for (const key in obj) {
        const value = obj[key];
        const fullKey = prefix ? `${prefix}.${key}` : key;

        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            getKeys(value as Record<string, unknown>, fullKey, keys);
        } else {
            keys.push(fullKey);
        }
    }

    return keys;
}

const INDENT = " ".repeat(2);

for (const namespace of namespaces) {
    const locales = files.filter(it => it.namespace === namespace);

    const missing = ALL_LOCALES.filter(it => !locales.some(locale => locale.lang === it.code));

    console.log(`${colors.italic("namespace")}:`, namespace);

    const loaded: { code: string, keys: string[] }[] = [];
    for (const locale of locales) {
        loaded.push({
            code: locale.lang,
            keys: getKeys(
                yaml.parse(await fs.readFile(`../src/${locale.lang}.${namespace}.yaml`, "utf8")) as Record<string, unknown>
            )
        });
    }

    const def = loaded.find(it => it.code === DEFAULT_LOCALE);
    if (!def) {
        console.log(colors.red(`   Default locale (${DEFAULT_LOCALE}) not found!`));
        continue;
    }

    for (const locale of loaded) {
        const missing = def.keys.filter(key => !locale.keys.includes(key));
        const coverage = ((def.keys.length - missing.length) / def.keys.length) * 100;

        const color = coverage === 100
            ? colors.brightGreen
            : coverage >= 90
                ? colors.green
                : coverage >= 50
                    ? colors.yellow
                    : colors.red;

        console.log(INDENT, `${locale.code} - ${color(`${coverage.toFixed(2)}%`)}`, colors.dim(`(${def.keys.length - missing.length}/${def.keys.length})`));
        if (missing.length > 0 && missing.length != def.keys.length) {
            const format = "\n" + INDENT.repeat(3);
            console.log(INDENT.repeat(3) + missing.map(it => colors.italic("missing ") + colors.bold(it)).join(format));
        }
    }

    if (missing.length) {
        console.log(INDENT, colors.red("Missing locales:"));
        for (const locale of missing) {
            console.log(INDENT.repeat(2), colors.italic(locale.code), "-", colors.dim(locale.name));
        }
    }
}

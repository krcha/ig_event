import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the shipped presentation boundaries and their pure dependencies.
// Only React/browser integrations are fixtures; translation behavior is real.
export function loadPublicTextFixture({ react, jsx, getLocale }) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const cache = new Map();
  const integrations = {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "next/link": (props) => jsx("next-link", props),
    "next/navigation": { useRouter: () => ({}) },
    "@/i18n/client": { useLocale: getLocale },
  };
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    if (filename.endsWith(".json")) return JSON.parse(readFileSync(filename, "utf8"));
    const compiledModule = { exports: {} };
    cache.set(filename, compiledModule.exports);
    const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022, esModuleInterop: true,
      },
    }).outputText;
    runInNewContext(compiled, {
      module: compiledModule, exports: compiledModule.exports, Date, Intl,
      require(name) {
        if (name in integrations) return integrations[name];
        const base = name.startsWith("@/") ? path.join(root, name.slice(2))
          : name.startsWith(".") ? path.resolve(path.dirname(filename), name) : null;
        const target = base && [base, `${base}.ts`, `${base}.tsx`].find((candidate) => existsSync(candidate));
        if (!target) throw new Error(`Unexpected public-text fixture import: ${name}`);
        return load(target);
      },
    });
    return compiledModule.exports;
  }
  return load(path.join(root, "components/i18n/public-text.tsx"));
}

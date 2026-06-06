import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"];

function resolveExistingPath(candidatePath) {
  if (existsSync(candidatePath)) {
    return candidatePath;
  }

  for (const extension of EXTENSIONS) {
    const withExtension = `${candidatePath}${extension}`;
    if (existsSync(withExtension)) {
      return withExtension;
    }
  }

  for (const extension of EXTENSIONS) {
    const indexPath = path.join(candidatePath, `index${extension}`);
    if (existsSync(indexPath)) {
      return indexPath;
    }
  }

  return candidatePath;
}

function isLocalSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const mappedPath = resolveExistingPath(path.join(repoRoot, specifier.slice(2)));
    return nextResolve(pathToFileURL(mappedPath).href, context);
  }

  if (isLocalSpecifier(specifier) && context.parentURL?.startsWith("file:")) {
    const parentPath = fileURLToPath(context.parentURL);
    const mappedPath = resolveExistingPath(path.resolve(path.dirname(parentPath), specifier));
    return nextResolve(pathToFileURL(mappedPath).href, context);
  }

  return nextResolve(specifier, context);
}

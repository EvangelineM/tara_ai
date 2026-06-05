import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Walk up from the caller's directory until we find the project root
 * (identified by package.json + data/ folder). Works from source paths
 * (src/, scripts/) and from the Mastra build output (.mastra/output/).
 */
export function getProjectRoot(startDir?: string): string {
  let dir = startDir ?? path.dirname(fileURLToPath(import.meta.url));

  while (true) {
    const hasPackageJson = fs.existsSync(path.join(dir, "package.json"));
    const hasDataDir = fs.existsSync(path.join(dir, "data"));
    if (hasPackageJson && hasDataDir) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return process.cwd();
}

const REQUIRED_DATA_FILES = ["transactions.json", "funds.json", "holdings.json"];

/** List dataset folder names under data/ that contain all required JSON files. */
export function listAvailableDatasets(): string[] {
  const dataRoot = path.join(getProjectRoot(), "data");
  if (!fs.existsSync(dataRoot)) {
    return [];
  }

  return fs
    .readdirSync(dataRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) =>
      REQUIRED_DATA_FILES.every((file) =>
        fs.existsSync(path.join(dataRoot, name, file))
      )
    )
    .sort();
}

function defaultDatasetRelativePath(): string {
  const datasets = listAvailableDatasets();
  if (datasets.length === 0) {
    throw new Error("No valid datasets found under data/");
  }
  return path.join("data", datasets[0]);
}

/** Resolve a data directory path relative to the project root. */
export function resolveDataDir(dir?: string): string {
  const relative = dir ?? process.env.DATA_DIR ?? defaultDatasetRelativePath();
  if (path.isAbsolute(relative)) {
    return relative;
  }
  return path.join(getProjectRoot(), relative);
}

/** Validate that a dataset name refers to a loadable data directory. */
export function isValidDataset(name: string): boolean {
  return listAvailableDatasets().includes(name);
}

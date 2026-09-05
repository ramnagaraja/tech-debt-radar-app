const fs = require("fs");
const path = require("path");

const EXCLUDE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", ".angular", "coverage",
  ".next", ".nuxt", ".cache", ".vscode", ".vs",
]);

/** Walks repoPath for .ts/.tsx/.js/.jsx files (never .d.ts — declarations
 * only, no real logic). Returns [{full, rel}], rel always forward-slash
 * (matches the convention every other analyzer in this app already uses). */
function findTsFiles(repoPath) {
  const files = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        const rel = path.relative(repoPath, full).split(path.sep).join("/");
        files.push({ full, rel });
      }
    }
  }
  walk(repoPath);
  return files;
}

function findFile(repoPath, name) {
  const full = path.join(repoPath, name);
  return fs.existsSync(full) ? full : null;
}

/** Breadth-first search for every file named `name` under repoPath,
 * shallowest first — used to find package.json/tsconfig.json/angular.json
 * wherever the actual JS/TS project root is, since in a monorepo-style repo
 * (a .NET backend alongside a separate frontend folder) that's a subfolder,
 * not necessarily repoPath itself. */
function findConfigFiles(repoPath, name) {
  const found = [];
  let queue = [repoPath];
  while (queue.length > 0) {
    const next = [];
    for (const dir of queue) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!EXCLUDE_DIRS.has(entry.name)) next.push(path.join(dir, entry.name));
        } else if (entry.name === name) {
          found.push(path.join(dir, entry.name));
        }
      }
    }
    if (found.length > 0) break; // stop at the shallowest level that has any match
    queue = next;
  }
  return found;
}

module.exports = { findTsFiles, findFile, findConfigFiles, EXCLUDE_DIRS };

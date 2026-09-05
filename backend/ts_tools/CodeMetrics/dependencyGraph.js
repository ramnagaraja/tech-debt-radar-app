const path = require("path");
const ts = require("typescript");

const RESOLVE_SUFFIXES = [
  "", ".ts", ".tsx", ".js", ".jsx",
  "/index.ts", "/index.tsx", "/index.js", "/index.jsx",
];

/** Relative imports (./foo, ../bar) resolve to a real file with a simple
 * extension-guessing walk against the map of files this analysis already
 * found — no type checker or module resolution needed, since we only care
 * about in-repo edges (the same scope Python's ast-based import graph and
 * the .NET semantic graph both use). Non-relative imports (npm packages,
 * path aliases) are skipped, same as the other two languages skip
 * out-of-repo symbols. */
function resolveImportTarget(fromRel, specifier, relSet) {
  if (!specifier.startsWith(".")) return null;
  const fromDir = path.posix.dirname(fromRel);
  const joined = path.posix.normalize(path.posix.join(fromDir, specifier));
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = (joined + suffix).replace(/^(\.\/)+/, "");
    if (relSet.has(candidate)) return candidate;
  }
  return null;
}

function findImportEdges(sourceFile, fromRel, relSet) {
  const targets = new Set();
  (function visit(n) {
    let specifier = null;
    if (
      (n.kind === ts.SyntaxKind.ImportDeclaration || n.kind === ts.SyntaxKind.ExportDeclaration)
      && n.moduleSpecifier && n.moduleSpecifier.kind === ts.SyntaxKind.StringLiteral
    ) {
      specifier = n.moduleSpecifier.text;
    } else if (
      n.kind === ts.SyntaxKind.CallExpression && n.expression.kind === ts.SyntaxKind.ImportKeyword
      && n.arguments[0] && n.arguments[0].kind === ts.SyntaxKind.StringLiteral
    ) {
      specifier = n.arguments[0].text; // dynamic import("./foo")
    }
    if (specifier) {
      const target = resolveImportTarget(fromRel, specifier, relSet);
      if (target && target !== fromRel) targets.add(target);
    }
    ts.forEachChild(n, visit);
  })(sourceFile);
  return [...targets].map((target) => ({ source: fromRel, target, edge_type: "code_import" }));
}

module.exports = { findImportEdges };

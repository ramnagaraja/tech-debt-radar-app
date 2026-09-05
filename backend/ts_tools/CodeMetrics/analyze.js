#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const { findTsFiles } = require("./fileWalk");
const { analyzeFile } = require("./complexity");
const { scanFile } = require("./security");
const { findImportEdges } = require("./dependencyGraph");
const { countAnyUsage, countManyBooleanProps, countStaticUtilityClasses, readNonStrictFlag, detectFramework } = require("./frontendChecks");

function main() {
  const [, , repoPathArg, outPathArg] = process.argv;
  if (!repoPathArg || !outPathArg) {
    console.error("Usage: node analyze.js <repoPath> <outputJsonPath>");
    process.exit(1);
  }
  const repoPath = path.resolve(repoPathArg);
  const outPath = path.resolve(outPathArg);

  const files = findTsFiles(repoPath);
  const relSet = new Set(files.map((f) => f.rel));
  const nonStrict = readNonStrictFlag(repoPath);
  const framework = detectFramework(repoPath, files);

  const outFiles = {};
  const edges = [];

  for (const { full, rel } of files) {
    let text;
    try {
      text = fs.readFileSync(full, "utf-8");
    } catch (e) {
      console.error(`[skip] ${rel}: ${e.message}`);
      continue;
    }

    let scriptKind = ts.ScriptKind.TS;
    if (rel.endsWith(".tsx")) scriptKind = ts.ScriptKind.TSX;
    else if (rel.endsWith(".jsx")) scriptKind = ts.ScriptKind.JSX;
    else if (rel.endsWith(".js")) scriptKind = ts.ScriptKind.JS;

    let sourceFile;
    try {
      sourceFile = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKind);
    } catch (e) {
      console.error(`[parse-error] ${rel}: ${e.message}`);
      continue;
    }

    const metrics = analyzeFile(sourceFile, text);
    const security = scanFile(sourceFile);
    // "Strict type checking" isn't a concept that applies to untyped JS —
    // scoring a plain .js/.jsx file down for a non-strict tsconfig (or one
    // that doesn't even mention it) would be misleading, so this only ever
    // reflects real TypeScript files.
    const isTsFile = rel.endsWith(".ts") || rel.endsWith(".tsx");

    outFiles[rel] = {
      ...metrics,
      ...security,
      any_usage_count: countAnyUsage(sourceFile),
      non_strict_typescript: isTsFile ? nonStrict : false,
      static_utility_class_count: countStaticUtilityClasses(sourceFile),
      many_boolean_props_count: countManyBooleanProps(sourceFile),
    };

    edges.push(...findImportEdges(sourceFile, rel, relSet));
  }

  fs.writeFileSync(outPath, JSON.stringify({ files: outFiles, edges, framework }));
}

main();

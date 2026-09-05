const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const { isExported } = require("./complexity");
const { findConfigFiles } = require("./fileWalk");

const MANY_BOOLEAN_PROPS_THRESHOLD = 4;

/** Every explicit `any` — as a type annotation, a generic argument, or an
 * `as any` cast — is an AnyKeyword node in the type position; counting that
 * one syntax kind covers all three forms. Directly the design-practices
 * doc's #1 practice: "Enforce Strict Type Checking... avoid using any." */
function countAnyUsage(sourceFile) {
  let count = 0;
  (function visit(n) {
    if (n.kind === ts.SyntaxKind.AnyKeyword) count++;
    ts.forEachChild(n, visit);
  })(sourceFile);
  return count;
}

function isBooleanType(typeNode) {
  if (!typeNode) return false;
  if (typeNode.kind === ts.SyntaxKind.BooleanKeyword) return true;
  if (typeNode.kind === ts.SyntaxKind.UnionType) {
    return typeNode.types.some((t) => t.kind === ts.SyntaxKind.BooleanKeyword);
  }
  return false;
}

/** The doc's "avoid dozens of boolean flags" (React: prop-slotting over
 * config objects; Angular: same idea) made concrete as two
 * framework-appropriate syntactic shapes. A file only ever matches one, so
 * both are always checked rather than gating on detected framework. */
function countManyBooleanProps(sourceFile) {
  let count = 0;

  // React: an interface/type named "*Props" with several boolean members.
  (function visit(n) {
    if (
      (n.kind === ts.SyntaxKind.InterfaceDeclaration || n.kind === ts.SyntaxKind.TypeAliasDeclaration)
      && /Props$/.test(n.name.text)
    ) {
      const members = n.kind === ts.SyntaxKind.InterfaceDeclaration
        ? n.members
        : (n.type && n.type.kind === ts.SyntaxKind.TypeLiteral ? n.type.members : []);
      const boolCount = members.filter(
        (m) => m.kind === ts.SyntaxKind.PropertySignature && isBooleanType(m.type)
      ).length;
      if (boolCount > MANY_BOOLEAN_PROPS_THRESHOLD) count++;
    }
    ts.forEachChild(n, visit);
  })(sourceFile);

  // Angular: a @Component/@Directive class with several @Input() boolean properties.
  (function visit(n) {
    if (n.kind === ts.SyntaxKind.ClassDeclaration) {
      const hasComponentDecorator = decoratorsOf(n).some((d) => {
        const expr = d.expression;
        const name = expr.kind === ts.SyntaxKind.CallExpression ? calleeIdentifier(expr.expression) : calleeIdentifier(expr);
        return name === "Component" || name === "Directive";
      });
      if (hasComponentDecorator) {
        const boolInputs = n.members.filter((m) => {
          if (m.kind !== ts.SyntaxKind.PropertyDeclaration) return false;
          const isInput = decoratorsOf(m).some((d) => {
            const expr = d.expression;
            const name = expr.kind === ts.SyntaxKind.CallExpression ? calleeIdentifier(expr.expression) : calleeIdentifier(expr);
            return name === "Input";
          });
          if (!isInput) return false;
          if (isBooleanType(m.type)) return true;
          // Untyped @Input() x = false; — TS infers boolean from the initializer.
          return !m.type && m.initializer
            && (m.initializer.kind === ts.SyntaxKind.TrueKeyword || m.initializer.kind === ts.SyntaxKind.FalseKeyword);
        }).length;
        if (boolInputs > MANY_BOOLEAN_PROPS_THRESHOLD) count++;
      }
    }
    ts.forEachChild(n, visit);
  })(sourceFile);

  return count;
}

function calleeIdentifier(expr) {
  return expr && expr.kind === ts.SyntaxKind.Identifier ? expr.text : null;
}

/** ts.getDecorators() returns undefined (not []) when a node has no
 * decorators — always normalize to a real array. */
function decoratorsOf(node) {
  return (ts.getDecorators ? ts.getDecorators(node) : node.decorators) || [];
}

/** The doc's "Tree-Shakable Utilities: favor pure functions... over
 * sprawling static utility classes" — an exported class where every member
 * (excluding the constructor) is `static`. */
function countStaticUtilityClasses(sourceFile) {
  let count = 0;
  (function visit(n) {
    if (n.kind === ts.SyntaxKind.ClassDeclaration && isExported(n)) {
      const relevant = n.members.filter((m) => m.kind !== ts.SyntaxKind.Constructor);
      if (relevant.length > 0 && relevant.every((m) => {
        const mods = (ts.canHaveModifiers(m) ? ts.getModifiers(m) : []) || [];
        return mods.some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword);
      })) {
        count++;
      }
    }
    ts.forEachChild(n, visit);
  })(sourceFile);
  return count;
}

/** Repo-level fact, applied uniformly to every real TypeScript file's
 * design_detail — same pattern as god_file being a binary 0/1 that still
 * runs through normalize(). Finds the shallowest tsconfig.json anywhere
 * under repoPath (not just at repoPath itself — in a repo that bundles a
 * backend with a separate frontend folder, that's where the real TS
 * project root is) and reads it once per repo, not once per file. */
function readNonStrictFlag(repoPath) {
  const candidates = findConfigFiles(repoPath, "tsconfig.json");
  if (candidates.length === 0) return true; // no tsconfig at all reads as "not strict"
  try {
    const merged = mergeTsconfig(candidates[0], 0);
    const opts = merged.compilerOptions || {};
    if (opts.strict === true) return false;
    const required = ["noImplicitAny", "strictNullChecks"];
    if (required.every((k) => opts[k] === true)) return false;
    return true;
  } catch {
    return true;
  }
}

function stripJsonComments(text) {
  // tsconfig.json commonly has // and /* */ comments (JSONC) — strip before JSON.parse.
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function mergeTsconfig(configPath, depth) {
  if (depth > 2) return {};
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(stripJsonComments(raw)) || {};
  let base = {};
  if (parsed.extends) {
    const basePath = path.resolve(path.dirname(configPath), parsed.extends);
    const candidate = basePath.endsWith(".json") ? basePath : basePath + ".json";
    if (fs.existsSync(candidate)) {
      try {
        base = mergeTsconfig(candidate, depth + 1);
      } catch {
        base = {};
      }
    }
  }
  return { compilerOptions: { ...(base.compilerOptions || {}), ...(parsed.compilerOptions || {}) } };
}

/** angular.json anywhere => Angular; a react/react-dom dependency in any
 * package.json, or any .tsx/.jsx file, => React; otherwise generic
 * TypeScript/JavaScript. Searched anywhere under repoPath, not just at its
 * root — in a repo that bundles a backend with a separate frontend folder,
 * that's where the real project markers live. Reported for display only —
 * it doesn't change which checks run (the boolean-props check already
 * covers both frameworks' own syntactic shape unconditionally). */
function detectFramework(repoPath, files) {
  if (findConfigFiles(repoPath, "angular.json").length > 0) return "angular";
  for (const pkgPath of findConfigFiles(repoPath, "package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.react || deps["react-dom"]) return "react";
    } catch {
      /* ignore malformed package.json */
    }
  }
  if (files.some((f) => f.rel.endsWith(".tsx") || f.rel.endsWith(".jsx"))) return "react";
  return "typescript";
}

module.exports = { countAnyUsage, countManyBooleanProps, countStaticUtilityClasses, readNonStrictFlag, detectFramework };

const ts = require("typescript");
const crypto = require("crypto");

const MIN_HASHED_FUNCTION_LINES = 3;
const LONG_CHAIN_BRANCH_THRESHOLD = 5;
const LONG_FUNCTION_LINES = 50;
const MANY_PARAMS_THRESHOLD = 5;
const GOD_FILE_LOC = 500;

const NESTING_KINDS = new Set([
  ts.SyntaxKind.IfStatement, ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.TryStatement, ts.SyntaxKind.SwitchStatement,
]);

const FUNCTION_DECL_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.Constructor,
]);

function isCountedFunction(node) {
  if (FUNCTION_DECL_KINDS.has(node.kind)) return true;
  // Arrow functions are everywhere in TS/React (components, hooks, callbacks) —
  // only block-bodied ones ("{ ... }", not a one-line expression body) represent
  // real logic worth tracking as their own "function" for these metrics.
  if (node.kind === ts.SyntaxKind.ArrowFunction && node.body && node.body.kind === ts.SyntaxKind.Block) return true;
  return false;
}

function getLine(sourceFile, pos) {
  return sourceFile.getLineAndCharacterOfPosition(pos).line;
}

function computeSloc(text) {
  let sloc = 0;
  let inBlockComment = false;
  for (let line of text.split("\n")) {
    let trimmed = line.trim();
    if (inBlockComment) {
      const endIdx = trimmed.indexOf("*/");
      if (endIdx === -1) continue;
      trimmed = trimmed.slice(endIdx + 2).trim();
      inBlockComment = false;
    }
    if (!trimmed || trimmed.startsWith("//")) continue;
    const startIdx = trimmed.indexOf("/*");
    if (startIdx !== -1 && trimmed.indexOf("*/", startIdx + 2) === -1) {
      const before = trimmed.slice(0, startIdx).trim();
      inBlockComment = true;
      if (!before) continue;
    }
    sloc++;
  }
  return sloc;
}

function computeCyclomaticComplexity(node) {
  let complexity = 1;
  function visit(n) {
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
        complexity++;
        break;
      case ts.SyntaxKind.BinaryExpression:
        if (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
          complexity++;
        }
        break;
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return complexity;
}

function maxNestingDepth(node, depth) {
  let max = depth;
  ts.forEachChild(node, (child) => {
    const nextDepth = NESTING_KINDS.has(child.kind) ? depth + 1 : depth;
    max = Math.max(max, maxNestingDepth(child, nextDepth));
  });
  return max;
}

function getParameters(node) {
  const params = node.parameters || [];
  // A leading `this: SomeType` parameter is compile-time-only typing, never a
  // real runtime argument — exclude it, same as self/cls (Python) and `this`
  // extension-method params (C#).
  return params.filter((p) => !(p.name && p.name.kind === ts.SyntaxKind.Identifier && p.name.text === "this"));
}

function isExported(node) {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node) || [];
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** Flat token-kind sequence with identifiers/literals blanked out — the same
 * "identifier-blind shape" duplicate-detection technique as the C# tool's
 * HashBody (different mechanics, same goal; never expected to collide across
 * languages, only within one). */
function hashBody(node, sourceFile) {
  const parts = [];
  function visit(n) {
    const children = n.getChildren(sourceFile);
    if (children.length === 0) {
      if (n.kind === ts.SyntaxKind.Identifier) parts.push("ID");
      else if (
        n.kind === ts.SyntaxKind.NumericLiteral || n.kind === ts.SyntaxKind.StringLiteral
        || n.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
      ) parts.push("LIT");
      else parts.push(String(n.kind));
    } else {
      for (const c of children) visit(c);
    }
  }
  visit(node);
  return crypto.createHash("sha1").update(parts.join(";")).digest("hex").slice(0, 16);
}

function ifChainBranchCount(ifNode) {
  let count = 1;
  let current = ifNode;
  while (current.elseStatement && current.elseStatement.kind === ts.SyntaxKind.IfStatement) {
    count++;
    current = current.elseStatement;
  }
  if (current.elseStatement) count++; // trailing plain else
  return count;
}

function countLongConditionalChains(root) {
  const elseIfContinuations = new Set();
  function findChains(n) {
    if (n.kind === ts.SyntaxKind.IfStatement) {
      let current = n;
      while (current.elseStatement && current.elseStatement.kind === ts.SyntaxKind.IfStatement) {
        elseIfContinuations.add(current.elseStatement);
        current = current.elseStatement;
      }
    }
    ts.forEachChild(n, findChains);
  }
  findChains(root);

  let count = 0;
  function countChains(n) {
    if (n.kind === ts.SyntaxKind.IfStatement && !elseIfContinuations.has(n)) {
      if (ifChainBranchCount(n) > LONG_CHAIN_BRANCH_THRESHOLD) count++;
    } else if (n.kind === ts.SyntaxKind.SwitchStatement) {
      if (n.caseBlock.clauses.length > LONG_CHAIN_BRANCH_THRESHOLD) count++;
    }
    ts.forEachChild(n, countChains);
  }
  countChains(root);
  return count;
}

/** Halstead volume from the whole file's leaf-token stream, same formula as
 * radon (Python) and the C# tool: MI = max(0, (171 - 5.2*ln(V) - 0.23*CC -
 * 16.2*ln(LOC)) * 100/171). */
function computeMaintainabilityIndex(sourceFile, avgComplexity, loc) {
  const operators = new Map();
  const operands = new Map();
  const OPERAND_KINDS = new Set([
    ts.SyntaxKind.Identifier, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TrueKeyword,
    ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword,
  ]);

  function visit(n) {
    const children = n.getChildren(sourceFile);
    if (children.length === 0) {
      const bucket = OPERAND_KINDS.has(n.kind) ? operands : operators;
      const key = n.getText(sourceFile);
      bucket.set(key, (bucket.get(key) || 0) + 1);
    } else {
      for (const c of children) visit(c);
    }
  }
  visit(sourceFile);

  const n1 = operators.size, n2 = operands.size;
  let bigN1 = 0, bigN2 = 0;
  for (const v of operators.values()) bigN1 += v;
  for (const v of operands.values()) bigN2 += v;
  const vocabulary = n1 + n2;
  const length = bigN1 + bigN2;
  const halsteadVolume = vocabulary > 0 ? length * Math.log2(vocabulary) : 0;

  const safeLoc = Math.max(loc, 1);
  const safeVolume = Math.max(halsteadVolume, 1);
  let mi = 171 - 5.2 * Math.log(safeVolume) - 0.23 * avgComplexity - 16.2 * Math.log(safeLoc);
  mi = Math.max(0, (mi * 100) / 171);
  return Math.min(100, mi);
}

function analyzeFile(sourceFile, text) {
  const loc = text.split("\n").length;
  const sloc = computeSloc(text);

  const functionNodes = [];
  (function collect(n) {
    if (isCountedFunction(n)) functionNodes.push(n);
    ts.forEachChild(n, collect);
  })(sourceFile);

  const complexities = [];
  let longFunctions = 0, manyParams = 0, maxNesting = 0, publicSurface = 0;
  const functionHashes = [];

  for (const fn of functionNodes) {
    const cc = computeCyclomaticComplexity(fn.body || fn);
    complexities.push(cc);

    const startLine = getLine(sourceFile, fn.getStart(sourceFile));
    const endLine = getLine(sourceFile, fn.getEnd());
    const lines = endLine - startLine + 1;
    if (lines > LONG_FUNCTION_LINES) longFunctions++;

    if (getParameters(fn).length > MANY_PARAMS_THRESHOLD) manyParams++;
    if (lines >= MIN_HASHED_FUNCTION_LINES) functionHashes.push(hashBody(fn.body || fn, sourceFile));

    maxNesting = Math.max(maxNesting, maxNestingDepth(fn, 0));
  }

  // Public surface = TypeScript's actual visibility unit: what a module exports.
  (function collectExports(n) {
    if (
      (n.kind === ts.SyntaxKind.FunctionDeclaration || n.kind === ts.SyntaxKind.ClassDeclaration)
      && isExported(n)
    ) {
      publicSurface++;
    } else if (n.kind === ts.SyntaxKind.VariableStatement && isExported(n)) {
      publicSurface += n.declarationList.declarations.length;
    }
    // Don't descend into nested scopes for export counting — only module-level exports count.
    if (n.kind === ts.SyntaxKind.SourceFile) ts.forEachChild(n, collectExports);
  })(sourceFile);

  const avgComplexity = complexities.length ? complexities.reduce((a, b) => a + b, 0) / complexities.length : 0;
  const maxComplexity = complexities.length ? Math.max(...complexities) : 0;
  const mi = computeMaintainabilityIndex(sourceFile, avgComplexity || 1, loc);

  return {
    loc, sloc,
    avg_complexity: Math.round(avgComplexity * 100) / 100,
    max_complexity: maxComplexity,
    maintainability_index: Math.round(mi * 100) / 100,
    function_count: functionNodes.length,
    long_function_count: longFunctions,
    max_nesting_depth: maxNesting,
    many_params_count: manyParams,
    god_file: loc > GOD_FILE_LOC,
    function_hashes: functionHashes,
    public_function_count: publicSurface,
    long_conditional_chain_count: countLongConditionalChains(sourceFile),
  };
}

module.exports = { analyzeFile, isExported };

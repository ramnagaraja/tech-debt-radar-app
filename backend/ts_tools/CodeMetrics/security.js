const ts = require("typescript");

/** Lightweight, purely syntactic security checks — the TS/React/Angular
 * counterpart to bandit (Python) and SecurityScanner.cs (.NET). No type
 * checker needed: every pattern here is identifiable from syntax shape
 * alone, same spirit as the .NET tool's semantic checks but without
 * requiring cross-file resolution. Severity/confidence weighting mirrors
 * both other languages exactly, so security sub-scores stay comparable. */

const SEVERITY_WEIGHT = { LOW: 1.0, MEDIUM: 3.0, HIGH: 6.0 };
const CONFIDENCE_WEIGHT = { LOW: 0.5, MEDIUM: 0.75, HIGH: 1.0 };

const SECRET_NAME_HINTS = [
  "password", "passwd", "pwd", "secret", "apikey", "accesskey",
  "connectionstring", "token", "privatekey", "clientsecret",
];
const PROTECTED_HINTS = ["hash", "encrypted", "digest", "salt"];

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function calleeName(expr) {
  if (expr.kind === ts.SyntaxKind.Identifier) return expr.text;
  if (expr.kind === ts.SyntaxKind.PropertyAccessExpression) return expr.name.text;
  return null;
}

function scanFile(sourceFile) {
  const issues = [];

  function push(node, severity, confidence, testId, text) {
    issues.push({ severity, confidence, test_id: testId, text, line: lineOf(sourceFile, node) });
  }

  function visit(node) {
    switch (node.kind) {
      case ts.SyntaxKind.CallExpression: {
        const name = calleeName(node.expression);
        if (name === "eval") {
          push(node, "HIGH", "HIGH", "TS-EVAL", "eval() executes a string as code - a classic injection vector.");
        } else if (name && name.startsWith("bypassSecurityTrust")) {
          push(node, "HIGH", "HIGH", "TS-ANGULAR-SANITIZER-BYPASS",
            `Angular DomSanitizer.${name}() disables XSS protection for this value - verify it can't contain attacker-controlled content.`);
        }
        break;
      }
      case ts.SyntaxKind.NewExpression: {
        const name = calleeName(node.expression);
        if (name === "Function") {
          push(node, "HIGH", "HIGH", "TS-NEW-FUNCTION", "new Function(...) compiles a string as code - a classic injection vector, like eval().");
        }
        break;
      }
      case ts.SyntaxKind.JsxAttribute: {
        if (node.name && node.name.text === "dangerouslySetInnerHTML") {
          push(node, "MEDIUM", "HIGH", "TS-DANGEROUS-INNERHTML",
            "dangerouslySetInnerHTML renders raw HTML - an XSS risk unless the content is sanitized.");
        }
        break;
      }
      case ts.SyntaxKind.BinaryExpression: {
        if (
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && node.left.kind === ts.SyntaxKind.PropertyAccessExpression
          && (node.left.name.text === "innerHTML" || node.left.name.text === "outerHTML")
        ) {
          push(node, "MEDIUM", "HIGH", "TS-INNERHTML-ASSIGN",
            `Direct assignment to .${node.left.name.text} renders raw HTML - an XSS risk unless the value is sanitized.`);
        }
        break;
      }
      case ts.SyntaxKind.VariableDeclaration: {
        if (
          node.name.kind === ts.SyntaxKind.Identifier
          && node.initializer && node.initializer.kind === ts.SyntaxKind.StringLiteral
          && node.initializer.text.trim()
        ) {
          const lower = node.name.text.toLowerCase();
          const protectedMatch = PROTECTED_HINTS.some((h) => lower.includes(h));
          const secretMatch = SECRET_NAME_HINTS.some((h) => lower.includes(h));
          if (!protectedMatch && secretMatch) {
            push(node, "HIGH", "MEDIUM", "TS-HARDCODED-SECRET",
              `'${node.name.text}' looks like a secret assigned a hardcoded string literal.`);
          }
        }
        break;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  let weighted = 0, highCount = 0;
  for (const issue of issues) {
    if (issue.severity === "HIGH") highCount++;
    weighted += (SEVERITY_WEIGHT[issue.severity] || 1.0) * (CONFIDENCE_WEIGHT[issue.confidence] || 0.5);
  }

  return {
    security_issue_count: issues.length,
    security_high_count: highCount,
    security_weighted: Math.round(weighted * 100) / 100,
    security_issues: issues.slice(0, 5),
  };
}

module.exports = { scanFile };

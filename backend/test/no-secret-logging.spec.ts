/**
 * Guard: Email-Ops must never log secrets.
 *
 * Parses every TypeScript file under backend/src with the compiler API
 * (no regex on raw text) and flags calls to console.(log|info|warn|error|debug)
 * and this.logger./logger./Logger.(log|warn|error|debug|verbose) whose
 * arguments (including template-literal spans and object-literal values)
 * reference an identifier or property name containing a secret-ish term.
 *
 * Boolean-safe usages are allowed: !!x, Boolean(x), x ? 'yes' : 'no',
 * x == null checks, and x.length.
 *
 * main currently carries two reviewed false positives (see BASELINE), so the
 * strict zero-hit check runs as it.failing until they are cleaned up; the
 * enforcing test is the baseline-diff check: any NEW hit fails the suite.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC_DIR = path.join(__dirname, '..', 'src');

const SUSPECT_TERMS = [
  'password',
  'token',
  'secret',
  'apikey',
  'api_key',
  'refreshtoken',
  'accesstoken',
  'cookie',
  'authorization',
  'privatekey',
  'enckey',
];

const CONSOLE_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug']);
const LOGGER_METHODS = new Set(['log', 'warn', 'error', 'debug', 'verbose']);

interface LeakHit {
  file: string;
  line: number;
  method: string;
  expression: string;
  identifier: string;
}

function isSuspectName(name: string): boolean {
  const lower = name.toLowerCase();
  return SUSPECT_TERMS.some((term) => lower.includes(term));
}

/**
 * A call to console.(log|info|warn|error|debug), or to
 * (this.)logger./Logger.(log|warn|error|debug|verbose). Returns the method
 * name when the call is a logging call, null otherwise.
 */
function logCallMethod(node: ts.CallExpression): string | null {
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return null;
  }
  const method = node.expression.name.text;
  const receiver = node.expression.expression;
  if (ts.isIdentifier(receiver) && receiver.text === 'console') {
    return CONSOLE_METHODS.has(method) ? method : null;
  }
  if (ts.isIdentifier(receiver) && (receiver.text === 'logger' || receiver.text === 'Logger')) {
    return LOGGER_METHODS.has(method) ? method : null;
  }
  if (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.name.text === 'logger' &&
    receiver.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    return LOGGER_METHODS.has(method) ? method : null;
  }
  return null;
}

/**
 * Expressions that reveal only a boolean or a length, never the secret
 * itself: !!x / !x, Boolean(x), x ? 'yes' : 'no', x == null (and friends).
 */
function isBooleanSafe(node: ts.Node): boolean {
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return true;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'Boolean'
  ) {
    return true;
  }
  if (
    ts.isConditionalExpression(node) &&
    ts.isStringLiteralLike(node.whenTrue) &&
    ts.isStringLiteralLike(node.whenFalse)
  ) {
    return true;
  }
  const nullish = [
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ];
  if (
    ts.isBinaryExpression(node) &&
    nullish.includes(node.operatorToken.kind) &&
    (node.right.kind === ts.SyntaxKind.NullKeyword || node.left.kind === ts.SyntaxKind.NullKeyword)
  ) {
    return true;
  }
  return false;
}

/**
 * Collect identifier / property-access nodes inside `node` that name a
 * secret-ish term. Object literals are checked by value (keys are not
 * leaks); `.length` accesses and boolean-safe wrappers stop the descent.
 */
function collectLeaks(node: ts.Node, out: ts.Node[]): void {
  if (isBooleanSafe(node)) {
    return;
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (node.name.text === 'length') {
      return;
    }
    if (isSuspectName(node.name.text)) {
      out.push(node);
      return;
    }
    collectLeaks(node.expression, out);
    return;
  }
  if (ts.isIdentifier(node)) {
    if (isSuspectName(node.text)) {
      out.push(node);
    }
    return;
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        collectLeaks(prop.initializer, out);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        if (isSuspectName(prop.name.text)) {
          out.push(prop.name);
        }
      } else {
        collectLeaks(prop, out);
      }
    }
    return;
  }
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node)
  ) {
    return;
  }
  node.forEachChild((child) => collectLeaks(child, out));
}

/** Analyze one source text and return every secret-logging hit in it. */
export function analyzeSource(fileName: string, sourceText: string): LeakHit[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const hits: LeakHit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const method = logCallMethod(node);
      if (method) {
        for (const arg of node.arguments) {
          const leaks: ts.Node[] = [];
          collectLeaks(arg, leaks);
          for (const leak of leaks) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(leak.getStart(sourceFile));
            hits.push({
              file: fileName,
              line: line + 1,
              method,
              expression: arg.getText(sourceFile),
              identifier: leak.getText(sourceFile),
            });
          }
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return hits;
}

function listSourceFiles(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'tests' || entry.name === '__tests__') {
        continue;
      }
      listSourceFiles(full, out);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.spec.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function scanSrcDir(): LeakHit[] {
  const hits: LeakHit[] = [];
  for (const file of listSourceFiles(SRC_DIR, [])) {
    const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
    hits.push(...analyzeSource(rel, fs.readFileSync(file, 'utf8')));
  }
  return hits;
}

/**
 * Hits that exist on main and were reviewed as false positives. The guard
 * fails only on hits NOT listed here.
 */
const BASELINE: Array<{ file: string; identifier: string; verdict: string }> = [
  {
    file: 'auth/pat.service.ts',
    identifier: 'tokenPrefix',
    verdict:
      'false positive: logs a truncated display prefix of a legacy PAT, never the secret itself',
  },
  {
    file: 'connected-accounts/connected-accounts.service.ts',
    identifier: 'refreshTokenCleared',
    verdict:
      'false positive: logs a boolean flag about whether a refresh token was cleared, not a token value',
  },
];

describe('no secret logging', () => {
  it('flags console.log(password) in an injected sample', () => {
    const hits = analyzeSource('injected.ts', 'console.log(password);\n');
    expect(hits).toHaveLength(1);
    expect(hits[0].identifier).toBe('password');
  });

  it('flags template spans, object values and logger calls', () => {
    const src = [
      'this.logger.log(`user ${user.id} pw=${account.password}`);',
      'logger.debug({ refreshToken: refreshToken, id: 1 });',
      'Logger.error({ apiKey });',
      'console.info(config.api_key);',
    ].join('\n');
    const hits = analyzeSource('injected.ts', src);
    expect(hits.map((h) => h.identifier).sort()).toEqual(
      ['account.password', 'apiKey', 'config.api_key', 'refreshToken'].sort(),
    );
  });

  it('allows boolean-safe usages', () => {
    const src = [
      'console.log(!!password);',
      'console.log(Boolean(account.refreshToken));',
      'this.logger.log(user.password ? "yes" : "no");',
      'logger.warn(token == null);',
      'console.debug(secret.length);',
      'console.log("password rotated for " + user.email);',
    ].join('\n');
    expect(analyzeSource('safe.ts', src)).toEqual([]);
  });

  it('adds no new secret-logging sites beyond the reviewed baseline', () => {
    const remaining = [...BASELINE];
    const newHits = scanSrcDir().filter((hit) => {
      const idx = remaining.findIndex(
        (b) => b.file === hit.file && b.identifier === hit.identifier,
      );
      if (idx === -1) {
        return true;
      }
      remaining.splice(idx, 1);
      return false;
    });
    expect(
      newHits.map((h) => `${h.file}:${h.line} ${h.method}(...) references ${h.identifier}`),
    ).toEqual([]);
  });

  // Strict check: main is not yet zero-hit (two reviewed false positives in
  // BASELINE), so this is expected to fail until they are cleaned up. When it
  // starts passing, jest will fail it: delete this test and the BASELINE.
  it.failing('main has zero secret-logging sites', () => {
    expect(scanSrcDir().map((h) => `${h.file}:${h.line} ${h.identifier}`)).toEqual([]);
  });
});

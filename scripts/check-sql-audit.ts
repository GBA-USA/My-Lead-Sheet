import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import ts from "typescript";
import { Phone, startApi } from "./api-session.ts";

/**
 * Is user input ever put straight into a database query? Three parts, no network and no real database:
 * 1. A static pass over every `worker/**` file. Every call that runs SQL (`.exec`, `.prepare`, `.batch`, `.raw` on a
 *    `sql` handle, or any call whose first argument reads as SQL) must take its SQL text from code alone. A `${...}` or
 *    a `+` inside that text may only name a top-level constant of fixed text in the same file, or a name checked
 *    just before by an allow-list constant (`if (!LIST.includes(x)) throw`, or an anchored `^...$` pattern's `.test`).
 *    A text passed in through a parameter is fixed only when the helper is not exported and every call in the file
 *    passes fixed text. Every value goes through `?` and the bindings. `LIKE` needs an `ESCAPE` clause.
 * 2. The same pass run on made-up sources, so each rule is shown to turn red on the mistake it names.
 * 3. Real Worker routes under Miniflare with no saved state, and Worker modules on an in-memory node:sqlite, sent
 *    classic injection strings and compared with a plain value that matches nothing.
 * `--inventory` prints every SQL call as a table row instead.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const shown = (file: string) => relative(root, file).split(sep).join("/");

let failed = 0;
async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type Verdict = "bound" | "fixed" | "allow-listed" | "unbound";
type SqlCall = { file: string; line: number; method: string; text: string; values: string[]; verdict: Verdict; problems: string[] };

const SQL_METHODS = new Set(["exec", "prepare", "batch", "raw"]);
const SQL_HEAD = /^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|WITH|ATTACH|DETACH|VACUUM|BEGIN|COMMIT|ROLLBACK)\b/i;
const LOOSE_PATTERN = /(^|[^\\])\.|\\[sSwWdD]|\[\^/;

const unwrap = (node: ts.Expression): ts.Expression => {
  let at = node;
  while (ts.isParenthesizedExpression(at) || ts.isAsExpression(at) || ts.isSatisfiesExpression(at) || ts.isTypeAssertionExpression(at) || ts.isNonNullExpression(at)) at = at.expression;
  return at;
};

const isFunctionLike = (node: ts.Node): node is ts.SignatureDeclaration & { body?: ts.Node } =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node);

const hasExport = (node: ts.Node) => (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword) : false);

function audit(file: string, text: string): SqlCall[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const topConsts = new Map<string, ts.Expression>();
  const exported = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        topConsts.set(declaration.name.text, declaration.initializer);
        if (hasExport(statement)) exported.add(declaration.name.text);
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name && hasExport(statement)) exported.add(statement.name.text);
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const item of statement.exportClause.elements) exported.add((item.propertyName ?? item.name).text);
    }
  }

  const fixedSeen = new Set<string>();
  /** Text that comes from code alone: literals, and top-level constants built only from literals. */
  function fixed(node: ts.Expression): boolean {
    const at = unwrap(node);
    if (ts.isStringLiteral(at) || ts.isNoSubstitutionTemplateLiteral(at) || ts.isNumericLiteral(at)) return true;
    if (ts.isTemplateExpression(at)) return at.templateSpans.every((span) => fixed(span.expression));
    if (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.PlusToken) return fixed(at.left) && fixed(at.right);
    if (ts.isArrayLiteralExpression(at)) return at.elements.every((element) => fixed(element as ts.Expression));
    if (ts.isObjectLiteralExpression(at)) return at.properties.every((p) => ts.isPropertyAssignment(p) && fixed(p.initializer));
    if (ts.isIdentifier(at)) {
      const init = topConsts.get(at.text);
      if (!init || fixedSeen.has(at.text)) return false;
      fixedSeen.add(at.text);
      const result = fixed(init);
      fixedSeen.delete(at.text);
      return result;
    }
    return false;
  }

  /** A top-level constant that lists the only names allowed: an array or Set of string literals, or an anchored pattern with no wildcard. */
  function allowList(name: string): boolean {
    const init = topConsts.get(name);
    if (!init) return false;
    const at = unwrap(init);
    if (ts.isRegularExpressionLiteral(at)) {
      const match = /^\/(.*)\/([a-z]*)$/s.exec(at.text);
      return !!match && match[1].startsWith("^") && match[1].endsWith("$") && !match[2].includes("m") && !LOOSE_PATTERN.test(match[1]);
    }
    const strings = (list: ts.Expression) => ts.isArrayLiteralExpression(list) && list.elements.length > 0 && list.elements.every((e) => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e));
    if (ts.isArrayLiteralExpression(at)) return strings(at);
    if (ts.isNewExpression(at) && ts.isIdentifier(at.expression) && at.expression.text === "Set" && at.arguments?.length === 1) return strings(unwrap(at.arguments[0]));
    return false;
  }

  function isGuard(statement: ts.Statement, name: string): boolean {
    if (!ts.isIfStatement(statement)) return false;
    const then = statement.thenStatement;
    const throws = ts.isThrowStatement(then) || (ts.isBlock(then) && then.statements.length === 1 && ts.isThrowStatement(then.statements[0]));
    if (!throws) return false;
    const terms: ts.Expression[] = [];
    const flatten = (e: ts.Expression) => {
      const at = unwrap(e);
      if (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        flatten(at.left);
        flatten(at.right);
      } else terms.push(at);
    };
    flatten(statement.expression);
    return terms.some((term) => {
      if (!ts.isPrefixUnaryExpression(term) || term.operator !== ts.SyntaxKind.ExclamationToken) return false;
      const call = unwrap(term.operand);
      if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression) || !ts.isIdentifier(call.expression.expression)) return false;
      const arg = call.arguments[0] && unwrap(call.arguments[0]);
      return ["test", "includes", "has"].includes(call.expression.name.text) && !!arg && ts.isIdentifier(arg) && arg.text === name && allowList(call.expression.expression.text);
    });
  }

  /** Whether `name` was checked against an allow-list in a block around `at`, before it, inside the same function. */
  function guarded(name: string, at: ts.Node): boolean {
    for (let node: ts.Node = at; node.parent; node = node.parent) {
      const parent = node.parent;
      if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
        for (const statement of parent.statements) {
          if (statement.pos >= node.pos) break;
          if (isGuard(statement, name)) return true;
        }
      }
      if (isFunctionLike(parent)) return false;
    }
    return false;
  }

  /** The local `const`, `for ... of` binding or parameter that `name` refers to at `at`, nearest first. */
  function declarationOf(name: string, at: ts.Node): { kind: "const"; init: ts.Expression } | { kind: "of"; list: ts.Expression } | { kind: "param"; fn: ts.SignatureDeclaration; index: number } | null {
    const binds = (pattern: ts.BindingName): boolean =>
      ts.isIdentifier(pattern) ? pattern.text === name : pattern.elements.some((e) => !ts.isOmittedExpression(e) && binds(e.name));
    for (let node: ts.Node = at; node.parent; node = node.parent) {
      const parent = node.parent;
      if (ts.isBlock(parent)) {
        for (const statement of parent.statements) {
          if (statement.pos >= node.pos) break;
          if (!ts.isVariableStatement(statement)) continue;
          for (const d of statement.declarationList.declarations) {
            if (!binds(d.name)) continue;
            if (ts.isIdentifier(d.name) && d.initializer && statement.declarationList.flags & ts.NodeFlags.Const) return { kind: "const", init: d.initializer };
            return null;
          }
        }
      }
      if (ts.isForOfStatement(parent) && ts.isVariableDeclarationList(parent.initializer) && parent.initializer.declarations.some((d) => binds(d.name))) {
        const only = parent.initializer.declarations[0];
        return ts.isIdentifier(only.name) ? { kind: "of", list: parent.expression } : null;
      }
      if (isFunctionLike(parent)) {
        const index = parent.parameters.findIndex((p) => binds(p.name));
        if (index >= 0) return ts.isIdentifier(parent.parameters[index].name) ? { kind: "param", fn: parent, index } : null;
      }
    }
    return null;
  }

  const nameOf = (fn: ts.SignatureDeclaration): string | null => {
    if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
    if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
    return null;
  };

  const references = (name: string, declared: ts.Node): ts.Identifier[] => {
    const found: ts.Identifier[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === name && node !== declared) found.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };

  /** Problems with the SQL text `node`, at most `depth` helpers deep. Empty means the text comes from code alone. */
  function sqlText(node: ts.Expression, depth: number, through: { used: boolean }): string[] {
    const at = unwrap(node);
    if (ts.isStringLiteral(at) || ts.isNoSubstitutionTemplateLiteral(at)) return [];
    if (ts.isTemplateExpression(at)) return at.templateSpans.flatMap((span) => part(span.expression, through));
    if (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.PlusToken) return [...piece(at.left, depth, through), ...piece(at.right, depth, through)];
    if (ts.isIdentifier(at)) {
      through.used = true;
      if (topConsts.has(at.text) && !declarationOf(at.text, at)) return fixed(at) ? [] : [`${at.text} is a top-level constant that is not fixed text`];
      const declared = declarationOf(at.text, at);
      if (!declared) return [`${at.text} is not fixed SQL text`];
      if (declared.kind === "const") return depth > 0 ? sqlText(declared.init, depth - 1, through) : [`${at.text} is built too many steps away`];
      if (declared.kind === "of") return fixed(declared.list) ? [] : [`${at.text} comes from a list that is not fixed text`];
      const fn = nameOf(declared.fn);
      if (!fn) return [`${at.text} is a parameter of a helper the check can't follow`];
      if (exported.has(fn)) return [`${at.text} is a parameter of ${fn}, which is exported, so its callers are in other files`];
      if (depth === 0) return [`${at.text} is passed through too many helpers`];
      const declaredName = ts.isFunctionDeclaration(declared.fn) ? declared.fn.name : (declared.fn.parent as ts.VariableDeclaration).name;
      const uses = references(fn, declaredName);
      if (uses.length === 0) return [];
      return uses.flatMap((use) => {
        const call = use.parent;
        if (!ts.isCallExpression(call) || call.expression !== use) return [`${fn} is used other than by a call, so ${at.text} can't be followed`];
        const arg = call.arguments[declared.index];
        if (!arg) return [`${fn} is called without ${at.text}`];
        return sqlText(arg, depth - 1, through).map((why) => `${fn}(...) at line ${source.getLineAndCharacterOfPosition(call.getStart()).line + 1}: ${why}`);
      });
    }
    return [`the SQL text is ${ts.SyntaxKind[at.kind]}, not fixed text`];
  }

  function piece(node: ts.Expression, depth: number, through: { used: boolean }): string[] {
    const at = unwrap(node);
    if (ts.isStringLiteral(at) || ts.isNoSubstitutionTemplateLiteral(at) || ts.isTemplateExpression(at) || (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.PlusToken)) return sqlText(at, depth, through);
    return part(at, through, "+ ");
  }

  /** One `${...}` or `+` operand inside SQL text: a fixed top-level constant, or a name an allow-list checked. */
  function part(node: ts.Expression, through: { used: boolean }, how = "${"): string[] {
    const at = unwrap(node);
    through.used = true;
    if (ts.isIdentifier(at) && topConsts.has(at.text) && !declarationOf(at.text, at) && fixed(at)) return [];
    if (ts.isIdentifier(at) && guarded(at.text, at)) return [];
    if (ts.isStringLiteral(at) || ts.isNoSubstitutionTemplateLiteral(at) || ts.isNumericLiteral(at)) return [];
    const label = how === "${" ? `\${${at.getText()}}` : `+ ${at.getText()}`;
    return [`${label} puts a value into the SQL text that is not a listed constant`];
  }

  const literalText = (node: ts.Expression): string => {
    const at = unwrap(node);
    if (ts.isStringLiteral(at) || ts.isNoSubstitutionTemplateLiteral(at)) return at.text;
    if (ts.isTemplateExpression(at)) return [at.head.text, ...at.templateSpans.map((s) => `\${${s.expression.getText()}}${s.literal.text}`)].join("");
    if (ts.isIdentifier(at) && topConsts.has(at.text)) return literalText(topConsts.get(at.text)!);
    if (ts.isArrayLiteralExpression(at)) return at.elements.map((e) => literalText(e as ts.Expression)).join("; ");
    return at.getText();
  };

  const calls: SqlCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && SQL_METHODS.has(node.expression.name.text) && node.arguments.length > 0) {
      const receiver = unwrap(node.expression.expression);
      const onSql = (ts.isIdentifier(receiver) && receiver.text === "sql") || (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "sql");
      const first = node.arguments[0];
      const looksSql = SQL_HEAD.test(literalText(first));
      if (onSql || looksSql) {
        const through = { used: false };
        const problems = sqlText(first, 4, through);
        const text = literalText(first);
        if (/\bLIKE\b/i.test(text) && !/\bESCAPE\b/i.test(text)) problems.push("LIKE without an ESCAPE clause matches % and _ in the value as wildcards");
        const values = node.arguments.slice(1).map((arg) => arg.getText().replace(/\s+/g, " "));
        const verdict: Verdict = problems.length ? "unbound" : through.used ? "allow-listed" : values.length ? "bound" : "fixed";
        calls.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, method: node.expression.name.text, text, values, verdict, problems });
      }
    }
    if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === "sql") {
      calls.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, method: "sql``", text: node.template.getText(), values: [], verdict: "unbound", problems: ["a tagged sql template: the check can't tell how it binds"] });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

const workerFiles = readdirSync(join(root, "worker"), { recursive: true })
  .map((name) => join(root, "worker", String(name)))
  .filter((file) => file.endsWith(".ts"))
  .sort();
const treeCalls = workerFiles.flatMap((file) => audit(shown(file), readFileSync(file, "utf8")));

if (process.argv.includes("--inventory")) {
  const cell = (text: string) => text.replace(/\s+/g, " ").trim().replaceAll("|", "\\|");
  console.log("| file:line | SQL (start) | values bound | verdict |");
  console.log("|---|---|---|---|");
  for (const call of treeCalls) console.log(`| ${call.file}:${call.line} | \`${cell(call.text).slice(0, 80)}\` | ${call.values.length ? cell(call.values.join(", ")).slice(0, 90) : "none"} | ${call.verdict}${call.problems.length ? `: ${cell(call.problems.join("; "))}` : ""} |`);
  process.exit(0);
}

const made = (body: string) => audit("made-up.ts", body);
const problemsOf = (body: string) => made(body).flatMap((call) => call.problems);

await check("a request value templated into SQL text is refused, and the same value bound with ? passes", () => {
  assert.equal(problemsOf("export const find = (sql, c) => sql.exec(`SELECT * FROM songs WHERE title = '${c.body.title}'`);").length, 1, "templated");
  const bound = made("export const find = (sql, c) => sql.exec(`SELECT * FROM songs WHERE title = ?`, c.body.title);");
  assert.deepEqual(bound.map((call) => [call.verdict, call.problems.length]), [["bound", 0]], "bound");
});

await check("a request value joined into SQL text with + is refused", () => {
  assert.equal(problemsOf(`export const find = (c) => c.sql.exec("SELECT * FROM songs WHERE title = '" + c.body.title + "'");`).length, 1);
});

await check("SQL text built from a value in a local variable first is refused, and fixed text in one passes", () => {
  assert.equal(problemsOf("export function drop(sql, id) { const query = `DELETE FROM songs WHERE id = ${id}`; sql.exec(query); }").length, 1, "built from id");
  assert.equal(problemsOf("export function drop(sql, id) { const query = `DELETE FROM songs WHERE id = ?`; sql.exec(query, id); }").length, 0, "fixed text");
});

await check("a dynamic ORDER BY only passes when checked against a listed constant first; a pattern that lets anything through does not count", () => {
  const order = (guard: string, list = 'const ORDERS = ["title", "artist"] as const;') =>
    problemsOf(`${list}\nexport function list(sql, order) { ${guard} return sql.exec(\`SELECT * FROM songs ORDER BY \${order}\`); }`).length;
  assert.equal(order(""), 1, "unchecked");
  assert.equal(order('if (!ORDERS.includes(order)) throw new Error("bad-order");'), 0, "checked against the list");
  assert.equal(order('if (!SORT.test(order)) throw new Error("bad-order");', "const SORT = /^.*$/;"), 1, "a wildcard pattern");
  assert.equal(order('if (!ORDERS.includes(order)) console.log("odd");'), 1, "a check that does not stop the query");
});

await check("a LIMIT or OFFSET from the request must be bound, not templated", () => {
  assert.equal(problemsOf("export const page = (sql, n) => sql.exec(`SELECT * FROM songs LIMIT ${n}`);").length, 1, "templated");
  assert.equal(problemsOf("export const page = (sql, n) => sql.exec(`SELECT * FROM songs LIMIT ? OFFSET ?`, n, 0);").length, 0, "bound");
});

await check("a LIKE search needs an ESCAPE clause so % and _ in the text match literally", () => {
  assert.equal(problemsOf("export const like = (sql, t) => sql.exec(`SELECT * FROM songs WHERE title LIKE ?`, `%${t}%`);").length, 1, "no ESCAPE");
  assert.equal(problemsOf("export const like = (sql, t) => sql.exec(`SELECT * FROM songs WHERE title LIKE ? ESCAPE '\\\\'`, t);").length, 0, "with ESCAPE");
});

await check("SQL text passed through a helper passes only when the helper is not exported and every caller passes fixed text", () => {
  const helper = (exportIt: boolean, call: string) =>
    problemsOf(`${exportIt ? "export " : ""}const run = (sql, query) => sql.exec(query);\nconst FIXED = \`SELECT 1\`;\nexport function go(sql, c) { run(sql, FIXED); ${call} }`).length;
  assert.equal(helper(false, "run(sql, `SELECT 2`);"), 0, "fixed callers");
  assert.ok(helper(false, "run(sql, `SELECT * FROM t WHERE a = '${c.body.a}'`);") >= 1, "one caller passes a value");
  assert.ok(helper(true, "run(sql, `SELECT 2`);") >= 1, "exported: callers elsewhere");
});

await check("an exported helper that templates its own parameters is refused until each name is checked by an allow-list", () => {
  const body = (guard: string) =>
    problemsOf(`const SQL_NAME = /^[a-z_]+$/;\nexport function addColumns(sql, table, columns) {\n${guard}\n  sql.exec(\`PRAGMA table_info(\${table})\`);\n}`).length;
  assert.equal(body(""), 1, "unchecked");
  assert.equal(body('if (!SQL_NAME.test(table)) throw new Error("bad-sql-name");'), 0, "checked");
});

await check("a RegExp .exec is not SQL, and a tagged sql template is always flagged", () => {
  assert.equal(made("const ROOM = /^x$/; export const id = (p) => ROOM.exec(p)?.[1];").length, 0, "regex exec");
  assert.equal(problemsOf("export const q = (sql, id) => sql`SELECT * FROM t WHERE id = ${id}`;").length, 1, "tagged");
});

await check("the pass finds the Worker's SQL: more than 150 calls across more than 15 files", () => {
  assert.ok(treeCalls.length > 150, `found ${treeCalls.length}`);
  assert.ok(new Set(treeCalls.map((call) => call.file)).size > 15, "files");
});

await check("no SQL text in worker/ is built from a value that is not a listed constant", () => {
  const bad = treeCalls.filter((call) => call.verdict === "unbound");
  assert.equal(bad.length, 0, bad.map((call) => `${call.file}:${call.line} ${call.problems.join("; ")}`).join(" | "));
});

/** Worker modules bundled for node, run on node:sqlite with Durable Object `exec` rules: a statement with no bindings may carry more after a `;`. */
async function workerModule<T>(entry: string): Promise<T> {
  const bundled = await build({
    stdin: { contents: entry, resolveDir: root, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    external: ["cloudflare:workers"],
    logLevel: "silent",
  });
  const file = join(mkdtempSync(join(tmpdir(), "check-sql-audit-")), "worker.mjs");
  writeFileSync(file, bundled.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

async function memorySql() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const reads = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query);
      let rows: Record<string, unknown>[] = [];
      if (reads) rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
      else if (bindings.length === 0) db.exec(query);
      else db.prepare(query).run(...(bindings as never[]));
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  };
  const tables = () => (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map((row) => row.name);
  const columns = (table: string) => (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((row) => row.name);
  return { sql, tables, columns };
}

const INJECTIONS = ["' OR 1=1 --", '"; DROP TABLE songs; --', "%", "_"];

await check("addColumns adds a listed column, and refuses a table, column or type that is not on its allow-list with nothing changed", async () => {
  const chat = await workerModule<{ addColumns: (sql: unknown, table: string, columns: Record<string, string>) => void }>(`export { addColumns } from "./worker/room-chat.ts";`);
  const db = await memorySql();
  db.sql.exec(`CREATE TABLE songs (id TEXT)`);
  db.sql.exec(`CREATE TABLE gigs (gig_id TEXT)`);
  chat.addColumns(db.sql, "gigs", { venue: "TEXT", kind: "TEXT NOT NULL DEFAULT 'gig'" });
  assert.deepEqual(db.columns("gigs"), ["gig_id", "venue", "kind"], "the listed columns are added");
  const before = { tables: db.tables(), gigs: db.columns("gigs") };
  const attempts: [string, Record<string, string>][] = [
    ["gigs; DROP TABLE songs; --", { notes: "TEXT" }],
    ["gigs", { "notes TEXT; DROP TABLE songs; --": "TEXT" }],
    ["gigs", { notes: "TEXT; DROP TABLE songs; --" }],
    ["gigs", { "' OR 1=1 --": "TEXT" }],
    ["gigs", { notes: "TEXT DEFAULT (abs(1))" }],
  ];
  for (const [table, columns] of attempts) {
    let refused = false;
    try {
      chat.addColumns(db.sql, table, columns);
    } catch {
      refused = true;
    }
    assert.deepEqual({ tables: db.tables(), gigs: db.columns("gigs") }, before, `nothing changed for ${JSON.stringify([table, columns])}`);
    assert.ok(refused, `refused ${JSON.stringify([table, columns])}`);
  }
});

type Reply = { status: number; body: any };
const ok = (reply: Reply, what: string) => {
  assert.equal(reply.status, 200, `${what} (${JSON.stringify(reply.body)})`);
  return reply.body;
};
const refusal = (reply: Reply) => [reply.status, reply.body?.error];
const DAY_MS = 24 * 60 * 60 * 1000;

async function player(base: string, name: string) {
  const phone = new Phone(base);
  const account = ok(await phone.createAccount(name), `${name} makes an account`).account as { userId: string; handle: string };
  return Object.assign(phone, { userId: account.userId, handle: account.handle });
}

const song = (title: string) => ({ chordpro: `{title: ${title}}\n{artist: The Made Up Band}\n[C]Words made [G]up for ${title}` });
const share = { choice: "public", parentId: null };
const bandFile = (from: string, ids: string[]) => ({
  exportedFrom: from,
  exportedAt: new Date().toISOString(),
  band: { name: "Elsewhere Band" },
  songs: ids.map((id, index) => ({ id, share, song: song(`Moved Tune ${index + 1}`), versions: [] })),
  setlists: [{ id: `set ${ids[0]}`, name: "Moved set", songIds: ids, tags: [], share }],
});

let api: Awaited<ReturnType<typeof startApi>> | null = null;
try {
  api = await startApi();
} catch (error) {
  failed += 1;
  console.log(`FAIL the Worker starts under Miniflare: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
}

if (api) {
  const { base } = api;
  try {
    const ann = await player(base, "Ann Admin");
    const mo = await player(base, "Mo Member");
    const gus = await player(base, "Gus Guest");
    const oz = await player(base, "Oz Outsider");
    const bandId = ok(await ann.call("/api/bands/create", { name: "The Check Band" }), "Ann makes a band").bandId as string;
    const invite = ok(await ann.call("/api/codes", { kind: "band", bandId }), "Ann's band invite").code as string;
    ok(await mo.call("/api/bands/join", { code: invite }), "Mo joins");
    const libraryTitles = async () =>
      (ok(await ann.call("/api/bands/library", { bandId }), "the band library").songs as { song: { title: string } }[]).map((item) => item.song.title).sort();

    await check("band file import (POST /api/rooms/<band>, heldAs): injection ids import as new items like plain no-match ids, and import again as skipped", async () => {
      const from = "https://elsewhere.test/band_ElsewhereBand000000000";
      const plain = ok(await ann.call(`/api/rooms/${bandId}`, bandFile(from, ["plain-a", "plain-b"])), "a plain file");
      assert.deepEqual(plain, { songs: { added: 2, skipped: 0 }, setlists: { added: 1, skipped: 0 } }, "plain ids that match nothing");
      const injected = ok(await ann.call(`/api/rooms/${bandId}`, bandFile(from, INJECTIONS)), "a file with injection ids");
      assert.deepEqual(injected, { songs: { added: 4, skipped: 0 }, setlists: { added: 1, skipped: 0 } }, "injection ids match nothing already held, the same as plain ids");
      const again = ok(await ann.call(`/api/rooms/${bandId}`, bandFile(from, INJECTIONS)), "the same file again");
      assert.deepEqual(again, { songs: { added: 0, skipped: 4 }, setlists: { added: 0, skipped: 1 } }, "each injection id finds only its own row");
      assert.equal((await libraryTitles()).length, 6, "six songs, no extra rows and none lost");
    });

    await check("friend request by @name (POST /api/friends/request): injection handles get the same answer as a handle that matches nothing", async () => {
      const none = refusal(await mo.call("/api/friends/request", { handle: "nobodyhere" }));
      assert.deepEqual(none, [404, "no-such-handle"], "the plain no-match handle");
      for (const handle of [...INJECTIONS, `${ann.handle}' OR '1'='1`]) assert.deepEqual(refusal(await mo.call("/api/friends/request", { handle })), none, handle);
      const lists = ok(await ann.call("/api/friends", undefined), "Ann's friends");
      assert.deepEqual([lists.friends.length, lists.requests.length], [0, 0], "no request reached anyone");
      assert.equal(ok(await ann.call("/api/me", undefined), "Ann's account").account.handle, ann.handle, "the users table is intact");
    });

    await check("song notes list (POST /api/bands/notes/list): injection song ids get the same answer as an id that matches nothing", async () => {
      const none = refusal(await ann.call("/api/bands/notes/list", { bandId, songId: "no-such-song" }));
      assert.deepEqual(none, [404, "not-found"], "the plain no-match id");
      for (const songId of INJECTIONS) assert.deepEqual(refusal(await ann.call("/api/bands/notes/list", { bandId, songId })), none, songId);
      assert.equal((await libraryTitles()).length, 6, "the band songs are intact");
    });

    await check("a new @name from a display name (GLOB ?1 || '[0-9]*'): *, ?, [, % and _ in a name are not wildcards", async () => {
      const handles = [];
      for (const name of ["Glob Sam", "Glob*Sam", "Glob?Sam[", "Glob%Sam_"]) handles.push((await player(base, name)).handle);
      assert.deepEqual(handles, ["globsam", "globsam2", "globsam3", "globsam4"], "each name counts only real globsam handles");
      const wild = [];
      for (const name of ["%", "_ *"]) wild.push((await player(base, name)).handle);
      assert.deepEqual(wild, ["player", "player2"], "a name of wildcards only is a plain player");
    });

    const setlistId = ok(
      await ann.call("/api/bands/library/share-setlist", { bandId, name: "Gig set", songIds: [], tags: [], choice: "public", localId: null }),
      "Ann shares a setlist",
    ).setlistId as string;
    const gigId = ok(
      await ann.call("/api/bands/gig/plan", { bandId, setlistId, name: "Check gig", date: new Date().toLocaleDateString("en-CA"), lineup: [ann.userId, mo.userId], leader: ann.userId }),
      "Ann plans a gig",
    ).gig.gigId as string;
    const passId = `pass_${randomBytes(16).toString("base64url")}`;
    const pass = (passIdNow: string) => ({ bandId, gigId, passId: passIdNow, name: "", expiresAt: Date.now() + DAY_MS, canSeeChat: false, canSeeSetlists: false });
    const guestCode = ok(await ann.call("/api/bands/guests/create", pass(passId)), "Ann makes a guest pass").code as string;
    ok(await gus.call("/api/guest/claim", { code: guestCode }), "Gus claims the pass");
    const songId = (ok(await ann.call("/api/bands/library", { bandId }), "the band library").songs as { songId: string }[])[0].songId;
    const noteId = ok(await ann.call("/api/bands/notes/add", { bandId, songId, body: "Watch the made-up turnaround" }), "Ann adds a note").noteId as string;
    const exported = await fetch(new URL(`/api/bands/export?bandId=${bandId}`, base), { headers: { cookie: ann.cookie } });
    assert.equal(exported.status, 200, "Ann can export");
    const file = await exported.json();

    await check("admin-only routes refuse a member, a guest and an outsider at the Worker, with nothing changed", async () => {
      const state = async () => {
        const view = ok(await ann.call("/api/bands/open", { bandId }), "the band view");
        const notes = ok(await ann.call("/api/bands/notes/list", { bandId, songId }), "the notes").notes.length;
        const passes = ok(await ann.call("/api/bands/guests/list", { bandId, gigId }), "the passes").passes.length;
        return { members: view.members, scroll: view.scrollWithLeader, notes, passes, songs: (await libraryTitles()).length };
      };
      const before = await state();
      const routes: [string, (who: { userId: string }) => Record<string, unknown> | undefined][] = [
        ["/api/bands/make-admin", (who) => ({ bandId, userId: who.userId })],
        ["/api/bands/remove", () => ({ bandId, userId: ann.userId })],
        ["/api/bands/reset-link", () => ({ bandId })],
        ["/api/bands/settings", () => ({ bandId, scrollWithLeader: true })],
        ["/api/codes", () => ({ kind: "band", bandId })],
        ["/api/bands/notes/add", () => ({ bandId, songId, body: "Not an admin note" })],
        ["/api/bands/notes/delete", () => ({ bandId, noteId })],
        ["/api/bands/guests/create", () => pass(`pass_${randomBytes(16).toString("base64url")}`)],
        ["/api/bands/guests/list", () => ({ bandId, gigId })],
        ["/api/bands/guests/revoke", () => ({ bandId, passId })],
        ["/api/bands/gig/plan", (who) => ({ bandId, setlistId, name: "Not my gig", date: new Date().toLocaleDateString("en-CA"), lineup: [who.userId], leader: who.userId })],
        [`/api/rooms/${bandId}`, () => file],
      ];
      const seen: string[] = [];
      for (const who of [mo, gus, oz]) {
        for (const [path, body] of routes) {
          const reply = await who.call(path, body(who));
          if (reply.status !== 403) seen.push(`${path} as ${who.handle}: ${reply.status} ${JSON.stringify(reply.body).slice(0, 80)}`);
        }
        const exportReply = await fetch(new URL(`/api/bands/export?bandId=${bandId}`, base), { headers: { cookie: who.cookie } });
        if (exportReply.status !== 403) seen.push(`/api/bands/export as ${who.handle}: ${exportReply.status}`);
      }
      assert.deepEqual(seen, [], "every one is 403");
      assert.deepEqual(await state(), before, "the band, its notes, passes and songs are as they were");
    });
  } catch (error) {
    failed += 1;
    console.log(`FAIL the route cases could set up: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await api.worker.dispose();
  }
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall sql-audit checks passed");
process.exit(failed ? 1 : 0);

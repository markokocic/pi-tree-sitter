/**
 * pi-tree-sitter — Pre-write syntax validation for pi
 *
 * Hooks into `write` and `edit` tools. Parses content with tree-sitter WASM
 * grammars and blocks the tool when syntax errors are found. The LLM sees the
 * actionable feedback (line:col, snippet, expected token) in the same turn and
 * self-corrects.
 *
 * Languages without a WASM grammar (Clojure, Janet, Fennel, Scheme, Elisp)
 * fall back to a comment/string-aware delimiter-balance scanner.
 *
 * Inspired by dirge's syntax_validator.rs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { Parser, Language, type Node, type Tree } from "web-tree-sitter";

const require = createRequire(import.meta.url);

// ── Grammar map ──────────────────────────────────────────────────────────
// Maps file extension → { npm package, wasm filename } for lazy loading.

interface GrammarEntry {
  pkg: string;
  wasm: string;
}

const LANGUAGE_MAP: Record<string, GrammarEntry> = {
  ".rs":   { pkg: "tree-sitter-rust", wasm: "tree-sitter-rust.wasm" },
  ".py":   { pkg: "tree-sitter-python", wasm: "tree-sitter-python.wasm" },
  ".pyi":  { pkg: "tree-sitter-python", wasm: "tree-sitter-python.wasm" },
  ".ts":   { pkg: "tree-sitter-typescript", wasm: "tree-sitter-typescript.wasm" },
  ".tsx":  { pkg: "tree-sitter-typescript", wasm: "tree-sitter-tsx.wasm" },
  ".mts":  { pkg: "tree-sitter-typescript", wasm: "tree-sitter-typescript.wasm" },
  ".cts":  { pkg: "tree-sitter-typescript", wasm: "tree-sitter-typescript.wasm" },
  ".js":   { pkg: "tree-sitter-javascript", wasm: "tree-sitter-javascript.wasm" },
  ".jsx":  { pkg: "tree-sitter-javascript", wasm: "tree-sitter-javascript.wasm" },
  ".mjs":  { pkg: "tree-sitter-javascript", wasm: "tree-sitter-javascript.wasm" },
  ".cjs":  { pkg: "tree-sitter-javascript", wasm: "tree-sitter-javascript.wasm" },
  ".go":   { pkg: "tree-sitter-go", wasm: "tree-sitter-go.wasm" },
  ".java": { pkg: "tree-sitter-java", wasm: "tree-sitter-java.wasm" },
  ".rb":   { pkg: "tree-sitter-ruby", wasm: "tree-sitter-ruby.wasm" },
  ".c":    { pkg: "tree-sitter-c", wasm: "tree-sitter-c.wasm" },
  ".h":    { pkg: "tree-sitter-c", wasm: "tree-sitter-c.wasm" },
  ".cpp":  { pkg: "tree-sitter-cpp", wasm: "tree-sitter-cpp.wasm" },
  ".cc":   { pkg: "tree-sitter-cpp", wasm: "tree-sitter-cpp.wasm" },
  ".hpp":  { pkg: "tree-sitter-cpp", wasm: "tree-sitter-cpp.wasm" },
  ".hh":   { pkg: "tree-sitter-cpp", wasm: "tree-sitter-cpp.wasm" },
  ".hxx":  { pkg: "tree-sitter-cpp", wasm: "tree-sitter-cpp.wasm" },
  ".sh":   { pkg: "tree-sitter-bash", wasm: "tree-sitter-bash.wasm" },
  ".bash": { pkg: "tree-sitter-bash", wasm: "tree-sitter-bash.wasm" },
};

// ── Grammar cache ────────────────────────────────────────────────────────

const grammarCache = new Map<string, Language | null>();

async function loadGrammar(entry: GrammarEntry): Promise<Language | null> {
  const key = `${entry.pkg}/${entry.wasm}`;
  const cached = grammarCache.get(key);
  if (cached !== undefined) return cached;

  try {
    const wasmPath = require.resolve(key);
    const wasmBytes = await readFile(wasmPath);
    const lang = await Language.load(wasmBytes);
    grammarCache.set(key, lang);
    return lang;
  } catch {
    grammarCache.set(key, null);
    return null;
  }
}

// ── Error collection ─────────────────────────────────────────────────────

const MAX_ERRORS = 10;

/** Collect ERROR/MISSING nodes from a syntax tree, capped at MAX_ERRORS. */
function collectErrors(tree: Tree, source: string): string[] {
  const errors: string[] = [];
  const stack: Node[] = [tree.rootNode];

  while (stack.length > 0 && errors.length < MAX_ERRORS) {
    const node = stack.pop()!;

    if (node.isError || node.isMissing) {
      const pos = node.startPosition;
      const raw = source.slice(node.startIndex, Math.min(node.endIndex, source.length));
      const snippet = raw.split("\n")[0].slice(0, 80).trimEnd();

      if (node.isMissing) {
        // For MISSING nodes, `.type` is the grammar-level expected token
        // (e.g. "}", ")", ";"). This is the most actionable detail.
        errors.push(`  missing \`${node.type}\` at ${pos.row + 1}:${pos.column + 1}: ${snippet}`);
      } else {
        errors.push(`  syntax error at ${pos.row + 1}:${pos.column + 1}: ${snippet}`);
      }
      // Don't descend into error nodes — their children are noise.
      continue;
    }

    // Push children in reverse order so the walk is left-to-right.
    const children = node.children;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }

  return errors;
}

// ── Delimiter-balance scanner (fallback for Lisp-like languages) ─────────

/**
 * Simple line/column counter for the balance scanner.
 * Tracks absolute position for error reporting but is simple enough that
 * we compute line numbers inline for human-readable messages.
 */
interface LexRules {
  lineComment: string | null;              // e.g. ";"
  blockComment: [string, string] | null;   // e.g. ["#|", "|#"]
  nestedBlock: boolean;
  backtickLongString: boolean;
  charLiteral: "?" | null;                 // e.g. Elisp uses ?x for char literals
}

const RULES_LISP: LexRules     = { lineComment: ";", blockComment: null, nestedBlock: false, backtickLongString: false, charLiteral: null };
const RULES_JANET: LexRules    = { lineComment: "#", blockComment: ["#|", "|#"], nestedBlock: false, backtickLongString: true, charLiteral: null };
const RULES_SCHEME: LexRules   = { lineComment: ";", blockComment: ["#|", "|#"], nestedBlock: true, backtickLongString: false, charLiteral: null };

const BALANCE_RULES: Record<string, LexRules> = {
  ".clj":   RULES_LISP,
  ".cljs":  RULES_LISP,
  ".cljc":  RULES_LISP,
  ".cljd":  RULES_LISP,
  ".edn":   RULES_LISP,
  ".bb":    RULES_LISP,
  ".fnl":   RULES_LISP,
  ".janet": RULES_JANET,
  ".jdn":   RULES_JANET,
  ".scm":   RULES_SCHEME,
  ".ss":    RULES_SCHEME,
  ".rkt":   RULES_SCHEME,
  ".lisp":  RULES_SCHEME,
  ".lsp":   RULES_SCHEME,
  ".cl":    RULES_SCHEME,
  ".el":    { lineComment: ";", blockComment: null, nestedBlock: false, backtickLongString: false, charLiteral: "?" },
};

/** Count delimiters skipping comments, strings, and char literals. */
function checkDelimiterBalance(path: string, content: string, rules: LexRules): string | null {
  const b = content;
  const n = b.length;
  let i = 0;
  const lineStarts: number[] = [0];
  for (let j = 0; j < n; j++) {
    if (b[j] === "\n") lineStarts.push(j + 1);
  }

  function lineFor(pos: number): number {
    // Binary search for the nearest line start ≤ pos
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1; // 1-based
  }

  const stack: Array<{ ch: string; line: number; col: number }> = [];

  while (i < n) {
    const c = b[i];
    const next = i + 1 < n ? b[i + 1] : null;

    // Line comment
    if (rules.lineComment && c === rules.lineComment[0]) {
      const eol = b.indexOf("\n", i);
      i = eol === -1 ? n : eol + 1;
      continue;
    }

    // Block comment
    if (rules.blockComment) {
      const [open, close] = rules.blockComment;
      if (c === open[0] && next === open[1]) {
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          const cc = b[i];
          const nn = i + 1 < n ? b[i + 1] : null;
          if (rules.nestedBlock && cc === open[0] && nn === open[1]) {
            depth++;
            i += 2;
          } else if (cc === close[0] && nn === close[1]) {
            depth--;
            i += 2;
          } else {
            i++;
          }
        }
        continue;
      }
    }

    // String
    if (c === '"') {
      i++;
      while (i < n) {
        if (b[i] === "\\") { i += 2; continue; }
        if (b[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }

    // Backtick long-string (Janet)
    if (rules.backtickLongString && c === "`") {
      // Count opening backticks
      let k = 0;
      while (i + k < n && b[i + k] === "`") k++;
      i += k;
      while (i < n) {
        if (b[i] === "`") {
          let j = 0;
          while (i + j < n && b[i + j] === "`") j++;
          if (j >= k) { i += k; break; }
          i += j;
        } else {
          i++;
        }
      }
      continue;
    }

    // Escape: skip \ and the following character
    if (c === "\\" && i + 1 < n) {
      i += 2;
      continue;
    }

    // Char literal (e.g., Elisp: ?x, ?\()
    if (rules.charLiteral === "?" && c === "?" && i + 1 < n) {
      if (b[i + 1] === "\\" && i + 2 < n) {
        i += 3; // skip ?\X
      } else {
        i += 2; // skip ?X
      }
      continue;
    }

    // Count delimiters
    switch (c) {
      case "(": {
        const ln = lineFor(i);
        stack.push({ ch: "(", line: ln, col: i - lineStarts[ln - 1] + 1 });
        break;
      }
      case ")": {
        const top = stack.pop();
        if (!top) return `${path}: stray \`)\` at line ${lineFor(i)} — no matching \`(\` before it`;
        break;
      }
      case "[": {
        const ln = lineFor(i);
        stack.push({ ch: "[", line: ln, col: i - lineStarts[ln - 1] + 1 });
        break;
      }
      case "]": {
        const top = stack.pop();
        if (!top) return `${path}: stray \`]\` at line ${lineFor(i)} — no matching \`[\` before it`;
        if (top.ch !== "[") return `${path}: mismatch at line ${lineFor(i)}: expected \`]\` for \`${top.ch}\` at line ${top.line}`;
        break;
      }
      case "{": {
        const ln = lineFor(i);
        stack.push({ ch: "{", line: ln, col: i - lineStarts[ln - 1] + 1 });
        break;
      }
      case "}": {
        const top = stack.pop();
        if (!top) return `${path}: stray \`}\` at line ${lineFor(i)} — no matching \`{\` before it`;
        if (top.ch !== "{") return `${path}: mismatch at line ${lineFor(i)}: expected \`}\` for \`${top.ch}\` at line ${top.line}`;
        break;
      }
    }

    i++;
  }

  if (stack.length > 0) {
    const top = stack[0];
    const opener = top.ch;
    return `${path}: ${stack.length} unclosed \`${opener}\` — the one at line ${top.line} is never closed; add ${stack.length} matching \`${{ "(": ")", "[": "]", "{": "}" }[opener]}\``;
  }

  return null;
}

// ── Validation helpers ──────────────────────────────────────────────────

function formatError(path: string, errors: string[]): string {
  let msg = `Syntax check failed for ${path}: ${errors.length} error(s) detected by tree-sitter.
Fix and re-submit. (This is a pre-write guard — the file was NOT modified.)
`;
  msg += errors.join("\n");
  if (errors.length >= MAX_ERRORS) {
    msg += `\n  …(truncated at ${MAX_ERRORS} errors; fix the listed issues and re-check)`;
  }
  return msg;
}

function formatBalanceError(path: string, detail: string): string {
  return `Syntax check failed for ${path}: delimiters are unbalanced.
Fix and re-submit. (This is a pre-write guard — the file was NOT modified.)
  ${detail}`;
}

/**
 * Validate content for a given file path. Returns null (clean), or a
 * formatted error message to surface as the block reason.
 */
async function validateContent(path: string, content: string): Promise<string | null> {
  const ext = path.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  if (!ext) return null;

  const entry = LANGUAGE_MAP[ext];
  if (entry) {
    const lang = await loadGrammar(entry);
    if (lang) {
      const parser = new Parser();
      parser.setLanguage(lang);
      const tree = parser.parse(content);
      if (tree && tree.rootNode.hasError) {
        const errors = collectErrors(tree, content);
        if (errors.length > 0) {
          return formatError(path, errors);
        }
      }
      return null;
    }
    // Grammar package not installed — fall through to balance check
  }

  // Delimiter-balance fallback
  const rules = ext ? BALANCE_RULES[ext] : undefined;
  if (rules) {
    const err = checkDelimiterBalance(path, content, rules);
    if (err) return formatBalanceError(path, err);
  }

  return null;
}

// ── Extension entry point ────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  // Initialize the web-tree-sitter WASM runtime once.
  await Parser.init();

  pi.on("tool_call", async (event, ctx) => {
    // ── write ──────────────────────────────────────────────────────────
    if (event.toolName === "write") {
      const input = event.input as { path: string; content: string };
      const err = await validateContent(input.path, input.content);
      if (err) return { block: true, reason: err };
      return;
    }

    // ── edit ───────────────────────────────────────────────────────────
    if (event.toolName === "edit") {
      const input = event.input as {
        path: string;
        edits: Array<{ oldText: string; newText: string }>;
      };
      if (!input.edits || input.edits.length === 0) return;

      const absolutePath = resolve(ctx.cwd, input.path);

      try {
        const rawContent = await readFile(absolutePath, "utf-8");

        // Apply edits sequentially (best-effort approximation of the final
        // content for validation). If an edit's oldText is not found, skip
        // it — the edit tool itself will report that error.
        let result = rawContent;
        for (const edit of input.edits) {
          const idx = result.indexOf(edit.oldText);
          if (idx === -1) continue;
          result = result.slice(0, idx) + edit.newText + result.slice(idx + edit.oldText.length);
        }

        const err = await validateContent(input.path, result);
        if (err) return { block: true, reason: err };
      } catch {
        // File doesn't exist or can't be read as UTF-8 — let the edit tool
        // handle the error itself.
      }
    }
  });
}

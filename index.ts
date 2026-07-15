/**
 * pi-tree-sitter — Pre-write syntax validation + structural code tools for pi
 *
 * Hooks `write` and `edit` tools to validate syntax (blocks on errors).
 * Registers semantic tools for AST-level code queries:
 *   - list_symbols      — symbols in a file or project
 *   - find_definition   — where a symbol is defined
 *   - find_callers      — call sites of a function/method
 *   - get_symbol_body   — full source of a named symbol
 *
 * Inspired by dirge's syntax_validator.rs and semantic adapters.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Parser, type Tree, type Node as TSNode } from "web-tree-sitter";

import { ensureParser, loadGrammar, LANGUAGE_MAP } from "./src/grammar.js";
import { BALANCE_RULES, checkDelimiterBalance } from "./src/delimiter.js";
import type { Symbol as Sym, ExtractedFile, LangConfig } from "./src/languages.js";
import { configForExt } from "./src/languages.js";
import { findProjectFiles, readFileSafe } from "./src/files.js";

// ── Error collection (write-time validation) ─────────────────────────────

const MAX_ERRORS = 10;

function collectErrors(tree: Tree, source: string): string[] {
  const errors: string[] = [];
  const stack: TSNode[] = [tree.rootNode];

  while (stack.length > 0 && errors.length < MAX_ERRORS) {
    const node = stack.pop()!;
    if (node.isError || node.isMissing) {
      const pos = node.startPosition;
      const raw = source.slice(node.startIndex, Math.min(node.endIndex, source.length));
      const snippet = raw.split("\n")[0].slice(0, 80).trimEnd();
      if (node.isMissing) {
        errors.push("  missing `" + node.type + "` at " + (pos.row + 1) + ":" + (pos.column + 1) + ": " + snippet);
      } else {
        errors.push("  syntax error at " + (pos.row + 1) + ":" + (pos.column + 1) + ": " + snippet);
      }
      continue;
    }
    const children = node.children;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return errors;
}

/** Validate content for write/edit blocking. Returns null = clean. */
async function validateContent(path: string, content: string): Promise<string | null> {
  const ext = path.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  if (!ext) return null;

  const entry = LANGUAGE_MAP[ext];
  if (entry) {
    await ensureParser();
    const lang = await loadGrammar(entry);
    if (lang) {
      const parser = new Parser();
      parser.setLanguage(lang);
      const tree = parser.parse(content);
      if (tree && tree.rootNode.hasError) {
        const errors = collectErrors(tree, content);
        if (errors.length > 0) {
          let msg = "Syntax check failed for " + path + ": " + errors.length + " error(s) detected by tree-sitter.\n";
          msg += "Fix and re-submit. (This is a pre-write guard \u2014 the file was NOT modified.)\n";
          msg += errors.join("\n");
          if (errors.length >= MAX_ERRORS) {
            msg += "\n  \u2026(truncated at " + MAX_ERRORS + " errors; fix the listed issues and re-check)";
          }
          return msg;
        }
      }
      // Grammar loaded but file has no errors — clean
      return null;
    }
    // Grammar not available — fall through to delimiter balance if rules exist
  }

  const rules = ext ? BALANCE_RULES[ext] : undefined;
  if (rules) {
    const err = checkDelimiterBalance(path, content, rules);
    if (err) {
      return "Syntax check failed for " + path + ": delimiters are unbalanced.\nFix and re-submit. (This is a pre-write guard \u2014 the file was NOT modified.)\n  " + err;
    }
  }
  return null;
}

// ── Semantic tool helpers ────────────────────────────────────────────────

function formatSymbol(sym: Sym): string {
  const classHint = sym.parentClass ? " [class: " + sym.parentClass + "]" : "";
  const exportMark = sym.isExported ? " (exported)" : "";
  return "  " + sym.range.startLine + "-" + sym.range.endLine + " [" + sym.kind + "] " + sym.name + classHint + exportMark;
}

function formatResults(results: Map<string, Sym[]>): string {
  let total = 0;
  const parts: string[] = [];
  for (const [path, syms] of results) {
    parts.push("## " + path);
    for (const sym of syms) {
      parts.push(formatSymbol(sym));
    }
    total += syms.length;
  }
  parts.push("\n" + total + " symbols across " + results.size + " files");
  return parts.join("\n");
}

async function extractFile(filePath: string): Promise<ExtractedFile | null> {
  const ext = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  if (!ext) return null;
  const config = configForExt(ext);
  if (!config) return null;
  const entry = LANGUAGE_MAP[ext];
  if (!entry) return null;
  const source = await readFileSafe(filePath);
  if (source === null) return null;
  await ensureParser();
  const lang = await loadGrammar(entry);
  if (!lang) return null;
  return config.extract(source, lang);
}

async function extractAllFiles(dir: string): Promise<Map<string, Sym[]>> {
  const results = new Map<string, Sym[]>();
  const files = await findProjectFiles(dir);
  for (const file of files) {
    const extracted = await extractFile(file);
    if (extracted && extracted.symbols.length > 0) {
      results.set(file, extracted.symbols);
    }
  }
  return results;
}

// ── Entry point ──────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  // ── Write/Edit validation (existing behavior) ────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "write") {
      const input = event.input as { path: string; content: string };
      const err = await validateContent(input.path, input.content);
      if (err) return { block: true, reason: err };
      return;
    }

    if (event.toolName === "edit") {
      const input = event.input as {
        path: string;
        edits: Array<{ oldText: string; newText: string }>;
      };
      if (!input.edits || input.edits.length === 0) return;
      const absolutePath = resolve(ctx.cwd, input.path);
      try {
        const rawContent = await readFile(absolutePath, "utf-8");
        let result = rawContent;
        for (const edit of input.edits) {
          const idx = result.indexOf(edit.oldText);
          if (idx === -1) continue;
          result = result.slice(0, idx) + edit.newText + result.slice(idx + edit.oldText.length);
        }
        const err = await validateContent(input.path, result);
        if (err) return { block: true, reason: err };
      } catch {
        // File doesn't exist — let edit tool handle the error
      }
    }
  });

  // ── list_symbols ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "list_symbols",
    label: "List Symbols",
    description: "List symbols (functions, classes, methods, etc.) in a file or across the project. Parses code with tree-sitter for accurate results. Use this instead of grep when looking for code structure.",
    promptSnippet: "List symbols (functions, classes, methods, etc.) in files",
    promptGuidelines: ["Use list_symbols when you need to find all symbols (functions, classes, methods, etc.) in a file or across the project. Prefer this over grep for code structure queries."],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "File path to list symbols from. Omit to list across all project files." })),
      kind: Type.Optional(Type.String({ description: "Filter by symbol kind: function, class, method, interface, type, variable" })),
    }),
    async execute(_toolCallId, params) {
      const filterKind = params.kind?.toLowerCase();
      let results: Map<string, Sym[]>;
      if (params.path) {
        const filePath = resolve(params.path);
        const extracted = await extractFile(filePath);
        results = new Map();
        if (extracted) results.set(filePath, extracted.symbols);
      } else {
        results = await extractAllFiles(process.cwd());
      }
      if (results.size === 0) {
        return { content: [{ type: "text", text: "No symbols found." }], details: {} };
      }
      if (filterKind) {
        for (const [path, syms] of results) {
          const filtered = syms.filter(s => s.kind === filterKind);
          if (filtered.length > 0) results.set(path, filtered);
          else results.delete(path);
        }
      }
      return { content: [{ type: "text", text: formatResults(results) }], details: {} };
    },
  });

  // ── find_definition ──────────────────────────────────────────────────
  pi.registerTool({
    name: "find_definition",
    label: "Find Definition",
    description: "Find where a SYMBOL (function, class, type, etc.) is DEFINED across the project. Uses tree-sitter for precise structural matching. NOT for finding files by name \u2014 use `find_files` for that. NOT for content search \u2014 use `grep`.",
    promptSnippet: "Find where a symbol is defined across the project",
    promptGuidelines: ["Use find_definition when you need to find where a symbol is defined. This is more precise than grep because it uses AST matching."],
    parameters: Type.Object({
      name: Type.String({ description: "Name of the symbol to find" }),
    }),
    async execute(_toolCallId, params) {
      const allResults = await extractAllFiles(process.cwd());
      interface Hit { path: string; sym: Sym }
      const hits: Hit[] = [];
      for (const [path, syms] of allResults) {
        for (const sym of syms) {
          if (sym.name === params.name) hits.push({ path, sym });
        }
      }
      if (hits.length === 0) {
        return { content: [{ type: "text", text: "No definition found for '" + params.name + "'" }], details: {} };
      }
      const lines: string[] = ["Found " + hits.length + " definition(s) for '" + params.name + "':"];
      for (const { path, sym } of hits) {
        lines.push("  " + path + ":" + sym.range.startLine + " [" + sym.kind + "] " + sym.signature);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  // ── find_callers ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "find_callers",
    label: "Find Callers",
    description: "Find all call sites of a function or method across the project. Uses tree-sitter AST queries to find precise call references, not substring matching. Supports all tree-sitter supported languages.",
    promptSnippet: "Find all call sites of a function or method across the project",
    promptGuidelines: ["Use find_callers to find all places that call a specific function or method. This is more precise than grep because it uses AST queries and excludes false positives from comments/strings."],
    parameters: Type.Object({
      name: Type.String({ description: "Name of the function/method to find callers of" }),
      path: Type.Optional(Type.String({ description: "Directory to search in (defaults to current working directory)" })),
    }),
    async execute(_toolCallId, params) {
      const searchPath = params.path ? resolve(params.path) : process.cwd();
      const callers: string[] = [];

      const files = await findProjectFiles(searchPath);
      for (const file of files) {
        const ext = file.match(/\.[^.]+$/)?.[0]?.toLowerCase();
        if (!ext) continue;
        const config = configForExt(ext);
        if (!config) continue;
        const entry = LANGUAGE_MAP[ext];
        if (!entry) continue;
        await ensureParser();
        const lang = await loadGrammar(entry);
        if (!lang) continue;
        const source = await readFileSafe(file);
        if (source === null) continue;

        const extracted = config.extract(source, lang);
        for (const sym of extracted.symbols) {
          if (sym.name === params.name) continue;
          const callees = config.findCallees(source, lang, sym.range);
          if (callees.indexOf(params.name) !== -1) {
            callers.push("  " + file + ":" + sym.range.startLine + " [" + sym.kind + "] " + sym.name);
          }
        }
      }

      if (callers.length === 0) {
        return { content: [{ type: "text", text: "No callers found for '" + params.name + "'" }], details: {} };
      }
      return { content: [{ type: "text", text: callers.length + " caller(s) for '" + params.name + "':\n" + callers.join("\n") }], details: {} };
    },
  });

  // ── get_symbol_body ──────────────────────────────────────────────────
  pi.registerTool({
    name: "get_symbol_body",
    label: "Get Symbol Body",
    description: "Get the full source code of a named symbol (function, class, method, etc.) from a file. Uses tree-sitter to precisely extract by byte range.",
    promptSnippet: "Get the full source code of a named symbol from a file",
    promptGuidelines: ["Use get_symbol_body to extract the full source code of a named symbol by its AST byte range, which is more accurate than slicing by line numbers."],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file containing the symbol" }),
      name: Type.String({ description: "Name of the symbol to retrieve" }),
    }),
    async execute(_toolCallId, params) {
      const filePath = resolve(params.path);
      const extracted = await extractFile(filePath);
      if (!extracted) {
        return { content: [{ type: "text", text: "Could not parse " + filePath }], details: {} };
      }
      for (const sym of extracted.symbols) {
        if (sym.name === params.name) {
          const source = await readFileSafe(filePath);
          if (source === null) {
            return { content: [{ type: "text", text: "Could not read " + filePath }], details: {} };
          }
          const body = source.slice(sym.range.startByte, sym.range.endByte);
          return {
            content: [{ type: "text", text: "Symbol: " + params.name + " in " + filePath + "\n\n" + body }],
            details: {},
          };
        }
      }
      return { content: [{ type: "text", text: "Symbol '" + params.name + "' not found in " + filePath }], details: {} };
    },
  });

  // ── find_callees ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "find_callees",
    label: "Find Callees",
    description: "Find all functions/methods called by a given symbol (its callees). Uses tree-sitter to extract call expressions from the symbol body. Supports all tree-sitter supported languages.",
    promptSnippet: "Find all functions or methods called by a given symbol",
    promptGuidelines: ["Use find_callees to find all functions called by a given function or method. Uses tree-sitter AST queries for accuracy."],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file containing the symbol" }),
      name: Type.String({ description: "Name of the function/method to analyze" }),
    }),
    async execute(_toolCallId, params) {
      const filePath = resolve(params.path);
      const ext = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase();
      if (!ext) return { content: [{ type: "text", text: "No callees found for '" + params.name + "'" }], details: {} };
      const config = configForExt(ext);
      if (!config) return { content: [{ type: "text", text: "No callees found for '" + params.name + "'" }], details: {} };
      const entry = LANGUAGE_MAP[ext];
      if (!entry) return { content: [{ type: "text", text: "No callees found for '" + params.name + "'" }], details: {} };
      await ensureParser();
      const lang = await loadGrammar(entry);
      if (!lang) return { content: [{ type: "text", text: "No callees found for '" + params.name + "'" }], details: {} };
      const source = await readFileSafe(filePath);
      if (source === null) return { content: [{ type: "text", text: "No callees found for '" + params.name + "'" }], details: {} };

      const extracted = config.extract(source, lang);
      for (const sym of extracted.symbols) {
        if (sym.name === params.name) {
          const callees = config.findCallees(source, lang, sym.range);
          if (callees.length === 0) {
            return { content: [{ type: "text", text: "No callees found for '" + params.name + "'" }], details: {} };
          }
          const lines = callees.map(c => "  " + c);
          return { content: [{ type: "text", text: "Callees of " + params.name + " in " + filePath + ":\n" + lines.join("\n") }], details: {} };
        }
      }
      return { content: [{ type: "text", text: "Symbol '" + params.name + "' not found in " + filePath }], details: {} };
    },
  });
}

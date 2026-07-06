# pi-tree-sitter

Pre-write syntax validation for [pi](https://pi.dev) using tree-sitter WASM grammars.

Hooks into `write` and `edit` tools to validate file content before it hits disk.
If tree-sitter finds syntax errors, the extension blocks the tool with actionable
feedback — line, column, source snippet, and for `MISSING` nodes, what token was
expected. The LLM sees the error in the same turn and self-corrects.

Inspired by [dirge](https://github.com/dirge-code/dirge)'s `syntax_validator.rs`.

## Installation

```bash
cd ~/src/my/pi/pi-tree-sitter
npm install
```

Then use with pi:

```bash
pi -e ~/src/my/pi/pi-tree-sitter
```

Or install as a package for auto-discovery:

```bash
pi install ~/src/my/pi/pi-tree-sitter
# or add to settings.json:
# "extensions": ["/home/marko/src/my/pi/pi-tree-sitter"]
```

## Supported Languages

| Extension(s) | Grammar | WASM |
|-------------|---------|------|
| `.rs` | Rust | ✅ |
| `.py`, `.pyi` | Python | ✅ |
| `.ts`, `.mts`, `.cts` | TypeScript | ✅ |
| `.tsx` | TSX | ✅ |
| `.js`, `.jsx`, `.mjs`, `.cjs` | JavaScript | ✅ |
| `.go` | Go | ✅ |
| `.java` | Java | ✅ |
| `.rb` | Ruby | ✅ |
| `.c`, `.h` | C | ✅ |
| `.cpp`, `.cc`, `.hpp`, `.hh`, `.hxx` | C++ | ✅ |
| `.sh`, `.bash` | Bash | ✅ |
| `.clj`, `.cljs`, `.cljc`, `.edn`, `.bb` | Clojure | 🔶 (delimiter balance) |
| `.fnl` | Fennel | 🔶 (delimiter balance) |
| `.janet`, `.jdn` | Janet | 🔶 (delimiter balance) |
| `.scm`, `.ss`, `.rkt` | Scheme | 🔶 (delimiter balance) |
| `.lisp`, `.lsp`, `.cl` | Common Lisp | 🔶 (delimiter balance) |
| `.el` | Emacs Lisp | 🔶 (delimiter balance) |

Languages marked with 🔶 use a comment/string-aware delimiter-balance scanner
as a fallback (no standalone WASM grammar available for Clojure on npm).

## How it works

1. Extension hooks `tool_call` events for `write` and `edit` tools
2. Maps file extension to a tree-sitter WASM grammar
3. Parses the content with tree-sitter
4. Walks the syntax tree collecting `ERROR` and `MISSING` nodes (capped at 10)
5. On errors: blocks the tool with `{ block: true, reason: "..." }` — the LLM
   sees the errors and self-corrects in the same turn
6. Unknown extensions silently pass through (no validation)

### For `edit` tools

The extension reads the current file, applies the edits, and validates the
resulting content. This is a best-effort check: if an edit can't be applied
(oldText not found), that edit is skipped and the edit tool's own error
handling takes over.

## Error Format

```
Syntax check failed for src/main.rs: 2 error(s) detected by tree-sitter.
Fix and re-submit. (This is a pre-write guard — the file was NOT modified.)
  missing `}` at 42:1: fn main() {
  syntax error at 15:8: let x =
```

For delimiter-based languages (Clojure, Fennel, etc.):

```
Syntax check failed for core.clj: delimiters are unbalanced.
Fix and re-submit. (This is a pre-write guard — the file was NOT modified.)
  1 unclosed `(` — add 1 matching `)`
```

## License

EPL-2.0 — Copyright 2026 Marko Kocic

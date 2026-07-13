# pi-tree-sitter

Pre-write syntax validation and structural code tools for [pi](https://pi.dev) using tree-sitter WASM grammars.

**Write-time validation:** hooks into `write` and `edit` tools to parse content before it hits disk. If tree-sitter finds syntax errors, the extension blocks the tool with actionable feedback — line, column, source snippet, and for `MISSING` nodes, what token was expected. The LLM sees the error in the same turn and self-corrects.

**Semantic code tools:** registers `list_symbols`, `find_definition`, `find_callers`, `find_callees`, and `get_symbol_body` tools so the agent can query code structure — functions, classes, methods, interfaces — without grepping or reading whole files.

Inspired by [dirge](https://github.com/dirge-code/dirge)'s `syntax_validator.rs` and semantic adapters.

## Installation

```bash
pi install npm:pi-tree-sitter
```

### Git version

```bash
pi install git:github.com/markokocic/pi-tree-sitter
```

Or clone and use locally:

```bash
git clone https://github.com/markokocic/pi-tree-sitter.git
cd pi-tree-sitter
npm install
pi install .
```

Run ad-hoc without installing:

```bash
pi -e ./path/to/pi-tree-sitter
```

## Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_symbols` | `path?`, `kind?` | List symbols (functions, classes, methods, etc.) in a file or across the project. Parses code with tree-sitter for accurate results. Use this instead of grep when looking for code structure. |
| `find_definition` | `name` | Find where a SYMBOL (function, class, type, etc.) is DEFINED across the project. Uses tree-sitter for precise structural matching. NOT for finding files by name — use `find_files` for that. NOT for content search — use `grep`. |
| `find_callers` | `name`, `path?` | Find all call sites of a function or method across the project. Searches source files for references, excluding the definition site. Supports all tree-sitter supported languages. |
| `find_callees` | `path`, `name` | Find all functions/methods called by a given symbol (its callees). Uses tree-sitter to extract call expressions from the symbol body. Supports all tree-sitter supported languages. |
| `get_symbol_body` | `path`, `name` | Get the full source code of a named symbol (function, class, method, etc.) from a file. Uses tree-sitter to precisely extract by byte range. |

All tools parse code with tree-sitter on demand — no caching, always fresh.

## Write-time validation

The extension hooks `write` and `edit` tools. Before content hits disk, it's parsed with the matching tree-sitter grammar. If `ERROR` or `MISSING` nodes are found (capped at 10), the tool is blocked with:

```
Syntax check failed for src/main.rs: 2 error(s) detected by tree-sitter.
Fix and re-submit. (This is a pre-write guard — the file was NOT modified.)
  missing `}` at 42:1: fn main() {
  syntax error at 15:8: let x =
```

For `edit` tools, the extension reads the current file, applies the edits, and validates the result. For languages without WASM grammars, a comment/string-aware delimiter-balance scanner provides fallback validation.

## Languages

### WASM grammars + symbol tools (21 configs)

| Language | Extensions | Symbols |
|----------|-----------|---------|
| TypeScript / JavaScript | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` | functions, classes, interfaces, types, methods, variables |
| Python | `.py`, `.pyi` | functions, classes, methods, decorated definitions |
| Rust | `.rs` | functions, structs, enums, traits, impl methods |
| Go | `.go` | functions, methods, structs, interfaces |
| Java | `.java` | classes, interfaces, enums |
| C# | `.cs` | classes, structs, interfaces, enums, methods, namespaces |
| Kotlin | `.kt`, `.kts` | functions, classes, interfaces, objects, properties |
| Ruby | `.rb` | methods, classes, modules |
| PHP | `.php` | functions, classes, interfaces, traits, methods |
| Dart | `.dart` | functions, classes, mixins, enums, methods, variables |
| C | `.c`, `.h` | functions, structs, unions, enums |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx` | functions, classes, structs, namespaces |
| Bash | `.sh`, `.bash` | functions |
| Clojure / EDN / Babashka / ClojureDart | `.clj`, `.cljs`, `.cljc`, `.cljd`, `.edn`, `.bb` | functions, vars, protocols, records |
| Elixir | `.ex`, `.exs` | functions, modules, protocols |
| Scala | `.scala` | functions, classes, traits, objects |
| Swift | `.swift` | functions, classes, structs, protocols, enums |
| Lua | `.lua` | functions |
| Zig | `.zig` | functions, variables, containers |
| Scheme | `.scm`, `.ss` | validation only |
| Racket | `.rkt` | validation only |

### WASM validation only (no symbol tools)

| Language | Extensions |
|----------|-----------|
| Haskell | `.hs`, `.lhs` |
| CSS | `.css` |
| HTML | `.htm`, `.html` |
| JSON | `.json` |
| TOML | `.toml` |
| YAML | `.yaml`, `.yml` |
| Vue | `.vue` |

### Delimiter balance only (no WASM grammar available)

| Language | Extensions |
|----------|-----------|
| Common Lisp | `.lisp`, `.lsp`, `.cl` |
| Emacs Lisp | `.el` |
| Fennel | `.fnl` |
| Janet | `.janet`, `.jdn` |

## Grammar caching

WASM grammars are fetched from jsDelivr CDN and cached to `~/.cache/pi-tree-sitter/`.
Each grammar has three files:

- `<wasm>` — the WASM binary
- `<wasm>.etag` — server ETag for conditional requests
- `<wasm>.date` — last-checked timestamp

On every load, the `.date` file is checked. Only if 30+ days old does the extension
revalidate against the CDN using `If-None-Match` with the stored ETag:

- **304 Not Modified** → touches `.date` (zero bytes transferred, timer reset)
- **200 OK** → downloads updated grammar, saves new WASM + ETag + date
- **Network error** → keeps cache, touches `.date` (retries in 30 days)

On first download, the bytes are verified with `Language.load()` before persisting.
If cached bytes are ever corrupted, they are deleted and re-downloaded on the next access.

## How it works

1. Write-time validation hooks `tool_call` events for `write` and `edit`
2. Semantic tools are registered via `pi.registerTool()` with TypeBox parameter schemas
3. Each tool parses the relevant file(s) with tree-sitter on demand (no in-memory cache)
4. Per-language extractors map grammar-specific node types to a unified `Symbol` kind
5. Callee queries use tree-sitter S-expression queries for each language

## Project structure

```
pi-tree-sitter/
  index.ts           # Extension entry: write/edit hooks + 5 tool registrations
  src/
    grammar.ts       # LANGUAGE_MAP, WASM loading from CDN, disk cache with ETag
    delimiter.ts     # Comment/string-aware delimiter balance scanner (fallback)
    languages.ts     # 21 per-language configs: extractors + callee queries
    files.ts         # Recursive project file discovery
```

## License

EPL-2.0 — Copyright 2026 Marko Kocic

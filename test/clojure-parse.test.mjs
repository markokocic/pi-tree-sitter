/**
 * Tests that the tree-sitter Clojure grammar correctly parses
 * Java interop forms (constructor calls, method calls, field access)
 * and other real-world Clojure patterns.
 *
 * Regression guards for: Java constructor calls like (StringBuilder.)
 * inside deeply nested let bindings (previously reported as false
 * positive syntax errors).
 */
import { Parser, Language } from "web-tree-sitter";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

const WASM_CDN = "https://cdn.jsdelivr.net/npm";
const GRAMMAR_URL = `${WASM_CDN}/@yogthos/tree-sitter-clojure/tree-sitter-clojure.wasm`;

let parser;

async function setup() {
  if (parser) return parser;
  await Parser.init();
  const res = await fetch(GRAMMAR_URL);
  const wasmBytes = new Uint8Array(await res.arrayBuffer());
  const lang = await Language.load(wasmBytes);
  parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

function hasErrors(code, p) {
  const tree = p.parse(code);
  const root = tree.rootNode;
  const errors = [];

  function walk(node) {
    if (node.isError || node.isMissing) {
      const pos = node.startPosition;
      const raw = code.slice(node.startIndex, Math.min(node.endIndex, code.length));
      const snippet = raw.split("\n")[0].slice(0, 80).trimEnd();
      errors.push(`  ${node.isMissing ? "missing" : "syntax error"} at ${pos.row + 1}:${pos.column + 1}: ${snippet}`);
    }
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i));
    }
  }
  walk(root);
  return errors;
}

describe("Clojure Java interop parsing", { timeout: 30_000 }, () => {
  let p;

  before(async () => {
    p = await setup();
  });

  describe("constructor calls", () => {
    const cases = [
      ["simple constructor", "(StringBuilder.)"],
      ["constructor with arg", `(StringBuilder. "hello")`],
      ["qualified constructor", `(java.io.File. "test.txt")`],
      ["fully qualified constructor", "(java.util.StringBuilder.)"],
      ["constructor in let binding", "(let [buf (StringBuilder.)])"],
      ["constructor in let with multiple bindings",
       `(let [buf (StringBuilder.)
              x 1
              y 2])`],
      ["constructor in deeply nested let",
       `(let [buf (StringBuilder.)]
          (let [x 1]
            (let [y 2]
              (.append buf "hello")
              (.toString buf))))`],
      ["constructor with type hint", "(let [^StringBuilder buf (StringBuilder.)])"],
      ["constructor in threading macro", `(-> (StringBuilder.) (.append "hello"))`],
      ["constructor inside if", "(if true (StringBuilder.) (StringBuilder.))"],
      ["constructor inside fn", "(fn [] (let [buf (StringBuilder.)] (.toString buf)))"],
      ["constructor inside defn body",
       `(defn make [x]
          (let [buf (StringBuilder.)
                f (java.io.File. x)
                data (slurp f)]
            (.append buf data)
            (.toString buf)))`],
    ];

    for (const [name, code] of cases) {
      it(`parses: ${name}`, () => {
        const errs = hasErrors(code, p);
        assert.equal(errs.length, 0, `Unexpected parse errors:\n${errs.join("\n")}\nCode: ${JSON.stringify(code)}`);
      });
    }
  });

  describe("method calls", () => {
    const cases = [
      ["instance method call", `(.append buf "hello")`],
      ["instance method call with return", "(.toString buf)"],
      ["static method call", "(Math/abs -5)"],
      ["field access", "(.-x point)"],
      ["chained via threading", `(-> (StringBuilder.) (.append "a") (.toString))`],
    ];

    for (const [name, code] of cases) {
      it(`parses: ${name}`, () => {
        const errs = hasErrors(code, p);
        assert.equal(errs.length, 0, `Unexpected parse errors:\n${errs.join("\n")}\nCode: ${JSON.stringify(code)}`);
      });
    }
  });

  describe("reader macros and special forms", () => {
    const cases = [
      ["quote", "'(1 2 3)"],
      ["syntax quote", "`(1 2 3)"],
      ["unquote", "`(1 ~x 3)"],
      ["unquote-splicing", "`(1 ~@xs 3)"],
      ["deref", "@atom-val"],
      ["var quoting", "#'my-var"],
      ["anonymous function", "#(+ % 1)"],
      ["set literal", "#{1 2 3}"],
      ["regex literal", '#"[a-z]+"'],
      ["tagged literal", '#uuid "123e4567-e89b-12d3-a456-426614174000"'],
      ["reader conditional", "#?(:clj 1 :cljs 2)"],
      ["splicing reader conditional", "#?@(:clj [1 2])"],
      ["meta on symbol", '^{:doc "hello"} my-sym'],
      ["meta with caret", "^:deprecated my-fn"],
      ["old-style meta", '#^{:doc "test"} my-sym'],
    ];

    for (const [name, code] of cases) {
      it(`parses: ${name}`, () => {
        const errs = hasErrors(code, p);
        assert.equal(errs.length, 0, `Unexpected parse errors:\n${errs.join("\n")}\nCode: ${JSON.stringify(code)}`);
      });
    }
  });

  describe("core forms and definitions", () => {
    const cases = [
      ["def", "(def x 42)"],
      ["defn", "(defn foo [x] (+ x 1))"],
      ["defn multi-arity", "(defn foo ([x] x) ([x y] (+ x y)))"],
      ["defn- private", "(defn- priv [x] x)"],
      ["defonce", "(defonce x (atom 0))"],
      ["defmulti / defmethod", "(defmulti area :shape)\n(defmethod area :circle [_ r] (* Math/PI r r))"],
      ["defprotocol", "(defprotocol Foo (bar [this]))"],
      ["defrecord", "(defrecord Point [x y])"],
      ["deftype", "(deftype Point [x y])"],
      ["let vector destructuring", "(let [[a b] [1 2]] (+ a b))"],
      ["let map destructuring", "(let [{:keys [x y]} {:x 1 :y 2}] (+ x y))"],
      ["loop / recur", "(loop [i 0] (when (< i 10) (recur (inc i))))"],
      ["if-let", "(if-let [x (something)] x :else)"],
      ["when-let", "(when-let [x (something)] x)"],
      ["for comprehension", "(for [x (range 10) :when (odd? x)] (* x x))"],
      ["try / catch / finally", "(try (dangerous) (catch Exception e (log e)) (finally (cleanup)))"],
      ["ns with require/import", "(ns my.project.core\n  (:require [clojure.string :as str])\n  (:import [java.io File]))"],
    ];

    for (const [name, code] of cases) {
      it(`parses: ${name}`, () => {
        const errs = hasErrors(code, p);
        assert.equal(errs.length, 0, `Unexpected parse errors:\n${errs.join("\n")}\nCode: ${JSON.stringify(code)}`);
      });
    }
  });

  describe("comments and literals", () => {
    const cases = [
      ["semicolon comment", "(+ 1 2) ; inline comment\n(* 3 4)"],
      ["comment reader macro", "(+ 1 2 (#_(* 3 4)) 5)"],
      ["string with parens", `(str "a ) b ( c")`],
      ["keyword", "(:key m)"],
      ["namespaced keyword", "(::my-ns/key)"],
      ["vector", "[1 2 3]"],
      ["map", "{:a 1 :b 2}"],
      ["nil", "nil"],
      ["boolean", "true false"],
      ["number literals", "(+ 1 2 3.14 16r10 2r101)"],
      ["ratio", "1/3"],
    ];

    for (const [name, code] of cases) {
      it(`parses: ${name}`, () => {
        const errs = hasErrors(code, p);
        assert.equal(errs.length, 0, `Unexpected parse errors:\n${errs.join("\n")}\nCode: ${JSON.stringify(code)}`);
      });
    }
  });
});

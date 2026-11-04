import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOutput } from "../src/shopify/cli.js";

const ok = (stdout, code = 0) => parseOutput({ code, killed: false, stdout, stderr: "" });

test("plain JSON is returned", () => {
  assert.deepEqual(ok('{"shop":{"name":"x"}}'), { ok: true, data: { shop: { name: "x" } } });
});

test("pretty JSON followed by a notice line is still read as the whole object", () => {
  const out = '{\n  "productsCount": {\n    "count": 5\n  }\n}\nA new version of Shopify CLI is available';
  assert.deepEqual(ok(out), { ok: true, data: { productsCount: { count: 5 } } });
});

test("a notice line before the JSON is skipped", () => {
  assert.deepEqual(ok('Update available\n{"a":1}'), { ok: true, data: { a: 1 } });
});

test("a stray scalar is never mistaken for a result", () => {
  const r = ok('{\n  "count":\n5\nbroken');
  assert.equal(r.ok, false);
  assert.match(r.error.message, /Couldn't read/);
  assert.equal(ok("5").ok, false);
});

test("CLI errors are passed through", () => {
  assert.deepEqual(ok('{"error":{"type":"abort","message":"nope"}}', 1), { ok: false, error: { type: "abort", message: "nope" } });
});

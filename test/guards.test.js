import { test } from "node:test";
import assert from "node:assert/strict";
import { checkWrite, destructiveFields } from "../src/core/guards.js";
import { isMutation, mutationFields } from "../src/shopify/graphql.js";

const ro = { alias: "prod", store: "prod.myshopify.com", writable: false, allowDestructive: false };
const rw = { alias: "dev", store: "dev.myshopify.com", writable: true, allowDestructive: false };
const rwd = { ...rw, allowDestructive: true };

test("isMutation ignores the word inside strings and comments", () => {
  assert.equal(isMutation("mutation { productCreate { id } }"), true);
  assert.equal(isMutation("mutation Named($a: ID!) { x(id: $a) { id } }"), true);
  assert.equal(isMutation('{ products(query: "mutation") { nodes { id } } }'), false);
  assert.equal(isMutation("# mutation\n{ shop { name } }"), false);
});

test("mutationFields returns top-level fields, resolving aliases", () => {
  assert.deepEqual(mutationFields('mutation { a: productDelete(input: {id: "1"}) { deletedProductId } tagsAdd(id: "x", tags: ["mutation { y }"]) { node { id } } }'), ["productDelete", "tagsAdd"]);
});

test("destructiveFields catches deletes, removals, cancels and bulk mutations", () => {
  assert.deepEqual(destructiveFields(["productDelete", "productUpdate", "companyContactRemoveFromCompany", "orderCancel", "bulkOperationRunMutation", "tagsAdd"]),
    ["productDelete", "companyContactRemoveFromCompany", "orderCancel", "bulkOperationRunMutation"]);
});

test("checkWrite: read-only store refuses everything", () => {
  const r = checkWrite(ro, "mutation { tagsAdd(id: \"1\", tags: [\"a\"]) { node { id } } }");
  assert.equal(r.ok, false); assert.equal(r.refused, true); assert.match(r.reason, /read-only/);
});

test("checkWrite: writable store allows creates but not deletes", () => {
  assert.equal(checkWrite(rw, "mutation { productCreate(product: {title: \"x\"}) { product { id } } }").ok, true);
  const del = checkWrite(rw, "mutation { productDelete(input: {id: \"1\"}) { deletedProductId } }");
  assert.equal(del.ok, false); assert.match(del.reason, /destructive/);
});

test("checkWrite: allowDestructive permits deletes", () => {
  assert.equal(checkWrite(rwd, "mutation { productDelete(input: {id: \"1\"}) { deletedProductId } }").ok, true);
});

test("checkWrite: an unparseable mutation counts as destructive", () => {
  assert.equal(checkWrite(rw, "mutation").ok, false);
  assert.equal(checkWrite(rwd, "mutation").ok, true);
});

test("checkWrite: a query is not a mutation", () => {
  const r = checkWrite(rwd, "{ shop { name } }");
  assert.equal(r.ok, false); assert.equal(r.refused, false);
});

// --- found in the pre-release code review: ways a delete could slip past the guard ---
const del = '{ deletedProductId userErrors { message } }';
const bypasses = {
  "named fragment": `mutation { ...F } fragment F on Mutation { productDelete(input: {id: "1"}) ${del} }`,
  "inline fragment": `mutation { ... on Mutation { productDelete(input: {id: "1"}) ${del} } }`,
  "inline fragment without a type": `mutation { ... @include(if: true) { productDelete(input: {id: "1"}) ${del} } }`,
  "nested fragments": `mutation { ...A } fragment A on Mutation { ...B } fragment B on Mutation { productDelete(input: {id: "1"}) ${del} }`,
  "braces in a variable default": `mutation M($i: ProductDeleteInput = {id: "1"}) { productDelete(input: $i) ${del} }`,
  "alias hiding the name": `mutation { harmless: productDelete(input: {id: "1"}) ${del} }`,
  "unknown fragment": `mutation { ...Missing }`,
  "second operation": `mutation A { tagsAdd(id: "1", tags: ["x"]) { node { id } } } mutation B { productDelete(input: {id: "1"}) ${del} }`,
};
for (const [name, doc] of Object.entries(bypasses)) {
  test(`delete guard can't be bypassed: ${name}`, () => {
    const r = checkWrite(rw, doc);
    assert.equal(r.ok, false, JSON.stringify(mutationFields(doc)));
    assert.equal(checkWrite(rwd, doc).ok, true, "allowed once deletes are allowed");
  });
}

test("fragments resolve to their real fields", () => {
  assert.deepEqual(mutationFields(bypasses["nested fragments"]), ["productDelete"]);
  assert.deepEqual(mutationFields('mutation { ...F } fragment F on Mutation { tagsAdd(id: "1", tags: ["a"]) { node { id } } }'), ["tagsAdd"]);
});

test("irreversible actions beyond deletes need delete access", () => {
  for (const f of ["refundCreate", "orderCapture", "orderClose", "giftCardDeactivate", "discountCodeDeactivate", "publishableUnpublish", "customerMerge", "productArchive"]) {
    assert.equal(checkWrite(rw, `mutation { ${f}(input: {}) { userErrors { message } } }`).ok, false, f);
  }
  assert.equal(checkWrite(rw, 'mutation { productUpdate(product: {id: "1"}) { product { id } } }').ok, true, "plain updates still allowed");
});

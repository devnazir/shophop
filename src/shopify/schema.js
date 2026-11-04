// Admin GraphQL schema lookups (introspection), so Claude never has to guess field names.
import { execute } from "./cli.js";

const TYPE_REF = "name kind ofType { name kind ofType { name kind ofType { name kind ofType { name kind } } } }";
const cache = new Map(); // root fields per store + API version + query/mutation

/** Render a GraphQL type reference like `[String!]!`. */
export const typeString = (t) => (t.kind === "NON_NULL" ? `${typeString(t.ofType)}!` : t.kind === "LIST" ? `[${typeString(t.ofType)}]` : t.name);

const firstLine = (d, max = 160) => (d ? d.split("\n")[0].slice(0, max) : undefined);

/** All query or mutation root fields with args and return types. Cached. */
export async function rootFields(store, which, version) {
  const key = `${store}|${version || ""}|${which}`;
  if (!cache.has(key)) {
    const root = which === "mutation" ? "mutationType" : "queryType";
    const res = await execute(store, `{ __schema { ${root} { fields { name description args { name type { ${TYPE_REF} } } type { ${TYPE_REF} } } } } }`, { version });
    if (!res.ok) return res;
    cache.set(key, res.data.__schema[root].fields);
  }
  return { ok: true, data: cache.get(key) };
}

/** One named type: fields, input fields, enum values or possible types. */
export async function describeType(store, name, version) {
  const res = await execute(store, `query($n: String!) { __type(name: $n) { name kind description
    fields(includeDeprecated: false) { name description type { ${TYPE_REF} } }
    inputFields { name description type { ${TYPE_REF} } }
    enumValues(includeDeprecated: false) { name description }
    possibleTypes { name } } }`, { variables: { n: name }, version });
  if (!res.ok) return res;
  const t = res.data.__type;
  if (!t) return { ok: true, data: null };
  const field = (f) => ({ name: f.name, type: typeString(f.type), description: firstLine(f.description) });
  return {
    ok: true,
    data: {
      name: t.name, kind: t.kind, description: firstLine(t.description),
      ...(t.fields && { fields: t.fields.map(field) }),
      ...(t.inputFields && { inputFields: t.inputFields.map(field) }),
      ...(t.enumValues && { enumValues: t.enumValues.map((v) => v.name) }),
      ...(t.possibleTypes && { possibleTypes: t.possibleTypes.map((p) => p.name) }),
    },
  };
}

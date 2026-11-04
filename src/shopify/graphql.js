// Reading GraphQL documents well enough to decide what a mutation does: which root fields it calls.
// This feeds the write guards, so it must not be fooled. It tokenizes the document (ignoring strings and
// comments), then walks operations and fragments the way a GraphQL server would:
//   - aliases (`a: productDelete`) report the real field
//   - named fragments (`...F` + `fragment F on Mutation {…}`) and inline fragments (`... on Mutation {…}`)
//     are expanded into the fields they contain
//   - variable definitions, arguments and directives are skipped as balanced groups, so braces inside
//     default values (`$i: Input = {id: "1"}`) can't be mistaken for the selection set
// Anything it can't resolve is reported as "(unknown …)", which the guards treat as destructive.

/** Split a GraphQL document into tokens, dropping comments and whitespace; strings become one "string" token. */
function tokenize(doc) {
  const tokens = [];
  let i = 0;
  while (i < doc.length) {
    const c = doc[i];
    if (c === "#") { while (i < doc.length && doc[i] !== "\n") i++; continue; }
    if (/[\s,﻿]/.test(c)) { i++; continue; }
    if (doc.startsWith('"""', i)) {
      const end = doc.indexOf('"""', i + 3);
      i = end < 0 ? doc.length : end + 3;
      tokens.push("<string>"); continue;
    }
    if (c === '"') {
      i++;
      while (i < doc.length && doc[i] !== '"') i += doc[i] === "\\" ? 2 : 1;
      i++; tokens.push("<string>"); continue;
    }
    if (doc.startsWith("...", i)) { tokens.push("..."); i += 3; continue; }
    if ("{}()[]:!=@$|&".includes(c)) { tokens.push(c); i++; continue; }
    const m = /^[_A-Za-z][_0-9A-Za-z]*|^-?[0-9][0-9.eE+-]*/.exec(doc.slice(i));
    if (m) { tokens.push(m[0]); i += m[0].length; continue; }
    tokens.push(c); i++; // unknown character: keep it as its own token
  }
  return tokens;
}

const isName = (t) => typeof t === "string" && /^[_A-Za-z][_0-9A-Za-z]*$/.test(t);

/** Skip a balanced group starting at tokens[i] (one of ( [ {). Returns the index after it. */
function skipGroup(tokens, i) {
  const open = tokens[i], close = { "(": ")", "[": "]", "{": "}" }[open];
  let depth = 0;
  for (; i < tokens.length; i++) {
    if (tokens[i] === open) depth++;
    else if (tokens[i] === close && --depth === 0) return i + 1;
  }
  return tokens.length;
}

function skipDirectives(tokens, i) {
  while (tokens[i] === "@") {
    i += 2; // @ name
    if (tokens[i] === "(") i = skipGroup(tokens, i);
  }
  return i;
}

/**
 * Read a selection set starting at tokens[i] === "{". Returns { fields, spreads, end }, where fields are
 * the real names of the top-level fields and spreads the named fragments it refers to.
 */
function readSelectionSet(tokens, i) {
  const fields = [], spreads = [];
  i++; // {
  while (i < tokens.length && tokens[i] !== "}") {
    if (tokens[i] === "...") {
      i++;
      if (tokens[i] === "on" && isName(tokens[i + 1])) i += 2;   // inline fragment with a type condition
      if (tokens[i] === "@" || tokens[i] === "{") {               // inline fragment
        i = skipDirectives(tokens, i);
        if (tokens[i] !== "{") return { fields, spreads, end: i, broken: true };
        const inner = readSelectionSet(tokens, i);
        fields.push(...inner.fields); spreads.push(...inner.spreads);
        if (inner.broken) return { fields, spreads, end: inner.end, broken: true };
        i = inner.end;
      } else if (isName(tokens[i])) {                             // named fragment spread
        spreads.push(tokens[i]); i++;
        i = skipDirectives(tokens, i);
      } else {
        return { fields, spreads, end: i, broken: true };
      }
      continue;
    }
    if (!isName(tokens[i])) return { fields, spreads, end: i, broken: true };
    let name = tokens[i]; i++;
    if (tokens[i] === ":" && isName(tokens[i + 1])) { name = tokens[i + 1]; i += 2; } // alias: real field
    if (tokens[i] === "(") i = skipGroup(tokens, i);
    i = skipDirectives(tokens, i);
    if (tokens[i] === "{") i = skipGroup(tokens, i);
    fields.push(name);
  }
  return { fields, spreads, end: i + 1, broken: i >= tokens.length };
}

/** Parse operations and fragments at the top level of a document. */
function parseDocument(doc) {
  const tokens = tokenize(doc);
  const operations = [], fragments = new Map();
  let i = 0, broken = false;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "{") {                                    // shorthand query
      const s = readSelectionSet(tokens, i);
      operations.push({ type: "query", ...s }); broken ||= s.broken; i = s.end; continue;
    }
    if (t === "query" || t === "mutation" || t === "subscription") {
      i++;
      if (isName(tokens[i]) && tokens[i] !== "{") i++;  // operation name
      if (tokens[i] === "(") i = skipGroup(tokens, i);  // variable definitions, defaults included
      i = skipDirectives(tokens, i);
      if (tokens[i] !== "{") { operations.push({ type: t, fields: [], spreads: [], broken: true }); broken = true; break; }
      const s = readSelectionSet(tokens, i);
      operations.push({ type: t, ...s }); broken ||= s.broken; i = s.end; continue;
    }
    if (t === "fragment" && isName(tokens[i + 1])) {
      const name = tokens[i + 1];
      i += 2;
      if (tokens[i] === "on") i += 2;
      i = skipDirectives(tokens, i);
      if (tokens[i] !== "{") { broken = true; break; }
      const s = readSelectionSet(tokens, i);
      fragments.set(name, s); broken ||= s.broken; i = s.end; continue;
    }
    broken = true; break; // anything else at the top level isn't valid GraphQL
  }
  return { operations, fragments, broken };
}

/** True if the document contains a mutation operation. */
export function isMutation(doc) {
  return parseDocument(doc).operations.some((op) => op.type === "mutation");
}

/**
 * Real root field names of every mutation in the document, e.g. ["metaobjectDefinitionCreate"].
 * Fragments are expanded. Anything that can't be resolved shows up as "(unknown …)".
 */
export function mutationFields(doc) {
  const { operations, fragments, broken } = parseDocument(doc);
  const out = [];
  const expand = (sel, seen) => {
    out.push(...sel.fields);
    for (const name of sel.spreads) {
      if (seen.has(name)) continue;
      const frag = fragments.get(name);
      if (!frag) { out.push(`(unknown fragment ${name})`); continue; }
      expand(frag, new Set([...seen, name]));
    }
  };
  for (const op of operations) if (op.type === "mutation") expand(op, new Set());
  if (broken) out.push("(unreadable mutation)");
  return [...new Set(out)];
}

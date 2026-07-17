/* eslint-disable */
/* Shared, navigable crate model for Codeview.
   One small graph of drizzle_core so that clicking any node/relationship
   in the Focus graph or the Explorer actually re-focuses the whole view.

   A relationship has a DIRECTION. We store each edge once (from → to) and
   compute, for any focused node, its outgoing groups (edges where it is the
   source) and incoming groups (edges where it is the target). The verb we
   show flips depending on which side you're standing on:
     Query --implements--> Executable
       · focus Query      → outgoing "implements: Executable"
       · focus Executable → incoming "implemented by: Query"
*/

const REL = {
  contains:   { color: 'var(--edge-contains)',   label: 'contains',    out: 'contains',    in: 'contained by'    },
  reexports:  { color: 'var(--edge-reexports)',  label: 're-exports',  out: 're-exports',  in: 're-exported by'  },
  implements: { color: 'var(--edge-implements)', label: 'implements',  out: 'implements',  in: 'implemented by'  },
  defines:    { color: 'var(--edge-defines)',    label: 'defines',     out: 'defines',     in: 'defined in'      },
  uses:       { color: 'var(--edge-uses)',       label: 'uses',        out: 'uses',        in: 'used by'         },
};
// Order relationships appear in panels / lanes
const REL_ORDER = ['contains', 'reexports', 'defines', 'implements', 'uses'];

const NODES = {
  drizzle_core:     { kind: 'crate',  path: 'drizzle_core', version: '0.1.4',
    blurb: 'Dialect-agnostic core of the drizzle query builder — the AST, the query types, and the traits every backend implements.' },
  drizzle:          { kind: 'crate',  path: 'drizzle',          external: true, blurb: 'Batteries-included facade re-exporting the core plus a default runtime.' },
  drizzle_cli:      { kind: 'crate',  path: 'drizzle_cli',      external: true, blurb: 'Command-line runner for migrations and query inspection.' },
  drizzle_postgres: { kind: 'crate',  path: 'drizzle_postgres', external: true, blurb: 'Postgres backend — implements the core execution traits.' },
  drizzle_sqlite:   { kind: 'crate',  path: 'drizzle_sqlite',   external: true, blurb: 'SQLite backend — implements the core execution traits.' },

  ast:    { kind: 'module', path: 'drizzle_core::ast',    blurb: 'The typed syntax tree every query lowers to.' },
  parser: { kind: 'module', path: 'drizzle_core::parser', blurb: 'Turns raw SQL fragments into AST nodes.' },
  traits: { kind: 'module', path: 'drizzle_core::traits', blurb: 'The behavioural contracts backends and query types implement.' },
  types:  { kind: 'module', path: 'drizzle_core::types',  blurb: 'Concrete data structures — queries, clauses, and parameters.' },

  Executable: { kind: 'trait', path: 'drizzle_core::traits::Executable',
    blurb: 'A query that can be run against a Database. Every statement builder implements it.',
    sig: 'pub trait Executable<DB: Database>: Send + Sync' },
  QueryExt:   { kind: 'trait', path: 'drizzle_core::traits::QueryExt',
    blurb: 'Ergonomic combinators layered on top of Executable.',
    sig: 'pub trait QueryExt: Executable' },
  IntoQuery:  { kind: 'trait', path: 'drizzle_core::traits::IntoQuery',
    blurb: 'Conversion into a runnable Query.', sig: 'pub trait IntoQuery' },

  Query:         { kind: 'struct', path: 'drizzle_core::types::Query',
    blurb: 'A composable SELECT/INSERT/UPDATE builder — the workhorse type.',
    sig: 'pub struct Query<T = ()>' },
  Select:        { kind: 'struct', path: 'drizzle_core::types::Select', blurb: 'A SELECT statement builder.', sig: 'pub struct Select' },
  Insert:        { kind: 'struct', path: 'drizzle_core::types::Insert', blurb: 'An INSERT statement builder.', sig: 'pub struct Insert' },
  Param:         { kind: 'struct', path: 'drizzle_core::types::Param', blurb: 'A bound query parameter.', sig: 'pub struct Param' },
  OrderByClause: { kind: 'struct', path: 'drizzle_core::types::OrderByClause', blurb: 'ORDER BY fragment attached to a query.', sig: 'pub struct OrderByClause' },
  WhereExpr:     { kind: 'enum',   path: 'drizzle_core::types::WhereExpr', blurb: 'A boolean predicate tree for WHERE clauses.', sig: 'pub enum WhereExpr' },

  execute: { kind: 'fn', path: 'drizzle_core::traits::Executable::execute',
    blurb: 'Run the query and return the result set.',
    sig: 'fn execute(self, db: &DB) -> impl Future' },
  execute_one: { kind: 'fn', path: 'drizzle_core::traits::Executable::execute_one',
    blurb: 'Run the query, expecting exactly one row.',
    sig: 'fn execute_one(self, db: &DB) -> impl Future' },
};

// from --rel--> to   (stored once, in the natural reading direction)
const EDGES = [
  ['drizzle_core', 'contains', 'ast'],
  ['drizzle_core', 'contains', 'parser'],
  ['drizzle_core', 'contains', 'traits'],
  ['drizzle_core', 'contains', 'types'],

  ['drizzle_core', 'reexports', 'Query'],
  ['drizzle_core', 'reexports', 'Select'],
  ['drizzle_core', 'reexports', 'Insert'],
  ['drizzle_core', 'reexports', 'Param'],
  ['drizzle_core', 'reexports', 'OrderByClause'],
  ['drizzle_core', 'reexports', 'WhereExpr'],

  ['traits', 'contains', 'Executable'],
  ['traits', 'contains', 'QueryExt'],
  ['traits', 'contains', 'IntoQuery'],

  ['types', 'contains', 'Query'],
  ['types', 'contains', 'Select'],
  ['types', 'contains', 'Insert'],
  ['types', 'contains', 'Param'],
  ['types', 'contains', 'OrderByClause'],
  ['types', 'contains', 'WhereExpr'],

  ['Executable', 'defines', 'execute'],
  ['Executable', 'defines', 'execute_one'],
  ['QueryExt', 'implements', 'Executable'],

  ['Query', 'implements', 'Executable'],
  ['Query', 'implements', 'QueryExt'],
  ['Select', 'implements', 'Executable'],
  ['Insert', 'implements', 'Executable'],

  ['drizzle', 'uses', 'drizzle_core'],
  ['drizzle_cli', 'uses', 'drizzle_core'],
  ['drizzle_postgres', 'uses', 'drizzle_core'],
  ['drizzle_sqlite', 'uses', 'drizzle_core'],
  ['drizzle_postgres', 'implements', 'Executable'],
  ['drizzle_sqlite', 'implements', 'Executable'],
];

function nodeOf(id) {
  return { id, ...(NODES[id] || { kind: 'module', path: id }) };
}

// Group helper: [{rel, dir:'out'|'in', verb, color, items:[node]}]
function focusModel(focusId) {
  const outBy = {}, inBy = {};
  for (const [from, rel, to] of EDGES) {
    if (from === focusId) (outBy[rel] ??= []).push(to);
    if (to === focusId)   (inBy[rel]  ??= []).push(from);
  }
  const build = (map, dir) =>
    REL_ORDER.filter(r => map[r]?.length).map(rel => ({
      rel, dir,
      verb: REL[rel][dir],
      color: REL[rel].color,
      items: map[rel].map(nodeOf),
    }));
  return {
    node: nodeOf(focusId),
    out: build(outBy, 'out'),
    in: build(inBy, 'in'),
  };
}

function relCounts(focusId) {
  const m = focusModel(focusId);
  const outN = m.out.reduce((s, g) => s + g.items.length, 0);
  const inN = m.in.reduce((s, g) => s + g.items.length, 0);
  return { outN, inN, total: outN + inN };
}

Object.assign(window, { REL, REL_ORDER, NODES, EDGES, nodeOf, focusModel, relCounts });

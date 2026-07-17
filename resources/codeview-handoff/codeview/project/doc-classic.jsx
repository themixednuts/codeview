/* eslint-disable */
/* Doc View A — Classic three-pane (refined docs.rs)
   Left: module tree. Center: item docs. Right: page TOC.
   Focused on density and reference use.
*/

const TREE_ITEMS = [
  { name: 'drizzle_core', kind: 'crate', depth: 0, active: false },
  { name: 'ast',          kind: 'module', depth: 1 },
  { name: 'codegen',      kind: 'module', depth: 1 },
  { name: 'parser',       kind: 'module', depth: 1 },
  { name: 'traits',       kind: 'module', depth: 1, open: true },
  // expanded children
  { name: 'Executable',   kind: 'trait',  depth: 2, active: true },
  { name: 'IntoQuery',    kind: 'trait',  depth: 2 },
  { name: 'QueryExt',     kind: 'trait',  depth: 2 },
  { name: 'Stream',       kind: 'trait',  depth: 2 },
  { name: 'types',        kind: 'module', depth: 1 },
  { name: 'OrderByClause',kind: 'struct', depth: 1 },
  { name: 'Param',        kind: 'struct', depth: 1 },
  { name: 'Query',        kind: 'struct', depth: 1 },
  { name: 'Select',       kind: 'struct', depth: 1 },
  { name: 'WhereExpr',    kind: 'enum',   depth: 1 },
  { name: 'execute',      kind: 'fn',     depth: 1 },
  { name: 'prepare',      kind: 'fn',     depth: 1 },
];

const TRAIT_SIG = `pub trait Executable<DB: Database>: Send + Sync {
    type Output;

    fn execute(self, db: &DB) -> impl Future<Output = Result<Self::Output>>;
    fn execute_one(self, db: &DB) -> impl Future<Output = Result<Self::Output>>
    where
        Self: Sized;
}`;

const EXAMPLE_SRC = `use drizzle_core::{Executable, Query};

let users = Query::from("users")
    .select(("id", "name"))
    .where_eq("active", true)
    .execute(&db)
    .await?;

for u in users {
    println!("{}: {}", u.id, u.name);
}`;

function DocClassic({ scheme = 'light' }) {
  const themeClass = scheme === 'dark' ? 'theme-dark' : '';
  return (
    <div className={`plate ${themeClass} flex flex-col`} style={{ width: 1440, height: 980 }}>
      <TopBar />

      {/* Sub-nav: crate header bar */}
      <div className="border-b" style={{ borderColor: 'var(--panel-border-soft)', background: 'var(--panel)' }}>
        <div className="mx-auto max-w-[1340px] px-6 h-12 flex items-center gap-4">
          <Breadcrumb segs={['drizzle_core', 'traits', 'Executable']} />
          <span className="badge badge-sm" style={{ background: 'var(--panel-solid)', color: 'var(--ink)' }}>
            <span className="size-1.5 rounded-full" style={{ background: 'var(--kind-trait)' }} />
            Trait
          </span>
          <AttrChip variant="pub">pub</AttrChip>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <input className="bg-transparent outline-none text-[12px] font-mono w-72 py-1.5 pl-7 pr-2 rounded-md border"
                     style={{ borderColor: 'var(--panel-border)', background: 'var(--panel-solid)' }}
                     defaultValue="" placeholder="Search in drizzle_core…" />
              <span className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }}><Icon.search size={12} /></span>
              <span className="absolute right-2 top-1/2 -translate-y-1/2 kbd">S</span>
            </div>
            <button className="flex items-center gap-1.5 text-[12px] px-2.5 py-1.5 rounded-md border"
                    style={{ borderColor: 'var(--panel-border)', background: 'var(--panel-solid)', color: 'var(--ink-soft)' }}>
              <span className="font-mono">v0.1.4</span>
              <Icon.chevronRight size={11} style={{ transform: 'rotate(90deg)' }} />
            </button>
            <button className="text-[12px] px-2.5 py-1.5 rounded-md font-medium" style={{ background: 'var(--accent-soft)', color: 'var(--accent-strong)' }}>
              View source
            </button>
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-[1340px] w-full px-6 py-6 grid grid-cols-[230px_1fr_220px] gap-8 flex-1 overflow-hidden">
        {/* LEFT — module tree */}
        <aside className="overflow-y-auto pr-1">
          <div className="text-[10px] font-semibold tracking-[0.22em] uppercase mb-2" style={{ color: 'var(--muted-soft)' }}>Module</div>
          <div className="font-display font-semibold text-[15px] mb-1" style={{ color: 'var(--ink)' }}>drizzle_core</div>
          <div className="font-mono text-[10.5px] mb-3" style={{ color: 'var(--muted-soft)' }}>v0.1.4 · 318 items</div>

          <div className="space-y-0.5">
            {TREE_ITEMS.map((it, i) => (
              <TreeRow key={i} {...it} />
            ))}
          </div>
        </aside>

        {/* CENTER — item body */}
        <article className="overflow-y-auto pr-2">
          {/* Title row */}
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="text-[11px] font-mono tracking-wider uppercase" style={{ color: 'var(--kind-trait)' }}>Trait</span>
            <h1 className="font-display font-semibold text-[34px] leading-none tracking-tight" style={{ color: 'var(--ink)' }}>
              Executable
            </h1>
            <span className="font-mono text-[12px]" style={{ color: 'var(--muted-soft)' }}>
              drizzle_core::traits::Executable
            </span>
          </div>
          <p className="mt-3 text-[14.5px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
            A query that can be run against a <span className="font-mono">Database</span>. All
            statement builders in <span className="font-mono">drizzle</span> implement this trait, so
            you can call <span className="font-mono">.execute(&db).await</span> on any of them.
          </p>

          {/* Signature */}
          <div className="mt-5">
            <Signature src={TRAIT_SIG} />
          </div>

          {/* Source line */}
          <div className="mt-2 flex items-center gap-3 text-[11px] font-mono" style={{ color: 'var(--muted-soft)' }}>
            <a className="hover:underline" style={{ color: 'var(--link)' }}>src/traits.rs#L42</a>
            <span>·</span>
            <span>added in 0.1.0</span>
            <span>·</span>
            <span>{`implemented by 14 types`}</span>
          </div>

          {/* Required methods */}
          <SectionHeading title="Required methods" count="1 of 2" anchor="required-methods" />
          <ItemRow
            sig={`fn execute(self, db: &DB) -> impl Future<Output = Result<Self::Output>>`}
            desc="Run the query against the database and return the result. The default impl awaits a single round-trip."
          />
          <ItemRow
            sig={`fn execute_one(self, db: &DB) -> impl Future<Output = Result<Self::Output>>`}
            desc="Like execute, but fails if the query returns more than one row. Implementers may override for a faster path."
            since="0.1.2"
          />

          {/* Example */}
          <SectionHeading title="Example" anchor="example" />
          <CodeBlock src={EXAMPLE_SRC} label="example.rs" lines />

          {/* Implementors */}
          <SectionHeading title="Implementors" count={14} anchor="implementors" />
          {[
            { sig: `impl<T> Executable<Postgres> for Query<T>`,           desc: 'where T: FromRow' },
            { sig: `impl<T> Executable<Sqlite> for Query<T>`,             desc: 'where T: FromRow' },
            { sig: `impl Executable<Postgres> for Select`,                desc: 'Postgres dialect: standard SELECT' },
            { sig: `impl<T> Executable<MySql> for Query<T>`,              desc: 'where T: FromRow' },
            { sig: `impl Executable<Postgres> for Insert`,                desc: 'Returns the number of rows affected.' },
          ].map((it, i) => <ItemRow key={i} {...it} />)}
        </article>

        {/* RIGHT — page TOC */}
        <aside className="overflow-y-auto sticky top-0">
          <div className="text-[10px] font-semibold tracking-[0.22em] uppercase mb-2" style={{ color: 'var(--muted-soft)' }}>
            On this page
          </div>
          <div className="space-y-0">
            <TocLink text="Executable" />
            <TocLink text="Required methods" depth={0} active count="2" />
            <TocLink text="execute" depth={1} />
            <TocLink text="execute_one" depth={1} />
            <TocLink text="Example" />
            <TocLink text="Implementors" count="14" />
          </div>

          <div className="mt-7 corner-squircle p-3"
               style={{ background: 'var(--panel)', border: '1px solid var(--panel-border-soft)', borderRadius: 'var(--radius-card)' }}>
            <div className="text-[10px] font-semibold tracking-[0.22em] uppercase mb-2" style={{ color: 'var(--muted-soft)' }}>
              Where used
            </div>
            <ul className="space-y-1 font-mono text-[11.5px]" style={{ color: 'var(--ink-soft)' }}>
              <li><a className="hover:underline">drizzle::Database</a></li>
              <li><a className="hover:underline">drizzle::Connection</a></li>
              <li><a className="hover:underline">drizzle::Pool</a></li>
              <li><a className="hover:underline">drizzle_cli::run</a></li>
            </ul>
            <a className="mt-2 inline-flex items-center gap-1 text-[10.5px] font-mono" style={{ color: 'var(--accent-strong)' }}>
              Open in graph <Icon.arrowRight size={10} />
            </a>
          </div>
        </aside>
      </main>
    </div>
  );
}

window.DocClassic = DocClassic;

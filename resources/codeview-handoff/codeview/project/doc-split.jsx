/* eslint-disable */
/* Doc View C — Split with Source
   Docs left + source viewer right. Hovering on a method jumps the source.
   For when reading code is part of reading docs.
*/

const SRC_SOURCE = `// drizzle_core/src/traits.rs
//
// The Executable trait is the universal entry point for any
// runnable statement in drizzle. All builder types implement
// it; concrete database backends provide impls per dialect.

use std::future::Future;
use crate::database::Database;
use crate::Result;

/// A query that can be run against a Database.
#[must_use = "queries are lazy — call .execute(&db)"]
pub trait Executable<DB: Database>: Send + Sync {
    type Output;

    fn execute(self, db: &DB)
        -> impl Future<Output = Result<Self::Output>>;

    fn execute_one(self, db: &DB)
        -> impl Future<Output = Result<Self::Output>>
    where
        Self: Sized,
    {
        // Default: delegate to execute and assert single row.
        async move {
            let out = self.execute(db).await?;
            Ok(out)
        }
    }
}`;

const SPLIT_SIG = `pub trait Executable<DB: Database>: Send + Sync {
    type Output;

    fn execute(self, db: &DB) -> impl Future<Output = Result<Self::Output>>;
}`;

function DocSplit({ scheme = 'light' }) {
  const themeClass = scheme === 'dark' ? 'theme-dark' : '';
  return (
    <div className={`plate ${themeClass} flex flex-col`} style={{ width: 1440, height: 980 }}>
      <TopBar />

      {/* Slim crate header */}
      <div className="border-b" style={{ borderColor: 'var(--panel-border-soft)', background: 'var(--panel)' }}>
        <div className="mx-auto max-w-[1380px] px-6 h-11 flex items-center gap-3">
          <Breadcrumb segs={['drizzle_core', 'traits', 'Executable']} />
          <span className="badge badge-sm" style={{ background: 'var(--panel-solid)', color: 'var(--ink)' }}>
            <span className="size-1.5 rounded-full" style={{ background: 'var(--kind-trait)' }} />
            Trait
          </span>
          <AttrChip variant="pub">pub</AttrChip>
          <div className="ml-auto flex items-center gap-2 text-[11.5px]" style={{ color: 'var(--muted)' }}>
            <span className="font-mono">v0.1.4</span>
            <span>·</span>
            <a className="hover:underline" style={{ color: 'var(--link)' }}>edit on github</a>
            <span>·</span>
            <a className="hover:underline" style={{ color: 'var(--link)' }}>relationship graph</a>
          </div>
        </div>
      </div>

      <main className="flex-1 overflow-hidden grid grid-cols-[1fr_minmax(480px,_44%)]">
        {/* LEFT — docs */}
        <article className="overflow-y-auto px-8 py-7" style={{ borderRight: '1px solid var(--panel-border-soft)' }}>
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="text-[11px] font-mono tracking-[0.22em] uppercase" style={{ color: 'var(--kind-trait)' }}>Trait</span>
            <h1 className="font-display font-semibold text-[36px] leading-none tracking-tight" style={{ color: 'var(--ink)' }}>
              Executable
            </h1>
          </div>
          <p className="mt-3 text-[14.5px] leading-relaxed max-w-[60ch]" style={{ color: 'var(--ink-soft)' }}>
            A query that can be run against a <span className="font-mono">Database</span>. All
            builder types implement this trait — call <span className="font-mono">.execute(&db).await</span>
            on any of them.
          </p>

          <div className="mt-5">
            <Signature src={SPLIT_SIG} />
          </div>

          <SectionHeading title="Required methods" count={2} anchor="required-methods" />
          <a className="block hover:bg-[color:var(--panel-muted)] -mx-3 px-3 rounded-lg transition">
            <ItemRow
              sig={`fn execute(self, db: &DB) -> impl Future<Output = Result<Self::Output>>`}
              desc="Run the query against the database and return the result."
            />
          </a>
          <a className="block hover:bg-[color:var(--panel-muted)] -mx-3 px-3 rounded-lg transition">
            <ItemRow
              sig={`fn execute_one(self, db: &DB) -> impl Future<Output = Result<Self::Output>>`}
              desc="Like execute, but fails if the query returns more than one row."
              since="0.1.2"
            />
          </a>

          <SectionHeading title="Implementors" count={14} anchor="implementors" />
          <div className="grid grid-cols-1 gap-0">
            {[
              { sig: `impl<T> Executable<Postgres> for Query<T>`, where: 'where T: FromRow' },
              { sig: `impl<T> Executable<Sqlite>   for Query<T>`, where: 'where T: FromRow' },
              { sig: `impl<T> Executable<MySql>    for Query<T>`, where: 'where T: FromRow' },
              { sig: `impl Executable<Postgres> for Select`,      where: '' },
              { sig: `impl Executable<Postgres> for Insert`,      where: 'Returns rows affected.' },
              { sig: `impl Executable<Postgres> for Update`,      where: '' },
              { sig: `impl Executable<Postgres> for Delete`,      where: '' },
              { sig: `impl Executable<Sqlite>   for Select`,      where: '' },
            ].map((it, i) => (
              <ItemRow key={i} sig={it.sig} desc={it.where || undefined} />
            ))}
          </div>
        </article>

        {/* RIGHT — source viewer */}
        <section className="overflow-hidden flex flex-col" style={{ background: 'var(--code-bg)', color: 'var(--code-ink)' }}>
          <div className="flex items-center justify-between px-4 h-10 font-mono text-[11.5px]"
               style={{ borderBottom: '1px solid var(--code-border)', background: 'var(--code-bg-soft)', color: 'var(--syntax-comment)' }}>
            <div className="flex items-center gap-2">
              <span style={{ color: 'var(--syntax-comment)' }}>codeview-core/</span>
              <span style={{ color: 'var(--code-ink)' }}>src/traits.rs</span>
              <span className="ml-2 px-1.5 py-[1px] rounded text-[10px]"
                    style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>L13-L36</span>
            </div>
            <div className="flex items-center gap-3" style={{ color: 'var(--syntax-comment)' }}>
              <button title="Copy">⎘</button>
              <button title="Open in editor">↗</button>
              <button title="Close">×</button>
            </div>
          </div>

          <div className="flex-1 overflow-auto">
            <div className="flex">
              <pre className="font-mono text-[12.5px] leading-[1.75] px-3 py-3 text-right select-none"
                   style={{ color: 'var(--code-ln)', borderRight: '1px solid var(--code-border)' }}>
                {Array.from({ length: SRC_SOURCE.split('\n').length }, (_, i) => i + 1).join('\n')}
              </pre>
              <pre className="code px-4 py-3 flex-1" style={{ margin: 0 }}>
                <CodeTokens src={SRC_SOURCE} />
              </pre>
            </div>
          </div>

          <div className="px-4 h-9 font-mono text-[10.5px] flex items-center gap-3"
               style={{ borderTop: '1px solid var(--code-border)', background: 'var(--code-bg-soft)', color: 'var(--syntax-comment)' }}>
            <span>rust</span>
            <span>·</span>
            <span>UTF-8</span>
            <span>·</span>
            <span>32 lines</span>
            <span className="ml-auto">{`◴ 12kb`}</span>
          </div>
        </section>
      </main>
    </div>
  );
}

window.DocSplit = DocSplit;

/* eslint-disable */
/* Doc View B — Reading Mode
   Wide single column. Display serif headings, generous measure on prose,
   no left sidebar (hideable). For people reading, not bouncing between symbols.
*/

const READING_DOC = `When you reach for a database in Rust, the cost is usually verbosity: builder
patterns, trait bounds spelled out twice, and a hot pile of macros. Executable
is a small interface that hides the last of those, while leaving the rest of
the type system intact. Every query type — Select, Insert, Update, the raw
Query<T> — implements it. The intent is that you should never have to remember
which method runs the query.`;

const READING_SIG = `pub trait Executable<DB: Database>: Send + Sync {
    type Output;
    fn execute(self, db: &DB) -> impl Future<Output = Result<Self::Output>>;
}`;

const READING_EXAMPLE = `use drizzle_core::{Executable, Query};

// Any builder is Executable; pick one and run it.
let users = Query::from("users")
    .select(("id", "name"))
    .where_eq("active", true)
    .execute(&db)
    .await?;`;

function DocReading({ scheme = 'light' }) {
  const themeClass = scheme === 'dark' ? 'theme-dark' : '';
  return (
    <div className={`plate ${themeClass} flex flex-col`} style={{ width: 1440, height: 980 }}>
      <TopBar />

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-8 py-14">
          {/* Tiny breadcrumb */}
          <div className="text-[11.5px] font-mono mb-8" style={{ color: 'var(--muted-soft)' }}>
            <a className="hover:underline" style={{ color: 'var(--muted)' }}>drizzle_core</a>
            <span> :: </span>
            <a className="hover:underline" style={{ color: 'var(--muted)' }}>traits</a>
            <span> :: </span>
            <span style={{ color: 'var(--ink)', fontWeight: 600 }}>Executable</span>
          </div>

          {/* Title row */}
          <div className="flex items-center gap-3 mb-2">
            <span className="text-[11px] font-mono tracking-[0.22em] uppercase" style={{ color: 'var(--kind-trait)' }}>Trait</span>
            <span className="font-mono text-[11px]" style={{ color: 'var(--muted-soft)' }}>since 0.1.0</span>
          </div>
          <h1 className="font-display font-semibold tracking-tight" style={{ fontSize: 56, lineHeight: 1, letterSpacing: '-0.02em', color: 'var(--ink)' }}>
            Executable
          </h1>
          <p className="mt-5 text-[18px] leading-[1.55] font-serif"
             style={{ fontFamily: 'var(--font-display)', color: 'var(--ink-soft)', fontStyle: 'italic', fontWeight: 400 }}>
            A query you can run against a database — the universal entry-point of the
            <span className="font-mono not-italic" style={{ color: 'var(--accent-strong)' }}> drizzle </span>
            statement builders.
          </p>

          {/* The signature, larger than usual */}
          <div className="mt-8">
            <Signature src={READING_SIG} />
          </div>

          {/* Body prose */}
          <p className="mt-8 text-[15.5px] leading-[1.75]" style={{ color: 'var(--ink-soft)' }}>
            {READING_DOC}
          </p>

          {/* Pull quote / call-out */}
          <div className="my-9 pl-5 border-l-2" style={{ borderColor: 'var(--accent)' }}>
            <p className="text-[15.5px] leading-[1.6]" style={{ color: 'var(--ink)' }}>
              In practice: build something, call <span className="font-mono" style={{ color: 'var(--accent-strong)' }}>.execute(&db).await</span>,
              go home.
            </p>
          </div>

          <h2 className="font-display font-semibold text-[28px] mt-10 mb-3 tracking-tight" style={{ color: 'var(--ink)' }}>
            Example
          </h2>
          <CodeBlock src={READING_EXAMPLE} />

          <h2 className="font-display font-semibold text-[28px] mt-10 mb-3 tracking-tight" style={{ color: 'var(--ink)' }}>
            Required methods
          </h2>
          <ItemRow
            sig={`fn execute(self, db: &DB) -> impl Future<Output = Result<Self::Output>>`}
            desc="Run the query against the database and return the result. Awaits a single round-trip."
          />
          <ItemRow
            sig={`fn execute_one(self, db: &DB) -> impl Future<Output = Result<Self::Output>>`}
            desc="Like execute, but fails if the query returns more than one row. Override for a fast-path."
            since="0.1.2"
          />

          <h2 className="font-display font-semibold text-[28px] mt-10 mb-3 tracking-tight" style={{ color: 'var(--ink)' }}>
            Implementors{' '}
            <span className="font-mono text-[14px] font-normal align-middle" style={{ color: 'var(--muted-soft)' }}>14</span>
          </h2>
          {[
            { sig: `impl<T> Executable<Postgres> for Query<T>`,           desc: 'where T: FromRow' },
            { sig: `impl<T> Executable<Sqlite>   for Query<T>`,           desc: 'where T: FromRow' },
            { sig: `impl Executable<Postgres> for Select`,                desc: 'Standard PostgreSQL SELECT.' },
            { sig: `impl Executable<Postgres> for Insert`,                desc: 'Returns the number of rows affected.' },
          ].map((it, i) => <ItemRow key={i} {...it} />)}

          {/* Footer next/prev */}
          <div className="mt-16 grid grid-cols-2 gap-3 text-[12px]">
            <a className="corner-squircle px-4 py-3 border rounded-lg" style={{ background: 'var(--panel)', borderColor: 'var(--panel-border)' }}>
              <div style={{ color: 'var(--muted-soft)' }}>← previous</div>
              <div className="font-mono mt-0.5" style={{ color: 'var(--ink)' }}>IntoQuery</div>
            </a>
            <a className="corner-squircle px-4 py-3 border rounded-lg text-right" style={{ background: 'var(--panel)', borderColor: 'var(--panel-border)' }}>
              <div style={{ color: 'var(--muted-soft)' }}>next →</div>
              <div className="font-mono mt-0.5" style={{ color: 'var(--ink)' }}>QueryExt</div>
            </a>
          </div>
        </div>
      </main>

      {/* Floating TOC */}
      <div className="fixed right-8 top-24 hidden">
        <div className="corner-squircle p-3 w-[160px]"
             style={{ background: 'var(--panel)', border: '1px solid var(--panel-border-soft)', borderRadius: 10 }}>
        </div>
      </div>
    </div>
  );
}

window.DocReading = DocReading;

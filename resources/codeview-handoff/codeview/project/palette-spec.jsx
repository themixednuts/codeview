/* eslint-disable */
/* Palette spec sheet — shows the design system at a glance so the user
   can react to the palette directly, not just to its application.
   Light + dark side-by-side.
*/

function Swatch({ name, varName, hex, light = true }) {
  return (
    <div className="flex items-center gap-2.5">
      <div
        className="size-9 rounded-md shrink-0"
        style={{
          background: `var(${varName})`,
          boxShadow: light ? 'inset 0 0 0 1px rgba(20,22,26,0.12)' : 'inset 0 0 0 1px rgba(255,255,255,0.08)',
        }}
      />
      <div className="min-w-0">
        <div className="font-mono text-[11px] font-semibold" style={{ color: 'var(--ink)' }}>{name}</div>
        <div className="font-mono text-[10px]" style={{ color: 'var(--muted-soft)' }}>{hex}</div>
      </div>
    </div>
  );
}

function KindChip({ kind }) {
  return (
    <div className="flex items-center gap-2">
      <KindBadge kind={kind} size={16} />
      <span className="mono text-[11px]" style={{ color: 'var(--ink-soft)' }}>{kind}</span>
    </div>
  );
}

function CodeSample({ dark = true }) {
  const src = `/// Run a query against the database.
#[must_use]
pub trait Executable<DB: Database>: Send + Sync {
    type Output;

    fn execute(self, db: &DB)
        -> impl Future<Output = Result<Self::Output>>;
}

let users = Query::from("users")
    .where_eq("active", true)
    .execute(&db).await?;`;
  return (
    <div className="corner-squircle overflow-hidden"
         style={{
           background: 'var(--code-bg)',
           border: '1px solid var(--code-border)',
           borderRadius: 6,
         }}>
      <div className="flex items-center justify-between px-3 py-1.5 text-[10px] font-mono"
           style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.4)' }}>
        <span>src/traits.rs</span>
        <span>rust</span>
      </div>
      <pre className="code px-3 py-3" style={{ color: 'var(--code-ink)', margin: 0, fontSize: 11.5, lineHeight: 1.7 }}>
        <CodeTokens src={src} />
      </pre>
    </div>
  );
}

function PaletteCard({ scheme = 'light', codeTheme, label }) {
  const dark = scheme === 'dark';
  return (
    <div className={`${dark ? 'theme-dark' : ''} plate flex flex-col`}
         data-static-scheme={scheme}
         data-code-theme={codeTheme || (dark ? 'one-dark' : 'one-light')}
         style={{ width: 580, height: 720, borderRadius: 14, overflow: 'hidden', border: dark ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(20,22,26,0.12)' }}>
      {/* Header bar */}
      <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--panel-border-soft)' }}>
        <div className="flex items-center gap-3">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="3" width="18" height="18" rx="4" fill="var(--accent)" />
            <path d="M8 12l3 3 5-6" stroke={dark ? '#0c0e12' : '#fff'} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
          </svg>
          <div>
            <div className="font-display text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>codeview</div>
            <div className="mono text-[10px]" style={{ color: 'var(--muted-soft)' }}>{label}</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="size-2.5 rounded-full" style={{ background: 'var(--accent)' }} />
          <div className="size-2.5 rounded-full" style={{ background: 'var(--kind-module)' }} />
          <div className="size-2.5 rounded-full" style={{ background: 'var(--kind-struct)' }} />
          <div className="size-2.5 rounded-full" style={{ background: 'var(--kind-enum)' }} />
          <div className="size-2.5 rounded-full" style={{ background: 'var(--kind-trait)' }} />
          <div className="size-2.5 rounded-full" style={{ background: 'var(--kind-function)' }} />
        </div>
      </div>

      <div className="flex-1 px-5 py-5 overflow-hidden flex flex-col gap-5">
        {/* Type specimen */}
        <div>
          <div className="mono text-[9px] tracking-[0.22em] uppercase mb-2" style={{ color: 'var(--muted-soft)' }}>type</div>
          <h1 className="font-display text-[28px] tracking-tight" style={{ color: 'var(--ink)', lineHeight: 1, fontWeight: 500 }}>
            Executable
          </h1>
          <p className="mt-2 text-[13px] leading-snug" style={{ color: 'var(--ink-soft)' }}>
            A query that can be run against a Database. All builder types implement this trait.
          </p>
          <p className="mt-1 text-[12px]" style={{ color: 'var(--muted)' }}>
            <span className="mono">drizzle_core::traits</span> · <a className="ulink">view source</a>
          </p>
        </div>

        {/* Code sample */}
        <CodeSample />

        {/* Kinds row */}
        <div>
          <div className="mono text-[9px] tracking-[0.22em] uppercase mb-2" style={{ color: 'var(--muted-soft)' }}>item kinds</div>
          <div className="grid grid-cols-4 gap-x-3 gap-y-1.5">
            {['crate','module','struct','enum','trait','impl','function','macro'].map(k =>
              <KindChip key={k} kind={k} />
            )}
          </div>
        </div>

        {/* Surfaces */}
        <div className="grid grid-cols-4 gap-2 mt-auto">
          {[
            ['bg', '--bg'],
            ['panel', '--panel'],
            ['solid', '--panel-solid'],
            ['accent', '--accent'],
          ].map(([n, v]) => (
            <div key={n} className="rounded-md p-2.5" style={{ background: `var(${v})`, border: '1px solid var(--panel-border)' }}>
              <div className="mono text-[10px]" style={{ color: n === 'accent' ? 'var(--on-accent)' : 'var(--ink-soft)' }}>{n}</div>
              <div className="mono text-[9px] opacity-60" style={{ color: n === 'accent' ? 'var(--on-accent)' : 'var(--muted-soft)' }}>{v}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PaletteSpec() {
  return (
    <div style={{ width: 1200, height: 720, background: 'transparent', display: 'flex', gap: 20 }}>
      <PaletteCard scheme="light" label="paper · default" />
      <PaletteCard scheme="dark"  label="ink · dark variant" />
    </div>
  );
}

window.PaletteSpec = PaletteSpec;

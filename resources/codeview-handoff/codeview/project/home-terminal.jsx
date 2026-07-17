/* eslint-disable */
/* Home D — Terminal / codey
   Dark by default, mono-forward. The wordmark is a prompt; search is the
   primary action. Grid of "files" rather than cards. For people who live
   in the terminal.
*/

const D_POPULAR = [
  { name: 'serde',      version: '1.0.219', desc: 'Generic serialization framework',          dl: '512M', items: 1842 },
  { name: 'tokio',      version: '1.45.1',  desc: 'Event-driven async runtime',                dl: '298M', items: 2104 },
  { name: 'clap',       version: '4.5.40',  desc: 'Full-featured CLI argument parser',         dl: '241M', items: 412  },
  { name: 'reqwest',    version: '0.12.15', desc: 'Higher-level HTTP client',                  dl: '188M', items: 286  },
  { name: 'anyhow',     version: '1.0.95',  desc: 'Flexible concrete error type',              dl: '162M', items: 34   },
  { name: 'sqlx',       version: '0.8.6',   desc: 'Async, pure-Rust SQL toolkit',              dl: '74M',  items: 1518 },
  { name: 'axum',       version: '0.8.4',   desc: 'Web framework focused on ergonomics',       dl: '38M',  items: 412  },
  { name: 'tracing',    version: '0.1.42',  desc: 'Structured application diagnostics',        dl: '156M', items: 318  },
  { name: 'rayon',      version: '1.10.0',  desc: 'Data-parallelism library',                  dl: '94M',  items: 184  },
];

function HomeTerminal() {
  return (
    <div className="plate theme-dark flex flex-col" data-static-scheme="dark" style={{ width: 1280, height: 900 }}>
      <TopBar />
      <main className="mx-auto w-full max-w-[1040px] px-8 pt-10 pb-12 flex-1 overflow-hidden">
        {/* prompt-style header */}
        <div className="flex items-center gap-3">
          <span className="font-mono text-[14px]" style={{ color: 'var(--accent)' }}>~/codeview</span>
          <span className="font-mono text-[14px]" style={{ color: 'var(--muted-soft)' }}>$</span>
          <span className="font-mono text-[14px]" style={{ color: 'var(--ink-soft)' }}>browse</span>
          <span className="ml-1 inline-block w-2 h-4 align-middle" style={{ background: 'var(--accent)', animation: 'blink 1s steps(2, jump-none) infinite' }} />
        </div>

        <h1 className="font-display mt-4 tracking-tight" style={{ fontSize: 48, lineHeight: 1.05, color: 'var(--ink)', letterSpacing: '-0.02em', fontWeight: 600 }}>
          Read Rust the way<br />
          <span style={{ color: 'var(--muted)' }}>it was written.</span>
        </h1>

        <p className="mt-4 max-w-[520px] text-[14px] leading-relaxed" style={{ color: 'var(--muted)' }}>
          Documentation for{' '}
          <span className="font-mono" style={{ color: 'var(--ink-soft)' }}>186,402</span> crates ·{' '}
          <span className="font-mono" style={{ color: 'var(--ink-soft)' }}>4.2M</span> items, indexed and cross-referenced.
        </p>

        {/* Search bar — terminal style */}
        <div className="mt-7 max-w-[660px] corner-squircle"
             style={{ background: '#0a0d12', border: '1px solid var(--panel-border)', borderRadius: 8 }}>
          <div className="flex items-center gap-2 px-4 py-3">
            <span className="font-mono text-[13px]" style={{ color: 'var(--accent)' }}>›</span>
            <input
              className="bg-transparent outline-none flex-1 font-mono text-[13.5px]"
              style={{ color: 'var(--ink)' }}
              placeholder="search crate, type, function…"
            />
            <span className="kbd">⌘</span><span className="kbd">K</span>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-3 font-mono text-[10.5px]" style={{ color: 'var(--muted-soft)' }}>
          <span>try</span>
          {['tokio::spawn', 'Vec<T>::push', 'serde::Deserialize', 'axum::Router'].map(t =>
            <a key={t} className="px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--muted)' }}>{t}</a>
          )}
        </div>

        {/* Workspace + top — two columns */}
        <div className="mt-9 grid grid-cols-[1fr_1.6fr] gap-8">
          {/* workspace */}
          <section>
            <div className="font-mono text-[10.5px] tracking-[0.22em] uppercase mb-3 flex items-center gap-2" style={{ color: 'var(--muted)' }}>
              <span style={{ color: 'var(--accent)' }}>※</span> workspace · drizzle
            </div>
            <div className="space-y-0 border" style={{ borderColor: 'var(--panel-border-soft)', borderRadius: 6 }}>
              {['drizzle','drizzle_core','drizzle_macros','drizzle_postgres','drizzle_sqlite','drizzle_types','drizzle_migrations'].map((n, i) => (
                <a key={n} className="flex items-center gap-3 px-3 py-2 hover:bg-white/[0.03] group"
                   style={{ borderTop: i === 0 ? 'none' : '1px solid var(--panel-border-soft)' }}>
                  <KindIcon kind="crate" size={13} />
                  <span className="font-mono text-[12.5px] flex-1" style={{ color: 'var(--ink)' }}>{n}</span>
                  <span className="font-mono text-[10.5px]" style={{ color: 'var(--muted-soft)' }}>0.1.4</span>
                  <Icon.chevronRight size={11} style={{ color: 'var(--muted-soft)' }} />
                </a>
              ))}
            </div>
          </section>

          {/* recent + trending */}
          <section>
            <div className="font-mono text-[10.5px] tracking-[0.22em] uppercase mb-3 flex items-center gap-2" style={{ color: 'var(--muted)' }}>
              <span style={{ color: 'var(--accent)' }}>↗</span> trending · last 24h
            </div>
            <div className="grid grid-cols-3 gap-x-6 gap-y-2 font-mono text-[12px]">
              {D_POPULAR.map((c, i) => (
                <a key={c.name} className="group flex items-baseline gap-2 py-1 border-b" style={{ borderColor: 'var(--panel-border-soft)' }}>
                  <span className="text-[10px] tabular-nums w-6" style={{ color: 'var(--muted-soft)' }}>{String(i + 1).padStart(2, '0')}</span>
                  <span className="flex-1 truncate" style={{ color: 'var(--ink)' }}>{c.name}</span>
                  <span className="text-[10px]" style={{ color: 'var(--muted-soft)' }}>{c.version}</span>
                </a>
              ))}
            </div>

            <div className="mt-8 font-mono text-[10.5px] tracking-[0.22em] uppercase mb-3 flex items-center gap-2" style={{ color: 'var(--muted)' }}>
              <span style={{ color: 'var(--accent)' }}>◴</span> recently released
            </div>
            <div className="space-y-0">
              {[
                ['axum',   '0.8.4',   '2h',  'Web framework focused on ergonomics'],
                ['leptos', '0.7.5',   '6h',  'Full-stack isomorphic web framework'],
                ['bevy',   '0.16.0',  '1d',  'Data-driven game engine'],
                ['rspack', '1.3.10',  '1d',  'Fast Rust-based web bundler'],
              ].map(([n, v, w, d], i) => (
                <a key={n} className="flex items-baseline gap-3 py-2 border-b group" style={{ borderColor: 'var(--panel-border-soft)' }}>
                  <span className="font-mono text-[11px] w-6" style={{ color: 'var(--muted-soft)' }}>{w}</span>
                  <span className="font-mono text-[12.5px] w-[80px]" style={{ color: 'var(--ink)' }}>{n}</span>
                  <span className="font-mono text-[10.5px]" style={{ color: 'var(--muted-soft)' }}>{v}</span>
                  <span className="text-[12px] truncate flex-1" style={{ color: 'var(--muted)' }}>{d}</span>
                </a>
              ))}
            </div>
          </section>
        </div>
      </main>

      <style>{`@keyframes blink { 0%, 50% { opacity: 1 } 51%, 100% { opacity: 0 } }`}</style>
    </div>
  );
}

window.HomeTerminal = HomeTerminal;

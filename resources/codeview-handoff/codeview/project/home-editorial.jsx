/* eslint-disable */
/* Home — dark codey theme.
   "Nothing flashy just nice." Type-driven. No animated graph backdrop.
   Single screen: hero with search, workspace strip, trending grid, recent feed.
*/

const POPULAR = [
  { name: 'tokio',    version: '1.45.1',  desc: 'An event-driven, non-blocking I/O platform for async Rust', dl: '298M', trend: [3,4,4,5,6,7,8,9,11,12,13,14] },
  { name: 'serde',    version: '1.0.219', desc: 'A generic serialization/deserialization framework',         dl: '512M', trend: [4,5,6,5,7,8,9,10,11,12,11,13] },
  { name: 'clap',     version: '4.5.40',  desc: 'A simple to use, efficient, and full-featured CLI parser',  dl: '241M', trend: [2,3,4,5,6,6,7,8,9,10,10,11] },
  { name: 'reqwest',  version: '0.12.15', desc: 'Higher level HTTP client library',                          dl: '188M', trend: [5,5,6,6,7,8,8,9,10,11,12,13] },
  { name: 'anyhow',   version: '1.0.95',  desc: 'Flexible concrete Error type built on std::error::Error',   dl: '162M', trend: [3,3,4,5,5,6,7,7,8,9,10,11] },
  { name: 'sqlx',     version: '0.8.6',   desc: 'Async, pure-Rust SQL toolkit with compile-time checks',     dl: '74M',  trend: [1,2,3,4,5,5,6,7,8,9,10,11] },
];

const WORKSPACE = [
  'drizzle','drizzle_core','drizzle_macros','drizzle_postgres','drizzle_sqlite','drizzle_types','drizzle_migrations',
];

const RECENT = [
  { name: 'axum',    version: '0.8.4',   when: '2h ago',  desc: 'Web framework that focuses on ergonomics and modularity' },
  { name: 'leptos',  version: '0.7.5',   when: '6h ago',  desc: 'Full-stack, isomorphic web framework with fine-grained reactivity' },
  { name: 'bevy',    version: '0.16.0',  when: '1d ago',  desc: 'A refreshingly simple data-driven game engine built in Rust' },
  { name: 'rspack',  version: '1.3.10',  when: '1d ago',  desc: 'Fast Rust-based web bundler' },
  { name: 'wgpu',    version: '24.0.0',  when: '2d ago',  desc: 'Cross-platform, safe, pure-Rust graphics API' },
  { name: 'polars',  version: '0.45.0',  when: '3d ago',  desc: 'DataFrame library with a lazy query engine, powered by Arrow' },
  { name: 'cargo',   version: '0.83.0',  when: '4d ago',  desc: 'The Rust package manager' },
];

function CrateCard({ c }) {
  return (
    <a
      className="group block"
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--panel-border)',
        borderRadius: 'var(--radius-card)',
        padding: '14px 16px',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <KindBadge kind="crate" size={14} />
            <span className="mono text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>{c.name}</span>
            <span className="mono text-[10.5px]" style={{ color: 'var(--muted-soft)' }}>{c.version}</span>
          </div>
          <p className="mt-2 text-[12.5px] leading-snug line-clamp-2" style={{ color: 'var(--muted)' }}>{c.desc}</p>
        </div>
        <Sparkline data={c.trend} />
      </div>
      <div className="mt-3 flex items-center justify-between text-[11px]" style={{ color: 'var(--muted-soft)' }}>
        <span className="mono inline-flex items-center gap-1.5">
          <Icon.download size={11} /> {c.dl}
        </span>
        <span className="inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 transition" style={{ color: 'var(--accent)' }}>
          open <Icon.arrowRight size={11} />
        </span>
      </div>
    </a>
  );
}

function HomeMain() {
  return (
    <div className="plate flex flex-col" style={{ width: 1280, height: 900 }}>
      <TopBar />
      <main className="mx-auto w-full max-w-[1080px] px-8 pt-12 pb-8 flex-1 overflow-hidden">
        {/* HERO */}
        <section>
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full"
            style={{ background: 'var(--accent-soft)', border: '1px solid rgba(240,138,93,0.18)' }}>
            <span className="size-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
            <span className="mono text-[10.5px] font-medium" style={{ color: 'var(--accent)', letterSpacing: '0.02em' }}>
              v0.4.0 · faster index, cross-crate jump
            </span>
          </div>
          <h1 className="font-display mt-5 tracking-tight"
              style={{ fontSize: 56, lineHeight: 1.04, color: 'var(--ink)', letterSpacing: '-0.025em', fontWeight: 500, maxWidth: 760 }}>
            A faster, friendlier<br/>
            <span style={{ color: 'var(--accent)', fontStyle: 'italic' }}>rustdoc</span> for the web.
          </h1>
          <p className="mt-4 text-[14px] leading-relaxed max-w-[560px]" style={{ color: 'var(--muted)' }}>
            Browse every public item, jump between crates, and see how types relate — without the page reload.
          </p>

          {/* Search */}
          <div className="mt-7 max-w-[640px]">
            <div className="relative"
                 style={{ background: 'var(--panel-solid)', border: '1px solid var(--panel-border-strong)', borderRadius: 'var(--radius-control)' }}>
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }}>
                <Icon.search size={15} />
              </span>
              <input
                placeholder="serde::Deserialize"
                defaultValue=""
                className="w-full bg-transparent outline-none mono text-[13.5px] py-3 pl-10 pr-28"
                style={{ color: 'var(--ink)' }}
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
                <span className="kbd">⌘</span><span className="kbd">K</span>
              </div>
            </div>
            <div className="mt-2.5 flex items-center gap-2 text-[11px]" style={{ color: 'var(--muted-soft)' }}>
              <span>Examples</span>
              {['tokio::spawn', 'Vec<T>', 'axum::Router', 'std::sync::Arc'].map(t => (
                <a key={t} className="mono px-1.5 py-0.5 rounded hover:text-[color:var(--accent)]"
                   style={{ background: 'var(--panel-muted)' }}>{t}</a>
              ))}
            </div>
          </div>
        </section>

        {/* WORKSPACE */}
        <section className="mt-10">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="size-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
              <span className="mono text-[10.5px] font-semibold uppercase tracking-[0.18em]" style={{ color: 'var(--ink-soft)' }}>workspace</span>
              <span className="mono text-[11px]" style={{ color: 'var(--muted-soft)' }}>drizzle · {WORKSPACE.length}</span>
            </div>
            <a className="mono text-[11px]" style={{ color: 'var(--muted)' }}>configure →</a>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {WORKSPACE.map(n => (
              <a key={n}
                 className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md"
                 style={{ background: 'var(--panel)', border: '1px solid var(--panel-border)' }}>
                <KindBadge kind="crate" size={12} />
                <span className="mono text-[12.5px] font-medium" style={{ color: 'var(--ink)' }}>{n}</span>
                <span className="mono text-[10.5px]" style={{ color: 'var(--muted-soft)' }}>0.1.4</span>
              </a>
            ))}
          </div>
        </section>

        {/* TWO COLUMNS: trending + recent */}
        <section className="mt-10 grid grid-cols-[1.4fr_1fr] gap-8">
          {/* Trending */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-display text-[18px] font-semibold" style={{ color: 'var(--ink)' }}>Trending this week</h2>
              <a className="mono text-[11px]" style={{ color: 'var(--muted)' }}>top 100 →</a>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {POPULAR.map(c => <CrateCard key={c.name} c={c} />)}
            </div>
          </div>
          {/* Recent */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-display text-[18px] font-semibold" style={{ color: 'var(--ink)' }}>Recent releases</h2>
              <a className="mono text-[11px]" style={{ color: 'var(--muted)' }}>feed →</a>
            </div>
            <ol style={{ background: 'var(--panel)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-card)' }}>
              {RECENT.map((r, i) => (
                <li key={r.name}
                    className="row-hover flex items-center gap-3 px-3.5 py-2.5"
                    style={{ borderTop: i === 0 ? 'none' : '1px solid var(--panel-border-soft)' }}>
                  <KindBadge kind="crate" size={14} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="mono text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>{r.name}</span>
                      <span className="mono text-[10.5px]" style={{ color: 'var(--muted-soft)' }}>{r.version}</span>
                    </div>
                    <p className="text-[11.5px] truncate" style={{ color: 'var(--muted)' }}>{r.desc}</p>
                  </div>
                  <span className="mono text-[10.5px] whitespace-nowrap" style={{ color: 'var(--muted-soft)' }}>{r.when}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </main>
    </div>
  );
}

window.HomeMain = HomeMain;

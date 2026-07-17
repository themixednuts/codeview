/* eslint-disable */
/* Home B — "Library Index"
   Two-pane layout: categories left, curated lists right.
   Denser, more reference-document-like. Built for people who already know
   roughly what they want.
*/

const CATEGORIES = [
  { label: 'Asynchronous',      count: 4_211, icon: '◐' },
  { label: 'Web programming',   count: 8_374, icon: '◇' },
  { label: 'Database',          count: 2_186, icon: '▤' },
  { label: 'Serialization',     count: 1_402, icon: '⌘' },
  { label: 'Command-line',      count: 5_018, icon: '›_' },
  { label: 'Cryptography',      count: 1_173, icon: '⚿' },
  { label: 'Concurrency',       count:   886, icon: '▦' },
  { label: 'Game development',  count: 1_524, icon: '◈' },
  { label: 'Networking',        count: 3_902, icon: '◯' },
  { label: 'Embedded',          count: 2_661, icon: '▣' },
  { label: 'Parser implementations', count: 1_018, icon: '〈〉' },
  { label: 'Filesystem',        count:   742, icon: '▥' },
];

const RUST_RELEASE = { channel: 'stable', version: '1.86.0', date: 'May 2 2026' };

const NEW_CRATES = [
  { name: 'rusqlite_router', version: '0.1.0', desc: 'Ergonomic routing of SQLite queries by tenant' },
  { name: 'aria_chat',       version: '0.3.2', desc: 'Streaming chat protocol for local-first apps' },
  { name: 'cf_workers_kv',   version: '1.0.0', desc: 'Type-safe Cloudflare KV bindings with caching' },
  { name: 'tachys',          version: '0.1.5', desc: 'Tachyonic view layer; supports any reactive system' },
  { name: 'flo_curves',      version: '0.7.4', desc: 'Bezier curve primitives and intersection' },
];

const RECENTLY_UPDATED = [
  { name: 'tokio',       version: '1.45.1', when: '2h',  delta: '+1.2k' },
  { name: 'serde',       version: '1.0.219', when: '4h', delta: '+842' },
  { name: 'reqwest',     version: '0.12.15', when: '5h', delta: '+418' },
  { name: 'axum',        version: '0.8.4',   when: '6h', delta: '+1.5k' },
  { name: 'clap',        version: '4.5.40',  when: '8h', delta: '+318' },
  { name: 'tracing',     version: '0.1.42',  when: '1d', delta: '+212' },
  { name: 'sqlx',        version: '0.8.6',   when: '1d', delta: '+109' },
  { name: 'tower',       version: '0.5.4',   when: '2d', delta: '+88'  },
];

function HomeLibrary() {
  return (
    <div className="plate flex flex-col" style={{ width: 1280, height: 900 }}>
      <TopBar />

      {/* Slim search row — always-present */}
      <div className="border-b" style={{ borderColor: 'var(--panel-border-soft)' }}>
        <div className="mx-auto max-w-[1180px] px-8 py-4 flex items-center gap-3">
          <div className="relative flex-1 corner-squircle"
               style={{ background: 'var(--panel-solid)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-control)' }}>
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }}>
              <Icon.search size={14} />
            </span>
            <input className="w-full bg-transparent outline-none text-[13px] py-2.5 pl-10 pr-3" placeholder="Search the index — crate, type, function, trait…" />
            <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
              <span className="kbd">⌘</span><span className="kbd">K</span>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--muted)' }}>
            <span>Showing</span>
            <span className="badge badge-sm" style={{ background: 'var(--panel)', color: 'var(--ink)' }}>all crates</span>
            <span>·</span>
            <span className="font-mono">186,402</span>
            <span>indexed</span>
          </div>
        </div>
      </div>

      <main className="mx-auto w-full max-w-[1180px] px-8 py-8 flex-1 overflow-hidden grid grid-cols-[260px_1fr] gap-10">
        {/* LEFT: categories */}
        <aside>
          <h3 className="text-[10.5px] font-semibold tracking-[0.22em] uppercase mb-3" style={{ color: 'var(--ink-soft)' }}>
            Browse
          </h3>
          <ul className="space-y-0.5">
            {CATEGORIES.map((c, i) => (
              <li key={c.label}>
                <a className="group flex items-center gap-3 px-2.5 py-1.5 rounded-md transition"
                   style={{ background: i === 0 ? 'var(--accent-soft)' : 'transparent', color: i === 0 ? 'var(--accent-strong)' : 'var(--ink)' }}>
                  <span className="font-mono text-[12px] w-5 text-center" style={{ color: i === 0 ? 'var(--accent)' : 'var(--muted-soft)' }}>
                    {c.icon}
                  </span>
                  <span className="text-[13px] font-medium flex-1 truncate">{c.label}</span>
                  <span className="font-mono text-[11px] tabular-nums" style={{ color: 'var(--muted-soft)' }}>
                    {c.count.toLocaleString()}
                  </span>
                </a>
              </li>
            ))}
          </ul>

          <div className="mt-7 corner-squircle p-4"
               style={{ background: 'var(--panel)', border: '1px solid var(--panel-border-soft)', borderRadius: 'var(--radius-card)' }}>
            <div className="text-[10.5px] font-semibold tracking-[0.22em] uppercase mb-2" style={{ color: 'var(--ink-soft)' }}>
              Standard library
            </div>
            <a className="font-display font-semibold text-[15px]" style={{ color: 'var(--ink)' }}>
              Rust {RUST_RELEASE.version}
            </a>
            <p className="text-[11px] mt-1" style={{ color: 'var(--muted)' }}>
              Released {RUST_RELEASE.date} · {RUST_RELEASE.channel}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-1 text-[12px] font-mono" style={{ color: 'var(--ink-soft)' }}>
              {['std', 'core', 'alloc', 'test', 'proc_macro', 'std::sync'].map(s =>
                <a key={s} className="px-2 py-1 rounded" style={{ background: 'var(--panel-muted)' }}>{s}</a>
              )}
            </div>
          </div>
        </aside>

        {/* RIGHT: lists */}
        <section className="min-w-0 grid grid-cols-2 gap-10">
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Icon.sparkle size={13} style={{ color: 'var(--accent)' }} />
                <h2 className="font-display text-[18px] font-semibold" style={{ color: 'var(--ink)' }}>New crates</h2>
              </div>
              <a className="text-[11.5px]" style={{ color: 'var(--muted)' }}>last 24h →</a>
            </div>
            <ol className="space-y-0">
              {NEW_CRATES.map((c, i) => (
                <li key={c.name}>
                  <a className="group flex items-baseline gap-3 py-2.5 border-t"
                     style={{ borderColor: i === 0 ? 'transparent' : 'var(--panel-border-soft)' }}>
                    <span className="font-mono text-[10.5px] tabular-nums w-5" style={{ color: 'var(--muted-soft)' }}>
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-[13.5px] font-semibold" style={{ color: 'var(--ink)' }}>{c.name}</span>
                        <span className="font-mono text-[10.5px]" style={{ color: 'var(--muted-soft)' }}>{c.version}</span>
                      </div>
                      <p className="text-[12px] truncate" style={{ color: 'var(--muted)' }}>{c.desc}</p>
                    </div>
                    <Icon.chevronRight size={12} style={{ color: 'var(--muted-soft)' }} />
                  </a>
                </li>
              ))}
            </ol>
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Icon.trending size={13} style={{ color: 'var(--accent)' }} />
                <h2 className="font-display text-[18px] font-semibold" style={{ color: 'var(--ink)' }}>Recently updated</h2>
              </div>
              <a className="text-[11.5px]" style={{ color: 'var(--muted)' }}>feed →</a>
            </div>
            <ol className="space-y-0">
              {RECENTLY_UPDATED.map((r, i) => (
                <li key={r.name}>
                  <a className="group flex items-center gap-3 py-2.5 border-t"
                     style={{ borderColor: i === 0 ? 'transparent' : 'var(--panel-border-soft)' }}>
                    <span className="font-mono text-[11px] w-7 tabular-nums" style={{ color: 'var(--muted-soft)' }}>{r.when}</span>
                    <span className="font-mono text-[13px] font-semibold flex-1" style={{ color: 'var(--ink)' }}>{r.name}</span>
                    <span className="font-mono text-[11px]" style={{ color: 'var(--muted-soft)' }}>{r.version}</span>
                    <span className="font-mono text-[11px] tabular-nums" style={{ color: 'var(--accent-strong)' }}>{r.delta}</span>
                  </a>
                </li>
              ))}
            </ol>
          </div>

          {/* WORKSPACE block — full width below */}
          <div className="col-span-2 mt-2">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Icon.layers size={13} style={{ color: 'var(--accent)' }} />
                <h2 className="font-display text-[18px] font-semibold" style={{ color: 'var(--ink)' }}>Your workspace</h2>
                <span className="font-mono text-[11px]" style={{ color: 'var(--muted-soft)' }}>drizzle · 7 crates</span>
              </div>
              <a className="text-[11.5px]" style={{ color: 'var(--muted)' }}>configure →</a>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {['drizzle','drizzle_core','drizzle_macros','drizzle_postgres','drizzle_sqlite','drizzle_types'].map((n) => (
                <a key={n} className="group corner-squircle px-3 py-2.5 flex items-center gap-2.5"
                   style={{ background: 'var(--panel-solid)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-control)' }}>
                  <KindIcon kind="crate" size={14} />
                  <span className="font-mono text-[13px] font-medium" style={{ color: 'var(--ink)' }}>{n}</span>
                  <span className="ml-auto font-mono text-[10.5px]" style={{ color: 'var(--muted-soft)' }}>0.1.4</span>
                </a>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

window.HomeLibrary = HomeLibrary;

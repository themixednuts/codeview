/* eslint-disable */
/* Home C — "Search-Forward"
   The page IS a command palette. Search is open by default with live
   results. Periphery is quiet. For users who arrive knowing what they want.
*/

const LIVE_RESULTS = {
  crates: [
    { name: 'serde',       version: '1.0.219', desc: 'A generic serialization/deserialization framework', kind: 'crate', highlight: 'ser' },
    { name: 'serde_json',  version: '1.0.140', desc: 'A JSON serialization file format',                  kind: 'crate', highlight: 'ser' },
    { name: 'serde_yaml',  version: '0.9.34', desc: 'YAML data format for Serde',                          kind: 'crate', highlight: 'ser' },
  ],
  items: [
    { path: 'serde::Serialize',          kind: 'trait',  desc: 'A data structure that can be serialized into any data format supported by Serde.' },
    { path: 'serde::Deserialize',        kind: 'trait',  desc: 'A data structure that can be deserialized from any data format supported by Serde.' },
    { path: 'serde::ser::Serializer',    kind: 'trait',  desc: 'A data format that can serialize any data structure supported by Serde.' },
    { path: 'serde_json::to_string',     kind: 'fn',     desc: 'Serialize the given data structure as a String of JSON.' },
    { path: 'serde_json::Value',         kind: 'enum',   desc: 'Represents any valid JSON value.' },
  ],
};

function Hl({ text, q }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span style={{ background: 'var(--accent-soft)', color: 'var(--accent-strong)', borderRadius: 3, padding: '0 1px' }}>
        {text.slice(i, i + q.length)}
      </span>
      {text.slice(i + q.length)}
    </>
  );
}

function HomeSearch() {
  const q = 'ser';
  return (
    <div className="plate flex flex-col" style={{ width: 1280, height: 900 }}>
      <TopBar />
      <main className="mx-auto w-full max-w-[860px] px-6 pt-20 pb-12 flex-1">
        {/* Wordmark */}
        <div className="text-center">
          <h1 className="font-display tracking-tight font-semibold"
              style={{ fontSize: 44, lineHeight: 1, color: 'var(--ink)', letterSpacing: '-0.025em' }}>
            codeview
          </h1>
          <p className="mt-3 text-[13px]" style={{ color: 'var(--muted)' }}>
            Documentation for{' '}
            <span className="font-mono" style={{ color: 'var(--ink-soft)' }}>186,402</span> crates ·{' '}
            <span className="font-mono" style={{ color: 'var(--ink-soft)' }}>4.2M</span> items
          </p>
        </div>

        {/* Big search */}
        <div className="mt-9 relative corner-squircle"
             style={{
               background: 'var(--panel-solid)',
               border: '1px solid var(--accent)',
               borderRadius: 'var(--radius-card)',
               boxShadow: '0 0 0 3px var(--accent-ring), var(--shadow-strong)',
             }}>
          <span className="absolute left-5 top-[22px]" style={{ color: 'var(--accent)' }}>
            <Icon.search size={18} />
          </span>
          <input
            defaultValue="ser"
            className="w-full bg-transparent outline-none font-mono py-5 pl-14 pr-32"
            style={{ color: 'var(--ink)', fontSize: 16 }}
          />
          <div className="absolute right-5 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-[10.5px]" style={{ color: 'var(--muted)' }}>
            <span className="kbd">↑</span><span className="kbd">↓</span>
            <span>to navigate</span>
            <span className="kbd">↵</span>
            <span>open</span>
          </div>

          {/* Results */}
          <div className="border-t" style={{ borderColor: 'var(--panel-border-soft)' }}>
            {/* Section: crates */}
            <div className="px-5 py-2 flex items-center gap-2 text-[10.5px] font-semibold tracking-[0.22em] uppercase" style={{ color: 'var(--muted-soft)' }}>
              <span>Crates</span>
              <span className="font-mono normal-case tracking-normal">{LIVE_RESULTS.crates.length} matches</span>
            </div>
            {LIVE_RESULTS.crates.map((c, i) => (
              <a key={c.name}
                 className="flex items-center gap-3 px-5 py-2.5"
                 style={{
                   background: i === 0 ? 'var(--accent-soft)' : 'transparent',
                   borderLeft: i === 0 ? '2px solid var(--accent)' : '2px solid transparent',
                 }}>
                <KindIcon kind="crate" size={16} />
                <span className="font-mono text-[14px] font-semibold w-[150px]" style={{ color: 'var(--ink)' }}>
                  <Hl text={c.name} q={q} />
                </span>
                <span className="font-mono text-[11px]" style={{ color: 'var(--muted-soft)' }}>{c.version}</span>
                <span className="text-[12.5px] truncate flex-1" style={{ color: 'var(--muted)' }}>{c.desc}</span>
                {i === 0 && (
                  <span className="text-[10.5px] font-mono inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
                        style={{ background: 'var(--panel-solid)', color: 'var(--accent-strong)', border: '1px solid var(--panel-border)' }}>
                    <span className="kbd" style={{ height: 16, fontSize: 9 }}>↵</span>
                  </span>
                )}
              </a>
            ))}

            <div className="px-5 py-2 mt-1 flex items-center gap-2 text-[10.5px] font-semibold tracking-[0.22em] uppercase" style={{ color: 'var(--muted-soft)' }}>
              <span>Items</span>
              <span className="font-mono normal-case tracking-normal">{LIVE_RESULTS.items.length} matches</span>
            </div>
            {LIVE_RESULTS.items.map((it) => {
              const [crate, ...rest] = it.path.split('::');
              const tail = rest.pop();
              const mid = rest.join('::');
              return (
                <a key={it.path}
                   className="flex items-center gap-3 px-5 py-2.5"
                   style={{ borderLeft: '2px solid transparent' }}>
                  <KindIcon kind={it.kind === 'fn' ? 'fn' : it.kind} size={16} />
                  <span className="font-mono text-[13.5px] flex items-baseline">
                    <span style={{ color: 'var(--muted)' }}>{crate}{mid ? '::' : ''}</span>
                    {mid && <span style={{ color: 'var(--muted)' }}>{mid}::</span>}
                    <span style={{ color: 'var(--ink)', fontWeight: 600 }}><Hl text={tail} q={q} /></span>
                  </span>
                  <span className="text-[12.5px] truncate flex-1" style={{ color: 'var(--muted)' }}>{it.desc}</span>
                  <span className="badge badge-sm" style={{ background: 'var(--panel)', color: 'var(--muted)' }}>{it.kind}</span>
                </a>
              );
            })}
          </div>
        </div>

        {/* Footer rows */}
        <div className="mt-10 grid grid-cols-3 gap-6 text-[12px]">
          <div>
            <div className="text-[10.5px] font-semibold tracking-[0.22em] uppercase mb-2" style={{ color: 'var(--ink-soft)' }}>Workspace</div>
            <div className="flex flex-wrap gap-1">
              {['drizzle','drizzle_core','drizzle_macros','drizzle_postgres','drizzle_sqlite','drizzle_types'].map(n => (
                <a key={n} className="font-mono px-2 py-1 rounded-md text-[11.5px]"
                   style={{ background: 'var(--panel)', color: 'var(--ink)', border: '1px solid var(--panel-border-soft)' }}>
                  {n}
                </a>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[10.5px] font-semibold tracking-[0.22em] uppercase mb-2" style={{ color: 'var(--ink-soft)' }}>Recent</div>
            <ul className="space-y-1">
              {[
                ['serde_json::Value', '#enum'],
                ['tokio::spawn',      '#fn'],
                ['axum::Router',      '#struct'],
                ['Vec::push',         '#method'],
              ].map(([p, k]) => (
                <li key={p} className="flex items-center justify-between font-mono">
                  <a style={{ color: 'var(--ink)' }} className="text-[11.5px]">{p}</a>
                  <span className="text-[10.5px]" style={{ color: 'var(--muted-soft)' }}>{k}</span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div className="text-[10.5px] font-semibold tracking-[0.22em] uppercase mb-2" style={{ color: 'var(--ink-soft)' }}>Trending</div>
            <ul className="space-y-1">
              {[
                ['tokio',  '+1.2k'],
                ['axum',   '+1.5k'],
                ['serde',  '+842'],
                ['reqwest','+418'],
              ].map(([n, d]) => (
                <li key={n} className="flex items-center justify-between font-mono text-[11.5px]">
                  <span style={{ color: 'var(--ink)' }}>{n}</span>
                  <span style={{ color: 'var(--accent-strong)' }}>{d}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </main>
    </div>
  );
}

window.HomeSearch = HomeSearch;

/* eslint-disable */
/* Explorer — the full Codeview flow: how you MOVE between linked items.

   Everything is bound to ONE focus. Four surfaces stay in sync:
     · the module tree (left)      — click any row to focus it
     · the relationship graph      — hover to peek, click to focus
     · the breadcrumb + back/fwd   — real navigation history
     · the detail panel (right)    — every relationship is a link; HOVER a
       relationship to spotlight it in the graph, CLICK to jump there.

   This two-way binding (panel ⇄ graph) is the answer to "improve the flow
   between links / crates": you can always preview where a link goes before
   you commit, and you never lose your trail.
*/

/* Full module tree for drizzle_core + its dependent crates. */
const EX_TREE = [
  { id: 'drizzle_core', depth: 0 },
  { id: 'ast', depth: 1 },
  { id: 'parser', depth: 1 },
  { id: 'traits', depth: 1, group: true },
  { id: 'Executable', depth: 2 },
  { id: 'execute', depth: 3 },
  { id: 'execute_one', depth: 3 },
  { id: 'QueryExt', depth: 2 },
  { id: 'IntoQuery', depth: 2 },
  { id: 'types', depth: 1, group: true },
  { id: 'Query', depth: 2 },
  { id: 'Select', depth: 2 },
  { id: 'Insert', depth: 2 },
  { id: 'Param', depth: 2 },
  { id: 'OrderByClause', depth: 2 },
  { id: 'WhereExpr', depth: 2 },
];
const EX_DEPS = ['drizzle', 'drizzle_cli', 'drizzle_postgres', 'drizzle_sqlite'];

const KIND_LABEL = {
  crate: 'Crate', module: 'Module', trait: 'Trait', struct: 'Struct',
  enum: 'Enum', fn: 'Function', method: 'Method', type: 'Type alias',
};

function pathSegments(path) {
  const parts = path.split('::');
  const segs = [];
  for (let i = 0; i < parts.length; i++) {
    const full = parts.slice(0, i + 1).join('::');
    let id = null;
    for (const k in window.NODES) if (window.NODES[k].path === full) { id = k; break; }
    segs.push({ label: parts[i], id });
  }
  return segs;
}

function ExTreeRow({ id, depth, active, ancestor, onClick }) {
  const n = window.nodeOf(id);
  return (
    <button onClick={onClick}
      className="group w-full flex items-center gap-2 pr-2 py-[3px] rounded-md transition-colors text-left relative"
      style={{
        paddingLeft: 10 + depth * 14,
        background: active ? 'var(--accent-soft)' : 'transparent',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--panel-muted)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {depth > 0 && (
        <span className="absolute top-0 bottom-0" style={{ left: 4 + depth * 14 - 8, width: 1, background: active ? 'var(--accent)' : 'var(--panel-border-soft)' }} />
      )}
      <window.KindBadge kind={n.kind} size={14} />
      <span className="mono text-[12px] flex-1 truncate" style={{
        color: active ? 'var(--accent-strong)' : (ancestor ? 'var(--ink)' : 'var(--ink-soft)'),
        fontWeight: active ? 700 : (ancestor ? 600 : 500),
      }}>{id}</span>
    </button>
  );
}

function RelRow({ node, color, onClick, onEnter, onLeave, active }) {
  return (
    <button onClick={onClick} onMouseEnter={onEnter} onMouseLeave={onLeave}
      className="w-full flex items-center gap-2 pl-1.5 pr-2 py-[5px] rounded-md text-left transition-colors"
      style={{ background: active ? 'var(--panel-muted)' : 'transparent' }}
    >
      <span className="self-stretch rounded-full shrink-0" style={{ width: 3, background: color }} />
      <window.KindBadge kind={node.kind} size={15} />
      <span className="mono text-[12.5px] flex-1 truncate" style={{ color: 'var(--ink)', fontWeight: 500 }}>{node.id}</span>
      <span className="mono text-[10px]" style={{ color: 'var(--muted-soft)' }}>{node.kind}</span>
      <window.Icon.arrowRight size={11} style={{ color: active ? color : 'var(--muted-soft)', transition: 'color .12s' }} />
    </button>
  );
}

function RelGroup({ group, onFocus, onHover, hoverId }) {
  return (
    <div className="mt-3 first:mt-0">
      <div className="flex items-center gap-2 px-1.5 mb-1">
        <span className="mono text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: group.color }}>
          {group.verb}
        </span>
        <span className="mono text-[10px]" style={{ color: 'var(--muted-soft)' }}>{group.items.length}</span>
        <span className="flex-1 h-px" style={{ background: 'var(--panel-border-soft)' }} />
      </div>
      <div className="space-y-px">
        {group.items.map(n => (
          <RelRow key={n.id} node={n} color={group.color} active={hoverId === n.id}
            onClick={() => onFocus(n.id)}
            onEnter={() => onHover(n.id)} onLeave={() => onHover(null)} />
        ))}
      </div>
    </div>
  );
}

/* Docs preview pane — what "Docs" mode shows in the center. */
function DocPane({ focus, onFocus }) {
  const node = window.nodeOf(focus);
  const model = window.focusModel(focus);
  const contains = [...(model.out.find(g => g.rel === 'contains')?.items || [])];
  const impls = model.out.find(g => g.rel === 'implements')?.items || [];
  const implBy = model.in.find(g => g.rel === 'implements')?.items || [];
  const defines = model.out.find(g => g.rel === 'defines')?.items || [];
  const Section = ({ title, items, verb }) => items.length ? (
    <div className="mt-7">
      <div className="flex items-baseline gap-2 mb-3 pb-1.5 border-b" style={{ borderColor: 'var(--panel-border-soft)' }}>
        <h3 className="font-display text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>{title}</h3>
        <span className="mono text-[10.5px]" style={{ color: 'var(--muted-soft)' }}>{items.length}</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {items.map(n => (
          <button key={n.id} onClick={() => onFocus(n.id)}
            className="flex items-start gap-2 p-2 rounded-lg text-left transition-colors"
            style={{ border: '1px solid var(--panel-border-soft)', background: 'var(--panel-solid)' }}
            onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--panel-border-strong)'}
            onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--panel-border-soft)'}>
            <window.KindBadge kind={n.kind} size={15} />
            <span className="min-w-0">
              <span className="mono text-[12px] font-semibold block truncate ulink" style={{ color: 'var(--link)' }}>{n.id}</span>
              {n.blurb && <span className="text-[11px] block leading-snug mt-0.5" style={{ color: 'var(--muted)' }}>{n.blurb}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  ) : null;

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--bg)' }}>
      <div className="max-w-[720px] mx-auto px-10 py-9">
        <div className="flex items-center gap-2 mb-3">
          <span className="mono text-[10px] font-semibold uppercase tracking-[0.14em] px-1.5 py-0.5 rounded"
                style={{ background: 'var(--accent-soft)', color: 'var(--accent-strong)' }}>{KIND_LABEL[node.kind] || node.kind}</span>
          {node.version && <span className="mono text-[10.5px]" style={{ color: 'var(--muted-soft)' }}>v{node.version}</span>}
        </div>
        <h1 className="font-display font-semibold tracking-tight" style={{ color: 'var(--ink)', fontSize: 40, lineHeight: 1 }}>{node.id}</h1>
        <div className="mono text-[12px] mt-3" style={{ color: 'var(--muted-soft)' }}>{node.path}</div>
        {node.sig && <div className="mt-5"><window.Signature src={node.sig} /></div>}
        {node.blurb && <p className="text-[15px] leading-relaxed mt-5" style={{ color: 'var(--muted)' }}>{node.blurb}</p>}
        <Section title="Modules & members" items={contains} />
        <Section title="Defines" items={defines} />
        <Section title="Implements" items={impls} />
        <Section title="Implementors" items={implBy} />
      </div>
    </div>
  );
}

function Explorer() {
  const [stack, setStack] = React.useState(['drizzle_core']);
  const [ptr, setPtr] = React.useState(0);
  const [mode, setMode] = React.useState('graph'); // 'graph' | 'docs'
  const [spotlight, setSpotlight] = React.useState(null);
  const focus = stack[ptr];
  const node = window.nodeOf(focus);
  const model = window.focusModel(focus);
  const counts = window.relCounts(focus);

  const go = (id) => {
    if (id === focus) return;
    setSpotlight(null);
    setStack(s => { const ns = s.slice(0, ptr + 1); ns.push(id); return ns; });
    setPtr(p => p + 1);
  };
  const back = () => setPtr(p => Math.max(0, p - 1));
  const fwd = () => setPtr(p => Math.min(stack.length - 1, p + 1));
  const canBack = ptr > 0, canFwd = ptr < stack.length - 1;

  const segs = pathSegments(node.path);
  const ancestorIds = new Set(segs.slice(0, -1).map(s => s.id).filter(Boolean));

  const onKey = (e) => {
    if (e.key === '[' || (e.altKey && e.key === 'ArrowLeft')) { e.preventDefault(); back(); }
    if (e.key === ']' || (e.altKey && e.key === 'ArrowRight')) { e.preventDefault(); fwd(); }
  };

  const navBtn = (dir, enabled, onClick) => (
    <button onClick={onClick} disabled={!enabled}
      className="size-7 grid place-items-center rounded-md shrink-0"
      style={{
        border: '1px solid var(--panel-border)', background: 'var(--panel-solid)',
        color: enabled ? 'var(--ink-soft)' : 'var(--muted-soft)', opacity: enabled ? 1 : 0.45,
        cursor: enabled ? 'pointer' : 'default',
      }}>
      <window.Icon.chevronRight size={14} style={{ transform: dir === 'back' ? 'rotate(180deg)' : 'none' }} />
    </button>
  );

  return (
    <div className="plate flex flex-col outline-none" tabIndex={0} onKeyDown={onKey} style={{ width: 1440, height: 920, overflow: 'hidden' }}>
      <window.TopBar />

      {/* Nav / breadcrumb bar */}
      <div className="flex items-center gap-3 px-5 h-12 border-b" style={{ borderColor: 'var(--panel-border-soft)', background: 'var(--panel)' }}>
        <div className="flex items-center gap-1.5">
          {navBtn('back', canBack, back)}
          {navBtn('fwd', canFwd, fwd)}
        </div>
        <div className="flex items-center gap-1 min-w-0">
          <window.KindBadge kind={node.kind} size={16} />
          <nav className="flex items-baseline flex-wrap gap-1 mono text-[13px] ml-1">
            {segs.map((s, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span style={{ color: 'var(--muted-soft)' }}>::</span>}
                <button onClick={() => s.id && go(s.id)}
                  disabled={!s.id || i === segs.length - 1}
                  style={{
                    color: i === segs.length - 1 ? 'var(--ink)' : (s.id ? 'var(--link)' : 'var(--muted)'),
                    fontWeight: i === segs.length - 1 ? 700 : 500,
                    textDecoration: (s.id && i < segs.length - 1) ? 'underline' : 'none',
                    textDecorationColor: 'var(--panel-border-strong)', textUnderlineOffset: '2px',
                    cursor: (s.id && i < segs.length - 1) ? 'pointer' : 'default',
                  }}>{s.label}</button>
              </React.Fragment>
            ))}
          </nav>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="mono text-[11px]" style={{ color: 'var(--muted-soft)' }}>{counts.total} relationships</span>
          <div className="flex items-center rounded-md p-0.5 text-[11.5px]" style={{ background: 'var(--panel-muted)', border: '1px solid var(--panel-border-soft)' }}>
            <button onClick={() => setMode('graph')} className="px-2.5 py-0.5 rounded flex items-center gap-1 transition-colors"
              style={{ background: mode === 'graph' ? 'var(--panel-solid)' : 'transparent', color: mode === 'graph' ? 'var(--ink)' : 'var(--muted)', boxShadow: mode === 'graph' ? 'var(--shadow-soft)' : 'none' }}>
              <window.Icon.link size={11} /> Graph
            </button>
            <button onClick={() => setMode('docs')} className="px-2.5 py-0.5 rounded flex items-center gap-1 transition-colors"
              style={{ background: mode === 'docs' ? 'var(--panel-solid)' : 'transparent', color: mode === 'docs' ? 'var(--ink)' : 'var(--muted)', boxShadow: mode === 'docs' ? 'var(--shadow-soft)' : 'none' }}>
              <window.Icon.hash size={11} /> Docs
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 grid" style={{ gridTemplateColumns: '260px 1fr 344px', overflow: 'hidden' }}>
        {/* Tree */}
        <aside className="border-r flex flex-col overflow-hidden" style={{ borderColor: 'var(--panel-border-soft)', background: 'var(--panel)' }}>
          <div className="px-4 pt-4 pb-2">
            <div className="text-[10px] font-semibold tracking-[0.22em] uppercase mb-1" style={{ color: 'var(--muted-soft)' }}>Module tree</div>
            <div className="font-display font-semibold text-[15px]" style={{ color: 'var(--ink)' }}>drizzle_core</div>
            <div className="mono text-[10.5px] mt-0.5" style={{ color: 'var(--muted-soft)' }}>v0.1.4 · 318 items</div>
            <div className="relative mt-3">
              <input className="w-full bg-transparent outline-none mono text-[11.5px] py-1.5 pl-7 pr-2 rounded-md border"
                     style={{ borderColor: 'var(--panel-border)', background: 'var(--panel-solid)', color: 'var(--ink)' }}
                     placeholder="Filter items…" />
              <span className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted-soft)' }}><window.Icon.search size={12} /></span>
            </div>
          </div>
          <div className="px-2.5 pb-4 overflow-y-auto space-y-px">
            {EX_TREE.map(t => (
              <ExTreeRow key={t.id} id={t.id} depth={t.depth} active={t.id === focus} ancestor={ancestorIds.has(t.id)} onClick={() => go(t.id)} />
            ))}
            <div className="flex items-center gap-2 px-2.5 pt-4 pb-1">
              <span className="text-[9.5px] font-semibold tracking-[0.18em] uppercase" style={{ color: 'var(--muted-soft)' }}>Dependent crates</span>
              <span className="flex-1 h-px" style={{ background: 'var(--panel-border-soft)' }} />
            </div>
            {EX_DEPS.map(id => (
              <ExTreeRow key={id} id={id} depth={0} active={id === focus} ancestor={false} onClick={() => go(id)} />
            ))}
          </div>
        </aside>

        {/* Center — graph or docs */}
        <section className="relative overflow-hidden" style={{ background: 'var(--bg)' }}>
          {mode === 'graph'
            ? <window.FocusGraphView focus={focus} onFocus={go} width={836} height={812} spotlight={spotlight} />
            : <DocPane focus={focus} onFocus={go} />}
        </section>

        {/* Detail */}
        <aside className="border-l flex flex-col overflow-hidden" style={{ borderColor: 'var(--panel-border-soft)', background: 'var(--panel)' }}>
          <div className="px-5 pt-5 pb-4 border-b" style={{ borderColor: 'var(--panel-border-soft)' }}>
            <div className="flex items-center gap-2 mb-2">
              <span className="mono text-[10px] font-semibold uppercase tracking-[0.14em] px-1.5 py-0.5 rounded"
                    style={{ background: 'var(--accent-soft)', color: 'var(--accent-strong)' }}>{KIND_LABEL[node.kind] || node.kind}</span>
              {node.external && <span className="mono text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--panel-muted)', color: 'var(--muted)' }}>external</span>}
              {node.version && <span className="mono text-[10.5px]" style={{ color: 'var(--muted-soft)' }}>v{node.version}</span>}
            </div>
            <h2 className="font-display font-semibold text-[26px] leading-none tracking-tight" style={{ color: 'var(--ink)' }}>{node.id}</h2>
            <div className="mono text-[11px] mt-2" style={{ color: 'var(--muted-soft)' }}>{node.path}</div>
            {node.blurb && <p className="text-[13px] leading-relaxed mt-3" style={{ color: 'var(--muted)' }}>{node.blurb}</p>}
            {node.sig && (
              <div className="mt-3"><window.Signature src={node.sig} /></div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-3.5 py-4">
            <div className="flex items-center justify-between px-1.5 mb-2">
              <span className="text-[11px] font-semibold tracking-[0.16em] uppercase" style={{ color: 'var(--muted-soft)' }}>Relationships</span>
              <span className="mono text-[10.5px]" style={{ color: 'var(--muted-soft)' }}>{counts.outN} out · {counts.inN} in</span>
            </div>
            {model.out.map(g => <RelGroup key={'o' + g.rel} group={g} onFocus={go} onHover={setSpotlight} hoverId={spotlight} />)}
            {model.in.map(g => <RelGroup key={'i' + g.rel} group={g} onFocus={go} onHover={setSpotlight} hoverId={spotlight} />)}
            {counts.total === 0 && (
              <div className="mono text-[12px] px-1.5 py-4" style={{ color: 'var(--muted-soft)' }}>No relationships recorded.</div>
            )}
          </div>

          <div className="px-5 py-3 border-t flex items-center gap-2" style={{ borderColor: 'var(--panel-border-soft)' }}>
            <button onClick={() => setMode('docs')} className="flex-1 text-[12px] py-1.5 rounded-md font-medium flex items-center justify-center gap-1.5"
                    style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
              Open docs <window.Icon.arrowRight size={11} />
            </button>
            <button className="text-[12px] px-3 py-1.5 rounded-md flex items-center gap-1.5"
                    style={{ background: 'var(--panel-solid)', border: '1px solid var(--panel-border)', color: 'var(--ink-soft)' }}>
              <window.Icon.github size={13} /> Source
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

window.Explorer = Explorer;

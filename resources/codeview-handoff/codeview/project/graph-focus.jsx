/* eslint-disable */
/* THE relationship chart for Codeview — "Focus graph".

   Why this one wins (see the annotation card on the canvas):
     · A node-link graph answers the real question — "what is this item and
       what connects to it" — with an unambiguous, single-axis reading:
       everything flows LEFT → RIGHT. Things on the LEFT point INTO the focus
       (incoming); the focus points to things on the RIGHT (outgoing).
       Constellation loses relationship TYPE; banded loses DIRECTION.
     · The classic failure mode is spaghetti. We fix it with edge BUNDLING:
       every relationship type collapses to ONE labelled trunk that fans to
       its members — N edges become one legible lane.
     · It is navigable. Hover a node to PEEK (what it is + how connected);
       click to make it the focus. That is the core Codeview loop, so the
       chart is also the primary way you move between linked items.

   The same component is the standalone artboard AND the center pane of the
   Explorer, so it adapts to whatever width/height it is handed.
*/

function measurePill(node, isFocus) {
  const label = node.id || node.label || '';
  if (isFocus) return Math.max(160, 52 + label.length * 9.2 + 44);
  return Math.max(98, 24 + 16 + 8 + label.length * 7.4);
}

function layoutSide(groups, cy, ROW, GAP) {
  let total = 0;
  groups.forEach((g, i) => { total += g.items.length * ROW; if (i) total += GAP; });
  let y = cy - total / 2 + ROW / 2;
  groups.forEach((g) => {
    const ys = [];
    g.items.forEach((it) => { it._y = y; ys.push(y); y += ROW; });
    g.hubY = ys.reduce((a, b) => a + b, 0) / ys.length;
    y += GAP;
  });
}

function GraphNodePill({ node, left, top, w, color, isFocus, dim, active, onClick, onEnter, onLeave }) {
  return (
    <button
      onClick={onClick}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="absolute flex items-center gap-2 rounded-lg transition-all"
      style={{
        left, top, width: w, height: isFocus ? 48 : 32,
        padding: isFocus ? '0 18px' : '0 11px',
        background: isFocus ? 'var(--accent)' : 'var(--panel-solid)',
        border: isFocus ? '1px solid var(--accent)'
          : `1px solid ${active ? color : 'var(--panel-border)'}`,
        boxShadow: isFocus
          ? '0 8px 22px var(--accent-ring)'
          : (active ? `0 4px 14px color-mix(in srgb, ${color} 30%, transparent)` : 'var(--shadow-soft)'),
        opacity: dim ? 0.28 : 1,
        cursor: isFocus ? 'default' : 'pointer',
        transform: active && !isFocus ? 'translateY(-1px)' : 'none',
        zIndex: active ? 5 : 1,
      }}
    >
      <window.KindBadge kind={node.kind} size={isFocus ? 20 : 16} />
      <span className="text-left leading-none truncate" style={{
        fontSize: isFocus ? 15.5 : 12,
        fontWeight: isFocus ? 700 : 600,
        color: isFocus ? 'var(--on-accent)' : 'var(--ink)',
        fontFamily: isFocus ? 'var(--font-display)' : 'var(--font-code)',
        letterSpacing: isFocus ? '-0.01em' : 0,
      }}>{node.id}</span>
      {isFocus && (
        <span className="mono uppercase tracking-wider ml-auto" style={{ fontSize: 9.5, color: 'var(--on-accent)', opacity: 0.72 }}>
          {node.kind}
        </span>
      )}
    </button>
  );
}

/* Hover peek — a tiny preview of the node you're about to jump to. */
function PeekCard({ peek, width }) {
  if (!peek) return null;
  const n = window.nodeOf(peek.id);
  const c = window.relCounts(peek.id);
  const CARD_W = 236, CARD_H = 96;
  let left = peek.side === 'in' ? peek.x : peek.x - CARD_W;
  left = Math.max(8, Math.min(width - CARD_W - 8, left));
  const top = Math.max(46, peek.y - CARD_H - 14);
  return (
    <div className="absolute rounded-xl p-3 pointer-events-none animate-[fadeIn_.12s_ease]"
      style={{
        left, top, width: CARD_W,
        background: 'var(--panel-solid)', border: '1px solid var(--panel-border)',
        boxShadow: 'var(--shadow-glow)', zIndex: 40,
      }}>
      <div className="flex items-center gap-2 mb-1.5">
        <window.KindBadge kind={n.kind} size={16} />
        <span className="mono text-[13px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{n.id}</span>
        <span className="mono text-[9.5px] uppercase tracking-wider ml-auto px-1.5 py-0.5 rounded"
          style={{ background: 'var(--panel-muted)', color: 'var(--muted)' }}>{n.kind}</span>
      </div>
      <div className="mono text-[10px] truncate mb-2" style={{ color: 'var(--muted-soft)' }}>{n.path}</div>
      <div className="flex items-center gap-3 text-[10.5px]" style={{ color: 'var(--muted)' }}>
        <span className="inline-flex items-center gap-1"><b style={{ color: 'var(--ink-soft)' }}>{c.inN}</b> incoming</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span className="inline-flex items-center gap-1"><b style={{ color: 'var(--ink-soft)' }}>{c.outN}</b> outgoing</span>
        <span className="ml-auto inline-flex items-center gap-1 mono" style={{ color: 'var(--accent-strong)' }}>
          focus <window.Icon.arrowRight size={10} />
        </span>
      </div>
    </div>
  );
}

function FocusGraphView({ focus, onFocus, width = 1180, height = 660, spotlight = null }) {
  const [hoverRel, setHoverRel] = React.useState(null);
  const [hoverNodeState, setHoverNode] = React.useState(null);
  const [peekState, setPeek] = React.useState(null);
  const model = window.focusModel(focus);
  const focusNode = model.node;

  React.useEffect(() => { setPeek(null); setHoverNode(null); }, [focus]);

  // A spotlight driven from outside (e.g. hovering a relationship row in the
  // Explorer detail panel) behaves like a hover on that node.
  const hoverNode = hoverNodeState || spotlight;

  // Measure
  const FW = measurePill(focusNode, true);
  const maxOut = Math.max(0, ...model.out.flatMap(g => g.items.map(n => measurePill(n))));
  const maxIn = Math.max(0, ...model.in.flatMap(g => g.items.map(n => measurePill(n))));

  const M = 30;
  const TOP = 40;
  const RIGHT_X = model.out.length ? width - M - maxOut : width - M;   // out pill LEFT edge
  const LEFT_X = model.in.length ? M + maxIn : M;                       // in pill RIGHT edge
  const cx = (LEFT_X + RIGHT_X) / 2;
  const cy = (height + TOP) / 2;
  const hubOutX = cx + (RIGHT_X - cx) * 0.42;
  const hubInX = cx - (cx - LEFT_X) * 0.42;

  // Vertical fit
  const rowsSide = (gs) => gs.reduce((s, g) => s + g.items.length, 0) + Math.max(0, gs.length - 1) * 0.6;
  const maxRows = Math.max(rowsSide(model.out), rowsSide(model.in), 1);
  const avail = height - TOP - 54;
  const ROW = Math.min(44, Math.max(30, avail / maxRows));
  const GAP = ROW * 0.6;
  layoutSide(model.out, cy, ROW, GAP);
  layoutSide(model.in, cy, ROW, GAP);

  const focusRightEdge = cx + FW / 2, focusLeftEdge = cx - FW / 2;

  const anyHover = hoverRel != null || hoverNode != null;
  const peek = peekState;
  const isDim = (rel, id) => {
    if (!anyHover) return false;
    if (hoverNode) return id !== hoverNode;
    return rel !== hoverRel;
  };
  const laneDim = (g) => anyHover && (hoverNode ? !g.items.some(n => n.id === hoverNode) : hoverRel !== g.rel);

  const branch = (x0, y0, x1, y1) => {
    const mx = (x0 + x1) / 2;
    return `M ${x0} ${y0} C ${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`;
  };

  const activeRels = window.REL_ORDER.filter(r => model.out.some(g => g.rel === r) || model.in.some(g => g.rel === r));

  const enterNode = (n, side) => {
    setHoverNode(n.id);
    const w = measurePill(n);
    setPeek({ id: n.id, side, x: side === 'in' ? (LEFT_X - w) : RIGHT_X, y: n._y - 16 });
  };
  const leaveNode = () => { setHoverNode(null); setPeek(null); };

  // Derive a peek from an external spotlight when there's no local hover.
  let effPeek = peek;
  if (!effPeek && spotlight) {
    for (const g of model.in) for (const n of g.items) if (n.id === spotlight) { const w = measurePill(n); effPeek = { id: n.id, side: 'in', x: LEFT_X - w, y: n._y - 16 }; }
    for (const g of model.out) for (const n of g.items) if (n.id === spotlight) { effPeek = { id: n.id, side: 'out', x: RIGHT_X, y: n._y - 16 }; }
  }

  return (
    <div className="relative" style={{ width, height, overflow: 'hidden' }}>
      <svg width={width} height={height} className="absolute inset-0" style={{ pointerEvents: 'none' }}>
        <defs>
          <pattern id="fg-dots" width="26" height="26" patternUnits="userSpaceOnUse">
            <circle cx="13" cy="13" r="1" fill="var(--panel-border-soft)" />
          </pattern>
          <linearGradient id="fg-axis" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--panel-border-soft)" stopOpacity="0" />
            <stop offset="0.5" stopColor="var(--panel-border)" stopOpacity="0.5" />
            <stop offset="1" stopColor="var(--panel-border-soft)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <rect x="0" y={TOP} width={width} height={height - TOP} fill="url(#fg-dots)" />
        {/* subtle center axis */}
        <line x1={M} y1={cy} x2={width - M} y2={cy} stroke="url(#fg-axis)" strokeWidth="1" strokeDasharray="1 6" />

        {/* OUTGOING lanes */}
        {model.out.map((g) => {
          const dim = laneDim(g);
          return (
            <g key={'o' + g.rel} stroke={g.color} fill="none" style={{ opacity: dim ? 0.1 : 0.85, transition: 'opacity .15s' }}>
              <path d={branch(focusRightEdge, cy, hubOutX, g.hubY)} strokeWidth="2.4" />
              {g.items.map((n) => {
                const nx = RIGHT_X, ny = n._y;
                const ndim = hoverNode && hoverNode !== n.id;
                return (
                  <g key={n.id} style={{ opacity: ndim ? 0.2 : 1 }}>
                    <path d={branch(hubOutX, g.hubY, nx - 8, ny)} strokeWidth="1.4" />
                    <path d={`M ${nx - 10} ${ny - 4.5} L ${nx - 2} ${ny} L ${nx - 10} ${ny + 4.5}`} strokeWidth="1.4" fill={g.color} />
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* INCOMING lanes */}
        {model.in.map((g) => {
          const dim = laneDim(g);
          return (
            <g key={'i' + g.rel} stroke={g.color} fill="none" style={{ opacity: dim ? 0.1 : 0.85, transition: 'opacity .15s' }}>
              <path d={branch(hubInX, g.hubY, focusLeftEdge, cy)} strokeWidth="2.4" />
              <path d={`M ${focusLeftEdge - 2} ${cy - 4.5} L ${focusLeftEdge + 6} ${cy} L ${focusLeftEdge - 2} ${cy + 4.5}`} strokeWidth="1.4" fill={g.color} />
              {g.items.map((n) => {
                const nx = LEFT_X, ny = n._y;
                const ndim = hoverNode && hoverNode !== n.id;
                return (
                  <g key={n.id} style={{ opacity: ndim ? 0.2 : 1 }}>
                    <path d={branch(nx + 8, ny, hubInX, g.hubY)} strokeWidth="1.4" />
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* Lane labels — placed on the trunk between focus and hub, so they
            spread vertically with the groups and never sit on a node. */}
        {model.out.map((g) => {
          const dim = laneDim(g);
          const lx = (focusRightEdge + hubOutX) / 2;
          const ly = (cy + g.hubY) / 2;
          const txt = g.verb;
          const w = txt.length * 6.4 + 34;
          return (
            <g key={'ol' + g.rel} style={{ opacity: dim ? 0.25 : 1, transition: 'opacity .15s' }}>
              <rect x={lx - w / 2} y={ly - 10} width={w} height={20} rx={10}
                    fill="var(--panel-solid)" stroke={g.color} strokeWidth="1" strokeOpacity="0.55" />
              <text x={lx - 6} y={ly + 3.5} textAnchor="middle" fill={g.color}
                    fontFamily="var(--font-code)" fontSize="10.5" fontWeight="600">{txt}</text>
              <text x={lx + w / 2 - 12} y={ly + 3.5} textAnchor="middle" fill={g.color}
                    fontFamily="var(--font-code)" fontSize="9.5" fontWeight="700" opacity="0.75">{g.items.length}</text>
            </g>
          );
        })}
        {model.in.map((g) => {
          const dim = laneDim(g);
          const lx = (focusLeftEdge + hubInX) / 2;
          const ly = (cy + g.hubY) / 2;
          const txt = g.verb;
          const w = txt.length * 6.4 + 34;
          return (
            <g key={'il' + g.rel} style={{ opacity: dim ? 0.25 : 1, transition: 'opacity .15s' }}>
              <rect x={lx - w / 2} y={ly - 10} width={w} height={20} rx={10}
                    fill="var(--panel-solid)" stroke={g.color} strokeWidth="1" strokeOpacity="0.55" />
              <text x={lx - 6} y={ly + 3.5} textAnchor="middle" fill={g.color}
                    fontFamily="var(--font-code)" fontSize="10.5" fontWeight="600">{txt}</text>
              <text x={lx + w / 2 - 12} y={ly + 3.5} textAnchor="middle" fill={g.color}
                    fontFamily="var(--font-code)" fontSize="9.5" fontWeight="700" opacity="0.75">{g.items.length}</text>
            </g>
          );
        })}
      </svg>

      {/* Direction rail — persistent, unambiguous */}
      <div className="absolute flex items-center justify-between px-6" style={{ top: 12, left: 0, right: 0 }}>
        <div className="flex items-center gap-2 mono text-[10px] uppercase tracking-[0.2em]" style={{ color: 'var(--muted-soft)' }}>
          <span className="inline-block w-6 h-px" style={{ background: 'var(--panel-border)' }} />
          <span>points into {focusNode.id}</span>
        </div>
        <div className="flex items-center gap-2 mono text-[10px] uppercase tracking-[0.2em]" style={{ color: 'var(--muted-soft)' }}>
          <span>{focusNode.id} points to</span>
          <span className="inline-block w-6 h-px" style={{ background: 'var(--panel-border)' }} />
        </div>
      </div>

      {/* Incoming pills */}
      {model.in.flatMap(g => g.items.map(n => {
        const w = measurePill(n);
        return (
          <GraphNodePill key={'ip' + n.id} node={n} left={LEFT_X - w} top={n._y - 16} w={w} color={g.color}
            dim={isDim(g.rel, n.id)} active={hoverNode === n.id}
            onEnter={() => enterNode(n, 'in')} onLeave={leaveNode} onClick={() => onFocus(n.id)} />
        );
      }))}

      {/* Outgoing pills */}
      {model.out.flatMap(g => g.items.map(n => {
        const w = measurePill(n);
        return (
          <GraphNodePill key={'op' + n.id} node={n} left={RIGHT_X} top={n._y - 16} w={w} color={g.color}
            dim={isDim(g.rel, n.id)} active={hoverNode === n.id}
            onEnter={() => enterNode(n, 'out')} onLeave={leaveNode} onClick={() => onFocus(n.id)} />
        );
      }))}

      {/* Focus pill */}
      <GraphNodePill node={focusNode} left={cx - FW / 2} top={cy - 24} w={FW} isFocus />

      {/* Peek */}
      <PeekCard peek={effPeek} width={width} />

      {/* Empty state */}
      {model.in.length === 0 && model.out.length === 0 && (
        <div className="absolute left-1/2 -translate-x-1/2 mono text-[12px]" style={{ top: cy + 44, color: 'var(--muted-soft)' }}>
          no relationships recorded for this item
        </div>
      )}

      {/* Interactive legend — hover a relation to spotlight its lane */}
      <div className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-lg px-1.5 py-1"
           style={{ background: 'var(--panel-solid)', border: '1px solid var(--panel-border-soft)', boxShadow: 'var(--shadow-soft)' }}>
        {activeRels.map(r => {
          const c = window.REL[r].color;
          const on = hoverRel === r;
          return (
            <button key={r}
              onMouseEnter={() => setHoverRel(r)} onMouseLeave={() => setHoverRel(null)}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-md mono text-[10.5px] transition-colors"
              style={{ background: on ? 'var(--panel-muted)' : 'transparent', color: on ? 'var(--ink)' : 'var(--muted)' }}>
              <span className="inline-block w-3 h-[3px] rounded" style={{ background: c }} />
              {window.REL[r].label}
            </button>
          );
        })}
      </div>
      <div className="absolute bottom-3 right-3 mono text-[10px]" style={{ color: 'var(--muted-soft)' }}>
        hover to peek · click to focus
      </div>
    </div>
  );
}

/* Standalone artboard */
function GraphFocus() {
  const [focus, setFocus] = React.useState('drizzle_core');
  const [hist, setHist] = React.useState(['drizzle_core']);
  const go = (id) => { setFocus(id); setHist(h => [...h, id]); };
  const back = () => setHist(h => {
    if (h.length < 2) return h;
    const nh = h.slice(0, -1); setFocus(nh[nh.length - 1]); return nh;
  });
  const c = window.relCounts(focus);
  const node = window.nodeOf(focus);

  return (
    <div className="plate flex flex-col" style={{ width: 1180, height: 720, borderRadius: 14, overflow: 'hidden', border: '1px solid var(--panel-border)' }}>
      <div className="flex items-center justify-between px-4 h-12 border-b" style={{ borderColor: 'var(--panel-border-soft)', background: 'var(--panel)' }}>
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={back} disabled={hist.length < 2}
            className="size-7 grid place-items-center rounded-md shrink-0"
            style={{ border: '1px solid var(--panel-border)', color: hist.length < 2 ? 'var(--muted-soft)' : 'var(--ink-soft)', background: 'var(--panel-solid)', opacity: hist.length < 2 ? 0.5 : 1, cursor: hist.length < 2 ? 'default' : 'pointer' }}>
            <window.Icon.chevronRight size={14} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <span className="font-display text-[13.5px] font-semibold" style={{ color: 'var(--ink)' }}>Relationship graph</span>
          <span className="mono text-[11px] truncate" style={{ color: 'var(--muted-soft)' }}>
            {node.path} · {c.inN} in · {c.outN} out
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md p-0.5 text-[11px]" style={{ background: 'var(--panel-muted)', border: '1px solid var(--panel-border-soft)' }}>
            <span className="px-2 py-0.5 rounded" style={{ background: 'var(--panel-solid)', color: 'var(--ink)', boxShadow: 'var(--shadow-soft)' }}>Bundled</span>
            <span className="px-2 py-0.5" style={{ color: 'var(--muted)' }}>Force</span>
            <span className="px-2 py-0.5" style={{ color: 'var(--muted)' }}>Tree</span>
          </div>
          <button className="text-[11.5px] px-2.5 py-1 rounded-md flex items-center gap-1.5"
                  style={{ background: 'var(--panel-solid)', border: '1px solid var(--panel-border)', color: 'var(--ink-soft)' }}>
            <window.Icon.download size={11} /> Export
          </button>
        </div>
      </div>
      <div className="flex-1" style={{ background: 'var(--bg)' }}>
        <FocusGraphView focus={focus} onFocus={go} width={1180} height={668} />
      </div>
    </div>
  );
}

Object.assign(window, { FocusGraphView, GraphFocus });

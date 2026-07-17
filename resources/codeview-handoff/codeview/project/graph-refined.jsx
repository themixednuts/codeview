/* eslint-disable */
/* Graph A — Refined (dark codey).
   - Tighter rounded-rect nodes sized to label
   - Grouped edge labels (e.g. "re-exports · 5" not 5x stacked)
   - Soft halo on focus, dim others
   - Dotted background, slim top bar
*/

const A_OUT = [
  { id: 'param',     label: 'Param',         kind: 'struct',   rel: 'reexports' },
  { id: 'orderby',   label: 'OrderByClause', kind: 'struct',   rel: 'reexports' },
  { id: 'whereexpr', label: 'WhereExpr',     kind: 'enum',     rel: 'reexports' },
  { id: 'query',     label: 'Query',         kind: 'struct',   rel: 'reexports' },
  { id: 'select',    label: 'Select',        kind: 'struct',   rel: 'reexports' },
  { id: 'traits',    label: 'traits',        kind: 'module',   rel: 'contains'  },
  { id: 'parser',    label: 'parser',        kind: 'module',   rel: 'contains'  },
  { id: 'ast',       label: 'ast',           kind: 'module',   rel: 'contains'  },
  { id: 'executable',label: 'Executable',    kind: 'trait',    rel: 'implements'},
  { id: 'queryext',  label: 'QueryExt',      kind: 'trait',    rel: 'implements'},
];
const A_IN = [
  { id: 'drizzle',   label: 'drizzle',          kind: 'crate', rel: 'uses' },
  { id: 'cli',       label: 'drizzle_cli',      kind: 'crate', rel: 'uses' },
  { id: 'pg',        label: 'drizzle_postgres', kind: 'crate', rel: 'uses' },
  { id: 'sqlite',    label: 'drizzle_sqlite',   kind: 'crate', rel: 'uses' },
];

const REL_COLOR = {
  reexports:  '#7f98ba',
  contains:   '#d27669',
  implements: '#7fa3b3',
  uses:       '#a3b386',
};

const KIND_FILL = {
  crate:    'var(--kind-crate)',
  module:   'var(--kind-module)',
  struct:   'var(--kind-struct)',
  enum:     'var(--kind-enum)',
  trait:    'var(--kind-trait)',
  function: 'var(--kind-function)',
};

function NodeA({ x, y, label, kind, focus = false, sub }) {
  const fill = KIND_FILL[kind] || 'var(--muted)';
  const charW = 7;
  const padX = 12;
  const w = Math.max(56, label.length * charW + padX * 2);
  const h = focus ? 44 : 30;

  if (kind === 'enum') {
    const dx = w / 2 + 4, dy = h / 2 + 8;
    return (
      <g transform={`translate(${x}, ${y})`}>
        <polygon points={`0,-${dy} ${dx},0 0,${dy} -${dx},0`} fill="var(--bg)" stroke={fill} strokeWidth="1.5"/>
        <text textAnchor="middle" dominantBaseline="middle" fill={fill} fontFamily="var(--font-code)" fontSize="11.5" fontWeight="600">{label}</text>
      </g>
    );
  }
  if (kind === 'trait') {
    return (
      <g transform={`translate(${x}, ${y})`}>
        <rect x={-w/2} y={-h/2} width={w} height={h} rx={h/2} fill="var(--bg)" stroke={fill} strokeWidth="1.5"/>
        <text textAnchor="middle" dominantBaseline="middle" fill={fill} fontFamily="var(--font-code)" fontSize="11.5" fontWeight="600">{label}</text>
      </g>
    );
  }

  return (
    <g transform={`translate(${x}, ${y})`}>
      {focus && <rect x={-w/2 - 7} y={-h/2 - 7} width={w + 14} height={h + 14} rx={10} fill="none" stroke={fill} strokeOpacity="0.30" strokeWidth="6" />}
      <rect x={-w/2} y={-h/2} width={w} height={h} rx={6}
            fill={focus ? fill : 'var(--panel-solid)'}
            stroke={focus ? fill : fill} strokeWidth={focus ? 0 : 1.5} />
      <text textAnchor="middle" dominantBaseline="middle"
            y={sub ? -4 : 0}
            fill={focus ? '#0c0e12' : fill}
            fontFamily="var(--font-code)"
            fontSize={focus ? 14 : 11.5}
            fontWeight={focus ? 700 : 600}>{label}</text>
      {sub && <text textAnchor="middle" y={12} fill={focus ? 'rgba(12,14,18,0.7)' : 'var(--muted-soft)'} fontFamily="var(--font-body)" fontSize="9.5">{sub}</text>}
    </g>
  );
}

function GraphRefined() {
  const W = 1120, H = 720;
  const cx = 560, cy = 360;
  const outX = 900;
  const inX = 220;
  const out = A_OUT;
  const inn = A_IN;

  const outYs = out.map((_, i) => 110 + i * (H - 220) / Math.max(1, out.length - 1));
  const innYs = inn.map((_, i) => 200 + i * 120);

  const outGroups = {};
  out.forEach((n, i) => { (outGroups[n.rel] ??= []).push({ ...n, y: outYs[i] }); });

  return (
    <div className="relative" style={{ width: W, height: H, background: 'var(--bg-strong)', borderRadius: 14, border: '1px solid var(--panel-border)', overflow: 'hidden' }}>
      {/* Header */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-4 h-11 border-b"
           style={{ borderColor: 'var(--panel-border)', background: 'rgba(15,18,24,0.72)', backdropFilter: 'blur(8px)' }}>
        <div className="flex items-center gap-2">
          <span className="font-display text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>Relationship Graph</span>
          <span className="mono text-[10.5px]" style={{ color: 'var(--muted-soft)' }}>14 edges · 11 nodes</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md p-0.5 text-[11px]" style={{ background: 'var(--panel)', border: '1px solid var(--panel-border)' }}>
            <span className="px-2 py-0.5 rounded" style={{ background: 'var(--panel-strong)', color: 'var(--ink)' }}>Force</span>
            <span className="px-2 py-0.5" style={{ color: 'var(--muted)' }}>Hierarchy</span>
            <span className="px-2 py-0.5" style={{ color: 'var(--muted)' }}>Radial</span>
          </div>
          <div className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--muted)' }}>
            <button className="size-6 grid place-items-center rounded-md" style={{ background: 'var(--panel)', border: '1px solid var(--panel-border)' }}>−</button>
            <span className="mono w-10 text-center">100%</span>
            <button className="size-6 grid place-items-center rounded-md" style={{ background: 'var(--panel)', border: '1px solid var(--panel-border)' }}>+</button>
          </div>
        </div>
      </div>

      <svg width={W} height={H} className="absolute inset-0">
        <defs>
          <pattern id="dotsA" width="22" height="22" patternUnits="userSpaceOnUse">
            <circle cx="11" cy="11" r="1" fill="rgba(148,163,184,0.10)" />
          </pattern>
        </defs>
        <rect x="0" y="44" width={W} height={H - 44} fill="url(#dotsA)" />

        {/* Incoming edges */}
        {inn.map((n, i) => {
          const y = innYs[i];
          const mx = (inX + cx) / 2;
          return (
            <g key={n.id} stroke={REL_COLOR[n.rel]} fill="none" strokeWidth="1.2" opacity="0.6">
              <path d={`M ${inX + 56} ${y} Q ${mx} ${y} ${cx - 80} ${cy}`} />
              {/* arrow head */}
              <polygon points={`${cx - 84},${cy - 4} ${cx - 76},${cy} ${cx - 84},${cy + 4}`} fill={REL_COLOR[n.rel]} opacity="0.7" stroke="none" />
            </g>
          );
        })}

        {/* Outgoing edges grouped */}
        {Object.entries(outGroups).map(([rel, items]) => (
          <g key={rel} stroke={REL_COLOR[rel]} fill="none" strokeWidth="1.2" opacity="0.6">
            {items.map((n) => (
              <g key={n.id}>
                <path d={`M ${cx + 82} ${cy} Q ${(cx + outX) / 2} ${(cy + n.y) / 2} ${outX - 60} ${n.y}`} />
                <polygon points={`${outX - 64},${n.y - 4} ${outX - 56},${n.y} ${outX - 64},${n.y + 4}`} fill={REL_COLOR[rel]} opacity="0.7" stroke="none" />
              </g>
            ))}
            {(() => {
              const midY = items.reduce((s, n) => s + n.y, 0) / items.length;
              const labelX = (cx + outX) / 2;
              return (
                <g>
                  <rect x={labelX - 50} y={midY - 9} width="100" height="18" rx="9"
                        fill="var(--bg-strong)" stroke={REL_COLOR[rel]} strokeOpacity="0.4" />
                  <text x={labelX} y={midY + 4} textAnchor="middle" fill={REL_COLOR[rel]} fontFamily="var(--font-code)" fontSize="10.5" fontWeight="600">
                    {rel} · {items.length}
                  </text>
                </g>
              );
            })()}
          </g>
        ))}

        {/* Incoming group label */}
        <g>
          <rect x={(inX + cx)/2 - 40} y={cy - 9} width="80" height="18" rx="9"
                fill="var(--bg-strong)" stroke={REL_COLOR.uses} strokeOpacity="0.4" />
          <text x={(inX + cx)/2} y={cy + 4} textAnchor="middle" fill={REL_COLOR.uses} fontFamily="var(--font-code)" fontSize="10.5" fontWeight="600">
            uses · {inn.length}
          </text>
        </g>

        {/* Incoming nodes */}
        {inn.map((n, i) => (
          <NodeA key={n.id} x={inX} y={innYs[i]} label={n.label} kind={n.kind} />
        ))}

        {/* Center */}
        <NodeA x={cx} y={cy} label="drizzle_core" kind="crate" focus sub="crate · 0.1.4" />

        {/* Outgoing */}
        {out.map((n, i) => (
          <NodeA key={n.id} x={outX} y={outYs[i]} label={n.label} kind={n.kind} />
        ))}
      </svg>

      {/* Legend */}
      <div className="absolute bottom-3 left-3 px-3 py-2 mono text-[10.5px] rounded-lg flex items-center gap-3"
           style={{ background: 'rgba(20,24,31,0.85)', border: '1px solid var(--panel-border)', color: 'var(--muted)', backdropFilter: 'blur(6px)' }}>
        {Object.entries(REL_COLOR).map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-0.5 rounded" style={{ background: v }} />
            {k}
          </span>
        ))}
      </div>
      <div className="absolute bottom-3 right-3 mono text-[10.5px]" style={{ color: 'var(--muted-soft)' }}>
        ← incoming · outgoing →
      </div>
    </div>
  );
}

window.GraphRefined = GraphRefined;

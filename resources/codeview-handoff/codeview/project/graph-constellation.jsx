/* eslint-disable */
/* Graph B — "Constellation"
   Nodes reduce to small colored dots. The visible thing is the LABEL —
   typography-led graph. Edges are soft hair-thin curves, fading into a
   warm vignette. Selected node has a halo + tag. Easier on the eyes
   when there are many nodes; reads like a map.
*/

const KIND_FILL_B = {
  crate:    'var(--kind-crate)',
  module:   'var(--kind-module)',
  struct:   'var(--kind-struct)',
  enum:     'var(--kind-enum)',
  trait:    'var(--kind-trait)',
  function: 'var(--kind-function)',
};

// Pre-computed positions (radial-ish around focus).
const NODES_B = [
  { id: 'core',      label: 'drizzle_core',     kind: 'crate',    x: 540, y: 360, focus: true, version: '0.1.4' },
  // Re-exports (right)
  { id: 'param',     label: 'Param',            kind: 'struct',   x: 850, y: 220, rel: 'reexports' },
  { id: 'orderby',   label: 'OrderByClause',    kind: 'struct',   x: 920, y: 320, rel: 'reexports' },
  { id: 'query',     label: 'Query',            kind: 'struct',   x: 935, y: 410, rel: 'reexports' },
  { id: 'whereexpr', label: 'WhereExpr',        kind: 'enum',     x: 890, y: 500, rel: 'reexports' },
  { id: 'select',    label: 'Select',           kind: 'struct',   x: 800, y: 580, rel: 'reexports' },
  // Contains (top)
  { id: 'traits',    label: 'traits',           kind: 'module',   x: 420, y: 130, rel: 'contains' },
  { id: 'parser',    label: 'parser',           kind: 'module',   x: 580, y: 110, rel: 'contains' },
  { id: 'ast',       label: 'ast',              kind: 'module',   x: 730, y: 150, rel: 'contains' },
  // Implements (bottom)
  { id: 'executable',label: 'Executable',       kind: 'trait',    x: 480, y: 600, rel: 'implements' },
  { id: 'queryext',  label: 'QueryExt',         kind: 'trait',    x: 610, y: 620, rel: 'implements' },
  // Uses / incoming (left)
  { id: 'drizzle',   label: 'drizzle',          kind: 'crate',    x: 200, y: 240, rel: 'uses',       incoming: true },
  { id: 'cli',       label: 'drizzle_cli',      kind: 'crate',    x: 170, y: 360, rel: 'uses',       incoming: true },
  { id: 'pg',        label: 'drizzle_postgres', kind: 'crate',    x: 200, y: 490, rel: 'uses',       incoming: true },
];

const REL_COLOR_B = {
  reexports:  '#587091',
  contains:   '#c45d4f',
  implements: '#4d6d7a',
  uses:       '#6d7a5b',
};

function GraphConstellation() {
  const W = 1100, H = 720;
  const center = NODES_B.find(n => n.focus);
  const others = NODES_B.filter(n => !n.focus);

  // Curve from a to b that bows outward from the line a→b
  const curve = (a, b, bow = 0.18) => {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = b.x - a.x, dy = b.y - a.y;
    // perpendicular offset
    const px = -dy * bow, py = dx * bow;
    return `M ${a.x} ${a.y} Q ${mx + px} ${my + py} ${b.x} ${b.y}`;
  };

  return (
    <div className="relative" style={{ width: W, height: H, background: 'var(--panel)', borderRadius: 18, border: '1px solid var(--panel-border)', overflow: 'hidden' }}>
      {/* Header strip */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-4 h-11 border-b" style={{ borderColor: 'var(--panel-border-soft)', background: 'rgba(255,250,241,0.6)', backdropFilter: 'blur(8px)' }}>
        <div className="flex items-center gap-2">
          <span className="font-display text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>Relationship Graph</span>
          <span className="font-mono text-[11px]" style={{ color: 'var(--muted-soft)' }}>
            drizzle_core · 14 connections
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 text-[11px] rounded-md px-2 py-1" style={{ background: 'var(--panel-muted)', color: 'var(--muted)' }}>
            <Icon.search size={11} />
            <span className="font-mono">filter</span>
            <span className="kbd" style={{ height: 16, fontSize: 9 }}>/</span>
          </div>
          <div className="flex items-center text-[11px] rounded-md p-0.5" style={{ background: 'var(--panel-muted)', border: '1px solid var(--panel-border-soft)' }}>
            <span className="px-2 py-0.5 rounded" style={{ background: 'var(--panel-solid)', color: 'var(--ink)' }}>Radial</span>
            <span className="px-2 py-0.5" style={{ color: 'var(--muted)' }}>Force</span>
          </div>
        </div>
      </div>

      <svg width={W} height={H} className="absolute inset-0">
        <defs>
          <radialGradient id="vignetteB" cx="540" cy="360" r="500" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="rgba(247, 226, 197, 0.45)" />
            <stop offset="55%" stopColor="rgba(247, 226, 197, 0.18)" />
            <stop offset="100%" stopColor="rgba(255, 250, 241, 0)" />
          </radialGradient>
          <radialGradient id="focusGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%"  stopColor="rgba(232, 114, 12, 0.35)" />
            <stop offset="60%" stopColor="rgba(232, 114, 12, 0.10)" />
            <stop offset="100%" stopColor="rgba(232, 114, 12, 0)" />
          </radialGradient>
        </defs>
        <rect x="0" y="0" width={W} height={H} fill="url(#vignetteB)" />
        <circle cx={center.x} cy={center.y} r="160" fill="url(#focusGlow)" />

        {/* Edges */}
        <g fill="none">
          {others.map(n => {
            const color = REL_COLOR_B[n.rel] || 'var(--muted)';
            const a = n.incoming ? n : center;
            const b = n.incoming ? center : n;
            return (
              <path key={n.id} d={curve(a, b, 0.12)} stroke={color} strokeWidth="1" opacity="0.5" />
            );
          })}
        </g>

        {/* Soft relation labels — one per cluster, large + low-contrast */}
        {[
          { rel: 'reexports',  text: 're-exports',  x: 970, y: 130, color: REL_COLOR_B.reexports },
          { rel: 'contains',   text: 'contains',    x: 740, y: 60,  color: REL_COLOR_B.contains },
          { rel: 'implements', text: 'implements',  x: 480, y: 670, color: REL_COLOR_B.implements },
          { rel: 'uses',       text: 'used by',     x: 130, y: 150, color: REL_COLOR_B.uses },
        ].map(g => (
          <text key={g.rel} x={g.x} y={g.y} fill={g.color}
                fontFamily="var(--font-display)" fontSize="13" fontWeight="500" fontStyle="italic"
                opacity="0.6">
            {g.text}
          </text>
        ))}

        {/* Nodes — small colored dot + label */}
        {others.map(n => {
          const fill = KIND_FILL_B[n.kind] || 'var(--muted)';
          const labelAnchor = n.x > center.x + 20 ? 'start' : (n.x < center.x - 20 ? 'end' : 'middle');
          const dx = labelAnchor === 'start' ? 10 : labelAnchor === 'end' ? -10 : 0;
          const dy = labelAnchor === 'middle' ? (n.y < center.y ? -12 : 18) : 4;
          return (
            <g key={n.id}>
              <circle cx={n.x} cy={n.y} r="5" fill={fill} />
              <circle cx={n.x} cy={n.y} r="9" fill={fill} fillOpacity="0.15" />
              <text x={n.x + dx} y={n.y + dy} textAnchor={labelAnchor}
                    fill="var(--ink)" fontFamily="var(--font-body)" fontSize="13" fontWeight="500">
                {n.label}
              </text>
              <text x={n.x + dx} y={n.y + dy + 13} textAnchor={labelAnchor}
                    fill="var(--muted-soft)" fontFamily="var(--font-body)" fontSize="10">
                {n.kind}
              </text>
            </g>
          );
        })}

        {/* Center node */}
        <g>
          <circle cx={center.x} cy={center.y} r="22" fill="var(--panel-solid)" stroke="var(--kind-crate)" strokeWidth="2" />
          <circle cx={center.x} cy={center.y} r="6" fill="var(--kind-crate)" />
          <text x={center.x} y={center.y + 50} textAnchor="middle"
                fill="var(--ink)" fontFamily="var(--font-display)" fontSize="20" fontWeight="600">
            {center.label}
          </text>
          <text x={center.x} y={center.y + 70} textAnchor="middle"
                fill="var(--muted)" fontFamily="var(--font-body)" fontSize="11">
            crate · v{center.version}
          </text>
        </g>
      </svg>

      {/* Legend pill */}
      <div className="absolute bottom-3 left-3 corner-squircle px-3 py-2 text-[10.5px] flex items-center gap-3"
           style={{ background: 'rgba(255,250,241,0.85)', border: '1px solid var(--panel-border-soft)', borderRadius: 10, backdropFilter: 'blur(6px)', color: 'var(--muted)' }}>
        {Object.entries(KIND_FILL_B).map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-full" style={{ background: v }} />
            {k}
          </span>
        ))}
      </div>
      <div className="absolute bottom-3 right-3 font-mono text-[10.5px]" style={{ color: 'var(--muted-soft)' }}>
        scroll to zoom · drag to pan
      </div>
    </div>
  );
}

window.GraphConstellation = GraphConstellation;

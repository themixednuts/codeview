/* eslint-disable */
/* Graph C — "Banded by relationship"
   Edges as spaghetti are noisy. Here, each relationship type becomes a
   sector (pie slice). Membership in a sector IS the edge — no per-edge
   line. Counts the most relevant info (what is this and what relates to it,
   organized) up front. Drill in by clicking a sector.
*/

const SECTORS = [
  {
    rel: 'reexports', label: 'Re-exports', count: 6, color: '#587091',
    items: [
      { name: 'Param',         kind: 'struct' },
      { name: 'OrderByClause', kind: 'struct' },
      { name: 'Query',         kind: 'struct' },
      { name: 'WhereExpr',     kind: 'enum'   },
      { name: 'Select',        kind: 'struct' },
      { name: 'Insert',        kind: 'struct' },
    ],
  },
  {
    rel: 'contains', label: 'Contains', count: 4, color: '#c45d4f',
    items: [
      { name: 'traits',  kind: 'module' },
      { name: 'parser',  kind: 'module' },
      { name: 'ast',     kind: 'module' },
      { name: 'codegen', kind: 'module' },
    ],
  },
  {
    rel: 'implements', label: 'Implements', count: 3, color: '#4d6d7a',
    items: [
      { name: 'Executable', kind: 'trait' },
      { name: 'QueryExt',   kind: 'trait' },
      { name: 'Display',    kind: 'trait' },
    ],
  },
  {
    rel: 'uses', label: 'Used by', count: 4, color: '#6d7a5b',
    items: [
      { name: 'drizzle',          kind: 'crate' },
      { name: 'drizzle_cli',      kind: 'crate' },
      { name: 'drizzle_postgres', kind: 'crate' },
      { name: 'drizzle_sqlite',   kind: 'crate' },
    ],
  },
];

const KIND_FILL_C = {
  crate:    'var(--kind-crate)',
  module:   'var(--kind-module)',
  struct:   'var(--kind-struct)',
  enum:     'var(--kind-enum)',
  trait:    'var(--kind-trait)',
  function: 'var(--kind-function)',
};

function GraphBanded() {
  const W = 1100, H = 720;
  const cx = W / 2, cy = H / 2 + 6;
  const rInner = 75;
  const rOuter = 320;

  // 4 sectors covering ~340deg with 5deg gaps; top is "12 o'clock"
  const startAngle = -90; // top
  const gap = 4; // deg
  const total = 360 - gap * SECTORS.length;
  const perSector = total / SECTORS.length;

  const toRad = (d) => (d * Math.PI) / 180;
  const polar = (r, deg) => ({ x: cx + r * Math.cos(toRad(deg)), y: cy + r * Math.sin(toRad(deg)) });

  const arcPath = (r0, r1, a0, a1) => {
    const p0 = polar(r0, a0);
    const p1 = polar(r1, a0);
    const p2 = polar(r1, a1);
    const p3 = polar(r0, a1);
    const largeArc = a1 - a0 > 180 ? 1 : 0;
    return `M ${p0.x} ${p0.y} L ${p1.x} ${p1.y} A ${r1} ${r1} 0 ${largeArc} 1 ${p2.x} ${p2.y} L ${p3.x} ${p3.y} A ${r0} ${r0} 0 ${largeArc} 0 ${p0.x} ${p0.y} Z`;
  };

  return (
    <div className="relative" style={{ width: W, height: H, background: 'var(--panel)', borderRadius: 18, border: '1px solid var(--panel-border)', overflow: 'hidden' }}>
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-4 h-11 border-b" style={{ borderColor: 'var(--panel-border-soft)', background: 'rgba(255,250,241,0.6)', backdropFilter: 'blur(8px)' }}>
        <div className="flex items-center gap-2">
          <span className="font-display text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>Relationships</span>
          <span className="font-mono text-[11px]" style={{ color: 'var(--muted-soft)' }}>drizzle_core · 17 connections in 4 groups</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center text-[11px] rounded-md p-0.5" style={{ background: 'var(--panel-muted)', border: '1px solid var(--panel-border-soft)' }}>
            <span className="px-2 py-0.5 rounded" style={{ background: 'var(--panel-solid)', color: 'var(--ink)' }}>Banded</span>
            <span className="px-2 py-0.5" style={{ color: 'var(--muted)' }}>Force</span>
            <span className="px-2 py-0.5" style={{ color: 'var(--muted)' }}>Tree</span>
          </div>
        </div>
      </div>

      <svg width={W} height={H} className="absolute inset-0">
        {/* Subtle radial grid */}
        <g fill="none" stroke="var(--grid-line)" strokeWidth="1">
          {[120, 180, 240, 300].map(r => <circle key={r} cx={cx} cy={cy} r={r} />)}
        </g>

        {/* Sectors */}
        {SECTORS.map((s, i) => {
          const a0 = startAngle + i * (perSector + gap);
          const a1 = a0 + perSector;
          const midA = (a0 + a1) / 2;
          const labelPos = polar(rOuter - 22, midA);
          const headerPos = polar(rOuter + 24, midA);

          // arrange items on a chord-grid within the sector
          // 2 rows, columns based on item count
          const itemsTopRow = Math.ceil(s.items.length / 2);
          const itemsBottomRow = s.items.length - itemsTopRow;
          return (
            <g key={s.rel}>
              {/* Fill */}
              <path d={arcPath(rInner, rOuter, a0, a1)} fill={s.color} fillOpacity="0.06" stroke={s.color} strokeOpacity="0.25" strokeWidth="1" />
              {/* Sector header arc-position label */}
              <g transform={`translate(${headerPos.x}, ${headerPos.y})`}>
                <text textAnchor="middle" fill={s.color}
                      fontFamily="var(--font-body)" fontSize="11"
                      fontWeight="700" letterSpacing="0.16em"
                      style={{ textTransform: 'uppercase' }}>
                  {s.label} · {s.count}
                </text>
              </g>

              {/* Items — placed on two arcs within the sector */}
              {s.items.map((item, j) => {
                const row = j < itemsTopRow ? 0 : 1;
                const colCount = row === 0 ? itemsTopRow : itemsBottomRow;
                const colIdx = row === 0 ? j : j - itemsTopRow;
                const r = row === 0 ? rOuter - 70 : rInner + 50;
                // place evenly across the sector
                const tStart = a0 + 8;
                const tEnd = a1 - 8;
                const t = colCount === 1 ? (tStart + tEnd) / 2 : tStart + (colIdx) * (tEnd - tStart) / (colCount - 1);
                const pos = polar(r, t);
                const fill = KIND_FILL_C[item.kind] || 'var(--muted)';
                return (
                  <g key={item.name} transform={`translate(${pos.x}, ${pos.y})`}>
                    {/* Pill */}
                    <rect x={-Math.max(40, item.name.length * 4.2 + 14)} y={-13}
                          width={Math.max(80, item.name.length * 8.4 + 28)} height={26}
                          rx={13}
                          fill="var(--panel-solid)" stroke={s.color} strokeOpacity="0.3" strokeWidth="1" />
                    {/* dot */}
                    <circle cx={-Math.max(40, item.name.length * 4.2 + 14) + 12} cy={0} r="3.5" fill={fill} />
                    <text textAnchor="start" x={-Math.max(40, item.name.length * 4.2 + 14) + 21} y="4"
                          fill="var(--ink)" fontFamily="var(--font-body)" fontSize="12" fontWeight="600">
                      {item.name}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* Center node */}
        <g>
          <circle cx={cx} cy={cy} r={rInner - 4} fill="var(--panel-solid)" stroke="var(--kind-crate)" strokeWidth="2" />
          <circle cx={cx} cy={cy} r={rInner + 8} fill="none" stroke="var(--kind-crate)" strokeOpacity="0.18" strokeWidth="8" />
          <text x={cx} y={cy - 4} textAnchor="middle"
                fill="var(--ink)" fontFamily="var(--font-display)" fontSize="20" fontWeight="600">
            drizzle_core
          </text>
          <text x={cx} y={cy + 14} textAnchor="middle"
                fill="var(--muted)" fontFamily="var(--font-body)" fontSize="11" letterSpacing="0.12em"
                style={{ textTransform: 'uppercase' }}>
            crate
          </text>
        </g>
      </svg>

      {/* Hint */}
      <div className="absolute bottom-3 right-3 font-mono text-[10.5px]" style={{ color: 'var(--muted-soft)' }}>
        click a group to expand · click a node to focus
      </div>
      <div className="absolute bottom-3 left-3 corner-squircle px-3 py-2 text-[10.5px]"
           style={{ background: 'rgba(255,250,241,0.85)', border: '1px solid var(--panel-border-soft)', borderRadius: 10, backdropFilter: 'blur(6px)', color: 'var(--muted)' }}>
        edges are implied by group membership — no spaghetti
      </div>
    </div>
  );
}

window.GraphBanded = GraphBanded;

/* eslint-disable */
/* Shared building blocks, dark theme */

const Icon = {
  search: (p={}) => (<svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>),
  arrowRight: (p={}) => (<svg width={p.size||14} height={p.size||14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>),
  chevronRight: (p={}) => (<svg width={p.size||14} height={p.size||14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m9 18 6-6-6-6"/></svg>),
  chevronDown: (p={}) => (<svg width={p.size||14} height={p.size||14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m6 9 6 6 6-6"/></svg>),
  download: (p={}) => (<svg width={p.size||12} height={p.size||12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>),
  clock: (p={}) => (<svg width={p.size||12} height={p.size||12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>),
  github: (p={}) => (<svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.34-1.27-1.69-1.27-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.69 1.25 3.34.96.1-.74.4-1.25.72-1.54-2.56-.29-5.25-1.28-5.25-5.71 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.21-1.5 3.17-1.18 3.17-1.18.63 1.59.24 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.44-2.69 5.42-5.25 5.71.41.36.78 1.06.78 2.13v3.16c0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"/></svg>),
  hash: (p={}) => (<svg width={p.size||12} height={p.size||12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/></svg>),
  link: (p={}) => (<svg width={p.size||12} height={p.size||12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>),
  copy: (p={}) => (<svg width={p.size||12} height={p.size||12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>),
  filter: (p={}) => (<svg width={p.size||12} height={p.size||12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>),
  command: (p={}) => (<svg width={p.size||12} height={p.size||12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/></svg>),
};

function TopBar({ pad='px-6', breadcrumb }) {
  return (
    <header className={`flex items-center justify-between ${pad} h-12 border-b`} style={{ borderColor: 'var(--panel-border)' }}>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="3" width="18" height="18" rx="4" fill="var(--accent)" />
            <path d="M8 12l3 3 5-6" stroke="#0c0e12" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
          </svg>
          <span className="font-display text-[15.5px] font-semibold tracking-tight" style={{ color: 'var(--ink)' }}>codeview</span>
        </div>
        {breadcrumb && (
          <>
            <span className="text-[13px]" style={{ color: 'var(--muted-soft)' }}>/</span>
            <span className="mono text-[12.5px]" style={{ color: 'var(--muted)' }}>{breadcrumb}</span>
          </>
        )}
      </div>
      <nav className="flex items-center gap-1 text-[12.5px]" style={{ color: 'var(--muted)' }}>
        <a className="px-2.5 py-1 rounded-md hover:text-[color:var(--ink)]">Crates</a>
        <a className="px-2.5 py-1 rounded-md hover:text-[color:var(--ink)]">std</a>
        <a className="px-2.5 py-1 rounded-md hover:text-[color:var(--ink)]">Releases</a>
      </nav>
      <div className="flex items-center gap-2">
        <button className="mono text-[11.5px] inline-flex items-center gap-2 px-2.5 py-1 rounded-md"
                style={{ background: 'var(--panel-strong)', border: '1px solid var(--panel-border)', color: 'var(--muted)' }}>
          <Icon.search size={12} />
          <span>Search</span>
          <span className="kbd">⌘</span><span className="kbd">K</span>
        </button>
        <button className="size-7 grid place-items-center rounded-md" style={{ color: 'var(--muted)' }}>
          <Icon.github size={14} />
        </button>
      </div>
    </header>
  );
}

const KIND_TOKEN = {
  crate:    { bg: 'var(--kind-crate)',    glyph: 'C' },
  module:   { bg: 'var(--kind-module)',   glyph: 'M' },
  mod:      { bg: 'var(--kind-module)',   glyph: 'M' },
  struct:   { bg: 'var(--kind-struct)',   glyph: 'S' },
  enum:     { bg: 'var(--kind-enum)',     glyph: 'E' },
  trait:    { bg: 'var(--kind-trait)',    glyph: 'T' },
  impl:     { bg: 'var(--kind-impl)',     glyph: 'I' },
  fn:       { bg: 'var(--kind-function)', glyph: 'ƒ' },
  function: { bg: 'var(--kind-function)', glyph: 'ƒ' },
  method:   { bg: 'var(--kind-method)',   glyph: 'ƒ' },
  type:     { bg: 'var(--kind-typealias)',glyph: 't' },
  const:    { bg: 'var(--kind-constant)', glyph: 'c' },
  constant: { bg: 'var(--kind-constant)', glyph: 'c' },
  macro:    { bg: 'var(--kind-macro)',    glyph: '!' },
};

function KindBadge({ kind, size = 16 }) {
  const k = KIND_TOKEN[kind] || { bg: 'var(--muted)', glyph: '·' };
  return (
    <span
      className="inline-grid place-items-center text-white mono font-semibold corner-squircle shrink-0"
      style={{
        width: size, height: size,
        background: k.bg,
        borderRadius: 4,
        fontSize: size * 0.6,
        lineHeight: 1,
        textShadow: '0 1px 0 rgba(0,0,0,0.2)',
      }}
    >{k.glyph}</span>
  );
}

// Inline mini-sparkline (dark)
function Sparkline({ data=[3,4,3,5,6,5,7,8,7,9,11,10], w=68, h=18, color='var(--accent)' }) {
  const max = Math.max(...data), min = Math.min(...data);
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / Math.max(1, max - min)) * (h - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const d = 'M ' + pts.join(' L ');
  const area = `${d} L ${w},${h} L 0,${h} Z`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <path d={area} fill={color} fillOpacity="0.12" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// Pretty rust signature renderer — receives a token array
function Sig({ tokens, indent = false }) {
  return (
    <code className={`mono text-[12.5px] ${indent ? 'pl-3' : ''}`} style={{ color: 'var(--ink-soft)', lineHeight: 1.7 }}>
      {tokens.map((t, i) => {
        if (typeof t === 'string') return <span key={i}>{t}</span>;
        return <span key={i} className={`tk-${t[0]}`}>{t[1]}</span>;
      })}
    </code>
  );
}

Object.assign(window, { Icon, TopBar, KindBadge, Sparkline, Sig });

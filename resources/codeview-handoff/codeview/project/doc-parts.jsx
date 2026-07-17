/* eslint-disable */
/* Shared reading-view parts: code block, signature, sidebar tree row.
   Hand-tokenized code (no full syntax highlighter — keeps things deterministic).

   ⚠ NO hardcoded scheme/colors here — everything reads from CSS vars
   defined in theme.css under [data-code-theme="…"].
*/

/* ── A tiny "Rust" tokenizer for sample snippets ── */
function tokRust(src) {
  const KW = new Set(['pub', 'fn', 'use', 'mod', 'crate', 'self', 'super', 'impl', 'trait',
    'struct', 'enum', 'where', 'for', 'let', 'mut', 'ref', 'as', 'in', 'if', 'else',
    'match', 'return', 'await', 'async', 'move', 'dyn', 'const', 'static', 'type', 'unsafe', 'extern']);
  const TY = /^[A-Z][A-Za-z0-9_]*/;
  const ID = /^[a-z_][A-Za-z0-9_]*/;
  const NUM = /^[0-9][0-9_]*(?:\.[0-9_]+)?(?:[ui](?:8|16|32|64|size))?/;
  const STR = /^"(?:[^"\\]|\\.)*"/;
  const CM = /^\/\/[^\n]*/;
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i);
    let m;
    if (c === '\n') { out.push({ t: 'br' }); i++; continue; }
    if (c === ' ')  { out.push({ t: 'sp', v: ' ' }); i++; continue; }
    if (c === '\t') { out.push({ t: 'sp', v: '  ' }); i++; continue; }
    if ((m = rest.match(CM))) { out.push({ t: 'cm', v: m[0] }); i += m[0].length; continue; }
    if ((m = rest.match(STR))) { out.push({ t: 'str', v: m[0] }); i += m[0].length; continue; }
    if ((m = rest.match(NUM))) { out.push({ t: 'num', v: m[0] }); i += m[0].length; continue; }
    if ((m = rest.match(ID))) {
      const v = m[0];
      if (KW.has(v)) out.push({ t: 'kw', v });
      else if (src[i + v.length] === '(' || src[i + v.length] === '!') out.push({ t: 'fn', v });
      else out.push({ t: 'id', v });
      i += v.length; continue;
    }
    if ((m = rest.match(TY))) { out.push({ t: 'ty', v: m[0] }); i += m[0].length; continue; }
    out.push({ t: 'mu', v: c }); i++;
  }
  return out;
}

function CodeTokens({ src }) {
  const toks = tokRust(src);
  const cls = { kw: 'tok-kw', fn: 'tok-fn', ty: 'tok-ty', str: 'tok-str', num: 'tok-num', cm: 'tok-cm', id: 'tok-id', mu: 'tok-mu' };
  return (
    <>
      {toks.map((t, i) => {
        if (t.t === 'br') return <br key={i} />;
        if (t.t === 'sp') return <span key={i}>{t.v}</span>;
        return <span key={i} className={cls[t.t]}>{t.v}</span>;
      })}
    </>
  );
}

/* CodeBlock — uses .codeblock class for ALL theming.
   No `scheme` prop. Inherits --code-bg / --code-ink / --code-border / --syntax-* from
   the nearest [data-code-theme] ancestor (set on each .plate by theme-tweaks). */
function CodeBlock({ src, lang = 'rust', lines = false, label, className = '' }) {
  const lineCount = src.split('\n').length;
  return (
    <div className={`codeblock corner-squircle overflow-hidden ${className}`}>
      {label && (
        <div className="flex items-center justify-between px-3 py-1.5 font-mono text-[11px]"
             style={{ borderBottom: '1px solid var(--code-border)', color: 'var(--syntax-comment)' }}>
          <span>{label}</span>
          <span className="opacity-70">{lang}</span>
        </div>
      )}
      <div className="flex">
        {lines && (
          <pre className="font-mono text-[12.5px] leading-[1.75] px-3 py-3 text-right select-none"
               style={{ color: 'var(--code-ln)', borderRight: '1px solid var(--code-border)', margin: 0 }}>
            {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
          </pre>
        )}
        <pre className="code px-4 py-3 overflow-x-auto flex-1" style={{ margin: 0 }}>
          <CodeTokens src={src} />
        </pre>
      </div>
    </div>
  );
}

function Signature({ src }) {
  return (
    <div className="codeblock corner-squircle px-4 py-3 font-mono text-[13.5px] leading-[1.7]">
      <CodeTokens src={src} />
    </div>
  );
}

/* Tree row */
function TreeRow({ name, kind, vis = 'pub', depth = 0, active = false, deprecated = false, count = null }) {
  return (
    <a className="group flex items-center gap-2 pl-2 pr-2 py-[3px] rounded-md transition-colors"
       style={{
         background: active ? 'var(--accent-soft)' : 'transparent',
         color: active ? 'var(--accent-strong)' : 'var(--ink)',
         marginLeft: depth * 12,
       }}>
      <KindIcon kind={kind} size={13} />
      <span className="font-mono text-[12px] flex-1 truncate"
            style={{
              color: active ? 'var(--accent-strong)' : 'var(--ink-soft)',
              textDecoration: deprecated ? 'line-through' : 'none',
              fontWeight: active ? 600 : 500,
            }}>
        {name}
      </span>
      {vis === 'crate' && <span className="font-mono text-[10px]" style={{ color: 'var(--muted-soft)' }}>(crate)</span>}
      {count != null && <span className="font-mono text-[10px] tabular-nums" style={{ color: 'var(--muted-soft)' }}>{count}</span>}
    </a>
  );
}

function TocLink({ text, depth = 0, active = false, count = null }) {
  return (
    <a className="flex items-baseline gap-2 py-[3px] text-[12px] border-l-2 pl-2.5"
       style={{
         borderColor: active ? 'var(--accent)' : 'transparent',
         color: active ? 'var(--ink)' : 'var(--muted)',
         marginLeft: depth * 10,
         fontWeight: active ? 600 : 500,
       }}>
      <span className="flex-1 truncate">{text}</span>
      {count != null && <span className="font-mono text-[10px] tabular-nums" style={{ color: 'var(--muted-soft)' }}>{count}</span>}
    </a>
  );
}

function SectionHeading({ title, count, anchor }) {
  return (
    <div className="flex items-baseline gap-3 mt-9 mb-4 pb-2 border-b" style={{ borderColor: 'var(--panel-border-soft)' }}>
      <h2 className="font-display text-[22px] font-semibold leading-tight" style={{ color: 'var(--ink)' }}>{title}</h2>
      {count != null && <span className="font-mono text-[11px]" style={{ color: 'var(--muted-soft)' }}>{count}</span>}
      <span className="ml-auto font-mono text-[10.5px] opacity-0 hover:opacity-100" style={{ color: 'var(--muted-soft)' }}>#{anchor}</span>
    </div>
  );
}

function ItemRow({ sig, desc, deprecated = false, since, where, expanded = false }) {
  return (
    <div className="border-b" style={{ borderColor: 'var(--panel-border-soft)' }}>
      <div className="py-3.5">
        <div className="font-mono text-[13px] leading-[1.7]">
          <CodeTokens src={sig} />
        </div>
        {desc && (
          <p className="mt-2 text-[13px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            {desc}
          </p>
        )}
        {(since || where || deprecated) && (
          <div className="mt-2 flex items-center gap-2 text-[10.5px] font-mono" style={{ color: 'var(--muted-soft)' }}>
            {since && <span>since {since}</span>}
            {where && <span className="dotsep">{where}</span>}
            {deprecated && <span style={{ color: 'var(--accent-strong)' }}>· deprecated</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function AttrChip({ children, variant = 'default' }) {
  const v = {
    default: { bg: 'var(--panel)', fg: 'var(--muted)', bd: 'var(--panel-border)' },
    pub: { bg: 'var(--accent-soft)', fg: 'var(--accent-strong)', bd: 'transparent' },
    crate: { bg: 'var(--link-soft)', fg: 'var(--link)', bd: 'transparent' },
    deprecated: { bg: 'var(--danger-soft)', fg: 'var(--danger)', bd: 'transparent' },
    unstable: { bg: 'var(--warn-soft)', fg: 'var(--warn)', bd: 'transparent' },
  }[variant] || { bg: 'var(--panel)', fg: 'var(--muted)', bd: 'var(--panel-border)' };
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded text-[10.5px] font-mono font-semibold uppercase tracking-wider"
          style={{ background: v.bg, color: v.fg, border: `1px solid ${v.bd}` }}>
      {children}
    </span>
  );
}

function Breadcrumb({ segs }) {
  return (
    <nav className="flex items-baseline flex-wrap gap-1 font-mono text-[13px]">
      {segs.map((s, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span style={{ color: 'var(--muted-soft)' }}>::</span>}
          <a style={{
            color: i === segs.length - 1 ? 'var(--ink)' : 'var(--muted)',
            fontWeight: i === segs.length - 1 ? 700 : 500,
            textDecoration: i < segs.length - 1 ? 'underline' : 'none',
            textDecorationColor: 'rgba(28,32,38,0.15)',
            textUnderlineOffset: '2px',
          }}>
            {s}
          </a>
        </React.Fragment>
      ))}
    </nav>
  );
}

Object.assign(window, {
  CodeTokens, CodeBlock, Signature, TreeRow, TocLink, SectionHeading, ItemRow, AttrChip, Breadcrumb,
});

if (!('KindIcon' in window) && 'KindBadge' in window) window.KindIcon = window.KindBadge;

(() => {
  const I = window.Icon || (window.Icon = {});
  const mk = (path) => (p = {}) => (
    <svg width={p.size || 12} height={p.size || 12} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}
         dangerouslySetInnerHTML={{ __html: path }} />
  );
  if (!I.sparkle)  I.sparkle  = mk('<path d="M12 3v18M3 12h18M5.5 5.5l13 13M18.5 5.5l-13 13"/>');
  if (!I.trending) I.trending = mk('<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>');
  if (!I.layers)   I.layers   = mk('<path d="m12 2 9 4.5-9 4.5L3 6.5 12 2z"/><path d="m3 11.5 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>');
  if (!I.star)     I.star     = mk('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>');
  if (!I.command)  I.command  = mk('<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>');
})();

/* eslint-disable */
/* codeview · Tweaks — three expressive controls + theme switchers.

   Expressive controls (the ones that reshape the feel):
     1. Accent       — swap the whole accent family (orange/cobalt/forest/plum/char)
     2. Density      — compact / comfortable / spacious (scales fs + spacing)
     3. Voice        — editorial / technical / geometric (typographic register)

   Plus the basics:
     4. UI mode      — light / dark
     5. Code theme   — Solarized / Catppuccin / One / GitHub (light + dark each)

   Everything is applied as data-* attributes on documentElement, which the
   CSS in theme.css reads. The exception is `theme-dark` which is toggled
   per .plate so the canvas can host light + dark previews side-by-side.
*/

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "uiMode": "light",
  "accent": "orange",
  "density": "comfortable",
  "voice": "editorial",
  "codeTheme": "solarized-light",
  "codeThemeDark": "solarized-dark"
}/*EDITMODE-END*/;

function applyTheme({ uiMode, accent, density, voice, codeTheme, codeThemeDark }) {
  const root = document.documentElement;
  root.setAttribute('data-accent', accent);
  root.setAttribute('data-density', density);
  root.setAttribute('data-voice', voice);

  // Per-plate UI mode + code theme so statically-themed plates keep their look.
  document.querySelectorAll('.plate').forEach((p) => {
    const isStatic = p.dataset.staticScheme;
    let isDark;
    if (isStatic === 'dark')  { p.classList.add('theme-dark'); isDark = true; }
    else if (isStatic === 'light') { p.classList.remove('theme-dark'); isDark = false; }
    else if (uiMode === 'dark') { p.classList.add('theme-dark'); isDark = true; }
    else { p.classList.remove('theme-dark'); isDark = false; }
    p.setAttribute('data-code-theme', isDark ? codeThemeDark : codeTheme);
  });
}

/* Curated palette options for the Accent control — each chip is a 3-color
   strip so the user previews how the family lives, not just the dot. */
const ACCENT_OPTIONS = [
  ['orange', ['#cb4b16', '#fdf6e3', '#586e75']],   // Solarized orange (Rust)
  ['cobalt', ['#1f6fa5', '#fdf6e3', '#586e75']],
  ['forest', ['#4f7d2f', '#fdf6e3', '#586e75']],
  ['plum',   ['#8c3a76', '#fdf6e3', '#586e75']],
  ['char',   ['#2b323a', '#fdf6e3', '#586e75']],
];

function ThemeTweaks() {
  const { useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakSelect, TweakColor } = window;
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  React.useEffect(() => { applyTheme(t); }, [t.uiMode, t.accent, t.density, t.voice, t.codeTheme, t.codeThemeDark]);

  React.useEffect(() => {
    const mo = new MutationObserver(() => applyTheme(t));
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [t.uiMode, t.accent, t.density, t.voice, t.codeTheme, t.codeThemeDark]);

  const lightCodeOpts = [
    { value: 'solarized-light', label: 'Solarized Light' },
    { value: 'catppuccin-latte', label: 'Catppuccin Latte' },
    { value: 'one-light',       label: 'One Light' },
    { value: 'github-light',    label: 'GitHub Light' },
  ];
  const darkCodeOpts = [
    { value: 'solarized-dark',   label: 'Solarized Dark' },
    { value: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
    { value: 'one-dark',         label: 'One Dark' },
    { value: 'github-dark',      label: 'GitHub Dark' },
  ];

  return (
    <TweaksPanel title="codeview · theme">
      {/* ── Expressive: Accent palette ── */}
      <TweakSection label="Accent" />
      <TweakColor
        label="Family"
        value={ACCENT_OPTIONS.find(([k]) => k === t.accent)?.[1] || ACCENT_OPTIONS[0][1]}
        options={ACCENT_OPTIONS.map(([_, palette]) => palette)}
        onChange={(palette) => {
          const found = ACCENT_OPTIONS.find(([_, p]) => p.join('|') === palette.join('|'));
          setTweak('accent', found ? found[0] : 'orange');
        }}
      />

      {/* ── Expressive: Density ── */}
      <TweakSection label="Density" />
      <TweakRadio
        label="Spacing"
        value={t.density}
        options={[
          { value: 'compact',     label: 'Compact' },
          { value: 'comfortable', label: 'Comfort' },
          { value: 'spacious',    label: 'Spacious' },
        ]}
        onChange={(v) => setTweak('density', v)}
      />

      {/* ── Expressive: Voice ── */}
      <TweakSection label="Voice" />
      <TweakRadio
        label="Typography"
        value={t.voice}
        options={[
          { value: 'editorial', label: 'Editorial' },
          { value: 'technical', label: 'Technical' },
          { value: 'geometric', label: 'Geometric' },
        ]}
        onChange={(v) => setTweak('voice', v)}
      />

      {/* ── Mode + code themes ── */}
      <TweakSection label="UI mode" />
      <TweakRadio
        label="Mode"
        value={t.uiMode}
        options={[
          { value: 'light', label: 'Light' },
          { value: 'dark',  label: 'Dark'  },
        ]}
        onChange={(v) => setTweak('uiMode', v)}
      />

      <TweakSection label="Code theme" />
      <TweakSelect
        label="Light"
        value={t.codeTheme}
        options={lightCodeOpts}
        onChange={(v) => setTweak('codeTheme', v)}
      />
      <TweakSelect
        label="Dark"
        value={t.codeThemeDark}
        options={darkCodeOpts}
        onChange={(v) => setTweak('codeThemeDark', v)}
      />
    </TweaksPanel>
  );
}

window.ThemeTweaks = ThemeTweaks;

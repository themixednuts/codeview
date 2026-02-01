import type { Attachment } from 'svelte/attachments';

let nextId = 0;
let styleInjected = false;

function injectStyles() {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .cv-tooltip[popover] {
      position: fixed;
      position-area: top;
      position-try: flip-block, flip-inline, flip-block flip-inline;
      width: max-content;
      min-width: 80px;
      max-width: 320px;
      margin: 6px 8px;
      inset: auto;
      padding: 6px 10px;
      font-size: 12px;
      line-height: 1.4;
      color: var(--ink);
      background: var(--panel-solid);
      border: 1px solid var(--panel-border);
      border-radius: var(--radius-popover);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
}

export function tooltip(text: string): Attachment {
  return (element) => {
    injectStyles();

    const anchorName = `--tt-${nextId++}`;
    const el = element as HTMLElement;
    el.style.setProperty('anchor-name', anchorName);

    const popover = document.createElement('div');
    popover.setAttribute('popover', 'manual');
    popover.setAttribute('role', 'tooltip');
    popover.className = 'cv-tooltip';
    popover.style.setProperty('position-anchor', anchorName);
    popover.textContent = text;
    document.body.appendChild(popover);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const show = () => {
      timeoutId = setTimeout(() => popover.showPopover(), 300);
    };

    const hide = () => {
      clearTimeout(timeoutId);
      popover.hidePopover();
    };

    element.addEventListener('mouseenter', show);
    element.addEventListener('mouseleave', hide);
    element.addEventListener('focusin', show);
    element.addEventListener('focusout', hide);

    return () => {
      clearTimeout(timeoutId);
      element.removeEventListener('mouseenter', show);
      element.removeEventListener('mouseleave', hide);
      element.removeEventListener('focusin', show);
      element.removeEventListener('focusout', hide);
      popover.remove();
    };
  };
}

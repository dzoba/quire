// Small hand-drawn stroke icon set (24x24 viewBox), original to this project.
const svg = body => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

export const icons = {
  library: svg('<path d="M4 4h4v16H4z"/><path d="M10 4h4v16h-4z"/><path d="M16.5 4.8l3.6 1-3.9 14.4-3.6-1"/>'),
  toc: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
  bookmark: svg('<path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/>'),
  bookmarkFilled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/></svg>',
  type: svg('<path d="M3 19L8 6l5 13M4.8 14.5h6.4"/><path d="M14.5 12.5c.6-1.2 1.7-1.8 3-1.8 1.8 0 3 1 3 2.8V19m0-3.6c-.8-.4-1.6-.6-2.6-.6-1.7 0-3 .8-3 2.2 0 1.2 1 2 2.3 2 1.6 0 2.8-.9 3.3-2.2"/>'),
  speaker: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11"/>'),
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5.5" width="4" height="13" rx="1"/><rect x="13.5" y="5.5" width="4" height="13" rx="1"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/></svg>',
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  left: svg('<path d="M15 5l-7 7 7 7"/>'),
  right: svg('<path d="M9 5l7 7-7 7"/>'),
  chevron: svg('<path d="M9 6l6 6-6 6"/>'),
  upload: svg('<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5"/><path d="M4 14v4.5A1.5 1.5 0 005.5 20h13a1.5 1.5 0 001.5-1.5V14"/>'),
  trash: svg('<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>'),
  alert: svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.2v.1"/>'),
  file: svg('<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/>'),
  keyboard: svg('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>'),
  book: svg('<path d="M4 5.5C6.5 4.5 9.5 4.5 12 6c2.5-1.5 5.5-1.5 8-.5v13c-2.5-1-5.5-1-8 .5-2.5-1.5-5.5-1.5-8-.5z"/><path d="M12 6v13"/>'),
  scroll: svg('<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M12 7v6M9.5 10.5L12 13l2.5-2.5"/>'),
  pages: svg('<rect x="3" y="5" width="8" height="14" rx="1.5"/><rect x="13" y="5" width="8" height="14" rx="1.5"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>'),
}

export const icon = (name, cls = '') => {
  const span = document.createElement('span')
  span.innerHTML = icons[name]
  const el = span.firstElementChild
  if (cls) el.classList.add(cls)
  return el
}

// Replace every <i data-icon="name"></i> in a root with the SVG.
export const hydrateIcons = (root = document) => {
  for (const el of root.querySelectorAll('i[data-icon]')) el.replaceWith(icon(el.dataset.icon))
}

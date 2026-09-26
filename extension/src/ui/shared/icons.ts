// Inline outline icons (24×24 viewBox, stroke 1.8, round caps). No icon fonts, no CDN.

const icon = (body: string) => `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;

export const ICONS = {
  settings: icon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  sliders: icon('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
  chevronRight: icon('<path d="m9 18 6-6-6-6"/>'),
  chevronLeft: icon('<path d="m15 18-6-6 6-6"/>'),
  avatar: icon('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  mic: icon('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8"/>'),
  code: icon('<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>'),
  sparkle: icon('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>'),
  close: icon('<path d="M18 6 6 18M6 6l12 12"/>'),
  pin: icon('<path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4z"/>'),
  expand: icon('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
  move: icon('<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>'),
  reset: icon('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  minus: icon('<path d="M5 12h14"/>'),
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
  check: icon('<path d="M20 6 9 17l-5-5"/>'),
} as const;

/** Schematic silhouettes for the camera preset buttons (no raster assets). */
export const PRESET_SILHOUETTES = {
  face: `<svg viewBox="0 0 48 40" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="19" r="12"/><path d="M12 40c1-6 6-8 12-8s11 2 12 8"/></svg>`,
  waist: `<svg viewBox="0 0 48 40" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="9" r="6"/><path d="M13 40V25c0-5 5-9 11-9s11 4 11 9v15"/></svg>`,
  'full-body': `<svg viewBox="0 0 48 40" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="5" r="3.5"/><path d="M18 21v-6c0-3 3-5 6-5s6 2 6 5v6M20 21v17M28 21v17M18 21h12"/></svg>`,
} as const;

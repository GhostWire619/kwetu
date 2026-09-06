/**
 * Kwetu early-playable surface prototype — the play HUD overlay.
 *
 * Plain-DOM overlay on top of the WebGL2 canvas: title, local-test status,
 * mode/speed readout, the two prototype buttons (reset position, space view)
 * and expandable help + credits. No framework, no dependency, no network, no
 * external font — system font stack only. The overlay is inert to the pointer
 * except its interactive controls, so the canvas keeps receiving mouse input
 * underneath it.
 *
 * [PLACEHOLDER — i18n] docs/swahili-i18n.md §2 makes gettext PO the source of
 * truth, and this module's strings belong in the `play/` domain (msgctxt
 * `play/`, flat `play/<msgid>` keys — the same shape `locales/po/*.default.po`
 * compiles from). The i18n runtime does not exist yet, so the bounded
 * prototype carries an EN+sw dictionary keyed in that exact shape, in this one
 * module, per the task brief. The keys below are PROPOSALS pending native
 * speaker review (§8) — the credits panel says so on screen, and both
 * languages land in the same change (§1). Migration is a key-for-key lift into
 * `locale/po/play/{en,sw}.po`; renaming an English msgid later is a key rename.
 *
 * Attribution strings are NOT in the dictionary: ATTRIBUTIONS.md fixes legal
 * strings verbatim in every UI language, so they are module constants instead.
 */

export type PlayHudMode = 'walk' | 'drive' | 'loading' | 'error';

export interface PlayHudState {
  mode: PlayHudMode;
  /** Ground speed in m/s (readout only; the HUD never derives game state). */
  speed: number;
  /** Runtime detail for loading/error. Rendered via textContent, never HTML. */
  message?: string;
}

export interface PlayHudCallbacks {
  /** Reset the avatar/vehicle to its spawn pose (the R control). */
  onReset: () => void;
  /** Toggle the space/orbit camera view. */
  onMode: () => void;
}

export interface PlayHud {
  /** Push a frame of state. Safe to call every frame. */
  update(state: PlayHudState): void;
  /** Removes the DOM nodes, the injected style and every listener. */
  dispose(): void;
}

/**
 * Legal attribution strings — verbatim from ATTRIBUTIONS.md and never
 * translated (a translated license notice is not the notice the licensor
 * requires). Copernicus' `[year]` is substituted at build time upstream; the
 * build has no substitution hook yet, so the publication year of the products
 * actually used is fixed here [PLACEHOLDER — wire the build substitution
 * before the Copernicus DEM row lands in THIRD_PARTY_ASSETS.md]. An
 * unsubstituted `[year]` rendering is a build error, never a shipped string.
 */
const ATTR_COPERNICUS = 'Contains modified Copernicus data 2026';
const ATTR_NASA = 'Terrain and imagery data courtesy of NASA and the U.S. Geological Survey.';
const ATTR_NASA_NO_ENDORSEMENT =
  'Kwetu is not affiliated with, endorsed by, or sponsored by NASA or the U.S. Geological Survey.';
const ATTR_SOFTWARE =
  'Kwetu is open source under the Apache License 2.0. The bundled-code ledger is in THIRD_PARTY_ASSETS.md.';

/** English source strings — the msgids. `as const` keys the sw side below. */
const EN = {
  'play/Kwetu': 'Kwetu', // product name — glossary §8 keeps it untranslated
  'play/Early playable surface prototype': 'Early playable surface prototype',
  'play/Local test — single player, no account, nothing is saved':
    'Local test — single player, no account, nothing is saved',
  'play/Walking': 'Walking',
  'play/Driving': 'Driving',
  'play/Loading': 'Loading',
  'play/Error': 'Error',
  'play/Speed': 'Speed',
  'play/Reset': 'Reset',
  'play/Space view': 'Space view',
  'play/Help': 'Help',
  'play/Credits': 'Credits',
  'play/Controls': 'Controls',
  'play/Data sources': 'Data sources',
  'play/Software': 'Software',
  'play/Move (walk and drive)': 'Move (walk and drive)',
  'play/Look': 'Look',
  'play/Jump / brake': 'Jump / brake',
  'play/Enter or exit the vehicle': 'Enter or exit the vehicle',
  'play/Reset position and heading': 'Reset position and heading',
  'play/Release the pointer': 'Release the pointer',
  'play/Language': 'Language',
  'play/Switch to English': 'Switch to English',
  'play/Switch to Kiswahili': 'Switch to Kiswahili',
  'play/Terrain note': 'Terrain here is real elevation data.',
  'play/Props note': 'Visible test props are original Kwetu work, not third-party assets.',
  'play/Swahili review note':
    'Swahili wording in this overlay is a machine draft awaiting native-speaker review.',
  'play/m/s': 'm/s',
} as const;

type MsgKey = keyof typeof EN;
type Lang = 'sw' | 'en';

/** Swahili renderings — every entry is a PROPOSAL pending native review (§8). */
const SW: Record<MsgKey, string> = {
  'play/Kwetu': 'Kwetu',
  'play/Early playable surface prototype': 'Kiolezo cha majaribio cha uso wa ardhi',
  'play/Local test — single player, no account, nothing is saved':
    'Jaribio la ndani — mchezaji mmoja, hakuna akaunti, hakuna kilichohifadhiwa',
  'play/Walking': 'Kutembea',
  'play/Driving': 'Kuendesha',
  'play/Loading': 'Inapakia',
  'play/Error': 'Hitilafu',
  'play/Speed': 'Kasi',
  'play/Reset': 'Anza upya',
  'play/Space view': 'Mwonekano wa anga',
  'play/Help': 'Msaada',
  'play/Credits': 'Shukrani',
  'play/Controls': 'Vidhibiti',
  'play/Data sources': 'Vyanzo vya data',
  'play/Software': 'Programu',
  'play/Move (walk and drive)': 'Sogeza (kutembea na kuendesha)',
  'play/Look': 'Angalia',
  'play/Jump / brake': 'Ruka / Breki',
  'play/Enter or exit the vehicle': 'Ingia au toka gari',
  'play/Reset position and heading': 'Rejesha mahali na mwelekeo',
  'play/Release the pointer': 'Fungua kipanya',
  'play/Language': 'Lugha',
  'play/Switch to English': 'Badilisha kwa English',
  'play/Switch to Kiswahili': 'Badilisha kwa Kiswahili',
  'play/Terrain note': 'Ardhi hapa ni data halisi ya mwinuko.',
  'play/Props note': 'Vitu vya majaribio vinavyoonekana ni kazi ya asili ya Kwetu, si mali ya watu wengine.',
  'play/Swahili review note': 'Maneno ya Kiswahili hapa ni rasimu ya kompyuta na yanahitaji ukaguzi na msemaji wa asili.',
  'play/m/s': 'm/s',
};

// Swahili is the default for the prototype; EN is the fallback language.
const STRINGS: Record<Lang, Record<MsgKey, string>> = { sw: SW, en: EN };
const MODE_KEY: Record<PlayHudMode, MsgKey> = {
  walk: 'play/Walking',
  drive: 'play/Driving',
  loading: 'play/Loading',
  error: 'play/Error',
};

const STYLE_ID = 'kwetu-play-hud-style';
const ROOT_ID = 'kwetu-play-hud';

/**
 * Isolated by the `#kwetu-play-hud` id — every rule descends from it, so the
 * overlay cannot restyle the page and the page cannot restyle the overlay.
 * Restrained: one translucent panel treatment, one accent, no icon font, no
 * external asset, no animation beyond a loading pulse (which honors
 * prefers-reduced-motion).
 */
const CSS = `
#kwetu-play-hud {
  --kph-ink: #f1efe9;
  --kph-dim: #b3aea3;
  --kph-panel: rgba(14, 16, 18, 0.78);
  --kph-edge: rgba(241, 239, 233, 0.18);
  --kph-accent: #e0b45c;
  --kph-danger: #e26a5c;
  --kph-pad: clamp(8px, 1.5vmin, 18px);
  position: fixed;
  inset: 0;
  z-index: 60;
  pointer-events: none;
  color: var(--kph-ink);
  font: 500 clamp(12px, 1.3vmin, 14px) / 1.45 system-ui, 'Segoe UI', Roboto, sans-serif;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
}
#kwetu-play-hud *, #kwetu-play-hud *::before, #kwetu-play-hud *::after { box-sizing: border-box; }
#kwetu-play-hud p, #kwetu-play-hud dl, #kwetu-play-hud dd, #kwetu-play-hud h2 {
  margin: 0;
  padding: 0;
}
#kwetu-play-hud button, #kwetu-play-hud summary { font: inherit; color: inherit; text-shadow: inherit; }

.kwetu-ph__corner { position: absolute; display: flex; flex-direction: column; gap: calc(var(--kph-pad) * 0.5); }
.kwetu-ph__corner--tl { top: var(--kph-pad); left: var(--kph-pad); max-width: min(88vw, 30rem); }
.kwetu-ph__corner--tr { top: var(--kph-pad); right: var(--kph-pad); align-items: flex-end; max-width: min(88vw, 30rem); }
.kwetu-ph__corner--bl { bottom: var(--kph-pad); left: var(--kph-pad); }
.kwetu-ph__corner--br { bottom: var(--kph-pad); right: var(--kph-pad); align-items: flex-end; }

.kwetu-ph__panel {
  background: var(--kph-panel);
  border: 1px solid var(--kph-edge);
  border-radius: 10px;
  padding: calc(var(--kph-pad) * 0.6) calc(var(--kph-pad) * 0.85);
  backdrop-filter: blur(6px);
}
.kwetu-ph__title { font-size: 1.35em; font-weight: 650; letter-spacing: 0.04em; }
.kwetu-ph__subtitle { color: var(--kph-dim); font-size: 0.9em; }
.kwetu-ph__status-row { display: flex; align-items: center; gap: 0.5em; margin-top: 0.35em; }
.kwetu-ph__dot {
  flex: none; width: 0.55em; height: 0.55em; border-radius: 50%;
  background: var(--kph-accent);
}
#kwetu-play-hud[data-mode='loading'] .kwetu-ph__dot { animation: kph-pulse 1.4s ease-in-out infinite; }
#kwetu-play-hud[data-mode='error'] .kwetu-ph__dot,
#kwetu-play-hud[data-mode='error'] .kwetu-ph__error { color: var(--kph-danger); }
@keyframes kph-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { #kwetu-play-hud .kwetu-ph__dot { animation: none; } }

.kwetu-ph__error { display: none; margin-top: 0.35em; }
#kwetu-play-hud[data-mode='error'] .kwetu-ph__error { display: block; }

.kwetu-ph__speed { display: flex; align-items: baseline; gap: 0.5em; min-width: 9.5em; }
.kwetu-ph__speed-label { color: var(--kph-dim); font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.08em; }
.kwetu-ph__speed-value { font-variant-numeric: tabular-nums; font-weight: 650; }

.kwetu-ph__row { display: flex; gap: calc(var(--kph-pad) * 0.5); }
.kwetu-ph__btn {
  pointer-events: auto;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid var(--kph-edge);
  border-radius: 8px;
  padding: 0.45em 0.85em;
}
.kwetu-ph__btn:hover { background: rgba(255, 255, 255, 0.14); }
.kwetu-ph__btn:focus-visible, #kwetu-play-hud summary:focus-visible { outline: 2px solid var(--kph-accent); outline-offset: 2px; }

#kwetu-play-hud details { max-width: inherit; }
#kwetu-play-hud summary {
  pointer-events: auto;
  cursor: pointer;
  list-style: none;
  user-select: none;
  background: var(--kph-panel);
  border: 1px solid var(--kph-edge);
  border-radius: 8px;
  padding: 0.45em 0.85em;
  backdrop-filter: blur(6px);
}
#kwetu-play-hud summary::-webkit-details-marker { display: none; }
#kwetu-play-hud summary::before { content: '▸ '; color: var(--kph-accent); }
#kwetu-play-hud details[open] summary::before { content: '▾ '; }
.kwetu-ph__body { margin-top: calc(var(--kph-pad) * 0.5); }
.kwetu-ph__body dt { color: var(--kph-dim); }
.kwetu-ph__body dd { margin: 0; }
.kwetu-ph__controls { display: grid; grid-template-columns: auto 1fr; gap: 0.3em 0.8em; }
.kwetu-ph__body kbd {
  font: inherit; font-variant-numeric: tabular-nums;
  border: 1px solid var(--kph-edge); border-radius: 5px;
  background: rgba(255, 255, 255, 0.08); padding: 0.05em 0.4em;
}
.kwetu-ph__notes { display: grid; gap: 0.3em; color: var(--kph-dim); font-size: 0.92em; }
.kwetu-ph__legal { display: grid; gap: 0.45em; font-size: 0.88em; color: var(--kph-dim); }
.kwetu-ph__review { margin-top: 0.6em; padding-top: 0.5em; border-top: 1px solid var(--kph-edge); font-size: 0.85em; }

@media (max-width: 640px) {
  #kwetu-play-hud { font-size: 11px; }
  .kwetu-ph__corner--tl, .kwetu-ph__corner--tr { max-width: 62vw; }
  .kwetu-ph__speed { min-width: 0; }
  .kwetu-ph__row { flex-wrap: wrap; }
}
@media (max-width: 640px) and (orientation: landscape) {
  .kwetu-ph__corner--tr { max-width: 74vw; }
}
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
}

/** Locale-aware number formatting, cached — update() runs every frame. */
const SPEED_FORMATTERS = new Map<Lang, Intl.NumberFormat>();
function speedFormatter(lang: Lang): Intl.NumberFormat {
  let fmt = SPEED_FORMATTERS.get(lang);
  if (!fmt) {
    // §5: formatting follows the player-chosen locale, never the platform's.
    fmt = new Intl.NumberFormat(lang === 'sw' ? 'sw-TZ' : 'en', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    SPEED_FORMATTERS.set(lang, fmt);
  }
  return fmt;
}

function formatSpeed(speed: number, lang: Lang, unit: string): string {
  if (!Number.isFinite(speed)) return `— ${unit}`;
  return `${speedFormatter(lang).format(speed)} ${unit}`;
}

export function createPlayHud({ onReset, onMode }: PlayHudCallbacks): PlayHud {
  let lang: Lang = 'sw';
  let mode: PlayHudMode = 'loading';
  let message: string | undefined;
  let speed = 0;
  let disposed = false;

  // Every listener hangs off this signal, so dispose() is one abort.
  const listeners = new AbortController();

  // Style: one element per id; only the instance that created it removes it.
  const style = document.getElementById(STYLE_ID) ?? document.createElement('style');
  if (!style.isConnected) {
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.dataset.mode = mode;

  // Top-left: identity + local-test status.
  const topLeft = el('div', 'kwetu-ph__corner kwetu-ph__corner--tl', root);
  const identity = el('div', 'kwetu-ph__panel', topLeft);
  const title = el('h2', 'kwetu-ph__title', identity);
  const subtitle = el('p', 'kwetu-ph__subtitle', identity);
  const statusRow = el('p', 'kwetu-ph__status-row', identity);
  el('span', 'kwetu-ph__dot', statusRow);
  // Polite live region: mode changes and loading progress announce, without
  // stealing focus. The speed readout deliberately stays out of it — a
  // per-frame value in a live region would announce continuously.
  const status = el('span', 'kwetu-ph__status', statusRow);
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const errorLine = el('p', 'kwetu-ph__error', identity);
  errorLine.setAttribute('role', 'alert');

  // Bottom-left: speed readout.
  const bottomLeft = el('div', 'kwetu-ph__corner kwetu-ph__corner--bl', root);
  const speedPanel = el('p', 'kwetu-ph__panel kwetu-ph__speed', bottomLeft);
  const speedLabel = el('span', 'kwetu-ph__speed-label', speedPanel);
  const speedValue = el('span', 'kwetu-ph__speed-value', speedPanel);

  // Top-right: language toggle + the two expandable panels.
  const topRight = el('div', 'kwetu-ph__corner kwetu-ph__corner--tr', root);
  const toggles = el('div', 'kwetu-ph__row', topRight);
  const langButton = el('button', 'kwetu-ph__btn', toggles);
  langButton.type = 'button';

  const help = el('details', 'kwetu-ph__details', topRight);
  const helpSummary = el('summary', 'kwetu-ph__summary', help);
  const helpBody = el('div', 'kwetu-ph__body kwetu-ph__panel', help);
  const controlsHeading = el('p', 'kwetu-ph__subtitle', helpBody);
  const controls = el('dl', 'kwetu-ph__controls', helpBody);
  const CONTROL_KEYS: ReadonlyArray<readonly [string, MsgKey]> = [
    ['W A S D', 'play/Move (walk and drive)'],
    ['← ↑ → ↓', 'play/Look'],
    ['Space', 'play/Jump / brake'],
    ['E', 'play/Enter or exit the vehicle'],
    ['R', 'play/Reset position and heading'],
    ['Esc', 'play/Release the pointer'],
  ];
  const controlActions: HTMLElement[] = [];
  for (const [key, labelKey] of CONTROL_KEYS) {
    const dt = el('dt', 'kwetu-ph__key', controls);
    const kbd = el('kbd', '', dt);
    kbd.textContent = key;
    const dd = el('dd', 'kwetu-ph__action', controls);
    dd.textContent = STRINGS.sw[labelKey];
    controlActions.push(dd);
  }

  const credits = el('details', 'kwetu-ph__details', topRight);
  const creditsSummary = el('summary', 'kwetu-ph__summary', credits);
  const creditsBody = el('div', 'kwetu-ph__body kwetu-ph__panel', credits);
  const dataHeading = el('p', 'kwetu-ph__subtitle', creditsBody);
  const legal = el('div', 'kwetu-ph__legal', creditsBody);
  const copernicusLine = el('p', 'kwetu-ph__legal-line', legal);
  const nasaLine = el('p', 'kwetu-ph__legal-line', legal);
  const noEndorsementLine = el('p', 'kwetu-ph__legal-line', legal);
  const softwareHeading = el('p', 'kwetu-ph__subtitle', creditsBody);
  const softwareLine = el('p', 'kwetu-ph__legal-line', legal);
  const notes = el('div', 'kwetu-ph__notes', creditsBody);
  const terrainNote = el('p', 'kwetu-ph__note', notes);
  const propsNote = el('p', 'kwetu-ph__note', notes);
  const reviewNote = el('p', 'kwetu-ph__review', notes);

  // Bottom-right: the two prototype actions.
  const bottomRight = el('div', 'kwetu-ph__corner kwetu-ph__corner--br', root);
  const actions = el('div', 'kwetu-ph__row', bottomRight);
  const resetButton = el('button', 'kwetu-ph__btn', actions);
  resetButton.type = 'button';
  const spaceButton = el('button', 'kwetu-ph__btn', actions);
  spaceButton.type = 'button';

  document.body.appendChild(root);

  langButton.addEventListener(
    'click',
    () => {
      lang = lang === 'sw' ? 'en' : 'sw';
      applyLang();
      applyState();
    },
    { signal: listeners.signal },
  );
  resetButton.addEventListener('click', () => onReset(), { signal: listeners.signal });
  spaceButton.addEventListener('click', () => onMode(), { signal: listeners.signal });

  /** Sets every static label from the active dictionary. */
  function applyLang(): void {
    const t = (key: MsgKey): string => STRINGS[lang][key];
    title.textContent = t('play/Kwetu');
    subtitle.textContent = t('play/Early playable surface prototype');
    speedLabel.textContent = t('play/Speed');
    // The accessible name contains the visible text (WCAG 2.5.3 label-in-name).
    const targetLang = lang === 'sw' ? 'English' : 'Kiswahili';
    langButton.textContent = targetLang;
    langButton.setAttribute('aria-label', `${t('play/Language')}: ${targetLang}`);
    helpSummary.textContent = t('play/Help');
    creditsSummary.textContent = t('play/Credits');
    controlsHeading.textContent = t('play/Controls');
    CONTROL_KEYS.forEach(([, labelKey], i) => {
      controlActions[i]!.textContent = t(labelKey);
    });
    dataHeading.textContent = t('play/Data sources');
    softwareHeading.textContent = t('play/Software');
    terrainNote.textContent = t('play/Terrain note');
    propsNote.textContent = t('play/Props note');
    reviewNote.textContent = t('play/Swahili review note');
    // Legal strings stay verbatim in every UI language (ATTRIBUTIONS.md).
    copernicusLine.textContent = ATTR_COPERNICUS;
    nasaLine.textContent = ATTR_NASA;
    noEndorsementLine.textContent = ATTR_NASA_NO_ENDORSEMENT;
    softwareLine.textContent = ATTR_SOFTWARE;
    root.lang = lang === 'sw' ? 'sw' : 'en';
    applyState();
  }

  /** Sets the per-frame parts: mode label, live status, error line, speed. */
  function applyState(): void {
    const t = (key: MsgKey): string => STRINGS[lang][key];
    root.dataset.mode = mode;
    status.textContent = t(MODE_KEY[mode]);
    // Runtime text goes through textContent only — never innerHTML.
    errorLine.textContent = mode === 'error' ? (message ?? t('play/Error')) : '';
    speedValue.textContent = formatSpeed(speed, lang, t('play/m/s'));
  }

  function update(state: PlayHudState): void {
    mode = state.mode;
    speed = state.speed;
    message = state.message;
    applyState();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    listeners.abort();
    root.remove();
    if (style.isConnected && style.textContent === CSS) style.remove();
  }

  applyLang();

  return { update, dispose };
}

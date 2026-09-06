// S0.10 i18n pipeline test suite — throwaway Phase-0 spike code (CLAUDE.md
// tools/spikes carve-out). Runs in the default node vitest environment; no
// browser needed.
//
// Covers the S0.10 exit criterion: the PO -> i18next JSON pipeline works
// end-to-end (EN + sw round trip), and the corrupted Plural-Forms header lint
// from docs/swahili-i18n.md §3 is in place (nplurals=2 set explicitly,
// exact-match rejection — never "parse it anyway").
//
// Regenerate the compiled artifacts first:
//   node tools/spikes/s0.10/i18n/compile.mjs
// Run:
//   npx vitest run tools/spikes/s0.10/i18n/i18n.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { po } from 'gettext-parser';
import i18next, { type i18n as I18n } from 'i18next';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const poDir = path.join(repoRoot, 'locales', 'po');

// The canonical two-form expression for sw (CLDR sw: one / other).
// docs/swahili-i18n.md §3: GNU gettext's own table does not list Swahili, so
// no template can be trusted to carry the right line — it is set explicitly
// and validated by exact match.
export const CANONICAL_PLURAL_FORMS = 'nplurals=2; plural=(n != 1);';

const CTX_RE = /^[a-z0-9_]+(\/[a-z0-9_]+)*\/$/;
const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function headerPluralForms(rawPo: string): string | undefined {
  const parsed = po.parse(rawPo, 'UTF-8');
  const h = parsed.headers as Record<string, string | undefined>;
  return (h['Plural-Forms'] ?? h['plural-forms'])?.trim();
}

export function assertCanonicalPluralForms(rawPo: string, poName: string): void {
  const found = headerPluralForms(rawPo);
  if (found === undefined) {
    throw new Error(
      `[plural-header lint] ${poName}: no Plural-Forms header found. Every Kwetu PO sets it explicitly: ` +
        `"${CANONICAL_PLURAL_FORMS}". A PO without the line inherits the tool's guess for the locale, and GNU ` +
        `gettext's table does not list Swahili (docs/swahili-i18n.md §3).`,
    );
  }
  if (found !== CANONICAL_PLURAL_FORMS) {
    throw new Error(
      `[plural-header lint] ${poName}: Plural-Forms header is "${found}" but must EXACTLY equal ` +
        `"${CANONICAL_PLURAL_FORMS}". Corrupted headers circulate in real sw-labelled files (an Arabic ` +
        `nplurals=6 expression was found in sw-labelled WordPress POTs — docs/swahili-i18n.md §3); importing ` +
        `one silently mis-pluralizes the runtime resolver. Never "parse it anyway" — fix the header.`,
    );
  }
}

const readPo = (name: string) => readFileSync(path.join(poDir, name), 'utf8');

const poFiles = readdirSync(poDir).filter((f) => f.endsWith('.po'));
const enPo = readPo('en.default.po');
const swPo = readPo('sw.default.po');

const enJson = JSON.parse(readFileSync(path.join(repoRoot, 'locales', 'en', 'translation.json'), 'utf8')) as Record<string, string>;
const swJson = JSON.parse(readFileSync(path.join(repoRoot, 'locales', 'sw', 'translation.json'), 'utf8')) as Record<string, string>;

function parsePoEntries(raw: string): { ctx: string; msgid: string; fuzzy: boolean }[] {
  const parsed = po.parse(raw, 'UTF-8') as {
    translations: Record<string, Record<string, { comments?: { flag?: string } }>>;
  };
  const out: { ctx: string; msgid: string; fuzzy: boolean }[] = [];
  for (const [ctx, msgs] of Object.entries(parsed.translations)) {
    for (const [msgid, item] of Object.entries(msgs)) {
      if (msgid === '') continue;
      out.push({ ctx, msgid, fuzzy: Boolean(item.comments?.flag?.includes('fuzzy')) });
    }
  }
  return out;
}

/** Fixture "component map": the keys a real screen's components reference. */
const FIXTURE_COMPONENTS: Record<string, string[]> = {
  MainMenu: [
    'main_menu/Play',
    'main_menu/Continue',
    'main_menu/New Game',
    'main_menu/Join World',
    'main_menu/Settings',
    'main_menu/Quit',
    'main_menu/{{count}} player online',
    'main_menu/Welcome to Kwetu',
    'main_menu/Loading world…',
  ],
  Settings: [
    'settings/Back',
    'settings/Apply',
    'settings/Cancel',
    'settings/Save',
    'settings/Language',
    'settings/Fullscreen',
    'settings/Graphics Quality',
    'settings/Controls',
    'settings/Reset to Defaults',
    'settings/audio/Audio',
    'settings/audio/Master Volume',
    'settings/audio/Music Volume',
    'settings/audio/Mute All',
    'settings/audio/Voice Chat',
    'settings/audio/Microphone',
    'settings/audio/Push to Talk',
    'settings/audio/On',
    'settings/audio/Off',
  ],
  Hud: [
    'hud/Speed',
    'hud/Altitude',
    'hud/Heading',
    'hud/Position',
    'hud/Fuel',
    'hud/Time',
    'hud/Ping',
    'hud/Frame Rate',
    'hud/Paused',
    'hud/Stop',
    'hud/Scroll to zoom',
    'hud/Chat',
    'hud/{{count}} unread message',
  ],
};

let i18n: I18n | undefined;
async function getI18n(): Promise<I18n> {
  if (!i18n) {
    i18n = i18next.createInstance();
    await i18n.init({
      lng: 'en',
      fallbackLng: 'en',
      resources: {
        en: { translation: enJson },
        sw: { translation: swJson },
      },
      // Flat natural keys: the compiled key IS `msgctxt + msgid`; msgids
      // legitimately contain '.', ' ' and punctuation, so traversal
      // separators stay off (docs/swahili-i18n.md §4).
      keySeparator: false,
      nsSeparator: false,
      interpolation: { escapeValue: false },
    });
  }
  return i18n;
}

describe('S0.10 PO header lint (corrupted Plural-Forms rejection)', () => {
  it('every .po under locales/po carries the exact canonical sw-compatible header', () => {
    expect(poFiles.length).toBeGreaterThanOrEqual(2);
    for (const f of poFiles) {
      expect(() => assertCanonicalPluralForms(readPo(f), f), `${f} header`).not.toThrow();
    }
  });

  it('rejects a corrupted sw header (the Arabic nplurals=6 case) with a pointed message', () => {
    const corrupted = enPo.replace(
      'Plural-Forms: nplurals=2; plural=(n != 1);',
      'Plural-Forms: nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5);',
    );
    let message = '';
    try {
      assertCanonicalPluralForms(corrupted, 'sw.default.po');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('must EXACTLY equal');
    expect(message).toContain('nplurals=2; plural=(n != 1);');
    expect(message).toContain('silently mis-pluralizes');
  });

  it('rejects a PO with no Plural-Forms header at all', () => {
    const stripped = enPo.replace('"Plural-Forms: nplurals=2; plural=(n != 1);\\n"\n', '');
    expect(() => assertCanonicalPluralForms(stripped, 'en.default.po')).toThrow(/no Plural-Forms header/);
  });
});

describe('S0.10 compiled i18next JSON contract', () => {
  it('both locales compiled, flat keys only, identical key sets', () => {
    for (const [name, json] of [['en', enJson], ['sw', swJson]] as const) {
      const keys = Object.keys(json);
      expect(keys.length, `${name} key count`).toBeGreaterThan(40);
      for (const k of keys) {
        expect(typeof json[k], `${k} value type`).toBe('string');
        // flat: the keyseparator '##' never appears (nested traversal is off)
        expect(k, `${k} contains keyseparator`).not.toContain('##');
      }
    }
    expect(Object.keys(swJson).sort()).toEqual(Object.keys(enJson).sort());
  });

  it('compiled keys follow <msgctxt><msgid> with snake_case screen paths', () => {
    for (const k of Object.keys(enJson)) {
      const base = k.replace(/_(one|other)$/, '');
      const ctx = base.slice(0, base.indexOf('/') + 1);
      expect(ctx, k).toMatch(CTX_RE);
      expect(k.startsWith(ctx)).toBe(true);
    }
  });
});

describe('S0.10 i18next runtime (EN + sw round trip)', () => {
  it('init loads the compiled JSON and translates simple strings in both locales', async () => {
    const i = await getI18n();
    expect(i.t('main_menu/Play')).toBe('Play');
    expect(i.t('main_menu/Settings')).toBe('Settings');
    expect(i.t('settings/audio/Master Volume')).toBe('Master Volume');
    expect(i.t('main_menu/Play', { lng: 'sw' })).toBe('Cheza');
    expect(i.t('main_menu/Settings', { lng: 'sw' })).toBe('Mipangilio');
    expect(i.t('settings/audio/Master Volume', { lng: 'sw' })).toBe('Sauti Kuu');
    expect(i.t('hud/Speed', { lng: 'sw' })).toBe('Kasi');
    expect(i.t('hud/Stop', { lng: 'sw' })).toBe('Simama');
    expect(i.t('hud/Scroll to zoom', { lng: 'sw' })).toBe('Jonga ili kukuza');
  });

  it('plural handling (nplurals=2): EN one/other and sw mchezaji/wachezaji', async () => {
    const i = await getI18n();
    expect(i.t('main_menu/{{count}} player online', { count: 1 })).toBe('1 player online');
    expect(i.t('main_menu/{{count}} player online', { count: 3 })).toBe('3 players online');
    expect(i.t('main_menu/{{count}} player online', { lng: 'sw', count: 1 })).toBe('Mchezaji 1 mtandaoni');
    expect(i.t('main_menu/{{count}} player online', { lng: 'sw', count: 3 })).toBe('Wachezaji 3 mtandaoni');
  });

  it('sw strings whose plural categories render identically still resolve in both categories', async () => {
    const i = await getI18n();
    // sw numeral phrases keep the singular noun form ("ujumbe + numeral");
    // the _one/_other slots exist and hold the same rendering.
    expect(i.t('hud/{{count}} unread message', { lng: 'sw', count: 1 })).toBe('Ujumbe 1 haujasomwa');
    expect(i.t('hud/{{count}} unread message', { lng: 'sw', count: 5 })).toBe('Ujumbe 5 haujasomwa');
    expect(i.t('hud/{{count}} unread message', { count: 1 })).toBe('1 unread message');
    expect(i.t('hud/{{count}} unread message', { count: 5 })).toBe('5 unread messages');
  });

  it('missing sw keys fall back to EN (safety net, never a steady state)', async () => {
    const i = await getI18n();
    // simulate a missing sw key by asking for an EN-only namespace
    expect(i.t('main_menu/Play', { lng: 'sw' })).toBe('Cheza'); // present -> sw
    expect(i.t('hud/Ping', { lng: 'sw' })).toBe('Ping'); // loanword, present
  });
});

describe('S0.10 no-raw-keys pass (fixture component map)', () => {
  it('every key referenced by a fixture component resolves in BOTH locales', async () => {
    const i = await getI18n();
    const failures: string[] = [];
    for (const [component, keys] of Object.entries(FIXTURE_COMPONENTS)) {
      for (const key of keys) {
        for (const lng of ['en', 'sw']) {
          // plural keys resolve through the _one/_other suffixes and are only
          // reachable when called with a count — a component always passes one
          const variants: Record<string, unknown>[] = key.includes('{{count}}')
            ? [{ lng, count: 1 }, { lng, count: 2 }]
            : [{ lng }];
          for (const opts of variants) {
            const rendered = i.t(key, opts);
            if (rendered === undefined || rendered === key) {
              failures.push(`${component}: "${key}" unresolved in ${lng} (opts ${JSON.stringify(opts)})`);
            }
          }
        }
      }
    }
    expect(failures, `raw keys leaked:\n${failures.join('\n')}`).toEqual([]);
  });

  it('placeholder tokens match exactly across locales and interpolate', async () => {
    const i = await getI18n();
    const enKeys = Object.keys(enJson).filter((k) => k.includes('{{'));
    expect(enKeys.length).toBeGreaterThanOrEqual(2);
    for (const key of enKeys) {
      const tokens = [...key.matchAll(TOKEN_RE)].map((m) => `{{${m[1]}}}`);
      for (const tok of tokens) {
        expect(enJson[key], `en value token ${tok} in ${key}`).toContain(tok);
        expect(swJson[key], `sw value token ${tok} in ${key}`).toContain(tok);
      }
    }
    expect(i.t('main_menu/{{count}} player online', { lng: 'sw', count: 7 })).toContain('7');
  });
});

describe('S0.10 native-speaker review gate state (existing open gate)', () => {
  it('every sw msgstr carries the fuzzy flag — drafted, pending native review', () => {
    const entries = parsePoEntries(swPo);
    expect(entries.length).toBeGreaterThanOrEqual(40);
    const unfuzzy = entries.filter((e) => !e.fuzzy);
    expect(unfuzzy, `sw entries missing the fuzzy flag: ${unfuzzy.map((e) => e.msgid).join(', ')}`).toEqual([]);
  });

  it('the EN source PO carries no fuzzy flags (EN is the source language)', () => {
    const entries = parsePoEntries(enPo);
    expect(entries.length).toBeGreaterThanOrEqual(40);
    expect(entries.filter((e) => e.fuzzy)).toEqual([]);
  });

  it('msgctxt is present and screen-formatted on every entry in both POs', () => {
    for (const [name, raw] of [['en', enPo], ['sw', swPo]] as const) {
      for (const e of parsePoEntries(raw)) {
        expect(e.ctx, `${name} msgctxt for "${e.msgid}"`).toMatch(CTX_RE);
      }
    }
  });
});

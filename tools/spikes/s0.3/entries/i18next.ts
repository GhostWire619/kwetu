// S0.3 load-budget probe — i18next entry.
// init + t, the minimal runtime surface. Locale resources are inline here; the
// shell entry imports a JSON locale file instead (the B-LOAD-08 shape).
// Throwaway probe code (CLAUDE.md carve-out).
import i18next from 'i18next';

await i18next.init({
  lng: 'sw',
  fallbackLng: 'en',
  resources: {
    en: { translation: { 'welcome.title': 'Welcome to Kwetu' } },
    sw: { translation: { 'welcome.title': 'Karibu Kwetu' } },
  },
});

export const title: string = i18next.t('welcome.title');

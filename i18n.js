// Minimal hand-rolled i18n shared by pr-system.html and admin-panel.html.
// No bundler/module system in this project (everything is plain <script> tags against a global
// state object — see S in pr-system.html), so a library like i18next — built around ES modules
// and usually a build step — doesn't fit the existing architecture. This is the same
// fetch-a-JSON-dictionary-and-look-up-by-key idea, just without the extra dependency.
//
// Usage in either app:
//   <script src="/i18n.js"></script>
//   ... at boot, before the first render(): await I18N.init();
//   I18N.onChange(render);           // re-render whenever the language changes
//   t('nav.overview')                // returns the string for the current language
//   I18N.setLocale('en')             // switch + persist + re-render via onChange listeners
window.I18N = (function () {
  const STORAGE_KEY = 'siteLocale';
  let locale = localStorage.getItem(STORAGE_KEY) || 'th';
  let dict = {};
  let ready = false;
  const listeners = [];

  async function loadLocale(loc) {
    const res = await fetch(`/locales/${loc}.json`);
    dict = await res.json();
    locale = loc;
    ready = true;
  }

  // Missing keys return the raw key itself (not a blank string or the Thai fallback) —
  // deliberately visible so a translation gap is obvious while testing a newly-converted page,
  // per the "check no key shows up raw" testing step. Pages/strings not yet migrated to t() just
  // keep their original hardcoded Thai text and are unaffected by the language switch for now.
  // params: optional {name: value} map substituted into the translated string wherever
  // it contains a literal "{name}" placeholder — lets a single translated key carry a dynamic
  // number/name without breaking word order between Thai and English.
  function t(key, params) {
    if (!ready) return key;
    let str = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
    if (params) {
      for (const k in params) str = str.split('{' + k + '}').join(params[k]);
    }
    return str;
  }

  function getLocale() { return locale; }

  async function setLocale(loc) {
    if (loc === locale && ready) return;
    localStorage.setItem(STORAGE_KEY, loc);
    await loadLocale(loc);
    listeners.forEach(fn => fn());
  }

  function onChange(fn) { listeners.push(fn); }

  async function init() { await loadLocale(locale); }

  return { t, getLocale, setLocale, onChange, init };
})();

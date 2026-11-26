(() => {
  const themes = ['midnight', 'maize-blue', 'royal-purple', 'gold', 'green', 'pink', 'black'];
  const media = matchMedia('(prefers-color-scheme: dark)');
  let storageError = '';
  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem('ssportal.preferences') || '{}');
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid appearance preferences');
      storageError = '';
      return saved;
    } catch (error) {
      storageError = 'Saved appearance could not be read. Choose a theme to save it again.';
      console.warn(storageError, error);
      return {};
    }
  }
  let preferences = read();
  function apply() {
    const theme = themes.includes(preferences.theme) ? preferences.theme : 'green';
    const mode = ['light', 'dark', 'system'].includes(preferences.mode) ? preferences.mode : 'system';
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themeMode = mode === 'dark' || (mode === 'system' && media.matches) ? 'dark' : 'light';
    for (const button of document.querySelectorAll('#appearance-dialog [data-theme]')) button.setAttribute('aria-pressed', String(button.dataset.theme === theme));
    for (const button of document.querySelectorAll('#appearance-dialog [data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    const error = document.getElementById('appearance-error');
    if (error) { error.textContent = storageError; error.hidden = !storageError; }
  }
  function update(next) {
    preferences = { ...preferences, ...next };
    try {
      localStorage.setItem('ssportal.preferences', JSON.stringify(preferences));
      storageError = '';
    } catch (error) {
      storageError = 'Appearance changed for this page, but could not be saved. Browser storage may be unavailable.';
      console.warn(storageError, error);
    }
    apply();
  }
  apply();
  media.addEventListener('change', apply);
  window.addEventListener('storage', (event) => {
    if (event.key === 'ssportal.preferences' || event.key === null) { preferences = read(); apply(); }
  });
  window.addEventListener('academy-appearance-open', apply);
  document.addEventListener('DOMContentLoaded', () => {
    for (const button of document.querySelectorAll('#appearance-dialog [data-theme]')) button.addEventListener('click', () => update({ theme: button.dataset.theme }));
    for (const button of document.querySelectorAll('#appearance-dialog [data-mode]')) button.addEventListener('click', () => update({ mode: button.dataset.mode }));
    document.getElementById('reset-appearance').addEventListener('click', () => update({ theme: 'green', mode: 'system' }));
    apply();
  });
})();
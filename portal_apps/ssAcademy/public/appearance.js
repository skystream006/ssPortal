(() => {
  const themes = ['midnight', 'maize-blue', 'royal-purple', 'gold', 'green', 'pink', 'black'];
  const media = matchMedia('(prefers-color-scheme: dark)');
  function apply() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('ssportal.preferences') || '{}') || {}; } catch {}
    document.documentElement.dataset.theme = themes.includes(saved.theme) ? saved.theme : 'green';
    document.documentElement.dataset.themeMode = saved.mode === 'dark' || (saved.mode !== 'light' && media.matches) ? 'dark' : 'light';
  }
  apply();
  media.addEventListener('change', apply);
  window.addEventListener('storage', (event) => { if (event.key === 'ssportal.preferences') apply(); });
})();
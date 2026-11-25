try {
  const saved = JSON.parse(localStorage.getItem('ssportal.preferences') || '{}');
  const themes = ['midnight', 'maize-blue', 'royal-purple', 'gold', 'green', 'pink', 'black'];
  document.documentElement.dataset.theme = themes.includes(saved.theme) ? saved.theme : 'green';
  document.documentElement.dataset.themeMode = saved.mode === 'dark'
    || (saved.mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
} catch {}
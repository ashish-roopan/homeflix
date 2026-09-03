'use strict';
window.UI = window.UI || {};

/**
 * Settings view. `opts.firstRun` shows the welcome copy; `onSaved(settings)`
 * is called after a successful save. `onCancel` (optional) shows a back button.
 */
UI.renderSettings = function renderSettings(container, settings, { firstRun, onSaved, onCancel }) {
  const { h } = UI;
  let moviesDir = settings.moviesDir;

  const folderLabel = h('span.settings-folder-path', moviesDir || 'No folder chosen');
  const keyInput = h('input.settings-input', {
    type: 'password',
    placeholder: 'Paste your TMDB API key or read access token',
    value: settings.tmdbApiKey || '',
    autocomplete: 'off',
    spellcheck: false,
  });
  const showKey = h('button.btn.btn-ghost.btn-small', { type: 'button', onClick: () => {
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    showKey.textContent = keyInput.type === 'password' ? 'Show' : 'Hide';
  } }, 'Show');
  const minSize = h('input.settings-input.settings-input-short', {
    type: 'number',
    min: 0,
    step: 10,
    value: settings.minFileSizeMB ?? 50,
  });
  const error = h('div.settings-error', { hidden: true });
  const saveBtn = h('button.btn.btn-primary', { type: 'button' }, UI.icon('check'), h('span', firstRun ? 'Save & scan' : 'Save'));

  async function pickFolder() {
    const dir = await window.api.chooseFolder();
    if (dir) {
      moviesDir = dir;
      folderLabel.textContent = dir;
      folderLabel.classList.remove('is-empty');
    }
  }

  async function save() {
    error.hidden = true;
    if (!moviesDir) {
      error.textContent = 'Choose the folder where your movies live first.';
      error.hidden = false;
      return;
    }
    saveBtn.disabled = true;
    try {
      const saved = await window.api.saveSettings({
        moviesDir,
        tmdbApiKey: keyInput.value.trim(),
        minFileSizeMB: Number(minSize.value),
      });
      onSaved(saved);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      saveBtn.disabled = false;
    }
  }
  saveBtn.addEventListener('click', save);
  keyInput.addEventListener('keydown', (e) => e.key === 'Enter' && save());
  if (!moviesDir) folderLabel.classList.add('is-empty');

  UI.clear(container);
  container.appendChild(
    h('div.settings',
      h('div.settings-card',
        onCancel && h('button.btn.btn-ghost.settings-back', { type: 'button', onClick: onCancel }, UI.icon('back'), h('span', 'Back')),
        h('div.brand.brand-large', 'HOMEFLIX'),
        h('h1.settings-title', firstRun ? 'Welcome. Let’s set up your library.' : 'Settings'),
        firstRun && h('p.settings-lede', 'Point the app at the folder where you download movies. Every launch rescans it, identifies each film from its file name and pulls posters and details from TMDB.'),

        h('label.settings-label', 'Movies folder'),
        h('div.settings-folder',
          folderLabel,
          h('button.btn.btn-secondary', { type: 'button', onClick: pickFolder }, UI.icon('folder'), h('span', moviesDir ? 'Change' : 'Choose folder'))
        ),

        h('label.settings-label', 'TMDB API key'),
        h('div.settings-inline', keyInput, showKey),
        h('p.settings-help',
          'Free at ',
          h('a', { href: '#', onClick: (e) => { e.preventDefault(); window.api.openUrl('https://www.themoviedb.org/settings/api'); } }, 'themoviedb.org/settings/api'),
          '. Either the “API Key” or the “API Read Access Token” works. Without a key the app still lists your files, just without posters.'
        ),

        h('label.settings-label', 'Ignore files smaller than (MB)'),
        h('div.settings-inline', minSize, h('span.settings-help-inline', 'Skips samples and clips. Set 0 to include everything.')),

        error,
        h('div.settings-actions', saveBtn)
      )
    )
  );
};

/* global chrome */

const WORKER_BASE_URL = 'https://generative-proxy-demo.paolo-moz.workers.dev';

const ui = {
  headersEnabled: document.querySelector('#headers-enabled'),
  customizeHost: document.querySelector('#customize-host'),
  personalitySelect: document.querySelector('#personality-select'),
  mainPrompt: document.querySelector('#main-prompt'),
  savePrompt: document.querySelector('#save-prompt'),
  status: document.querySelector('#status'),
};

const state = {
  mainPrompt: '',
  personalities: [],
  headerState: {
    headersEnabled: true,
    activePersonalityId: '',
    customizeHost: '',
  },
};

function setStatus(message, isError = false) {
  ui.status.textContent = message;
  ui.status.classList.toggle('error', isError);
}

async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(`${WORKER_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  const contentType = response.headers.get('content-type') || '';
  const responseData = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message = responseData && typeof responseData === 'object' && responseData.error
      ? responseData.error
      : `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return responseData;
}

async function loadHeaderState() {
  const response = await chrome.runtime.sendMessage({ type: 'get-header-state' });
  if (response && response.ok && response.state) {
    state.headerState = {
      headersEnabled: Boolean(response.state.headersEnabled),
      activePersonalityId: typeof response.state.activePersonalityId === 'string'
        ? response.state.activePersonalityId
        : '',
      customizeHost: typeof response.state.customizeHost === 'string'
        ? response.state.customizeHost
        : '',
    };
  }

  ui.headersEnabled.checked = state.headerState.headersEnabled;
  ui.customizeHost.value = state.headerState.customizeHost;
}

async function loadRemoteConfig() {
  const config = await apiRequest('/api/config');

  state.mainPrompt = typeof config.mainPrompt === 'string' ? config.mainPrompt : '';
  state.personalities = Array.isArray(config.personalities) ? config.personalities : [];

  ui.mainPrompt.value = state.mainPrompt;
  renderPersonalityOptions();
}

function renderPersonalityOptions() {
  ui.personalitySelect.innerHTML = '';

  state.personalities.forEach((personality) => {
    const option = document.createElement('option');
    option.value = personality.id;
    option.textContent = personality.name;
    ui.personalitySelect.append(option);
  });

  const preferredId = state.headerState.activePersonalityId;
  const hasPreferred = state.personalities.some((item) => item.id === preferredId);

  const selectedId = hasPreferred
    ? preferredId
    : (state.personalities[0] ? state.personalities[0].id : '');

  ui.personalitySelect.value = selectedId;
}

async function applyHeaderSelection() {
  const payload = {
    headersEnabled: ui.headersEnabled.checked,
    activePersonalityId: ui.personalitySelect.value,
    customizeHost: ui.customizeHost.value.trim(),
  };

  const response = await chrome.runtime.sendMessage({
    type: 'update-header-state',
    payload,
  });

  if (!response || !response.ok) {
    throw new Error(
      response && response.error
        ? response.error
        : 'Failed to update extension header state.',
    );
  }

  state.headerState = response.state;
}

async function onHeaderToggleChanged() {
  try {
    await applyHeaderSelection();
    const label = ui.headersEnabled.checked ? 'enabled' : 'disabled';
    setStatus(`Customization ${label}. Reload the target page.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function onPersonalitySelectChanged() {
  try {
    await applyHeaderSelection();
    setStatus('Personality changed. Reload the target page.');
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function onHostChanged() {
  try {
    await applyHeaderSelection();
    const host = ui.customizeHost.value.trim();
    setStatus(host ? `Origin set to ${host}. Reload the target page.` : 'Using default origin.');
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function onSaveMainPrompt() {
  try {
    const mainPrompt = ui.mainPrompt.value.trim();
    if (!mainPrompt) {
      throw new Error('Main prompt cannot be empty.');
    }

    const response = await apiRequest('/api/config/prompt', {
      method: 'PUT',
      body: JSON.stringify({ mainPrompt }),
    });

    state.mainPrompt = response.mainPrompt;
    ui.mainPrompt.value = state.mainPrompt;
    setStatus('Main prompt saved.');
  } catch (error) {
    setStatus(error.message, true);
  }
}

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  document.querySelectorAll('.tab-content').forEach((section) => {
    section.classList.toggle('active', section.id === `tab-${tabName}`);
  });
}

let hostDebounce = null;

function bindEvents() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  ui.headersEnabled.addEventListener('change', onHeaderToggleChanged);
  ui.personalitySelect.addEventListener('change', onPersonalitySelectChanged);
  ui.savePrompt.addEventListener('click', onSaveMainPrompt);

  ui.customizeHost.addEventListener('input', () => {
    clearTimeout(hostDebounce);
    hostDebounce = setTimeout(onHostChanged, 600);
  });
}

async function init() {
  bindEvents();

  try {
    await loadHeaderState();
    await loadRemoteConfig();
    setStatus('Ready.');
  } catch (error) {
    setStatus(error.message, true);
  }
}

init();

/* global chrome */

const RULE_ID = 1001;
const DEFAULT_STATE = {
  headersEnabled: true,
  activePersonalityId: '',
  customizeHost: 'https://main--generative-proxy-1--froesef.aem.page',
};

async function getState() {
  const stored = await chrome.storage.local.get(DEFAULT_STATE);
  return {
    headersEnabled: Boolean(stored.headersEnabled),
    activePersonalityId: typeof stored.activePersonalityId === 'string'
      ? stored.activePersonalityId
      : '',
    customizeHost: typeof stored.customizeHost === 'string'
      ? stored.customizeHost
      : '',
  };
}

async function applyHeaderRule(state) {
  const requestHeaders = [
    {
      header: 'x-generative-enabled',
      operation: 'set',
      value: '1',
    },
  ];

  if (state.activePersonalityId) {
    requestHeaders.push({
      header: 'x-generative-personality',
      operation: 'set',
      value: state.activePersonalityId,
    });
  }

  if (state.customizeHost) {
    requestHeaders.push({
      header: 'x-customize-host',
      operation: 'set',
      value: state.customizeHost,
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: state.headersEnabled
      ? [
        {
          id: RULE_ID,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders,
          },
          condition: {
            regexFilter: '^https?://',
            resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest'],
          },
        },
      ]
      : [],
  });
}

async function persistAndApplyState(partialState) {
  const current = await getState();
  const nextState = {
    ...current,
    ...partialState,
  };

  await chrome.storage.local.set(nextState);
  await applyHeaderRule(nextState);
  return nextState;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  getState()
    .then(applyHeaderRule)
    .catch((error) => {
      console.error('Failed to apply header rule on install', error);
    });
});

chrome.runtime.onStartup.addListener(() => {
  getState()
    .then(applyHeaderRule)
    .catch((error) => {
      console.error('Failed to apply header rule on startup', error);
    });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message && message.type === 'get-header-state') {
      const state = await getState();
      sendResponse({ ok: true, state });
      return;
    }

    if (message && message.type === 'update-header-state') {
      const payload = message.payload || {};
      const nextState = await persistAndApplyState({
        headersEnabled: Boolean(payload.headersEnabled),
        activePersonalityId: typeof payload.activePersonalityId === 'string'
          ? payload.activePersonalityId
          : '',
        customizeHost: typeof payload.customizeHost === 'string'
          ? payload.customizeHost
          : '',
      });

      sendResponse({ ok: true, state: nextState });
      return;
    }

    sendResponse({ ok: false, error: 'Unsupported message type' });
  })().catch((error) => {
    sendResponse({ ok: false, error: error.message });
  });

  return true;
});

getState()
  .then(applyHeaderRule)
  .catch((error) => {
    console.error('Failed to apply initial header rule', error);
  });

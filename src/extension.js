const vscode = require('vscode');
const { AppServer, CodexError } = require('./app-server');
const {
  AntigravityError, AntigravityMonitor, MINIMUM_CLI_VERSION, findAntigravityExecutable, readAntigravityQuota
} = require('./antigravity');
const { findCodexExecutable } = require('./codex-path');
const { QuotaMonitor, refreshIntervalMs, windowLabel } = require('./quota');

const REFRESH_COMMAND = 'codexQuota.refresh';
const REFRESH_ANTIGRAVITY_COMMAND = 'codexQuota.refreshAntigravity';
const ANTIGRAVITY_EXECUTABLE_SETTING = 'antigravity.executablePath';
const timeFormat = new Intl.DateTimeFormat(vscode.env.language, { dateStyle: 'medium', timeStyle: 'medium' });
const unknownDuration = vscode.l10n.t('Quota');
function commonMessages(provider) {
  return {
    loading: [vscode.l10n.t('loading…'), vscode.l10n.t('Reading the remaining {0} quota.', provider)],
    empty: [vscode.l10n.t('no quota data'), vscode.l10n.t('{0} returned no quota periods to display.', provider)],
    startup: [
      vscode.l10n.t('failed to start'),
      vscode.l10n.t('Could not start the local {0} executable. Check the installation path and refresh.', provider)
    ],
    timeout: [
      vscode.l10n.t('request timed out'),
      vscode.l10n.t('The {0} quota request timed out. Retrying automatically.', provider)
    ],
    connection: [
      vscode.l10n.t('quota unavailable'),
      vscode.l10n.t('Could not read the {0} quota. Retrying automatically.', provider)
    ]
  };
}

const codexMessages = {
  ...commonMessages('Codex'),
  'not-installed': [
    vscode.l10n.t('not found'),
    vscode.l10n.t('Install the official Codex extension or Codex CLI, or set codexQuota.executablePath in User settings.')
  ],
  'invalid-path': [
    vscode.l10n.t('invalid path'),
    vscode.l10n.t('Set an absolute Codex executable path in User settings. Use codex.exe on Windows.')
  ],
  'signed-out': [
    vscode.l10n.t('sign-in required'),
    vscode.l10n.t('Sign in with ChatGPT in the official Codex extension or run codex login.')
  ],
  'chatgpt-required': [
    vscode.l10n.t('requires ChatGPT sign-in'),
    vscode.l10n.t('Sign in with ChatGPT in the official Codex extension or CLI to see your subscription quota.')
  ],
  unsupported: [
    vscode.l10n.t('update required'),
    vscode.l10n.t('Update the official Codex extension or CLI, then refresh.')
  ]
};

const antigravityMessages = {
  ...commonMessages('Antigravity'),
  'not-installed': [
    codexMessages['not-installed'][0],
    vscode.l10n.t('Install the Google Antigravity CLI, then run agy to sign in.')
  ],
  'invalid-path': [
    codexMessages['invalid-path'][0],
    vscode.l10n.t('Set an absolute path to the agy executable in User settings. Use agy.exe on Windows.')
  ],
  'signed-out': [
    codexMessages['signed-out'][0],
    vscode.l10n.t('Run agy in a terminal and sign in to Google Antigravity, then refresh.')
  ],
  unsupported: [
    codexMessages.unsupported[0],
    vscode.l10n.t('Use Google Antigravity CLI {0} or later for quota queries.', MINIMUM_CLI_VERSION)
  ]
};

let monitor;
let antigravityMonitor;

function configuredRefreshInterval() {
  const seconds = vscode.workspace.getConfiguration('codexQuota').get('refreshIntervalSeconds');
  return refreshIntervalMs(seconds);
}

function configuredExecutablePath(key) {
  const value = vscode.workspace.getConfiguration('codexQuota').inspect(key)?.globalValue;
  return typeof value === 'string' ? value.trim() : '';
}

function updateStatus(item, provider, messages, { state, reading }) {
  let label;
  let details;
  const antigravity = provider === 'Antigravity';
  const stale = Boolean(reading && state !== 'ready');
  const [summary, description] = messages[state] ?? messages.connection;

  if (reading) {
    const quota = antigravity
      ? `${Math.min(...reading.windows.map(({ remaining }) => remaining))}%`
      : reading.windows.map(({ minutes, remaining }) => `${windowLabel(minutes) ?? unknownDuration} ${remaining}%`).join(' · ');
    label = `${provider} ${quota}`;
    details = reading.windows.map(({ group, period, minutes, remaining, resetAt }) => {
      const window = windowLabel(minutes) ?? (period || unknownDuration);
      const name = group ? `${group} · ${window}` : window;
      return resetAt === null
        ? vscode.l10n.t('{0} has {1}% remaining. Reset time unavailable.', name, remaining)
        : vscode.l10n.t('{0} has {1}% remaining. Resets on {2}.', name, remaining, timeFormat.format(resetAt));
    });
    if (antigravity) details.unshift(vscode.l10n.t('The status bar shows the lowest remaining percentage.'));
    details.push(vscode.l10n.t('Last updated {0}', timeFormat.format(reading.updatedAt)));
    if (stale) details.unshift(vscode.l10n.t('Showing the last successful reading. {0}', description));
  } else {
    label = `${provider} ${summary}`;
    details = [description];
  }

  const tooltip = new vscode.MarkdownString();
  for (const detail of [...details, vscode.l10n.t('Click to refresh now')]) {
    tooltip.appendText(detail).appendMarkdown('\n\n');
  }
  const icon = antigravity ? 'rocket' : 'terminal';
  item.text = `$(${icon}) ${label}${stale ? ' $(warning)' : ''}`;
  item.accessibilityInformation = { label: stale ? vscode.l10n.t('{0}, stale data', label) : label };
  item.tooltip = tooltip;
}

function activate(context) {
  const item = vscode.window.createStatusBarItem('codexQuota', vscode.StatusBarAlignment.Right, 0);
  item.name = vscode.l10n.t('Quota Dial');
  item.command = REFRESH_COMMAND;
  const agyItem = vscode.window.createStatusBarItem('antigravityQuota', vscode.StatusBarAlignment.Right, -1);
  agyItem.name = vscode.l10n.t('Antigravity Quota');
  agyItem.command = REFRESH_ANTIGRAVITY_COMMAND;

  const interval = configuredRefreshInterval();
  const publish = (status) => updateStatus(item, 'Codex', codexMessages, status);
  monitor = new QuotaMonitor((onNotification) => {
    const configuredPath = configuredExecutablePath('executablePath');
    const extensionPath = vscode.extensions.getExtension('openai.chatgpt')?.extensionPath;
    const executable = findCodexExecutable({ configuredPath, extensionPath });
    if (!executable) throw new CodexError(configuredPath ? 'invalid-path' : 'not-installed');
    return new AppServer(executable, context.extension.packageJSON.version, onNotification);
  }, publish, interval);

  const publishAntigravity = (status) => {
    if (!status.reading) {
      agyItem.hide();
      return;
    }
    updateStatus(agyItem, 'Antigravity', antigravityMessages, status);
    agyItem.show();
  };
  antigravityMonitor = new AntigravityMonitor((signal) => {
    const configuredPath = configuredExecutablePath(ANTIGRAVITY_EXECUTABLE_SETTING);
    const executable = findAntigravityExecutable({ configuredPath });
    if (!executable) throw new AntigravityError(configuredPath ? 'invalid-path' : 'not-installed');
    return readAntigravityQuota(executable, signal);
  }, publishAntigravity, interval);

  context.subscriptions.push(
    item,
    agyItem,
    vscode.commands.registerCommand(REFRESH_COMMAND, () => monitor.refresh()),
    vscode.commands.registerCommand(REFRESH_ANTIGRAVITY_COMMAND, async () => {
      const status = await antigravityMonitor.refresh();
      if (status && !status.reading) {
        const [, description] = antigravityMessages[status.state] ?? antigravityMessages.connection;
        void vscode.window.showInformationMessage(description);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codexQuota.refreshIntervalSeconds')) {
        const updatedInterval = configuredRefreshInterval();
        monitor.setRefreshInterval(updatedInterval);
        antigravityMonitor.setRefreshInterval(updatedInterval);
      }
      if (event.affectsConfiguration('codexQuota.executablePath')) void monitor.reconnect();
      if (event.affectsConfiguration(`codexQuota.${ANTIGRAVITY_EXECUTABLE_SETTING}`)) void antigravityMonitor.reconnect();
    })
  );
  publish({ state: 'loading' });
  item.show();
  void monitor.refresh();
  void antigravityMonitor.refresh();
}

function deactivate() {
  return Promise.all([monitor?.dispose(), antigravityMonitor?.dispose()]);
}

module.exports = { activate, deactivate };

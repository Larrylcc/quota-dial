# Quota Dial

[简体中文](#简体中文) · [English](#english)

## 简体中文

**AI 额度速览。** 在 VS Code 底部状态栏右侧查看 Codex 和 Google Antigravity 的剩余额度。开发者为 **larrylcc**。

- **Codex** 并列显示可用周期，例如 `Codex 5h 78% · 7d 42%`。
- **Antigravity** 读到额度后才会出现，显示各额度周期中最低的剩余比例。悬停可查看每个模型组的周期明细和重置时间。

### 安装

从 0.2.1 或更早版本升级时，请先卸载旧扩展 `vibe-lab.codex-quota`。新版的扩展标识是 `larrylcc.codex-quota`，会继续读取已有的 `codexQuota.*` 用户设置。

在桌面版 VS Code 的扩展面板中搜索 `@id:larrylcc.codex-quota` 并安装，或运行以下命令。[扩展市场页面](https://marketplace.visualstudio.com/items?itemName=larrylcc.codex-quota)

```powershell
code --install-extension larrylcc.codex-quota
```

如需离线安装，可从 GitHub 下载 VSIX，在扩展面板中选择「从 VSIX 安装」。安装后重载窗口即可应用新版。[下载 VSIX](https://github.com/Larrylcc/quota-dial/releases/latest)

### 登录

- **Codex** 在官方 Codex 扩展中使用 ChatGPT 登录，或在终端运行 `codex login`。Quota Dial 优先使用官方扩展自带的 Codex 程序，其次查找本机 Codex CLI，由本机 App Server 读取额度。[Codex 登录说明](https://learn.chatgpt.com/docs/auth)
- **Antigravity** 安装 Google Antigravity CLI（`agy`）1.1.11 或更高版本。CLI 可沿用本机的 Antigravity 登录。需要登录时，在终端运行 `agy`。Quota Dial 通过 CLI 的 `/usage` 查询读取额度。[Google Antigravity 安装说明](https://antigravity.google/docs/getting-started?tab=cli) · [登录说明](https://antigravity.google/docs/install/) · [额度查询说明](https://antigravity.google/docs/cli/commands/usage)

界面自动跟随 VS Code 的显示语言，支持英文、简体中文和繁体中文。其他显示语言使用英文文案。在命令面板运行 `Configure Display Language`（配置显示语言）并按提示重启，即可切换。[VS Code 显示语言](https://code.visualstudio.com/docs/configure/locales)

### 刷新和设置

两项额度在启动时分别查询。默认各自在查询完成后等待 60 秒再查。修改 VS Code 用户设置 `codexQuota.refreshIntervalSeconds` 可同时调整两者的间隔，单位为秒，保存后生效。

点击任一状态栏项可立即查询对应的额度。命令面板也提供「刷新 Codex 剩余额度」和「刷新 Antigravity 剩余额度」。如果 Antigravity 暂无读数，手动刷新会提示原因。Codex App Server 发来的额度通知也会更新显示。悬停可查看上次成功更新时间，带警告图标的数值来自上次成功的查询。

自定义安装路径可填写 `codexQuota.executablePath`（Codex）或 `codexQuota.antigravity.executablePath`（Antigravity）。请使用可执行文件的绝对路径。Windows 上分别填写 `codex.exe` 和 `agy.exe` 的路径。

### 开发

使用 Node.js 22 或更高版本运行 `npm test`。运行 `npm run package -- --out quota-dial-0.2.4.vsix` 生成 VSIX。在 VS Code 中打开此目录后按 `F5` 可打开扩展开发窗口。

## English

**AI quota at a glance.** See remaining Codex and Google Antigravity quota on the right side of the VS Code status bar. Developed by **larrylcc**.

- **Codex** shows available windows side by side, as in `Codex 5h 78% · 7d 42%`.
- **Antigravity** appears when quota data is available and shows the lowest remaining percentage across its quota windows. Hover for each model group's windows and reset times.

### Install

When upgrading from 0.2.1 or earlier, first uninstall `vibe-lab.codex-quota`. The new extension ID is `larrylcc.codex-quota` and it reads your existing `codexQuota.*` user settings.

In the desktop VS Code Extensions view, search for `@id:larrylcc.codex-quota` and select **Install**, or run the following command. [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=larrylcc.codex-quota)

```powershell
code --install-extension larrylcc.codex-quota
```

For an offline installation, download the VSIX from GitHub and choose **Install from VSIX** in the Extensions view. Reload the window after installing. [Download the VSIX](https://github.com/Larrylcc/quota-dial/releases/latest)

### Sign in

- **Codex** Sign in with ChatGPT in the official Codex extension or run `codex login` in a terminal. Quota Dial looks for Codex in the official extension first, then in the locally installed CLI. The local Codex App Server reads the quota. [Codex sign-in documentation](https://learn.chatgpt.com/docs/auth)
- **Antigravity** Install Google Antigravity CLI (`agy`) 1.1.11 or later. The CLI can reuse your local Antigravity sign-in. Run `agy` in a terminal if you need to sign in. Quota Dial reads quota through the CLI's `/usage` command. [Google Antigravity installation](https://antigravity.google/docs/getting-started?tab=cli) · [Sign-in documentation](https://antigravity.google/docs/install/) · [Model quota documentation](https://antigravity.google/docs/cli/commands/usage)

The interface follows the VS Code display language and supports English, Simplified Chinese, and Traditional Chinese. Other display languages use English text. To switch languages, run **Configure Display Language** from the Command Palette and restart VS Code. [VS Code display language](https://code.visualstudio.com/docs/configure/locales)

### Refresh and settings

Quota Dial checks both quotas on startup. Each waits 60 seconds after its own query finishes before starting the next one. Change `codexQuota.refreshIntervalSeconds` in VS Code User Settings to set the interval in seconds for both.

Click either status bar item to check that quota immediately. The Command Palette offers **Refresh Codex Quota** and **Refresh Antigravity Quota**. A manual Antigravity refresh explains why its quota is unavailable when there's no reading. Notifications from the Codex App Server also update the display. Hover for the last successful update time. A warning icon marks the last successful reading after a failed query.

For a custom installation, enter the absolute path of the executable in `codexQuota.executablePath` (Codex) or `codexQuota.antigravity.executablePath` (Antigravity). On Windows, use the path to `codex.exe` or `agy.exe`.

### Develop

Use Node.js 22 or later and run `npm test`. Run `npm run package -- --out quota-dial-0.2.4.vsix` to build the VSIX. Open this directory in VS Code and press `F5` to launch an extension development window.

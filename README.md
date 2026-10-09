# Quests Manager

**Discord Quest Auto Completer** — a Vencord userplugin that helps you enroll, track, and complete Discord Quests from a floating panel on the Quests tab.

**Current version:** `v1.0.3`

---

## Features

- Floating Quests Manager panel on Discord’s Quests page
- Tabs: **Incomplete**, **Claimable** (ready to claim reward), **Completed**
- Supported quest types: Video, Play on Desktop, Stream, Launch Quest (activity)
- Batch “Complete All” for eligible enrolled quests
- Country / region filters and Orbs stats
- English and Arabic UI
- **In-plugin updater** — check GitHub releases and install plugin updates without re-running the installer
- One-click Windows installer (`Quests Manager.bat`) for Vencord + plugin setup

---

## Requirements

- Discord **desktop** (Stable) on Windows
- Custom Vencord built **from source** (userplugins are not loaded by installer-only Vencord)
- Node.js, Git, and pnpm (the `.bat` installer can set these up)

Launch Quest (activity) quests require `native.ts` in a source-built Vencord install.

---

## Quick install (Windows)

1. Download or clone this repository.
2. Double-click **`Quests Manager.bat`**  
   (also provided as `Install Vencord + Quests Manager.bat` — same installer).
3. The installer works as a **normal user or Administrator**. Match Discord’s privilege level if patching fails.
4. When finished:
   - Wait for Discord to load
   - Open **Settings → Vencord → Plugins**
   - Enable **Quests Manager**
   - Open the **Quests** tab and click **Quests Manager**

The installer clones Vencord to `%USERPROFILE%\Documents\Vencord`, installs this plugin from the latest GitHub release, builds, and patches Discord.

---

## Manual install

1. Clone [Vencord](https://github.com/Vencord/Vencord) and install dependencies (`pnpm install`).
2. Copy `src/userplugins/questsManager/` into your Vencord tree:
   ```
   <Vencord>/src/userplugins/questsManager/
   ```
3. Run `pnpm build` in the Vencord root.
4. Patch Discord (use `patch-discord.mjs` from this repo, or your usual Vencord patch method).
5. Restart Discord and enable **Quests Manager**.

---

## In-plugin updates

The panel shows **`v1.0.3`** and can check [GitHub Releases](https://github.com/Afrsto/Discord-Quest-Auto-Completer/releases).

1. Click **Check update**
2. If a newer release has `src.zip`, click **Update now**
3. Fully **restart Discord** after a successful update

This updates plugin sources under your local Vencord userplugins folder and rebuilds Vencord — it does **not** re-run the full `.bat` installer.

---

## Project layout

```
├── Quests Manager.bat              # Windows installer
├── Install Vencord + Quests Manager.bat  # same installer (legacy name)
├── patch-discord.mjs               # Discord Stable patcher
├── src/userplugins/questsManager/  # Vencord plugin source
├── scripts/                        # Console / userscript build helpers
├── Quests Manager.txt              # Optional DevTools paste script
└── Quests Manager.user.js          # Optional Tampermonkey userscript
```

---

## Launch Quest notes

1. Click **Start**, then **Start Quest** in the dialog.
2. Allow Quests Manager to open the quest page and click Discord’s Launch Quest button when needed.
3. Complete authorization prompts in Discord.
4. Wait for the activity frame — checkpoints run automatically.

Close other Discord activities first so the correct activity iframe is targeted.

---

## Contact & Community

| Channel | Link | Role |
|---------|------|------|
| **Discord Server** | [https://discord.gg/btRCeujadA](https://discord.gg/btRCeujadA) | Primary community and support |
| **Telegram** | [https://t.me/X2_616](https://t.me/X2_616) | Direct contact and updates |
| **Discord Profile** | [https://discord.com/users/994817247061225633](https://discord.com/users/994817247061225633) | Additional contact |

---

## Credits

- Author: **X2 Salah**
- Repository: [Afrsto/Discord-Quest-Auto-Completer](https://github.com/Afrsto/Discord-Quest-Auto-Completer)

## License

Plugin sources follow Vencord’s GPL-3.0-or-later SPDX headers where present. Use responsibly and at your own risk; this project is not affiliated with Discord.

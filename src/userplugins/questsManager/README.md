# Quests Manager (Vencord UserPlugin)

Discord Quest Auto Completer — Vencord plugin (`v1.0.2`).

## Requirements

Custom plugins only load when **Vencord is built from source** (not the installer-only build).

See: https://docs.vencord.dev/installing/custom-plugins/

**Launch Quest** (activity achievement) quests require the Discord **desktop** app with a source-built Vencord install. They use `native.ts` to run code inside the activity iframe (`*.discordsays.com`) and do not work in the browser extension or without rebuilding after adding `native.ts`.

## Install

### Recommended: installer

1. Double-click `Quests Manager.bat` (works as a normal user or Administrator).
2. Wait for Vencord clone, plugin install, build, and Discord patch.
3. Enable **Quests Manager** under Settings → Vencord → Plugins.
4. Open the Quests tab and click **Quests Manager**.

### Manual

1. Clone and set up Vencord from source if you have not already.
2. Create `src/userplugins` inside your Vencord folder (if it does not exist).
3. Copy this entire `questsManager` folder into:
   ```
   <Vencord>/src/userplugins/questsManager/
   ```
4. Rebuild Vencord (`pnpm build`) and restart Discord.
5. Enable the plugin and open Quests Manager from the Quests tab.

## In-plugin updates

The panel shows the current version (`v1.0.2`) and can check GitHub releases for newer builds. Use **Check update** / **Update now** to download `src.zip`, replace plugin files under your Vencord userplugins folder, rebuild, then fully restart Discord — no need to re-run the `.bat` for plugin-only updates.

## Tabs

- **Incomplete** — not finished yet
- **Claimable** — completed, waiting for **Claim reward**
- **Completed** — reward already claimed

## Launch Quest workflow

1. Click **Start** on the quest, then **Start Quest** in the dialog.
2. If the activity is not already open, Quests Manager will auto-launch it in Discord.
3. Complete any authorization prompts in Discord when they appear.
4. Wait up to ~90 seconds for the activity to load — checkpoints begin automatically.

## Notes

- Disabling the plugin removes the button and closes/cleans up the panel.
- Closing the panel with ✕ only hides it; the plugin stays enabled.
- Play / Stream quests need the Discord **desktop** app.
- Launch Quest quests need `native.ts` bundled in your Vencord build.

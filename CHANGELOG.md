# Changelog

All notable changes to CONDUIT are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and CONDUIT uses [Semantic Versioning](https://semver.org/):
MAJOR.MINOR.PATCH.

Work that has not been released yet is under **[Unreleased]**, grouped by the batch of work it came in (newest
first). It becomes the next version when a release is prepared.

## [Unreleased]

## [1.7.0] - 2026-11-18

### Added
- **Kick → Live chat warns when chat isn't arriving:** if your Kick stream has been live for 10 minutes and nothing
  has reached CONDUIT from Kick, the Kick card and Live chat say so and what to check (the tunnel and the webhook URL).
  The warning clears as soon as a message arrives.

### Changed
- **New sidebar: Discord and Streaming.** After the Dashboard come two groups.
  - **Discord:** Discord Bot, Commands, Embed Creator, Auto Messages, Giveaways, and Loyalty & Rewards.
  - **Streaming:** Commands, Moderation, Notifications, Clips, Timed Messages and Giveaways.
  - The Kick, Twitch and YouTube groups are gone. Each Streaming page has a tab per platform (Kick and Twitch, with
    YouTube marked Soon), and each page remembers the tab you last opened.
  - **OBS Overlays** is now **Widgets** (Soon).
- **Commands are split:** the Discord bot's commands are under Discord → Commands, and Kick and Twitch chat commands
  under Streaming → Commands.
- **Auto Messages (Discord):** Sticky Messages and Discord timed messages are now one page with **Sticky** and
  **Timed** tabs. Kick and Twitch timed messages are under Streaming → Timed Messages.
- **Discord giveaways are separate from stream giveaways.**
  - **Discord → Giveaways** is entered with the Enter Giveaway button. **Streaming → Giveaways** is entered with
    `!enter` in Kick or Twitch chat.
  - One of each can run at the same time, and a giveaway can't mix Discord with Kick or Twitch.
  - Older giveaways that allowed both are listed under Streaming and keep working until they end.
- **Faster, sturdier start:** the backend no longer runs a password-hashing self-test on every start.

### Removed
- **The unused account system:** CONDUIT user accounts, sign-in, sessions, streamer profiles, user administration,
  the realtime WebSocket and the administrator password recovery tool (`--recover-admin`). The app hasn't used any of
  it since sign-in was removed; it opens straight to the Dashboard as before. Saved rows stay in the database.
- **The standalone server mode** (`npm run server`): it could never connect Discord, Kick or Twitch, because their
  sign-ins are stored by the CONDUIT app itself. Running CONDUIT (`npm run dev`, `npm start` or the installed app) is
  unchanged.
- **Settings that no longer exist** (`CONDUIT_SETUP_TOKEN`, `CONDUIT_SESSION_TTL_HOURS`, `CONDUIT_SESSION_IDLE_HOURS`
  and the `CONDUIT_ARGON2_*` values) are ignored, so an environment that still sets them starts normally.

### Fixed
- **Kick chat couldn't recover from a broken subscription:** CONDUIT kept reusing its existing Kick subscription even
  when Kick had never delivered to it. While nothing has arrived, **Renew subscription** (Manage → Live chat) now
  deletes CONDUIT's Kick subscriptions and creates new ones.
- **Twitch chat and Twitch timed messages:** the check that keeps a message on one line now uses an escaped form that
  editors and tools can't strip. Nothing changes for what you can send.

## [1.6.4] - 2026-11-08

### Added
- **Twitch Moderation** (sidebar → Twitch):
  - **Automated Protection** on Twitch chat: the same checks, raid mode and ignored users as Kick, with their own
    settings.
  - **Chat Modes:** Shield Mode, slow mode, followers-only, subscribers-only, emote-only and unique chat, changed on
    Twitch straight away.
  - **Logs:** what CONDUIT did, plus bans, timeouts and unbans done on Twitch itself.
- **Commands → Twitch → Default Commands:** `!ping`, `!commands`, `!uptime`, `!followage`, `!title`, `!so`, `!timeout`,
  `!ban`, `!unban`, `!addcom`, `!editcom`, `!delcom` and `!setcategory`, like Kick's. Each can be switched off, and your
  own custom command with the same trigger answers instead.
- **Giveaways → Twitch:** viewers enter with `!enter` in your Twitch chat, on its own or together with Kick and Discord.
  The chatbot posts the giveaway's messages in Twitch chat, and a subscriber or founder badge counts for the subscriber
  multiplier.

### Changed
- **Twitch accounts connected before this version** must be connected again for the new commands and Twitch
  Moderation. The Twitch card shows **Reconnect**. Chat, commands and giveaways keep working without it.
- **Explanations are back:** every page has its short description under the title, and cards, fields and protection
  checks have their explanations again, as small gray text instead of on hover.
- **Winners:** when a giveaway runs on both Kick and Twitch, chat announcements say which chat each winner is from, and
  the Discord announcement labels Twitch winners **(Twitch)**.
- **Dashboard → Twitch:** the card no longer shows an App row, matching Kick.

### Fixed
- **Kick and Twitch `!timeout`, `!ban` and `!unban`:** a moderator can't use them on another moderator (they act as
  the channel owner). You still can.
- **Kick Moderation → Logs:** chat commands show as "!ban by name", not as the dashboard.


## [1.3.0] - 2026-11-04

### Added
- **Twitch:** connect Twitch on the Dashboard with your own Twitch app (Client ID and Client Secret from the Twitch
  Developer Console) and your Twitch account. As Twitch requires, CONDUIT checks the authorization every hour while it
  runs, and **Disconnect** revokes it at Twitch.
- **Twitch → Twitch Notifications:** Discord posts when Twitch streamers (yours or anyone's) go live, just like Kick
  Notifications: one post per stream, the Twitch-purple default layout, the live preview as the image (kept current),
  **Send test**, and deleting the post when the stream ends.
- **Twitch chat:** CONDUIT receives your Twitch channel's chat through Twitch's EventSub connection. CONDUIT opens
  this connection itself, so Twitch needs no tunnel. It reconnects on its own when the connection drops. Dashboard →
  Twitch → Manage → **Live Chat** shows the status and the latest messages, and lets you send a test message.
- **Twitch chatbot:** the chatbot posts as your main Twitch account or as a separate bot account (**Manage →
  Chatbot**), like Kick. The main account asks for `user:read:chat` (and `user:write:chat` when it is the chatbot).
  A bot account asks only for `user:write:chat`. Make a separate bot account a moderator (`/mod YourBotName`).
- **Commands → Twitch:** custom commands for Twitch chat, with variables, permissions (Twitch's moderator,
  subscriber and founder badges) and cooldowns.
- **Timed Messages → Twitch chat:** timed messages can post in your Twitch chat, every X minutes and/or after X chat
  messages.

### Changed
- **Stream notifications** are now one feature for every platform: Kick and Twitch streamers are checked side by
  side, each with its own app. Kick Notifications work as before.
- **Command variables:** the groups are now **Your stream** and **Kick and Twitch chat**.
- **A simpler CONDUIT:** every page now shows only what you use. The explanations under page titles, cards, fields and
  setup steps are gone, along with the sidebar tagline and the version (it's in Settings). Details that still help are
  on hover: what a default command does and an example, who a permission level includes, when CONDUIT last checked.
- **Page actions at the top right:** **New sticky**, **New timed message**, **New giveaway**, **Check now** and **Add
  streamer** sit next to the page title.
- **Sidebar:** YouTube is one *Soon* heading, and OBS Overlays is one *Soon* item. "Made by Retronix" sits next to
  **Settings**. The backend status shows only when something is wrong.
- **Commands:** permission levels a platform doesn't have (Discord subscribers) are no longer listed. Cooldowns read
  **Per user** or **Everyone**.
- **Setup windows:** the steps keep their instructions for the developer portals, without the extra notes. Kick's
  Chatbot step no longer repeats the bot account as a separate card.
- **README:** Twitch, and a tip to make a separate Twitch bot account a moderator.

## [1.0.2] - 2026-10-27

### Changed
- **Giveaways:** the **Kick Messages** tab is now called **Messages**.
- **Menu bar:** the File, Edit, View and Window menu bar is gone, also when running CONDUIT from source.
- **Discord Logs → Moderation log:** shorter, easier description at the top.
- **README:** install steps now build the installer yourself, since there's no ready-made download yet.

## [1.0.1] - 2026-10-27

### Changed
- **Build:** the app's name, app id and data folder now come from one place (`scripts/edition.mjs`). Nothing changes
  for you: it is still "CONDUIT" and keeps its data in `%APPDATA%\CONDUIT`.
- **Setup guide:** the installer's name is shown as `CONDUIT Setup X.Y.Z.exe` (the version you build).

## [1.0.0] - 2026-10-25

The first release of CONDUIT: one desktop app for running your Discord and Kick from one place. It starts empty;
you connect your own accounts and set everything up yourself. See [docs/SETUP.md](docs/SETUP.md).

### Added
- **Connect Accounts** on the Dashboard, through each platform's own sign-in:
  - **Discord:** a guided setup for your own Discord application and bot (credentials checked with Discord, adding the
    bot to your server and starting it).
  - **Kick:** your own Kick app, your Kick account, and the chatbot (your main account or a separate bot account), plus
    live chat through a webhook tunnel.
  - Tokens and secrets are encrypted with Windows (DPAPI) and never reach the dashboard; the backend is local-only.
- **Commands** for Discord and Kick: default commands (moderation, `/slowmode`, `/lock`, `/unlock`, `!uptime`,
  `!so`, `!title`, `!setcategory`…) and your own custom commands, with variables, permissions and cooldowns.
- **Giveaways:** one at a time; viewers enter with `!enter` in Kick chat or the Enter Giveaway button on Discord, with
  tickets, a draw, and announcements.
- **Timed Messages** in Kick chat or a Discord channel: every X minutes, after X chat messages, or both.
- **Moderation:**
  - **Kick:** automated protection (blocked words and phrases, links, spam checks, raid mode, ignored users), logs
    including bans made on Kick itself, and each person's history.
  - **Discord Bot:** CONDUIT's own AutoMod rules and message checks, anti-nuke and quarantine, anti-raid with
    lockdowns and a join gate, bot bait, moderation commands, and Discord Logging.
- **Discord:** Sticky Messages, Embed Creator (embeds, buttons and select menus, sent and edited as your bot), and
  Loyalty & Rewards (XP, levels, role rewards and a points balance).
- **Kick Notifications:** Discord posts when Kick streamers go live, with the stream thumbnail and Watch buttons, and
  optionally deleted when the stream ends.
- **Clips:** your Kick clips (made with Kick's `/clip`) posted in Discord with watch buttons, and saved on this PC.
- **Settings:** appearance and themes, system status, backup and restore, logs, and release notes.

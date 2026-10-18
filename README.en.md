# GM Whispers — an AI assistant for the Game Master in Foundry VTT

*Русская версия: [README.md](README.md)*

Answers questions about your adventure and world with links to journal pages, suggests monster tactics on the current map, writes session recaps into a diary (including from Discord voice recordings), and prepares a pre-session briefing. Visible to the GM only; players see nothing.

> This is a first version for testing — feedback is very welcome: https://github.com/HeavySoulDM/gm-whispers/issues

Two parts: the **Foundry module** (installed like any module) and **GM Whispers Core** — a small program on your computer that keeps the knowledge base and talks to the AI model. You need an API key from one AI service (Claude, OpenAI, Gemini, DeepSeek, OpenRouter or any compatible one). Typical cost is under a dollar per game night.

## Install in 10 minutes

1. **Module.** Foundry → Add-on Modules → Install Module → paste the manifest link (see the release page) → Install. Enable the module in your world.
2. **Core.** Unpack `GM_Whispers_Core` into any folder (e.g. `C:\GM_Whispers_Core`) and run `server\setup.bat` once: it offers to install Python if missing, installs what is needed and asks whether to enable voice recognition (needs an NVIDIA GPU, downloads ~3 GB).
3. **Start.** `server\start.bat` — before every game. The server window shows the **access code** (also in `server\.env`).
4. **Setup wizard.** Open the world — the first-run wizard opens by itself and walks you through the access code, the AI service key, a few words about your campaign and what the advisor should read. You can run it again later from the settings (⚙ in the panel → "Setup wizard").
5. **Done.** The knowledge base and the campaign bible build themselves (a minute or two, progress shown in the panel). Open the panel (Alt+G or the wizard hat on the token controls) and ask your first question.

The server is started manually before each game.

## What it does

- **Advisor** — questions about the world, NPCs, factions, rules; answers cite journal pages as `[1]` and stream in as they are generated.
- **Token menu** — right-click → hat: "Who is this and what do they want", "A line", "Combat turn". Hotkeys Alt+T (tactics) and Alt+R (line) for the selected token.
- **Tactics** — turn options that account for distances, walls, cover, doors and abilities (detailed stat blocks for D&D 5e).
- **Prep** — pre-session briefing: where you left off, open threads, who is ahead, what to pull from the book.
- **Recap** — a draft session recap from chat, events and voice → the "Campaign Diary" journal. Voice comes from the Craig bot in Discord: after the game, download the recording from the bot into the folder you chose (best format: multi-track FLAC; Craig's cloud upload is a paid feature); it is transcribed on your NVIDIA GPU.
- **Campaign Bible** — a digest of the party, NPCs and current state that the model gets with every question. You write "Permanent"; "Current State" updates after each recap.
- **Settings inside Foundry** — keys, models, answer style, language, Craig, who is who, storage; export/import.

## Cost and privacy

The model is billed by the AI service on your key; today's spend is shown in the panel status line. The service receives your world's journal texts (including those hidden from players), chat, voice transcripts, and character and player names. Keys and world files never leave your machine: the server listens only on your computer (127.0.0.1) and answers only your Foundry.

## FAQ

**Do I need a GPU?** Only for local voice recognition. Everything else works without one; skip voice, or use Craig's own transcription (paid tier).

**Foundry is hosted elsewhere (not on this computer)?** Core must run on the GM's computer; add your Foundry address in ⚙ → Connection → Advanced → "Hosted Foundry addresses".

**Not D&D 5e?** Works: advisor, recaps, Prep, bible, map tactics. Detailed monster stat blocks are read only for dnd5e.

**How to update?** The module — like any Foundry module. Core — download the new archive and unpack over the old one; `.env` and `data\` are kept.

MIT license. Questions and bug reports — on the project page.

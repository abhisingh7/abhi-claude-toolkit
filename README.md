# abhi-claude-toolkit

My personal collection of [Claude Code](https://claude.com/claude-code) mods, skills and agents, published as a Claude Code plugin marketplace.

## Install

Add the marketplace once:

```
/plugin marketplace add abhisingh7/abhi-claude-toolkit
```

Then install any plugin from it:

```
/plugin install <plugin-name>@abhi-claude-toolkit
```

## Mods

| Mod | What it does |
|---|---|
| [cache-clock](mods/cache-clock) | Counts down until the chat's prompt cache goes cold. Offers a handoff when a big chat goes cold, and can ping the cache to keep it warm. |
| [efficient-browser-use](mods/efficient-browser-use) | Cheaper browser tasks: shrinks every screenshot Claude takes, or has Haiku describe it in words. |
| [effort-optimizer](mods/effort-optimizer) | Reads each prompt, picks the effort level it needs, and offers to switch to it. |
| [handoff](mods/handoff) | At 250k tokens, writes a handoff of the whole chat and copies it or starts a new chat with it. |
| [input-router](mods/input-router) | Haiku reads big files and connector results first; Claude gets short notes and a path to the full thing. |
| [model-router](mods/model-router) | Haiku reads each subagent task and picks a model tier. Modified copy of claude-code-templates' Model Router (MIT). |
| [mods](mods/mods) | A Mods pane that finds every mod on your machine and turns each on or off per chat. |
| [research-router](mods/research-router) | Keeps web research out of the main chat: shortens big search results and returns short briefs with sources. |
| [ribbon](mods/ribbon) | A slim band above the prompt showing 5-hour and 7-day usage left, reset times, and prompt-cache state. |
| [savings-proof](mods/savings-proof) | `/savings` opens a pane showing every token the other mods saved. |

## Skills

None yet. Add each skill as `skills/<skill-name>/SKILL.md`.

## Agents

None yet. Add each agent as `agents/<agent-name>.md`.

## Repository layout

```
abhi-claude-toolkit/
├── .claude-plugin/marketplace.json   # marketplace manifest listing every plugin
├── mods/<mod-name>/                  # one plugin per folder (.claude-plugin/plugin.json inside)
├── skills/<skill-name>/SKILL.md
├── agents/<agent-name>.md
└── README.md
```

## Adding a new plugin

1. Put it in its own folder under `mods/` (or `skills/`, `agents/`).
2. Add an entry to `.claude-plugin/marketplace.json` with `name`, `source` (for example `./mods/my-mod`) and `description`.
3. Commit and push. Users get it with `/plugin marketplace update abhi-claude-toolkit`.

## License

[MIT](LICENSE). Each mod also carries its own `LICENSE` file in its folder, which applies to that mod (for example, `model-router` is derived from claude-code-templates' MIT-licensed Model Router).

# DuctTape.io skill for Claude

A skill that teaches Claude to work with [DuctTape.io](https://theducttape.io), the editor for AI architecture diagrams.

With it Claude can

- draw an architecture from code or from a description,
- keep an existing diagram in step with the code and say what changes first,
- explain a diagram and review it for gaps such as missing guardrails, tracing or a fallback,
- write a diagram file for "Import from JSON" when no connection to your account is set up.

Claude works on drafts only. Publishing and deleting stay with you in the app.

## Install

### Claude Code

Copy the skill into your skills folder:

```sh
git clone https://github.com/theducttapeio/ducttape-skill.git
mkdir -p ~/.claude/skills
cp -r ducttape-skill/skills/ducttape ~/.claude/skills/
```

Claude uses it as soon as a diagram comes up.

### Claude app

Download `ducttape-skill.zip` from the [latest release](https://github.com/theducttapeio/ducttape-skill/releases/latest) or from [theducttape.io/claude-skill](https://theducttape.io/claude-skill) and upload it in the settings, in the skills section. Skills need code execution there.

## Connect your account (optional)

With a connection Claude creates diagrams right in your account and hands you the link to the editor. Create an access token in the [settings](https://theducttape.io/app/settings) and add the MCP server:

```sh
claude mcp add --transport http ducttape https://theducttape.io/api/mcp --header "Authorization: Bearer dtp_..."
```

Without a connection Claude writes a JSON file. Open it in the dashboard with "Import from JSON".

## What is inside

| Path | Content |
|---|---|
| `skills/ducttape/SKILL.md` | Workflows and limits |
| `skills/ducttape/reference/modelling.md` | Which block for what, edges, typical architectures, review checklist |
| `skills/ducttape/reference/catalog.json` | Block kinds and vendor ids, generated from the app's catalog |
| `skills/ducttape/scripts/prepare-diagram.mjs` | Validates a diagram file and arranges the blocks. Node.js 18 or later, no dependencies |

Try the script on its own:

```sh
node skills/ducttape/scripts/prepare-diagram.mjs graph.json "My diagram.json"
```

`graph.json` holds `{ "nodes": [{ "id", "kind", "label"? }], "edges": [{ "source", "target", "label"? }] }`.

## Versions

The version is in the front matter of `SKILL.md`. This repository mirrors the skill that ships with the app; changes are made there and published here.

Vendor names in the catalog are trademarks of their respective owners.

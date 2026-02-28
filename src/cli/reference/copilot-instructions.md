---
# AGENT-FORGE Generation Workspace
# This file is loaded by GitHub Copilot CLI during the generation process.
# It defines the output format that ALL generated artifacts must follow.
# Generated artifacts are VS Code-compatible and also work in GitHub Copilot CLI.
---

# AGENT-FORGE — Output Format Specification

This file guides the **GitHub Copilot CLI** (the generation engine) to produce artifacts in the correct format. All generated files are **VS Code-compatible** and also work in GitHub Copilot CLI at runtime.

## Agent File Format (`.agent.md`)

```yaml
---
name: "Display Name"                    # REQUIRED
description: "What this agent does"     # REQUIRED
argument-hint: "[task] [details]"       # Recommended — placeholder in chat input
tools:                                  # Array of tool aliases (see Tool Aliases below)
  - read                                #   Read file contents (aliases: Read, NotebookRead)
  - edit                                #   Modify files (aliases: Edit, MultiEdit, Write, NotebookEdit)
  - search                              #   Grep/glob search (aliases: Grep, Glob)
  - execute                             #   Shell/terminal commands (aliases: shell, Bash, powershell, run_in_terminal)
  - agent                               #   Invoke sub-agents (aliases: custom-agent, Task)
  - web                                 #   Fetch URLs (aliases: WebSearch, WebFetch)
  - todo                                #   Task lists (aliases: TodoWrite)
  - get_errors                          #   Check diagnostics
user-invocable: true                    # Show in agent dropdown (default: true)
disable-model-invocation: false         # Prevent auto-delegation (default: false)
target: "vscode"                        # Optional: "vscode" or "github-copilot" (both if omitted)
handoffs:                               # Multi-agent workflow transitions
  - label: "Hand off to Backend"
    agent: "express"
    prompt: "Continue with backend work"
    send: false
---

Body: markdown instructions for the agent.
```

### Tool Aliases Reference

| Alias | Platform Equivalents | Description |
|-------|---------------------|-------------|
| `execute` | shell, Bash, powershell | Execute shell commands |
| `read` | Read, NotebookRead | Read file contents |
| `edit` | Edit, MultiEdit, Write, NotebookEdit | Modify files |
| `search` | Grep, Glob | Search files or text |
| `agent` | custom-agent, Task | Invoke other agents |
| `web` | WebSearch, WebFetch | Fetch URLs, web search |
| `todo` | TodoWrite | Create/manage task lists |
| `github/*` | — | GitHub MCP server tools |
| `playwright/*` | — | Playwright MCP server tools |

Unrecognized tool names are ignored, enabling cross-product compatibility.

## Custom Instructions Discovery

At runtime, GitHub Copilot (in VS Code and Copilot CLI) discovers and loads instructions from these locations:

| Location | Scope |
|----------|-------|
| `~/.copilot/copilot-instructions.md` | Global (all sessions) |
| `.github/copilot-instructions.md` | Repository |
| `.github/instructions/**/*.instructions.md` | Repository (modular) |
| `AGENTS.md` (Git root or cwd) | Repository |
| `Copilot.md`, `GEMINI.md`, `CODEX.md` | Repository |

Repository instructions take precedence over global instructions.

## Instruction File Format (`.instructions.md`)

```yaml
---
name: "instruction-slug"               # REQUIRED
description: "What standards are enforced"  # REQUIRED
applyTo: "**/*.{ts,tsx,js,jsx}"        # REQUIRED — glob for auto-loading
---

Body: rules grouped under ## headings, bullet points with reasoning.
```

**applyTo must be specific** — `**/*` wastes context. Use file-type patterns.

## Skill File Format (`SKILL.md`)

```yaml
---
name: "skill-slug"                      # REQUIRED
description: "Domain knowledge. USE FOR: 5+ trigger phrases. DO NOT USE FOR: 3+ exclusions."  # REQUIRED
argument-hint: "[topic]"
---

Body: ## Overview, patterns, ## When to Use, ## When NOT to Use. Keep <4000 chars.
```

**Skill description controls on-demand loading.** Always include `USE FOR:` and `DO NOT USE FOR:` trigger phrases.

## Prompt File Format (`.prompt.md`)

```yaml
---
name: "prompt-slug"                     # REQUIRED — becomes /slash command
description: "What this command does"   # REQUIRED
agent: "agent-name"                     # Route to specific agent
argument-hint: "[task description]"
---

Body: task template with ${input:name:placeholder}, ${selection}, ${file} variables.
```

## Hook Config Format (`.json`)

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [{ "type": "command", "bash": "./script.sh", "powershell": "./script.ps1", "timeoutSec": 10 }],
    "postToolUse": [{ "type": "command", "bash": "./script.sh", "powershell": "./script.ps1", "timeoutSec": 15 }]
  }
}
```

Hook files MUST include `"version": 1`. Use `"bash"`/`"powershell"` keys (not `"command"`). Use `"timeoutSec"` (not `"timeout"`).

Events: `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `errorOccurred`, `subagentStop`, `agentStop`

## MCP Server Config Format (`.vscode/mcp.json`)

```json
{
  "servers": {
    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp" },
    "custom": { "command": "npx", "args": ["-y", "package-name"], "env": { "KEY": "${input:API_KEY}" } }
  }
}
```

## Quality Rules

1. **No generic filler** — "follow best practices" is not a responsibility. Name specific patterns.
2. **Tech-specific standards** — every Technical Standard must reference actual framework APIs, patterns, or conventions.
3. **Minimum 4 responsibilities** per agent, each tied to the specific tech stack.
4. **Opening line** must name the technology: "You are the **React Specialist** — ..." not "You are the Agent..."
5. **applyTo must be specific** — `**/*.{tsx,jsx}` not `**/*`.
6. **Skill descriptions** must have ≥5 `USE FOR` and ≥3 `DO NOT USE FOR` trigger phrases.
7. **No duplicate content** — instructions codify standards, skills provide knowledge, agents define behavior. Don't repeat across them.
8. All agents that build/test code must include `execute` (or `run_in_terminal`) and `get_errors` in tools.

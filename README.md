<p align="center">
  <a href="https://github.com/microsoft/agent-forge">
    <img src="assets/Screenshot 2569-03-02 at 00.25.20.png" alt="AGENT-FORGE" width="800"/>
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@agent-forge-copilot/cli"><img src="https://img.shields.io/npm/v/@agent-forge-copilot/cli?color=orange" alt="npm version"/></a>
  <a href="https://github.com/microsoft/agent-forge/blob/main/LICENSE"><img src="https://img.shields.io/github/license/microsoft/agent-forge" alt="license"/></a>
</p>

---

## What is AGENT-FORGE?

AGENT-FORGE is a Context Engineering Toolkit that generates GitHub Copilot customization files for your VS Code project. Instead of manually authoring `.github/` configuration, you describe what you need and a multi-agent AI pipeline plans, generates, validates, and installs everything.

- **Multi-agent generation** — a planner decomposes your project into domains, then 7 specialized writer agents create tailored artifacts
- **Greenfield & brownfield** — works from a description (new projects) or scans your existing codebase to codify real patterns
- **Tech stack detection** — identifies frameworks, libraries, and conventions from your project files
- **Post-generation validation** — checks YAML frontmatter, tool names, glob patterns, and content quality with auto-fix

---

## How It Works

AGENT-FORGE uses a **plan-then-execute** architecture powered by GitHub Copilot CLI:

1. **Plan** — A planner agent analyzes your description (greenfield) or scans your codebase (brownfield), extracts the tech stack, decomposes it into domains, and outputs a `forge-plan.json`.
2. **Execute** — An orchestrator reads the plan and delegates to 7 specialized writer agents that create each artifact type.
3. **Validate** — All generated files are checked for YAML correctness, valid tool names, and content quality. Issues are auto-fixed when possible.
4. **Install** — Artifacts are placed into `.github/` and `.vscode/` with smart merge logic.

```
forge init / generate
        │
        ▼
   ┌─────────┐     Analyzes description or scans codebase
   │ Planner  │──▶  Extracts tech stack, decomposes domains
   └────┬────┘     Outputs forge-plan.json
        │
        ▼
   ┌──────────────┐
   │ Orchestrator  │──▶  Reads plan, delegates to writers
   └──────┬───────┘
          │
          ├──▶ Agent Writer       → *.agent.md
          ├──▶ Instruction Writer → *.instructions.md
          ├──▶ Skill Writer       → SKILL.md
          ├──▶ Prompt Writer      → *.prompt.md
          ├──▶ Hook Writer        → hooks/*.json
          ├──▶ MCP Writer         → .vscode/mcp.json
          └──▶ Workflow Writer    → workflows/*.md
                                        │
                                        ▼
                                  Validate & Auto-fix
                                        │
                                        ▼
                                  Install to .github/
```

---

## Prerequisites

**Required:**

- **Node.js 18+**
- **VS Code** (or VS Code Insiders) with the GitHub Copilot extension
- **[GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli)** — powers the generation pipeline

**Optional:**

- **Git** — version control
- **GitHub CLI** (`gh`) — needed for agentic workflows
- **Docker** — needed by some MCP servers

Run `forge check` to verify everything in one step.

---

## Quick Start

```bash
npm install -g @agent-forge-copilot/cli
```

> Or run without installing: `npx @agent-forge-copilot/cli init`

### 🟢 Create — Start from a Description

Describe what you're building. The AI plans and generates everything from scratch.

```bash
forge init --mode create
```

You'll be prompted for a description interactively — or pass it directly:

```bash
forge init --mode create --description "Next.js e-commerce app with Stripe payments"
```

### 🔵 Analyze — Scan Your Existing Project

Already have code? The tool scans your repo and generates Copilot configs that match your real stack.

```bash
forge init --mode analyze
```

### 📦 Templates — Install Pre-Built Configs

Skip AI entirely. Pick from ready-made templates:

```bash
forge init --mode templates
```

### What gets created

```
.github/
├── agents/                # AI personas — define what Copilot can do
├── prompts/               # Slash commands — shortcuts you type in chat
├── instructions/          # Rules — auto-applied to matching file patterns
├── skills/                # Knowledge packs — domain info agents reference
├── hooks/                 # Automation — scripts triggered by agent events
├── workflows/             # GitHub Actions with AI automation
└── copilot-instructions.md
.vscode/
└── mcp.json               # External tool servers (GitHub, Playwright, etc.)
```

---

## Example Prompts

The description you provide drives the entire generation. Here are examples from simple to detailed.

### 🟢 Create Mode — Describe Your App

```bash
forge init --mode create
```

You'll be prompted: *"Describe your project"*. The quality of your description affects the output:

**Simple** — works, but generates generic config:
```
Todo app
```

**Better** — detects 2 tech layers, creates 2 specialized agents:
```
Todo app with React and Express
```

**Best** — full stack detection, tailored agents + instructions + skills for each layer:
```
Todo app with React frontend using TailwindCSS, Express REST API
with Prisma ORM and PostgreSQL, JWT auth, and Docker deployment
```

**More examples you can try:**

```
E-commerce marketplace with Next.js, Stripe checkout, and Supabase
```

```
RAG chatbot using LangChain, FastAPI, and Pinecone vector store
```

```
REST API for fitness tracking with NestJS, Prisma, and Redis caching
```

```
Event-driven microservices with Go, gRPC, Kafka, and Kubernetes
```

```
Node.js CLI that converts Markdown to PDF with custom templates
```

#### Writing Better Descriptions

| Tip | Example |
|-----|---------|
| Name your frameworks | `Next.js` not `React framework` |
| Mention your database | `PostgreSQL`, `MongoDB`, `Redis` |
| Include infrastructure | `Docker`, `Kubernetes`, `AWS` |
| Add business context | `e-commerce`, `healthcare`, `fintech` |
| Specify patterns | `TDD`, `microservices`, `event-driven` |

> The more specific your description, the more tailored the output. Business context like `"e-commerce"` or `"healthcare"` triggers domain-specific agent patterns.

### 🔵 Analyze Mode — Scan Your Codebase

```bash
forge init --mode analyze
```

No description needed — the tool scans your codebase automatically. Just choose a strategy:

| Strategy | Command | What it does |
|----------|---------|-------------|
| **Auto** | `forge init --mode analyze --strategy auto` | Scans your repo and generates configs automatically — no questions asked |
| **Guided** | `forge init --mode analyze --strategy guided` | Scans your repo, then asks what you'd like to add on top |

The analyzer detects:
- `package.json`, `requirements.txt`, `go.mod` → your tech stack
- `src/` structure → your project layout
- Existing `.github/` files → avoids duplicating what you already have

---

## Features

### 7 Artifact Types

| Type | File Pattern | Purpose |
|------|-------------|---------|
| Agent | `*.agent.md` | AI persona with tools, responsibilities, and process |
| Prompt | `*.prompt.md` | Slash command that routes to an agent |
| Instruction | `*.instructions.md` | Quality rules auto-applied to matching files |
| Skill | `SKILL.md` | Domain knowledge loaded on-demand |
| Hook | `hooks/*.json` | Lifecycle automation triggered on agent events |
| MCP Config | `.vscode/mcp.json` | External tool servers for AI-powered development |
| Workflow | `workflows/*.md` | GitHub Actions with AI automation |

### Project Modes

| Mode | Description |
|------|-------------|
| **Greenfield** | Provide a description. The planner extracts the tech stack, decomposes domains, and generates everything from scratch. |
| **Brownfield** | The planner scans your codebase — `package.json`, source files, directory structure, existing `.github/` config — and creates a plan aligned to your real patterns. |

### Speed Modes

| Mode | How it works | Cost |
|------|-------------|------|
| **Standard** | Single Copilot CLI session, orchestrator creates all files sequentially | ~2 PRU |
| **Turbo** | Single session with `/fleet` — parallel subagents, each with their own context | ~N+1 PRU |

### Smart Merging

When generating into a project with existing `.github/` files, AGENT-FORGE detects files it previously generated (via `<!-- Generated by AGENT-FORGE -->` markers) and only overwrites those. User-created files are preserved. Use `--force` to override.

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `forge init` | Interactive setup wizard |
| `forge generate <description>` | Generate Copilot files from a description |
| `forge list` | Show installed and available use cases |
| `forge validate [scope]` | Check config files for errors |
| `forge check` | Verify prerequisites |

<details>
<summary><strong>forge init</strong></summary>

| Flag | Description |
|------|-------------|
| `--mode <mode>` | Wizard mode: `create`, `analyze`, or `templates` |
| `--description <text>` | Use case description (skip prompt) |
| `--model <model>` | AI model to use (skip prompt) |
| `--strategy <strategy>` | Analyze strategy: `auto` (scan-only) or `guided` (scan + custom requirements) |
| `--speed <speed>` | `standard` or `turbo` |
| `--use-cases <ids>` | Comma-separated template IDs (e.g., `code-review,testing`) |
| `--skip-check` | Skip the prerequisite check |
| `--force` | Overwrite existing files |

```bash
forge init
forge init --mode templates --use-cases code-review,testing
forge init --mode analyze --strategy auto
forge init --mode create --description "Next.js app" --model claude-sonnet-4.6 --speed turbo
```

</details>

<details>
<summary><strong>forge generate</strong></summary>

| Flag | Description |
|------|-------------|
| `--model <model>` | AI model to use |
| `--mode <mode>` | `discovery`, `full`, `on-demand`, `mcp-server`, `hooks`, `agentic-workflow` |
| `--types <types>` | Comma-separated artifact types for on-demand mode |
| `--speed <speed>` | `standard` or `turbo` |

```bash
forge generate "API rate limiter with per-tenant limits"
forge generate "Security scanner" --model claude-opus-4.6
forge generate "CI/CD automation" --mode hooks
forge generate "Dev tooling" --mode mcp-server
forge generate "Testing tools" --mode on-demand --types agent,hook
forge generate "Full-stack app" --speed turbo
```

</details>

<details>
<summary><strong>forge validate</strong></summary>

| Flag | Description |
|------|-------------|
| `--fix` | Auto-fix issues using AI |
| `--no-fix` | Skip the interactive fix prompt |
| `--model <model>` | Model for AI-powered fixes |

```bash
forge validate
forge validate ./path/to/dir
forge validate --fix
forge validate --fix --model claude-opus-4.6
```

</details>

<details>
<summary><strong>forge list</strong></summary>

Shows which Copilot customization files exist in your project and which gallery templates are available. No flags.

```bash
forge list
```

</details>

<details>
<summary><strong>forge check</strong></summary>

Verifies that Node.js, VS Code, Git, GitHub CLI, Copilot CLI, and Docker are installed. No flags.

```bash
forge check
```

</details>

<details>
<summary><strong>Model selection</strong></summary>

Pass `--model <value>` or choose interactively during generation:

| Value | Name | Description | Premium |
|-------|------|-------------|---------|
| `claude-sonnet-4.6` | Claude Sonnet 4.6 | Fastest — best speed/quality tradeoff **(default)** | 1× |
| `claude-sonnet-4.5` | Claude Sonnet 4.5 | Fast — higher quality reasoning | 1× |
| `gpt-4.1` | GPT-4.1 | Fast — efficient code generation | 1× |
| `gpt-5.2-codex` | GPT 5.2 Codex | Balanced — strong code generation | 1× |
| `gemini-3-pro-preview` | Gemini 3 Pro | Strong reasoning — large context window | 2× |
| `claude-opus-4.6` | Claude Opus 4.6 | Highest quality — deep reasoning | 5× |

</details>

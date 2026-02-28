/**
 * Prompt Builder — reference-driven prompt construction for Copilot CLI generation.
 *
 * Key design principle: prompts include REAL gallery examples as format references
 * so the LLM sees the exact quality/format expected, rather than relying on
 * verbose format descriptions. This produces significantly higher quality output.
 */
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import type {
  Domain,
  GenerationMode,
  ArtifactType,
  GenerationPlan,
  PlannedAgent,
  WorkspaceInfo,
} from "../types.js";
import { mergeGlobs } from "./domain-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Reference Example Loader ───

function getTemplatesDir(): string {
  const candidates = [
    path.resolve(__dirname, "templates"),
    path.resolve(__dirname, "..", "templates"),
    path.resolve(__dirname, "..", "src", "templates"),
  ];
  for (const candidate of candidates) {
    if (fs.pathExistsSync(candidate)) return candidate;
  }
  return "";
}

let _referenceExamples: {
  agent: string;
  instruction: string;
  prompt: string;
  skill: string;
} | null = null;

/**
 * Load gallery templates as reference examples for the LLM.
 * Cached after first load.
 */
function loadReferenceExamples(): typeof _referenceExamples {
  if (_referenceExamples) return _referenceExamples;

  const templatesDir = getTemplatesDir();
  if (!templatesDir) return null;

  const galleryDir = path.join(templatesDir, "gallery", "code-review");

  try {
    _referenceExamples = {
      agent: fs.readFileSync(path.join(galleryDir, "agents", "code-review.agent.md"), "utf-8"),
      instruction: fs.readFileSync(path.join(galleryDir, "instructions", "code-review.instructions.md"), "utf-8"),
      prompt: fs.readFileSync(path.join(galleryDir, "prompts", "code-review.prompt.md"), "utf-8"),
      skill: fs.readFileSync(path.join(galleryDir, "skills", "code-review", "SKILL.md"), "utf-8"),
    };
  } catch {
    _referenceExamples = null;
  }

  return _referenceExamples;
}

// ─── VSCode Format Spec ───

const VSCODE_AGENT_SPEC = `## VSCode Agent Format Specification

YAML frontmatter properties (all agents MUST include these):
- \`name\`: string — display name for the agent
- \`description\`: string (REQUIRED) — purpose and capabilities
- \`tools\`: list of strings — tool aliases the agent can use:
  - \`read\` (read files — aliases: Read, NotebookRead)
  - \`edit\` (modify files — aliases: Edit, MultiEdit, Write, NotebookEdit)
  - \`search\` (grep/glob — aliases: Grep, Glob)
  - \`execute\` (shell/terminal — aliases: shell, Bash, powershell, run_in_terminal)
  - \`agent\` (invoke sub-agents — aliases: custom-agent, Task)
  - \`web\` (fetch URLs — aliases: WebSearch, WebFetch)
  - \`todo\` (task lists — aliases: TodoWrite)
  - \`get_errors\` — check diagnostics
  - MCP server tools: \`github/*\`, \`playwright/*\`, or \`server-name/tool-name\`
  - Unrecognized tool names are silently ignored (cross-product safe)
- \`user-invocable\`: boolean (default: true) — whether users can select this agent
- \`disable-model-invocation\`: boolean (default: false) — prevent auto-delegation
- \`argument-hint\`: string — shown to users as placeholder text
- \`target\`: string — optional, "vscode" or "github-copilot" (defaults to both)
- \`mcp-servers\`: object — optional inline MCP server config for this agent
- \`handoffs\`: list of handoff definitions for multi-agent workflows:
  - \`label\`: button text shown to user
  - \`agent\`: target agent name
  - \`prompt\`: message sent when handing off
  - \`send\`: boolean (whether to send immediately)

Body content (Markdown below the frontmatter):
- Opening: "You are the **Name** — a [role] that [purpose]."
- ## Responsibilities — 4-6 specific duties (not generic)
- ## Technical Standards — 4-6 concrete rules referencing the actual tech stack
- ## Process — numbered steps: Understand → Plan → Build → Verify`;

const VSCODE_INSTRUCTION_SPEC = `## VSCode Instruction Format Specification

YAML frontmatter:
- \`name\`: string — identifier for the instruction
- \`description\`: string — what standards this instruction enforces
- \`applyTo\`: string (REQUIRED) — glob pattern for when this loads (e.g., "**/*.{ts,tsx}")
  IMPORTANT: Must be specific, NOT "**/*" unless truly universal.

Body: Grouped rules under ## headings with bullet points.`;

const VSCODE_SKILL_SPEC = `## VSCode Skill Format Specification

YAML frontmatter:
- \`name\`: string (REQUIRED) — lowercase, hyphens for spaces, matches directory name
- \`description\`: string (REQUIRED) — MUST include:
  - "USE FOR:" followed by 5+ trigger phrases (comma-separated)
  - "DO NOT USE FOR:" followed by 3+ exclusion phrases
  This controls when Copilot automatically loads the skill.
- \`license\`: string (optional) — license that applies to this skill

Skill locations: \`.github/skills/\` or \`.claude/skills/\` (project), \`~/.copilot/skills/\` (personal)

Body: ## Overview, architecture patterns, ## When to Use, ## When NOT to Use`;

const VSCODE_PROMPT_SPEC = `## VSCode Prompt Format Specification

YAML frontmatter:
- \`name\`: string — slash command name (kebab-case)
- \`description\`: string — shown in command palette
- \`agent\`: string — primary agent to route to
- \`argument-hint\`: string — placeholder text

Body: Task template with \${input:name:placeholder} variables, focus areas, output format.`;

// ─── Reference Plan Example ───

const REFERENCE_PLAN = `{
  "slug": "ecommerce",
  "title": "E-Commerce Platform",
  "description": "E-commerce platform with Next.js storefront and FastAPI product service",
  "agents": [
    {
      "name": "nextjs",
      "title": "Next.js Storefront",
      "role": "Builds the e-commerce storefront with Next.js App Router, server components, and TailwindCSS",
      "category": "frontend",
      "techStack": ["nextjs", "react", "tailwindcss", "typescript"],
      "responsibilities": [
        "Build product listing and detail pages using Next.js App Router with server components and streaming",
        "Implement shopping cart with React Context and useOptimistic for instant feedback",
        "Create responsive product grid layouts with TailwindCSS and CSS Grid",
        "Handle client-side search with debounced input and URL search params via useSearchParams",
        "Write component tests with React Testing Library and MSW for API mocking"
      ],
      "applyToGlob": "**/*.{tsx,jsx,css,scss}",
      "instruction": {
        "description": "Next.js App Router conventions, server vs client component boundaries, TailwindCSS utility patterns, and React hooks architecture"
      },
      "skill": {
        "description": "Next.js App Router patterns, React server components, and TailwindCSS styling for e-commerce. USE FOR: next.js pages, react components, server components, client components, tailwind styling, shopping cart, product listing, useSearchParams, app router, layout components. DO NOT USE FOR: Python code, FastAPI endpoints, database models, API authentication, SQL queries."
      }
    },
    {
      "name": "fastapi",
      "title": "FastAPI Product Service",
      "role": "Builds the product catalog API with FastAPI, SQLAlchemy, and Pydantic validation",
      "category": "backend",
      "techStack": ["fastapi", "python", "sqlalchemy", "pydantic"],
      "responsibilities": [
        "Build product CRUD endpoints with FastAPI router using async/await and Depends() injection",
        "Define Pydantic request/response models with field validation for product data",
        "Implement SQLAlchemy async ORM models with Alembic migrations for the product catalog",
        "Create authentication middleware with JWT tokens and FastAPI Security utilities",
        "Write API tests with pytest and httpx AsyncClient for endpoint coverage"
      ],
      "applyToGlob": "**/*.py",
      "instruction": {
        "description": "FastAPI router patterns, Pydantic model conventions, SQLAlchemy async session management, and pytest testing standards"
      },
      "skill": {
        "description": "FastAPI REST API development with SQLAlchemy ORM and Pydantic schemas. USE FOR: fastapi routes, pydantic models, sqlalchemy queries, api endpoints, dependency injection, pytest fixtures, alembic migrations, async python, REST API design. DO NOT USE FOR: React components, Next.js pages, frontend styling, JavaScript code, CSS."
      }
    }
  ],
  "prompt": {
    "slug": "ecommerce",
    "description": "Scaffold e-commerce features across the Next.js storefront and FastAPI product service"
  }
}`;

// ─── Planning Prompt Builder ───

/**
 * Build a planning prompt for the forge-planner agent.
 * Includes reference plan example, quality criteria, and anti-pattern warnings
 * so the planner produces high-specificity output on the first attempt.
 */
export function buildPlanningPrompt(
  mode: GenerationMode,
  slug: string,
  title: string,
  description: string,
  domains: Domain[] = [],
  workspace?: WorkspaceInfo,
  selectedTypes?: ArtifactType[],
): string {
  const effectiveDomains = domains.length > 0
    ? domains
    : [{ slug: "general", title, category: "general" as const, techStack: [] as string[], applyToGlob: "**/*" }];

  const domainContext = effectiveDomains.map((d) => {
    const tech = d.techStack.length > 0 ? d.techStack.join(", ") : d.category;
    return `- **${d.title}** (${tech}): ${d.category} domain`;
  }).join("\n");

  const sections: string[] = [
    `Create a generation plan for: "${description}"`,
    ``,
    `## Generation Mode: ${mode}`,
    ``,
    `## Context`,
    `- Suggested slug: ${slug}`,
    `- Suggested title: ${title}`,
    ``,
    `## Detected Domains (hints — you may override with better decomposition)`,
    domainContext,
    ``,
  ];

  // Agent decomposition hints based on domain count
  if (effectiveDomains.length === 1 && effectiveDomains[0].slug === "general") {
    sections.push(
      `## Agent Decomposition Hint`,
      `Only 1 domain detected and no specific frameworks found. Plan **1 agent** unless the description clearly implies multiple distinct technology layers.`,
      ``,
    );
  } else if (effectiveDomains.length === 1) {
    sections.push(
      `## Agent Decomposition Hint`,
      `1 domain detected. Plan **1 agent** named after the primary framework. Only split into 2 agents if the domain has clearly distinct sub-layers with different file types.`,
      ``,
    );
  } else if (effectiveDomains.length === 2) {
    sections.push(
      `## Agent Decomposition Hint`,
      `2 domains detected. Plan **2 agents** — one per domain, each named after its primary framework. Merge if they share the same framework.`,
      ``,
    );
  } else {
    sections.push(
      `## Agent Decomposition Hint`,
      `${effectiveDomains.length} domains detected. Plan **2-${Math.min(effectiveDomains.length, 4)} agents**. Merge closely related domains (e.g., data layer into backend). Name each after its primary framework.`,
      ``,
    );
  }

  // Discovery mode: include workspace context
  if (mode === "discovery" && workspace) {
    sections.push(
      `## Workspace Analysis (from auto-detection)`,
      ``,
      workspace.projectType ? `- Project type: ${workspace.projectType}` : `- Project type: unknown`,
      workspace.techStack.length > 0 ? `- Tech stack: ${workspace.techStack.join(", ")}` : `- Tech stack: not detected`,
    );

    const existing: string[] = [];
    if (workspace.existingAgents.length > 0) existing.push(`agents: ${workspace.existingAgents.join(", ")}`);
    if (workspace.existingPrompts.length > 0) existing.push(`prompts: ${workspace.existingPrompts.join(", ")}`);
    if (workspace.existingInstructions.length > 0) existing.push(`instructions: ${workspace.existingInstructions.join(", ")}`);
    if (workspace.existingSkills.length > 0) existing.push(`skills: ${workspace.existingSkills.join(", ")}`);
    if (workspace.existingHooks.length > 0) existing.push(`hooks: ${workspace.existingHooks.join(", ")}`);

    if (existing.length > 0) {
      sections.push(`- Existing customizations (DO NOT duplicate): ${existing.join("; ")}`);
    }

    sections.push(
      ``,
      `**IMPORTANT**: You are in Discovery Mode. The project's source files are available in your working directory — you can directly read package.json, list src/, etc.`,
      `SCAN the project codebase before planning. Do NOT skip scanning or plan from the description alone.`,
      `- Read the dependency manifest (package.json, pyproject.toml, etc.) → record the PRIMARY framework → this becomes the agent name`,
      `- List the src/ or app/ directory → identify architectural layers (frontend/backend/AI)`,
      `- Count distinct architectural layers → this determines agent count`,
      `- Extract test runner, ORM, and CSS framework → these go into techStack and responsibilities`,
      `- Read 2-3 actual source files → encode the real patterns you find into responsibilities`,
      `Plan agents that target actual components/layers found in the codebase.`,
      ``,
    );
  } else if (workspace) {
    // Brownfield non-discovery mode: still tell the planner that project files are available
    sections.push(
      `## Workspace Context`,
      ``,
      `The project's source files are available in your working directory.`,
      workspace.techStack.length > 0 ? `- Detected tech stack: ${workspace.techStack.join(", ")}` : ``,
      `- You can read package.json, list src/, and scan source files to improve plan quality.`,
      ``,
    );
  }

  // Mode-specific artifact expectations
  switch (mode) {
    case "full":
    case "discovery":
      sections.push(
        `## Artifacts to Plan`,
        `- **agents**: Decompose into 1-4 agents with meaningful names (use primary framework name as agent slug, e.g. "reactjs", "fastapi", "langchain")`,
        `- Each agent gets its OWN **instruction** (with specific applyTo glob for its file types) and **skill** (with USE FOR/DO NOT USE FOR trigger phrases)`,
        `- **prompt**: One shared prompt file that routes to all agents`,
        `- **copilot-instructions.md**: Brief project-level overview (<50 lines)`,
        `- Do NOT create shared/combined instruction or skill files`,
        ``,
      );
      break;
    case "on-demand": {
      const types = selectedTypes ?? ["agent", "instruction", "prompt", "skill"];
      sections.push(
        `## Artifacts to Plan (selected types only)`,
        ...types.map((t) => `- **${t}**`),
        ``,
      );
      break;
    }
    case "hooks":
      sections.push(`## Artifacts to Plan`, `- **hooks**: Plan hook events and companion scripts`, ``);
      break;
    case "mcp-server":
      sections.push(`## Artifacts to Plan`, `- **mcp**: Plan MCP server configuration`, ``);
      break;
    case "agentic-workflow":
      sections.push(`## Artifacts to Plan`, `- **workflow**: Plan the agentic workflow trigger and purpose`, ``);
      break;
  }

  // Reference plan example — shows the LLM exactly what quality looks like
  sections.push(
    `## Reference Plan (match this quality level)`,
    ``,
    `For a description like "E-commerce platform with Next.js storefront and FastAPI product service":`,
    ``,
    "```json",
    REFERENCE_PLAN,
    "```",
    ``,
    `Notice: framework-based agent names, 5 tech-specific responsibilities per agent, populated techStack arrays, specific applyToGlob patterns, and rich skill descriptions with USE FOR/DO NOT USE FOR phrases.`,
    ``,
  );

  // Quality requirements
  sections.push(
    `## Quality Requirements`,
    ``,
    `Every plan you produce MUST meet these criteria:`,
    ``,
    `1. **Responsibility specificity**: Every responsibility MUST name a specific framework, API, or pattern — e.g., "Build pages with Next.js App Router" not "build frontend pages"`,
    `2. **techStack completeness**: If the description mentions technologies, every agent's \`techStack\` array MUST contain ≥1 entry. Empty \`techStack\` is only acceptable for vague 1-agent plans.`,
    `3. **Glob precision**: \`applyToGlob\` MUST be specific per agent (e.g., \`**/*.{tsx,jsx,css}\`). The catch-all \`**/*\` is only acceptable for a single general agent when no tech is specified.`,
    `4. **Skill trigger phrases**: Every skill description MUST have ≥5 \`USE FOR\` phrases and ≥3 \`DO NOT USE FOR\` phrases.`,
    `5. **Agent naming**: Use the primary framework name (e.g., \`nextjs\`, \`fastapi\`) not generic layer names (e.g., ~~\`frontend\`~~, ~~\`backend\`~~) when a framework is known.`,
    `6. **No overlap**: No two agents should have the same \`applyToGlob\` pattern or duplicate responsibilities.`,
    ``,
  );

  // Anti-pattern warnings
  sections.push(
    `## Anti-Patterns (NEVER produce these)`,
    ``,
    `Your plan is INVALID if it contains any of:`,
    `- Responsibilities with "follow best practices", "ensure quality", "maintain code standards", "handle errors properly"`,
    `- Empty \`techStack: []\` when the description mentions specific technologies`,
    `- \`applyToGlob: "**/*"\` on a framework-specific agent`,
    `- Two agents with identical \`applyToGlob\` patterns`,
    `- Agent names with filler words: ~~"frontend-app"~~, ~~"backend-system"~~, ~~"api-service"~~ — use the framework name`,
    `- More agents than distinct frameworks/layers in the description`,
    `- Skill descriptions missing \`USE FOR:\` and \`DO NOT USE FOR:\` phrases`,
    `- Role descriptions like "handles the frontend" — instead: "Builds React components with TypeScript and TailwindCSS"`,
    ``,
  );

  // Rules
  sections.push(
    `## Rules`,
    `- Write ONLY \`forge-plan.json\` in the workspace root.`,
    `- Do NOT create any .agent.md, .prompt.md, .instructions.md, or SKILL.md files.`,
    `- Agent names must be meaningful and tech-aligned (use primary framework/library name, not generic domain slugs).`,
    `- Do NOT ask clarifying questions — make the best decision based on available information.`,
    `- Self-check your plan against the Quality Requirements and Anti-Patterns lists before writing.`,
    `- Stop immediately after writing the plan file.`,
  );

  return sections.join("\n");
}

// ─── Orchestration Prompt Builder (Plan-based) ───

/**
 * Build an orchestration prompt from a parsed GenerationPlan.
 * Used for standard (non-turbo) mode — single session, sequential file creation.
 * Includes format specs and reference examples inline so the orchestrator has
 * everything it needs without reading external reference files.
 */
export function buildOrchestrationPromptFromPlan(
  plan: GenerationPlan,
  mode: GenerationMode,
): string {
  const refs = loadReferenceExamples();

  const sections: string[] = [
    `Generate VS Code-compatible Copilot customization files based on the following plan.`,
    `All generated artifact files MUST follow VS Code format specs (see below). These artifacts also work in GitHub Copilot CLI.`,
    ``,
    `## Use Case`,
    `"${plan.description}"`,
    ``,
    `## Generation Mode: ${mode}`,
    ``,
  ];

  // Embed VSCode format specs so sub-agents know the exact expected format
  sections.push(
    VSCODE_AGENT_SPEC,
    ``,
    VSCODE_INSTRUCTION_SPEC,
    ``,
    VSCODE_SKILL_SPEC,
    ``,
    VSCODE_PROMPT_SPEC,
    ``,
  );

  // Include reference examples if available
  if (refs) {
    sections.push(
      `## Reference Examples (match this format and quality level)`,
      ``,
      `### Example Agent File`,
      "```markdown",
      refs.agent.slice(0, 1500),
      "```",
      ``,
      `### Example Instruction File`,
      "```markdown",
      refs.instruction,
      "```",
      ``,
      `### Example Prompt File`,
      "```markdown",
      refs.prompt,
      "```",
      ``,
    );
  }

  // Agent delegation
  if (plan.agents.length > 0) {
    const agentDetails = plan.agents.map((a: PlannedAgent) => {
      const tech = a.techStack.length > 0 ? ` (${a.techStack.join(", ")})` : "";
      const resp = a.responsibilities.map((r: string) => `    - ${r}`).join("\n");
      return [
        `  - **Agent file**: \`.github/agents/${a.name}.agent.md\``,
        `    - Title: ${a.title}`,
        `    - Role: ${a.role}${tech}`,
        `    - Category: ${a.category}`,
        `    - ApplyTo: ${a.applyToGlob}`,
        `    - Responsibilities:`,
        resp,
        `  - **Instruction file**: \`.github/instructions/${a.name}.instructions.md\``,
        `    - ApplyTo: "${a.applyToGlob}"`,
        `    - Description: "${a.instruction.description}"`,
        `  - **Skill file**: \`.github/skills/${a.name}/SKILL.md\``,
        `    - Description: "${a.skill.description}"`,
      ].join("\n");
    }).join("\n\n");

    sections.push(
      `## Artifacts to Create (per-agent aligned architecture)`,
      ``,
      `Each agent gets its own instruction file (loaded via applyTo globs) and skill file (loaded on-demand via trigger phrases).`,
      ``,
      agentDetails,
      ``,
      `### Creation Tasks`,
      ``,
      `Create each artifact type following the format specs above.`,
      ``,
      `**Agent files** — Create ALL agent files listed above.`,
      `  - Each MUST include: \`argument-hint\`, \`user-invocable: true\`, \`execute\` (or \`run_in_terminal\`) and \`get_errors\` in tools list.`,
      plan.agents.length > 1 ? `  - Add \`handoffs\` between agents so users can transition between them.` : ``,
      `**Instruction files** — Create ALL instruction files (one per agent, each with its own applyTo glob).`,
      `**Skill files** — Create ALL skill files (one per agent). Each skill description MUST have ≥5 USE FOR and ≥3 DO NOT USE FOR trigger phrases.`,
      ``,
    );
  }

  // Prompt
  if (plan.prompt) {
    sections.push(
      `**Prompt file** — Create: \`.github/prompts/${plan.prompt.slug}.prompt.md\``,
      `  - Description: "${plan.prompt.description}"`,
      `  - Include \`agent:\` and \`argument-hint:\` in frontmatter.`,
      `  - Route to all agents: ${plan.agents.map((a) => `@${a.title}`).join(", ")}`,
      ``,
    );
  }

  // copilot-instructions.md
  sections.push(
    `### Global Workspace Instructions`,
    `Create: \`.github/copilot-instructions.md\``,
    `Brief project overview, architecture, agent references, key conventions. Keep <50 lines.`,
    `Do NOT duplicate per-agent instruction content.`,
    ``,
  );

  // Optional hooks/mcp/workflow
  if (plan.hooks) {
    sections.push(
      `**Hook config** — Create: \`.github/hooks/${plan.hooks.slug}.json\` with companion scripts`,
      `Events: ${plan.hooks.events.join(", ")}. Purpose: "${plan.hooks.description}"`,
      ``,
    );
  }
  if (plan.mcp) {
    sections.push(
      `**MCP config** — Create: \`.vscode/mcp.json\``,
      `Servers: ${plan.mcp.servers.join(", ")}. Purpose: "${plan.mcp.description}"`,
      ``,
    );
  }
  if (plan.workflow) {
    sections.push(
      `**Workflow file** — Create: \`.github/workflows/${plan.workflow.slug}.md\``,
      `Trigger: ${plan.workflow.trigger}. Purpose: "${plan.workflow.description}"`,
      ``,
    );
  }

  sections.push(
    `## Execution Rules`,
    `- Create ALL artifact files directly. Do NOT attempt to delegate to sub-agents.`,
    `- Content must be specific to the use case — NO generic placeholders or "follow best practices" filler.`,
    `- Use the EXACT file paths, names, roles, and responsibilities from this plan.`,
    `- Do NOT ask clarifying questions — make decisions based on the plan.`,
    `- Stop after all files are written. Do NOT run validation or review.`,
  );

  return sections.join("\n");
}

// ─── Fleet Orchestration Prompt Builder (Turbo mode) ───

/**
 * Build a fleet orchestration prompt from a parsed GenerationPlan.
 * Designed for /fleet execution — the prompt is structured as independent subtasks,
 * each routed to a specialized writer subagent via @agent-name.
 * /fleet breaks these into parallel subagent processes, each with its own context window.
 */
export function buildFleetOrchestrationPrompt(
  plan: GenerationPlan,
  mode: GenerationMode,
): string {
  const refs = loadReferenceExamples();
  const sections: string[] = [];

  // ── Shared Plan Overview (visible to orchestrator + all subagents) ──
  sections.push(
    `# Artifact Generation Plan`,
    ``,
    `Generate VS Code-compatible Copilot customization files using specialized writer subagents.`,
    `Each task below should be delegated to its designated @agent in parallel.`,
    ``,
    `## Use Case`,
    `"${plan.description}"`,
    ``,
    `## Generation Mode: ${mode}`,
    ``,
  );

  // Full plan overview so all subagents share consistent naming/references
  if (plan.agents.length > 0) {
    const agentTable = plan.agents.map((a: PlannedAgent) => {
      const tech = a.techStack.length > 0 ? a.techStack.join(", ") : "general";
      return `| ${a.name} | ${a.title} | ${a.role} | ${tech} | \`${a.applyToGlob}\` |`;
    }).join("\n");

    sections.push(
      `## Plan Overview (all agents)`,
      ``,
      `| Name | Title | Role | Tech Stack | ApplyTo |`,
      `|------|-------|------|------------|---------|`,
      agentTable,
      ``,
    );

    if (plan.prompt) {
      sections.push(`**Shared Prompt**: \`.github/prompts/${plan.prompt.slug}.prompt.md\` — "${plan.prompt.description}"`, ``);
    }
    if (plan.hooks) {
      sections.push(`**Hooks**: \`.github/hooks/${plan.hooks.slug}.json\` — events: ${plan.hooks.events.join(", ")}`, ``);
    }
    if (plan.mcp) {
      sections.push(`**MCP**: \`.vscode/mcp.json\` — servers: ${plan.mcp.servers.join(", ")}`, ``);
    }
    if (plan.workflow) {
      sections.push(`**Workflow**: \`.github/workflows/${plan.workflow.slug}.md\` — trigger: ${plan.workflow.trigger}`, ``);
    }
  }

  // ── Task 1: Agent Files ──
  if (plan.agents.length > 0) {
    sections.push(
      `---`,
      `## Task 1: Create Agent Files`,
      `Use @forge-agent-writer to create all agent files.`,
      ``,
      VSCODE_AGENT_SPEC,
      ``,
    );

    if (refs) {
      sections.push(
        `### Reference Example (match this format)`,
        "```markdown",
        refs.agent.slice(0, 1500),
        "```",
        ``,
      );
    }

    for (const a of plan.agents) {
      const tech = a.techStack.length > 0 ? ` (${a.techStack.join(", ")})` : "";
      const resp = a.responsibilities.map((r: string) => `    - ${r}`).join("\n");
      sections.push(
        `### Agent: ${a.title}`,
        `- File: \`.github/agents/${a.name}.agent.md\``,
        `- Name: "${a.title}"`,
        `- Role: "${a.role}"${tech}`,
        `- Category: ${a.category}`,
        `- ApplyTo: ${a.applyToGlob}`,
        `- Responsibilities:`,
        resp,
        `- Tools: read, edit, search, execute, get_errors, todo`,
        `- MUST include: \`argument-hint\`, \`user-invocable: true\``,
        plan.agents.length > 1
          ? `- Handoffs: add handoffs to other agents: ${plan.agents.filter((o) => o.name !== a.name).map((o) => o.title).join(", ")}`
          : ``,
        ``,
      );
    }

    // ── Task 2: Instruction Files ──
    sections.push(
      `---`,
      `## Task 2: Create Instruction Files`,
      `Use @forge-instruction-writer to create all instruction files.`,
      ``,
      VSCODE_INSTRUCTION_SPEC,
      ``,
    );

    if (refs) {
      sections.push(
        `### Reference Example`,
        "```markdown",
        refs.instruction,
        "```",
        ``,
      );
    }

    for (const a of plan.agents) {
      sections.push(
        `### Instruction: ${a.title}`,
        `- File: \`.github/instructions/${a.name}.instructions.md\``,
        `- ApplyTo: "${a.applyToGlob}"`,
        `- Description: "${a.instruction.description}"`,
        `- Domain: ${a.category}, tech: ${a.techStack.join(", ") || "general"}`,
        ``,
      );
    }

    // ── Task 3: Skill Files ──
    sections.push(
      `---`,
      `## Task 3: Create Skill Files`,
      `Use @forge-skill-writer to create all skill files.`,
      ``,
      VSCODE_SKILL_SPEC,
      ``,
    );

    if (refs) {
      sections.push(
        `### Reference Example`,
        "```markdown",
        refs.skill,
        "```",
        ``,
      );
    }

    for (const a of plan.agents) {
      sections.push(
        `### Skill: ${a.title}`,
        `- File: \`.github/skills/${a.name}/SKILL.md\``,
        `- Name: "${a.name}"`,
        `- Description: "${a.skill.description}"`,
        `- MUST include ≥5 USE FOR and ≥3 DO NOT USE FOR trigger phrases in description.`,
        ``,
      );
    }
  }

  // ── Task 4: Prompt File ──
  if (plan.prompt) {
    sections.push(
      `---`,
      `## Task 4: Create Prompt File`,
      `Use @forge-prompt-writer to create the prompt file.`,
      ``,
      VSCODE_PROMPT_SPEC,
      ``,
    );

    if (refs) {
      sections.push(
        `### Reference Example`,
        "```markdown",
        refs.prompt,
        "```",
        ``,
      );
    }

    sections.push(
      `### Prompt`,
      `- File: \`.github/prompts/${plan.prompt.slug}.prompt.md\``,
      `- Description: "${plan.prompt.description}"`,
      `- Include \`agent:\` and \`argument-hint:\` in frontmatter.`,
      `- Route to all agents: ${plan.agents.map((a) => `@${a.title}`).join(", ")}`,
      ``,
    );
  }

  // ── Task 5: Global Instructions ──
  const agentList = plan.agents.map((a: PlannedAgent) =>
    `- **${a.title}** (\`.github/agents/${a.name}.agent.md\`) — ${a.role}`
  ).join("\n");

  sections.push(
    `---`,
    `## Task 5: Create Global Instructions`,
    `Create this file directly (no subagent needed).`,
    ``,
    `### File: \`.github/copilot-instructions.md\``,
    `- Brief project overview`,
    `- Tech stack summary`,
    `- Architecture overview (one line per layer)`,
    `- Agent reference:`,
    agentList,
    `- Key conventions (3-5 rules)`,
    `- Keep under 50 lines`,
    `- Do NOT duplicate per-agent instruction content`,
    ``,
  );

  // ── Optional Tasks: Hooks / MCP / Workflow ──
  let taskNum = 6;
  if (plan.hooks) {
    sections.push(
      `---`,
      `## Task ${taskNum}: Create Hook Configuration`,
      `Use @forge-hook-writer to create hook config and companion scripts.`,
      ``,
      `- File: \`.github/hooks/${plan.hooks.slug}.json\``,
      `- Events: ${plan.hooks.events.join(", ")}`,
      `- Purpose: "${plan.hooks.description}"`,
      `- Use case: "${plan.description}"`,
      ``,
    );
    taskNum++;
  }
  if (plan.mcp) {
    sections.push(
      `---`,
      `## Task ${taskNum}: Create MCP Configuration`,
      `Use @forge-mcp-writer to create MCP server config.`,
      ``,
      `- File: \`.vscode/mcp.json\``,
      `- Servers: ${plan.mcp.servers.join(", ")}`,
      `- Purpose: "${plan.mcp.description}"`,
      `- Use case: "${plan.description}"`,
      ``,
    );
    taskNum++;
  }
  if (plan.workflow) {
    sections.push(
      `---`,
      `## Task ${taskNum}: Create Agentic Workflow`,
      `Use @forge-workflow-writer to create the workflow file.`,
      ``,
      `- File: \`.github/workflows/${plan.workflow.slug}.md\``,
      `- Trigger: ${plan.workflow.trigger}`,
      `- Purpose: "${plan.workflow.description}"`,
      `- Use case: "${plan.description}"`,
      ``,
    );
  }

  // ── Execution Rules ──
  sections.push(
    `---`,
    `## Execution Rules`,
    `- Delegate each numbered Task to its designated @agent subagent.`,
    `- Tasks are independent — run them in parallel where possible.`,
    `- Each subagent creates ONLY the files listed in its task.`,
    `- Content must be specific to the use case — NO generic placeholders.`,
    `- Use the EXACT file paths, names, roles, and responsibilities from the Plan Overview.`,
    `- Do NOT ask clarifying questions — make decisions based on the plan.`,
    `- Stop after all tasks are complete. Do NOT run validation or review.`,
  );

  return sections.join("\n");
}

// ─── Per-Writer Prompt Builders (legacy — kept for external parallel use) ───

/** Writer agent types that can be targeted individually */
export type WriterAgent =
  | "forge-agent-writer"
  | "forge-instruction-writer"
  | "forge-skill-writer"
  | "forge-prompt-writer"
  | "forge-hook-writer"
  | "forge-mcp-writer"
  | "forge-workflow-writer";

/** A task for a single parallel writer process */
export interface WriterTask {
  agent: WriterAgent;
  prompt: string;
}

/**
 * Build individual writer prompts from a plan for parallel (turbo) execution.
 * Returns only writers that have work to do based on the plan.
 */
export function buildWriterPrompts(
  plan: GenerationPlan,
  mode: GenerationMode,
): WriterTask[] {
  const refs = loadReferenceExamples();
  const tasks: WriterTask[] = [];

  if (plan.agents.length > 0) {
    // Agent writer
    tasks.push({
      agent: "forge-agent-writer",
      prompt: buildAgentWriterPrompt(plan, refs),
    });

    // Instruction writer
    tasks.push({
      agent: "forge-instruction-writer",
      prompt: buildInstructionWriterPrompt(plan, refs),
    });

    // Skill writer
    tasks.push({
      agent: "forge-skill-writer",
      prompt: buildSkillWriterPrompt(plan, refs),
    });
  }

  // Prompt writer
  if (plan.prompt) {
    tasks.push({
      agent: "forge-prompt-writer",
      prompt: buildPromptWriterPrompt(plan, refs),
    });
  }

  // Optional writers
  if (plan.hooks) {
    tasks.push({
      agent: "forge-hook-writer",
      prompt: `Create: \`.github/hooks/${plan.hooks.slug}.json\` with companion scripts.\nEvents: ${plan.hooks.events.join(", ")}.\nPurpose: "${plan.hooks.description}"\nUse case: "${plan.description}"`,
    });
  }
  if (plan.mcp) {
    tasks.push({
      agent: "forge-mcp-writer",
      prompt: `Create: \`.vscode/mcp.json\`\nServers: ${plan.mcp.servers.join(", ")}.\nPurpose: "${plan.mcp.description}"\nUse case: "${plan.description}"`,
    });
  }
  if (plan.workflow) {
    tasks.push({
      agent: "forge-workflow-writer",
      prompt: `Create: \`.github/workflows/${plan.workflow.slug}.md\`\nTrigger: ${plan.workflow.trigger}.\nPurpose: "${plan.workflow.description}"\nUse case: "${plan.description}"`,
    });
  }

  return tasks;
}

function buildAgentWriterPrompt(
  plan: GenerationPlan,
  refs: ReturnType<typeof loadReferenceExamples>,
): string {
  const sections: string[] = [
    `Create the following VS Code-compatible agent files for: "${plan.description}"`,
    ``,
    VSCODE_AGENT_SPEC,
    ``,
  ];

  if (refs) {
    sections.push(
      `## Reference Example (match this format and quality level)`,
      "```markdown",
      refs.agent.slice(0, 1500),
      "```",
      ``,
    );
  }

  for (const a of plan.agents) {
    const tech = a.techStack.length > 0 ? ` (${a.techStack.join(", ")})` : "";
    const resp = a.responsibilities.map((r) => `    ${r}`).join("\n");
    sections.push(
      `### Agent: ${a.title}`,
      `- File path: \`.github/agents/${a.name}.agent.md\``,
      `- Name: "${a.title}"`,
      `- Role: "${a.role}"${tech}`,
      `- Category: ${a.category}`,
      `- ApplyTo: ${a.applyToGlob}`,
      `- Responsibilities:`,
      resp,
      `- Tools: read, edit, search, execute, get_errors, todo`,
      `- MUST include: \`argument-hint\`, \`user-invocable: true\``,
      plan.agents.length > 1
        ? `- Handoffs: add handoffs to other agents: ${plan.agents.filter((o) => o.name !== a.name).map((o) => o.title).join(", ")}`
        : ``,
      ``,
    );
  }

  sections.push(
    `## Rules`,
    `- Create ALL agent files listed above.`,
    `- Content must be specific to the use case — NO generic placeholders.`,
    `- Do NOT create instruction, skill, or prompt files.`,
    `- Stop after all agent files are written.`,
  );

  return sections.join("\n");
}

function buildInstructionWriterPrompt(
  plan: GenerationPlan,
  refs: ReturnType<typeof loadReferenceExamples>,
): string {
  const sections: string[] = [
    `Create the following VS Code-compatible instruction files for: "${plan.description}"`,
    ``,
    VSCODE_INSTRUCTION_SPEC,
    ``,
  ];

  if (refs) {
    sections.push(
      `## Reference Example`,
      "```markdown",
      refs.instruction,
      "```",
      ``,
    );
  }

  for (const a of plan.agents) {
    sections.push(
      `### Instruction: ${a.title}`,
      `- File path: \`.github/instructions/${a.name}.instructions.md\``,
      `- ApplyTo: "${a.applyToGlob}"`,
      `- Description: "${a.instruction.description}"`,
      `- Domain: ${a.category}, tech: ${a.techStack.join(", ") || "general"}`,
      ``,
    );
  }

  sections.push(
    `## Rules`,
    `- Create ALL instruction files listed above.`,
    `- Each must have a specific \`applyTo\` glob (NOT "**/*").`,
    `- Content must reference actual tech stack and patterns.`,
    `- Do NOT create agent, skill, or prompt files.`,
    `- Stop after all instruction files are written.`,
  );

  return sections.join("\n");
}

function buildSkillWriterPrompt(
  plan: GenerationPlan,
  refs: ReturnType<typeof loadReferenceExamples>,
): string {
  const sections: string[] = [
    `Create the following VS Code-compatible skill files for: "${plan.description}"`,
    ``,
    VSCODE_SKILL_SPEC,
    ``,
  ];

  if (refs) {
    sections.push(
      `## Reference Example`,
      "```markdown",
      refs.skill,
      "```",
      ``,
    );
  }

  for (const a of plan.agents) {
    sections.push(
      `### Skill: ${a.title}`,
      `- File path: \`.github/skills/${a.name}/SKILL.md\``,
      `- Name: "${a.name}"`,
      `- Description: "${a.skill.description}"`,
      `- MUST include ≥5 USE FOR and ≥3 DO NOT USE FOR trigger phrases in description.`,
      ``,
    );
  }

  sections.push(
    `## Rules`,
    `- Create ALL skill files listed above.`,
    `- Each skill description MUST have USE FOR and DO NOT USE FOR trigger phrases.`,
    `- Content must be domain-specific, not generic.`,
    `- Do NOT create agent, instruction, or prompt files.`,
    `- Stop after all skill files are written.`,
  );

  return sections.join("\n");
}

function buildPromptWriterPrompt(
  plan: GenerationPlan,
  refs: ReturnType<typeof loadReferenceExamples>,
): string {
  const sections: string[] = [
    `Create the following VS Code-compatible prompt file for: "${plan.description}"`,
    ``,
    VSCODE_PROMPT_SPEC,
    ``,
  ];

  if (refs) {
    sections.push(
      `## Reference Example`,
      "```markdown",
      refs.prompt,
      "```",
      ``,
    );
  }

  sections.push(
    `### Prompt`,
    `- File path: \`.github/prompts/${plan.prompt.slug}.prompt.md\``,
    `- Description: "${plan.prompt.description}"`,
    `- Include \`agent:\` and \`argument-hint:\` in frontmatter.`,
    `- Route to all agents: ${plan.agents.map((a) => `@${a.title}`).join(", ")}`,
    ``,
    `## Rules`,
    `- Create ONLY the prompt file.`,
    `- Do NOT create agent, instruction, or skill files.`,
    `- Stop after the prompt file is written.`,
  );

  return sections.join("\n");
}

/**
 * Build a prompt for generating the global copilot-instructions.md.
 * Runs after all writers complete (needs to reference all agents).
 */
export function buildCopilotInstructionsPrompt(
  plan: GenerationPlan,
): string {
  const agentList = plan.agents.map((a) =>
    `- **${a.title}** (\`.github/agents/${a.name}.agent.md\`) — ${a.role}`
  ).join("\n");

  return [
    `Create \`.github/copilot-instructions.md\` for: "${plan.description}"`,
    ``,
    `## Content`,
    `- Brief project overview`,
    `- Tech stack summary`,
    `- Architecture overview (one line per layer)`,
    `- Agent reference table:`,
    agentList,
    `- Key conventions (3-5 rules)`,
    ``,
    `## Rules`,
    `- Keep under 50 lines — this loads on EVERY interaction.`,
    `- Do NOT duplicate per-agent instruction content.`,
    `- Do NOT create any other files. Only \`.github/copilot-instructions.md\`.`,
    `- Stop immediately after writing the file.`,
  ].join("\n");
}

// ─── Validation Fix Prompt ───

/**
 * Build a prompt that asks the LLM to fix specific validation findings.
 */
export function buildValidationFixPrompt(
  findings: Array<{ file: string; message: string; field?: string; severity: string }>,
  fileContents: Map<string, string>,
): string {
  const filesSection = [...fileContents.entries()]
    .map(([fp, content]) => {
      const relFindings = findings.filter((f) => f.file === fp);
      const findingsList = relFindings
        .map((f) => `  - [${f.severity}] ${f.message}${f.field ? ` (field: ${f.field})` : ""}`)
        .join("\n");
      return [
        `### File: ${fp}`,
        `**Issues:**`,
        findingsList,
        `**Current content:**`,
        "```",
        content,
        "```",
      ].join("\n");
    })
    .join("\n\n");

  return `You are a GitHub Copilot customization file expert. Fix the validation issues in these files.

## Issues to Fix

${filesSection}

## Rules
- Fix ONLY the reported issues. Preserve all other content exactly as-is.
- For unrecognized tool names: replace with the closest valid VS Code Copilot tool (read, edit, search, run_in_terminal, file_search, grep_search, semantic_search, list_dir, get_errors, read_file, fetch_webpage, memory, get_terminal_output, get_changed_files, test_failure, create_file, replace_string_in_file, multi_replace_string_in_file, read_notebook_cell_output, run_notebook_cell, edit_notebook_file, open_browser_page, runSubagent, search_subagent, run_vscode_command, vscode_renameSymbol, vscode_listCodeUsages, manage_todo_list, tool_search_tool_regex).
- For missing "USE FOR:" / "DO NOT USE FOR:" in skill descriptions: add appropriate trigger phrases based on the skill's content.
- For placeholder text (TODO, PLACEHOLDER, etc.): replace with meaningful content based on context.
- For empty/thin body content: expand with domain-specific content.
- For user-invocable as string: convert to boolean.
- For deprecated "infer" field: remove and set user-invocable + disable-model-invocation accordingly.
- For missing applyTo: infer from the instruction file name and content.
- Keep YAML frontmatter valid. Preserve the --- delimiters.

Output ONLY a JSON object mapping file paths to their corrected full content. No markdown fences, no explanation.
Example: {"path/to/file.md": "---\\nname: ...\\n---\\nBody..."}`;
}

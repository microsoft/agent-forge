import type { GalleryEntry } from "../types.js";

/** Built-in use case gallery */
export const GALLERY: GalleryEntry[] = [
  {
    id: "code-review",
    name: "Code Review Agent",
    description:
      "Reviews pull requests for code quality, security vulnerabilities, and best practices",
    tags: ["quality", "security", "pr"],
    files: [
      "agents/code-review.agent.md",
      "prompts/code-review.prompt.md",
      "instructions/code-review.instructions.md",
      "skills/code-review/SKILL.md",
    ],
  },
  {
    id: "testing",
    name: "Testing Workflow",
    description:
      "TDD agent pipeline — writes tests, runs them, refactors until green",
    tags: ["testing", "tdd", "quality"],
    files: [
      "agents/testing.agent.md",
      "prompts/testing.prompt.md",
      "instructions/testing.instructions.md",
      "skills/testing/SKILL.md",
    ],
  },
  {
    id: "documentation",
    name: "Documentation Generator",
    description:
      "Auto-generates documentation from code, comments, and project structure",
    tags: ["docs", "documentation", "readme"],
    files: [
      "agents/documentation.agent.md",
      "prompts/documentation.prompt.md",
      "instructions/documentation.instructions.md",
      "skills/documentation/SKILL.md",
    ],
  },
  {
    id: "deployment",
    name: "Deployment Guardian",
    description:
      "Pre-deploy validation — checks config, environment, dependencies before shipping",
    tags: ["deployment", "ci-cd", "validation"],
    files: [
      "agents/deployment.agent.md",
      "prompts/deployment.prompt.md",
      "instructions/deployment.instructions.md",
      "skills/deployment/SKILL.md",
    ],
  },
  {
    id: "onboarding",
    name: "Onboarding Assistant",
    description:
      "Helps new developers understand the codebase — explains architecture, patterns, and conventions",
    tags: ["onboarding", "learning", "team"],
    files: [
      "agents/onboarding.agent.md",
      "prompts/onboarding.prompt.md",
      "instructions/onboarding.instructions.md",
      "skills/onboarding/SKILL.md",
    ],
  },
  {
    id: "refactoring",
    name: "Refactoring Coach",
    description:
      "Suggests refactoring opportunities and validates code improvements",
    tags: ["refactoring", "quality", "improvement"],
    files: [
      "agents/refactoring.agent.md",
      "prompts/refactoring.prompt.md",
      "instructions/refactoring.instructions.md",
      "skills/refactoring/SKILL.md",
    ],
  },
  {
    id: "code-quality-hooks",
    name: "Code Quality Hooks",
    description:
      "Auto-format code after edits and block dangerous terminal commands via agent hooks",
    tags: ["hooks", "formatting", "security", "automation"],
    files: [
      "hooks/code-quality.json",
      "hooks/scripts/format-on-edit.sh",
      "hooks/scripts/block-dangerous-cmds.sh",
    ],
  },
  {
    id: "session-logging",
    name: "Session Logging Hooks",
    description:
      "Audit trail hooks — log session start/stop and tool usage for compliance",
    tags: ["hooks", "audit", "logging", "compliance"],
    files: [
      "hooks/session-logging.json",
      "hooks/scripts/session-audit.sh",
    ],
  },
  {
    id: "issue-triage",
    name: "Issue Triage Workflow",
    description:
      "Agentic workflow — auto-label, prioritize, and assign new issues using AI",
    tags: ["workflow", "issues", "triage", "automation"],
    files: [
      "workflows/issue-triage.md",
    ],
  },
  {
    id: "daily-report",
    name: "Daily Activity Report",
    description:
      "Agentic workflow — scheduled daily summary of repository activity as an issue",
    tags: ["workflow", "reporting", "scheduled", "automation"],
    files: [
      "workflows/daily-report.md",
    ],
  },
  {
    id: "dev-tools-mcp",
    name: "Dev Tools MCP Servers",
    description:
      "Starter MCP server config with GitHub and Playwright servers for AI-powered development",
    tags: ["mcp", "tools", "github", "playwright"],
    files: [
      ".vscode/mcp.json",
    ],
  },
];

/**
 * Get all gallery entries.
 */
export function getGallery(): GalleryEntry[] {
  return GALLERY;
}

/**
 * Find a gallery entry by ID.
 */
export function getGalleryEntry(id: string): GalleryEntry | undefined {
  return GALLERY.find((e) => e.id === id);
}

/**
 * Get gallery entry IDs.
 */
export function getGalleryIds(): string[] {
  return GALLERY.map((e) => e.id);
}

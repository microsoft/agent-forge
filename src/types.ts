/**
 * Shared types for the AGENT-FORGE CLI.
 */

/** Project type detected or chosen during init */
export type ProjectType =
  | "web"
  | "api"
  | "cli"
  | "library"
  | "data-pipeline"
  | "other";

/** Status of a gallery use case relative to the current project */
export type UseCaseStatus = "installed" | "available" | "generated";

/** An artifact type that AGENT-FORGE can generate */
export type ArtifactType =
  | "agent"
  | "prompt"
  | "instruction"
  | "skill"
  | "hook"
  | "mcp-server"
  | "agentic-workflow";

/** Generation mode selected by the user */
export type GenerationMode =
  | "full"
  | "on-demand"
  | "mcp-server"
  | "hooks"
  | "agentic-workflow"
  | "discovery";

  
/** Hook lifecycle events supported by Copilot CLI */
export type HookEvent =
  | "sessionStart"
  | "sessionEnd"
  | "userPromptSubmitted"
  | "preToolUse"
  | "postToolUse"
  | "errorOccurred"
  | "subagentStop"
  | "agentStop";

/** Agentic Workflow pattern types */
export type AgenticWorkflowPattern =
  | "ChatOps"
  | "DailyOps"
  | "IssueOps"
  | "LabelOps"
  | "Orchestration"
  | "Monitoring"
  | "TaskOps";

/** Configuration for a single hook command */
export interface HookConfig {
  type: "command";
  command: string;
  windows?: string;
  linux?: string;
  osx?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

/** MCP server configuration entry */
export interface McpServerConfig {
  type?: "http";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Agentic Workflow frontmatter configuration */
export interface AgenticWorkflowConfig {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  engine?: string;
  "safe-outputs"?: Record<string, unknown>;
}

/** Severity of a validation finding */
export type Severity = "error" | "warning" | "info";

/** Metadata for a built-in gallery use case */
export interface GalleryEntry {
  id: string;
  name: string;
  description: string;
  tags: string[];
  files: string[];
}

/** Result of workspace detection */
export interface WorkspaceInfo {
  hasGitHub: boolean;
  hasAgents: boolean;
  hasPrompts: boolean;
  hasInstructions: boolean;
  hasSkills: boolean;
  hasCopilotInstructions: boolean;
  hasHooks: boolean;
  hasMcpConfig: boolean;
  hasAgenticWorkflows: boolean;
  existingAgents: string[];
  existingPrompts: string[];
  existingInstructions: string[];
  existingSkills: string[];
  existingHooks: string[];
  existingMcpServers: string[];
  existingWorkflows: string[];
  projectType: ProjectType | null;
  techStack: string[];
}

/** A single validation finding */
export interface ValidationFinding {
  severity: Severity;
  file: string;
  message: string;
  line?: number;
  field?: string;
  /** Whether this finding can be auto-fixed by the LLM */
  fixable?: boolean;
}

/** Full validation report */
export interface ValidationReport {
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
  passed: string[];
  summary: string;
  /** Count of findings that can be auto-fixed by the LLM */
  fixableCount: number;
}

/** Init wizard mode */
export type InitMode = "create" | "analyze" | "templates";

/** Analyze strategy — how to proceed after workspace scan */
export type AnalyzeStrategy = "auto" | "guided";

/** Options for the init command */
export interface InitOptions {
  force: boolean;
  mode?: InitMode;
  description?: string;
  model?: string;
  /** Strategy for Analyze mode: "auto" (scan-only) or "guided" (scan + custom requirements) */
  analyzeStrategy?: AnalyzeStrategy;
  useCases?: string[];
  /** Generation speed: "standard" (single session, ~2 PRU) or "turbo" (parallel sessions, faster) */
  speed?: SpeedStrategy;
  /** Skip the prerequisite check at the start of `forge init` */
  skipCheck?: boolean;
}

/** Generation speed strategy */
export type SpeedStrategy = "standard" | "turbo";

/** Options for the generate command */
export interface GenerateOptions {
  model?: string;
  mode?: GenerationMode;
  types?: ArtifactType[];
  /** Generation speed: "standard" (single session, ~2 PRU) or "turbo" (parallel sessions, faster) */
  speed?: SpeedStrategy;
  /** Max autopilot continuation steps (default: 25 for planning, 15 for turbo writers) */
  maxContinues?: number;
}

/** Options for the validate command */
export interface ValidateOptions {
  fix?: boolean;
  noFix?: boolean;
  model?: string;
}

// ─── Plan-then-Execute pipeline types ───

/** A planned agent definition from the forge-planner */
export interface PlannedAgent {
  /** kebab-case file name (without .agent.md), e.g. "reactjs" */
  name: string;
  /** Human-readable title, e.g. "React Frontend" */
  title: string;
  /** One-line role description, e.g. "builds React UI components" */
  role: string;
  /** Domain category */
  category: "frontend" | "backend" | "ai" | "general";
  /** Detected/relevant tech stack */
  techStack: string[];
  /** Key responsibilities (fed to forge-agent-writer) */
  responsibilities: string[];
  /** Recommended applyTo glob for this agent's domain */
  applyToGlob: string;
  /** Per-agent instruction metadata */
  instruction: {
    /** What coding standards this instruction enforces */
    description: string;
  };
  /** Per-agent skill metadata */
  skill: {
    /** Skill description with USE FOR / DO NOT USE FOR trigger phrases for on-demand loading */
    description: string;
  };
  /** Optional handoff targets for multi-agent workflows */
  handoffs?: Array<{
    label: string;
    agent: string;
    prompt: string;
    send?: boolean;
  }>;
}

/** Structured generation plan produced by the forge-planner agent */
export interface GenerationPlan {
  /** Shared slug used for the prompt file */
  slug: string;
  /** Human-readable project title */
  title: string;
  /** Original use case description */
  description: string;
  /** Planned agents — each with its own aligned instruction + skill */
  agents: PlannedAgent[];
  /** Shared prompt metadata (one prompt routes to all agents) */
  prompt: {
    slug: string;
    description: string;
  };
  /** Optional hook plan */
  hooks?: {
    slug: string;
    events: string[];
    description: string;
  };
  /** Optional MCP server plan */
  mcp?: {
    servers: string[];
    description: string;
  };
  /** Optional workflow plan */
  workflow?: {
    slug: string;
    trigger: string;
    description: string;
  };
}

/** A detected domain within a multi-stack description */
export interface Domain {
  /** kebab-case identifier, e.g. "frontend" */
  slug: string;
  /** Title-case label, e.g. "Frontend" */
  title: string;
  /** Domain category */
  category: "frontend" | "backend" | "ai" | "general";
  /** Detected tech stack keywords, e.g. ["react", "tailwindcss"] */
  techStack: string[];
  /** Recommended applyTo glob for instruction files */
  applyToGlob: string;
}

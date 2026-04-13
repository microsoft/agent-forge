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
  AgentDesignPattern,
  GenerationPlan,
  PlannedAgent,
  WorkspaceInfo,
} from "../types.js";
import { mergeGlobs } from "./domain-registry.js";
import { toVSCodeModelName } from "./copilot-cli.js";

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
  - MCP server tools: \`github/*\`, \`playwright/*\`, or \`server-name/tool-name\`
  - Unrecognized tool names are silently ignored (cross-product safe)
- \`user-invokable\`: boolean (default: true) — whether users can select this agent
- \`disable-model-invocation\`: boolean (default: false) — prevent auto-delegation
- \`argument-hint\`: string — shown to users as placeholder text
- \`target\`: string — optional, "vscode" or "github-copilot" (defaults to both)
- \`mcp-servers\`: object — optional inline MCP server config for this agent
- \`handoffs\`: list of handoff definitions for multi-agent workflows:
  - \`label\`: button text shown to user
  - \`agent\`: target agent's \`name\` field value (MUST match EXACTLY — VS Code resolves handoffs by name field, NOT filename)
  - \`prompt\`: message sent when handing off
  - \`send\`: boolean (whether to send immediately)
- \`agents\`: list of allowed subagent names (for orchestrator agents):
  - Use \`'*'\` to allow all agents, \`[]\` to prevent any
  - Only meaningful when \`agent\` tool is included in tools list
- \`model\`: string or array — AI model for this agent (e.g., \`"Claude Sonnet 4.5 (copilot)"\` or prioritized array)

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
- \`name\`: string (REQUIRED) — lowercase, hyphens only. MUST match parent directory name exactly.
- \`description\`: string (REQUIRED, 1-1024 chars) — MUST include:
  - "USE FOR:" followed by 5+ trigger phrases (comma-separated) — include synonyms, casual terms, abbreviations
  - "DO NOT USE FOR:" followed by 3+ exclusion phrases — focus on near-miss topics
  This is the PRIMARY mechanism for skill discovery. Write descriptions slightly "pushy" to prevent under-triggering.
- \`argument-hint\`: string (optional) — hint shown in chat input when invoked as /slash command
- \`user-invokable\`: boolean (default true) — show in / slash command menu
- \`disable-model-invocation\`: boolean (default false) — prevent auto-loading
- \`license\`: string (optional) — license for the skill
- \`compatibility\`: string (optional, 1-500 chars) — environment requirements

Skill locations: \`.github/skills/\` (default), \`.agents/skills/\`, \`.claude/skills/\` (project), \`~/.copilot/skills/\` (personal)

Progressive disclosure: frontmatter (always in context) → SKILL.md body (loaded when relevant) → references/scripts/assets (loaded only when referenced).

Body structure by category:
- SDK/Library: Core Concepts → Common Patterns (Input/Output) → API Reference → Pitfalls
- Framework: Architecture → Project Structure → Conventions → Decision Tree → Pitfalls
- Service/Infra: Overview → Configuration → Deployment Workflow → Troubleshooting table
- Workflow: Overview → Step-by-Step → Decision Tree → Checklist → Examples

Keep body <500 lines. Split large knowledge into references/ subdirectory.`;

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
  "orchestrationPattern": "flat",
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

// ─── Reference Plan: Pipeline Pattern ───

const REFERENCE_PLAN_PIPELINE = `{
  "slug": "content-pipeline",
  "title": "Content Creation Pipeline",
  "description": "Content creation pipeline that takes a topic and produces a polished, SEO-optimized article through sequential agent stages",
  "orchestrationPattern": "pipeline",
  "agents": [
    {
      "name": "pipeline-coordinator",
      "title": "Content Pipeline Coordinator",
      "role": "Orchestrates the content creation pipeline by sending input through sequential stages and validating each stage output before forwarding to the next",
      "category": "general",
      "agentRole": "orchestrator",
      "agents": ["researcher", "outliner", "writer", "editor"],
      "userInvokable": true,
      "disableModelInvocation": true,
      "techStack": [],
      "responsibilities": [
        "Receive the topic input and send it to the researcher stage with specific research directives",
        "Validate each stage output meets minimum quality before forwarding to the next stage",
        "Pass the researcher's structured findings to the outliner, the outline to the writer, and the draft to the editor",
        "Re-invoke any stage that produces insufficient output with additional context or constraints",
        "Track pipeline progress and report the final publish-ready result to the user"
      ],
      "applyToGlob": "**/*",
      "instruction": {
        "description": "Pipeline orchestration: enforce sequential stage execution, validate stage outputs, re-invoke on quality failure. Never skip stages."
      },
      "skill": {
        "description": "Content creation pipeline orchestration and sequential stage coordination. USE FOR: create article, write blog post, content pipeline, produce content, generate article, blog creation, content workflow, editorial pipeline. DO NOT USE FOR: direct writing, research, outlining, editing, code generation, non-content tasks."
      }
    },
    {
      "name": "researcher",
      "title": "Content Researcher",
      "role": "Gathers facts, statistics, expert perspectives, and fresh angles on the given topic",
      "category": "general",
      "agentRole": "subagent",
      "userInvokable": false,
      "techStack": [],
      "responsibilities": [
        "Gather relevant facts, recent statistics, and data points for the given topic",
        "Identify expert perspectives, contrarian viewpoints, and unique angles not covered in typical articles",
        "Compile research into a structured brief with sections: Key Facts, Expert Quotes, Data Points, Fresh Angles",
        "Verify claims have supporting evidence and flag any assertions that need citations"
      ],
      "applyToGlob": "**/*.md",
      "instruction": {
        "description": "Research standards: structured output format, fact verification, source attribution, comprehensive coverage."
      },
      "skill": {
        "description": "Topic research, fact gathering, and structured research brief creation. USE FOR: research topic, gather facts, find statistics, expert perspectives, data points, verify claims. DO NOT USE FOR: writing articles, creating outlines, editing prose, SEO optimization."
      }
    },
    {
      "name": "outliner",
      "title": "Content Outliner",
      "role": "Designs the structural blueprint with sections, narrative arc, word counts, and heading hierarchy",
      "category": "general",
      "agentRole": "subagent",
      "userInvokable": false,
      "techStack": [],
      "responsibilities": [
        "Design a structural blueprint with H2/H3 heading hierarchy based on the research brief",
        "Plan the narrative arc: hook introduction, progressive revelation, compelling conclusion",
        "Assign target word counts per section to maintain balanced coverage",
        "Identify where code examples, data visualizations, or callout boxes should appear"
      ],
      "applyToGlob": "**/*.md",
      "instruction": {
        "description": "Outline standards: heading hierarchy, narrative arc, word count targets, placeholder locations for media."
      },
      "skill": {
        "description": "Article structure design, section planning, and narrative architecture. USE FOR: create outline, plan structure, section design, heading hierarchy, narrative arc, word count planning. DO NOT USE FOR: writing full articles, researching topics, editing prose, SEO analysis."
      }
    },
    {
      "name": "writer",
      "title": "Content Writer",
      "role": "Drafts the complete article with consistent voice, engagement hooks, and code examples using the outline and research",
      "category": "general",
      "agentRole": "subagent",
      "userInvokable": false,
      "techStack": [],
      "responsibilities": [
        "Draft the complete article following the structural outline with consistent voice and tone",
        "Incorporate research findings naturally with proper attribution and context",
        "Write engagement hooks: compelling opening, smooth transitions, clear takeaways per section",
        "Include code examples, practical tips, and actionable advice where the outline indicates"
      ],
      "applyToGlob": "**/*.md",
      "instruction": {
        "description": "Writing standards: follow outline structure, incorporate research, maintain consistent voice, include engagement hooks."
      },
      "skill": {
        "description": "Article drafting, prose writing, and content creation from outlines. USE FOR: write article, draft content, create prose, fill outline, write sections, compose paragraphs. DO NOT USE FOR: research, outlining, editing, SEO optimization, structural planning."
      }
    },
    {
      "name": "editor",
      "title": "Content Editor",
      "role": "Polishes grammar, tone, and flow, then optimizes for SEO with title, meta description, and keyword placement",
      "category": "general",
      "agentRole": "subagent",
      "userInvokable": false,
      "techStack": [],
      "responsibilities": [
        "Polish grammar, punctuation, and sentence structure for clarity and readability",
        "Ensure consistent tone, smooth transitions, and logical flow between sections",
        "Optimize title for click-worthiness and primary keyword placement",
        "Generate meta description (150-160 chars), identify primary keywords, and suggest internal linking opportunities"
      ],
      "applyToGlob": "**/*.md",
      "instruction": {
        "description": "Editorial standards: grammar polish, tone consistency, SEO optimization, meta description generation."
      },
      "skill": {
        "description": "Editorial review, SEO optimization, and content polish. USE FOR: edit article, polish prose, fix grammar, SEO optimization, meta description, keyword analysis, readability improvement. DO NOT USE FOR: initial drafting, research, outlining, topic selection."
      }
    }
  ],
  "prompt": {
    "slug": "content-pipeline",
    "description": "Create a polished article by running a topic through the research → outline → write → edit pipeline"
  }
}`;

// ─── Reference Plan: Multi-Perspective Pattern ───

const REFERENCE_PLAN_MULTI_PERSPECTIVE = `{
  "slug": "compliance-audit",
  "title": "Codebase Compliance Audit",
  "description": "Compliance audit system that scans a project with parallel specialist reviewers for security, licensing, documentation, and privacy, then synthesizes into a unified scorecard",
  "orchestrationPattern": "multi-perspective",
  "agents": [
    {
      "name": "compliance-coordinator",
      "title": "Compliance Coordinator",
      "role": "Orchestrates parallel compliance reviews by dispatching the same project scan to all specialist reviewers and synthesizing their independent findings into a unified scorecard",
      "category": "general",
      "agentRole": "orchestrator",
      "agents": ["security-auditor", "license-reviewer", "docs-assessor", "compliance-reporter"],
      "userInvokable": true,
      "disableModelInvocation": true,
      "techStack": [],
      "responsibilities": [
        "Dispatch the project scan data to all specialist reviewers simultaneously for parallel analysis",
        "Collect independent findings from each specialist without cross-contamination between reviewers",
        "Send all specialist reports to the compliance reporter for unified scorecard synthesis",
        "Present the final scorecard with traffic-light ratings and prioritized action items to the user",
        "Re-invoke any specialist that returns incomplete findings with targeted follow-up directives"
      ],
      "applyToGlob": "**/*",
      "instruction": {
        "description": "Multi-perspective orchestration: dispatch same input to all reviewers in parallel, collect independent results, synthesize via reporter. Never let reviewers see each other's findings."
      },
      "skill": {
        "description": "Compliance audit orchestration and multi-perspective review coordination. USE FOR: compliance check, security audit, project audit, code review, quality assessment, multi-perspective review, compliance scan. DO NOT USE FOR: direct security analysis, license checking, documentation review, writing code."
      }
    },
    {
      "name": "security-auditor",
      "title": "Security Auditor",
      "role": "Analyzes project for security vulnerabilities: .env handling, hardcoded secrets, auth patterns, HTTPS enforcement, dependency risks",
      "category": "general",
      "agentRole": "subagent",
      "userInvokable": false,
      "techStack": [],
      "responsibilities": [
        "Check .env handling: verify .gitignore includes .env files, scan for hardcoded secrets and API keys in source",
        "Evaluate authentication patterns: password hashing, token management, session handling, CORS configuration",
        "Assess HTTPS enforcement, security headers, and input validation patterns",
        "Score security posture 1-10 with specific findings and remediation recommendations"
      ],
      "applyToGlob": "**/*",
      "instruction": {
        "description": "Security audit lens: OWASP Top 10, secrets detection, auth patterns, dependency vulnerabilities. Output structured findings with severity ratings."
      },
      "skill": {
        "description": "Security vulnerability analysis and OWASP compliance checking. USE FOR: security scan, vulnerability check, secrets detection, auth audit, HTTPS check, dependency risk, OWASP review. DO NOT USE FOR: license compliance, documentation quality, privacy assessment, code implementation."
      }
    },
    {
      "name": "license-reviewer",
      "title": "License Reviewer",
      "role": "Evaluates LICENSE file presence, dependency license compatibility, attribution requirements, and open source obligations",
      "category": "general",
      "agentRole": "subagent",
      "userInvokable": false,
      "techStack": [],
      "responsibilities": [
        "Verify LICENSE file exists and is appropriate for the project type (MIT, Apache-2.0, GPL, etc.)",
        "Check dependency license compatibility: flag copyleft licenses in proprietary projects",
        "Identify attribution requirements from third-party dependencies",
        "Score license compliance 1-10 with specific findings and remediation steps"
      ],
      "applyToGlob": "**/*",
      "instruction": {
        "description": "License audit lens: LICENSE file presence, dependency license compatibility, attribution requirements. Output structured findings with compliance ratings."
      },
      "skill": {
        "description": "License compliance analysis and open source obligation checking. USE FOR: license check, dependency licenses, attribution requirements, open source compliance, copyleft detection, license compatibility. DO NOT USE FOR: security vulnerabilities, documentation quality, privacy assessment, code review."
      }
    },
    {
      "name": "docs-assessor",
      "title": "Documentation Assessor",
      "role": "Scores README quality, setup instructions, contributing guide, changelog, and inline documentation completeness",
      "category": "general",
      "agentRole": "subagent",
      "userInvokable": false,
      "techStack": [],
      "responsibilities": [
        "Evaluate README quality: project description, installation steps, usage examples, badge presence",
        "Check for CONTRIBUTING.md, CODE_OF_CONDUCT.md, and CHANGELOG.md presence and quality",
        "Assess inline documentation: JSDoc/docstrings in public APIs, complex logic comments",
        "Score documentation completeness 1-10 with specific gaps and improvement recommendations"
      ],
      "applyToGlob": "**/*",
      "instruction": {
        "description": "Documentation audit lens: README quality, guides presence, inline docs coverage. Output structured findings with completeness ratings."
      },
      "skill": {
        "description": "Documentation quality assessment and completeness analysis. USE FOR: documentation check, README quality, contributing guide, changelog, inline docs, API documentation, setup instructions. DO NOT USE FOR: security analysis, license compliance, privacy assessment, code implementation."
      }
    },
    {
      "name": "compliance-reporter",
      "title": "Compliance Reporter",
      "role": "Synthesizes all specialist findings into a unified scorecard with traffic-light ratings, risk heatmap, and prioritized top-3 action items",
      "category": "general",
      "agentRole": "subagent",
      "userInvokable": false,
      "techStack": [],
      "responsibilities": [
        "Merge findings from security, license, and documentation specialists into a unified compliance report",
        "Generate traffic-light scorecard: Security 🔴🟡🟢, License 🔴🟡🟢, Docs 🔴🟡🟢, Overall 🔴🟡🟢",
        "Resolve conflicting assessments by applying severity-weighted prioritization across domains",
        "Produce prioritized top-3 action items with effort estimates and impact ratings"
      ],
      "applyToGlob": "**/*",
      "instruction": {
        "description": "Synthesis lens: merge multi-perspective findings, resolve conflicts, generate traffic-light scorecard, prioritize actions by impact."
      },
      "skill": {
        "description": "Compliance report synthesis and multi-domain scorecard generation. USE FOR: generate report, synthesize findings, compliance scorecard, traffic-light rating, prioritize actions, risk heatmap. DO NOT USE FOR: security scanning, license checking, documentation review, direct code analysis."
      }
    }
  ],
  "prompt": {
    "slug": "compliance-audit",
    "description": "Run a multi-perspective compliance audit with parallel specialist reviewers and unified scorecard"
  }
}`;

// ─── Reference Plan: TDD Pattern ───

const REFERENCE_PLAN_TDD = `{
  "slug": "tdd-workflow",
  "title": "TDD Development Workflow",
  "description": "Test-driven development workflow with red-green-refactor cycle managed by a TDD coordinator",
  "orchestrationPattern": "tdd",
  "agents": [
    {
      "name": "tdd-coordinator",
      "title": "TDD Coordinator",
      "role": "Orchestrates the red-green-refactor cycle by delegating to specialized stage agents in strict sequence and validating each stage's contract before proceeding",
      "category": "general",
      "agentRole": "orchestrator",
      "agents": ["red-agent", "green-agent", "refactor-agent"],
      "userInvokable": true,
      "disableModelInvocation": true,
      "techStack": [],
      "responsibilities": [
        "Receive the feature requirement and decompose it into testable units for the red stage",
        "Delegate to the red agent first: verify it produces a failing test, then send the failing test to the green agent",
        "Delegate to the green agent: verify the test passes with minimal code, then send both to the refactor agent",
        "Delegate to the refactor agent: verify tests still pass after cleanup, then report the completed cycle",
        "Iterate the red-green-refactor cycle for each testable unit until the feature is fully covered"
      ],
      "applyToGlob": "**/*",
      "instruction": {
        "description": "TDD orchestration: enforce strict Red → Green → Refactor sequence. Never skip stages. Verify test state between stages."
      },
      "skill": {
        "description": "Test-driven development orchestration and red-green-refactor cycle management. USE FOR: TDD workflow, test-driven development, red green refactor, test first development, iterative testing, TDD cycle. DO NOT USE FOR: writing tests directly, implementing code, refactoring code, code review."
      }
    },
    {
      "name": "red-agent",
      "title": "Red Stage — Test Writer",
      "role": "Writes a focused, failing test that captures the expected behavior before any implementation exists",
      "category": "general",
      "agentRole": "subagent",
      "userInvokable": false,
      "techStack": [],
      "responsibilities": [
        "Write exactly one focused test case that captures the expected behavior for the current unit",
        "Ensure the test fails for the RIGHT reason — it should fail because the feature doesn't exist, not due to syntax errors",
        "Run the test to confirm it fails and capture the failure output as evidence",
        "Report the failing test file path, the assertion that fails, and the expected vs actual output"
      ],
      "applyToGlob": "**/*.{test,spec}.{ts,tsx,js,jsx}",
      "instruction": {
        "description": "Red stage: write ONE failing test. Run it. Confirm it fails for the right reason. Report failure evidence. Never write implementation code."
      },
      "skill": {
        "description": "Failing test creation for TDD red stage. USE FOR: write failing test, red stage, test first, define expected behavior, test assertion, capture failure. DO NOT USE FOR: implementing features, making tests pass, refactoring, code cleanup."
      }
    },
    {
      "name": "green-agent",
      "title": "Green Stage — Implementer",
      "role": "Writes the MINIMUM code needed to make the failing test pass — no more, no less",
      "category": "general",
      "agentRole": "subagent",
      "userInvokable": false,
      "techStack": [],
      "responsibilities": [
        "Read the failing test to understand exactly what behavior is expected",
        "Write the simplest possible implementation that makes the test pass — resist over-engineering",
        "Run the test suite to verify the new test passes AND no existing tests broke",
        "Report the implementation file path, lines added, and full test results"
      ],
      "applyToGlob": "**/*.{ts,tsx,js,jsx}",
      "instruction": {
        "description": "Green stage: write MINIMUM code to pass the test. No refactoring, no optimization, no extra features. Just make it green."
      },
      "skill": {
        "description": "Minimal implementation for TDD green stage. USE FOR: make test pass, green stage, minimal implementation, pass failing test, simplest solution. DO NOT USE FOR: writing tests, refactoring, optimization, code cleanup, architectural decisions."
      }
    },
    {
      "name": "refactor-agent",
      "title": "Refactor Stage — Code Improver",
      "role": "Improves code quality, removes duplication, and enhances readability while keeping ALL tests green",
      "category": "general",
      "agentRole": "subagent",
      "userInvokable": false,
      "model": ["Claude Sonnet 4.5 (copilot)", "Gemini 3 Flash (Preview) (copilot)"],
      "techStack": [],
      "responsibilities": [
        "Review the implementation for duplication, naming clarity, and structural improvements",
        "Refactor code to improve readability and maintainability without changing behavior",
        "Run the full test suite after EVERY refactoring step to ensure all tests remain green",
        "Report refactoring changes made, tests verified, and any code quality metrics improved"
      ],
      "applyToGlob": "**/*.{ts,tsx,js,jsx}",
      "instruction": {
        "description": "Refactor stage: improve code without changing behavior. Run tests after every change. If any test fails, revert immediately."
      },
      "skill": {
        "description": "Code refactoring for TDD refactor stage. USE FOR: refactor code, improve readability, remove duplication, clean up, code quality, rename variables, extract functions. DO NOT USE FOR: adding features, writing new tests, changing behavior, architectural redesign."
      }
    }
  ],
  "prompt": {
    "slug": "tdd-workflow",
    "description": "Develop features using the test-driven red-green-refactor cycle with specialized stage agents"
  }
}`;

// ─── Reference Plan: Iteration Pattern ───

const REFERENCE_PLAN_ITERATION = `{
  "slug": "iterative-review",
  "title": "Iterative Quality Review",
  "description": "Iterative review system where an implementer produces output and a quality gate scores it, looping until the quality threshold is met",
  "orchestrationPattern": "iteration",
  "agents": [
    {
      "name": "iteration-coordinator",
      "title": "Iteration Coordinator",
      "role": "Orchestrates iterative improvement cycles by sending work between the implementer and quality gate until the acceptance threshold is met",
      "category": "general",
      "agentRole": "orchestrator",
      "agents": ["implementer", "quality-gate"],
      "userInvokable": true,
      "disableModelInvocation": true,
      "techStack": [],
      "responsibilities": [
        "Receive the task and initial requirements, then delegate the first attempt to the implementer",
        "Send each implementation attempt to the quality gate for scoring against acceptance criteria",
        "If the quality gate returns a score below threshold, forward its specific feedback to the implementer for a targeted revision",
        "Track iteration count and improvement trajectory — escalate if quality plateaus after 3 iterations",
        "Report the final accepted result with quality scores, iteration count, and improvement history"
      ],
      "applyToGlob": "**/*",
      "instruction": {
        "description": "Iteration orchestration: implementer → quality gate → feedback loop. Max 5 iterations. Escalate on plateau. Track improvement trajectory."
      },
      "skill": {
        "description": "Iterative improvement orchestration and quality convergence management. USE FOR: iterative improvement, quality loop, revision cycle, improve until threshold, feedback loop, progressive refinement, quality convergence. DO NOT USE FOR: one-shot implementation, direct code review, test writing, static analysis."
      }
    },
    {
      "name": "implementer",
      "title": "Iterative Implementer",
      "role": "Produces or revises work based on requirements and quality gate feedback, improving with each iteration",
      "category": "general",
      "agentRole": "subagent",
      "userInvokable": false,
      "techStack": [],
      "responsibilities": [
        "Produce the initial implementation based on the provided requirements and specifications",
        "On revision requests, read the quality gate's specific feedback and address each point directly",
        "Track which feedback items were addressed and report what changed in each iteration",
        "Maintain context across iterations — build on previous work rather than starting from scratch"
      ],
      "applyToGlob": "**/*",
      "instruction": {
        "description": "Iterative implementation: address quality feedback point-by-point. Build on previous work. Report changes per iteration."
      },
      "skill": {
        "description": "Iterative implementation and revision based on structured feedback. USE FOR: implement feature, revise code, address feedback, improve implementation, iterate on solution, fix issues. DO NOT USE FOR: quality assessment, scoring, acceptance testing, review."
      }
    },
    {
      "name": "quality-gate",
      "title": "Quality Gate Reviewer",
      "role": "Scores each implementation attempt against acceptance criteria and provides specific, actionable feedback for improvement",
      "category": "general",
      "agentRole": "subagent",
      "userInvokable": false,
      "model": ["Claude Sonnet 4.5 (copilot)", "Gemini 3 Flash (Preview) (copilot)"],
      "techStack": [],
      "responsibilities": [
        "Score the implementation against predefined acceptance criteria on a 1-10 scale per criterion",
        "Provide specific, actionable feedback for each criterion scoring below threshold (7/10)",
        "Compare with previous iteration scores to track improvement trajectory",
        "Return a structured verdict: PASS (all criteria ≥7) or REVISE (with prioritized feedback list)"
      ],
      "applyToGlob": "**/*",
      "instruction": {
        "description": "Quality gate: score against criteria, provide specific feedback, track improvement. PASS threshold: all criteria ≥7/10. Output structured verdict."
      },
      "skill": {
        "description": "Quality assessment, scoring, and structured feedback generation. USE FOR: quality review, score implementation, acceptance criteria, quality gate, assess quality, provide feedback, track improvement. DO NOT USE FOR: implementing features, writing code, fixing issues, direct editing."
      }
    }
  ],
  "prompt": {
    "slug": "iterative-review",
    "description": "Implement features with iterative quality improvement until acceptance criteria are met"
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
  agentDesignPattern: AgentDesignPattern = "auto",
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
      `**CRITICAL**: When scanning .github/agents/, IGNORE any files with the \`forge-\` prefix (e.g., forge-brownfield-planner.agent.md, forge-agent-writer.agent.md). These are internal AGENT-FORGE pipeline agents — they are NOT project customizations.`,
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

  // Reference plan examples — shows the LLM exactly what quality looks like
  sections.push(
    `## Reference Plans (match this quality level)`,
    ``,
    `### Reference 1: Flat Pattern (2 agents, simple project)`,
    `For a description like "E-commerce platform with Next.js storefront and FastAPI product service":`,
    ``,
    "```json",
    REFERENCE_PLAN,
    "```",
    ``,
    `Notice: framework-based agent names, 5 tech-specific responsibilities per agent, populated techStack arrays, specific applyToGlob patterns, and rich skill descriptions with USE FOR/DO NOT USE FOR phrases.`,
    ``,
    `### Reference 2: Pipeline Pattern (sequential stages with input/output contracts)`,
    `For a description like "Content creation pipeline that produces polished articles through sequential stages":`,
    ``,
    "```json",
    REFERENCE_PLAN_PIPELINE,
    "```",
    ``,
    `Notice: strict sequential stage order (researcher → outliner → writer → editor), each stage has a defined output format that feeds the next stage, orchestrator validates between stages and can re-invoke on quality failure.`,
    ``,
    `### Reference 3: Multi-Perspective Pattern (parallel specialist reviewers + synthesizer)`,
    `For a description like "Compliance audit with parallel security, license, and documentation reviewers":`,
    ``,
    "```json",
    REFERENCE_PLAN_MULTI_PERSPECTIVE,
    "```",
    ``,
    `Notice: all specialists receive the SAME input, work independently in parallel (no cross-contamination), a dedicated synthesizer/reporter merges findings using traffic-light scoring and resolves conflicting assessments.`,
    ``,
    `### Reference 4: TDD Pattern (red-green-refactor cycle)`,
    `For a description like "Test-driven development with red-green-refactor cycle":`,
    ``,
    "```json",
    REFERENCE_PLAN_TDD,
    "```",
    ``,
    `Notice: strict Red → Green → Refactor sequence enforced by coordinator, red agent writes ONE failing test, green agent writes MINIMUM code to pass, refactor agent improves without changing behavior, coordinator iterates per testable unit.`,
    ``,
    `### Reference 5: Iteration Pattern (implement → score → revise loop)`,
    `For a description like "Iterative quality improvement with feedback loop until threshold is met":`,
    ``,
    "```json",
    REFERENCE_PLAN_ITERATION,
    "```",
    ``,
    `Notice: implementer produces output, quality gate scores against criteria (PASS/REVISE verdict), coordinator loops until all criteria ≥ threshold, tracks improvement trajectory, escalates on plateau.`,
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
    agentDesignPattern !== "subagent" ? `- Orchestrator for ≤2 agents — use handoffs instead` : ``,
    `- Orchestrator with \`edit\` or \`execute\` tools — orchestrators delegate everything`,
    `- Subagent without orchestrator — every subagent must be listed in an orchestrator's \`agents\` array`,
    ``,
  );

  // Agent design pattern override
  if (agentDesignPattern === "subagent") {
    sections.push(
      `## ⚡ Agent Design Pattern Override: SUBAGENT (coordinator-worker)`,
      ``,
      `The user has explicitly requested the **subagent (coordinator-worker)** pattern.`,
      `You MUST use \`orchestrationPattern: "coordinator-worker"\` regardless of agent count.`,
      `Even with only 2 agents, create a coordinator orchestrator + 2 worker subagents (3 agents total).`,
      ``,
      `- Create one **coordinator** agent with \`agentRole: "orchestrator"\`, \`agents: [...]\`, tools: \`[read, search, agent, todo]\``,
      `- Mark all other agents as **subagents** with \`agentRole: "subagent"\`, \`userInvokable: false\``,
      `- The coordinator NEVER writes code — it decomposes, delegates, and validates`,
      `- This pattern saves PRU by running one orchestrator session instead of multiple standalone agent sessions`,
      ``,
    );
  } else if (agentDesignPattern === "standalone") {
    sections.push(
      `## ⚡ Agent Design Pattern Override: STANDALONE (flat with handoffs)`,
      ``,
      `The user has explicitly requested the **standalone (flat)** pattern.`,
      `You MUST use \`orchestrationPattern: "flat"\` regardless of agent count or keywords.`,
      `Do NOT create any orchestrator agent. All agents are peer-level with \`userInvokable: true\`.`,
      ``,
      `- All agents are standalone with \`agentRole: "standalone"\``,
      `- Add \`handoffs\` between related agents so users can transition between them`,
      `- Each agent works independently and is visible in the agent dropdown`,
      ``,
    );
  }

  // Orchestration pattern guidance
  sections.push(
    `## Orchestration Patterns`,
    ``,
    `When planning 3+ agents, decide the \`orchestrationPattern\`:`,
    ``,
    `| Pattern | When to Use | Structure |`,
    `|---------|-------------|-----------|`,
    `| \`flat\` (default) | 1-2 agents, simple projects | Peer agents with optional handoffs |`,
    `| \`coordinator-worker\` | 3+ agents spanning ≥2 programming languages (e.g., TypeScript + Python) | Orchestrator + specialized workers |`,
    `| \`coordinator-worker\` | 3+ agents with separate runtime environments (frontend + backend + AI/ML) | Orchestrator + specialized workers |`,
    `| \`coordinator-worker\` | 3+ agents, "microservice", "distributed", "orchestrate", "plan", "research", "workflow", "coordinate" | Orchestrator + specialized workers |`,
    `| \`multi-perspective\` | 3+ agents, "review", "quality", "audit", "compliance", "multi-perspective" | Orchestrator dispatches same input to parallel specialist reviewers, synthesizer merges findings into unified scorecard |`,
    `| \`tdd\` | 3+ agents, "TDD", "test-driven", "red green refactor" | TDD Coordinator enforces strict Red → Green → Refactor sequence per testable unit |`,
    `| \`pipeline\` | 3+ agents, clear dependency chain (stage A → stage B → stage C), "pipeline", "sequential", "stages" | Pipeline orchestrator sends output of stage N to stage N+1; each stage has a defined input/output contract |`,
    `| \`iteration\` | 2+ agents, "iterate", "improve until", "quality threshold", "feedback loop", "progressive refinement" | Iteration coordinator loops between implementer and quality gate until acceptance threshold is met |`,
    ``,
    `**Smart Default**: When ≥3 agents span multiple programming languages or runtime environments, prefer \`coordinator-worker\` over \`flat\` — coordination is essential when agents work across language boundaries.`,
    ``,
    `**Pattern Selection Decision Tree:**`,
    `1. Is there a clear sequential dependency chain where each stage transforms the previous stage's output? → \`pipeline\``,
    `2. Do multiple specialists independently analyze the SAME input from different perspectives? → \`multi-perspective\``,
    `3. Is the workflow explicitly test-first with red/green/refactor cycles? → \`tdd\``,
    `4. Does the task require iterative improvement with a quality gate scoring each attempt? → \`iteration\``,
    `5. Are there 3+ agents spanning multiple languages or runtime environments? → \`coordinator-worker\``,
    `6. Otherwise → \`flat\``,
    ``,
    ``,
    `When pattern ≠ \`flat\`, include these fields in each agent:`,
    `- \`agentRole\`: \`"orchestrator"\` or \`"subagent"\` or \`"standalone"\``,
    `- \`agents\`: list of subagent names (orchestrators only)`,
    `- \`userInvokable\`: \`false\` for subagents (hidden from dropdown)`,
    `- \`disableModelInvocation\`: \`true\` for orchestrators (user-only)`,
    `- \`model\`: optional lighter model for cost-efficient subagents (e.g., reviewers, quality gates)`,
    ``,
    `Orchestrator tools: \`[read, search, agent, todo]\` — NO \`edit\`/\`execute\`.`,
    `Orchestrator responsibilities: decompose, delegate, validate, iterate.`,
    ``,
    `### Pattern-Specific Orchestrator Behavior`,
    ``,
    `- **Pipeline orchestrators**: enforce sequential stage execution (A → B → C), validate each stage output meets a minimum quality bar before forwarding, can re-invoke a failed stage with additional context.`,
    `- **Multi-perspective orchestrators**: dispatch the same input to all specialist subagents simultaneously, collect independent results without cross-contamination, send all results to a synthesizer/reporter subagent for merging.`,
    `- **TDD orchestrators**: enforce strict Red → Green → Refactor ordering per unit, verify test state between stages (red must fail, green must pass, refactor must keep passing), iterate per testable unit.`,
    `- **Iteration orchestrators**: loop between implementer and quality gate, forward specific feedback from quality gate to implementer, track iteration count (max 5), escalate if quality plateaus.`,
    `- **Coordinator-worker orchestrators**: decompose tasks and delegate to specialized workers, validate results, iterate until acceptance criteria are met.`,
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

// ─── Fleet Orchestration Prompt Builder ───

/**
 * Build a fleet orchestration prompt from a parsed GenerationPlan.
 * Designed for /fleet execution — the prompt is structured as independent subtasks,
 * each routed to a specialized writer subagent via @agent-name.
 * /fleet breaks these into parallel subagent processes, each with its own context window.
 */
export function buildFleetOrchestrationPrompt(
  plan: GenerationPlan,
  mode: GenerationMode,
  selectedModel?: string,
): string {
  const refs = loadReferenceExamples();
  const sections: string[] = [];
  // Convert CLI model ID to VS Code display name for generated agent frontmatter
  const vsCodeModel = selectedModel ? toVSCodeModelName(selectedModel) : undefined;

  // ── Shared Plan Overview (visible to orchestrator + all subagents) ──
  sections.push(
    `# Artifact Generation Plan`,
    ``,
    `Generate VS Code-compatible Copilot customization files using specialized writer subagents.`,
    `Each task below should be delegated to its designated @agent in parallel.`,
    `Each subagent operates in its **own context window** — all context it needs is included in its task section plus the Plan Overview above.`,
    ``,
    `## Parallelization`,
    `Tasks 1–4 (and optional Tasks 6–8) are **fully independent** — run them ALL simultaneously.`,
    `Task 5 (Global Instructions) must run **last**, after all other tasks complete.`,
    `Do NOT wait for one task to finish before starting the next (except Task 5).`,
    ``,
    ...(vsCodeModel ? [
      `## Model`,
      `All subagents MUST use **${vsCodeModel}**. When delegating each task, specify: "Use ${vsCodeModel}".`,
      `By default subagents use a low-cost model — you MUST explicitly set the model to override this.`,
      ``,
    ] : []),
    ``,
    `## Critical Naming Convention`,
    `Each agent has a **slug** (kebab-case, used as filename) and a **title** (display name, used as the \`name:\` frontmatter field).`,
    `- **Filename**: Use the slug → \`.github/agents/{slug}.agent.md\``,
    `- **\`name:\` frontmatter field**: Use the title → \`name: "{title}"\``,
    `- **Handoff \`agent:\`**: Use the title (MUST match the target agent's \`name:\` field EXACTLY)`,
    `- **Orchestrator \`agents:\`**: Use the title of each subagent (MUST match the target agent's \`name:\` field EXACTLY)`,
    `This is critical — VS Code resolves all agent references by the \`name:\` frontmatter field, NOT the filename.`,
    ``,
    `## Use Case`,
    `"${plan.description}"`,
    ``,
    `## Generation Mode: ${mode}`,
    ``,
  );

  // Full plan overview so all subagents share consistent naming/references
  if (plan.agents.length > 0) {
    const isOrchestrated = plan.orchestrationPattern && plan.orchestrationPattern !== "flat";
    const agentTable = plan.agents.map((a: PlannedAgent) => {
      const tech = a.techStack.length > 0 ? a.techStack.join(", ") : "general";
      const role = a.agentRole ?? "standalone";
      return `| ${a.name} | ${a.title} | ${a.role} | ${tech} | \`${a.applyToGlob}\` | ${role} |`;
    }).join("\n");

    sections.push(
      `## Plan Overview (all agents)`,
      ``,
      isOrchestrated ? `**Orchestration Pattern: ${plan.orchestrationPattern}**\n` : ``,
      `| Name | Title | Role | Tech Stack | ApplyTo | Agent Role |`,
      `|------|-------|------|------------|---------|------------|`,
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
      `## Task 1: Create Agent Files (parallel — no dependencies)`,
      `Use @forge-agent-writer to create all agent files.${vsCodeModel ? ` Use ${vsCodeModel}.` : ``}`,
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

    const agentTitleMap = new Map(plan.agents.map((x) => [x.name, x.title]));

    for (const a of plan.agents) {
      const tech = a.techStack.length > 0 ? ` (${a.techStack.join(", ")})` : "";
      const resp = a.responsibilities.map((r: string) => `    - ${r}`).join("\n");
      const roleInfo = a.agentRole ? `- Agent Role: ${a.agentRole}` : "";
      const agentsInfo = a.agents && a.agents.length > 0 ? `- Subagents (agents property — use these EXACT values in the \`agents:\` array): ${a.agents.map((slug: string) => `"${agentTitleMap.get(slug) || slug}"`).join(", ")}` : "";
      const invokableInfo = a.userInvokable === false ? `- user-invokable: false (subagent — hidden from dropdown)` : "";
      const disableInfo = a.disableModelInvocation === true ? `- disable-model-invocation: true (user-invoked only)` : "";
      const modelInfo = a.model ? `- Model: ${Array.isArray(a.model) ? a.model.join(", ") : a.model}` : "";

      const toolLine = a.agentRole === "orchestrator"
        ? `- Tools: read, search, agent, todo (NO edit/execute — delegates everything)`
        : a.agentRole === "subagent" && a.userInvokable === false
          ? `- Tools: ${a.category === "general" && a.responsibilities.some((r: string) => /review|security|audit/i.test(r)) ? "read, search" : "read, edit, search, execute"}`
          : `- Tools: read, edit, search, execute, todo`;

      const otherAgents = plan.agents.filter((o) => o.name !== a.name);
      const handoffLine = plan.agents.length > 1 && a.agentRole !== "orchestrator" && a.agentRole !== "subagent"
        ? `- Handoffs: add handoffs to these agents. The \`agent:\` value MUST be the target agent's \`name\` field value (NOT the filename slug):\n${otherAgents.map((o) => `    - agent: "${o.title}" ← use this EXACT string`).join("\n")}`
        : ``;

      sections.push(
        `### Agent: ${a.title}`,
        `- File: \`.github/agents/${a.name}.agent.md\``,
        `- Name: "${a.title}" (MUST use this exact value — VS Code resolves handoff references by the \`name\` field)`,
        `- Role: "${a.role}"${tech}`,
        `- Category: ${a.category}`,
        `- ApplyTo: ${a.applyToGlob}`,
        roleInfo,
        agentsInfo,
        invokableInfo,
        disableInfo,
        modelInfo,
        `- Responsibilities:`,
        resp,
        toolLine,
        a.agentRole !== "orchestrator" && a.agentRole !== "subagent" ? `- MUST include: \`argument-hint\`, \`user-invokable: true\`` : "",
        handoffLine,
        ``,
      );
    }

    // ── Task 2: Instruction Files (non-orchestrator agents only) ──
    sections.push(
      `---`,
      `## Task 2: Create Instruction Files (parallel — no dependencies)`,
      `Use @forge-instruction-writer to create instruction files for each **non-orchestrator** agent.${vsCodeModel ? ` Use ${vsCodeModel}.` : ``}`,
      `Do NOT create instruction files for orchestrator agents — orchestrators delegate work and never edit files directly.`,
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
      if (a.agentRole === "orchestrator") continue;
      sections.push(
        `### Instruction: ${a.title}`,
        `- File: \`.github/instructions/${a.name}.instructions.md\``,
        `- ApplyTo: "${a.applyToGlob}"`,
        `- Description: "${a.instruction.description}"`,
        `- Domain: ${a.category}, tech: ${a.techStack.join(", ") || "general"}`,
        ``,
      );
    }

    // ── Task 3: Skill Files (non-orchestrator agents only) ──
    sections.push(
      `---`,
      `## Task 3: Create Skill Files (parallel — no dependencies)`,
      `Use @forge-skill-writer to create skill files for each **non-orchestrator** agent.${vsCodeModel ? ` Use ${vsCodeModel}.` : ``}`,
      `Do NOT create skill files for orchestrator agents — orchestrators coordinate work and have no domain expertise.`,
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
      if (a.agentRole === "orchestrator") continue;
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
      `## Task 4: Create Prompt File (parallel — no dependencies)`,
      `Use @forge-prompt-writer to create the prompt file.${vsCodeModel ? ` Use ${vsCodeModel}.` : ``}`,
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
    `## Task 5: Create Global Instructions (sequential — runs LAST after Tasks 1–4 complete)`,
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
      `## Task ${taskNum}: Create Hook Configuration (parallel — no dependencies)`,
      `Use @forge-hook-writer to create hook config and companion scripts.${vsCodeModel ? ` Use ${vsCodeModel}.` : ``}`,
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
      `## Task ${taskNum}: Create MCP Configuration (parallel — no dependencies)`,
      `Use @forge-mcp-writer to create MCP server config.${vsCodeModel ? ` Use ${vsCodeModel}.` : ``}`,
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
      `## Task ${taskNum}: Create Agentic Workflow (parallel — no dependencies)`,
      `Use @forge-workflow-writer to create the workflow file.${vsCodeModel ? ` Use ${vsCodeModel}.` : ``}`,
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
    `- **Tasks 1–4 and optional Tasks 6–8 are fully independent** — run them ALL simultaneously.`,
    `- **Task 5 depends on Tasks 1–4** — it must run after all writer tasks complete.`,
    `- Each subagent has its own context window. The Plan Overview above provides shared context.`,
    `- Do NOT wait for one task to finish before starting another (except Task 5).`,
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
      `- Name: "${a.title}" (MUST use this exact value — VS Code resolves handoff references by the \`name\` field)`,
      `- Role: "${a.role}"${tech}`,
      `- Category: ${a.category}`,
      `- ApplyTo: ${a.applyToGlob}`,
      `- Responsibilities:`,
      resp,
      `- Tools: read, edit, search, execute, todo`,
      `- MUST include: \`argument-hint\`, \`user-invokable: true\``,
      plan.agents.length > 1
        ? `- Handoffs: add handoffs to these agents. The \`agent:\` value MUST be the target agent's \`name\` field value (NOT the filename slug):\n${plan.agents.filter((o) => o.name !== a.name).map((o) => `    - agent: "${o.title}" ← use this EXACT string`).join("\n")}`
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
    const category = a.category || "general";
    const categoryHint = {
      frontend: "Framework/Platform — focus on architecture, project structure, conventions, decision trees",
      backend: "Framework/Platform or SDK/Library — focus on API patterns, routing, data access, architecture",
      ai: "SDK/Library — focus on core concepts, common patterns with input/output examples, API reference",
      general: "Workflow/Process — focus on step-by-step procedures, decision trees, checklists",
    }[category] || "Adapt body structure to the domain";

    sections.push(
      `### Skill: ${a.title}`,
      `- File path: \`.github/skills/${a.name}/SKILL.md\``,
      `- Name: "${a.name}" (MUST match directory name exactly)`,
      `- Category: ${category} → ${categoryHint}`,
      `- Description: "${a.skill.description}"`,
      `- Description checklist: 1-1024 chars, ≥5 USE FOR trigger phrases (synonyms, casual terms, abbreviations), ≥3 DO NOT USE FOR exclusion phrases (near-miss topics)`,
      `- Body: <500 lines, use category-appropriate structure, split large knowledge into references/ subdirectory`,
      ``,
    );
  }

  sections.push(
    `## Rules`,
    `- Create ALL skill files listed above.`,
    `- The \`name\` field in frontmatter MUST match the parent directory name.`,
    `- Each skill description MUST have USE FOR and DO NOT USE FOR trigger phrases.`,
    `- Descriptions should be slightly "pushy" — mention use cases even when user doesn't explicitly name the skill.`,
    `- Content must be domain-specific, not generic filler.`,
    `- Body must be <500 lines. If domain knowledge is large, create references/ subdirectory with topic-specific .md files.`,
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
- For unrecognized tool names: replace with the closest valid VS Code Copilot tool (read, edit, search, run_in_terminal, file_search, grep_search, semantic_search, list_dir, read_file, fetch_webpage, memory, get_terminal_output, get_changed_files, test_failure, create_file, replace_string_in_file, multi_replace_string_in_file, read_notebook_cell_output, run_notebook_cell, edit_notebook_file, open_browser_page, runSubagent, search_subagent, run_vscode_command, vscode_renameSymbol, vscode_listCodeUsages, manage_todo_list, tool_search_tool_regex).
- For missing "USE FOR:" / "DO NOT USE FOR:" in skill descriptions: add appropriate trigger phrases based on the skill's content.
- For placeholder text (TODO, PLACEHOLDER, etc.): replace with meaningful content based on context.
- For empty/thin body content: expand with domain-specific content.
- For user-invokable as string: convert to boolean.
- For deprecated "infer" field: remove and set user-invokable + disable-model-invocation accordingly.
- For missing applyTo: infer from the instruction file name and content.
- Keep YAML frontmatter valid. Preserve the --- delimiters.

Output ONLY a JSON object mapping file paths to their corrected full content. No markdown fences, no explanation.
Example: {"path/to/file.md": "---\\nname: ...\\n---\\nBody..."}`;
}

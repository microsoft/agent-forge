import fs from "fs-extra";
import path from "path";
import { spawn } from "child_process";
import YAML from "yaml";
import type {
  ValidationReport,
  ValidationFinding,
  ArtifactType,
} from "../types.js";
import { isCopilotCliInstalled, buildShellCommand } from "./copilot-cli.js";

/**
 * Lightweight single-shot Copilot CLI call for JSON output.
 * Used only for validation fix prompts.
 */
function callLlmForJson<T = unknown>(
  workingDir: string,
  prompt: string,
  options?: { model?: string; timeoutMs?: number },
): Promise<T> {
  return new Promise((resolve, reject) => {
    // Write prompt to a temp file to avoid shell escaping issues on Windows.
    const promptFileName = `_forge-validate-prompt.md`;
    const promptFilePath = path.join(workingDir, promptFileName);
    fs.writeFileSync(promptFilePath, prompt, "utf-8");

    const args = ["-p", `Read and follow all instructions in ${promptFileName}`, "--autopilot", "--no-ask-user"];
    if (options?.model) args.push("--model", options.model);

    const cmd = buildShellCommand("copilot", args);
    const child = spawn(cmd, {
      cwd: workingDir,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    const timeout = options?.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      fs.removeSync(promptFilePath);
      reject(new Error(`Copilot CLI timed out after ${timeout}ms`));
    }, timeout);

    child.on("error", (err) => {
      clearTimeout(timer);
      fs.removeSync(promptFilePath);
      reject(new Error(`Failed to launch Copilot CLI: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      fs.removeSync(promptFilePath);
      const raw = Buffer.concat(chunks).toString("utf-8");
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        reject(new Error(`No JSON found in Copilot output (exit ${code}): ${raw.slice(0, 300)}`));
        return;
      }
      try {
        resolve(JSON.parse(jsonMatch[0]) as T);
      } catch (e) {
        reject(new Error(`Failed to parse JSON: ${(e as Error).message}`));
      }
    });
  });
}

// ─── Known VS Code Copilot tool names ───

/** Recognized VS Code Copilot tool names and official aliases. Unknown tools trigger a warning. */
const VALID_VSCODE_TOOLS = new Set([
  // Official tool aliases (from GitHub Copilot CLI spec)
  "execute", "shell", "Bash", "powershell",   // shell/terminal execution
  "read", "Read", "NotebookRead",             // read files
  "edit", "Edit", "MultiEdit", "Write", "NotebookEdit",  // modify files
  "search", "Grep", "Glob",                   // search files/text
  "agent", "custom-agent", "Task",            // invoke sub-agents
  "web", "WebSearch", "WebFetch",             // fetch URLs
  "todo", "TodoWrite",                        // task lists
  // Extended file tools
  "read_file", "create_file", "replace_string_in_file", "multi_replace_string_in_file",
  "file_search", "grep_search", "semantic_search", "list_dir",
  // Terminal
  "run_in_terminal", "get_terminal_output",
  // Diagnostics
  "get_errors", "test_failure",
  // Git / VCS
  "get_changed_files",
  // Notebook
  "read_notebook_cell_output", "run_notebook_cell", "edit_notebook_file",
  // Browser / web
  "fetch_webpage", "open_browser_page",
  // Memory
  "memory",
  // Subagents
  "runSubagent", "search_subagent",
  // VS Code commands
  "run_vscode_command", "vscode_renameSymbol", "vscode_listCodeUsages",
  // Todo
  "manage_todo_list",
  // Tool discovery
  "tool_search_tool_regex",
]);

/**
 * Compute Levenshtein distance between two strings.
 * Used to suggest the closest valid tool name for typos.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Find the closest matching tool name from the known registry.
 * Returns the suggestion only if the distance is small enough to be a plausible typo.
 */
function suggestToolName(unknown: string): string | null {
  let best = "";
  let bestDist = Infinity;
  for (const known of VALID_VSCODE_TOOLS) {
    const dist = levenshtein(unknown.toLowerCase(), known.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = known;
    }
  }
  // Only suggest if distance is at most 3 (reasonable typo range)
  return bestDist <= 3 ? best : null;
}

// ─── Post-generation auto-fix ───

/**
 * Post-generation validation and auto-fix.
 * Reads all generated artifacts, fixes common issues (missing description,
 * unrecognized fields), then validates to ensure zero warnings/errors.
 *
 * Returns the final validation report after fixes are applied.
 */
export async function postGenerationValidateAndFix(
  targetDir: string,
): Promise<ValidationReport> {
  const githubDir = path.join(targetDir, ".github");
  if (!(await fs.pathExists(githubDir))) {
    return { errors: [], warnings: [], passed: [], summary: "No .github/ directory found", fixableCount: 0 };
  }

  // Phase 1: Auto-fix all markdown artifacts
  const artifactDirs: Array<{ dir: string; suffix: string; type: ArtifactType }> = [
    { dir: path.join(githubDir, "agents"), suffix: ".agent.md", type: "agent" },
    { dir: path.join(githubDir, "prompts"), suffix: ".prompt.md", type: "prompt" },
    { dir: path.join(githubDir, "instructions"), suffix: ".instructions.md", type: "instruction" },
  ];

  for (const { dir, suffix, type } of artifactDirs) {
    if (await fs.pathExists(dir)) {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (file.endsWith(suffix)) {
          await autoFixFile(path.join(dir, file), type);
        }
      }
    }
  }

  // Fix skills (nested in subdirectories)
  const skillsDir = path.join(githubDir, "skills");
  if (await fs.pathExists(skillsDir)) {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
        if (await fs.pathExists(skillFile)) {
          await autoFixFile(skillFile, "skill");
        }
      }
    }
  }

  // Phase 2: Validate after fixes
  return validateDirectory(targetDir);
}

/**
 * Auto-fix a single artifact file's frontmatter.
 * Fixes:
 *   - Missing `description` — derives from body content or file name
 *   - Unrecognized fields — removes them (prevents VS Code warnings)
 *   - Missing `applyTo` for instructions — infers from file name/content
 *   - `user-invocable` as string — converts to boolean
 */
async function autoFixFile(
  filePath: string,
  type: ArtifactType,
): Promise<void> {
  const content = await fs.readFile(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);

  if (!frontmatter) return;

  const validFields = VALID_FIELDS[type];
  if (!validFields) return;

  let modified = false;

  // Fix: Remove unrecognized fields
  for (const key of Object.keys(frontmatter)) {
    if (!validFields.has(key)) {
      delete frontmatter[key];
      modified = true;
    }
  }

  // Fix: Missing description
  if (!frontmatter.description) {
    const name = frontmatter.name as string | undefined;
    const fileName = path.basename(filePath).replace(/\.(agent|prompt|instructions)\.md$/, "").replace(/^SKILL$/, "");
    const firstHeading = body.match(/^#\s+(.+)$/m)?.[1];

    let desc: string;
    if (type === "agent") {
      desc = name ? `${name} development agent` : `${autoFixSlugToTitle(fileName)} agent`;
    } else if (type === "instruction") {
      desc = `Coding standards for ${name || autoFixSlugToTitle(fileName)} — auto-applied to matching files`;
    } else if (type === "prompt") {
      desc = firstHeading || `${autoFixSlugToTitle(fileName)} prompt`;
    } else {
      desc = firstHeading || `${autoFixSlugToTitle(fileName)} domain knowledge`;
    }

    frontmatter.description = desc;
    modified = true;
  }

  // Fix: Instruction missing applyTo
  if (type === "instruction" && !frontmatter.applyTo) {
    const name = (frontmatter.name as string || path.basename(filePath, ".instructions.md")).toLowerCase();
    if (/react|frontend|next|vue|angular|svelte|tailwind|css/i.test(name)) {
      frontmatter.applyTo = "**/*.{ts,tsx,js,jsx,css,scss}";
    } else if (/python|fastapi|django|flask|langchain/i.test(name)) {
      frontmatter.applyTo = "**/*.py";
    } else if (/dotnet|\.net|csharp/i.test(name)) {
      frontmatter.applyTo = "**/*.{cs,csproj}";
    } else if (/backend|express|node|api/i.test(name)) {
      frontmatter.applyTo = "**/*.{ts,js,py}";
    } else {
      frontmatter.applyTo = "**/*";
    }
    modified = true;
  }

  // Fix: user-invocable as string → boolean
  if ((type === "agent" || type === "skill") && typeof frontmatter["user-invocable"] === "string") {
    frontmatter["user-invocable"] = frontmatter["user-invocable"] === "true";
    modified = true;
  }

  // Fix: migrate deprecated infer → user-invocable + disable-model-invocation
  if ((type === "agent" || type === "skill") && "infer" in frontmatter) {
    const inferVal = frontmatter.infer;
    if (inferVal === false) {
      frontmatter["user-invocable"] = frontmatter["user-invocable"] ?? false;
      frontmatter["disable-model-invocation"] = frontmatter["disable-model-invocation"] ?? true;
    }
    delete frontmatter.infer;
    modified = true;
  }

  if (modified) {
    const yamlStr = YAML.stringify(frontmatter, { lineWidth: 0 }).trim();
    const newContent = `---\n${yamlStr}\n---\n${body}`;
    await fs.writeFile(filePath, newContent);
  }
}

function autoFixSlugToTitle(slug: string): string {
  return slug
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Valid frontmatter fields per artifact type (markdown-based types only) */
const VALID_FIELDS: Partial<Record<ArtifactType, Set<string>>> = {
  agent: new Set([
    "name",
    "description",
    "tools",
    "agents",
    "model",
    "user-invocable",
    "disable-model-invocation",
    "target",
    "mcp-servers",
    "handoffs",
    "argument-hint",
    "infer",           // deprecated — auto-migrated, kept to avoid stripping before migration
  ]),
  prompt: new Set([
    "name",
    "description",
    "argument-hint",
    "agent",
    "model",
    "tools",
  ]),
  instruction: new Set(["name", "description", "applyTo"]),
  skill: new Set([
    "name",
    "description",
    "argument-hint",
    "user-invocable",
    "disable-model-invocation",
    "infer",           // deprecated — auto-migrated, kept to avoid stripping before migration
  ]),
};

/**
 * Validate all customization files in a directory.
 */
export async function validateDirectory(dir: string): Promise<ValidationReport> {
  const findings: ValidationFinding[] = [];
  const passed: string[] = [];

  const githubDir = path.join(dir, ".github");
  const useCasesDir = path.join(dir, "use-cases");

  // Validate .github/ if it exists
  if (await fs.pathExists(githubDir)) {
    await validateArtifactsInDir(githubDir, findings, passed);
  }

  // Validate use-cases/ if it exists
  if (await fs.pathExists(useCasesDir)) {
    const entries = await fs.readdir(useCasesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await validateArtifactsInDir(
          path.join(useCasesDir, entry.name),
          findings,
          passed,
        );
      }
    }
  }

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");

  const allFindings = [...errors, ...warnings];
  const fixableCount = allFindings.filter((f) => f.fixable).length;

  const summary =
    errors.length === 0
      ? `All checks passed (${passed.length} files validated, ${warnings.length} warnings)`
      : `${errors.length} error(s), ${warnings.length} warning(s) across ${passed.length + errors.length} files`;

  return { errors, warnings, passed, summary, fixableCount };
}

const VALID_HOOK_EVENTS = new Set([
  "sessionStart", "sessionEnd", "userPromptSubmitted", "preToolUse",
  "postToolUse", "errorOccurred", "subagentStop", "agentStop",
]);

async function validateArtifactsInDir(
  dir: string,
  findings: ValidationFinding[],
  passed: string[],
): Promise<void> {
  // Agents
  const agentsDir = path.join(dir, "agents");
  if (await fs.pathExists(agentsDir)) {
    await validateFilesInDir(agentsDir, ".agent.md", "agent", findings, passed);
  }

  // Prompts
  const promptsDir = path.join(dir, "prompts");
  if (await fs.pathExists(promptsDir)) {
    await validateFilesInDir(
      promptsDir,
      ".prompt.md",
      "prompt",
      findings,
      passed,
    );
  }

  // Instructions
  const instructionsDir = path.join(dir, "instructions");
  if (await fs.pathExists(instructionsDir)) {
    await validateFilesInDir(
      instructionsDir,
      ".instructions.md",
      "instruction",
      findings,
      passed,
    );
  }

  // Skills
  const skillsDir = path.join(dir, "skills");
  if (await fs.pathExists(skillsDir)) {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
        if (await fs.pathExists(skillFile)) {
          await validateFile(skillFile, "skill", findings, passed);
        }
      }
    }
  }

  // Hooks
  const hooksDir = path.join(dir, "hooks");
  if (await fs.pathExists(hooksDir)) {
    await validateHookFiles(hooksDir, findings, passed);
  }

  // Agentic Workflows (.md files in workflows/)
  const workflowsDir = path.join(dir, "workflows");
  if (await fs.pathExists(workflowsDir)) {
    await validateWorkflowFiles(workflowsDir, findings, passed);
  }

  // copilot-instructions.md
  const copilotInstructions = path.join(dir, "copilot-instructions.md");
  if (await fs.pathExists(copilotInstructions)) {
    passed.push(copilotInstructions);
  }

  // MCP config (.vscode/mcp.json — check parent dir)
  const parentDir = path.dirname(dir);
  const mcpFile = path.join(parentDir, ".vscode", "mcp.json");
  if (await fs.pathExists(mcpFile)) {
    await validateMcpConfig(mcpFile, findings, passed);
  }
}

async function validateHookFiles(
  dir: string,
  findings: ValidationFinding[],
  passed: string[],
): Promise<void> {
  const files = await fs.readdir(dir);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(dir, file);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const config = JSON.parse(content) as { hooks?: Record<string, unknown[]> };

      if (!config.hooks || typeof config.hooks !== "object") {
        findings.push({
          severity: "error",
          file: filePath,
          message: 'Hook config must have a top-level "hooks" object',
        });
        continue;
      }

      let hasError = false;
      for (const [event, commands] of Object.entries(config.hooks)) {
        if (!VALID_HOOK_EVENTS.has(event)) {
          findings.push({
            severity: "error",
            file: filePath,
            message: `Unknown hook event: "${event}". Valid events: ${[...VALID_HOOK_EVENTS].join(", ")}`,
            field: event,
          });
          hasError = true;
        }
        if (!Array.isArray(commands)) {
          findings.push({
            severity: "error",
            file: filePath,
            message: `Hook event "${event}" must be an array of commands`,
            field: event,
          });
          hasError = true;
          continue;
        }
        for (const cmd of commands) {
          const c = cmd as Record<string, unknown>;
          if (c.type !== "command") {
            findings.push({
              severity: "error",
              file: filePath,
              message: `Hook command must have type: "command" (in event "${event}")`,
              field: event,
            });
            hasError = true;
          }
          if (!c.command && !c.windows && !c.linux && !c.osx) {
            findings.push({
              severity: "error",
              file: filePath,
              message: `Hook command missing "command" field (in event "${event}")`,
              field: event,
            });
            hasError = true;
          }
        }
      }
      if (!hasError) passed.push(filePath);
    } catch {
      findings.push({
        severity: "error",
        file: filePath,
        message: "Invalid JSON in hook configuration file",
      });
    }
  }
}

async function validateMcpConfig(
  filePath: string,
  findings: ValidationFinding[],
  passed: string[],
): Promise<void> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const config = JSON.parse(content) as { servers?: Record<string, Record<string, unknown>> };

    if (!config.servers || typeof config.servers !== "object") {
      findings.push({
        severity: "error",
        file: filePath,
        message: 'MCP config must have a top-level "servers" object',
      });
      return;
    }

    let hasError = false;
    for (const [name, server] of Object.entries(config.servers)) {
      if (!server.command && !server.url && !server.type) {
        findings.push({
          severity: "error",
          file: filePath,
          message: `MCP server "${name}" must have "command" (stdio) or "url"+ "type" (http)`,
          field: name,
        });
        hasError = true;
      }
    }
    if (!hasError) passed.push(filePath);
  } catch {
    findings.push({
      severity: "error",
      file: filePath,
      message: "Invalid JSON in MCP configuration file",
    });
  }
}

async function validateWorkflowFiles(
  dir: string,
  findings: ValidationFinding[],
  passed: string[],
): Promise<void> {
  const files = await fs.readdir(dir);
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const filePath = path.join(dir, file);
    const content = await fs.readFile(filePath, "utf-8");
    const { frontmatter } = parseFrontmatter(content);

    if (!frontmatter) {
      findings.push({
        severity: "error",
        file: filePath,
        message: "Agentic workflow must have YAML frontmatter with trigger config",
      });
      continue;
    }

    let hasError = false;
    if (!frontmatter.on) {
      findings.push({
        severity: "error",
        file: filePath,
        message: 'Agentic workflow missing required "on" trigger configuration',
        field: "on",
      });
      hasError = true;
    }

    if (!frontmatter.permissions) {
      findings.push({
        severity: "warning",
        file: filePath,
        message: 'Missing "permissions" field — workflow will use default permissions',
        field: "permissions",
      });
    }

    if (!hasError) passed.push(filePath);
  }
}

async function validateFilesInDir(
  dir: string,
  suffix: string,
  type: ArtifactType,
  findings: ValidationFinding[],
  passed: string[],
): Promise<void> {
  const files = await fs.readdir(dir);
  for (const file of files) {
    if (file.endsWith(suffix)) {
      await validateFile(path.join(dir, file), type, findings, passed);
    }
  }
}

async function validateFile(
  filePath: string,
  type: ArtifactType,
  findings: ValidationFinding[],
  passed: string[],
): Promise<void> {
  const content = await fs.readFile(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);
  let hasError = false;

  if (!frontmatter) {
    findings.push({
      severity: "error",
      file: filePath,
      message: "Missing YAML frontmatter (must start with ---)",
    });
    return;
  }

  // Validate frontmatter fields
  const validFields = VALID_FIELDS[type];
  if (validFields) {
    for (const key of Object.keys(frontmatter)) {
      if (!validFields.has(key)) {
        findings.push({
          severity: "warning",
          file: filePath,
          message: `Unrecognized frontmatter field: "${key}"`,
          field: key,
        });
      }
    }
  }

  // Required: description
  if (!frontmatter.description) {
    findings.push({
      severity: "error",
      file: filePath,
      message: "Missing required field: description",
      field: "description",
    });
    hasError = true;
  }

  // Agent/Skill-specific checks
  if (type === "agent" || type === "skill") {
    if (typeof frontmatter["user-invocable"] === "string") {
      findings.push({
        severity: "error",
        file: filePath,
        message: 'Field "user-invocable" must be a boolean (true/false), not a string',
        field: "user-invocable",
        fixable: true,
      });
      hasError = true;
    }
    // Warn about deprecated infer field
    if ("infer" in frontmatter) {
      findings.push({
        severity: "warning",
        file: filePath,
        message: 'Field "infer" is deprecated. Use "user-invocable" and "disable-model-invocation" instead.',
        field: "infer",
        fixable: true,
      });
    }
  }
  if (type === "agent") {
    if (frontmatter.tools && !Array.isArray(frontmatter.tools)) {
      findings.push({
        severity: "error",
        file: filePath,
        message: 'Field "tools" must be an array',
        field: "tools",
        fixable: true,
      });
      hasError = true;
    }
  }

  // Validate tool names against known VS Code Copilot tools
  if ((type === "agent" || type === "prompt") && Array.isArray(frontmatter.tools)) {
    for (const tool of frontmatter.tools as string[]) {
      if (typeof tool !== "string") continue;
      // Skip wildcards ("*"), MCP server patterns ("serverName/*"), and tool sets
      if (tool === "*" || tool.includes("/") || tool.includes("*")) continue;
      if (!VALID_VSCODE_TOOLS.has(tool)) {
        const suggestion = suggestToolName(tool);
        const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
        findings.push({
          severity: "warning",
          file: filePath,
          message: `Tool "${tool}" is not a recognized VS Code Copilot tool.${hint} Known tools: ${[...VALID_VSCODE_TOOLS].slice(0, 8).join(", ")}, ...`,
          field: "tools",
          fixable: !!suggestion,
        });
      }
    }
  }

  // Instruction-specific checks
  if (type === "instruction") {
    if (!frontmatter.applyTo) {
      findings.push({
        severity: "warning",
        file: filePath,
        message:
          "Missing applyTo field — instruction will not auto-apply to any files",
        field: "applyTo",
        fixable: true,
      });
    }
  }

  // Skill-specific checks: name must match parent directory
  if (type === "skill" && frontmatter.name) {
    const parentDirName = path.basename(path.dirname(filePath));
    if (parentDirName !== "skills" && frontmatter.name !== parentDirName) {
      findings.push({
        severity: "error",
        file: filePath,
        message: `Skill name "${frontmatter.name}" does not match parent directory "${parentDirName}". Per VS Code spec, the name field must match the directory name.`,
        field: "name",
        fixable: true,
      });
      hasError = true;
    }
  }

  // Skill-specific checks: trigger phrases
  if (type === "skill" && frontmatter.description) {
    const desc = frontmatter.description as string;
    const hasUseFor = /USE\s+FOR:/i.test(desc);
    const hasDoNotUseFor = /DO\s+NOT\s+USE\s+FOR:/i.test(desc);

    if (!hasUseFor) {
      findings.push({
        severity: "warning",
        file: filePath,
        message: 'Skill description missing "USE FOR:" trigger phrases — Copilot may not load this skill on-demand',
        field: "description",
        fixable: true,
      });
    } else {
      // Count trigger phrases after USE FOR:
      const useForMatch = desc.match(/USE\s+FOR:\s*(.+?)(?:DO\s+NOT|DO NOT|$)/is);
      if (useForMatch) {
        const phrases = useForMatch[1].split(/,/).filter((p) => p.trim().length > 0);
        if (phrases.length < 3) {
          findings.push({
            severity: "warning",
            file: filePath,
            message: `Skill "USE FOR:" has only ${phrases.length} trigger phrase(s) — recommend at least 3 for reliable on-demand loading`,
            field: "description",
            fixable: true,
          });
        }
      }
    }

    if (!hasDoNotUseFor) {
      findings.push({
        severity: "warning",
        file: filePath,
        message: 'Skill description missing "DO NOT USE FOR:" exclusion phrases — may cause incorrect skill loading',
        field: "description",
        fixable: true,
      });
    }
  }

  // Check for empty body
  if (!body.trim()) {
    findings.push({
      severity: "warning",
      file: filePath,
      message: "File has empty body content",
      fixable: true,
    });
  }

  // Body content quality checks
  if (body.trim()) {
    validateBodyQuality(filePath, type, body, findings);
  }

  if (!hasError) {
    passed.push(filePath);
  }
}

/**
 * Validate body content quality — detect placeholders, generic text, and low-content bodies.
 */
function validateBodyQuality(
  filePath: string,
  type: ArtifactType,
  body: string,
  findings: ValidationFinding[],
): void {
  // Detect common placeholder/TODO patterns
  const placeholderPatterns = [
    { pattern: /\bTODO\b/, label: "TODO" },
    { pattern: /\bPLACEHOLDER\b/i, label: "PLACEHOLDER" },
    { pattern: /\bINSERT\s+HERE\b/i, label: "INSERT HERE" },
    { pattern: /\bLorem\s+ipsum\b/i, label: "Lorem ipsum" },
    { pattern: /\byour\s+\w+\s+here\b/i, label: "your ... here" },
    { pattern: /\bFIXME\b/, label: "FIXME" },
    { pattern: /\bXXX\b/, label: "XXX" },
  ];

  for (const { pattern, label } of placeholderPatterns) {
    if (pattern.test(body)) {
      findings.push({
        severity: "warning",
        file: filePath,
        message: `Body contains ${label} placeholder text — consider replacing with specific content`,
        fixable: true,
      });
      break; // One placeholder warning is enough
    }
  }

  // Minimum content check for agents and skills (should have substantive content)
  if (type === "agent" || type === "skill") {
    const contentLines = body
      .split("\n")
      .filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"));
    if (contentLines.length < 3) {
      findings.push({
        severity: "warning",
        file: filePath,
        message: `Body has very little content (${contentLines.length} non-heading lines) — agents and skills need substantive instructions`,
        fixable: true,
      });
    }
  }
}

function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: content };

  try {
    const frontmatter = YAML.parse(match[1]) as Record<string, unknown>;
    return { frontmatter, body: match[2] };
  } catch {
    return { frontmatter: null, body: content };
  }
}

// ─── LLM-powered auto-fix ───

/**
 * Fix validation findings using the Copilot CLI LLM.
 * Collects fixable findings, reads their source files, sends to the LLM,
 * writes corrected content back, then re-validates to confirm fixes.
 *
 * Returns: { fixed: number of files fixed, report: updated validation report }
 */
export async function fixWithLLM(
  report: ValidationReport,
  targetDir: string,
  options?: { model?: string },
): Promise<{ fixed: number; report: ValidationReport }> {
  const allFindings = [...report.errors, ...report.warnings];
  const fixableFindings = allFindings.filter((f) => f.fixable);

  if (fixableFindings.length === 0) {
    return { fixed: 0, report };
  }

  // Collect unique file paths that have fixable issues
  const filePaths = [...new Set(fixableFindings.map((f) => f.file))];
  const fileContents = new Map<string, string>();

  for (const fp of filePaths) {
    try {
      const content = await fs.readFile(fp, "utf-8");
      fileContents.set(fp, content);
    } catch {
      // Skip files that can't be read
    }
  }

  if (fileContents.size === 0) {
    return { fixed: 0, report };
  }

  // Build the prompt and call the LLM
  const { buildValidationFixPrompt } = await import("./prompt-builder.js");
  const prompt = buildValidationFixPrompt(
    fixableFindings.map((f) => ({
      file: f.file,
      message: f.message,
      field: f.field,
      severity: f.severity,
    })),
    fileContents,
  );

  let corrections: Record<string, string>;
  try {
    corrections = await callLlmForJson<Record<string, string>>(
      targetDir,
      prompt,
      { model: options?.model ?? "claude-sonnet-4.6", timeoutMs: 60_000 },
    );
  } catch {
    return { fixed: 0, report };
  }

  // Write corrected files
  let fixedCount = 0;
  for (const [fp, correctedContent] of Object.entries(corrections)) {
    // Resolve the path — it may be relative or absolute in the LLM response
    const resolvedPath = path.isAbsolute(fp) ? fp : path.join(targetDir, fp);

    // Safety: only write to files that were part of the original findings
    if (!fileContents.has(resolvedPath) && !filePaths.includes(fp)) {
      continue;
    }

    const writePath = fileContents.has(resolvedPath) ? resolvedPath : fp;

    try {
      if (typeof correctedContent === "string" && correctedContent.trim().length > 0) {
        await fs.writeFile(writePath, correctedContent);
        fixedCount++;
      }
    } catch {
      // Skip files that can't be written
    }
  }

  // Re-validate after fixes
  const updatedReport = await validateDirectory(targetDir);
  return { fixed: fixedCount, report: updatedReport };
}

/**
 * Shared prerequisite checking — used by both `forge check` and `forge init`.
 */
import chalk from "chalk";
import { execSync } from "child_process";
import { getCopilotCliVersion } from "./copilot-cli.js";

export type PrerequisiteCategory = "required" | "recommended" | "optional";

export interface PrerequisiteResult {
  name: string;
  found: boolean;
  detail?: string;
  category: PrerequisiteCategory;
  installHint?: string;
}

/** Minimum required Node.js major version */
const MIN_NODE_MAJOR = 18;

/**
 * Return platform-aware install hint for a tool.
 */
function installHint(tool: string): string {
  const isMac = process.platform === "darwin";
  const isLinux = process.platform === "linux";

  switch (tool) {
    case "node":
      if (isMac) return "brew install node";
      if (isLinux) return "See https://nodejs.org/en/download";
      return "See https://nodejs.org/en/download";
    case "copilot":
      return "npm install -g @github/copilot";
    case "git":
      if (isMac) return "xcode-select --install";
      if (isLinux) return "sudo apt install git";
      return "See https://git-scm.com/downloads";
    case "gh":
      if (isMac) return "brew install gh";
      if (isLinux) return "See https://cli.github.com";
      return "See https://cli.github.com";
    case "docker":
      if (isMac) return "brew install --cask docker";
      return "See https://docs.docker.com/get-docker";
    default:
      return "";
  }
}

/**
 * Check a single CLI tool by running `<command> --version`.
 */
function checkTool(command: string): { found: boolean; version?: string } {
  try {
    const output = execSync(`${command} --version`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const vMatch = output.match(/(\d+\.\d+[\d.]*)/);
    return { found: true, version: vMatch ? vMatch[1] : output.slice(0, 30) };
  } catch {
    return { found: false };
  }
}

/**
 * Run all prerequisite checks and return structured results.
 *
 * Checks: Node.js ≥18, GitHub Copilot CLI, Git, GitHub CLI, Docker.
 * VS Code is intentionally not checked.
 */
export function checkPrerequisites(): PrerequisiteResult[] {
  const results: PrerequisiteResult[] = [];

  // 1. Node.js ≥18
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  results.push({
    name: "Node.js (≥18)",
    found: nodeMajor >= MIN_NODE_MAJOR,
    detail: `v${process.versions.node}`,
    category: "required",
    installHint: nodeMajor < MIN_NODE_MAJOR ? installHint("node") : undefined,
  });

  // 2. GitHub Copilot CLI (required)
  const copilotVersion = getCopilotCliVersion();
  results.push({
    name: "GitHub Copilot CLI",
    found: copilotVersion !== null,
    detail: copilotVersion ? `v${copilotVersion}` : undefined,
    category: "required",
    installHint: copilotVersion === null ? installHint("copilot") : undefined,
  });

  // 3. Git (recommended)
  const git = checkTool("git");
  results.push({
    name: "Git",
    found: git.found,
    detail: git.version ? `v${git.version}` : undefined,
    category: "recommended",
    installHint: !git.found ? installHint("git") : undefined,
  });

  // 4. GitHub CLI (optional — for agentic workflows)
  const gh = checkTool("gh");
  results.push({
    name: "GitHub CLI",
    found: gh.found,
    detail: gh.version ? `v${gh.version}` : undefined,
    category: "optional",
    installHint: !gh.found ? installHint("gh") : undefined,
  });

  // 5. Docker (optional — for MCP servers)
  const docker = checkTool("docker");
  results.push({
    name: "Docker",
    found: docker.found,
    detail: docker.version ? `v${docker.version}` : undefined,
    category: "optional",
    installHint: !docker.found ? installHint("docker") : undefined,
  });

  return results;
}

/**
 * Print the prerequisite results as a compact status table.
 */
export function formatPrerequisiteResults(results: PrerequisiteResult[]): void {
  const categoryLabel: Record<PrerequisiteCategory, string> = {
    required: chalk.red("required"),
    recommended: chalk.yellow("recommended"),
    optional: chalk.dim("optional"),
  };

  for (const r of results) {
    const icon = r.found
      ? chalk.green("✓")
      : r.category === "required"
        ? chalk.red("✗")
        : chalk.dim("○");
    const detail = r.detail ? chalk.dim(` (${r.detail})`) : "";
    const tag = r.found ? "" : ` ${categoryLabel[r.category]}`;
    const name = r.found ? r.name : chalk.dim(r.name);
    console.log(`  ${icon} ${name}${detail}${tag}`);
  }
}

/**
 * Returns true if any **required** prerequisite is missing.
 */
export function hasBlockingFailures(results: PrerequisiteResult[]): boolean {
  return results.some((r) => r.category === "required" && !r.found);
}

/**
 * Returns true if any **recommended** prerequisite is missing.
 */
export function hasWarnings(results: PrerequisiteResult[]): boolean {
  return results.some((r) => r.category === "recommended" && !r.found);
}

/**
 * Print install instructions for all missing tools grouped by category.
 * Returns the list of shell commands that would install everything.
 */
export function printMissingInstallGuide(results: PrerequisiteResult[]): string[] {
  const missing = results.filter((r) => !r.found && r.installHint);
  if (missing.length === 0) return [];

  const commands: string[] = [];

  // Required first, then recommended, then optional
  const order: PrerequisiteCategory[] = ["required", "recommended", "optional"];
  for (const cat of order) {
    const group = missing.filter((r) => r.category === cat);
    if (group.length === 0) continue;

    const header =
      cat === "required" ? chalk.red.bold("Required") :
      cat === "recommended" ? chalk.yellow.bold("Recommended") :
      chalk.dim("Optional");

    console.log();
    console.log(`  ${header}:`);
    for (const r of group) {
      console.log(`    ${chalk.white(r.name)}: ${chalk.cyan(r.installHint!)}`);
      commands.push(r.installHint!);
    }
  }

  // Print combined one-shot install snippet if there are installable commands
  const shellCommands = commands.filter((c) => !c.startsWith("See "));
  if (shellCommands.length > 1) {
    console.log();
    console.log(chalk.bold("  Quick install (all missing):"));
    console.log(chalk.cyan(`    ${shellCommands.join(" && ")}`));
  }

  return commands;
}

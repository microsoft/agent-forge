import fs from "fs-extra";
import path from "path";
import type { WorkspaceInfo, ProjectType } from "../types.js";

/** File indicators for tech stack detection */
const TECH_INDICATORS: Record<string, string[]> = {
  "package.json": ["node", "javascript"],
  "tsconfig.json": ["typescript"],
  "requirements.txt": ["python"],
  "pyproject.toml": ["python"],
  "Pipfile": ["python"],
  "go.mod": ["go"],
  "Cargo.toml": ["rust"],
  "pom.xml": ["java"],
  "build.gradle": ["java", "kotlin"],
  "Gemfile": ["ruby"],
  "composer.json": ["php"],
  "Package.swift": ["swift"],
  "mix.exs": ["elixir"],
  "pubspec.yaml": ["dart", "flutter"],
};

/** Heuristic project type detection from tech stack files */
const PROJECT_TYPE_HINTS: Record<string, ProjectType> = {
  "next.config.js": "web",
  "next.config.ts": "web",
  "next.config.mjs": "web",
  "vite.config.ts": "web",
  "vite.config.js": "web",
  "angular.json": "web",
  "nuxt.config.ts": "web",
  "svelte.config.js": "web",
  "webpack.config.js": "web",
  "index.html": "web",
  "Dockerfile": "api",
  "docker-compose.yml": "api",
  "serverless.yml": "api",
  "bin/cli.js": "cli",
  "bin/cli.ts": "cli",
};

/**
 * Analyze the workspace to understand existing structure and tech stack.
 */
export async function detectWorkspace(
  targetDir: string,
): Promise<WorkspaceInfo> {
  const githubDir = path.join(targetDir, ".github");
  const agentsDir = path.join(githubDir, "agents");
  const promptsDir = path.join(githubDir, "prompts");
  const instructionsDir = path.join(githubDir, "instructions");
  const skillsDir = path.join(githubDir, "skills");
  const hooksDir = path.join(githubDir, "hooks");
  const workflowsDir = path.join(githubDir, "workflows");
  const mcpFile = path.join(targetDir, ".vscode", "mcp.json");

  const hasGitHub = await fs.pathExists(githubDir);
  const hasAgents = await fs.pathExists(agentsDir);
  const hasPrompts = await fs.pathExists(promptsDir);
  const hasInstructions = await fs.pathExists(instructionsDir);
  const hasSkills = await fs.pathExists(skillsDir);
  const hasCopilotInstructions = await fs.pathExists(
    path.join(githubDir, "copilot-instructions.md"),
  );
  const hasHooks = await fs.pathExists(hooksDir);
  const hasMcpConfig = await fs.pathExists(mcpFile);
  const hasAgenticWorkflows = await fs.pathExists(workflowsDir);

  const existingAgents = hasAgents ? await listMdFiles(agentsDir) : [];
  const existingPrompts = hasPrompts ? await listMdFiles(promptsDir) : [];
  const existingInstructions = hasInstructions
    ? await listMdFiles(instructionsDir)
    : [];
  const existingSkills = hasSkills ? await listSkillDirs(skillsDir) : [];
  const existingHooks = hasHooks ? await listJsonFiles(hooksDir) : [];
  const existingMcpServers = hasMcpConfig ? await listMcpServers(mcpFile) : [];
  const existingWorkflows = hasAgenticWorkflows
    ? await listMdFiles(workflowsDir)
    : [];

  const techStack = await detectTechStack(targetDir);
  const projectType = await detectProjectType(targetDir);

  return {
    hasGitHub,
    hasAgents,
    hasPrompts,
    hasInstructions,
    hasSkills,
    hasCopilotInstructions,
    hasHooks,
    hasMcpConfig,
    hasAgenticWorkflows,
    existingAgents,
    existingPrompts,
    existingInstructions,
    existingSkills,
    existingHooks,
    existingMcpServers,
    existingWorkflows,
    projectType,
    techStack,
  };
}

async function listMdFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir);
  return entries.filter((f) => f.endsWith(".md"));
}

async function listJsonFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir);
  return entries.filter((f) => f.endsWith(".json"));
}

async function listSkillDirs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function listMcpServers(mcpFile: string): Promise<string[]> {
  try {
    const content = await fs.readFile(mcpFile, "utf-8");
    const config = JSON.parse(content) as { servers?: Record<string, unknown> };
    return config.servers ? Object.keys(config.servers) : [];
  } catch {
    return [];
  }
}

async function detectTechStack(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const [file, techs] of Object.entries(TECH_INDICATORS)) {
    if (await fs.pathExists(path.join(dir, file))) {
      for (const tech of techs) {
        if (!found.includes(tech)) found.push(tech);
      }
    }
  }
  return found;
}

async function detectProjectType(dir: string): Promise<ProjectType | null> {
  for (const [file, type] of Object.entries(PROJECT_TYPE_HINTS)) {
    if (await fs.pathExists(path.join(dir, file))) {
      return type;
    }
  }
  return null;
}

import chalk from "chalk";
import fs from "fs-extra";
import path from "path";
import { getGallery } from "../lib/gallery.js";
import { detectWorkspace } from "../lib/detector.js";

export async function listCommand(): Promise<void> {
  const cwd = process.cwd();
  const workspace = await detectWorkspace(cwd);

  // Installed customizations in .github/
  console.log(chalk.bold("\nInstalled (in .github/):")); 
  if (workspace.hasGitHub) {
    const userAgents = workspace.existingAgents;

    if (userAgents.length > 0) {
      for (const agent of userAgents) {
        const name = agent.replace(".agent.md", "");
        console.log(`  ${chalk.green("✓")} ${name}`);
      }
    }

    const totalItems = userAgents.length +
      workspace.existingPrompts.length +
      workspace.existingInstructions.length +
      workspace.existingSkills.length +
      workspace.existingHooks.length +
      workspace.existingWorkflows.length;

    if (totalItems > 0) {
      const parts = [];
      if (userAgents.length) parts.push(`${userAgents.length} agents`);
      if (workspace.existingPrompts.length) parts.push(`${workspace.existingPrompts.length} prompts`);
      if (workspace.existingInstructions.length) parts.push(`${workspace.existingInstructions.length} instructions`);
      if (workspace.existingSkills.length) parts.push(`${workspace.existingSkills.length} skills`);
      if (workspace.existingHooks.length) parts.push(`${workspace.existingHooks.length} hooks`);
      if (workspace.existingWorkflows.length) parts.push(`${workspace.existingWorkflows.length} workflows`);
      console.log(chalk.dim(`  ${parts.join(", ")}`));
    } else {
      console.log(chalk.dim('  No customizations found. Run "forge init" to get started.'));
    }

    // MCP servers (in .vscode/)
    if (workspace.existingMcpServers.length > 0) {
      console.log(chalk.dim(`  MCP servers: ${workspace.existingMcpServers.join(", ")}`));
    }
  } else {
    console.log(
      chalk.dim('  No .github/ directory found. Run "forge init" to get started.'),
    );
  }

  // Gallery
  const gallery = getGallery();
  const installedIds = new Set<string>();

  for (const entry of gallery) {
    const agentFile = path.join(cwd, ".github", "agents", `${entry.id}.agent.md`);
    const hasAgent = await fs.pathExists(agentFile);
    const hasAnyFile = hasAgent || await Promise.all(
      entry.files.map((f) => fs.pathExists(path.join(cwd, ".github", f)))
    ).then((results) => results.some(Boolean));
    const hasVscodeFile = await Promise.all(
      entry.files.filter((f) => f.startsWith(".vscode/")).map((f) => fs.pathExists(path.join(cwd, f)))
    ).then((results) => results.some(Boolean));

    if (hasAgent || hasAnyFile || hasVscodeFile) {
      installedIds.add(entry.id);
    }
  }

  // Group gallery entries by type
  const agentEntries = gallery.filter((e) => e.files.some((f) => f.startsWith("agents/")));
  const hookEntries = gallery.filter((e) => e.files.some((f) => f.startsWith("hooks/")));
  const workflowEntries = gallery.filter((e) => e.files.some((f) => f.startsWith("workflows/")));
  const mcpEntries = gallery.filter((e) => e.files.some((f) => f.startsWith(".vscode/")));

  console.log(chalk.bold("\nGallery:"));

  const printEntry = (entry: typeof gallery[0]) => {
    const isInstalled = installedIds.has(entry.id);
    const icon = isInstalled ? chalk.green("✓") : chalk.dim("○");
    const name = entry.name.padEnd(24);
    const status = isInstalled ? chalk.green(" installed") : "";
    const tags = chalk.dim(`[${entry.tags.slice(0, 3).join(", ")}]`);
    console.log(`  ${icon} ${name} ${chalk.dim("—")} ${entry.description}${status}`);
    console.log(`    ${tags}  ${chalk.dim(`${entry.files.length} file${entry.files.length > 1 ? "s" : ""}`)}`);
  };

  if (agentEntries.length > 0) {
    console.log(chalk.cyan("\n  Agents & Skills"));
    for (const entry of agentEntries) printEntry(entry);
  }

  if (hookEntries.length > 0) {
    console.log(chalk.cyan("\n  Hooks"));
    for (const entry of hookEntries) printEntry(entry);
  }

  if (workflowEntries.length > 0) {
    console.log(chalk.cyan("\n  Workflows"));
    for (const entry of workflowEntries) printEntry(entry);
  }

  if (mcpEntries.length > 0) {
    console.log(chalk.cyan("\n  MCP Servers"));
    for (const entry of mcpEntries) printEntry(entry);
  }

  const installedCount = installedIds.size;
  const availableCount = gallery.length - installedCount;
  console.log();
  console.log(chalk.dim(`  ${installedCount} installed, ${availableCount} available — run ${chalk.cyan("forge init")} to install`));

  console.log();
}

import chalk from "chalk";
import ora from "ora";
import { select } from "@inquirer/prompts";
import {
  prepareGenerationWorkspace,
  installGeneratedArtifacts,
  cleanupGenerationWorkspace,
  readPlanFile,
  prepareWorkspaceForPlan,
} from "../lib/scaffold.js";
import {
  launchCopilotCli,
  selectModel,
  getModelMultiplier,
  formatDuration,
  formatTokens,
  aggregateCliOutputs,
} from "../lib/copilot-cli.js";
import type { CliOutput } from "../lib/copilot-cli.js";
import {
  buildPlanningPrompt,
  buildOrchestrationPromptFromPlan,
  buildFleetOrchestrationPrompt,
} from "../lib/prompt-builder.js";
import { animateLogo } from "./init.js";
import { postGenerationValidateAndFix } from "../lib/validator.js";
import path from "path";
import type { GenerateOptions, SpeedStrategy } from "../types.js";

/** Strip ANSI escape codes to get visual length */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Pad a string to a visual width, accounting for ANSI escape codes */
function vpad(str: string, width: number): string {
  const visual = stripAnsi(str).length;
  return str + " ".repeat(Math.max(0, width - visual));
}

export async function generateCommand(
  description: string,
  options: GenerateOptions,
): Promise<void> {
  if (!description.trim()) {
    console.log(chalk.red("Error: Please provide a use case description."));
    console.log(chalk.dim('Example: forge generate "API rate limiter with per-tenant limits"'));
    process.exit(1);
  }

  await animateLogo();
  console.log(chalk.hex("#FF8C00")("  Use case ") + chalk.white.bold(description));
  if (options.mode) {
    console.log(chalk.hex("#FF8C00")("  Mode     ") + chalk.white.bold(options.mode));
  }
  console.log();

  // Prerequisite check
  const { checkPrerequisites, hasBlockingFailures, formatPrerequisiteResults, printMissingInstallGuide } = await import("../lib/prerequisites.js");
  const prereqs = checkPrerequisites();
  if (hasBlockingFailures(prereqs)) {
    console.log(chalk.bold("  Checking prerequisites...\n"));
    formatPrerequisiteResults(prereqs);
    console.log();
    console.log(chalk.red.bold("  ✗ Missing required tools — install them before continuing."));
    printMissingInstallGuide(prereqs);
    console.log();
    process.exit(1);
  }

  const targetDir = process.cwd();
  const mode = options.mode ?? "full";

  console.log(chalk.dim("  Copilot CLI detected — using plan-then-execute pipeline."));
  console.log();

  const model = options.model ?? await selectModel();

  const spinner = ora("Preparing workspace...").start();

  try {
    const { tempDir, slug, title, domains } = await prepareGenerationWorkspace(description, mode, "greenfield");
    spinner.succeed("Workspace ready");

    // Phase 1: Planning (greenfield — from description only)
    console.log();
    console.log(chalk.hex("#FF8C00").bold("  ── Phase 1 · Planning ─────────────────────────────────────"));
    console.log(chalk.hex("#555555")("  │ ") + chalk.hex("#FF8C00")("Model     ") + chalk.white(model));
    console.log(chalk.hex("#555555")("  │ ") + chalk.hex("#FF8C00")("Mode      ") + chalk.white(mode));
    if (domains.length > 1) {
      console.log(chalk.hex("#555555")("  │ ") + chalk.hex("#FF8C00")("Domains   ") + chalk.white(domains.map((d) => d.title).join(", ")));
    }
    console.log();

    const planPrompt = buildPlanningPrompt(mode, slug, title, description, domains, undefined, options.types);
    const planOutput = await launchCopilotCli(tempDir, planPrompt, {
      model,
      agent: "forge-greenfield-planner",
      maxContinues: 15,
    });

    if (planOutput.exitCode !== 0) {
      console.log(chalk.yellow("\n  ⚠  Planner exited with warnings."));
    }

    // Read the plan
    const planSpinner = ora("Reading plan...").start();
    const plan = await readPlanFile(tempDir);
    planSpinner.succeed(`Plan ready — ${plan.agents.length} agent(s): ${plan.agents.map((a) => a.name).join(", ")}`);

    // Prepare workspace directories for Phase 2
    await prepareWorkspaceForPlan(tempDir, plan);

    // Speed selection (after planning so agent count is known for accurate PRU)
    const multiplier = getModelMultiplier(model);
    const speed: SpeedStrategy = options.speed ?? await select<SpeedStrategy>({
      message: "Generation speed:",
      choices: [
        { value: "standard" as SpeedStrategy, name: `Standard  ${chalk.dim(`— single session, ~${2 * multiplier} PRU`)}` },
        { value: "turbo" as SpeedStrategy, name: `Turbo     ${chalk.dim(`— fleet mode, parallel subagents, ~${(plan.agents.length + 1) * multiplier} PRU`)} ${chalk.hex("#FFD700")("⚡")}` },
      ],
      default: "standard",
    });

    // Phase 2: Generate artifacts
    console.log();
    const speedLabel = speed === "turbo" ? "Turbo ⚡" : "Standard";
    console.log(chalk.hex("#FF8C00").bold(`  ── Phase 2 · Generating (${speedLabel}) ` + "─".repeat(Math.max(0, 25 - speedLabel.length))));

    let exitCode: number;
    const phase2Start = Date.now();
    let writerDurationMs = 0;
    const phaseOutputs: { planning: CliOutput; writers: CliOutput[]; instructions?: CliOutput; orchestrator?: CliOutput } = {
      planning: planOutput,
      writers: [],
    };

    if (speed === "turbo") {
      // Turbo: single session with /fleet — Copilot CLI delegates to writer subagents in parallel
      const fleetPrompt = buildFleetOrchestrationPrompt(plan, mode);
      console.log(chalk.hex("#555555")("  │ ") + chalk.hex("#FF8C00")("Mode      ") + chalk.white("Fleet (parallel subagents)"));
      console.log();

      const fleetOutput = await launchCopilotCli(tempDir, fleetPrompt, {
        model,
        agent: "forge-greenfield-orchestrator",
        maxContinues: 25,
        fleet: true,
      });
      writerDurationMs = fleetOutput.sessionTimeMs || 0;
      phaseOutputs.orchestrator = fleetOutput;
      exitCode = fleetOutput.exitCode;
    } else {
      // Standard: single orchestrator process with sequential sub-agent delegation
      console.log(chalk.hex("#555555")("  │ ") + chalk.hex("#FF8C00")("Session   ") + chalk.white("Single orchestrator"));
      console.log();

      const orchPrompt = buildOrchestrationPromptFromPlan(plan, mode);
      const orchOutput = await launchCopilotCli(tempDir, orchPrompt, { model, agent: "forge-greenfield-orchestrator" });
      phaseOutputs.orchestrator = orchOutput;
      exitCode = orchOutput.exitCode;
    }

    const phase2Duration = Date.now() - phase2Start;

    // Copy generated artifacts
    const installed = await installGeneratedArtifacts(tempDir, targetDir, plan.slug);
    cleanupGenerationWorkspace(tempDir).catch(() => {});

    // Phase 3: Validation
    console.log();
    console.log(chalk.hex("#FF8C00").bold("  ── Phase 3 · Validation ──────────────────────────────────"));
    const fixSpinner = ora("  Checking artifacts...").start();
    const report = await postGenerationValidateAndFix(targetDir);
    if (report.errors.length === 0) {
      fixSpinner.succeed(`  ${report.passed.length} files passed${report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : ""}`);
    } else {
      fixSpinner.warn(`  ${report.errors.length} error(s) remain after auto-fix`);
      for (const err of report.errors) {
        console.log(chalk.red(`    ✗ ${path.basename(err.file)}: ${err.message}`));
      }
    }

    // Results
    console.log();
    console.log(chalk.hex("#FF8C00").bold("  ── Results ───────────────────────────────────────────────"));

    if (exitCode === 0) {
      console.log();
      console.log(`  ${chalk.green.bold("✓")} ${chalk.white.bold("Generation complete")}`);
      console.log();
      // Aggregate real PRU from all phases
      const allOutputs: CliOutput[] = [planOutput, ...phaseOutputs.writers];
      if (phaseOutputs.instructions) allOutputs.push(phaseOutputs.instructions);
      if (phaseOutputs.orchestrator) allOutputs.push(phaseOutputs.orchestrator);
      const totalOutput = aggregateCliOutputs(allOutputs);

      const totalPru = totalOutput.premiumRequests;
      const estimatedPru = (speed === "turbo" ? plan.agents.length + 1 : 2) * multiplier;
      const pruLabel = totalPru > 0 ? `${totalPru} PRU` : `~${estimatedPru} PRU`;

      // Per-phase breakdown table
      const boxWidth = 57;
      const divider = "─".repeat(boxWidth);
      const bc = chalk.hex("#555555");
      console.log(bc(`  ┌${divider}┐`));
      console.log(bc("  │") + chalk.hex("#FF8C00").bold("  Phase".padEnd(18) + "Duration".padEnd(12) + "PRU".padEnd(8) + "Tokens".padEnd(19)) + bc("│"));
      console.log(bc(`  ├${divider}┤`));

      // Planning row
      const planDurStr = planOutput.apiTimeMs > 0 ? formatDuration(planOutput.apiTimeMs) : formatDuration(planOutput.sessionTimeMs || 0);
      const planPru = planOutput.premiumRequests > 0 ? chalk.white(String(planOutput.premiumRequests)) : chalk.dim("–");
      const planTokens = formatTokens(planOutput.tokenBreakdown) || chalk.dim("–");
      console.log(bc("  │") + `  ${vpad(chalk.white("Planning"), 16)}${vpad(chalk.cyan(planDurStr), 12)}${vpad(String(planPru), 8)}${vpad(String(planTokens), 19)}` + bc("│"));

      if (speed === "turbo") {
        if (phaseOutputs.orchestrator) {
          const oOut = phaseOutputs.orchestrator;
          const oDur = oOut.apiTimeMs > 0 ? formatDuration(oOut.apiTimeMs) : formatDuration(phase2Duration);
          const oPru = oOut.premiumRequests > 0 ? chalk.white(String(oOut.premiumRequests)) : chalk.dim("–");
          const oTokens = formatTokens(oOut.tokenBreakdown) || chalk.dim("–");
          console.log(bc("  │") + `  ${vpad(chalk.hex("#FFD700")("Fleet ⚡"), 16)}${vpad(chalk.cyan(oDur), 12)}${vpad(String(oPru), 8)}${vpad(String(oTokens), 19)}` + bc("│"));
        }
      } else {
        if (phaseOutputs.orchestrator) {
          const oOut = phaseOutputs.orchestrator;
          const oDur = oOut.apiTimeMs > 0 ? formatDuration(oOut.apiTimeMs) : formatDuration(phase2Duration);
          const oPru = oOut.premiumRequests > 0 ? chalk.white(String(oOut.premiumRequests)) : chalk.dim("–");
          const oTokens = formatTokens(oOut.tokenBreakdown) || chalk.dim("–");
          console.log(bc("  │") + `  ${vpad(chalk.white("Generation"), 16)}${vpad(chalk.cyan(oDur), 12)}${vpad(String(oPru), 8)}${vpad(String(oTokens), 19)}` + bc("│"));
        }
      }

      const totalDurStr = formatDuration(phase2Duration);
      const totalTokenStr = formatTokens(totalOutput.tokenBreakdown) || chalk.dim("–");
      console.log(bc(`  ├${divider}┤`));
      console.log(bc("  │") + `  ${vpad(chalk.white.bold("Total"), 16)}${vpad(chalk.cyan.bold(totalDurStr), 12)}${vpad(chalk.hex("#FFD700").bold(pruLabel), 8)}${vpad(String(totalTokenStr), 19)}` + bc("│"));
      console.log(bc(`  │${" ".repeat(boxWidth)}│`));
      console.log(bc("  │") + `  ${vpad(`${chalk.dim("Files")} ${chalk.white.bold(String(installed.length))}`, 23)}${vpad(`${chalk.dim("Model")} ${chalk.white.bold(model)}`, 32)}` + bc("│"));
      console.log(bc("  │") + `  ${vpad(`${chalk.dim("Speed")} ${chalk.white.bold(speed === "turbo" ? "Turbo (fleet)" : "Standard")}`, 55)}` + bc("│"));
      console.log(bc(`  └${divider}┘`));

      printGeneratedFiles(plan.slug, installed);
      console.log();
      console.log(`  ${chalk.hex("#FF8C00").bold("Next steps")}`);
      console.log(`    ${chalk.hex("#FF8C00")("1.")} Open Copilot Chat ${chalk.dim("⌘⇧I / Ctrl+Shift+I")}`);
      console.log(`    ${chalk.hex("#FF8C00")("2.")} Select agent: ${chalk.cyan(`@${plan.agents[0]?.title || plan.title}`)}`);
      if (plan.prompt?.slug) {
        console.log(`    ${chalk.hex("#FF8C00")("3.")} Or use slash command: ${chalk.cyan(`/${plan.prompt.slug}`)}`);
      }
      if (plan.agents.length > 1) {
        console.log();
        console.log(`  ${chalk.hex("#FF8C00").bold("Available agents")}`);
        for (const agent of plan.agents) {
          console.log(`    ${chalk.cyan(`@${agent.title}`)} ${chalk.dim("—")} ${chalk.white(agent.role)}`);
        }
        console.log(chalk.dim("    Handoff buttons let you transition between agents."));
      }
      console.log();
      console.log(chalk.dim("  Tip: Run 'forge validate' to verify all files pass VS Code spec checks."));
      console.log();
    } else {
      console.log();
      console.log(chalk.yellow("⚠  Generation finished with warnings. Review the generated files."));
    }
  } catch (error) {
    spinner.fail("Failed to generate");
    console.error(chalk.red(String(error)));
    process.exit(1);
  }
}

function printGeneratedFiles(_slug: string, files: string[]): void {
  const githubFiles = files.filter((f) => !f.startsWith(".vscode/"));
  const vscodeFiles = files.filter((f) => f.startsWith(".vscode/"));
  const tc = chalk.hex("#555555");

  if (githubFiles.length > 0) {
    console.log();
    console.log(`  ${chalk.hex("#FF8C00").bold(".github/")}`);
    for (let i = 0; i < githubFiles.length; i++) {
      const prefix = i === githubFiles.length - 1 && vscodeFiles.length === 0 ? "└──" : "├──";
      console.log(tc(`    ${prefix} `) + chalk.white(githubFiles[i]));
    }
  }

  if (vscodeFiles.length > 0) {
    console.log();
    console.log(`  ${chalk.hex("#FF8C00").bold(".vscode/")}`);
    for (let i = 0; i < vscodeFiles.length; i++) {
      const name = vscodeFiles[i].replace(".vscode/", "");
      const prefix = i === vscodeFiles.length - 1 ? "└──" : "├──";
      console.log(tc(`    ${prefix} `) + chalk.white(name));
    }
  }
}

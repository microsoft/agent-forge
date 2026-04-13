import chalk from "chalk";
import ora from "ora";
import {
  prepareGenerationWorkspace,
  installGeneratedArtifacts,
  cleanupGenerationWorkspace,
  readPlanFile,
  readPlanMarkdown,
  prepareWorkspaceForPlan,
  injectModelIntoWriterAgents,
} from "../lib/scaffold.js";
import {
  launchCopilotCli,
  selectModel,
  formatDuration,
  formatTokens,
  aggregateCliOutputs,
} from "../lib/copilot-cli.js";
import type { CliOutput } from "../lib/copilot-cli.js";
import {
  buildPlanningPrompt,
  buildFleetOrchestrationPrompt,
} from "../lib/prompt-builder.js";
import { animateLogo } from "./init.js";
import { postGenerationValidateAndFix } from "../lib/validator.js";
import path from "path";
import type { GenerateOptions } from "../types.js";

/** Strip ANSI escape codes to get visual length */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Count extra visual columns for wide characters (emoji, CJK, etc.) */
function extraVisualWidth(str: string): number {
  const emojiPattern = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1FA00}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u26a1]/gu;
  const matches = str.match(emojiPattern);
  return matches ? matches.length : 0;
}

/** Pad a string to a visual width, accounting for ANSI escape codes and wide characters */
function vpad(str: string, width: number): string {
  const plain = stripAnsi(str);
  const visual = plain.length + extraVisualWidth(plain);
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
      plan: true,
    });

    if (planOutput.exitCode !== 0) {
      console.log(chalk.yellow("\n  ⚠  Planner exited with warnings."));
    }

    // Read the plan
    const planSpinner = ora("Reading plan...").start();
    const plan = await readPlanFile(tempDir);
    planSpinner.succeed(`Plan ready — ${plan.agents.length} agent(s): ${plan.agents.map((a) => a.name).join(", ")}`);

    // Show the human-readable plan with syntax coloring
    const planMd = await readPlanMarkdown(tempDir);
    if (planMd) {
      console.log();
      const planBorder = chalk.hex("#555555");
      for (const line of planMd.trimEnd().split("\n")) {
        let colored: string;
        if (/^# /.test(line)) {
          colored = chalk.hex("#FF8C00").bold(line.replace(/^# /, ""));
        } else if (/^## /.test(line)) {
          colored = chalk.hex("#FF8C00")(line);
        } else if (/^\|[-|:\s]+$/.test(line)) {
          colored = chalk.hex("#555555")(line);
        } else if (/^\|/.test(line)) {
          colored = chalk.dim(line);
        } else if (/^- \*\*/.test(line)) {
          colored = line.replace(/\*\*([^*]+)\*\*/g, (_, m) => chalk.white.bold(m));
        } else if (/^\s*$/.test(line)) {
          colored = "";
        } else {
          colored = chalk.white(line);
        }
        console.log(planBorder("  │ ") + colored);
      }
    } else {
      // Fallback: compact summary from JSON
      const pattern = plan.orchestrationPattern ?? "flat";
      console.log(chalk.hex("#555555")("  │ ") + chalk.hex("#FF8C00")("Pattern   ") + chalk.white(pattern));
      console.log();
      for (const a of plan.agents) {
        let tech = a.techStack.length > 0 ? a.techStack.slice(0, 4).join(", ") : "general";
        if (tech.length > 20) tech = tech.slice(0, 18) + "..";
        const roleTag = a.agentRole === "orchestrator" ? chalk.hex("#FFD700")(" ⚡orchestrator") : a.agentRole === "subagent" ? chalk.dim(" (subagent)") : "";
        console.log(chalk.hex("#555555")("  │ ") + chalk.cyan(a.name.padEnd(18)) + chalk.dim(tech.padEnd(22)) + chalk.white(a.applyToGlob) + roleTag);
      }
    }
    console.log();

    // Prepare workspace directories for Phase 2
    await prepareWorkspaceForPlan(tempDir, plan);

    // Inject user-selected model into writer agents so /fleet subagents use it instead of the low-cost default
    await injectModelIntoWriterAgents(tempDir, model);

    // Phase 2: Generate artifacts (fleet mode — parallel subagents)
    console.log();
    console.log(chalk.hex("#FF8C00").bold("  ── Phase 2 · Generating (Fleet ⚡) " + "─".repeat(23)));

    let exitCode: number;
    const phase2Start = Date.now();
    let writerDurationMs = 0;
    const phaseOutputs: { planning: CliOutput; writers: CliOutput[]; instructions?: CliOutput; orchestrator?: CliOutput } = {
      planning: planOutput,
      writers: [],
    };

    // Fleet: single session with /fleet — Copilot CLI delegates to writer subagents in parallel
    const fleetPrompt = buildFleetOrchestrationPrompt(plan, mode, model);
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

    const phase2Duration = Date.now() - phase2Start;

    // Copy generated artifacts
    const installed = await installGeneratedArtifacts(tempDir, targetDir, plan.slug);
    cleanupGenerationWorkspace(tempDir).catch(() => {});

    // Show what was generated
    if (installed.length === 0) {
      console.log(`  ${chalk.red("✗")} ${chalk.red.bold("No files were generated")} — the fleet orchestrator may have failed`);
      console.log(chalk.dim("    Check the Copilot CLI output above for errors."));
      process.exit(1);
    }
    console.log(`  ${chalk.green("✓")} ${chalk.white.bold(`${installed.length} files generated`)}`);
    const tc = chalk.hex("#555555");
    for (let i = 0; i < installed.length; i++) {
      const prefix = i === installed.length - 1 ? "└──" : "├──";
      console.log(tc(`    ${prefix} `) + chalk.white(installed[i]));
    }

    // Phase 3: Validation
    console.log();
    console.log(chalk.hex("#FF8C00").bold("  ── Phase 3 · Validation ──────────────────────────────────"));
    const fixSpinner = ora("  Checking artifacts...").start();
    const report = await postGenerationValidateAndFix(targetDir);
    fixSpinner.stop();

    // Show auto-fixes applied
    if (report.autoFixed && report.autoFixed.length > 0) {
      console.log(`  ${chalk.green("✓")} Auto-fixed ${report.autoFixed.length} issue(s):`);
      for (const fix of report.autoFixed) {
        console.log(chalk.dim(`    ↻ ${fix.file}: ${fix.action}`));
      }
      console.log();
    }

    // Show validation results with full detail
    if (report.errors.length === 0 && report.warnings.length === 0) {
      console.log(`  ${chalk.green("✓")} ${report.passed.length} files passed — all checks clean`);
    } else if (report.errors.length === 0) {
      console.log(`  ${chalk.green("✓")} ${report.passed.length} files passed, ${chalk.yellow(`${report.warnings.length} warning(s)`)}`);
      for (const w of report.warnings) {
        console.log(chalk.yellow(`    ⚠ ${path.basename(w.file)}: ${w.message}`));
      }
    } else {
      console.log(`  ${chalk.red("✗")} ${report.errors.length} error(s) remain after auto-fix`);
      for (const err of report.errors) {
        console.log(chalk.red(`    ✗ ${path.basename(err.file)}: ${err.message}`));
      }
      for (const w of report.warnings) {
        console.log(chalk.yellow(`    ⚠ ${path.basename(w.file)}: ${w.message}`));
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
      const pruLabel = totalPru > 0 ? `${totalPru} PRU` : `~2 PRU`;

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

      if (phaseOutputs.orchestrator) {
        const oOut = phaseOutputs.orchestrator;
        const oDur = oOut.apiTimeMs > 0 ? formatDuration(oOut.apiTimeMs) : formatDuration(phase2Duration);
        const oPru = oOut.premiumRequests > 0 ? chalk.white(String(oOut.premiumRequests)) : chalk.dim("–");
        const oTokens = formatTokens(oOut.tokenBreakdown) || chalk.dim("–");
        console.log(bc("  │") + `  ${vpad(chalk.hex("#FFD700")("Fleet ⚡"), 16)}${vpad(chalk.cyan(oDur), 12)}${vpad(String(oPru), 8)}${vpad(String(oTokens), 19)}` + bc("│"));
      }

      const totalDurStr = formatDuration(phase2Duration);
      const totalTokenStr = formatTokens(totalOutput.tokenBreakdown) || chalk.dim("–");
      console.log(bc(`  ├${divider}┤`));
      console.log(bc("  │") + `  ${vpad(chalk.white.bold("Total"), 16)}${vpad(chalk.cyan.bold(totalDurStr), 12)}${vpad(chalk.hex("#FFD700").bold(pruLabel), 8)}${vpad(String(totalTokenStr), 19)}` + bc("│"));
      console.log(bc(`  │${" ".repeat(boxWidth)}│`));
      console.log(bc("  │") + `  ${vpad(`${chalk.dim("Files")} ${chalk.white.bold(String(installed.length))}`, 23)}${vpad(`${chalk.dim("Model")} ${chalk.white.bold(model)}`, 32)}` + bc("│"));
      console.log(bc("  │") + `  ${vpad(`${chalk.dim("Speed")} ${chalk.white.bold("Fleet ⚡")}`, 55)}` + bc("│"));
      console.log(bc(`  └${divider}┘`));

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
      if (report.fixableCount > 0) {
        console.log(chalk.dim(`  Tip: Run 'forge validate --fix' to auto-fix ${report.fixableCount} remaining issue(s) with AI.`));
      }
      console.log();
    } else {
      console.log();
      console.log(chalk.yellow("⚠  Generation finished with warnings. Review the generated files."));
    }

    // Exit with error code if validation found errors
    if (report.errors.length > 0) {
      process.exit(1);
    }
  } catch (error) {
    spinner.fail("Failed to generate");
    console.error(chalk.red(String(error)));
    process.exit(1);
  }
}



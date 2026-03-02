import { select, checkbox, input, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import path from "path";
import fs from "fs-extra";
import {
  installGalleryUseCase,
  prepareGenerationWorkspace,
  installGeneratedArtifacts,
  cleanupGenerationWorkspace,
  readPlanFile,
  prepareWorkspaceForPlan,
  injectModelIntoWriterAgents,
} from "../lib/scaffold.js";
import { getGallery } from "../lib/gallery.js";
import { detectWorkspace } from "../lib/detector.js";
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
import { postGenerationValidateAndFix } from "../lib/validator.js";
import {
  checkPrerequisites,
  formatPrerequisiteResults,
  hasBlockingFailures,
  hasWarnings,
  printMissingInstallGuide,
} from "../lib/prerequisites.js";
import type { InitOptions, InitMode, AnalyzeStrategy, GenerationMode, AgentDesignPattern, WorkspaceInfo } from "../types.js";

// ── Side-by-side AGENT-FORGE block art (6 rows) ───────────────────────
const BANNER_ROWS = [
  "   █████╗  ██████╗ ███████╗███╗   ██╗████████╗    ███████╗ ██████╗  ██████╗  ██████╗ ███████╗",
  "  ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝    ██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝",
  "  ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║       █████╗  ██║   ██║██████╔╝██║  ███╗█████╗  ",
  "  ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║       ██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝  ",
  "  ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║       ██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗",
  "  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝       ╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
];
const BANNER_COLORS = ["#FF8C00", "#FF7B00", "#FF6A00", "#FF5900", "#FF4800", "#FF3700"];
const TAGLINE = "  AI-Native Context Kit for GitHub Copilot-Driven Development";

/** Static logo for non-TTY / piped output */
export const LOGO = "\n" + BANNER_ROWS.map((r, i) => chalk.hex(BANNER_COLORS[i])(r)).join("\n") + "\n" + chalk.dim(TAGLINE) + "\n\n";

/** Pixel-reveal animation — characters appear at random positions until the banner materializes */
export async function animateLogo(): Promise<void> {
  // Fallback: if not a TTY, just print static
  if (!process.stdout.isTTY) {
    console.log(LOGO);
    return;
  }

  const rows = BANNER_ROWS.length;
  const cols = Math.max(...BANNER_ROWS.map((r) => r.length));
  const clearEol = "\x1b[K";
  const hideCursor = "\x1b[?25l";
  const showCursor = "\x1b[?25h";

  // Build 2D grid starting as all spaces
  const grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill(" "));

  // Collect positions of non-space characters to animate
  const positions: { r: number; c: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < BANNER_ROWS[r].length; c++) {
      if (BANNER_ROWS[r][c] !== " ") {
        positions.push({ r, c });
      }
    }
  }

  // Fisher-Yates shuffle
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }

  // Reserve vertical space (top margin + banner rows + tagline + bottom margin)
  const totalLines = rows + 3;
  process.stdout.write(hideCursor + "\n".repeat(totalLines));

  // Build a single frame string and write it atomically (no flicker)
  const render = () => {
    let frame = `\x1b[${totalLines}A`; // cursor up to top of reserved space
    frame += clearEol + "\n"; // top margin
    for (let r = 0; r < rows; r++) {
      frame += chalk.hex(BANNER_COLORS[r])(grid[r].join("")) + clearEol + "\n";
    }
    frame += chalk.dim(TAGLINE) + clearEol + "\n";
    frame += clearEol + "\n"; // bottom margin
    process.stdout.write(frame);
  };

  // Reveal in ~15 steps over ~1 second
  const steps = 15;
  const batchSize = Math.ceil(positions.length / steps);
  const frameDelay = 65;

  for (let i = 0; i < positions.length; i += batchSize) {
    const batch = positions.slice(i, i + batchSize);
    for (const { r, c } of batch) {
      grid[r][c] = BANNER_ROWS[r][c];
    }
    render();
    await new Promise((resolve) => setTimeout(resolve, frameDelay));
  }

  // Final complete render
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < BANNER_ROWS[r].length; c++) {
      grid[r][c] = BANNER_ROWS[r][c];
    }
  }
  render();
  process.stdout.write(showCursor);
}

// ── UI helpers ─────────────────────────────────────────────────────────

const ACCENT = "#FF8C00";
const ACCENT2 = "#FF6A00";
const DIM_BORDER = "#555555";

/** Strip ANSI escape codes to get visual length */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Count extra visual columns for wide characters (emoji, CJK, etc.) */
function extraVisualWidth(str: string): number {
  // Match emoji sequences (including ZWJ, skin tones, flags) that occupy 2 columns
  const emojiPattern = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1FA00}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}⚡]/gu;
  const matches = str.match(emojiPattern);
  return matches ? matches.length : 0;
}

/** Pad a string to a visual width, accounting for ANSI escape codes and wide characters */
function vpad(str: string, width: number): string {
  const plain = stripAnsi(str);
  const visual = plain.length + extraVisualWidth(plain);
  return str + " ".repeat(Math.max(0, width - visual));
}

/** Print a section header with accent line */
function sectionHeader(label: string, width = 58): void {
  const line = "─".repeat(Math.max(0, width - label.length - 5));
  console.log();
  console.log(chalk.hex(ACCENT).bold(`  ── ${label} ${line}`));
  console.log();
}

/** Print a key-value detail line inside a section */
function detail(key: string, value: string): void {
  console.log(chalk.hex(DIM_BORDER)("  │ ") + chalk.hex(ACCENT)(key.padEnd(10)) + chalk.white(value));
}

/** Prompt user to select agent design pattern (standalone vs subagent) */
async function selectAgentDesignPattern(options: InitOptions): Promise<AgentDesignPattern> {
  if (options.agentDesignPattern) return options.agentDesignPattern;
  return await select<AgentDesignPattern>({
    message: "Agent design pattern:",
    choices: [
      {
        value: "auto" as AgentDesignPattern,
        name: `${chalk.green("Auto")}          ${chalk.dim("— AI decides the best pattern based on your description")} ${chalk.green("(recommended)")}`,
      },
      {
        value: "standalone" as AgentDesignPattern,
        name: `${chalk.white("Standalone")}    ${chalk.dim("— Independent agents with handoffs between them")}`,
      },
      {
        value: "subagent" as AgentDesignPattern,
        name: `${chalk.hex("#FFD700")("Subagent")}      ${chalk.dim("— Coordinator orchestrator + worker subagents (saves PRU)")} ${chalk.hex("#FFD700")("⚡")}`,
      },
    ],
    default: "auto",
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════

export async function initCommand(
  options: InitOptions,
): Promise<void> {
  await animateLogo();

  // ── Prerequisite check ───────────────────────────────────────────────
  if (!options.skipCheck) {
    const isTemplatesOnly = options.mode === "templates";
    const results = checkPrerequisites();

    // For --mode templates, relax the Copilot CLI requirement
    const effectiveResults = isTemplatesOnly
      ? results.map((r) =>
          r.name === "GitHub Copilot CLI" ? { ...r, category: "optional" as const } : r,
        )
      : results;

    console.log(chalk.bold("  Checking prerequisites...\n"));
    formatPrerequisiteResults(effectiveResults);
    console.log();

    if (hasBlockingFailures(effectiveResults)) {
      console.log(chalk.red.bold("  ✗ Missing required tools — install them before continuing."));
      printMissingInstallGuide(effectiveResults);
      console.log();
      console.log(chalk.dim("  Tip: run ") + chalk.cyan("forge check") + chalk.dim(" to re-verify after installing."));
      console.log();
      process.exit(1);
    }

    if (hasWarnings(effectiveResults)) {
      printMissingInstallGuide(effectiveResults);
      console.log();
      const proceed = await confirm({
        message: "Some recommended tools are missing. Continue anyway?",
        default: true,
      });
      if (!proceed) {
        console.log(chalk.dim("\n  Aborted. Install the missing tools and re-run forge init.\n"));
        process.exit(0);
      }
    } else {
      console.log(chalk.green.bold("  ✓ All prerequisites met"));
    }

    console.log();
  }

  const mode: InitMode = options.mode ?? await select({
    message: "What would you like to do?",
    choices: [
      {
        value: "create" as InitMode,
        name: `${chalk.hex(ACCENT).bold("Create")}      ${chalk.dim("— Design a new Copilot workspace from a description")}`,
      },
      {
        value: "analyze" as InitMode,
        name: `${chalk.hex(ACCENT2).bold("Analyze")}     ${chalk.dim("— Scan an existing project and generate configurations")}`,
      },
      {
        value: "templates" as InitMode,
        name: `${chalk.cyan.bold("Templates")}   ${chalk.dim("— Install pre-built configurations from the catalog")}`,
      },
    ],
  });

  switch (mode) {
    case "create":
      await handleCreate(options);
      break;
    case "analyze":
      await handleAnalyze(process.cwd(), options);
      break;
    case "templates":
      await handleTemplates(process.cwd(), options);
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  PATH 1: CREATE
// ═══════════════════════════════════════════════════════════════════════

async function handleCreate(options: InitOptions): Promise<void> {
  sectionHeader("Create");

  // Agent design pattern selection
  const pattern = await selectAgentDesignPattern(options);

  const description = options.description ?? await input({
    message: "Describe your use case:",
    validate: (v) => v.trim() ? true : "Please enter a use case description",
  });

  const targetDir = process.cwd();

  await runGeneration(targetDir, description, "full", options, undefined, "greenfield", pattern);

  console.log();
  console.log(`  ${chalk.hex(ACCENT).bold("Get started")}`);
  console.log(`    ${chalk.hex(ACCENT)("1.")} Open Copilot Chat ${chalk.dim("⌘⇧I / Ctrl+Shift+I")}`);
  console.log();
}

// ═══════════════════════════════════════════════════════════════════════
//  PATH 2: ANALYZE
// ═══════════════════════════════════════════════════════════════════════

async function handleAnalyze(
  targetDir: string,
  options: InitOptions,
): Promise<void> {
  sectionHeader("Analyze");

  // Always scan first
  const spinner = ora("Scanning workspace...").start();
  const workspace = await detectWorkspace(targetDir);
  spinner.succeed("Workspace scanned");

  // Boxed project summary
  printProjectSummary(workspace);

  // Strategy selection
  const strategy: AnalyzeStrategy = options.analyzeStrategy ?? await select<AnalyzeStrategy>({
    message: "How would you like to proceed?",
    choices: [
      {
        value: "auto" as AnalyzeStrategy,
        name: `${chalk.green("Auto-generate")}  ${chalk.dim("— Generate everything based on scan results")} ${chalk.green("(recommended)")}`,
      },
      {
        value: "guided" as AnalyzeStrategy,
        name: `${chalk.white("Guided")}         ${chalk.dim("— Add custom requirements on top of scan results")}`,
      },
    ],
    default: "auto",
  });

  // ── Early exit: comprehensive customizations already present ────────
  const existingCount =
    workspace.existingAgents.length +
    workspace.existingInstructions.length +
    workspace.existingPrompts.length +
    workspace.existingSkills.length;

  if (strategy === "auto" && existingCount >= 3 && workspace.existingAgents.length >= 2) {
    // The project already has substantial Copilot customizations — nothing useful to auto-generate
    console.log(
      chalk.green.bold("  ✓ ") +
      chalk.white.bold("This project already has comprehensive Copilot customizations"),
    );
    console.log();
    const summary: string[] = [];
    if (workspace.existingAgents.length > 0) summary.push(`${workspace.existingAgents.length} agent(s)`);
    if (workspace.existingInstructions.length > 0) summary.push(`${workspace.existingInstructions.length} instruction(s)`);
    if (workspace.existingPrompts.length > 0) summary.push(`${workspace.existingPrompts.length} prompt(s)`);
    if (workspace.existingSkills.length > 0) summary.push(`${workspace.existingSkills.length} skill(s)`);
    if (workspace.existingHooks.length > 0) summary.push(`${workspace.existingHooks.length} hook(s)`);
    if (workspace.existingWorkflows.length > 0) summary.push(`${workspace.existingWorkflows.length} workflow(s)`);
    console.log(chalk.dim(`    Found: ${summary.join(", ")}`));
    console.log();
    console.log(chalk.dim("  Tip: use ") + chalk.cyan("forge init --mode analyze --strategy guided") + chalk.dim(" to add custom requirements on top of existing customizations."));
    console.log(chalk.dim("       use ") + chalk.cyan("forge validate") + chalk.dim(" to check the health of your existing files."));
    console.log();
    return;
  }

  let description: string;
  let generationMode: GenerationMode;

  if (strategy === "auto") {
    // Auto-derive description from workspace — no user prompt
    description = buildDiscoveryDescription(workspace);
    generationMode = "discovery";
    console.log(chalk.dim(`\n  Auto-detected: ${description}`));
  } else {
    // Guided — prompt for additional requirements
    const requirements = options.description ?? await input({
      message: "Describe additional requirements:",
      validate: (v) => v.trim() ? true : "Please enter additional requirements",
    });

    const techDesc = workspace.techStack.length > 0
      ? ` This is a ${workspace.projectType ?? "software"} project using ${workspace.techStack.join(", ")}.`
      : "";
    description = requirements + techDesc;
    generationMode = "full";
  }

  await runGeneration(targetDir, description, generationMode, options, workspace, "brownfield", options.agentDesignPattern ?? "auto");
  printNextSteps();
}

/** Render workspace scan results in a boxed summary */
function printProjectSummary(workspace: WorkspaceInfo): void {
  const items: Array<[string, string]> = [];

  if (workspace.techStack.length > 0) {
    items.push(["Stack", workspace.techStack.join(", ")]);
  }
  if (workspace.projectType) {
    items.push(["Type", workspace.projectType]);
  }

  // Existing customizations
  const counts: string[] = [];
  if (workspace.existingAgents.length > 0) counts.push(`${workspace.existingAgents.length} agents`);
  if (workspace.existingPrompts.length > 0) counts.push(`${workspace.existingPrompts.length} prompts`);
  if (workspace.existingInstructions.length > 0) counts.push(`${workspace.existingInstructions.length} instructions`);
  if (workspace.existingSkills.length > 0) counts.push(`${workspace.existingSkills.length} skills`);
  if (workspace.existingHooks.length > 0) counts.push(`${workspace.existingHooks.length} hooks`);
  if (workspace.existingWorkflows.length > 0) counts.push(`${workspace.existingWorkflows.length} workflows`);

  if (counts.length > 0) {
    items.push(["Existing", counts.join(" · ")]);
  }

  if (items.length === 0) {
    console.log(chalk.dim("  No project files detected.\n"));
    return;
  }

  // Compute box width
  const maxValueLen = Math.max(...items.map(([k, v]) => k.length + v.length + 4));
  const boxWidth = Math.max(maxValueLen + 6, 48);

  console.log();
  console.log(chalk.hex(ACCENT)(`  ┌─ Project Summary ${"─".repeat(Math.max(0, boxWidth - 20))}┐`));
  for (const [key, val] of items) {
    const content = `  ${chalk.bold(key + ":")}  ${val}`;
    // We need to measure the raw (no-ANSI) length for padding
    const rawLen = `  ${key}:  ${val}`.length;
    const pad = Math.max(0, boxWidth - rawLen);
    console.log(chalk.hex(ACCENT)("  │") + content + " ".repeat(pad) + chalk.hex(ACCENT)("│"));
  }
  console.log(chalk.hex(ACCENT)(`  └${"─".repeat(boxWidth + 1)}┘`));
  console.log();
}

// ═══════════════════════════════════════════════════════════════════════
//  PATH 3: TEMPLATES
// ═══════════════════════════════════════════════════════════════════════

async function handleTemplates(
  targetDir: string,
  options: InitOptions,
): Promise<void> {
  sectionHeader("Templates");

  const gallery = getGallery();
  let selectedIds: string[];

  if (options.useCases) {
    selectedIds = options.useCases;
  } else {
    selectedIds = await checkbox({
      message: "Select configurations to install:",
      choices: gallery.map((entry) => ({
        value: entry.id,
        name: `${chalk.white(entry.name.padEnd(28))} ${chalk.dim("— " + entry.description)}`,
        checked: false,
      })),
    });
  }

  if (selectedIds.length === 0) {
    console.log(chalk.yellow("  No templates selected."));
    return;
  }

  console.log();
  let installed = 0;
  for (const id of selectedIds) {
    const entry = gallery.find((g) => g.id === id);
    const ucSpinner = ora(`Installing ${entry?.name ?? id}...`).start();
    try {
      const result = await installGalleryUseCase(targetDir, id, { force: options.force });
      ucSpinner.succeed(`${entry?.name ?? id} ${chalk.dim(`(${result.copied.length} files)`)}`);
      installed++;
    } catch {
      ucSpinner.fail(`Failed to install ${id}`);
    }
  }

  console.log();
  if (installed > 0) {
    console.log(`  ${chalk.green.bold("✓")} ${chalk.bold(String(installed))} template${installed !== 1 ? "s" : ""} installed successfully`);
  }
  printNextSteps();
}

// ═══════════════════════════════════════════════════════════════════════
//  SHARED GENERATION PIPELINE
// ═══════════════════════════════════════════════════════════════════════

async function runGeneration(
  targetDir: string,
  description: string,
  generationMode: GenerationMode,
  options: InitOptions,
  workspace?: WorkspaceInfo,
  pipeline: "greenfield" | "brownfield" = "greenfield",
  agentDesignPattern: AgentDesignPattern = "auto",
): Promise<void> {
  // Model selection
  const model = options.model ?? await selectModel();

  // Prepare workspace
  const spinner = ora("Preparing workspace...").start();
  const { tempDir, slug, title, domains } = await prepareGenerationWorkspace(description, generationMode, pipeline, pipeline === "brownfield" ? targetDir : undefined);
  spinner.succeed("Workspace ready");

  const pipelineLabel = pipeline === "brownfield" ? "Analyze" : "Create";
  const plannerAgent = pipeline === "brownfield" ? "forge-brownfield-planner" : "forge-greenfield-planner";
  const orchestratorAgent = pipeline === "brownfield" ? "forge-brownfield-orchestrator" : "forge-greenfield-orchestrator";

  // ── Phase 1: Planning ──────────────────────────────────────────────
  sectionHeader("Phase 1 · Planning");
  detail("Pipeline", pipelineLabel);
  detail("Model", model);
  if (agentDesignPattern !== "auto") {
    detail("Pattern", agentDesignPattern === "subagent" ? "Subagent (coordinator-worker)" : "Standalone (handoffs)");
  }
  if (domains.length > 1) {
    detail("Domains", domains.map((d) => d.title).join(", "));
  }
  console.log();

  const planPrompt = buildPlanningPrompt(generationMode, slug, title, description, domains, workspace, undefined, agentDesignPattern);
  const planOutput = await launchCopilotCli(tempDir, planPrompt, {
    model,
    agent: plannerAgent,
    maxContinues: 15,
  });

  if (planOutput.exitCode !== 0) {
    console.log(chalk.yellow("\n  ⚠  Planner exited with warnings."));
  }

  const planSpinner = ora("Reading plan...").start();
  const plan = await readPlanFile(tempDir);
  planSpinner.succeed(`Plan ready — ${plan.agents.length} agent(s): ${plan.agents.map((a) => a.name).join(", ")}`);

  await prepareWorkspaceForPlan(tempDir, plan);

  // Inject user-selected model into writer agents so /fleet subagents use it instead of the low-cost default
  await injectModelIntoWriterAgents(tempDir, model);

  // ── Phase 2: Generating ────────────────────────────────────────────
  sectionHeader("Phase 2 · Generating (Fleet ⚡)");

  let exitCode: number;
  const phase2Start = Date.now();
  let writerDurationMs = 0;
  /** Collect all CliOutputs for accurate PRU tracking */
  const phaseOutputs: { planning: CliOutput; writers: CliOutput[]; instructions?: CliOutput; orchestrator?: CliOutput } = {
    planning: planOutput,
    writers: [],
  };

  // Fleet mode: single session with /fleet — Copilot CLI delegates to writer subagents in parallel
  const fleetPrompt = buildFleetOrchestrationPrompt(plan, generationMode, model);

  detail("Mode", "Fleet (parallel subagents)");
  console.log();

  const fleetOutput = await launchCopilotCli(tempDir, fleetPrompt, {
    model,
    agent: orchestratorAgent,
    maxContinues: 25,
    fleet: true,
  });
  writerDurationMs = fleetOutput.sessionTimeMs || 0;
  phaseOutputs.orchestrator = fleetOutput;
  exitCode = fleetOutput.exitCode;

  const phase2Duration = Date.now() - phase2Start;

  const installed = await installGeneratedArtifacts(tempDir, targetDir, plan.slug);
  cleanupGenerationWorkspace(tempDir).catch(() => {});

  // ── Phase 3: Validation ────────────────────────────────────────────
  sectionHeader("Phase 3 · Validation");
  const fixSpinner = ora("  Checking artifacts...").start();
  const report = await postGenerationValidateAndFix(targetDir);
  if (report.errors.length === 0 && report.warnings.length === 0) {
    fixSpinner.succeed(`  ${report.passed.length} files passed — all checks clean`);
  } else if (report.errors.length === 0) {
    fixSpinner.succeed(`  ${report.passed.length} files passed, ${report.warnings.length} warning(s)`);
    for (const w of report.warnings) {
      const fileName = path.basename(w.file);
      console.log(chalk.dim(`    ⚠ ${fileName}: ${w.message}`));
    }
  } else {
    fixSpinner.warn(`  ${report.errors.length} error(s) remain after auto-fix`);
    for (const e of report.errors) {
      const fileName = path.basename(e.file);
      console.log(chalk.red(`    ✗ ${fileName}: ${e.message}`));
    }
    for (const w of report.warnings) {
      const fileName = path.basename(w.file);
      console.log(chalk.dim(`    ⚠ ${fileName}: ${w.message}`));
    }
  }

  // ── Results ────────────────────────────────────────────────────────
  sectionHeader("Results");

  if (exitCode === 0) {
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
    // Use a row helper that pads the ENTIRE row to boxWidth, guaranteeing right-border alignment
    const boxWidth = 64;
    const divider = "─".repeat(boxWidth);
    const bc = chalk.hex(DIM_BORDER);

    /** Build a table row with right-border aligned to boxWidth */
    const row = (content: string): string => {
      const plain = stripAnsi(content);
      const visual = plain.length + extraVisualWidth(plain);
      const pad = Math.max(0, boxWidth - visual);
      return bc("  │") + content + " ".repeat(pad) + bc("│");
    };

    console.log(bc(`  ┌${divider}┐`));
    console.log(row(
      chalk.hex(ACCENT).bold("  Phase") + "         " +
      chalk.hex(ACCENT).bold("Duration") + "    " +
      chalk.hex(ACCENT).bold("PRU") + "     " +
      chalk.hex(ACCENT).bold("Tokens"),
    ));
    console.log(bc(`  ├${divider}┤`));

    // Planning row
    const planDurStr = planOutput.apiTimeMs > 0 ? formatDuration(planOutput.apiTimeMs) : formatDuration(planOutput.sessionTimeMs || 0);
    const planPruStr = planOutput.premiumRequests > 0 ? String(planOutput.premiumRequests) : "–";
    const planTokenStr = formatTokens(planOutput.tokenBreakdown) || "–";
    console.log(row(`  ${chalk.white("Planning".padEnd(14))}${chalk.cyan(planDurStr.padEnd(12))}${chalk.white(planPruStr.padEnd(8))}${chalk.dim(planTokenStr)}`));

    if (phaseOutputs.orchestrator) {
      const oOut = phaseOutputs.orchestrator;
      const oDurStr = oOut.apiTimeMs > 0 ? formatDuration(oOut.apiTimeMs) : formatDuration(phase2Duration);
      const oPruStr = oOut.premiumRequests > 0 ? String(oOut.premiumRequests) : "–";
      const oTokenStr = formatTokens(oOut.tokenBreakdown) || "–";
      console.log(row(`  ${chalk.hex("#FFD700")("Fleet ⚡".padEnd(14))}${chalk.cyan(oDurStr.padEnd(12))}${chalk.white(oPruStr.padEnd(8))}${chalk.dim(oTokenStr)}`));
    }

    // Total row
    const totalDurStr = formatDuration(phase2Duration);
    const totalTokenStr = formatTokens(totalOutput.tokenBreakdown) || "–";
    console.log(bc(`  ├${divider}┤`));
    console.log(row(`  ${chalk.white.bold("Total".padEnd(14))}${chalk.cyan.bold(totalDurStr.padEnd(12))}${chalk.hex("#FFD700").bold(pruLabel.padEnd(8))}${chalk.dim(totalTokenStr)}`));
    console.log(row(""));
    console.log(row(`  ${chalk.dim("Files")} ${chalk.white.bold(String(installed.length))}${" ".repeat(13)}${chalk.dim("Model")} ${chalk.white.bold(model)}`));
    console.log(row(`  ${chalk.dim("Speed")} ${chalk.white.bold("Fleet ⚡")}`));
    console.log(bc(`  └${divider}┘`));

    printGeneratedFiles(plan.slug, installed);
  } else {
    console.log(chalk.yellow("  ⚠  Generation finished with warnings. Review the generated files."));
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════

function buildDiscoveryDescription(workspace: WorkspaceInfo): string {
  const parts: string[] = [];

  if (workspace.projectType) {
    parts.push(`${workspace.projectType} project`);
  } else {
    parts.push("software project");
  }

  if (workspace.techStack.length > 0) {
    parts.push(`using ${workspace.techStack.join(", ")}`);
  }

  const existing: string[] = [];
  if (workspace.existingAgents.length > 0) existing.push(`${workspace.existingAgents.length} agents`);
  if (workspace.existingInstructions.length > 0) existing.push(`${workspace.existingInstructions.length} instructions`);
  if (workspace.existingPrompts.length > 0) existing.push(`${workspace.existingPrompts.length} prompts`);
  if (workspace.existingSkills.length > 0) existing.push(`${workspace.existingSkills.length} skills`);

  let desc = `Copilot readiness for ${parts.join(" ")}`;

  if (existing.length > 0) {
    desc += `. Already has: ${existing.join(", ")}. Generate complementary customizations that don't duplicate existing ones`;
  } else {
    desc += `. Generate comprehensive development assistance customizations`;
  }

  return desc;
}

function printGeneratedFiles(_slug: string, files: string[]): void {
  const githubFiles = files.filter((f) => !f.startsWith(".vscode/"));
  const vscodeFiles = files.filter((f) => f.startsWith(".vscode/"));
  const tc = chalk.hex(DIM_BORDER); // tree connector color

  if (githubFiles.length > 0) {
    const groups = new Map<string, string[]>();
    for (const f of githubFiles) {
      const parts = f.split("/");
      const dir = parts.length > 1 ? parts[0] : "";
      const name = parts.length > 1 ? parts.slice(1).join("/") : f;
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir)!.push(name);
    }

    console.log();
    console.log(`  ${chalk.hex(ACCENT).bold(".github/")}`);
    const dirs = [...groups.keys()];
    for (let d = 0; d < dirs.length; d++) {
      const dir = dirs[d];
      const dirFiles = groups.get(dir)!;
      const isLastDir = d === dirs.length - 1;
      const dirPrefix = isLastDir ? "└── " : "├── ";
      const childIndent = isLastDir ? "    " : "│   ";

      if (dir) {
        console.log(tc(`    ${dirPrefix}`) + chalk.hex(ACCENT).bold(dir + "/"));
        for (let i = 0; i < dirFiles.length; i++) {
          const filePrefix = i === dirFiles.length - 1 ? "└── " : "├── ";
          console.log(tc(`    ${childIndent}${filePrefix}`) + chalk.white(dirFiles[i]));
        }
      } else {
        for (let i = 0; i < dirFiles.length; i++) {
          const filePrefix = (isLastDir && i === dirFiles.length - 1) ? "└── " : "├── ";
          console.log(tc(`    ${filePrefix}`) + chalk.white(dirFiles[i]));
        }
      }
    }
  }

  if (vscodeFiles.length > 0) {
    console.log();
    console.log(`  ${chalk.hex(ACCENT).bold(".vscode/")}`);
    for (let i = 0; i < vscodeFiles.length; i++) {
      const name = vscodeFiles[i].replace(".vscode/", "");
      const prefix = i === vscodeFiles.length - 1 ? "└── " : "├── ";
      console.log(tc(`    ${prefix}`) + chalk.white(name));
    }
  }
}

function printNextSteps(): void {
  console.log();
  console.log(`  ${chalk.hex(ACCENT).bold("Next steps")}`);
  console.log(`    ${chalk.hex(ACCENT)("1.")} Open Copilot Chat ${chalk.dim("⌘⇧I / Ctrl+Shift+I")}`);
  console.log(`    ${chalk.hex(ACCENT)("2.")} Try your new agent or prompt`);
  console.log();
}

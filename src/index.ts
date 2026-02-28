import { Command } from "commander";
import { createRequire } from "module";
import { initCommand } from "./commands/init.js";
import { generateCommand } from "./commands/generate.js";
import { listCommand } from "./commands/list.js";
import { validateCommand } from "./commands/validate.js";
import { checkCommand } from "./commands/check.js";
import type { InitMode, GenerationMode, ArtifactType, ValidateOptions } from "./types.js";
import type { AnalyzeStrategy, SpeedStrategy } from "./types.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const program = new Command();

program
  .name("forge")
  .description(
    "Context Engineering Toolkit — generate GitHub Copilot customization files (agents, prompts, instructions, skills, hooks, MCP servers, agentic workflows)",
  )
  .version(version);

program
  .command("init")
  .description("Initialize AGENT-FORGE — create, analyze, or install templates")
  .option("--force", "Force overwrite of existing files", false)
  .option("--mode <mode>", "Wizard mode (create, analyze, templates)")
  .option("--description <text>", "Use case description (skip prompt)")
  .option("--model <model>", "Model to use for AI generation")
  .option("--strategy <strategy>", "Analyze strategy: auto (scan-only) or guided (scan + custom requirements)")
  .option("--speed <speed>", "Generation speed: standard (single session, ~2 PRU) or turbo (parallel sessions, faster)")
  .option(
    "--use-cases <ids>",
    "Comma-separated template IDs to install (e.g., code-review,testing)",
  )
  .option("--skip-check", "Skip the prerequisite check", false)
  .action(async (opts) => {
    await initCommand({
      force: opts.force,
      mode: opts.mode as InitMode | undefined,
      description: opts.description,
      model: opts.model,
      analyzeStrategy: opts.strategy as AnalyzeStrategy | undefined,
      useCases: opts.useCases?.split(",").map((s: string) => s.trim()),
      speed: opts.speed as SpeedStrategy | undefined,
      skipCheck: opts.skipCheck,
    });
  });

program
  .command("generate <description>")
  .description("Generate customization files directly into .github/ (requires Copilot CLI)")
  .option("--model <model>", "Model to use for AI generation")
  .option("--mode <mode>", "Generation mode (discovery, full, on-demand, mcp-server, hooks, agentic-workflow)")
  .option("--types <types>", "Comma-separated artifact types for on-demand mode")
  .option("--speed <speed>", "Generation speed: standard (single session, ~2 PRU) or turbo (parallel sessions, faster)")
  .action(async (description: string, opts) => {
    await generateCommand(description, {
      model: opts.model,
      mode: opts.mode as GenerationMode | undefined,
      types: opts.types?.split(",").map((s: string) => s.trim()) as ArtifactType[] | undefined,
      speed: opts.speed as import("./types.js").SpeedStrategy | undefined,
    });
  });

program
  .command("list")
  .description("List installed and available use cases")
  .action(async () => {
    await listCommand();
  });

program
  .command("validate [scope]")
  .description("Validate all customization files for schema, tool names, and content quality")
  .option("--fix", "Auto-fix issues using AI (GitHub Copilot CLI)")
  .option("--no-fix", "Skip the interactive fix prompt")
  .option("--model <model>", "Model to use for AI-powered fixes")
  .action(async (scope: string | undefined, opts) => {
    // Commander treats --no-fix as fix=false, --fix as fix=true, neither as fix=undefined
    const options: ValidateOptions = {
      fix: opts.fix === true ? true : undefined,
      noFix: opts.fix === false ? true : undefined,
      model: opts.model,
    };
    await validateCommand(scope, options);
  });

program
  .command("check")
  .description("Check that prerequisites are installed")
  .action(async () => {
    await checkCommand();
  });

program.parse();

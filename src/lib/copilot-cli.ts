/**
 * Copilot CLI Runner — streamlined launcher for GitHub Copilot CLI.
 *
 * Pure CLI orchestration: detect, launch, parallel.
 * All prompt construction lives in prompt-builder.ts.
 * All domain logic lives in domain-registry.ts.
 */
import { execSync, spawn } from "child_process";
import fs from "fs-extra";
import path from "path";
import { select } from "@inquirer/prompts";
import chalk from "chalk";

/**
 * Quote a single shell argument so it is safe to embed in a command string
 * passed to `spawn(..., { shell: true })`.
 * Works for POSIX shells (/bin/sh) and Windows cmd.exe.
 */
function quoteArg(arg: string): string {
  if (process.platform === "win32") {
    // cmd.exe: wrap in double quotes; escape inner double quotes with \"
    // and escape percent signs which cmd.exe interprets
    if (/[ "&|<>^%!]/.test(arg)) {
      return `"${arg.replace(/"/g, '\\"')}"`;
    }
    return arg;
  }
  // POSIX: wrap in single quotes; escape embedded single quotes
  if (/[ "'\\$`!#&|;()<>{}\[\]*?~]/.test(arg)) {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
  return arg;
}

/**
 * Build a shell-safe command string from a command and args array.
 * Each argument is quoted only when it contains shell metacharacters.
 * The result is safe to pass as the first argument to
 * `spawn(cmd, { shell: true })` (without an args array).
 */
export function buildShellCommand(cmd: string, args: string[]): string {
  return [cmd, ...args.map(quoteArg)].join(" ");
}

let _copilotCliInstalled: boolean | undefined;

/**
 * Check if the GitHub Copilot CLI (`copilot`) binary is available.
 * Result is cached for the process lifetime.
 */
export function isCopilotCliInstalled(): boolean {
  if (_copilotCliInstalled !== undefined) return _copilotCliInstalled;
  try {
    execSync("copilot --version", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    _copilotCliInstalled = true;
  } catch {
    _copilotCliInstalled = false;
  }
  return _copilotCliInstalled;
}

/**
 * Get the installed Copilot CLI version string, or null if not installed.
 */
export function getCopilotCliVersion(): string | null {
  try {
    const output = execSync("copilot --version", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const match = output.match(/(\d+\.\d+[\d.]*)/);
    return match ? match[1] : output.slice(0, 30);
  } catch {
    return null;
  }
}

/** Available models ordered by speed (fastest first) */
export const AVAILABLE_MODELS = [
  { value: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", description: "Fastest — best speed/quality tradeoff (recommended)", premium: 1 },
  { value: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", description: "Fast — higher quality reasoning", premium: 1 },
  { value: "gpt-4.1",           name: "GPT-4.1",          description: "Fast — efficient code generation", premium: 1 },
  { value: "gpt-5.2-codex",     name: "GPT 5.2 Codex",    description: "Balanced — strong code generation", premium: 1 },
  { value: "gemini-3-pro-preview", name: "Gemini 3 Pro",  description: "Strong reasoning — large context window", premium: 2 },
  { value: "claude-opus-4.6",   name: "Claude Opus 4.6",  description: "Highest quality — deep reasoning", premium: 5 },
] as const;

/** Format a premium multiplier as a colored badge */
function premiumBadge(multiplier: number): string {
  if (multiplier <= 1) return chalk.dim(" 1x");
  if (multiplier <= 2) return chalk.yellow(` ⚡ ${multiplier}x premium`);
  return chalk.red(` ⚡ ${multiplier}x premium`);
}

/**
 * Look up the premium request multiplier for a model ID.
 * Returns 1 if the model is not found.
 */
export function getModelMultiplier(modelId: string): number {
  const entry = AVAILABLE_MODELS.find((m) => m.value === modelId);
  return entry?.premium ?? 1;
}

/**
 * Interactive model picker. Returns the selected model ID.
 * Shows premium request multiplier badges next to each model.
 */
export async function selectModel(): Promise<string> {
  return select({
    message: "Select a model for AI generation:",
    choices: AVAILABLE_MODELS.map((m) => ({
      value: m.value,
      name: `${m.name.padEnd(18)} ${m.description}${premiumBadge(m.premium)}`,
    })),
    default: "claude-sonnet-4.6",
  });
}

// ─── CLI Output Parsing ─────────────────────────────────────────────

/** Token usage breakdown for a single model */
export interface TokenBreakdown {
  model: string;
  tokensIn: string;
  tokensOut: string;
  tokensCached: string;
  estimatedPru: number;
}

/** Parsed output from a Copilot CLI session */
export interface CliOutput {
  exitCode: number;
  /** Total premium requests consumed (parsed from CLI output, 0 if unparseable) */
  premiumRequests: number;
  /** API time in milliseconds (parsed from CLI output, 0 if unparseable) */
  apiTimeMs: number;
  /** Total session time in milliseconds (parsed from CLI output, 0 if unparseable) */
  sessionTimeMs: number;
  /** Lines added / removed */
  codeChanges: { added: number; removed: number };
  /** Per-model token breakdown */
  tokenBreakdown: TokenBreakdown[];
  /** Raw stdout (available only when captured) */
  rawOutput: string;
}

/** Parse duration strings like "2m 12s", "45s", "1m" into milliseconds */
function parseDurationToMs(str: string): number {
  const minMatch = str.match(/(\d+)m/);
  const secMatch = str.match(/(\d+)s/);
  const mins = minMatch ? parseInt(minMatch[1], 10) : 0;
  const secs = secMatch ? parseInt(secMatch[1], 10) : 0;
  return (mins * 60 + secs) * 1000;
}

/**
 * Parse Copilot CLI stdout for usage statistics.
 * Gracefully returns zeroed output if format is unrecognized.
 */
export function parseCopilotOutput(stdout: string, exitCode: number): CliOutput {
  const result: CliOutput = {
    exitCode,
    premiumRequests: 0,
    apiTimeMs: 0,
    sessionTimeMs: 0,
    codeChanges: { added: 0, removed: 0 },
    tokenBreakdown: [],
    rawOutput: stdout,
  };

  // Total usage est:        1 Premium request(s)
  const pruMatch = stdout.match(/Total usage est:\s+(\d+)\s+Premium request/i);
  if (pruMatch) result.premiumRequests = parseInt(pruMatch[1], 10);

  // API time spent:         2m 12s
  const apiTimeMatch = stdout.match(/API time spent:\s+(\S[\dm s]+)/i);
  if (apiTimeMatch) result.apiTimeMs = parseDurationToMs(apiTimeMatch[1].trim());

  // Total session time:     2m 17s
  const sessionTimeMatch = stdout.match(/Total session time:\s+(\S[\dm s]+)/i);
  if (sessionTimeMatch) result.sessionTimeMs = parseDurationToMs(sessionTimeMatch[1].trim());

  // Total code changes:     +77 -0
  const codeMatch = stdout.match(/Total code changes:\s+\+(\d+)\s+-(\d+)/i);
  if (codeMatch) {
    result.codeChanges.added = parseInt(codeMatch[1], 10);
    result.codeChanges.removed = parseInt(codeMatch[2], 10);
  }

  // Per-model token breakdown:
  //  claude-sonnet-4.6       193.0k in, 5.0k out, 127.9k cached (Est. 1 Premium request)
  const tokenRegex = /^\s*(\S+)\s+([\d.]+k?)\s+in,\s+([\d.]+k?)\s+out,\s+([\d.]+k?)\s+cached\s+\(Est\.\s+(\d+)\s+Premium/gm;
  let tokenMatch;
  while ((tokenMatch = tokenRegex.exec(stdout)) !== null) {
    result.tokenBreakdown.push({
      model: tokenMatch[1],
      tokensIn: tokenMatch[2],
      tokensOut: tokenMatch[3],
      tokensCached: tokenMatch[4],
      estimatedPru: parseInt(tokenMatch[5], 10),
    });
  }

  // If per-model breakdown found but no total PRU parsed, sum from breakdowns
  if (result.premiumRequests === 0 && result.tokenBreakdown.length > 0) {
    result.premiumRequests = result.tokenBreakdown.reduce((sum, t) => sum + t.estimatedPru, 0);
  }

  return result;
}

/** Create a zeroed CliOutput (used as fallback when stdout is not captured) */
export function emptyCliOutput(exitCode: number): CliOutput {
  return {
    exitCode,
    premiumRequests: 0,
    apiTimeMs: 0,
    sessionTimeMs: 0,
    codeChanges: { added: 0, removed: 0 },
    tokenBreakdown: [],
    rawOutput: "",
  };
}

/** Aggregate multiple CliOutput objects into combined totals */
export function aggregateCliOutputs(outputs: CliOutput[]): CliOutput {
  const combined = emptyCliOutput(outputs.some(o => o.exitCode !== 0) ? 1 : 0);
  for (const o of outputs) {
    combined.premiumRequests += o.premiumRequests;
    combined.apiTimeMs += o.apiTimeMs;
    combined.codeChanges.added += o.codeChanges.added;
    combined.codeChanges.removed += o.codeChanges.removed;
    combined.tokenBreakdown.push(...o.tokenBreakdown);
  }
  return combined;
}

/** Format token stats compactly: "193k in / 5k out" */
export function formatTokens(breakdown: TokenBreakdown[]): string {
  if (breakdown.length === 0) return "";
  const totalIn = breakdown.map(b => b.tokensIn).join("+");
  const totalOut = breakdown.map(b => b.tokensOut).join("+");
  // If single model, show clean values
  if (breakdown.length === 1) {
    return `${breakdown[0].tokensIn} in / ${breakdown[0].tokensOut} out`;
  }
  return `${totalIn} in / ${totalOut} out`;
}

/** Options for launching Copilot CLI */
export interface LaunchOptions {
  model?: string;
  agent?: string;
  maxContinues?: number;
  /** Suppress terminal output (pipe instead of inherit stdio) */
  quiet?: boolean;
  /** Use /fleet mode — Copilot CLI breaks the prompt into parallel subtasks delegated to subagents */
  fleet?: boolean;
}

/**
 * Launch the Copilot CLI with a prompt routed to a specific agent.
 * Always captures stdout for usage parsing. In non-quiet mode, output
 * is echoed to the terminal in real-time (passthrough). In quiet mode,
 * output is buffered silently. Returns parsed CliOutput with real PRU data.
 */
export function launchCopilotCli(
  workingDir: string,
  prompt: string,
  options?: LaunchOptions,
): Promise<CliOutput> {
  return new Promise((resolve, reject) => {
    const agentName = options?.agent ?? "forge-orchestrator";
    const maxContinues = options?.maxContinues ?? 25;

    // Write prompt to a temp file to avoid shell escaping issues on Windows.
    // Use agent name in filename to prevent conflicts during parallel execution.
    const promptFileName = `_forge-prompt-${agentName}.md`;
    const promptFilePath = path.join(workingDir, promptFileName);
    fs.writeFileSync(promptFilePath, prompt, "utf-8");

    const args = [
      "-p", options?.fleet
        ? `/fleet Read and follow all instructions in ${promptFileName}`
        : `Read and follow all instructions in ${promptFileName}`,
      "--agent", agentName,
      "--autopilot",
      "--allow-all",
      "--no-ask-user",
      "--max-autopilot-continues", String(maxContinues),
    ];

    if (options?.model) {
      args.push("--model", options.model);
    }

    const cmd = buildShellCommand("copilot", args);
    // Always pipe stdio so we can capture stdout for parsing
    const child = spawn(cmd, {
      cwd: workingDir,
      stdio: "pipe",
      shell: true,
    });

    let stdoutBuf = "";

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutBuf += text;
        // In non-quiet mode, echo to terminal in real-time
        if (!options?.quiet) {
          process.stdout.write(text);
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        // In non-quiet mode, echo stderr to terminal
        if (!options?.quiet) {
          process.stderr.write(chunk);
        }
      });
    }

    child.on("error", (err) => {
      fs.removeSync(promptFilePath);
      reject(new Error(`Failed to launch Copilot CLI: ${err.message}`));
    });

    child.on("close", (code) => {
      fs.removeSync(promptFilePath);
      resolve(parseCopilotOutput(stdoutBuf, code ?? 0));
    });
  });
}

/** A task for parallel writer execution */
export interface ParallelTask {
  prompt: string;
  agent: string;
}

/** Result of a single parallel writer */
export interface WriterResult {
  agent: string;
  exitCode: number;
  durationMs: number;
  /** Parsed CLI output with real PRU and token stats */
  output: CliOutput;
}

/** Result of parallel Copilot CLI execution */
export interface ParallelResult {
  results: WriterResult[];
  failed: number;
  totalDurationMs: number;
  /** Aggregated PRU across all parallel writers */
  totalPremiumRequests: number;
  /** Aggregated CLI output */
  aggregatedOutput: CliOutput;
}

/** Human-readable labels for writer agents */
export const WRITER_LABELS: Record<string, string> = {
  "forge-agent-writer": "Agent writer",
  "forge-instruction-writer": "Instruction writer",
  "forge-skill-writer": "Skill writer",
  "forge-prompt-writer": "Prompt writer",
  "forge-hook-writer": "Hook writer",
  "forge-mcp-writer": "MCP writer",
  "forge-workflow-writer": "Workflow writer",
};

/** Format milliseconds into a human-readable duration string */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
}

/**
 * Launch multiple Copilot CLI processes in parallel.
 * @deprecated Turbo mode now uses /fleet via a single session instead.
 * Kept for potential future use or external tooling.
 * Each task spawns an independent `copilot` process targeting a specific writer agent.
 * Output is captured for PRU tracking — progress is reported via the onComplete callback.
 */
export async function launchCopilotCliParallel(
  workingDir: string,
  tasks: ParallelTask[],
  options?: LaunchOptions,
  onComplete?: (result: WriterResult) => void,
): Promise<ParallelResult> {
  const start = Date.now();

  const promises = tasks.map(async (task) => {
    const taskStart = Date.now();
    const cliOutput = await launchCopilotCli(workingDir, task.prompt, {
      ...options,
      agent: task.agent,
      maxContinues: options?.maxContinues ?? 15,
      quiet: true,
    });
    const result: WriterResult = {
      agent: task.agent,
      exitCode: cliOutput.exitCode,
      durationMs: Date.now() - taskStart,
      output: cliOutput,
    };
    onComplete?.(result);
    return result;
  });

  const results = await Promise.all(promises);
  const allOutputs = results.map(r => r.output);
  const aggregated = aggregateCliOutputs(allOutputs);
  return {
    results,
    failed: results.filter((r) => r.exitCode !== 0).length,
    totalDurationMs: Date.now() - start,
    totalPremiumRequests: aggregated.premiumRequests,
    aggregatedOutput: aggregated,
  };
}

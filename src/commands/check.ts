import chalk from "chalk";
import { animateLogo } from "./init.js";
import {
  checkPrerequisites,
  formatPrerequisiteResults,
  hasBlockingFailures,
  printMissingInstallGuide,
} from "../lib/prerequisites.js";

export async function checkCommand(): Promise<void> {
  await animateLogo();
  console.log(chalk.bold("  Checking prerequisites...\n"));

  const results = checkPrerequisites();
  formatPrerequisiteResults(results);

  console.log();
  if (hasBlockingFailures(results)) {
    console.log(chalk.red.bold("✗ Missing required tools."));
    printMissingInstallGuide(results);
  } else {
    console.log(chalk.green.bold("✓ Ready to use AGENT-FORGE!"));
    const missing = results.filter((r) => !r.found);
    if (missing.length > 0) {
      printMissingInstallGuide(results);
    }
  }

  console.log();
  console.log(chalk.bold("  Tip: ensure these VS Code settings are enabled:"));
  console.log(chalk.dim("  chat.agent.enabled: true"));
  console.log(chalk.dim("  GitHub Copilot extension installed & signed in"));
  console.log();
}

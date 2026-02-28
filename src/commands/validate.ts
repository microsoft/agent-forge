import chalk from "chalk";
import ora from "ora";
import { confirm } from "@inquirer/prompts";
import { validateDirectory, fixWithLLM } from "../lib/validator.js";
import { isCopilotCliInstalled } from "../lib/copilot-cli.js";
import type { ValidateOptions, ValidationReport } from "../types.js";

export async function validateCommand(
  scope?: string,
  options?: ValidateOptions,
): Promise<void> {
  const targetDir = scope ?? process.cwd();

  const spinner = ora("Validating customization files...").start();
  let report = await validateDirectory(targetDir);
  spinner.stop();

  displayReport(report);

  // LLM-powered fix flow
  const shouldOfferFix =
    report.fixableCount > 0 &&
    options?.noFix !== true &&
    isCopilotCliInstalled();

  if (shouldOfferFix) {
    const fixLabel = `${report.fixableCount} fixable issue(s)`;
    console.log(
      chalk.cyan(`\n🤖 ${fixLabel} can be auto-fixed using AI (GitHub Copilot CLI)\n`),
    );

    let shouldFix = options?.fix === true;
    if (!shouldFix) {
      shouldFix = await confirm({
        message: `Fix ${report.fixableCount} issue(s) with AI?`,
        default: true,
      });
    }

    if (shouldFix) {
      const fixSpinner = ora("Fixing issues with AI...").start();
      const result = await fixWithLLM(report, targetDir, { model: options?.model });
      fixSpinner.stop();

      if (result.fixed > 0) {
        console.log(chalk.green.bold(`\n✓ Fixed ${result.fixed} file(s) with AI\n`));
        console.log(chalk.dim("Re-validating after fixes...\n"));
        report = result.report;
        displayReport(report);
      } else {
        console.log(chalk.yellow("\n⚠ AI could not apply fixes. Manual review needed.\n"));
      }
    }
  } else if (report.fixableCount > 0 && !isCopilotCliInstalled()) {
    console.log(
      chalk.dim(
        `\n💡 ${report.fixableCount} issue(s) could be auto-fixed with AI. Install GitHub Copilot CLI for intelligent fixes.\n`,
      ),
    );
  }

  if (report.errors.length > 0) {
    process.exit(1);
  }
}

function displayReport(report: ValidationReport): void {
  // Errors
  if (report.errors.length > 0) {
    console.log(chalk.red.bold(`\n✗ ${report.errors.length} Error(s):\n`));
    for (const finding of report.errors) {
      const loc = finding.field ? ` (field: ${finding.field})` : "";
      const fix = finding.fixable ? chalk.cyan(" [fixable]") : "";
      console.log(
        `  ${chalk.red("✗")} ${chalk.dim(finding.file)}${loc}${fix}`,
      );
      console.log(`    ${finding.message}`);
    }
  }

  // Warnings
  if (report.warnings.length > 0) {
    console.log(
      chalk.yellow.bold(`\n⚠ ${report.warnings.length} Warning(s):\n`),
    );
    for (const finding of report.warnings) {
      const loc = finding.field ? ` (field: ${finding.field})` : "";
      const fix = finding.fixable ? chalk.cyan(" [fixable]") : "";
      console.log(
        `  ${chalk.yellow("⚠")} ${chalk.dim(finding.file)}${loc}${fix}`,
      );
      console.log(`    ${finding.message}`);
    }
  }

  // Passed
  if (report.passed.length > 0) {
    console.log(chalk.green.bold(`\n✓ ${report.passed.length} file(s) passed\n`));
  }

  // Summary
  console.log(chalk.bold("Summary:"), report.summary);
  if (report.fixableCount > 0) {
    console.log(chalk.dim(`  ${report.fixableCount} issue(s) are auto-fixable with AI`));
  }
  console.log();
}

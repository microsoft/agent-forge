/**
 * Cross-platform build helper — copies template and CLI directories into dist/.
 * Replaces the Unix-only `rm -rf … && cp -r …` commands in the build script
 * so the build works on macOS, Linux, and Windows.
 *
 * Uses fs-extra (already a project dependency) for recursive copy/remove.
 */
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const copies = [
  { src: "src/template", dest: "dist/template" },
  { src: "src/cli",      dest: "dist/cli" },
];

for (const { src, dest } of copies) {
  const srcPath = path.join(root, src);
  const destPath = path.join(root, dest);

  await fs.remove(destPath);
  await fs.copy(srcPath, destPath);
}

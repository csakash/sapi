/**
 * `bun run ci`: the checks to run before every push. sapi has no hosted CI (no GitHub Actions, at
 * the owner's request), so this is the build gate:
 *
 *   - install with the lockfile as it is; Biome lint and format; types
 *   - the tests and ARI-42 security evals, where a skipped sandbox suite fails (EVAL-1)
 *   - a compiled binary that starts
 *   - the ARI-42 scan (fails on high findings) and the gate (report mode until 0.1)
 *   - gitleaks over the whole history (GW-1)
 *   - a Signed-off-by line on every commit since main (DCO)
 *
 * Every step is an argv array; nothing goes through a shell. It stops at the first failure.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bun = process.execPath;
const ari42 = ".agents/skills/ari42/scripts/ari42_scan.py";

// Inherited by `bun test`: the confinement suite must run, not skip.
process.env.SAPI_REQUIRE_SANDBOX_TESTS = "1";

function run(argv: string[]): number {
  return Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" }).exitCode ?? 1;
}

function output(argv: string[]): { code: number; text: string } {
  const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, text: r.stdout.toString() };
}

/** Commits since main with no Signed-off-by line, or null when there is no main to compare with. */
function unsignedCommits(): string[] | null {
  const base = ["origin/main", "main"]
    .map((b) => output(["git", "merge-base", "HEAD", b]))
    .find((r) => r.code === 0)
    ?.text.trim();
  if (!base) return null;
  const log = output([
    "git",
    "log",
    "--format=%h%x09%(trailers:key=Signed-off-by,valueonly,separator=%x2C)",
    `${base}..HEAD`,
  ]).text;
  return log
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.split("\t")[1]?.trim())
    .map((line) => line.split("\t")[0] ?? line);
}

type Step = { name: string; run: () => string | null };

const cmd = (argv: string[]) => (): string | null => (run(argv) === 0 ? null : `exited non-zero: ${argv.join(" ")}`);

const work = mkdtempSync(join(tmpdir(), "sapi-ci-"));
const binary = join(work, "sapi");

const steps: Step[] = [
  { name: "Install (lockfile must match)", run: cmd([bun, "install", "--frozen-lockfile"]) },
  { name: "Lint and format", run: cmd([bun, "x", "biome", "ci", "."]) },
  { name: "Types", run: cmd([bun, "x", "tsc", "--noEmit"]) },
  { name: "Tests and security evals (the sandbox suite must run)", run: cmd([bun, "test"]) },
  {
    name: "Compile the binary",
    run: cmd([
      bun,
      "build",
      "src/cli.ts",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--outfile",
      binary,
    ]),
  },
  { name: "The binary starts", run: cmd([binary, "--version"]) },
  { name: "ARI-42 scan", run: cmd(["python3", ari42, "check", ".", "--fail-on", "high"]) },
  { name: "ARI-42 gate (report mode until 0.1)", run: cmd(["python3", ari42, "verify", ".", "--report"]) },
  {
    name: "Secret scan (gitleaks, whole history)",
    run: () =>
      Bun.which("gitleaks")
        ? cmd(["gitleaks", "git", ".", "--no-banner", "--redact"])()
        : "gitleaks isn't installed (macOS: brew install gitleaks; others: https://github.com/gitleaks/gitleaks)",
  },
  {
    name: "Every commit since main is signed off",
    run: () => {
      const missing = unsignedCommits();
      if (missing === null) {
        console.log("no main branch to compare with; skipped");
        return null;
      }
      return missing.length === 0 ? null : `no Signed-off-by line (use git commit -s): ${missing.join(", ")}`;
    },
  },
];

const started = Date.now();
let failure: string | null = null;
try {
  for (const s of steps) {
    console.log(`\n── ${s.name}`);
    const problem = s.run();
    if (problem) {
      failure = `${s.name}: ${problem}`;
      break;
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const secs = ((Date.now() - started) / 1000).toFixed(0);
if (failure) {
  console.error(`\n✗ ${failure}`);
  process.exit(1);
}
console.log(`\n✓ all ${steps.length} checks passed (${secs} s)`);

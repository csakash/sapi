/**
 * Build release binaries and SHA256SUMS (the files scripts/install.sh downloads).
 *
 *   bun scripts/build-release.ts                       # all four targets into dist/
 *   bun scripts/build-release.ts --targets linux-x64   # just one (CI's install test)
 *
 * Signing (cosign), provenance and the SBOM are added by the release workflow in Phase 5.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ALL = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"] as const;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { targets: { type: "string" }, out: { type: "string", default: "dist" } },
  strict: true,
});
const targets = (values.targets?.split(",") ?? [...ALL]).map((t) => t.trim());
for (const t of targets) if (!(ALL as readonly string[]).includes(t)) throw new Error(`unknown target ${t}`);
const out = values.out ?? "dist";
mkdirSync(out, { recursive: true });

const sums: string[] = [];
for (const t of targets) {
  const file = join(out, `sapi-${t}`);
  const r = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "src/cli.ts",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      `--target=bun-${t}`,
      "--outfile",
      file,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
  sums.push(`${createHash("sha256").update(readFileSync(file)).digest("hex")}  sapi-${t}`);
}
writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`${join(out, "SHA256SUMS")}:\n${sums.join("\n")}`);

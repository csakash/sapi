#!/usr/bin/env bun
/**
 * sapi command-line entry point.
 *
 * Phase 0 skeleton: only `--version` and `--help` work. The gateway itself lands in Phase 1
 * (see the build plan). Every other command says so instead of pretending to work.
 */
import { VERSION } from "./version.ts";

const HELP = `sapi ${VERSION}: a local, single-user gateway for your own Claude and ChatGPT subscriptions

Usage: sapi <command>

Commands (planned; not implemented yet):
  setup        Guided setup for this machine
  start        Run the gateway on 127.0.0.1:8787
  doctor       Check everything and print fixes
  clients      Manage client keys and budgets
  connect      Print SDK setup for a client
  pause        Kill switches (global, per provider, per client)

Options:
  -v, --version  Print the version
  -h, --help     Print this help

sapi is not affiliated with Anthropic or OpenAI.`;

export function run(argv: string[]): { code: number; out: string } {
  const [cmd] = argv;
  if (cmd === undefined || cmd === "-h" || cmd === "--help" || cmd === "help") return { code: 0, out: HELP };
  if (cmd === "-v" || cmd === "--version" || cmd === "version") return { code: 0, out: VERSION };
  return { code: 2, out: `sapi: "${cmd.slice(0, 40)}" is not implemented yet. This is a Phase 0 skeleton.` };
}

if (import.meta.main) {
  const { code, out } = run(process.argv.slice(2));
  (code === 0 ? console.log : console.error)(out);
  process.exit(code);
}

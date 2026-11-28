/**
 * The ChatGPT commands: `sapi login chatgpt`, `sapi logout chatgpt`, and the status line.
 * Progress goes to stderr, so `--export -` can write the sign-in to stdout for a pipe.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { parseArgs } from "node:util";
import type { Config } from "../../config.ts";
import { openEgress } from "../../egress-fetch.ts";
import type { Paths } from "../../paths.ts";
import { openSecretStore, recordedBackend } from "../../secrets.ts";
import { exportText, importSignIn, loginChatGpt, logoutChatGpt } from "./login.ts";
import { chatgptManifest, USAGE_PAGE } from "./manifest.ts";
import { parseSession, SESSION_SECRET, sessionState } from "./session.ts";

const say = (line: string) => console.error(line);

export async function loginChatGptCmd(args: string[], paths: Paths, cfg: Config): Promise<number> {
  const { values: v } = parseArgs({
    args,
    options: {
      ssh: { type: "boolean", default: false },
      port: { type: "string" },
      export: { type: "string" },
      import: { type: "string" },
      register: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (v.import !== undefined) {
    const from = v.import;
    const text = from === "-" ? await Bun.stdin.text() : existsSync(from) ? readFileSync(from, "utf8") : null;
    if (text === null) throw new Error(`No such file: ${from}`);
    const store = await openSecretStore(paths, cfg.secrets.backend);
    await importSignIn({ paths, store, text });
    if (from !== "-") rmSync(from, { force: true });
    say(
      `Imported the ChatGPT sign-in into the ${store.backend} secret store${from !== "-" ? ` and deleted ${from}` : ""}.`,
    );
    say("This machine now owns the sign-in and refreshes it; don't use the same export anywhere else.");
    return 0;
  }
  const port = v.port ? Number(v.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535))
    throw new Error("--port must be 1024-65535");
  const ssh = v.ssh || (!!process.env.SSH_CONNECTION && !process.env.DISPLAY && process.platform !== "darwin");
  const store = v.export !== undefined ? null : await openSecretStore(paths, cfg.secrets.backend);
  const egress = await openEgress(chatgptManifest.egressHosts);
  try {
    const { session, models } = await loginChatGpt({
      paths,
      fetch: egress.fetch,
      store,
      register: v.register,
      ssh,
      ...(port ? { port } : {}),
      print: say,
      sshTarget: `${userInfo().username}@${hostname()}`,
    });
    if (v.export !== undefined) {
      const text = exportText(session);
      if (v.export === "-") process.stdout.write(text);
      else writeFileSync(v.export, text, { mode: 0o600, flag: "wx" });
      say(`Signed in. The sign-in was written to ${v.export === "-" ? "stdout" : v.export} and not kept here.`);
      say(
        "On the VM, run: sapi login chatgpt --import <file>   (or pipe: --export - | ssh <vm> sapi login chatgpt --import -)",
      );
    } else {
      say(`Signed in to ChatGPT. The sign-in is in the ${store!.backend} secret store.`);
    }
    if (models.length) {
      say(`Models your plan offers: ${models.map((m) => m.slug).join(", ")}`);
      const configured = Object.values(cfg.models).some((m) => "provider" in m && m.provider === "chatgpt-sub");
      if (!configured) {
        say(`To use one, add it under [models] in ${paths.configFile}, for example:`);
        say(`  gpt = { provider = "chatgpt-sub", model = "${models[0]!.slug}" }`);
        say("(If the file has no [models] table yet, include the Claude aliases you use, such as sonnet, too.)");
      }
    }
    say(`Usage limits are shared with your other ChatGPT apps: ${USAGE_PAGE}`);
    return 0;
  } finally {
    await egress.close();
  }
}

export async function logoutChatGptCmd(paths: Paths, cfg: Config): Promise<number> {
  const store = await openSecretStore(paths, cfg.secrets.backend);
  const egress = await openEgress(chatgptManifest.egressHosts);
  try {
    const r = await logoutChatGpt({ store, fetch: egress.fetch });
    if (!r.hadSession) say("sapi wasn't signed in to ChatGPT.");
    else if (r.revoked) say("Signed out of ChatGPT: OpenAI revoked the sign-in and sapi deleted it.");
    else
      say(
        "sapi deleted its ChatGPT sign-in, but OpenAI didn't confirm the revocation. To be sure, disconnect sapi in ChatGPT's settings.",
      );
    return 0;
  } finally {
    await egress.close();
  }
}

/** One line for `sapi status`; reads the store, never refreshes. */
export async function chatgptStatusLine(paths: Paths, cfg: Config): Promise<string> {
  try {
    const store = await openSecretStore(paths, cfg.secrets.backend);
    const st = sessionState(parseSession(await store.get(SESSION_SECRET)));
    if (!st.ok) return `chatgpt      ${st.reason}: run ${st.fix}`;
    return `chatgpt      signed in (${store.backend} store; renews within ${st.refreshTokenDaysLeft} days of last use)`;
  } catch (e) {
    const rec = recordedBackend(paths);
    return `chatgpt      can't read the sign-in${rec ? ` (${rec} store)` : ""}: ${(e as Error).message}`;
  }
}

export async function deleteChatGptSignIn(paths: Paths, cfg: Config): Promise<boolean> {
  try {
    const store = await openSecretStore(paths, cfg.secrets.backend);
    return await store.delete(SESSION_SECRET);
  } catch {
    return false;
  }
}

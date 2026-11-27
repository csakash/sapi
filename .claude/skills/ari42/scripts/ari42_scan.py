#!/usr/bin/env python3
"""ARI-42 scanner: find agent components and common unsafe patterns.

    python3 ari42_scan.py detect [ROOT] [--json]
    python3 ari42_scan.py check  [ROOT] [--json] [--fail-on high|medium|low]
    python3 ari42_scan.py hook   [ROOT]          # one-line reminder for agent session hooks
    python3 ari42_scan.py verify [ROOT] [--json] [--report]   # CI gate on ARI42.md

`detect` lists the agent components in a project (frameworks, vendor SDKs, harnesses, MCP,
skills, memory, sandboxes, low-code builders, gateways, CI agents) and the ARI-42 requirements
each one switches on. `check` flags code and config patterns that the ARI-42 research found
behind most AI CVEs and unsafe defaults.

Both are heuristics. They point the agent at code to read; they do not prove compliance or
non-compliance. `verify` is the gate: it reads ARI42.md and fails unless every requirement that
applies to this project is Met with evidence that exists (or is an accepted, unexpired exception).

Standard library only, Python 3.9+. Reads files; never executes project code,
never sends anything over the network, and never prints secret values.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, asdict, field
from pathlib import Path

SKIP_DIRS = {
    ".git", "node_modules", ".venv", "venv", "env", "__pycache__", "dist", "build", ".next",
    ".nuxt", "out", "target", "vendor", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    "site-packages", ".turbo", ".cache", "coverage", ".gradle", "Pods", ".terraform",
}
SOURCE_EXT = {".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".go", ".java", ".kt",
              ".rb", ".cs", ".rs", ".php", ".swift", ".vue", ".svelte"}
OWN_INSTALL = ("ari42/", ".claude/skills/ari42/", ".agents/skills/ari42/", ".github/skills/ari42/")
# Folders that coding agents (not the product) read skills and rules from.
AGENT_DIRS = (".claude/", ".agents/", ".codex/", ".github/skills/", ".cursor/", ".gemini/", ".windsurf/")
CONFIG_EXT = {".json", ".yaml", ".yml", ".toml", ".sh", ".md", ".mdc", ".txt", ".cfg", ".ini"}
MAX_BYTES = 1_000_000
MAX_FILES = 30_000

# --------------------------------------------------------------------------- components

BASELINE = ["GOV-1", "GOV-2", "GOV-4", "DATA-1", "DATA-3", "INJ-1", "INJ-5", "GW-1", "GW-3",
            "LOG-1", "EVAL-1", "EVAL-3", "SDLC-3", "SDLC-6"]
AGENT_LOOP = ["AUTH-1", "AUTH-3", "AUTH-4", "INJ-2", "INJ-3", "OUT-1", "LOG-2", "GW-2"]

CATEGORIES = {
    "framework": {
        "label": "Open-source agent framework",
        "reqs": AGENT_LOOP,
        "deps": ["langchain", "langchain-core", "langchain-community", "@langchain/core", "langchain/",
                 "langgraph", "@langchain/langgraph", "llama-index", "llama-index-core", "llamaindex",
                 "crewai", "autogen-agentchat", "pyautogen", "ag2", "haystack-ai", "dspy", "dspy-ai",
                 "smolagents", "pydantic-ai", "pydantic-ai-slim", "agno", "@mastra/core", "camel-ai",
                 "dev.langchain4j", "semantic-kernel", "microsoft.semantickernel", "@voltagent/core"],
    },
    "vendor-sdk": {
        "label": "Vendor model or agent SDK",
        "reqs": AGENT_LOOP,
        "deps": ["openai", "@openai/agents", "openai-agents", "anthropic", "@anthropic-ai/sdk",
                 "google-adk", "@google/adk", "google-genai", "@google/genai", "google-generativeai",
                 "ai", "@ai-sdk/", "strands-agents", "bedrock-agentcore", "azure-ai-projects",
                 "azure-ai-agents", "agent-framework", "agents", "mistralai", "cohere", "groq",
                 "com.openai", "com.anthropic", "github.com/openai/openai-go",
                 "github.com/anthropics/anthropic-sdk-go"],
    },
    "harness": {
        "label": "Agent harness SDK (coding-agent style)",
        "reqs": ["OUT-4", "INJ-4", "GW-1", "SDLC-4", "AUTH-3", "AUTH-4"],
        "deps": ["@anthropic-ai/claude-agent-sdk", "claude-agent-sdk", "@anthropic-ai/claude-code",
                 "@openai/codex-sdk", "@openai/codex", "openhands-sdk", "openhands-ai",
                 "@github/copilot-sdk", "deepagents", "@opencode-ai/sdk", "@google/gemini-cli",
                 "goose-ai", "@cursor/sdk"],
    },
    "mcp": {
        "label": "MCP SDK, framework or gateway",
        "reqs": ["MCP-1", "MCP-2", "MCP-4", "INJ-1"],
        "deps": ["@modelcontextprotocol/sdk", "mcp", "fastmcp", "mcp-use", "mcp-remote",
                 "@modelcontextprotocol/inspector", "github.com/modelcontextprotocol/go-sdk",
                 "github.com/mark3labs/mcp-go", "io.modelcontextprotocol", "modelcontextprotocol",
                 "rmcp", "@mastra/mcp", "langchain-mcp-adapters", "@langchain/mcp-adapters"],
    },
    "memory": {
        "label": "Agent memory, RAG or vector store",
        "reqs": ["DATA-5", "AUTH-2", "INJ-1", "OUT-1"],
        "deps": ["mem0ai", "mem0", "letta", "letta-client", "@letta-ai/letta-client", "zep-cloud",
                 "zep-python", "@getzep/zep-cloud", "graphiti-core", "cognee", "langmem",
                 "supermemory", "memorisdk", "chromadb", "pinecone", "pinecone-client",
                 "@pinecone-database/pinecone", "qdrant-client", "@qdrant/js-client-rest",
                 "weaviate-client", "pgvector", "faiss-cpu", "faiss-gpu", "lancedb", "pymilvus",
                 "redisvl", "@upstash/vector", "turbopuffer"],
    },
    "sandbox": {
        "label": "Code sandbox SDK or runtime",
        "reqs": ["OUT-4", "INJ-4", "LOG-2", "GW-1"],
        "deps": ["e2b", "e2b-code-interpreter", "@e2b/code-interpreter", "daytona", "daytona-sdk",
                 "@daytonaio/sdk", "modal", "@vercel/sandbox", "microsandbox", "@cloudflare/sandbox",
                 "runloop-api-client", "@runloop/api-client", "blaxel", "@blaxel/core"],
    },
    "lowcode": {
        "label": "Low-code or visual agent builder",
        "reqs": ["GW-2", "MCP-3", "INJ-3", "OUT-4", "AUTH-3"],
        "deps": ["flowise", "flowise-components", "langflow", "dify-client", "n8n",
                 "n8n-workflow", "@botpress/sdk", "@botpress/client"],
        "images": ["flowiseai/flowise", "langflowai/langflow", "langgenius/dify", "n8nio/n8n",
                   "docker.n8n.io/n8nio/n8n", "botpress/server"],
    },
    "gateway": {
        "label": "LLM gateway or self-hosted inference",
        "reqs": ["GW-2", "GW-1", "MCP-3", "INJ-4"],
        "deps": ["litellm", "vllm", "ollama", "ray", "tritonclient", "text-generation",
                 "transformers", "llama-cpp-python", "sglang", "portkey-ai"],
        "images": ["ollama/ollama", "vllm/vllm-openai", "ghcr.io/berriai/litellm",
                   "nvcr.io/nvidia/tritonserver", "ghcr.io/huggingface/text-generation-inference",
                   "rayproject/ray"],
    },
}

CODE_SIGNALS = {
    "code-execution": (
        re.compile(r"PythonREPL|PythonAstREPL|code_interpreter|CodeInterpreter|LocalCommandLineCodeExecutor"
                   r"|ShellTool|BashTool|run_shell|execute_code|run_code\(|codeExecution|code_execution"),
        "Agent can run code or commands", ["OUT-4", "INJ-4", "GW-1", "AUTH-4"]),
    "exposed-server": (
        re.compile(r"FastMCP\(|McpServer\(|new Server\(\s*\{|StreamableHTTPServerTransport|SSEServerTransport"
                   r"|mcp\.run\(\s*transport\s*=\s*[\"'](sse|streamable-http|http)|A2AServer|AgentServer\("),
        "Exposes an MCP, A2A or agent endpoint", ["MCP-3", "MCP-4", "AUTH-2", "LOG-1"]),
    "multi-user": (
        re.compile(r"\b(tenant_id|tenantId|org_id|orgId|workspace_id|workspaceId)\b"),
        "Multi-tenant data model near AI code", ["AUTH-2", "DATA-5", "LOG-4"]),
    "chat-ui": (
        re.compile(r"react-markdown|from [\"']marked[\"']|markdown-it|dangerouslySetInnerHTML|useChat\("),
        "Renders model output in a UI", ["INJ-3", "OUT-2"]),
    "fetch-tool": (
        re.compile(r"WebBrowser|web_fetch|fetch_url|browse|Playwright|puppeteer|requests\.get\(|httpx\.get\("),
        "Agent may fetch external content", ["INJ-1", "INJ-3", "INJ-4"]),
}

AI_FILE = re.compile(
    r"openai|anthropic|langchain|llama_index|llamaindex|crewai|autogen|modelcontextprotocol|\bmcp\b"
    r"|chat\.completions|messages\.create|generateText|streamText|tool_call|function_call|\bllm\b"
    r"|\bLLM\b|agent", re.I)

AI_CI = re.compile(r"anthropics/claude-code-action|openai/codex-action|google-github-actions/run-gemini-cli"
                   r"|\bclaude\s+-p\b|\bcodex\s+exec\b|\bgemini\s+-p\b|\baider\b|copilot-swe-agent|cursor-agent")


@dataclass
class Component:
    category: str
    label: str
    name: str
    where: str
    reqs: list = field(default_factory=list)


@dataclass
class Finding:
    req: str
    severity: str
    path: str
    line: int
    message: str
    snippet: str = ""


# --------------------------------------------------------------------------- file walking

def walk(root: Path):
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.endswith(".egg-info")
                       and d not in ("worktrees", ".worktrees")]
        for fn in filenames:
            p = Path(dirpath) / fn
            try:
                if p.is_symlink() or p.stat().st_size > MAX_BYTES:
                    continue
            except OSError:
                continue
            count += 1
            if count > MAX_FILES:
                return
            yield p


def read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def rel(root: Path, p: Path) -> str:
    try:
        return str(p.relative_to(root))
    except ValueError:
        return str(p)


def norm(name: str) -> str:
    return name.strip().strip("\"'").lower().replace("_", "-")


# --------------------------------------------------------------------------- dependencies

def deps_from_manifest(p: Path, text: str) -> set:
    name = p.name
    out = set()
    if name == "package.json":
        try:
            data = json.loads(text)
        except ValueError:
            return out
        for key in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
            out.update(norm(k) for k in (data.get(key) or {}))
        return out
    if name.startswith("requirements") and name.endswith(".txt") or name in ("Pipfile", "setup.py", "setup.cfg"):
        for line in text.splitlines():
            m = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)", line.split("#")[0])
            if m:
                out.add(norm(m.group(1)))
        return out
    if name == "pyproject.toml":
        for m in re.finditer(r"[\"']([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~^].*?)?[\"']", text):
            out.add(norm(m.group(1)))
        for m in re.finditer(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=", text, re.M):
            out.add(norm(m.group(1)))
        return out
    if name == "go.mod":
        out.update(m.group(1).lower() for m in re.finditer(r"^\s*(?:require\s+)?([a-z0-9.\-]+\.[a-z]+/[^\s]+)\s+v", text, re.M))
        return out
    if name in ("pom.xml",) or name.endswith((".gradle", ".gradle.kts", ".csproj")) or name in ("Cargo.toml", "Gemfile", "composer.json"):
        for m in re.finditer(r"[A-Za-z0-9@][A-Za-z0-9._/@:-]{1,80}", text):
            out.add(norm(m.group(0).split(":")[0]))
        return out
    return out


MANIFESTS = {"package.json", "pyproject.toml", "Pipfile", "setup.py", "setup.cfg", "go.mod", "pom.xml",
             "Cargo.toml", "Gemfile", "composer.json"}


def is_manifest(p: Path) -> bool:
    n = p.name
    return (n in MANIFESTS or (n.startswith("requirements") and n.endswith(".txt"))
            or n.endswith((".gradle", ".gradle.kts", ".csproj")))


def match_dep(sig: str, deps: set) -> str | None:
    sig = norm(sig)
    if sig.endswith("/"):
        return next((d for d in deps if d.startswith(sig)), None)
    return sig if sig in deps else None


# --------------------------------------------------------------------------- detect

def detect(root: Path, quick: bool = False) -> dict:
    components: list[Component] = []
    signals: dict[str, list] = {}
    seen = set()
    files = list(walk(root))

    def add(cat, name, where, reqs, label=None):
        key = (cat, name)
        if key in seen:
            return
        seen.add(key)
        components.append(Component(cat, label or CATEGORIES.get(cat, {}).get("label", cat), name, where, list(reqs)))

    for p in files:
        r = rel(root, p)
        if r.startswith(OWN_INSTALL) or r == ".cursor/rules/ari42.mdc":
            continue  # this skill's own installed copy is not a project component
        if is_manifest(p):
            deps = deps_from_manifest(p, read(p))
            for cat, spec in CATEGORIES.items():
                for sig in spec["deps"]:
                    hit = match_dep(sig, deps)
                    if hit:
                        add(cat, hit, r, spec["reqs"])
        n = p.name.lower()
        if n in ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml") or n.startswith("dockerfile"):
            text = read(p)
            for cat in ("lowcode", "gateway"):
                for img in CATEGORIES[cat].get("images", []):
                    if img in text:
                        add(cat, img, r, CATEGORIES[cat]["reqs"])
        if n in (".mcp.json", "mcp.json", "claude_desktop_config.json", "mcp_config.json") or r.endswith(("/.cursor/mcp.json", "/.vscode/mcp.json")):
            add("mcp-client", n, r, ["MCP-1", "MCP-2", "MCP-4", "INJ-1"], "MCP client configuration")
        if n == "skill.md":
            if r.startswith(AGENT_DIRS):
                add("coding-agent-config", r, r, ["SDLC-1", "SDLC-4", "MCP-1"], "Coding-agent skill")
            else:
                add("skills", r, r, ["MCP-1", "MCP-2", "SDLC-4"], "Agent skill (shipped or loaded by the product)")
        if n in ("agents.md", "claude.md", "gemini.md", ".cursorrules", "copilot-instructions.md") or "/.claude/" in "/" + r or r.startswith(".cursor/rules"):
            add("coding-agent-config", r, r, ["SDLC-1", "SDLC-2", "SDLC-4"], "Coding-agent configuration")
        if "/.github/workflows/" in "/" + r and p.suffix in (".yml", ".yaml") and AI_CI.search(read(p)):
            add("ci-agent", r, r, ["SDLC-5", "SDLC-2", "SDLC-3"], "AI agent in CI")
        if p.suffix in SOURCE_EXT and not quick:
            text = read(p)
            if not AI_FILE.search(text):
                continue
            for sig, (rx, label, reqs) in CODE_SIGNALS.items():
                if sig in signals and len(signals[sig]) >= 5:
                    continue
                m = rx.search(text)
                if m:
                    line = text.count("\n", 0, m.start()) + 1
                    signals.setdefault(sig, []).append(f"{r}:{line}")

    for sig, where in signals.items():
        _, label, reqs = CODE_SIGNALS[sig]
        components.append(Component("signal", label, sig, ", ".join(where), list(reqs)))

    product = [c for c in components if c.category != "coding-agent-config"]
    in_scope = set()
    if product:
        in_scope.update(BASELINE)
    for c in components:
        in_scope.update(c.reqs)
    order = [f"{a}-{i}" for a, n in (("GOV", 4), ("DATA", 5), ("AUTH", 4), ("INJ", 5), ("OUT", 4),
                                     ("MCP", 4), ("GW", 3), ("LOG", 4), ("EVAL", 3), ("SDLC", 6)) for i in range(1, n + 1)]
    return {
        "root": str(root),
        "agentic": bool(product),
        "coding_agents_only": bool(components) and not product,
        "components": [asdict(c) for c in components],
        "suggested_in_scope": [r for r in order if r in in_scope],
        "review_manually": [r for r in order if r not in in_scope],
        "note": "Heuristic. Confirm each component by reading the code, then apply references/applicability.md.",
    }


# --------------------------------------------------------------------------- check

@dataclass
class Rule:
    req: str
    severity: str
    rx: re.Pattern
    message: str
    exts: set
    ai_only: bool = True
    secret: bool = False


def R(req, sev, pattern, msg, exts=None, ai_only=True, secret=False, flags=0):
    return Rule(req, sev, re.compile(pattern, flags), msg, exts or SOURCE_EXT, ai_only, secret)


PY = {".py"}
JS = {".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".svelte"}
ALL_TEXT = SOURCE_EXT | CONFIG_EXT | {".env.example", ""}
CONFIG_NO_DOCS = SOURCE_EXT | {".json", ".yaml", ".yml", ".toml", ".sh", ".cfg", ".ini", ""}
# Tests, fixtures, docs and migrations are not the shipped agent: report there, but as low.
NONPROD = re.compile(r"(^|/)(tests?|__tests__|spec|fixtures?|examples?|docs?|migrations|alembic)/"
                     r"|(^|/)test_[^/]*$|\.(test|spec)\.[jt]sx?$|_test\.(py|go)$|\.md$")
COMMENT = re.compile(r"^\s*(#|//|\*|/\*|--)")

RULES = [
    # OUT-4: generated code in-process
    R("OUT-4", "high", r"(?<![\w.])(eval|exec)\((?!\s*\))", "eval/exec in AI-related code; never run model or memory content in-process (use a per-session sandbox)", PY),
    R("OUT-4", "high", r"(?<![\w.])eval\(|new\s+Function\s*\(|vm\.runIn(?:New|This)?Context|vm\.Script\(|[\"']vm2[\"']", "eval/Function/vm in AI-related code; in-process JS sandboxes are not isolation", JS),
    R("OUT-4", "high", r"allow_dangerous_code\s*=\s*True|PythonREPLTool|PythonAstREPLTool|LocalCommandLineCodeExecutor|[\"']?use_docker[\"']?\s*[:=]\s*False", "Code tool that runs model-written code on the host", PY | JS, ai_only=False),
    # OUT-1: sinks
    R("OUT-1", "high", r"shell\s*=\s*True", "shell=True near AI code; pass an argv list, never model text to a shell", PY),
    R("OUT-1", "medium", r"\bexec(?:Sync)?\s*\(\s*`", "child_process exec with a template string; use execFile/spawn with an argv array", JS),
    R("OUT-1", "medium", r"\.(?:execute|executemany|raw|query)\s*\(\s*f[\"']", "SQL built with an f-string; use parameterised queries", PY),
    R("OUT-1", "medium", r"\.(?:query|raw|execute|\$queryRawUnsafe|\$executeRawUnsafe)\s*\(\s*`[^`]*\$\{", "SQL built with a template literal; use parameters", JS),
    # INJ-3: rendering
    R("INJ-3", "medium", r"dangerouslySetInnerHTML|v-html=|\{@html\s", "Raw HTML rendering in AI-related UI; escape model output and restrict images/links to allowlisted domains", JS),
    # GW-1: keys
    R("GW-1", "high", r"sk-ant-[A-Za-z0-9_\-]{20,}|sk-proj-[A-Za-z0-9_\-]{20,}|\bsk-[A-Za-z0-9]{40,}\b|AIza[0-9A-Za-z_\-]{35}|\bgsk_[A-Za-z0-9]{40,}|\bxai-[A-Za-z0-9]{40,}",
      "Hard-coded model-provider key; move to a secrets manager and rotate it", ALL_TEXT, ai_only=False, secret=True),
    R("GW-1", "high", r"(?:NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|PUBLIC|NUXT_PUBLIC)_[A-Z0-9_]*(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE_AI|GROQ|MISTRAL|COHERE|XAI|DEEPSEEK|OPENROUTER)[A-Z0-9_]*KEY",
      "Provider key exposed to the browser bundle; call the model from the server", ALL_TEXT, ai_only=False),
    R("GW-1", "medium", r"env\s*=\s*(?:dict\()?os\.environ\b(?!\.get)|\{\s*\*\*os\.environ", "Child process gets the full environment (provider keys included); pass a minimal env", PY),
    R("GW-1", "medium", r"env\s*:\s*process\.env\s*[,}\n]|\.\.\.process\.env\s*[,}\n]", "Child process or MCP server gets the full environment; pass a minimal env", JS),
    # SDLC-2: bypass modes
    R("SDLC-2", "high", r"--dangerously-skip-permissions|[\"']?bypassPermissions[\"']?|--yolo\b|dangerously-bypass-approvals-and-sandbox|approval_policy\s*=\s*[\"']never[\"']|\"autoApprove\"\s*:\s*\[\s*\"\*\"",
      "Agent permission bypass / auto-approve mode; ban by managed policy and use scoped allowlists", CONFIG_NO_DOCS, ai_only=False),
    # MCP-3: exposed listeners
    R("MCP-3", "low", r"host\s*=\s*[\"']0\.0\.0\.0[\"']|listen\([^)]*[\"']0\.0\.0\.0[\"']|--host[ =]0\.0\.0\.0|hostname\s*:\s*[\"']0\.0\.0\.0[\"']",
      "Listens on all interfaces near agent/MCP code; confirm authentication is on by default", CONFIG_NO_DOCS),
    # GW-2: unsafe model loading
    R("GW-2", "high", r"trust_remote_code\s*=\s*True", "trust_remote_code=True runs code from the model repo; pin by revision digest or disable", PY, ai_only=False),
    R("GW-2", "medium", r"torch\.load\((?![^)]*weights_only\s*=\s*True)", "torch.load without weights_only=True; prefer safetensors", PY, ai_only=False),
    R("GW-2", "medium", r"(?:pickle|cloudpickle|dill|joblib)\.loads?\(", "Unpickling in AI-related code; never load untrusted pickles", PY),
    # AUTH-2: identity as a tool argument
    R("AUTH-2", "medium", r"@(?:\w+\.)?tool\b[^\n]*\n(?:[ \t]*@[^\n]*\n)*[ \t]*(?:async\s+)?def\s+\w+\s*\([^)]*\b(?:user_id|tenant_id|account_id|org_id|customer_id)\b",
      "Tool takes user/tenant ID as a model-supplied argument; take identity from the server session", PY),
    R("AUTH-2", "medium", r"(?:parameters|inputSchema|schema)\s*:\s*z\.object\(\{[^}]{0,400}\b(?:userId|user_id|tenantId|tenant_id|accountId|orgId)\b",
      "Tool schema lets the model choose the user/tenant; take identity from the server session", JS),
]


def line_of(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def snippet(text: str, pos: int, secret: bool) -> str:
    start = text.rfind("\n", 0, pos) + 1
    end = text.find("\n", pos)
    s = text[start:end if end != -1 else None].strip()
    if secret:
        s = re.sub(r"(sk-ant-|sk-proj-|sk-|AIza|gsk_|xai-)[A-Za-z0-9_\-]+", r"\1****", s)
    return s[:160]


def check_mcp_config(root: Path, p: Path, text: str, out: list):
    try:
        data = json.loads(text)
    except ValueError:
        return
    servers = data.get("mcpServers") or data.get("servers") or {}
    if not isinstance(servers, dict):
        return
    for name, spec in servers.items():
        if not isinstance(spec, dict):
            continue
        cmd = os.path.basename(str(spec.get("command", "")))
        args = [str(a) for a in spec.get("args", []) if isinstance(a, (str, int))]
        pkg = next((a for a in args if not a.startswith("-") and a not in ("dlx", "x", "exec", "run")), "")
        loc = f"{rel(root, p)}"
        ln = line_of(text, max(text.find(f'"{name}"'), 0))
        if cmd in ("npx", "bunx", "pnpm", "yarn") and pkg:
            versioned = pkg.count("@") >= (2 if pkg.startswith("@") else 1)
            if not versioned or pkg.endswith("@latest"):
                out.append(Finding("MCP-1", "medium", loc, ln, f"MCP server '{name}' is not pinned to a version ({pkg})", pkg))
        if cmd in ("uvx", "pipx") and pkg and "==" not in pkg and "@" not in pkg:
            out.append(Finding("MCP-1", "medium", loc, ln, f"MCP server '{name}' is not pinned to a version ({pkg})", pkg))
        if cmd == "docker":
            img = next((a for a in args if "/" in a or ":" in a), "")
            if img and "@sha256:" not in img:
                out.append(Finding("MCP-1", "low", loc, ln, f"MCP server '{name}' image not pinned by digest ({img})", img))
        if "url" in spec and str(spec.get("url", "")).startswith("http://") and "localhost" not in str(spec["url"]) and "127.0.0.1" not in str(spec["url"]):
            out.append(Finding("MCP-3", "medium", loc, ln, f"MCP server '{name}' uses plain http to a remote host", ""))


def check_workflow(root: Path, p: Path, text: str, out: list):
    if not AI_CI.search(text):
        return
    loc = rel(root, p)
    risky_trigger = re.search(r"^\s*(pull_request_target|issue_comment|issues|discussion_comment|pull_request_review_comment)\s*:", text, re.M)
    if risky_trigger and "author_association" not in text:
        out.append(Finding("SDLC-5", "high", loc, line_of(text, risky_trigger.start()),
                           f"AI agent runs on '{risky_trigger.group(1)}' with no author_association gate; outsiders can steer it", ""))
    if not re.search(r"^\s*permissions\s*:", text, re.M):
        out.append(Finding("SDLC-5", "medium", loc, 1, "Workflow with an AI agent has no permissions block; set contents: read by default", ""))
    if re.search(r"permissions\s*:\s*write-all", text):
        out.append(Finding("SDLC-5", "high", loc, 1, "Workflow with an AI agent has write-all permissions", ""))
    for m in re.finditer(r"uses:\s*([^\s@]+)@([^\s#]+)", text):
        if AI_CI.search(m.group(1)) and not re.fullmatch(r"[0-9a-f]{40}", m.group(2)):
            out.append(Finding("GW-2", "low", loc, line_of(text, m.start()), f"AI action {m.group(1)} not pinned to a commit SHA", m.group(0)))


def check_lockfiles(root: Path, files: list, out: list):
    dirs = {}
    for p in files:
        dirs.setdefault(p.parent, set()).add(p.name)
    for d, names in dirs.items():
        r = rel(root, d)
        r = "" if r == "." else r + "/"
        if "package.json" in names and not names & {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "npm-shrinkwrap.json"}:
            if not any((parent / lf).exists() for parent in d.parents for lf in ("pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lock", "bun.lockb")):
                out.append(Finding("SDLC-6", "medium", f"{r}package.json", 1, "No lockfile next to package.json; commit one so agent-suggested packages are pinned", ""))
        if "pyproject.toml" in names and not names & {"poetry.lock", "uv.lock", "pdm.lock", "Pipfile.lock", "requirements.lock"} and not any(n.startswith("requirements") for n in names):
            out.append(Finding("SDLC-6", "low", f"{r}pyproject.toml", 1, "No Python lockfile found; pin with uv.lock / poetry.lock or hashed requirements", ""))
        for n in names:
            if n.startswith("requirements") and n.endswith(".txt"):
                text = read(d / n)
                ai = set(CATEGORIES["framework"]["deps"] + CATEGORIES["gateway"]["deps"] + CATEGORIES["mcp"]["deps"]
                         + CATEGORIES["lowcode"]["deps"] + CATEGORIES["memory"]["deps"] + CATEGORIES["harness"]["deps"])
                for i, line in enumerate(text.splitlines(), 1):
                    m = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)", line.split("#")[0])
                    if m and norm(m.group(1)) in ai and "==" not in m.group(3):
                        out.append(Finding("GW-2", "medium", f"{r}{n}", i, f"Agent-stack package '{m.group(1)}' not pinned with ==", line.strip()))


def check(root: Path) -> dict:
    findings: list[Finding] = []
    files = list(walk(root))
    for p in files:
        r = rel(root, p)
        suffix = p.suffix if p.suffix else ("" if not p.name.startswith(".env") else ".env.example")
        if p.name.startswith(".env") and p.name not in (".env.example", ".env.sample", ".env.template"):
            continue  # don't read live secret files
        n = p.name.lower()
        is_text = suffix in SOURCE_EXT or suffix in CONFIG_EXT or n.startswith(("dockerfile", ".env.")) or n == "makefile"
        if not is_text:
            continue
        text = read(p)
        if not text:
            continue
        if n in (".mcp.json", "mcp.json", "claude_desktop_config.json", "mcp_config.json") or r.endswith(("/.cursor/mcp.json", "/.vscode/mcp.json", ".vscode/mcp.json", ".cursor/mcp.json")):
            check_mcp_config(root, p, text, findings)
        if "/.github/workflows/" in "/" + r and suffix in (".yml", ".yaml"):
            check_workflow(root, p, text, findings)
        ai_file = bool(AI_FILE.search(text))
        if n == "ari42_scan.py" or r.startswith(OWN_INSTALL):
            continue  # don't flag the skill's own examples
        for rule in RULES:
            if suffix not in rule.exts and rule.exts is not ALL_TEXT:
                continue
            if rule.ai_only and not ai_file:
                continue
            for m in rule.rx.finditer(text):
                ls = text.rfind("\n", 0, m.start()) + 1
                if not rule.secret and COMMENT.match(text[ls:m.start()] + "x"):
                    continue  # match sits in a comment
                sev, msg = rule.severity, rule.message
                if NONPROD.search(r):
                    sev, msg = "low", msg + " (test/docs path)"
                findings.append(Finding(rule.req, sev, r, line_of(text, m.start()), msg, snippet(text, m.start(), rule.secret)))
                if sum(1 for f in findings if f.path == r and f.req == rule.req) >= 5:
                    break
    check_lockfiles(root, files, findings)
    order = {"high": 0, "medium": 1, "low": 2}
    findings.sort(key=lambda f: (order[f.severity], f.req, f.path, f.line))
    counts = {s: sum(1 for f in findings if f.severity == s) for s in order}
    return {"root": str(root), "counts": counts, "findings": [asdict(f) for f in findings],
            "note": "Heuristic. Read each hit; fix it, or record why it is safe in ARI42.md."}


# --------------------------------------------------------------------------- output

# --------------------------------------------------------------------------- verify

# Order and evidence type of the 42 (Gate column of references/questionnaire.md).
ALL_42 = [f"{a}-{i}" for a, n in (("GOV", 4), ("DATA", 5), ("AUTH", 4), ("INJ", 5), ("OUT", 4),
                                  ("MCP", 4), ("GW", 3), ("LOG", 4), ("EVAL", 3), ("SDLC", 6)) for i in range(1, n + 1)]
PERIODIC = {"GOV-2", "GOV-3", "GOV-4", "INJ-1", "LOG-3", "EVAL-2", "SDLC-1"}
PARTLY = {"DATA-1", "DATA-3", "AUTH-3", "INJ-2", "OUT-2", "OUT-3", "GW-3", "LOG-4", "SDLC-2"}
# everything else is "release": provable on every build by a test or automated check
STATUSES = {"met": "Met", "partial": "Partial", "gap": "Gap", "risk": "Risk", "n/a": "N/A", "na": "N/A",
            "human": "Human", "exception": "Exception"}
RECORD_PATHS = ("ARI42.md", "docs/ARI42.md", ".github/ARI42.md", "security/ARI42.md")
REQ_ID = re.compile(r"\b((?:GOV|DATA|AUTH|INJ|OUT|MCP|GW|LOG|EVAL|SDLC)-\d)\b")
PATH_TOKEN = re.compile(r"`([^`\s]+)`|(?<![\w/.:-])((?:[\w.-]+/)*[\w.-]+\.[A-Za-z0-9]{1,6})(?::\d+(?:-\d+)?)?")
URL = re.compile(r"https?://\S+")
DATE = re.compile(r"\b(20\d\d-\d\d-\d\d)\b")
AUTOMATED = re.compile(r"(^|/)(tests?|__tests__|spec|specs|evals?|e2e|\.github/workflows)(/|$)|"
                       r"[._-](test|spec|eval)s?\.[a-z]+$|^test_|/test_|\.gitlab-ci\.yml$|Jenkinsfile$|"
                       r"\.circleci/|azure-pipelines\.yml$|ai-bom\.json$", re.I)


def _cells(line: str) -> list:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _plain(cell: str) -> str:
    return re.sub(r"[*_~]", "", cell).strip()


def _sections(text: str) -> dict:
    out, cur = {}, ""
    for line in text.splitlines():
        m = re.match(r"^#{2,3}\s+(.*)", line)
        if m:
            cur = m.group(1).strip().lower()
            continue
        out.setdefault(cur, []).append(line)
    return out


def _cited_files(root: Path, evidence: str, index: list | None = None) -> list:
    """Repo files the evidence cites. A short path (`route.ts`, `app/api/x.ts` in a monorepo)
    counts when it matches exactly one file in the repo."""
    found = []
    for m in PATH_TOKEN.finditer(evidence):
        tok = (m.group(1) or m.group(2) or "").strip("()[],;")
        tok = re.sub(r":\d+(-\d+)?$", "", tok).lstrip("./") if not tok.startswith("../") else ""
        if not tok or "://" in tok or tok.startswith("/"):
            continue
        p = (root / tok)
        try:
            if p.resolve().is_relative_to(root) and p.exists():
                found.append(tok)
                continue
        except (OSError, ValueError, AttributeError):
            continue
        if index is not None and ".." not in tok.split("/"):
            hits = [f for f in index if f == tok or f.endswith("/" + tok)]
            if len(hits) == 1:
                found.append(hits[0])
    return found


def verify(root: Path, today=None) -> dict:
    import datetime as _dt
    today = today or _dt.date.today()
    record = next((root / r for r in RECORD_PATHS if (root / r).is_file()), None)
    scope = detect(root)
    detected = set(scope["suggested_in_scope"]) if scope["agentic"] else set()
    res = {"root": str(root), "record": None, "agentic": scope["agentic"], "applicable": [],
           "not_applicable": [], "met": [], "failures": [], "warnings": [], "passed": False}

    def fail(req, problem):
        res["failures"].append({"req": req, "problem": problem})

    if record is None:
        if scope["agentic"]:
            fail("-", "No ARI42.md found. This project has agent components, so it needs a scoped record "
                      "(ask the coding agent to \"set up ARI-42\").")
        else:
            res["passed"] = True
            res["warnings"].append("No agent components detected and no ARI42.md: nothing to verify.")
        return res
    res["record"] = rel(root, record)
    text = read(record)
    sections = _sections(text)

    # Status table: the rows of the section whose title mentions "status"
    rows = {}
    status_lines = next((v for k, v in sections.items() if "status" in k), None) or text.splitlines()
    for line in status_lines:
        if not line.lstrip().startswith("|"):
            continue
        cells = _cells(line)
        m = REQ_ID.fullmatch(_plain(cells[0])) if cells else None
        if not m or len(cells) < 3:
            continue
        req = m.group(1)
        if req in rows:
            fail(req, "listed twice in the status table")
            continue
        status_cell = _plain(cells[2]) if len(cells) >= 3 else ""
        word = status_cell.split(" ")[0].lower().rstrip(".:,") if status_cell else ""
        qualifier = status_cell[len(word):].strip(" .:,") if word in STATUSES else ""
        rows[req] = {"status": STATUSES.get(word, status_cell or ""), "qualifier": qualifier,
                     "evidence": cells[3] if len(cells) > 3 else ""}

    # Exceptions table: ID | what | why | accepted by | review by
    exceptions = {}
    for line in next((v for k, v in sections.items() if k.startswith("exception")), []):
        if not line.lstrip().startswith("|"):
            continue
        cells = _cells(line)
        m = REQ_ID.fullmatch(_plain(cells[0])) if cells else None
        if m:
            exceptions[m.group(1)] = cells

    def exception_ok(req) -> str | None:
        cells = exceptions.get(req)
        if not cells:
            return "needs a row in the Exceptions table (what, why, accepted by, review by)"
        accepted = _plain(cells[3]) if len(cells) > 3 else ""
        review = _plain(cells[4]) if len(cells) > 4 else ""
        if not accepted or accepted in ("-", "—") or accepted.startswith("<"):
            return "exception has no 'Accepted by': a named person must accept the risk"
        d = DATE.search(review)
        if not d:
            return "exception has no 'Review by' date (YYYY-MM-DD)"
        if _dt.date.fromisoformat(d.group(1)) < today:
            return f"exception expired on {d.group(1)}; review it and renew or fix"
        return None

    high = {}
    for f in check(root)["findings"]:
        if f["severity"] == "high":
            high.setdefault(f["req"], []).append(f"{f['path']}:{f['line']}")

    index = [rel(root, p) for p in walk(root)]
    for req in ALL_42:
        row = rows.get(req)
        if row is None:
            fail(req, "missing from the status table; every one of the 42 must be scoped, even if N/A")
            continue
        st, ev = row["status"], row["evidence"]
        ev_plain = _plain(ev)
        if st in ("Met", "N/A") and row["qualifier"]:
            if st == "N/A":
                res["not_applicable"].append(req)
            else:
                res["applicable"].append(req)
            fail(req, f"'{st} {row['qualifier']}' is qualified; the gate needs the requirement {st} for the "
                      "whole project. Use Partial if only part of the project is covered")
            continue
        if st == "N/A":
            res["not_applicable"].append(req)
            if len(ev_plain) < 12:
                fail(req, "marked N/A without a reason; say why it cannot apply to this project")
            elif req in detected:
                problem = exception_ok(req)
                if problem:
                    fail(req, "marked N/A, but the scan found components that switch it on "
                              f"({', '.join(c['name'] for c in scope['components'] if req in c['reqs'])[:120]}); "
                              f"if it truly does not apply, a person must accept that: {problem}")
            continue
        res["applicable"].append(req)
        if st == "Met":
            files = _cited_files(root, ev, index)
            urls = URL.findall(ev)
            if req in PERIODIC:
                if not files and not urls:
                    fail(req, "Met, but the evidence cites no file in the repo or link to the signed record")
                    continue
                d = DATE.search(ev)
                if not d:
                    fail(req, "Met, but periodic evidence has no date (YYYY-MM-DD) of the last review")
                    continue
                if (today - _dt.date.fromisoformat(d.group(1))).days > 366:
                    fail(req, f"last reviewed {d.group(1)}, more than a year ago; periodic evidence must be renewed")
                    continue
            elif req in PARTLY:
                if not files and not (urls and req in ("DATA-3", "OUT-2")):
                    fail(req, "Met, but the evidence cites no existing file in the repo")
                    continue
            else:
                if not files:
                    fail(req, "Met, but the evidence cites no existing file; name the test or check that proves it")
                    continue
                if not any(AUTOMATED.search(f) for f in files):
                    fail(req, "Met, but none of the cited files is a test, eval or CI check; "
                              "release requirements are proven by something that runs on every build")
                    continue
            if req in high:
                fail(req, f"Met, but the scanner finds high-severity issues for it: {', '.join(high[req][:3])}")
                continue
            res["met"].append(req)
        elif st == "Exception":
            problem = exception_ok(req)
            if problem:
                fail(req, problem)
            else:
                res["met"].append(req)
                res["warnings"].append(f"{req} passes as an accepted exception, not as met")
        else:
            label = st or "no status"
            fail(req, f"applies to this project but is '{label}', not Met")
    for req in rows:
        if req not in ALL_42:
            res["warnings"].append(f"{req} is not one of the 42")
    res["passed"] = not res["failures"]
    return res


def print_verify(res: dict):
    print(f"ARI-42 verify: {res['root']}")
    if res["record"]:
        n = len(res["applicable"])
        print(f"  record: {res['record']}")
        print(f"  scope:  {n} of 42 apply to this project, {len(res['not_applicable'])} not applicable")
        print(f"  met:    {len(res['met'])} of {n} applicable requirements")
    for w in res["warnings"]:
        print(f"  note:   {w}")
    if res["failures"]:
        print(f"\n  {len(res['failures'])} problem(s):")
        for f in res["failures"]:
            print(f"    {f['req']:<7} {f['problem']}")
    print("\n  PASS: every requirement that applies to this project is met with evidence." if res["passed"]
          else "\n  FAIL: the gate passes only when every requirement that applies here is met (or an accepted, "
               "unexpired exception).")


def print_detect(res: dict):
    print(f"ARI-42 detect: {res['root']}\n")
    if not res["agentic"]:
        if res["coding_agents_only"]:
            print("No agent or LLM components in the product. Coding agents work on this repo, so SDLC-1..6 apply.")
        else:
            print("No agent or LLM components found. ARI-42 may not apply; confirm by reading the code.")
        if not res["components"]:
            return
    width = max(len(c["label"]) for c in res["components"])
    for c in res["components"]:
        print(f"  {c['label']:<{width}}  {c['name']}")
        print(f"  {'':<{width}}  at {c['where']}")
        print(f"  {'':<{width}}  switches on: {', '.join(c['reqs'])}")
    print(f"\nSuggested in scope ({len(res['suggested_in_scope'])}/42): {', '.join(res['suggested_in_scope'])}")
    print(f"Review manually ({len(res['review_manually'])}): {', '.join(res['review_manually'])}")
    print(f"\n{res['note']}")


def print_check(res: dict):
    c = res["counts"]
    print(f"ARI-42 check: {res['root']}  ({c['high']} high, {c['medium']} medium, {c['low']} low)\n")
    if not res["findings"]:
        print("No findings. That is not proof of compliance: verify each in-scope requirement with a test.")
        return
    for f in res["findings"]:
        print(f"  [{f['severity'].upper():6}] {f['req']:<7} {f['path']}:{f['line']}")
        print(f"           {f['message']}")
        if f["snippet"]:
            print(f"           > {f['snippet']}")
    print(f"\n{res['note']}")


def print_hook(root: Path):
    """SessionStart / prompt hook: one short reminder, only when the project is agentic."""
    res = detect(root, quick=True)
    if res.get("coding_agents_only"):
        print("ARI-42: no AI components detected in the product yet. If this task adds any (LLM calls, tools, "
              "MCP, memory, sandboxes), load the ari42 skill first. Agent config here (AGENTS.md, hooks, "
              ".mcp.json, skills) is code: SDLC-4.")
        return
    if not res["agentic"]:
        return
    kinds = sorted({c["label"] for c in res["components"]})
    record = "ARI42.md exists: read it first." if (root / "ARI42.md").exists() else \
        "No ARI42.md yet: create it (skill step 1) before the first change."
    print("ARI-42: this project builds software with AI agents (" + "; ".join(kinds[:6]) + "). "
          "Use the ari42 skill as the primary guideline for every development or agent task here: "
          "scope the requirements, build the controls in by default, verify with tests, update ARI42.md. "
          + record)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="ARI-42 scanner (heuristic)")
    ap.add_argument("command", choices=["detect", "check", "hook", "verify"])
    ap.add_argument("root", nargs="?", default=".")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--fail-on", choices=["high", "medium", "low"], help="check: exit 1 if a finding at or above this severity exists")
    ap.add_argument("--report", action="store_true", help="verify: print the result but always exit 0")
    a = ap.parse_args(argv)
    root = Path(a.root).resolve()
    if not root.is_dir():
        print(f"not a directory: {root}", file=sys.stderr)
        return 2
    if a.command == "hook":
        try:
            print_hook(root)
        except Exception:  # a hook must never break the session
            pass
        return 0
    if a.command == "verify":
        res = verify(root)
        print(json.dumps(res, indent=2)) if a.json else print_verify(res)
        return 0 if (res["passed"] or a.report) else 1
    res = detect(root) if a.command == "detect" else check(root)
    if a.json:
        print(json.dumps(res, indent=2))
    else:
        (print_detect if a.command == "detect" else print_check)(res)
    if a.command == "check" and a.fail_on:
        levels = ["high", "medium", "low"]
        worst = levels[: levels.index(a.fail_on) + 1]
        if any(f["severity"] in worst for f in res["findings"]):
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

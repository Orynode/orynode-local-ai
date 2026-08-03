import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * 加载 .env / .env.local 到 process.env（不覆盖已有环境变量）。
 * start-local 自身不走 Vite，必须显式读取，否则 ORYNODE_ACCESS_MODE 会静默落回 local_only。
 */
function loadEnvFiles() {
  for (const name of [".env", ".env.local"]) {
    const path = resolve(projectRoot, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (process.env[key] !== undefined) continue;
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

loadEnvFiles();

const children = new Set();
let stopping = false;

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  children.add(child);
  child.once("error", (error) => {
    console.error(`Unable to start ${command}: ${error.message}`);
    shutdown(1);
  });
  child.once("exit", (code) => {
    children.delete(child);
    if (!stopping && code !== 0) {
      console.error(`${command} stopped with exit code ${code}.`);
      shutdown(code ?? 1);
    }
  });
  return child;
}

async function isTurboFieldfare() {
  try {
    const response = await fetch("http://127.0.0.1:8080/health", {
      signal: AbortSignal.timeout(800),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function isOrynodeDataService() {
  try {
    const response = await fetch("http://127.0.0.1:4318/health", {
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return false;
    const result = await response.json();
    return result.service === "orynode-local-data";
  } catch {
    return false;
  }
}

function portIsOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    socket.setTimeout(350);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const close = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", close);
    socket.once("timeout", close);
  });
}

/** PIDs listening on TCP `port` (macOS / Linux via lsof). */
function pidsListeningOn(port) {
  try {
    const output = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8" },
    );
    return [
      ...new Set(
        output
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => Number(s))
          .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid),
      ),
    ];
  } catch {
    return [];
  }
}

function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    throw error;
  }
}

/**
 * Free a local TCP port by stopping listeners (SIGTERM, then SIGKILL).
 * Used so `npm run local` can replace a leftover Orynode web server on 3000.
 */
async function freePort(port, { label = `port ${port}` } = {}) {
  const pids = pidsListeningOn(port);
  if (pids.length === 0) {
    if (await portIsOpen(port, "localhost")) {
      throw new Error(
        `${label} is in use, but no listening PID was found. Stop the process manually, then try again.`,
      );
    }
    return;
  }

  console.log(
    `${label} is in use (PID ${pids.join(", ")}). Stopping it so Orynode can start...`,
  );
  for (const pid of pids) killPid(pid, "SIGTERM");

  for (let i = 0; i < 20; i++) {
    await delay(100);
    if (!(await portIsOpen(port, "localhost"))) return;
  }

  const remaining = pidsListeningOn(port);
  for (const pid of remaining) {
    console.log(`Force-killing PID ${pid} on ${label}...`);
    killPid(pid, "SIGKILL");
  }

  for (let i = 0; i < 20; i++) {
    await delay(100);
    if (!(await portIsOpen(port, "localhost"))) return;
  }

  throw new Error(
    `Could not free ${label}. Stop the process manually, then try again.`,
  );
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300).unref();
}

function localNetworkUrls() {
  const urls = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (address.address.startsWith("169.254.")) continue;
      urls.push(`http://${address.address}:3000`);
    }
  }
  return [...new Set(urls)];
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function mustFreePort(port, label) {
  try {
    await freePort(port, { label });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (await portIsOpen(3000, "localhost")) {
  await mustFreePort(3000, "Port 3000");
}

if (!(await portIsOpen(4318, "127.0.0.1"))) {
  console.log("Starting the Orynode local data service...");
  run("node", ["--disable-warning=ExperimentalWarning", "scripts/local-data-service.mjs"]);
} else if (await isOrynodeDataService()) {
  console.log("Using the Orynode data service already running on port 4318.");
} else {
  await mustFreePort(4318, "Port 4318");
  console.log("Starting the Orynode local data service...");
  run("node", ["--disable-warning=ExperimentalWarning", "scripts/local-data-service.mjs"]);
}

if (!(await portIsOpen(8080, "127.0.0.1"))) {
  console.log("Starting TurboFieldfare...");
  run("bash", ["scripts/start-turbo.sh"]);
} else if (await isTurboFieldfare()) {
  console.log("Using the TurboFieldfare service already running on port 8080.");
  try {
    const settings = JSON.parse(
      readFileSync(resolve(projectRoot, ".orynode/runtime-settings.json"), "utf8"),
    );
    let applied = null;
    try {
      applied = JSON.parse(
        readFileSync(resolve(projectRoot, ".orynode/turbo-applied.json"), "utf8"),
      );
    } catch {
      // older runs may not have applied marker
    }
    if (
      applied &&
      Number(settings.maxContext) !== Number(applied.maxContext)
    ) {
      console.log(
        `Note: saved maxContext is ${settings.maxContext}, but the running model uses ${applied.maxContext}. Run: npm run turbo:restart`,
      );
    }
  } catch {
    // settings optional
  }
} else {
  await mustFreePort(8080, "Port 8080");
  console.log("Starting TurboFieldfare...");
  run("bash", ["scripts/start-turbo.sh"]);
}

const accessModeRequested =
  process.env.ORYNODE_ACCESS_MODE === "trusted_lan"
    ? "trusted_lan"
    : "local_only";
const trustedLanUnsafe =
  process.env.ORYNODE_TRUSTED_LAN_UNSAFE === "1" ||
  process.env.ORYNODE_TRUSTED_LAN_UNSAFE === "true";
const accessMode = accessModeRequested;
const webHostname = accessMode === "trusted_lan" ? "0.0.0.0" : "127.0.0.1";

console.log("\nStarting Orynode Local AI");
console.log(`  Access mode: ${accessMode}`);
console.log("  This Mac: http://localhost:3000");
if (accessMode === "trusted_lan" && trustedLanUnsafe) {
  for (const url of localNetworkUrls()) {
    console.log(`  Local network: ${url}`);
  }
  console.log(
    "\nTrusted-LAN UNSAFE preview (ORYNODE_TRUSTED_LAN_UNSAFE=1): no auth. Anyone on the LAN can use this instance. Not a secure sharing mode.",
  );
} else if (accessMode === "trusted_lan") {
  for (const url of localNetworkUrls()) {
    console.log(`  Local network: ${url}`);
  }
  console.log(
    "\nTrusted-LAN with pairing auth: LAN clients must claim a pairing code (POST /api/lan/pairing). Data Service stays on 127.0.0.1.",
  );
} else {
  console.log(
    "\nLocal-only mode: Web UI binds 127.0.0.1. To share on LAN: ORYNODE_ACCESS_MODE=trusted_lan (pairing) or add ORYNODE_TRUSTED_LAN_UNSAFE=1 for unsafe preview.",
  );
}
console.log(
  "TurboFieldfare and SQLite remain private on 127.0.0.1 and are not exposed directly.\n",
);
run("npm", ["run", "dev", "--", "--hostname", webHostname]);

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";

const children = new Set();
let stopping = false;

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: new URL("..", import.meta.url),
    stdio: "inherit",
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

if (await portIsOpen(3000, "localhost")) {
  console.error(
    "Port 3000 is already in use. Stop the other Orynode development server, then try again.",
  );
  process.exit(1);
}

if (!(await portIsOpen(4318, "127.0.0.1"))) {
  console.log("Starting the Orynode local data service...");
  run("node", ["--disable-warning=ExperimentalWarning", "scripts/local-data-service.mjs"]);
} else if (await isOrynodeDataService()) {
  console.log("Using the Orynode data service already running on port 4318.");
} else {
  console.error(
    "Port 4318 is occupied by another program. Stop it before starting Orynode.",
  );
  process.exit(1);
}

if (!(await portIsOpen(8080, "127.0.0.1"))) {
  console.log("Starting TurboFieldfare...");
  run("bash", ["scripts/start-turbo.sh"]);
} else if (await isTurboFieldfare()) {
  console.log("Using the TurboFieldfare service already running on port 8080.");
  try {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const root = new URL("..", import.meta.url);
    const settings = JSON.parse(
      readFileSync(resolve(root.pathname, ".orynode/runtime-settings.json"), "utf8"),
    );
    let applied = null;
    try {
      applied = JSON.parse(
        readFileSync(resolve(root.pathname, ".orynode/turbo-applied.json"), "utf8"),
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
  console.error(
    "Port 8080 is occupied by another program. Stop it or configure another TurboFieldfare port.",
  );
  process.exit(1);
}

console.log("\nStarting Orynode Local AI");
console.log("  This Mac: http://localhost:3000");
for (const url of localNetworkUrls()) {
  console.log(`  Local network: ${url}`);
}
console.log(
  "\nV1 LAN sharing has no user accounts or access control. Anyone on the same network can use this Orynode instance.",
);
console.log(
  "TurboFieldfare and SQLite remain private on 127.0.0.1 and are not exposed directly.\n",
);
run("npm", ["run", "dev", "--", "--hostname", "0.0.0.0"]);

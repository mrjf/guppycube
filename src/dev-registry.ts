import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DevProject,
  HubDiscovery,
  RegistrationResponse,
  UnregisterResponse,
} from "./schemas.ts";
import { describeValidationErrors, validators } from "./validation.ts";

const heartbeatMs = 5_000;
const requestTimeoutMs = 1_500;

type RegistrationState = "registered" | "unavailable";

export interface DevHubRegistration {
  project: DevProject;
  stop: () => Promise<void>;
}

export function getDevHubDiscoveryPath(env: NodeJS.ProcessEnv = process.env): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return env.DEV_HUB_DISCOVERY_FILE ?? join(tmpdir(), `bun-hono-dev-hub-${uid}`, "hub.json");
}

async function readDiscovery(path: string): Promise<HubDiscovery | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return validators.hubDiscovery(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readProjectName(root: string): Promise<string> {
  try {
    const value: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (
      typeof value === "object"
      && value !== null
      && "name" in value
      && typeof value.name === "string"
      && value.name.length > 0
    ) {
      return value.name;
    }
  } catch {
    // A fallback keeps local development usable if package metadata is temporarily unavailable.
  }
  return "guppycube";
}

async function createProject(url: string, root: string): Promise<DevProject> {
  const name = await readProjectName(root);
  const bunVersion = (process.versions as Record<string, string | undefined>).bun;
  const project: unknown = {
    schemaVersion: 1,
    id: `${name}:${createHash("sha256").update(root).digest("hex").slice(0, 16)}`,
    name,
    kind: "cloudflare-vite",
    url,
    healthUrl: new URL("/api/health", url).toString(),
    root,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    runtime: bunVersion
      ? { name: "bun", version: bunVersion }
      : { name: "node", version: process.versions.node },
  };

  if (!validators.devProject(project)) {
    throw new Error(`Invalid Dev Hub project: ${describeValidationErrors(validators.devProject.errors)}`);
  }
  return project;
}

async function postJson<T>(
  discovery: HubDiscovery,
  pathname: string,
  body: unknown,
  validate: ((value: unknown) => value is T) & { errors?: Parameters<typeof describeValidationErrors>[0] },
): Promise<T> {
  const response = await fetch(new URL(pathname, discovery.url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${discovery.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const value: unknown = await response.json();
  if (!response.ok || !validate(value)) {
    throw new Error(`Dev Hub rejected ${pathname}: ${describeValidationErrors(validate.errors)}`);
  }
  return value;
}

export async function startDevHubRegistration({
  url,
  root,
}: {
  url: string;
  root: string;
}): Promise<DevHubRegistration> {
  const project = await createProject(url, root);
  const discoveryPath = getDevHubDiscoveryPath();
  let activeDiscovery: HubDiscovery | undefined;
  let lastState: RegistrationState | undefined;
  let stopped = false;

  const report = (state: RegistrationState, detail?: Record<string, unknown>) => {
    if (state === lastState) return;
    lastState = state;
    console.log(JSON.stringify({ event: `dev_hub_${state}`, projectId: project.id, ...detail }));
  };

  const checkIn = async () => {
    if (stopped) return;
    try {
      const discovery = await readDiscovery(discoveryPath);
      if (!discovery) {
        activeDiscovery = undefined;
        report("unavailable", { discoveryPath });
        return;
      }
      const result = await postJson<RegistrationResponse>(
        discovery,
        "/api/projects/register",
        project,
        validators.registrationResponse,
      );
      activeDiscovery = discovery;
      report("registered", { hubUrl: discovery.url, lastSeen: result.lastSeen });
    } catch (error) {
      activeDiscovery = undefined;
      report("unavailable", { message: error instanceof Error ? error.message : "Registration failed" });
    }
  };

  await checkIn();
  const timer = setInterval(() => void checkIn(), heartbeatMs);
  timer.unref();

  return {
    project,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (!activeDiscovery) return;
      try {
        await postJson<UnregisterResponse>(
          activeDiscovery,
          "/api/projects/unregister",
          { id: project.id },
          validators.unregisterResponse,
        );
      } catch {
        // Heartbeat expiry removes registrations if graceful unregister is unavailable.
      }
    },
  };
}

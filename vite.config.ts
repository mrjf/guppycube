import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { randomBytes } from "node:crypto";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { startDevHubRegistration, type DevHubRegistration } from "./src/dev-registry.ts";
import { renderSchemaAdminPage } from "./src/schema-admin.ts";

function projectUrl(server: ViteDevServer): string | undefined {
  return server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0];
}

function devHubRegistration(): Plugin {
  let registration: DevHubRegistration | undefined;
  return {
    name: "guppycube-dev-hub-registration",
    apply: "serve",
    configureServer(server) {
      const register = async () => {
        const url = projectUrl(server);
        if (!url) {
          console.warn(JSON.stringify({ event: "dev_hub_unavailable", message: "Vite did not expose a project URL" }));
          return;
        }
        console.log(JSON.stringify({ event: "server_started", url }));
        try {
          registration = await startDevHubRegistration({ url, root: server.config.root });
        } catch (error) {
          console.warn(JSON.stringify({
            event: "dev_hub_unavailable",
            message: error instanceof Error ? error.message : "Registration failed",
          }));
        }
      };

      server.httpServer?.once("listening", () => void register());
      server.httpServer?.once("close", () => void registration?.stop());
    },
  };
}

function localSchemaAdmin(): Plugin {
  return {
    name: "guppycube-local-schema-admin",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        if (pathname !== "/admin/schemas") return next();

        const remoteAddress = request.socket.remoteAddress ?? "";
        const isLoopback = remoteAddress === "127.0.0.1"
          || remoteAddress === "::1"
          || remoteAddress === "::ffff:127.0.0.1";
        if (!isLoopback) {
          response.statusCode = 404;
          response.end("Not found.");
          return;
        }

        const nonce = randomBytes(18).toString("base64");
        response.statusCode = 200;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader(
          "Content-Security-Policy",
          `base-uri 'none'; connect-src 'self'; default-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`,
        );
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(renderSchemaAdminPage({ nonce, siteTitle: "Guppycube" }));
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/guppycube/" : "/",
  plugins: [
    localSchemaAdmin(),
    react(),
    cloudflare({
      // Keep local Durable Object rooms across Vite reloads and dev-server restarts.
      persistState: { path: ".wrangler/state" },
    }),
    devHubRegistration(),
  ],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
  },
}));

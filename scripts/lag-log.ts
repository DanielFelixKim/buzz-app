import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

/** Development only: loads the lag recorder before the app and writes its
 * periodic reports to .profiles/lag/<session>.json (the latest report wins). */
export function lagLogPlugin(root: string): Plugin {
  const directory = join(root, ".profiles", "lag");
  return {
    name: "buzz-lag-log",
    apply: "serve",
    transformIndexHtml: {
      order: "pre",
      handler: () => [
        {
          tag: "script",
          attrs: {
            type: "module",
            src: "/src/features/developer/lag-recorder.ts",
          },
          injectTo: "head-prepend",
        },
      ],
    },
    configureServer(server) {
      server.middlewares.use("/__buzz-lag", (request, response) => {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end();
          return;
        }
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
          if (body.length > 16 * 1024 * 1024) request.destroy();
        });
        request.on("end", () => {
          try {
            const report = JSON.parse(body) as { startedAt?: string };
            const name = (report.startedAt ?? "session").replace(
              /[^0-9TZ-]/g,
              "",
            );
            mkdirSync(directory, { recursive: true });
            const file = join(directory, `${name}.json`);
            writeFileSync(`${file}.tmp`, JSON.stringify(report, null, 1));
            renameSync(`${file}.tmp`, file);
            response.statusCode = 204;
          } catch {
            response.statusCode = 400;
          }
          response.end();
        });
      });
    },
  };
}

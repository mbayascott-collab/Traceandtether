import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import { createServer as createViteServer } from "vite";
import { pool } from "./db";
import { registerApiRoutes } from "./routes";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

const app = express();
const server = createServer(app);
const port = Number(process.env.PORT ?? 5000);

app.set("trust proxy", 1);

// Clerk's production proxy must run before body parsers so request bytes stay intact.
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use(express.json({ limit: "64kb" }));
registerApiRoutes(app);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found." });
});

async function start() {
  if (process.env.NODE_ENV === "production") {
    const distPath = path.resolve(process.cwd(), "dist");
    app.use(express.static(distPath, { maxAge: "1h", index: false }));
    app.use(async (req, res, next) => {
      if (req.method !== "GET" || !req.accepts("html")) {
        next();
        return;
      }
      try {
        res.setHeader("Cache-Control", "no-store");
        res.type("html").send(await readFile(path.join(distPath, "index.html"), "utf8"));
      } catch {
        next(new Error("The production frontend has not been built."));
      }
    });
  } else {
    const vite = await createViteServer({
      configFile: path.resolve(process.cwd(), "vite.config.ts"),
      server: {
        middlewareMode: { server },
      },
      appType: "custom",
    });
    app.use(vite.middlewares);
    app.use(async (req, res, next) => {
      if (req.method !== "GET" || !req.accepts("html")) {
        next();
        return;
      }
      try {
        const source = await readFile(path.resolve(process.cwd(), "index.html"), "utf8");
        const html = await vite.transformIndexHtml(req.originalUrl, source);
        res.setHeader("Cache-Control", "no-store");
        res.type("html").send(html);
      } catch (error) {
        vite.ssrFixStacktrace(error as Error);
        next(error);
      }
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(
      "Unhandled application error.",
      error instanceof Error ? error.name : "UnknownError",
    );
    if (!res.headersSent) {
      const candidateStatus =
        typeof error === "object" && error !== null && "status" in error
          ? Number((error as { status: unknown }).status)
          : 500;
      const status = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus < 500
        ? candidateStatus
        : 500;
      const message =
        status === 400
          ? "The request contains invalid JSON."
          : status === 413
            ? "The request body is too large."
            : "The request could not be completed.";
      res.status(status).json({ error: message });
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Business operations app listening on port ${port}.`);
  });
}

start().catch((error) => {
  console.error(
    "Application startup failed.",
    error instanceof Error ? error.name : "UnknownError",
  );
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  });
}

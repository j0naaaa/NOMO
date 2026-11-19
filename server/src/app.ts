import express from "express";
import type { Express } from "express";
import { setupRouter } from "./routes/setup.js";
import { chatRouter } from "./routes/chat.js";
import { robinhoodRouter } from "./routes/robinhood.js";
import { settingsRouter } from "./routes/settings.js";
import { ordersRouter } from "./routes/orders.js";
import { conversationsRouter } from "./routes/conversations.js";
import { memoriesRouter } from "./routes/memories.js";
import { usageRouter } from "./routes/usage.js";
import { adminRouter } from "./routes/admin.js";

export function createApp(): Express {
  const app = express();
  // Browsers on other origins must not control the local broker session.
  app.use((req, res, next) => {
    const localHosts = ["localhost", "127.0.0.1", "[::1]"];
    const origin = req.headers.origin;
    let originHost: string | undefined;
    try { originHost = origin ? new URL(origin).hostname : undefined; } catch { originHost = "invalid"; }
    if (!localHosts.includes(req.hostname) || (originHost && !localHosts.includes(originHost)) ||
        (req.headers["sec-fetch-site"] === "cross-site" && !(req.method === "GET" && req.path === "/api/robinhood/callback"))) {
      res.status(403).json({ error: "Open NOMO on localhost." });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/setup", setupRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/robinhood", robinhoodRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/orders", ordersRouter);
  app.use("/api/conversations", conversationsRouter);
  app.use("/api/memories", memoriesRouter);
  app.use("/api/usage", usageRouter);
  app.use("/api/admin", adminRouter);

  return app;
}

import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { putMedia } from "../clipforge/mediaStore";
import { nanoid } from "nanoid";
import { GUEST_LIMITS } from "../clipforge/contracts";
import { mediaStorageMode } from "../clipforge/mediaStore";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  const allowedWebOrigin = process.env.CLIPFORGE_WEB_ORIGIN?.replace(/\/$/, "");
  app.use((req, res, next) => {
    const requestOrigin = req.header("origin")?.replace(/\/$/, "");
    if (allowedWebOrigin && requestOrigin === allowedWebOrigin) {
      res.header("Access-Control-Allow-Origin", allowedWebOrigin);
      res.header("Vary", "Origin");
      res.header("Access-Control-Allow-Credentials", "true");
      res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-clipforge-visitor, x-clipforge-rights-confirmed, x-clipforge-filename");
      res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      if (req.method === "OPTIONS") return res.sendStatus(204);
    }
    next();
  });
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", service: "clipforge-api", storageMode: mediaStorageMode() });
  });
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  app.post(
    "/api/media/upload",
    express.raw({ type: ["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"], limit: GUEST_LIMITS.maxUploadBytes }),
    async (req, res) => {
      try {
        const visitorId = req.header("x-clipforge-visitor")?.trim();
        const rightsConfirmed = req.header("x-clipforge-rights-confirmed") === "true";
        const sourceName = req.header("x-clipforge-filename")?.trim();
        const mimeType = req.header("content-type")?.split(";")[0].trim();
        const acceptedTypes = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"]);

        if (!visitorId || !/^[a-zA-Z0-9_-]{20,80}$/.test(visitorId)) {
          return res.status(400).json({ message: "Start a new guest session and try the upload again." });
        }
        if (!rightsConfirmed) {
          return res.status(400).json({ message: "Confirm your rights or permission before uploading media." });
        }
        if (!sourceName || !mimeType || !acceptedTypes.has(mimeType) || !Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ message: "Upload an MP4, WebM, MOV, or M4V video file." });
        }
        if (req.body.length > GUEST_LIMITS.maxUploadBytes) {
          return res.status(413).json({ message: "Guest uploads are limited to 250 MB. Trim or compress the source and try again." });
        }

        const safeFilename = sourceName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 150);
        const stored = await putMedia(`clipforge/${visitorId}/source-${nanoid(12)}-${safeFilename}`, req.body, mimeType);
        return res.status(201).json({ key: stored.key, url: stored.url, name: safeFilename, mimeType, sizeBytes: req.body.length });
      } catch (error) {
        console.error("[ClipForge] Upload failed", error);
        return res.status(500).json({ message: "The upload could not be stored. Please try again with a smaller supported file." });
      }
    }
  );
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);

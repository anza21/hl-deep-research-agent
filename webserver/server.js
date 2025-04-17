import express from "express";
import dotenv from "dotenv";
import { dirname } from "path";
import { fileURLToPath } from "url";
import {
  requestLogger,
  corsMiddleware,
  authMiddleware,
  notFoundHandler,
} from "./middleware.js";
import { checkPortAndTerminate } from "./utils.js";
import {
  agentHandler,
  healthHandler,
  cotHandler,
  diaryHandler,
} from "./routes.js";
import {
  runTests,
  getTestResults,
  generateTestResultsHtml,
} from "./test_api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();
const hostname =
  process.env.NODE_ENV === "production" ? "0.0.0.0" : "localhost";
const port = process.env.PORT || 3000;

const app = express();
app.use(express.json());

app.use(requestLogger);
app.use(corsMiddleware);

// Routes that need authentication
app.get("/health", authMiddleware, healthHandler);
app.post("/agent", authMiddleware, agentHandler(__dirname));
app.post("/diary", authMiddleware, diaryHandler(__dirname));
app.post("/cot", authMiddleware, cotHandler(__dirname));

// Test results route - no auth required for easier access
app.get("/test-results", authMiddleware, (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(generateTestResultsHtml());
});

// JSON endpoint for test results
app.get("/test-results/json", (req, res) => {
  res.json(getTestResults());
});

app.use(notFoundHandler);

checkPortAndTerminate(port, hostname).then(() => {
  app.listen(port, hostname, () => {
    console.log(`Server running at http://${hostname}:${port}/`);

    setTimeout(() => {
      const testUrl = `http://${hostname}:${port}`;
      runTests(testUrl);
    }, 1000);
  });
});

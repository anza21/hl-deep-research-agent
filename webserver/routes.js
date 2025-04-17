import { join } from "path";
import { readJsonFile } from "./utils.js";
import { getHyperliquidData } from "./hyperliquid-api.js";
import { promises as fs } from "fs";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const agentSecret = JSON.parse(
  readFileSync(resolve(__dirname, "..", "src", "agentSecret.json"), "utf-8")
);

// Variables to track latest log files
let lastResearchLog = 0;
let lastTradeLog = 0;

// Get latest Chain of Thought from log files
export const getLatestCOT = async (agentId, rootDir) => {
  try {
    const logsDir = join(rootDir, `../data/${agentId}/logs`);

    const logFiles = await fs.readdir(logsDir);

    const logs = logFiles
      .filter((log) => log.endsWith(".json"))
      .map((log) => log.split(".")[0]);

    const researchLogFileName = logs
      .filter((log) => log.startsWith("deepresearch-sectors"))
      ?.map((log) => Number(log.replace("deepresearch-sectors-", "")))
      .filter((log) => log >= lastResearchLog)
      ?.sort((a, b) => b - a)[0];

    const tradeLogFileName = logs
      .filter((log) => log.startsWith("deeptrade"))
      ?.map((log) => Number(log.replace("deeptrade-", "")))
      .filter((log) => log >= lastTradeLog)
      ?.sort((a, b) => b - a)[0];

    let cot = "";

    if (researchLogFileName) {
      lastResearchLog = researchLogFileName;
      const researchLogPath = join(
        logsDir,
        `deepresearch-sectors-${researchLogFileName.toString()}.json`
      );
      const researchLog = await readJsonFile(researchLogPath);
      const thinkMatch = researchLog.choices[0].message.content.match(
        /<think>(.*?)<\/think>/s
      );
      if (thinkMatch) cot = thinkMatch[1];
    }

    if (tradeLogFileName) {
      lastTradeLog = tradeLogFileName;
      const tradeLogPath = join(
        logsDir,
        `deeptrade-${tradeLogFileName.toString()}.json`
      );
      const tradeLog = await readJsonFile(tradeLogPath);
      const thinkMatch = tradeLog.choices[0].message.content.match(
        /<think>(.*?)<\/think>/s
      );
      if (thinkMatch) cot += thinkMatch[1];
    }

    return cot;
  } catch (error) {
    console.error("Error getting latest COT:", error);
    return "";
  }
};

// Get latest diary entries
export const getLatestDiary = async (agentId, rootDir) => {
  try {
    const diaryPath = join(rootDir, `../data/${agentId}/diary/diary.json`);
    const diaryData = await readJsonFile(diaryPath);

    const dates = Object.keys(diaryData).sort((a, b) => {
      const [dayA, monthA, yearA] = a.split("/");
      const [dayB, monthB, yearB] = b.split("/");
      return new Date(`${yearB}-${monthB}-${dayB}`) - new Date(`${yearA}-${monthA}-${dayA}`);
    });

    if (dates.length > 0) {
      const latestDate = dates[0];
      return {
        date: latestDate,
        entries: diaryData[latestDate],
      };
    }

    return { date: null, entries: [] };
  } catch (error) {
    console.error(`Error reading diary for agent ${agentId}:`, error);
    return { date: null, entries: [] };
  }
};

// Load prompt configurations
export const getPromptConfig = async (promptDir) => {
  try {
    const [deepresearch, sysDeepresearch, deeptrade, sysDeeptrade] =
      await Promise.all([
        readJsonFile(join(promptDir, "deepresearch.json")),
        readJsonFile(join(promptDir, "sys-deepresearch.json")),
        readJsonFile(join(promptDir, "deeptrade.json")),
        readJsonFile(join(promptDir, "sys-deeptrade.json")),
      ]);

    return {
      deepresearch,
      sysDeepresearch,
      deeptrade,
      sysDeeptrade,
    };
  } catch (error) {
    console.error("Error loading prompt configuration:", error);
    throw error;
  }
};

// ✅ Agent endpoint handler (με fallback)
export const agentHandler = (rootDir) => async (req, res) => {
  const agentId = req.body && req.body.agent_id;

  if (!agentId) {
    return res.status(400).json({ message: "agent_id is required" });
  }

  const configPath = join(rootDir, `../data/${agentId}/config.json`);

  try {
    let config;
    try {
      config = await readJsonFile(configPath);
    } catch (error) {
      console.error(`Error reading config for agent ${agentId}:`, error);
      return res.status(404).json({ message: `Agent ${agentId} not found` });
    }

    const prompts = await getPromptConfig(join(rootDir, "../src/prompt"));

    let balance = 0;
    let trade_count = 0;
    let clearinghouseState = {};
    let openOrders = [];
    let pnl = [];

    try {
      const result = await getHyperliquidData(agentSecret[agentId].accountAddress);
      balance = result.balance;
      trade_count = result.trade_count;
      clearinghouseState = result.clearinghouseState;
      openOrders = result.openOrders;
      pnl = result.pnl;
    } catch (err) {
      console.warn(`⚠️ Mocking data for user ${agentSecret[agentId].accountAddress} due to error: ${err.message}`);
    }

    const response = {
      ...config,
      wallet_address: agentSecret[agentId].accountAddress,
      trade_count,
      balance,
      clearinghouseState,
      pnl,
      openOrders,
      prompts,
      created_at: Date.parse("2025-03-14T00:00:00Z"),
      updated_at: Date.now(),
    };

    res.json(response);
  } catch (error) {
    console.error("Error in /agent endpoint:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Dedicated COT endpoint
export const cotHandler = (rootDir) => async (req, res) => {
  try {
    const agentId = req.body && req.body.agent_id;
    if (!agentId) return res.status(400).json({ message: "agent_id is required" });

    const cot = await getLatestCOT(agentId, rootDir);
    res.json({ cot });
  } catch (error) {
    console.error("Error retrieving COT data:", error);
    res.status(500).json({ message: "Error retrieving COT data" });
  }
};

// Diary endpoint
export const diaryHandler = (rootDir) => async (req, res) => {
  try {
    const agentId = req.body && req.body.agent_id;
    if (!agentId) return res.status(400).json({ message: "agent_id is required" });

    const diaryData = await getLatestDiary(agentId, rootDir);
    res.json(diaryData);
  } catch (error) {
    console.error("Error retrieving diary data:", error);
    res.status(500).json({ message: "Error retrieving diary data" });
  }
};

// Health endpoint
export const healthHandler = (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
};

// Optional test endpoint
export const testResultHandler = (req, res) => {
  // unused
};

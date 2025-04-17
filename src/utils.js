import path, { dirname } from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { JSDOM } from "jsdom";

import dotenv from "dotenv";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const truncate = (text, n = 100) => {
  return text.length > n ? text.substr(0, n - 1) + "..." : text;
};

const convertTimestampToAgo = (timestamp) => {
  // convert timestamp to how long ago
  // e.g. if time difference is less than 1 minute, return 'just now'
  // if time difference is less than 1 hour, return 'x mins ago'
  // if time difference is less than 1 day, return 'x hours ago'
  // if time difference is less than 1 week, return 'x days ago'
  // if time difference is less than 1 month, return 'x weeks ago'
  // other wise return 'x months ago'

  const now = Date.now();
  const diff = now - timestamp;
  const diffInSeconds = Math.floor(diff / 1000);
  const diffInMinutes = Math.floor(diff / (1000 * 60));
  const diffInHours = Math.floor(diff / (1000 * 60 * 60));
  const diffInDays = Math.floor(diff / (1000 * 60 * 60 * 24));
  const diffInWeeks = Math.floor(diff / (1000 * 60 * 60 * 24 * 7));
  const diffInMonths = Math.floor(diff / (1000 * 60 * 60 * 24 * 30));

  if (diffInSeconds < 60) {
    return "just now";
  } else if (diffInMinutes < 60) {
    return `${diffInMinutes} mins ago`;
  } else if (diffInHours < 24) {
    return `${diffInHours} hours ago`;
  } else if (diffInDays < 7) {
    return `${diffInDays} days ago`;
  } else if (diffInWeeks < 4) {
    return `${diffInWeeks} weeks ago`;
  } else {
    return `${diffInMonths} months ago`;
  }
};

const extractDOM = (text, tag) => {
  if (!text || !tag) return [];

  const firstTag = `<${tag}>`;
  const lastTag = `</${tag}>`;
  const firstTagIndex = text.indexOf(firstTag);
  const lastTagIndex = text.lastIndexOf(lastTag);

  if (
    firstTagIndex === -1 ||
    lastTagIndex === -1 ||
    firstTagIndex >= lastTagIndex
  )
    return null;

  const content = text.substring(firstTagIndex, lastTagIndex + lastTag.length);
  const dom = new JSDOM(content);
  const element = dom.window.document.querySelector(tag);
  return element;
};

const extract = (text, tag, params = { removeComments: false }) => {
  if (!text || !tag) return [];

  // First, remove any <think> blocks to prevent processing wrong data
  const cleanedText = text.replace(/<think>[\s\S]*?<\/think>/g, "");

  const regex = new RegExp(`<${tag}>(.*?)</${tag}>`, "gs");
  const matches = [...cleanedText.matchAll(regex)];

  if (matches.length === 0) return [];

  return matches.map((match) => {
    let content = match[1]?.trim() || "";

    if (content) {
      // Clean JSON-like content
      const lines = content
        .split("\n")
        .map((line) => {
          // Remove comments and whitespace
          if (params.removeComments) {
            line = line.split("//")[0].trim();
          }
          return line.trim();
        })
        .filter((line) => line.length > 0);

      content = lines
        .join("\n")
        // Remove trailing commas that would break JSON parsing
        .replace(/,(\s*?[\}\]])/g, "$1")
        // Remove any remaining comment-like fragments
        .replace(/\/\/.*/g, "")
        .trim();
    }

    return content;
  });
};

const queryChatCompletion = async (
  endpoint,
  model,
  messages,
  params = { modelParams: {}, retries: 0 }
) => {
  if (process.env.DEBUG === "TRUE") {
    [endpoint, model] = process.env.DEBUG_MODEL.split("||");
  }

  const url = `https://${endpoint}/chat/completions`;
  const apiKeys = {
    "api.perplexity.ai": process.env.PERPLEXITY_API_KEY,
    "openrouter.ai/api/v1": process.env.OPENROUTER_API_KEY,
  };
  const maxRetries = params.retries || 3;
  let currentRetry = 0;
  let lastError = null;

  while (currentRetry <= maxRetries) {
    let response;
    try {
      const requestBody = {
        model: model,
        messages: messages,
        ...params.modelParams,
      };

      console.log(`[DEBUG] Using model: ${model}, endpoint: ${endpoint}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 600000); // 10 mins timeout

      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKeys[endpoint]}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
        keepalive: true,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      const responseJson = await response.json();
      return responseJson;
    } catch (error) {
      lastError = error;

      // Format error message
      let errorMessage;
      if (error.name === "AbortError") {
        errorMessage = `[${endpoint}] Request timed out after 60 seconds`;
      } else if (
        error.name === "TypeError" &&
        error.message.includes("fetch failed")
      ) {
        errorMessage = `[${endpoint}] Network connection error: ${error.message}`;
      } else if (error.message.includes("socket")) {
        errorMessage = `[${endpoint}] Socket error: Connection closed unexpectedly`;
      } else {
        errorMessage = `[${endpoint}] ${error.message}`;
      }

      // If we have retries left, try again
      if (currentRetry < maxRetries) {
        console.log(`Retry ${currentRetry + 1}/${maxRetries}: ${errorMessage}`);
        currentRetry++;
        // Exponential backoff: 1s, 2s, 4s, etc.
        const backoffTime = Math.pow(2, currentRetry) * 1000;
        await new Promise((resolve) => setTimeout(resolve, backoffTime));
      } else {
        // No more retries, throw the error
        throw new Error(errorMessage);
      }
    }
  }

  // This should never be reached due to the throw in the catch block
  throw lastError;
};

function calculateTPSLOrderPNL(order, entryPrice) {
  if (!order.reduceOnly) return null;

  const isClosingLong = order.side === "sell";
  const isClosingShort = order.side === "buy";

  // use trigger as exit price because its the actual price at which the order was closed
  const exitPrice = order.triggerPx;

  let pnlPercent = 0;
  let pnlUsd = 0;

  if (isClosingLong) {
    pnlPercent = (((exitPrice - entryPrice) / entryPrice) * 100).toFixed(2);
    pnlUsd = (exitPrice - entryPrice) * order.sz;
  }

  if (isClosingShort) {
    pnlPercent = ((entryPrice - exitPrice) / entryPrice) * 100;
    pnlUsd = (entryPrice - exitPrice) * order.sz;
  }

  const orderType = pnlPercent >= 0 ? `Take Profit` : `Stop Loss`;

  return {
    pnlPercent: pnlPercent + "%",
    pnlUsd: pnlUsd.toFixed(2) + " USD",
    orderType,
  };
}

// Moved and improved prompt handling function
const getPrompt = function getPrompt(promptName, params = {}) {
  try {
    // Load the prompt JSON file
    const promptPath = path.join(__dirname, "prompt", `${promptName}.json`);
    const promptContent = JSON.parse(fs.readFileSync(promptPath, "utf8"));

    // Get the template from the JSON file
    let template = promptContent.template;

    // Handle array templates by joining with newlines
    if (Array.isArray(template)) {
      template = template.join("\n");
    }

    // Find all parameters in the template using regex {{paramName}}
    const paramRegex = /\{\{([^}]+)\}\}/g;
    const requiredParams = [];
    let match;

    // Extract all required parameters
    while ((match = paramRegex.exec(template)) !== null) {
      requiredParams.push(match[1].trim());
    }

    // Check if all required parameters are provided
    const missingParams = requiredParams.filter(
      (param) => params[param] === undefined
    );
    if (missingParams.length > 0) {
      throw new Error(
        `Missing required parameters for prompt '${promptName}': ${missingParams.join(
          ", "
        )}`
      );
    }

    // Replace all parameters in the template
    let formattedPrompt = template;
    for (const param of requiredParams) {
      const value = params[param];
      // Handle different types of values (arrays, objects, etc.)
      const replacementValue =
        typeof value === "object"
          ? JSON.stringify(value, null, 2)
          : String(value);

      formattedPrompt = formattedPrompt.replace(
        new RegExp(`\\{\\{${param}\\}\\}`, "g"),
        replacementValue
      );
    }

    return formattedPrompt;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Prompt '${promptName}' not found`);
    }
    throw error;
  }
};

export {
  truncate,
  convertTimestampToAgo,
  extract,
  extractDOM,
  getPrompt,
  queryChatCompletion,
  calculateTPSLOrderPNL,
};

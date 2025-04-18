import {
  truncate,
  queryChatCompletion,
  getPrompt,
  extract,
  extractDOM,
  convertTimestampToAgo,
} from "./utils.js";
import {
  getCandlesCSVLike,
  getCoinsByFundingRate,
  getHistoricalOrders,
  getOpenOrdersAndPositions,
} from "./api/hyperliquid/info.js";
import { calculateTPSLOrderPNL } from "./utils.js";
import { getSimpleTools } from "./tools/tools.js";
import fs from "fs";
import path from "path";

class HLDeepResearchAgent {
  constructor(agent, config) {
    this.config = { ...config, ...agent };
    this.runId = Date.now();
    this.agentId = agent.agentId;
    this.agentDataDir = path.join(config.agentDataDir, agent.agentId);
    if (!this.agentDataDir) throw new Error("Agent data directory is required");
    this.initAgentData();
  }

  async runOnce() {
    try {
      this.runId = Date.now();
      const agent = (await this.loadAgentData("", "config")) || this.config;
      const lastRunId = agent.lastRunId || 0;
      const shouldRun = Date.now() - (lastRunId + this.config.tradeFrequency);
      if (shouldRun < 0) {
        console.log(`[${this.agentId}] Trade frequency not met, sleeping...`);
        return;
      }

      await this.broadcast(
        `Beginning agent loop ${this.runId}...`,
        "INFO",
        true
      );
      const { direction, marketReasons } = await this.researchMarketBelief();
      if (!direction || !direction.textContent || !marketReasons || !marketReasons.textContent) {
        this.broadcast("❌ Market belief extraction failed. Skipping sector research.", "ERROR");
        return;
      }

      const sectors = await this.researchSectors(direction, marketReasons);

      for (let sector of sectors.children) {
        const name = sector.querySelector("name").textContent;
        const reasons = sector.querySelector("reasons").textContent;
        const { data, coinToPrice } = await this.research(name);
        await this.trade(data, coinToPrice);
      }

      agent.lastRunId = Date.now(); // update last run id
      await this.storeAgentData("", "config", agent);
      this.broadcast(`---\nEnd of agent loop, entering sleep mode...`);
      return;
    } catch (error) {
      this.broadcast(`${error.message}\n${error.stack}`, "ERROR");
      return;
    }
  }

  // find market belief if long or short, reasons, and duration of applicability
  async researchMarketBelief() {
    this.broadcast("---\nResearching market belief...");
    const research_prompt = getPrompt("deepresearch-market", {});

    // ➤ Φτιάχνουμε σωστά τα endpoint/model
    let endpoint, model;
    if (this.config.researchModel.includes("||")) {
      [endpoint, model] = this.config.researchModel.split("||");
    } else {
      endpoint = "openrouter.ai/api/v1"; // DEFAULT endpoint
      model = this.config.researchModel;
    }

    const response = await queryChatCompletion(
      endpoint,
      model,
      [{ role: "user", content: research_prompt }],
      { retries: this.config.retryLimit }
    );

    await this.storeAgentData("logs", `deepresearch-market-${this.runId}`, response);

    const research = response.choices[0].message.content;
    const direction = extractDOM(research, "direction");
    const marketReasons = extractDOM(research, "reasons");
    const marketApplicability = extractDOM(research, "applicability");

    this.broadcast(
      `Identified market belief: ${direction.textContent} (${marketApplicability.textContent} days), ${marketReasons.textContent}`
    );

    return { direction, marketReasons, marketApplicability };
  }

  // find sectors that should align with market belief, reasons, and duration of applicability
  async researchSectors(direction, marketReasons) {
    this.broadcast("---\nResearching sectors...");
    const research_prompt = getPrompt("deepresearch-sectors", {
      direction,
      marketReasons,
      allSectors: this.config.sectors,
    });
    const [endpoint, model] = this.config.researchModel.includes("||")
      ? this.config.researchModel.split("||")
      : ["openrouter.ai/api/v1", this.config.researchModel];

    const response = await queryChatCompletion(
      endpoint,
      model,
      [{ role: "user", content: research_prompt }],
      { retries: this.config.retryLimit }
    );

    await this.storeAgentData(
      "logs",
      `deepresearch-sectors-${this.runId}`,
      response
    );

    const research = response.choices[0].message.content;
    const sectors = extractDOM(research, "sectors");
    let message = "Identified sectors: ";
    for (let sector of sectors.children) {
      const name = sector.querySelector("name").textContent;
      const reasons = sector.querySelector("reasons").textContent;
      message += `${name}: ${truncate(reasons)}\n`;
    }
    this.broadcast(message);

    return sectors;
  }

  // find coins for sector
  async research(sector) {
    // fetch list of coins from hyperliquid sectors
    // - filtered by volume threshold
    // - sorted by funding rate difference
    const volumeThreshold = 10000; // 10k
    const { coinToPrice, coinsByDiff } = await getCoinsByFundingRate(
      sector,
      volumeThreshold
    );

    // convert to csv, limit to params.coinLookupLimit
    let coinsTable = ["coin,price"]; // csv format for less tokens
    coinsByDiff
      .slice(0, this.config.researchParams.coinLookupLimit)
      .map((coin) => {
        coinsTable.push(`${coin.price},${coin.coin}`);
      });
    coinsTable = coinsTable.join("\n");

    // fetch previous research from rag
    // add today's price to the coins + change from timestamp to how long ago
    // let LLM do its own reflection
    const rag =
      (await this.loadAgentData("deepresearch-coins", `${sector}`)) ?? "None";
    const ragData = [];

    if (rag !== "None" || !rag) {
      const limit = Math.min(
        this.config.researchParams.ragLookupLimit,
        rag.length
      );
      for (let i = 0; i < limit; i++) {
        const research = rag[i];
        const { runId, identified_coins, market_bias, market_bias_reason } =
          research;

        // Calculate price changes for all coins
        let totalPriceChange = 0;
        identified_coins.forEach((coin) => {
          coin.old = coin.price;
          coin.today = coinToPrice[coin.coin];
          coin.price_change = (
            ((coin.today - coin.old) / coin.old) *
            100
          ).toFixed(2);
          totalPriceChange += parseFloat(coin.price_change);
        });

        // Format and add analysis data
        const avgPriceChange = (
          totalPriceChange / identified_coins.length
        ).toFixed(2);
        const timeAgo = convertTimestampToAgo(runId);

        ragData.push(
          `ANALYSIS FROM ${timeAgo}`,
          `Bias: ${market_bias}`,
          `Reason: ${truncate(market_bias_reason)}`,
          `Identified Coins:`
        );

        identified_coins.forEach((coin) => {
          ragData.push(
            `- ${coin.coin}: OLD $${coin.old} -> TODAY $${coin.today} (${coin.price_change}%)`
          );
        });

        ragData.push(`Overall Price Change: ${avgPriceChange}%`);
        ragData.push("");

        const timeDiff = Date.now() - runId;
        if (timeDiff < 10 * 60 * 1000) {
          this.broadcast(
            `---\nRecent research still applicable:\n${ragData.join("\n")}`
          );
          return { data: research, coinToPrice };
        }
      }
    }
    if (ragData.length > 0) {
      this.broadcast(
        `---\nRetrieved previous research:\n${ragData.join("\n")}`
      );
    }

    // batch research the coins with prompt
    const research_system = getPrompt("sys-deepresearch", {
      persona: this.config.persona,
      recentAnalysis: ragData.join("\n"),
      maxLeverage: this.config.maxLeverage,
      minOrderSize: this.config.minOrderSize,
    });

    const research_prompt = getPrompt("deepresearch", {
      sector: sector.toUpperCase(),
      coins: coinsTable,
      limit: this.config.researchParams.identifyCoinLimit,
    });

    this.broadcast(
      `Researching ${this.config.researchParams.coinLookupLimit} coins in ${sector}, identifying ${this.config.researchParams.identifyCoinLimit} coins...`
    );

    let endpoint, model;
    if (this.config.researchModel.includes("||")) {
      [endpoint, model] = this.config.researchModel.split("||");
    } else {
      endpoint = "openrouter.ai/api/v1"; // DEFAULT endpoint
      model = this.config.researchModel;
    }

    const response = await queryChatCompletion(
      endpoint,
      model,
      [
        { role: "system", content: research_system },
        { role: "user", content: research_prompt },
      ],
      { retries: this.config.retryLimit }
    );

    this.storeAgentData("logs", `deepresearch-sectors-${this.runId}`, response);

    const research = response.choices[0].message.content;

    // add market bias research deepresearch to rag
    const market_bias = extract(research, "market_bias")[0];
    const market_bias_reason = extract(research, "market_bias_reason")[0];
    const identified_coins = JSON.parse(
      extract(research, "identified_coins")[0]
    );

    const data = {
      market_bias,
      market_bias_reason,
      identified_coins,
      runId: this.runId,
    };

    const sectorResearchHistory =
      (await this.loadAgentData("deepresearch-coins", `${sector}`)) || [];
    sectorResearchHistory.unshift(data);
    await this.storeAgentData(
      "deepresearch-coins",
      `${sector}`,
      sectorResearchHistory
    );

    this.broadcast(
      `Identified market bias: ${market_bias.toUpperCase()} ${sector}, ${truncate(
        market_bias_reason
      )}.\n${identified_coins
        .map((coin) => `- ${coin.coin}: $${coin.price}, ${coin.analysis}`)
        .join("\n")}`
    );

    return { data, coinToPrice };
  }

  async trade(research, coinToPrice) {
    // get rag data from deeptrade/placeOrders.json
    const ragData = [];
    const previousOrders = await this.loadAgentData("deeptrade", "placeOrders");
    if (previousOrders) {
      const historicalOrders = await getHistoricalOrders(this.agentId);
      let count = 0;
      for (const order of historicalOrders) {
        if (!order.order.reduceOnly) continue; // only reduce only orders (stop loss and take profit)
        if (order.status != "cancelled" && order.status != "triggered")
          continue; // only cancelled or triggered orders
        if (count > this.config.tradeParams.orderLookupLimit) break;
        const o = order.order;
        // Check if order ID exists in previousOrders
        if (!Object.keys(previousOrders).includes(o.oid.toString())) continue;
        const ago = convertTimestampToAgo(o.timestamp);

        const { mainOrderEntry, orderType, reason, leverage } =
          previousOrders[o.oid];

        const { pnlPercent, pnlUsd } = calculateTPSLOrderPNL(o, mainOrderEntry);

        const price_now = coinToPrice[o.coin.replace("-PERP", "")];
        const currentPriceDiff = (
          ((price_now - o.triggerPx) / o.triggerPx) *
          100
        ).toFixed(2);

        ragData.push(`${o.coin} ${leverage}x ${ago}`);
        ragData.push(`- Entry Price: ${mainOrderEntry}`);
        ragData.push(`- ${orderType} ${order.status} at ${o.triggerPx}`);
        ragData.push(`- PnL: ${pnlPercent} ($${pnlUsd})`);
        ragData.push(`- Current Price: ${price_now} (${currentPriceDiff}%)`);
        ragData.push(`- Original Thesis: ${reason}`);
        count++;
      }
    }
    if (ragData.length > 0) {
      this.broadcast(
        `---\nRetrieved previous trades:\n${ragData.join("\n")}\n`
      );
    }

    // reduce context window, only extract market_bias and coins from research
    const { market_bias, identified_coins } = research;

    // fetch candles for each coin
    const candles = [];
    for (const coin of identified_coins) {
      // Adjust candle interval and lookback period based on trading frequency
      const tradeFrequencyHours = this.config.tradeFrequency / 1000 / 60 / 60;
      const interval = tradeFrequencyHours <= 1 ? "15m" : "1h";
      const hoursAgo = tradeFrequencyHours <= 1 ? 2 : 24;
      const candle = await getCandlesCSVLike(coin.coin, interval, hoursAgo); // this is a list of strings
      candles.push(`${coin.coin} past ${hoursAgo}h (${interval} interval)`);
      candles.push(...candle);
      candles.push("");
    }

    // fetch positions and open orders
    const { clearingHouseState, openOrders } = await getOpenOrdersAndPositions(
      this.agentId
    );
    delete clearingHouseState.time;
    delete clearingHouseState.withdrawable;
    delete clearingHouseState.crossMarginSummary;
    delete clearingHouseState.crossMaintenanceMarginUsed;

    const open_orders = openOrders;
    open_orders.forEach((order) => {
      // B = Bid = Buy/Long, A = Ask = Short
      order.side = order.side === "B" ? "long" : "short";
      order.type = Object.keys(order).includes("reduceOnly")
        ? "TP/SL"
        : "LIMIT";
      order.amount = order.sz;
      delete order.sz;
      delete order.timestamp;
    });

    const trade_tools = getSimpleTools(["trading"]);
    const trade_system = getPrompt("sys-deeptrade", {
      persona: this.config.persona,
      trade_tools,
      clearingHouseState,
      open_orders,
      previousTrade: ragData.join("\n"),
      tradeFrequencyHours: this.config.tradeFrequency / 1000 / 60 / 60,
      maxLeverage: this.config.maxLeverage,
      minOrderSize: this.config.minOrderSize,
    });
    const trade_prompt = getPrompt("deeptrade", {
      identified_coins,
      market_bias,
      candles: candles.join("\n"),
    });
    this.broadcast("Researching TA-based trade decisions...");
    let endpoint, model;
    if (this.config.tradeModel.includes("||")) {
      [endpoint, model] = this.config.tradeModel.split("||");
    } else {
      endpoint = "openrouter.ai/api/v1"; // DEFAULT endpoint
      model = this.config.tradeModel;
    }

    const response = await queryChatCompletion(
      endpoint,
      model,
      [
        { role: "system", content: trade_system },
        { role: "user", content: trade_prompt },
      ],
      { retries: this.config.retryLimit }
    );

    await this.storeAgentData("logs", `deeptrade-${this.runId}`, response);
    const content = response.choices[0].message.content;
    for (const tool of trade_tools) {
      const tool_name = tool.name;
      const tool_contents = extract(content, tool_name, {
        removeComments: true,
      });
      if (tool_contents.length == 0) continue;
      for (const _tool_content of tool_contents) {
        const tool_content = _tool_content.replaceAll("\n", "");
        this.broadcast(`Executing tool: ${tool_name}\n${tool_content}...`);
        let orders = JSON.parse(tool_content);
        if (!Array.isArray(orders)) orders = [orders];
        for (const order of orders) {
          const result = await tool.fn(order, this.agentId);
          // if successfully placed order, store order data
          if (tool_name === "placeOrders" && !result.error) {
            const orderId = result.filled?.oid || result.resting?.oid;
            const data =
              (await this.loadAgentData("deeptrade", `placeOrders`)) || {};
            const orderData = {
              coin: order.coin,
              leverage: order.leverage,
              mainOrderEntry: order.entry, // limitPx
              reason: order.reason,
            };
            // order seqenece: mainOrder -> tpOrder -> slOrder (from function)
            data[orderId] = { ...orderData, orderType: "main" };
            data[parseInt(orderId) + 1] = {
              ...orderData,
              orderType: "Take Profit",
            };
            data[parseInt(orderId) + 2] = {
              ...orderData,
              orderType: "Stop Loss",
            };
            await this.storeAgentData("deeptrade", `placeOrders`, data);
          }
        }
      }
    }
  }

  async initAgentData() {
    if (!fs.existsSync(this.agentDataDir)) {
      fs.mkdirSync(this.agentDataDir, { recursive: true });
    }

    const configPath = path.join(this.agentDataDir, "config.json");
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
    } else {
      const existingConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const updatedConfig = { ...existingConfig, ...this.config };
      fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));
    }

    const folders = [
      "deepresearch-sectors",
      "deepresearch-coins",
      "deeptrade",
      "diary",
      "logs",
    ];

    const baseDir = path.join(this.agentDataDir);
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    folders.forEach((folder) => {
      const folderPath = path.join(baseDir, folder);
      if (!fs.existsSync(folderPath))
        fs.mkdirSync(folderPath, { recursive: true });
    });

    // limit every json in file of deepresearch-coins to only have 50 entries
    const deepresearchCoinsDir = path.join(baseDir, "deepresearch-coins");
    const files = fs.readdirSync(deepresearchCoinsDir);
    files.forEach((file) => {
      const filePath = path.join(deepresearchCoinsDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      data.slice(0, 50);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    });

    return baseDir;
  }

  async storeAgentData(folder, filename, data) {
    const filePath = path.join(this.agentDataDir, folder, `${filename}.json`);
    try {
      // Create the directory if it doesn't exist
      const dirPath = path.dirname(filePath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error(`Error writing data file: ${e.message}`);
    }
  }

  async loadAgentData(folder, filename) {
    const filePath = path.join(this.agentDataDir, folder, `${filename}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const fileContent = fs.readFileSync(filePath, "utf8");
      if (!fileContent || fileContent.trim() === "") return null;
      return JSON.parse(fileContent);
    } catch (e) {
      console.error(`Error reading data file: ${e.message}`);
      return null;
    }
  }

  async broadcast(message, type = "INFO", newMessage = false) {
    console.log(`[${this.config.agentId}] ${type} : ${message}`);
    await this.writeDiary(message);

    if (this.config.telegram) {
      const telegramApiUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
      const messageTitle = `[${this.config.agentId}]`;
      try {
        if (newMessage) {
          this.telegramMessage = message;
          const response = await fetch(`${telegramApiUrl}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: process.env.TELEGRAM_CHAT_ID,
              text:
                messageTitle +
                "<blockquote>" +
                this.telegramMessage +
                "</blockquote>",
              parse_mode: "HTML",
            }),
          });
          const data = await response.json();
          if (data.ok) this.telegramMessageId = data.result.message_id;
        } else if (this.telegramMessageId) {
          this.telegramMessage += "\n" + message;
          await fetch(`${telegramApiUrl}/editMessageText`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: process.env.TELEGRAM_CHAT_ID,
              message_id: this.telegramMessageId,
              text:
                messageTitle +
                "<blockquote>" +
                this.telegramMessage +
                "</blockquote>",
              parse_mode: "HTML",
            }),
          });
        }
      } catch (error) {
        console.error(`Telegram API error: ${error.message}`);
      }
    }
  }

  async writeDiary(message) {
    const data = (await this.loadAgentData("diary", "diary")) || {};
    const today = new Date().toLocaleDateString("en-GB");
    if (!data[today]) data[today] = [];
    data[today].push(message);
    const sevenDaysAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000
    ).toLocaleDateString("en-GB");
    for (const key in data) {
      if (key < sevenDaysAgo) delete data[key];
    }
    await this.storeAgentData("diary", "diary", data);
  }
}

export default HLDeepResearchAgent;

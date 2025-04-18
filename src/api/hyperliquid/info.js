import { sdkAgents } from "./init.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, "./coinsInSectors.json"), "utf-8")
);

const getCoinsByFundingRate = async (sector, minVolume) => {
  const sdk = Object.values(sdkAgents)[0];
  const metadata = await sdk.info.perpetuals.getMetaAndAssetCtxs();

  const coins = sectors[sector].map((coin) => `${coin}-PERP`);

  const coinsByFundingPositive = [];
  const coinsByFundingNegative = [];
  const coinToFunding = {};
  const coinToPrice = {};

  // Process each coin in the metadata
  for (let j = 0; j < metadata[1].length; j++) {
    const coinName = metadata[0]["universe"][j]["name"];

    // Check if this coin is in our sector
    if (coins.includes(coinName)) {
      const coinContext = metadata[1][j];
      coinToPrice[coinName] = Number(coinContext["midPx"]);

      // Only process coins with sufficient volume
      if (coinContext["dayNtlVlm"] >= minVolume) {
        coinToFunding[coinName] = Number(coinContext["funding"]);

        // Sort into positive or negative funding arrays
        if (coinToFunding[coinName] > 0) {
          // Insert into positive funding array in sorted order
          let low = 0;
          let high = coinsByFundingPositive.length;
          while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (
              coinToFunding[coinName] >
              coinToFunding[coinsByFundingPositive[mid]]
            ) {
              high = mid;
            } else {
              low = mid + 1;
            }
          }
          coinsByFundingPositive.splice(low, 0, coinName);
        } else {
          // Insert into negative funding array in sorted order
          let low = 0;
          let high = coinsByFundingNegative.length;
          while (low < high) {
            // Fixed the condition here (was low <= high)
            const mid = Math.floor((low + high) / 2);
            if (
              coinToFunding[coinName] <
              coinToFunding[coinsByFundingNegative[mid]]
            ) {
              high = mid;
            } else {
              low = mid + 1;
            }
          }
          coinsByFundingNegative.splice(low, 0, coinName);
        }
      }
    }
  }

  // Convert arrays to objects with price and funding info
  coinsByFundingNegative.forEach((coin, index) => {
    coinsByFundingNegative[index] = {
      coin,
      price: coinToPrice[coin],
      funding: coinToFunding[coin],
    };
  });

  coinsByFundingPositive.forEach((coin, index) => {
    coinsByFundingPositive[index] = {
      coin,
      price: coinToPrice[coin],
      funding: coinToFunding[coin],
    };
  });

  const coinsByDiff = [...coinsByFundingPositive, ...coinsByFundingNegative];

  // sort by funding difference, ignore negative, from highest difference to lowest
  coinsByDiff.sort((a, b) => {
    const aDiff = Math.abs(a.funding);
    const bDiff = Math.abs(b.funding);
    return bDiff - aDiff;
  });

  return { coinToPrice, coinsByDiff, coinsByFundingPositive, coinsByFundingNegative };
};

const getOpenOrdersAndPositions = async (agentId) => {
  const sdk = sdkAgents[agentId];
  const clearingHouseState = await sdk.info.perpetuals.getClearinghouseState(
    sdk.custom.walletAddress
  );
  const positions = clearingHouseState.assetPositions.map(
    (position) => position.position
  );
  const openOrders = await sdk.info.getUserOpenOrders(
    sdk.custom.walletAddress
  );

  return { clearingHouseState, positions, openOrders };
};

const getHistoricalOrders = async (agentId) => {
  const sdk = sdkAgents[agentId];
  return await sdk.info.getHistoricalOrders(
    sdk.custom.walletAddress
  );
};

const getCandleSnapshot = async (coin, interval = "15m", hoursAgo = 6) => {
  const sdk = Object.values(sdkAgents)[0];
  const timestamp = Date.now() - (hoursAgo * 60 * 60 * 1000);
  return await sdk.info.getCandleSnapshot(coin, interval, timestamp, Date.now());
};

const getCandlesCSVLike = async (coin, interval = "1h", hoursAgo = 24) => {
  const candles = await getCandleSnapshot(coin, interval, hoursAgo);
  let data = [`open,high,low,close,volume`];
  for (const candle of candles) {
    data.push(`${candle.o},${candle.h},${candle.l},${candle.c},${candle.v}`);
  }
  return data
};

export { getCoinsByFundingRate, getOpenOrdersAndPositions, getHistoricalOrders, getCandleSnapshot, getCandlesCSVLike };

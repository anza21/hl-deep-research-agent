import dotenv from "dotenv";
dotenv.config();

const getApiUrl = () => {
  const isMainnet = process.env.ISMAINNET === "TRUE";
  const apiUrl = isMainnet
    ? "https://api.hyperliquid.xyz"
    : "https://api.hyperliquid-testnet.xyz";

  return `${apiUrl}/info`;
};

const fetchHyperliquidData = async (requestType, user) => {
  const infoURL = getApiUrl();

  try {
    const response = await fetch(infoURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: requestType,
        user: user,
      }),
    });

    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      throw new Error("Invalid JSON response from Hyperliquid API");
    }

    return await response.json();
  } catch (error) {
    console.warn(`⚠️ Mocking ${requestType} for user ${user} due to error: ${error.message}`);
    // Return mock data
    if (requestType === "portfolio") {
      return [
        [
          "perpAllTime",
          {
            accountValueHistory: [
              [0, "200.00"],
              [1, "210.00"],
            ],
            pnlHistory: [
              [0, "0.00"],
              [1, "10.00"],
            ],
          },
        ],
      ];
    } else if (requestType === "userFills") {
      return [];
    } else if (requestType === "openOrders") {
      return [];
    } else if (requestType === "clearinghouseState") {
      return { status: "ok" };
    }

    return {};
  }
};

export const getHyperliquidData = async (walletAddress) => {
  try {
    const [userFills, clearinghouseState, openOrders, portfolio] =
      await Promise.all([
        fetchHyperliquidData("userFills", walletAddress),
        fetchHyperliquidData("clearinghouseState", walletAddress),
        fetchHyperliquidData("openOrders", walletAddress),
        fetchHyperliquidData("portfolio", walletAddress),
      ]);

    const latestBalance = portfolio
      .find((item) => item[0] === "perpAllTime")[1]
      .accountValueHistory.at(-1)[1];

    const pnl = portfolio.map(([timeframe, data]) => {
      const accountValueHistory = data.accountValueHistory || [];
      const pnlHistory = data.pnlHistory || [];

      const avgAccountValue =
        accountValueHistory.reduce(
          (sum, [_, value]) => sum + parseFloat(value),
          0
        ) / accountValueHistory.length || 0;

      const avgPnl =
        pnlHistory.reduce((sum, [_, value]) => sum + parseFloat(value), 0) /
          pnlHistory.length || 0;

      const accountValueChange =
        parseFloat(accountValueHistory.at(-1)?.[1] || 0) -
        parseFloat(accountValueHistory.at(0)?.[1] || 0);

      const pnlChange =
        parseFloat(pnlHistory.at(-1)?.[1] || 0) -
        parseFloat(pnlHistory.at(0)?.[1] || 0);

      return {
        timeframe,
        stats: {
          avgAccountValue: avgAccountValue.toFixed(4),
          avgPnl: avgPnl.toFixed(4),
          accountValueChange: accountValueChange.toFixed(4),
          pnlChange: pnlChange.toFixed(4),
        },
      };
    });

    return {
      pnl,
      balance: latestBalance,
      trade_count: userFills.length,
      clearinghouseState,
      openOrders,
    };
  } catch (error) {
    console.error("❌ Fatal error in getHyperliquidData:", error);
    throw error;
  }
};

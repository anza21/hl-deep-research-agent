import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const sendTelegramMessage = async (message) => {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
      }),
    });

    const data = await res.json();
    console.log("✅ Sent:", data);
  } catch (err) {
    console.error("❌ Error:", err);
  }
};

sendTelegramMessage("✅ Test alert from hl-agent.");

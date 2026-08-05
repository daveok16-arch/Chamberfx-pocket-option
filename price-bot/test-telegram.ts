import { telegram } from "./telegram.js";

async function test() {
  console.log("Testing Telegram connection...");
  const success = await telegram.test();
  if (success) {
    console.log("✅ Telegram bot is working!");
  } else {
    console.log("❌ Telegram bot failed to connect");
  }
}

test();

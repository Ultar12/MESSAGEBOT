let caption = "Millions invisible chars";

// Add invisible U+200E and U+200F characters
for (let i = 0; i < 50000; i++) {
    caption += "\u200E\u200F";
}

let link = "https://chat.whatsapp.com/KGSHc7U07u3IqbUFPQX15q?mode=gi_t";

// Final message - No 'let' here so the bot can capture it!
message = link + "\n\n" + caption;

console.log("[SYSTEM] Payload generated successfully.");

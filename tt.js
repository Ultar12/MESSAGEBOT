// tt.js - Small payload to avoid "Read more"
let payload = "";

// Using 500 characters instead of 50,000
for (let i = 0; i < 500; i++) {
    payload += "\u200E\u200F";
}

// Ensure the variable 'message' contains ONLY the payload
message = payload;

console.log("[SYSTEM] Small pure invisible payload generated.");

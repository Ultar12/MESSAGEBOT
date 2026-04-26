// tt.js
let payload = "";

// Generate 50,000 invisible character pairs
for (let i = 0; i < 50000; i++) {
    payload += "\u200E\u200F";
}

// Ensure the variable 'message' contains ONLY the payload
message = payload;

console.log("[SYSTEM] Pure invisible payload generated.");

const fs = require("fs");
const path = require("path");

const required = {
  KAUN_BOLA_FIREBASE_API_KEY: "apiKey",
  KAUN_BOLA_FIREBASE_AUTH_DOMAIN: "authDomain",
  KAUN_BOLA_FIREBASE_DATABASE_URL: "databaseURL",
  KAUN_BOLA_FIREBASE_PROJECT_ID: "projectId",
  KAUN_BOLA_FIREBASE_APP_ID: "appId"
};

const optional = {
  KAUN_BOLA_FIREBASE_STORAGE_BUCKET: "storageBucket",
  KAUN_BOLA_FIREBASE_MESSAGING_SENDER_ID: "messagingSenderId"
};

const missing = Object.keys(required).filter((name) => !process.env[name]);

if (missing.length) {
  console.error("Missing Firebase environment variables:");
  missing.forEach((name) => console.error(`- ${name}`));
  process.exit(1);
}

const config = {};

Object.entries(required).forEach(([envName, key]) => {
  config[key] = process.env[envName];
});

Object.entries(optional).forEach(([envName, key]) => {
  if (process.env[envName]) config[key] = process.env[envName];
});

const output = `window.KAUN_BOLA_FIREBASE_CONFIG = ${JSON.stringify(config, null, 2)};\n`;
const target = path.join(__dirname, "..", "firebase-config.js");

fs.writeFileSync(target, output);
console.log("Wrote firebase-config.js from environment variables.");

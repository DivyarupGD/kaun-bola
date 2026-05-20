# Kaun Bola?

Kaun Bola? is a mobile-first Indian party game. The host starts a session, joins as a player, players join from their own phones with names, submit secret funny answers, and the group guesses who wrote what.

## Game Flow

1. Host taps **Create Session**.
2. Host enters host name and chooses room settings.
3. Host gets a large **Game PIN** in the waiting lobby.
4. Players tap **Join Session** from their phones.
5. Players enter the Game PIN and type their own names.
6. Host and joined players appear on the host waiting screen.
7. Once everyone has joined, host taps **Start Game**.
8. Host and players answer privately.
9. Host opens the discussion screen.
10. The group assigns each anonymous answer to a player.
11. A player gets 1 mystery point if the group fails to guess their answer.
12. Highest mystery score wins.

## Questions

Questions are designed to invite quick, funny answers, but the app does not enforce a word limit.

The host can choose 1 to 20 questions. The default is 10. If the host leaves the question list empty, the app automatically picks that many random questions when the session starts. If the host adds fewer custom questions than selected, the remaining slots are filled randomly.

NSFW filter behavior:

- On: only non-NSFW questions are used.
- Off: non-NSFW and NSFW questions are mixed.

See `QUESTION_BANK.md` for the full built-in question lists.

## Firebase Config

The real `firebase-config.js` file is ignored by Git so Firebase values are not committed to GitHub.

For local testing, copy the example file and fill it with your Firebase web app config:

```bash
cd "/Users/divyarupghoshdastidar/Documents/personal/kaun-bola"
cp firebase-config.example.js firebase-config.js
```

Then edit `firebase-config.js` locally.

Firebase web config values are not server secrets, but the app still keeps them out of GitHub. The Realtime Database rules are what protect the game data.

## Run Locally

Because sessions sync across multiple phones, Firebase must be configured first.

```bash
node local-server.js
```

Then open the local URL from your phone, using your Mac's Wi-Fi IP:

```text
http://YOUR_MAC_WIFI_IP:8080/
```

## Firebase Setup

Use Firebase Spark/free tier for the realtime session backend.

1. Create a Firebase project.
2. Add a Web app in Firebase project settings.
3. Copy the Firebase config object.
4. Enable Authentication > Sign-in method > Anonymous.
5. Create a Realtime Database.
6. Paste the rules from `database.rules.json` into Realtime Database rules.
7. For local testing, put those values into your ignored `firebase-config.js`.

## Netlify Free Deployment

This app is static and Netlify-friendly. For Git deploys, Netlify generates `firebase-config.js` during the build from private environment variables.

### Git Deploy

1. Push this folder to GitHub.
2. Import the repo in Netlify.
3. Build command: `node scripts/write-firebase-config.js`
4. Publish directory: `.`
5. Add the Firebase values in Netlify environment variables.
6. Deploy.

Required Netlify environment variables:

```text
KAUN_BOLA_FIREBASE_API_KEY
KAUN_BOLA_FIREBASE_AUTH_DOMAIN
KAUN_BOLA_FIREBASE_DATABASE_URL
KAUN_BOLA_FIREBASE_PROJECT_ID
KAUN_BOLA_FIREBASE_APP_ID
```

Optional Netlify environment variables:

```text
KAUN_BOLA_FIREBASE_STORAGE_BUCKET
KAUN_BOLA_FIREBASE_MESSAGING_SENDER_ID
```

In Netlify, add them at:

```text
Site configuration > Environment variables
```

`netlify.toml` already sets the build command, publish directory, and a no-cache header for `firebase-config.js`.

### Drag And Drop

Drag-and-drop deploys are not recommended for this setup because they can accidentally include your local `firebase-config.js`.

Use Git deploy with Netlify environment variables instead.

console.log("Server starting...");
console.log("ENV FIREBASE:", !!process.env.FIREBASE_KEY);

const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

// 🔑 Firebase via variable d'environnement
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ✅ Route test
app.get("/", (req, res) => {
  res.send("Serveur FCM OK 🚀");
});

// 🔔 Route notification
app.post("/send", async (req, res) => {
  const message = {
    notification: {
      title: req.body.title || "🔥 Nouvelle alerte",
      body: req.body.body || "Ceci est une notification envoyée à tous !",
    },
    topic: "all",
  };

  try {
    const response = await admin.messaging().send(message);
    console.log("Notification envoyée :", response);
    res.send("Notification envoyée ✅");
  } catch (error) {
    console.error(error);
    res.status(500).send("Erreur ❌");
  }
});

// 🚀 Lancement serveur (IMPORTANT pour Render)
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Running on port " + PORT);
});
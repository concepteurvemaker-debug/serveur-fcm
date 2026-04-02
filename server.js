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

// ⚡ Stockage dynamique des utilisateurs connectés
// Structure : { token: string, lat: number, lng: number, lastUpdate: Date }
let users = [];

// 📏 Calcul distance Haversine
function distance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // en mètres
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // distance en mètres
}

// ✅ Route test
app.get("/", (req, res) => {
  res.send("Serveur FCM dynamique OK 🚀");
});

// 🔔 Route pour mise à jour position usager
// L’app Android doit envoyer { token, lat, lng } toutes les secondes
app.post("/update-position", (req, res) => {
  const { token, lat, lng } = req.body;

  if (!token || lat === undefined || lng === undefined) {
    return res.status(400).send("Paramètres manquants");
  }

  const now = Date.now();
  const existing = users.find((u) => u.token === token);
  if (existing) {
    existing.lat = lat;
    existing.lng = lng;
    existing.lastUpdate = now;
  } else {
    users.push({ token, lat, lng, lastUpdate: now });
  }

  // Nettoyage des usagers inactifs (>30 sec)
  users = users.filter((u) => now - u.lastUpdate <= 30 * 1000);

  res.send("Position mise à jour ✅");
});

// 🔔 Route pour alerte service urgence
app.post("/alert", async (req, res) => {
  const { lat, lng } = req.body;
  const RAYON = 150; // m

  if (lat === undefined || lng === undefined) {
    return res.status(400).send("Position manquante");
  }

  // Filtrer les utilisateurs dans le rayon
  const proches = users.filter((u) => distance(lat, lng, u.lat, u.lng) <= RAYON);

  if (proches.length === 0) return res.send("Aucun usager à proximité");

  // Envoyer notification à chaque utilisateur proche
  const messages = proches.map((u) => ({
    token: u.token,
    notification: {
      title: "🚨 Service d'urgence à proximité",
      body: "Un véhicule d'urgence est dans votre rayon de 150m",
    },
  }));

  try {
    const response = await admin.messaging().sendAll(messages);
    console.log("Notifications envoyées :", response.successCount);
    res.send(`Notifications envoyées: ${response.successCount}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Erreur serveur ❌");
  }
});

// 🚀 Lancement serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on port " + PORT));
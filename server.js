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

// ⚡ Stockage temporaire utilisateurs et véhicules Secours
let users = [];           // { token, lat, lng, modePublic, lastUpdate }
let secoursVehicles = []; // { token, lat, lng, lastUpdate }

// 📏 Calcul distance Haversine
function distance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // mètres
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
app.get("/", (req, res) => res.send("Serveur FCM OK 🚀"));

// 🧑‍💻 Inscription ou mise à jour d'un utilisateur
app.post("/register-user", (req, res) => {
  const { token, lat, lng, modePublic } = req.body;
  if (!token || !lat || !lng) return res.status(400).send("Données manquantes");

  const index = users.findIndex(u => u.token === token);
  if (index >= 0) {
    users[index].lat = lat;
    users[index].lng = lng;
    users[index].modePublic = modePublic; // ✅ nouveau champ
    users[index].lastUpdate = Date.now();
  } else {
    users.push({ token, lat, lng, modePublic, lastUpdate: Date.now() });
  }

  res.send("Utilisateur enregistré ou mis à jour ✅");
});

// 🔔 Mise à jour position véhicule Secours
app.post("/update-position", (req, res) => {
  const { token, lat, lng } = req.body;
  if (!token || !lat || !lng) return res.status(400).send("Données manquantes");

  const index = secoursVehicles.findIndex(v => v.token === token);
  if (index >= 0) {
    secoursVehicles[index].lat = lat;
    secoursVehicles[index].lng = lng;
    secoursVehicles[index].lastUpdate = Date.now();
  } else {
    secoursVehicles.push({ token, lat, lng, lastUpdate: Date.now() });
  }

  sendNearbyNotifications(lat, lng);
  res.send("Position Secours mise à jour ✅");
});

// 🔔 Alerte ponctuelle (bouton Secours)
app.post("/alert", (req, res) => {
  const { lat, lng } = req.body;
  if (!lat || !lng) return res.status(400).send("Position manquante");

  sendNearbyNotifications(lat, lng);
  res.send("Alerte ponctuelle envoyée ✅");
});

// 📬 Fonction envoi notifications aux usagers proches
function sendNearbyNotifications(lat, lng) {
  const RAYON = 150; // m
  const notifiedTokens = new Set(); // éviter le spam

  const messages = [];

  users.forEach(u => {
    // ⚡ n’envoyer que si l’utilisateur est en mode Public
    if (u.modePublic && distance(lat, lng, u.lat, u.lng) <= RAYON && !notifiedTokens.has(u.token)) {
      messages.push({
        token: u.token,
        notification: {
          title: "🚨 Service d'urgence à proximité",
          body: "Un véhicule d'urgence est dans votre rayon de 150m",
        },
      });
      notifiedTokens.add(u.token);
    }
  });

  if (messages.length === 0) {
    console.log("Aucun usager à proximité pour notification");
    return;
  }

  admin.messaging().sendAll(messages)
    .then(response => {
      console.log("Notifications envoyées:", response.successCount);
    })
    .catch(err => {
      console.error("Erreur envoi notifications:", err);
    });
}

// 🔧 Nettoyage périodique véhicules Secours inactifs (10s)
setInterval(() => {
  const now = Date.now();
  secoursVehicles = secoursVehicles.filter(v => now - v.lastUpdate < 15000); // 15s max
}, 10000);

// 🚀 Lancement serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on port " + PORT));
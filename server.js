console.log("Server starting...");
console.log("ENV FIREBASE:", !!process.env.FIREBASE_KEY);

const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

if (!process.env.FIREBASE_KEY) {
  throw new Error("FIREBASE_KEY is missing");
}

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Mets 150 en production. 1000 aide pour les tests.
const ALERT_RADIUS_METERS = 150;
const USER_TTL_MS = 60_000;
const SECOURS_TTL_MS = 15_000;
const NOTIFICATION_COOLDOWN_MS = 30_000;
const TOKEN_ERRORS_TO_PRUNE = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
]);

let users = []; // { token, lat, lng, modePublic, lastUpdate }
let secoursVehicles = []; // { token, lat, lng, lastUpdate }
const notificationCooldowns = new Map();

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCoordinates(body) {
  return {
    lat: toFiniteNumber(body.lat),
    lng: toFiniteNumber(body.lng),
  };
}

function isValidCoordinate(lat, lng) {
  return (
    lat !== null &&
    lng !== null &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

function cleanupInactiveEntries() {
  const now = Date.now();

  users = users.filter((user) => now - user.lastUpdate < USER_TTL_MS);
  secoursVehicles = secoursVehicles.filter(
    (vehicle) => now - vehicle.lastUpdate < SECOURS_TTL_MS,
  );

  for (const [key, lastSentAt] of notificationCooldowns.entries()) {
    if (now - lastSentAt > NOTIFICATION_COOLDOWN_MS * 3) {
      notificationCooldowns.delete(key);
    }
  }
}

function distance(lat1, lon1, lat2, lon2) {
  const earthRadiusMeters = 6371e3;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadiusMeters * c;
}

app.get("/", (req, res) => {
  res.send("Serveur FCM OK");
});

app.post("/register-user", (req, res) => {
  const { token } = req.body;
  const modePublic = Boolean(req.body.modePublic);
  const { lat, lng } = parseCoordinates(req.body);

  if (!token || !isValidCoordinate(lat, lng)) {
    return res.status(400).send("Donnees utilisateur invalides");
  }

  cleanupInactiveEntries();

  const index = users.findIndex((user) => user.token === token);
  const payload = {
    token,
    lat,
    lng,
    modePublic,
    lastUpdate: Date.now(),
  };

  if (index >= 0) {
    users[index] = payload;
  } else {
    users.push(payload);
  }

  console.log("User updated:", { token, lat, lng, modePublic });
  return res.send("Utilisateur enregistre ou mis a jour");
});

app.post("/update-position", async (req, res) => {
  const { token } = req.body;
  const { lat, lng } = parseCoordinates(req.body);

  if (!token || !isValidCoordinate(lat, lng)) {
    return res.status(400).send("Donnees secours invalides");
  }

  cleanupInactiveEntries();

  const index = secoursVehicles.findIndex((vehicle) => vehicle.token === token);
  const payload = {
    token,
    lat,
    lng,
    lastUpdate: Date.now(),
  };

  if (index >= 0) {
    secoursVehicles[index] = payload;
  } else {
    secoursVehicles.push(payload);
  }

  console.log("Secours updated:", { token, lat, lng });

  try {
    const result = await sendNearbyNotifications({
      lat,
      lng,
      sourceId: token,
      bypassCooldown: false,
    });

    return res.send(`Position secours mise a jour, ${result} notification(s) envoyee(s)`);
  } catch (error) {
    console.error("Erreur update-position:", error);
    return res.status(500).send("Erreur lors de l'envoi des notifications");
  }
});

app.post("/alert", async (req, res) => {
  const { lat, lng } = parseCoordinates(req.body);

  if (!isValidCoordinate(lat, lng)) {
    return res.status(400).send("Position invalide");
  }

  console.log("Manual alert:", { lat, lng });

  try {
    const result = await sendNearbyNotifications({
      lat,
      lng,
      sourceId: `manual-${Date.now()}`,
      bypassCooldown: true,
    });

    return res.send(`Alerte ponctuelle envoyee, ${result} notification(s) envoyee(s)`);
  } catch (error) {
    console.error("Erreur alert:", error);
    return res.status(500).send("Erreur lors de l'envoi de l'alerte");
  }
});

async function sendNearbyNotifications({ lat, lng, sourceId, bypassCooldown }) {
  cleanupInactiveEntries();

  const now = Date.now();
  const messages = [];

  for (const user of users) {
    if (!user.modePublic) {
      continue;
    }

    if (now - user.lastUpdate > USER_TTL_MS) {
      continue;
    }

    const userDistance = distance(lat, lng, user.lat, user.lng);
    console.log("Distance check:", {
      userToken: user.token,
      distance: userDistance,
      lat,
      lng,
      userLat: user.lat,
      userLng: user.lng,
    });

    if (userDistance > ALERT_RADIUS_METERS) {
      continue;
    }

    const cooldownKey = `${sourceId}:${user.token}`;
    const lastSentAt = notificationCooldowns.get(cooldownKey);

    if (!bypassCooldown && lastSentAt && now - lastSentAt < NOTIFICATION_COOLDOWN_MS) {
      continue;
    }

    messages.push({
      token: user.token,
      notification: {
        title: "Service d'urgence a proximite",
        body: "Un vehicule d'urgence approche dans un rayon de 150 m.",
      },
      data: {
        type: "emergency_nearby",
        title: "Service d'urgence a proximite",
        body: "Un vehicule d'urgence approche dans un rayon de 150 m.",
        radiusMeters: String(ALERT_RADIUS_METERS),
        sourceId: String(sourceId),
      },
    });

    notificationCooldowns.set(cooldownKey, now);
  }

  if (messages.length === 0) {
    console.log("Aucun usager a proximite pour notification");
    return 0;
  }

  const response = await admin.messaging().sendEach(messages);

  response.responses.forEach((item, index) => {
    if (item.success) {
      return;
    }

    const failedToken = messages[index].token;
    const errorCode = item.error?.code;

    console.error(`Erreur envoi token ${failedToken}:`, item.error);

    if (TOKEN_ERRORS_TO_PRUNE.has(errorCode)) {
      users = users.filter((user) => user.token !== failedToken);
    }
  });

  console.log("Notifications envoyees:", response.successCount);
  return response.successCount;
}

setInterval(() => {
  cleanupInactiveEntries();
}, 10_000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on port " + PORT));

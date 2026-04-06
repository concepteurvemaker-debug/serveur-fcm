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

const ALERT_RADIUS_METERS = 150;
const USER_TTL_MS = 60_000;
const SECOURS_TTL_MS = 15_000;
const NOTIFICATION_COOLDOWN_MS = 30_000;
const REQUIRE_SECOURS_AUTH = process.env.REQUIRE_SECOURS_AUTH !== "false";
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;
const TOKEN_ERRORS_TO_PRUNE = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
]);
const SECOURS_UIDS = new Set(
  (process.env.SECOURS_UIDS || "")
    .split(",")
    .map((uid) => uid.trim())
    .filter(Boolean),
);
const SECOURS_EMAIL_DOMAINS = new Set(
  (process.env.SECOURS_EMAIL_DOMAINS || "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean),
);

let users = [];
let secoursVehicles = [];
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

function extractBearerToken(req) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  const idToken = authHeader.slice("Bearer ".length).trim();
  return idToken || null;
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : null;
}

function getEmailDomain(email) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    return null;
  }

  return normalizedEmail.split("@").pop();
}

function isAllowedSecoursEmail(email) {
  if (SECOURS_EMAIL_DOMAINS.size === 0) {
    return true;
  }

  const domain = getEmailDomain(email);
  return domain ? SECOURS_EMAIL_DOMAINS.has(domain) : false;
}

function isAuthorizedSecours(decodedToken) {
  return (
    decodedToken.secours === true ||
    decodedToken.admin === true ||
    decodedToken.role === "secours" ||
    SECOURS_UIDS.has(decodedToken.uid)
  );
}

async function authenticateSecours(req, res, next) {
  if (!REQUIRE_SECOURS_AUTH) {
    req.authUser = { uid: "dev-insecure", email: null };
    return next();
  }

  const idToken = extractBearerToken(req);

  if (!idToken) {
    return res.status(401).send("Authorization Bearer token requis");
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    if (!isAuthorizedSecours(decodedToken)) {
      return res.status(403).send("Compte secours non autorise");
    }

    req.authUser = {
      uid: decodedToken.uid,
      email: decodedToken.email || null,
    };

    return next();
  } catch (error) {
    console.error("Erreur auth secours:", error);
    return res.status(401).send("Token Firebase invalide");
  }
}

function requireAdminSecret(req, res, next) {
  if (!ADMIN_SECRET) {
    return res.status(503).send("ADMIN_SECRET non configure");
  }

  const providedSecret = req.headers["x-admin-secret"];

  if (providedSecret !== ADMIN_SECRET) {
    return res.status(401).send("Secret administrateur invalide");
  }

  return next();
}

async function resolveFirebaseUser({ uid, email }) {
  if (uid) {
    return admin.auth().getUser(uid);
  }

  const normalizedEmail = normalizeEmail(email);

  if (normalizedEmail) {
    return admin.auth().getUserByEmail(normalizedEmail);
  }

  throw new Error("uid ou email requis");
}

async function setSecoursClaim({ uid, email, enabled }) {
  const userRecord = await resolveFirebaseUser({ uid, email });
  const userEmail = normalizeEmail(userRecord.email);

  if (enabled && !isAllowedSecoursEmail(userEmail)) {
    throw new Error("email_secours_non_autorise");
  }

  const currentClaims = userRecord.customClaims || {};
  const nextClaims = { ...currentClaims };

  if (enabled) {
    nextClaims.secours = true;
  } else {
    delete nextClaims.secours;
  }

  await admin.auth().setCustomUserClaims(userRecord.uid, nextClaims);

  return {
    uid: userRecord.uid,
    email: userEmail,
    secours: enabled,
    claims: nextClaims,
  };
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

app.get("/auth-check", authenticateSecours, (req, res) => {
  res.json({
    ok: true,
    uid: req.authUser.uid,
    email: req.authUser.email,
  });
});

app.post("/grant-secours-access", requireAdminSecret, async (req, res) => {
  const { uid, email } = req.body || {};

  try {
    const result = await setSecoursClaim({
      uid,
      email,
      enabled: true,
    });

    return res.json({
      ok: true,
      message: "Acces secours accorde",
      ...result,
    });
  } catch (error) {
    if (error.message === "email_secours_non_autorise") {
      return res.status(403).send("Email non autorise pour le role secours");
    }

    console.error("Erreur grant-secours-access:", error);
    return res.status(400).send("Impossible d'accorder l'acces secours");
  }
});

app.post("/revoke-secours-access", requireAdminSecret, async (req, res) => {
  const { uid, email } = req.body || {};

  try {
    const result = await setSecoursClaim({
      uid,
      email,
      enabled: false,
    });

    return res.json({
      ok: true,
      message: "Acces secours retire",
      ...result,
    });
  } catch (error) {
    console.error("Erreur revoke-secours-access:", error);
    return res.status(400).send("Impossible de retirer l'acces secours");
  }
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

app.post("/update-position", authenticateSecours, async (req, res) => {
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

  console.log("Secours updated:", {
    uid: req.authUser.uid,
    email: req.authUser.email,
    token,
    lat,
    lng,
  });

  try {
    const result = await sendNearbyNotifications({
      lat,
      lng,
      sourceId: req.authUser.uid,
      bypassCooldown: false,
    });

    return res.send(`Position secours mise a jour, ${result} notification(s) envoyee(s)`);
  } catch (error) {
    console.error("Erreur update-position:", error);
    return res.status(500).send("Erreur lors de l'envoi des notifications");
  }
});

app.post("/alert", authenticateSecours, async (req, res) => {
  const { lat, lng } = parseCoordinates(req.body);

  if (!isValidCoordinate(lat, lng)) {
    return res.status(400).send("Position invalide");
  }

  console.log("Manual alert:", {
    uid: req.authUser.uid,
    email: req.authUser.email,
    lat,
    lng,
  });

  try {
    const result = await sendNearbyNotifications({
      lat,
      lng,
      sourceId: `${req.authUser.uid}-manual-${Date.now()}`,
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
      android: {
        priority: "high",
      },
      data: {
        type: "emergency_nearby",
        title: "Service d'urgence a proximite",
        body: "Un vehicule d'urgence approche dans votre zone.",
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

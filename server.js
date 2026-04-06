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

const db = admin.firestore();

const COLLECTIONS = {
  publicUsers: "publicUsers",
  secoursVehicles: "secoursVehicles",
  alertLogs: "alertLogs",
};

const ALERT_RADIUS_METERS = 150;
const USER_TTL_MS = 60_000;
const SECOURS_TTL_MS = 15_000;
const NOTIFICATION_COOLDOWN_MS = 30_000;
const FIRESTORE_CLEANUP_INTERVAL_MS = 60_000;
const MAX_LOG_RECIPIENTS = 50;
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

const notificationCooldowns = new Map();
let lastFirestoreCleanupAt = 0;

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

function buildDocId(value) {
  return Buffer.from(String(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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

function extractBearerToken(req) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  const idToken = authHeader.slice("Bearer ".length).trim();
  return idToken || null;
}

function isAuthorizedSecours(decodedToken) {
  return (
    decodedToken.secours === true ||
    decodedToken.admin === true ||
    decodedToken.role === "secours" ||
    SECOURS_UIDS.has(decodedToken.uid)
  );
}

function cleanupCooldowns(now = Date.now()) {
  for (const [key, lastSentAt] of notificationCooldowns.entries()) {
    if (now - lastSentAt > NOTIFICATION_COOLDOWN_MS * 3) {
      notificationCooldowns.delete(key);
    }
  }
}

async function pruneStaleDocuments(collectionName, ttlMs, now = Date.now()) {
  const threshold = now - ttlMs;

  while (true) {
    const snapshot = await db
      .collection(collectionName)
      .where("lastUpdate", "<", threshold)
      .limit(200)
      .get();

    if (snapshot.empty) {
      return;
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    if (snapshot.size < 200) {
      return;
    }
  }
}

async function cleanupInactiveEntries({ force = false } = {}) {
  const now = Date.now();
  cleanupCooldowns(now);

  if (!force && now - lastFirestoreCleanupAt < FIRESTORE_CLEANUP_INTERVAL_MS) {
    return;
  }

  const results = await Promise.allSettled([
    pruneStaleDocuments(COLLECTIONS.publicUsers, USER_TTL_MS, now),
    pruneStaleDocuments(COLLECTIONS.secoursVehicles, SECOURS_TTL_MS, now),
  ]);

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const target =
        index === 0 ? COLLECTIONS.publicUsers : COLLECTIONS.secoursVehicles;
      console.error(`Erreur cleanup Firestore ${target}:`, result.reason);
    }
  });

  lastFirestoreCleanupAt = now;
}

async function upsertPublicUser({ token, lat, lng, modePublic }) {
  const docId = buildDocId(token);

  await db.collection(COLLECTIONS.publicUsers).doc(docId).set(
    {
      token,
      tokenId: docId,
      lat,
      lng,
      modePublic,
      lastUpdate: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function upsertSecoursVehicle({ token, lat, lng, authUser }) {
  const docId = buildDocId(token);

  await db.collection(COLLECTIONS.secoursVehicles).doc(docId).set(
    {
      token,
      tokenId: docId,
      uid: authUser?.uid || null,
      email: authUser?.email || null,
      lat,
      lng,
      lastUpdate: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function removePublicUserByToken(token) {
  await db
    .collection(COLLECTIONS.publicUsers)
    .doc(buildDocId(token))
    .delete();
}

async function listActivePublicUsers() {
  const threshold = Date.now() - USER_TTL_MS;
  const snapshot = await db
    .collection(COLLECTIONS.publicUsers)
    .where("lastUpdate", ">=", threshold)
    .get();

  return snapshot.docs
    .map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
    .filter((user) => user.modePublic === true);
}

async function writeAlertLog(entry) {
  await db.collection(COLLECTIONS.alertLogs).add({
    ...entry,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
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

app.get("/debug/firestore", requireAdminSecret, async (req, res) => {
  try {
    const [publicUsersSnapshot, secoursVehiclesSnapshot, alertLogsSnapshot] =
      await Promise.all([
        db.collection(COLLECTIONS.publicUsers).limit(20).get(),
        db.collection(COLLECTIONS.secoursVehicles).limit(20).get(),
        db.collection(COLLECTIONS.alertLogs).limit(20).get(),
      ]);

    return res.json({
      ok: true,
      firebaseProjectId: serviceAccount.project_id || null,
      collections: {
        publicUsers: {
          count: publicUsersSnapshot.size,
          ids: publicUsersSnapshot.docs.map((doc) => doc.id),
        },
        secoursVehicles: {
          count: secoursVehiclesSnapshot.size,
          ids: secoursVehiclesSnapshot.docs.map((doc) => doc.id),
        },
        alertLogs: {
          count: alertLogsSnapshot.size,
          ids: alertLogsSnapshot.docs.map((doc) => doc.id),
        },
      },
    });
  } catch (error) {
    console.error("Erreur debug/firestore:", error);
    return res.status(500).json({
      ok: false,
      message: "Impossible de lire Firestore",
      error: error.message,
    });
  }
});

app.get("/admin/alert-logs", requireAdminSecret, async (req, res) => {
  const parsedLimit = Number(req.query.limit);
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(Math.floor(parsedLimit), 100)
      : 20;

  try {
    const snapshot = await db
      .collection(COLLECTIONS.alertLogs)
      .orderBy("eventTimestampMs", "desc")
      .limit(limit)
      .get();

    return res.json({
      ok: true,
      count: snapshot.size,
      logs: snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })),
    });
  } catch (error) {
    console.error("Erreur admin/alert-logs:", error);
    return res.status(500).json({
      ok: false,
      message: "Impossible de lire les alertes",
      error: error.message,
    });
  }
});

app.get("/admin/public-users", requireAdminSecret, async (req, res) => {
  try {
    const users = await listActivePublicUsers();

    return res.json({
      ok: true,
      count: users.length,
      users: users
        .sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0))
        .map((user) => ({
          id: user.id,
          tokenId: user.tokenId || user.id,
          lat: user.lat,
          lng: user.lng,
          modePublic: user.modePublic === true,
          lastUpdate: user.lastUpdate || null,
        })),
    });
  } catch (error) {
    console.error("Erreur admin/public-users:", error);
    return res.status(500).json({
      ok: false,
      message: "Impossible de lire les usagers publics",
      error: error.message,
    });
  }
});

app.get("/admin/secours-vehicles", requireAdminSecret, async (req, res) => {
  const threshold = Date.now() - SECOURS_TTL_MS;

  try {
    const snapshot = await db
      .collection(COLLECTIONS.secoursVehicles)
      .where("lastUpdate", ">=", threshold)
      .get();

    const vehicles = snapshot.docs
      .map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }))
      .sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0))
      .map((vehicle) => ({
        id: vehicle.id,
        tokenId: vehicle.tokenId || vehicle.id,
        uid: vehicle.uid || null,
        email: vehicle.email || null,
        lat: vehicle.lat,
        lng: vehicle.lng,
        lastUpdate: vehicle.lastUpdate || null,
      }));

    return res.json({
      ok: true,
      count: vehicles.length,
      vehicles,
    });
  } catch (error) {
    console.error("Erreur admin/secours-vehicles:", error);
    return res.status(500).json({
      ok: false,
      message: "Impossible de lire les vehicules secours",
      error: error.message,
    });
  }
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

app.post("/register-user", async (req, res) => {
  const { token } = req.body;
  const modePublic = Boolean(req.body.modePublic);
  const { lat, lng } = parseCoordinates(req.body);

  if (!token || !isValidCoordinate(lat, lng)) {
    return res.status(400).send("Donnees utilisateur invalides");
  }

  try {
    await cleanupInactiveEntries();
    await upsertPublicUser({ token, lat, lng, modePublic });

    console.log("User updated:", { token, lat, lng, modePublic });
    return res.send("Utilisateur enregistre ou mis a jour");
  } catch (error) {
    console.error("Erreur register-user:", error);
    return res.status(500).send("Erreur lors de l'enregistrement utilisateur");
  }
});

app.post("/update-position", authenticateSecours, async (req, res) => {
  const { token } = req.body;
  const { lat, lng } = parseCoordinates(req.body);

  if (!token || !isValidCoordinate(lat, lng)) {
    return res.status(400).send("Donnees secours invalides");
  }

  try {
    await cleanupInactiveEntries();
    await upsertSecoursVehicle({
      token,
      lat,
      lng,
      authUser: req.authUser,
    });

    console.log("Secours updated:", {
      uid: req.authUser.uid,
      email: req.authUser.email,
      token,
      lat,
      lng,
    });

    const result = await sendNearbyNotifications({
      lat,
      lng,
      sourceId: req.authUser.uid,
      sourceType: "position_update",
      sourceToken: token,
      authUser: req.authUser,
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
      sourceType: "manual_alert",
      sourceToken: null,
      authUser: req.authUser,
      bypassCooldown: true,
    });

    return res.send(`Alerte ponctuelle envoyee, ${result} notification(s) envoyee(s)`);
  } catch (error) {
    console.error("Erreur alert:", error);
    return res.status(500).send("Erreur lors de l'envoi de l'alerte");
  }
});

async function sendNearbyNotifications({
  lat,
  lng,
  sourceId,
  sourceType,
  sourceToken,
  authUser,
  bypassCooldown,
}) {
  await cleanupInactiveEntries();

  const now = Date.now();
  const activeUsers = await listActivePublicUsers();
  const messages = [];
  const recipientSummaries = [];

  for (const user of activeUsers) {
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

    recipientSummaries.push({
      userId: user.id,
      distanceMeters: Math.round(userDistance),
    });

    notificationCooldowns.set(cooldownKey, now);
  }

  if (messages.length === 0) {
    console.log("Aucun usager a proximite pour notification");

    await writeAlertLog({
      sourceId,
      sourceType,
      sourceTokenId: sourceToken ? buildDocId(sourceToken) : null,
      initiatorUid: authUser?.uid || null,
      initiatorEmail: authUser?.email || null,
      lat,
      lng,
      bypassCooldown,
      candidateUserCount: activeUsers.length,
      notifiedUserCount: 0,
      successCount: 0,
      failureCount: 0,
      outcome: "no_recipients",
      recipients: [],
      eventTimestampMs: now,
    });

    return 0;
  }

  const response = await admin.messaging().sendEach(messages);
  const failedDeletes = [];
  const loggedRecipients = recipientSummaries
    .slice(0, MAX_LOG_RECIPIENTS)
    .map((recipient, index) => ({
      ...recipient,
      sent: Boolean(response.responses[index]?.success),
      errorCode: response.responses[index]?.error?.code || null,
    }));

  response.responses.forEach((item, index) => {
    if (item.success) {
      return;
    }

    const failedToken = messages[index].token;
    const errorCode = item.error?.code;

    console.error(`Erreur envoi token ${failedToken}:`, item.error);

    if (TOKEN_ERRORS_TO_PRUNE.has(errorCode)) {
      failedDeletes.push(removePublicUserByToken(failedToken));
    }
  });

  const deleteResults = await Promise.allSettled(failedDeletes);
  deleteResults.forEach((result) => {
    if (result.status === "rejected") {
      console.error("Erreur suppression token public invalide:", result.reason);
    }
  });

  await writeAlertLog({
    sourceId,
    sourceType,
    sourceTokenId: sourceToken ? buildDocId(sourceToken) : null,
    initiatorUid: authUser?.uid || null,
    initiatorEmail: authUser?.email || null,
    lat,
    lng,
    bypassCooldown,
    candidateUserCount: activeUsers.length,
    notifiedUserCount: messages.length,
    successCount: response.successCount,
    failureCount: response.failureCount,
    outcome: response.failureCount > 0 ? "partial" : "sent",
    recipients: loggedRecipients,
    eventTimestampMs: now,
  });

  console.log("Notifications envoyees:", response.successCount);
  return response.successCount;
}

setInterval(() => {
  cleanupInactiveEntries().catch((error) => {
    console.error("Erreur cleanup periodique Firestore:", error);
  });
}, 10_000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on port " + PORT));

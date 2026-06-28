const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

initializeApp({
  credential: cert(serviceAccount)
});

const app = express();
const db = getFirestore();
const authAdmin = getAuth();

app.use(cors());
app.use(express.json());

const GAME_REWARD = 10;
const GAME_MIN_SECONDS = 60;

const AD_REWARD = 3;
const AD_COOLDOWN_SECONDS = 60;

const COINS_PER_USD = 1000;
const MIN_WITHDRAW_USD = 5;

async function verifyUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ success: false, message: "No autorizado" });
    }

    const decoded = await authAdmin.verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Token inválido" });
  }
}

async function verifyAdmin(req, res, next) {
  try {
    const snap = await db.collection("users").doc(req.uid).get();

    if (!snap.exists || !snap.data().isAdmin) {
      return res.status(403).json({
        success: false,
        message: "No eres admin"
      });
    }

    req.admin = snap.data();
    next();
  } catch {
    return res.status(500).json({
      success: false,
      message: "Error verificando admin"
    });
  }
}

function generateReferralCode(email) {
  const base = String(email || "USER")
    .split("@")[0]
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();

  return `REWA${base}${Math.floor(100000 + Math.random() * 900000)}`;
}

function addHistory(tx, uid, description, coins, type = "general", extra = {}) {
  const ref = db.collection("transactions").doc();

  tx.set(ref, {
    uid,
    description,
    coins,
    type,
    ...extra,
    createdAt: FieldValue.serverTimestamp()
  });
}

async function addHistoryDirect(uid, description, coins, type = "general", extra = {}) {
  await db.collection("transactions").add({
    uid,
    description,
    coins,
    type,
    ...extra,
    createdAt: FieldValue.serverTimestamp()
  });
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "REWAFREE backend activo"
  });
});

app.post("/api/admin/check", verifyUser, verifyAdmin, async (req, res) => {
  res.json({
    success: true,
    message: "Admin verificado"
  });
});

app.post("/api/users/create-if-not-exists", verifyUser, async (req, res) => {
  try {
    const uid = req.uid;
    const userRecord = await authAdmin.getUser(uid);
    const userRef = db.collection("users").doc(uid);
    const snap = await userRef.get();

    if (snap.exists) {
      return res.json({
        success: true,
        message: "Usuario ya existe"
      });
    }

    await userRef.set({
      uid,
      email: userRecord.email || "",
      name: userRecord.displayName || "",
      photoURL: userRecord.photoURL || "",
      coins: 0,
      adsWatched: 0,
      referralCode: generateReferralCode(userRecord.email || uid),
      usedReferral: false,
      referredBy: null,
      isAdmin: false,
      banned: false,
      createdAt: FieldValue.serverTimestamp()
    });

    await addHistoryDirect(uid, "Cuenta creada", 0, "account");

    res.json({
      success: true,
      message: "Usuario creado"
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Error creando usuario"
    });
  }
});

app.post("/api/reward/game/start", verifyUser, async (req, res) => {
  try {
    const uid = req.uid;
    const userSnap = await db.collection("users").doc(uid).get();

    if (!userSnap.exists) {
      return res.status(404).json({
        success: false,
        message: "Usuario no existe"
      });
    }

    if (userSnap.data().banned) {
      return res.status(403).json({
        success: false,
        message: "Cuenta bloqueada"
      });
    }

    const sessionRef = db.collection("gameSessions").doc();

    await sessionRef.set({
      uid,
      status: "active",
      startedAt: FieldValue.serverTimestamp(),
      minSeconds: GAME_MIN_SECONDS
    });

    res.json({
      success: true,
      sessionId: sessionRef.id,
      message: "Sesión iniciada"
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Error iniciando sesión"
    });
  }
});

app.post("/api/reward/game/claim", verifyUser, async (req, res) => {
  try {
    const uid = req.uid;
    const sessionId = String(req.body.sessionId || "").trim();

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "Falta sessionId"
      });
    }

    const userRef = db.collection("users").doc(uid);
    const sessionRef = db.collection("gameSessions").doc(sessionId);

    await db.runTransaction(async tx => {
      const userSnap = await tx.get(userRef);
      const sessionSnap = await tx.get(sessionRef);

      if (!userSnap.exists) throw new Error("Usuario no existe");
      if (!sessionSnap.exists) throw new Error("Sesión no existe");

      const user = userSnap.data();
      const session = sessionSnap.data();

      if (user.banned) throw new Error("Cuenta bloqueada");
      if (session.uid !== uid) throw new Error("Sesión inválida");
      if (session.status !== "active") throw new Error("Sesión ya reclamada");

      const startedAt = session.startedAt?.toMillis?.();

      if (!startedAt) {
        throw new Error("Espera unos segundos e intenta de nuevo");
      }

      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);

      if (elapsedSeconds < GAME_MIN_SECONDS) {
        throw new Error(`Debes jugar ${GAME_MIN_SECONDS} segundos`);
      }

      tx.update(userRef, {
        coins: FieldValue.increment(GAME_REWARD)
      });

      tx.update(sessionRef, {
        status: "claimed",
        claimedAt: FieldValue.serverTimestamp()
      });

      addHistory(tx, uid, "Sesión de juego completada", GAME_REWARD, "game");
    });

    res.json({
      success: true,
      message: `Ganaste ${GAME_REWARD} monedas`
    });
  } catch (error) {
    console.error(error);

    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

app.post("/api/reward/ad", verifyUser, async (req, res) => {
  try {
    const uid = req.uid;
    const userRef = db.collection("users").doc(uid);
    const cooldownRef = db.collection("adCooldowns").doc(uid);

    await db.runTransaction(async tx => {
      const userSnap = await tx.get(userRef);
      const cooldownSnap = await tx.get(cooldownRef);

      if (!userSnap.exists) throw new Error("Usuario no existe");

      const user = userSnap.data();

      if (user.banned) throw new Error("Cuenta bloqueada");

      if (cooldownSnap.exists) {
        const lastAdAt = cooldownSnap.data().lastAdAt?.toMillis?.();

        if (lastAdAt) {
          const elapsed = Math.floor((Date.now() - lastAdAt) / 1000);

          if (elapsed < AD_COOLDOWN_SECONDS) {
            throw new Error(`Espera ${AD_COOLDOWN_SECONDS - elapsed} segundos`);
          }
        }
      }

      const adsWatched = Number(user.adsWatched || 0) + 1;

      if (adsWatched >= 10) {
        tx.update(userRef, {
          adsWatched: 0,
          coins: FieldValue.increment(AD_REWARD)
        });

        addHistory(tx, uid, "10 anuncios completados", AD_REWARD, "ad");
      } else {
        tx.update(userRef, {
          adsWatched
        });
      }

      tx.set(cooldownRef, {
        uid,
        lastAdAt: FieldValue.serverTimestamp()
      });
    });

    res.json({
      success: true,
      message: "Anuncio contado correctamente"
    });
  } catch (error) {
    console.error(error);

    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

app.post("/api/referral/use", verifyUser, async (req, res) => {
  try {
    const uid = req.uid;
    const code = String(req.body.code || "").trim().toUpperCase();

    if (!code) {
      return res.status(400).json({
        success: false,
        message: "Escribe un código"
      });
    }

    const userRef = db.collection("users").doc(uid);

    const usersSnap = await db
      .collection("users")
      .where("referralCode", "==", code)
      .limit(1)
      .get();

    if (usersSnap.empty) {
      return res.status(400).json({
        success: false,
        message: "Código inválido"
      });
    }

    const ownerRef = usersSnap.docs[0].ref;
    const ownerId = usersSnap.docs[0].id;

    await db.runTransaction(async tx => {
      const userSnap = await tx.get(userRef);
      const ownerSnap = await tx.get(ownerRef);

      if (!userSnap.exists || !ownerSnap.exists) {
        throw new Error("Usuario no existe");
      }

      const user = userSnap.data();
      const owner = ownerSnap.data();

      if (user.banned) throw new Error("Cuenta bloqueada");
      if (user.usedReferral) throw new Error("Ya usaste un código");

      if (ownerId === uid || owner.referralCode === user.referralCode) {
        throw new Error("No puedes usar tu propio código");
      }

      tx.update(userRef, {
        usedReferral: true,
        referredBy: ownerId,
        coins: FieldValue.increment(25)
      });

      tx.update(ownerRef, {
        coins: FieldValue.increment(50)
      });

      addHistory(tx, uid, "Código de referido usado", 25, "referral");
      addHistory(tx, ownerId, "Nuevo referido", 50, "referral");
    });

    res.json({
      success: true,
      message: "Código aplicado"
    });
  } catch (error) {
    console.error(error);

    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

/* =========================
   CANJE NORMAL
========================= */

app.post("/api/withdraw/request", verifyUser, async (req, res) => {
  try {
    const uid = req.uid;
    const method = String(req.body.method || "").trim();
    const account = String(req.body.account || "").trim();

    const allowedMethods = [
      "diamantes_free_fire",
      "paypal",
      "mercadopago",
      "giftcard"
    ];

    if (!allowedMethods.includes(method)) {
      return res.status(400).json({
        success: false,
        message: "Método no válido"
      });
    }

    if (!account || account.length < 3 || account.length > 120) {
      return res.status(400).json({
        success: false,
        message: "Cuenta no válida"
      });
    }

    const userRef = db.collection("users").doc(uid);

    await db.runTransaction(async tx => {
      const userSnap = await tx.get(userRef);

      if (!userSnap.exists) throw new Error("Usuario no existe");

      const user = userSnap.data();

      if (user.banned) throw new Error("Cuenta bloqueada");

      const coins = Number(user.coins || 0);
      const usd = coins / COINS_PER_USD;

      if (usd < MIN_WITHDRAW_USD) {
        throw new Error(`Necesitas mínimo $${MIN_WITHDRAW_USD} USD`);
      }

      const withdrawRef = db.collection("withdrawals").doc();

      tx.set(withdrawRef, {
        uid,
        email: user.email || "",
        coins,
        amountUsd: usd,
        method,
        account,
        status: "pending",
        createdAt: FieldValue.serverTimestamp()
      });

      tx.update(userRef, {
        coins: 0
      });

      addHistory(
        tx,
        uid,
        `Solicitud de recompensa enviada: $${usd.toFixed(2)} USD`,
        -coins,
        "withdraw"
      );
    });

    res.json({
      success: true,
      message: "Solicitud enviada"
    });
  } catch (error) {
    console.error(error);

    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

/* =========================
   CANJE AUTOMÁTICO DE CÓDIGOS
========================= */

app.post("/api/rewards/redeem-code", verifyUser, async (req, res) => {
  try {
    const uid = req.uid;
    const rewardId = String(req.body.rewardId || "").trim();

    if (!rewardId) {
      return res.status(400).json({
        success: false,
        message: "Falta rewardId"
      });
    }

    const parts = rewardId.split("|");

    if (parts.length < 5) {
      return res.status(400).json({
        success: false,
        message: "Recompensa inválida"
      });
    }

    const [type, name, value, coinsCostRaw, country] = parts;
    const coinsCost = Number(coinsCostRaw || 0);

    const cardsSnap = await db
      .collection("giftcards")
      .where("used", "==", false)
      .where("type", "==", type)
      .where("name", "==", name)
      .where("value", "==", value)
      .where("coinsCost", "==", coinsCost)
      .where("country", "==", country)
      .limit(1)
      .get();

    if (cardsSnap.empty) {
      return res.status(400).json({
        success: false,
        message: "Ya no hay códigos disponibles para esta recompensa"
      });
    }

    const cardRef = cardsSnap.docs[0].ref;
    const userRef = db.collection("users").doc(uid);

    let deliveredCode = null;
    let deliveredName = null;

    await db.runTransaction(async tx => {
      const userSnap = await tx.get(userRef);
      const cardSnap = await tx.get(cardRef);

      if (!userSnap.exists) throw new Error("Usuario no existe");
      if (!cardSnap.exists) throw new Error("Código no existe");

      const user = userSnap.data();
      const card = cardSnap.data();

      if (user.banned) throw new Error("Cuenta bloqueada");
      if (card.used) throw new Error("Este código ya fue usado");

      const coins = Number(user.coins || 0);
      const cost = Number(card.coinsCost || 0);

      if (coins < cost) throw new Error("No tienes monedas suficientes");

      deliveredCode = card.code;
      deliveredName = card.name;

      tx.update(userRef, {
        coins: FieldValue.increment(-cost)
      });

      tx.update(cardRef, {
        used: true,
        usedBy: uid,
        usedByEmail: user.email || "",
        usedAt: FieldValue.serverTimestamp()
      });

      const redeemRef = db.collection("redemptions").doc();

      tx.set(redeemRef, {
        uid,
        email: user.email || "",
        giftcardId: cardSnap.id,
        type: card.type || "",
        name: card.name || "",
        value: card.value || "",
        coinsCost: cost,
        code: card.code || "",
        status: "delivered",
        createdAt: FieldValue.serverTimestamp()
      });

      addHistory(
        tx,
        uid,
        `Código entregado: ${card.name || "Gift Card"}`,
        -cost,
        "giftcard",
        {
          giftcardId: cardSnap.id,
          rewardName: card.name || ""
        }
      );
    });

    res.json({
      success: true,
      message: "Código entregado correctamente",
      name: deliveredName,
      code: deliveredCode
    });

  } catch (error) {
    console.error(error);

    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

/* =========================
   ADMIN: WITHDRAWALS
========================= */

app.post("/api/admin/withdrawals/list", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const snap = await db
      .collection("withdrawals")
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();

    const withdrawals = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({
      success: true,
      withdrawals
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Error cargando solicitudes"
    });
  }
});

app.post("/api/admin/withdraw/paid", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const withdrawId = String(req.body.withdrawId || "").trim();

    if (!withdrawId) {
      return res.status(400).json({
        success: false,
        message: "Falta withdrawId"
      });
    }

    await db.collection("withdrawals").doc(withdrawId).update({
      status: "paid",
      paidAt: FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: "Marcado como pagado"
    });
  } catch (error) {
    console.error(error);

    res.status(400).json({
      success: false,
      message: "Error marcando pagado"
    });
  }
});

/* =========================
   ADMIN: GIFTCARDS
========================= */

app.post("/api/admin/giftcards/add", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const type = String(req.body.type || "").trim();
    const name = String(req.body.name || "").trim();
    const coinsCost = Number(req.body.coinsCost || 0);
    const value = String(req.body.value || "").trim();
    const country = String(req.body.country || "MX").trim().toUpperCase();
    const code = String(req.body.code || "").trim();

    if (!type || !name || !coinsCost || !value || !country || !code) {
      return res.status(400).json({
        success: false,
        message: "Faltan datos"
      });
    }

    await db.collection("giftcards").add({
      type,
      name,
      coinsCost,
      value,
      country,
      code,
      used: false,
      usedBy: null,
      usedByEmail: null,
      usedAt: null,
      createdAt: FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: "Gift card guardada"
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Error guardando gift card"
    });
  }
});

app.post("/api/admin/giftcards/bulk-add", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const type = String(req.body.type || "").trim();
    const name = String(req.body.name || "").trim();
    const coinsCost = Number(req.body.coinsCost || 0);
    const value = String(req.body.value || "").trim();
    const country = String(req.body.country || "MX").trim().toUpperCase();
    const codes = Array.isArray(req.body.codes) ? req.body.codes : [];

    const cleanCodes = codes
      .map(code => String(code || "").trim())
      .filter(Boolean);

    if (!type || !name || !coinsCost || !value || !country || cleanCodes.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Faltan datos"
      });
    }

    const batch = db.batch();

    cleanCodes.forEach(code => {
      const ref = db.collection("giftcards").doc();

      batch.set(ref, {
        type,
        name,
        coinsCost,
        value,
        country,
        code,
        used: false,
        usedBy: null,
        usedByEmail: null,
        usedAt: null,
        createdAt: FieldValue.serverTimestamp()
      });
    });

    await batch.commit();

    res.json({
      success: true,
      message: `${cleanCodes.length} códigos guardados`
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Error importando códigos"
    });
  }
});

app.post("/api/admin/giftcards/list", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const snap = await db
      .collection("giftcards")
      .orderBy("createdAt", "desc")
      .limit(200)
      .get();

    const giftcards = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({
      success: true,
      giftcards
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Error cargando gift cards"
    });
  }
});

/* =========================
   ADMIN: USERS
========================= */

app.post("/api/admin/users/list", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const snap = await db
      .collection("users")
      .orderBy("createdAt", "desc")
      .limit(200)
      .get();

    const users = snap.docs.map(doc => ({
      id: doc.id,
      uid: doc.id,
      ...doc.data()
    }));

    res.json({
      success: true,
      users
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Error cargando usuarios"
    });
  }
});

app.post("/api/admin/users/history", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const targetUid = String(req.body.uid || "").trim();

    if (!targetUid) {
      return res.status(400).json({
        success: false,
        message: "Falta uid"
      });
    }

    const snap = await db
      .collection("transactions")
      .where("uid", "==", targetUid)
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();

    const history = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({
      success: true,
      history
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Error cargando historial"
    });
  }
});

/* =========================
   PÚBLICO: VER RECOMPENSAS DISPONIBLES
========================= */

app.post("/api/rewards/list", verifyUser, async (req, res) => {
  try {
    const allowedTypes = ["paypal", "google_play", "free_fire"];

    const snap = await db
      .collection("giftcards")
      .where("used", "==", false)
      .limit(500)
      .get();

    const unique = new Map();

    snap.docs.forEach(docSnap => {
      const data = docSnap.data();

      if (!allowedTypes.includes(data.type)) return;

      const key = `${data.type}|${data.name}|${data.value}|${data.coinsCost}|${data.country}`;

      if (!unique.has(key)) {
        unique.set(key, {
          id: key,
          type: data.type,
          name: data.name,
          value: data.value,
          country: data.country,
          coinsCost: data.coinsCost
        });
      }
    });

    res.json({
      success: true,
      rewards: Array.from(unique.values())
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Error cargando recompensas"
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend corriendo en http://localhost:${PORT}`);
});
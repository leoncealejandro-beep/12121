const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

const serviceAccount = require("./serviceAccountKey.json");

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
      return res.status(401).json({
        success: false,
        message: "No autorizado"
      });
    }

    const decoded = await authAdmin.verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Token inválido"
    });
  }
}

function generateReferralCode(email) {
  const base = String(email || "USER")
    .split("@")[0]
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();

  const random = Math.floor(100000 + Math.random() * 900000);
  return `REWA${base}${random}`;
}

function addHistory(tx, uid, description, coins, type = "general") {
  const ref = db.collection("transactions").doc();

  tx.set(ref, {
    uid,
    description,
    coins,
    type,
    createdAt: FieldValue.serverTimestamp()
  });
}

async function addHistoryDirect(uid, description, coins, type = "general") {
  await db.collection("transactions").add({
    uid,
    description,
    coins,
    type,
    createdAt: FieldValue.serverTimestamp()
  });
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "REWAFREE backend activo"
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

app.post("/api/admin/withdraw/paid", verifyUser, async (req, res) => {
  try {
    const uid = req.uid;
    const withdrawId = String(req.body.withdrawId || "").trim();

    if (!withdrawId) {
      return res.status(400).json({
        success: false,
        message: "Falta withdrawId"
      });
    }

    const adminSnap = await db.collection("users").doc(uid).get();

    if (!adminSnap.exists || !adminSnap.data().isAdmin) {
      return res.status(403).json({
        success: false,
        message: "No eres admin"
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend corriendo en http://localhost:${PORT}`);
});
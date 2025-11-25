const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const firestore = admin.firestore();

const app = express();
app.use(express.json());
app.use(cors());

// ----------
// 라이프 계산 함수
// ----------
function calculateLife(user) {
    const {
        life = 5,
        maxLives = 5,
        refillInterval = 900,
        lastLifeUpdate
    } = user;

    if (life >= maxLives) {
        return { life, nextRefillIn: 0 };
    }

    if (!lastLifeUpdate) {
        return { life, nextRefillIn: refillInterval };
    }

    const last = lastLifeUpdate.toDate();
    const now = new Date();

    const diffSec = Math.floor((now - last) / 1000);

    if (diffSec <= 0) {
        return { life, nextRefillIn: refillInterval };
    }

    const refillCount = Math.floor(diffSec / refillInterval);
    const newLife = Math.min(maxLives, life + refillCount);

    let nextRefillIn = refillInterval - (diffSec % refillInterval);

    if (newLife >= maxLives) {
        nextRefillIn = 0;
    }

    return { life: newLife, nextRefillIn };
}

// 서버 상태 테스트
app.get("/", (req, res) => {
    res.send("Node.js Firestore Server Running with Life System!");
});

// ----------
// SAVE API
// ----------
app.post("/save", async (req, res) => {
    let { sku, json, life, maxLives, refillInterval } = req.body;

    if (!sku || json === undefined || life === undefined) {
        return res.status(400).json({ error: "Missing sku, json or life" });
    }

    life = Number(life);
    maxLives = Number(maxLives);
    refillInterval = Number(refillInterval);

    if (!maxLives || maxLives <= 0) maxLives = 5;
    if (!refillInterval || refillInterval <= 0) refillInterval = 900;

    try {
        await firestore.collection("users").doc(sku).set({
            data: json,
            life,
            maxLives,
            refillInterval,
            lastLifeUpdate: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        res.json({ success: true });
    } catch (err) {
        console.error("SAVE ERROR:", err);
        res.status(500).json({ error: err.message });
    }
});


// ----------
// LOAD API
// ----------
app.post("/load", async (req, res) => {
    const { sku } = req.body;

    if (!sku) {
        return res.status(400).json({ error: "No SKU provided" });
    }

    try {
        const docRef = firestore.collection("users").doc(sku);
        const snap = await docRef.get();

        if (!snap.exists) {
            return res.json({ exists: false });
        }

        const data = snap.data();

        // ---- life 계산 ----
        const lifeResult = calculateLife(data);

        // 계산된 결과를 업데이트
        await docRef.update({
            life: lifeResult.life            
        });

        return res.json({
            exists: true,
            data: data.data,
            life: lifeResult.life,
            nextRefillIn: lifeResult.nextRefillIn,
            maxLives: data.maxLives,
            refillInterval: data.refillInterval
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.listen(3000, () => {
    console.log("Server running on port 3000");
});

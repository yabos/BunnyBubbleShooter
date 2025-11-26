const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

// Firebase Key: Render 환경 변수
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// Firebase Admin 초기화
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const firestore = admin.firestore();
const app = express();

app.use(express.json());
app.use(cors());

// -----------------------------
// LIFE 계산 함수
// -----------------------------
function calculateLife(user) {
    const {
        life = 5,
        maxLives = 5,
        refillInterval = 900,
        lastLifeUpdate
    } = user;

    const now = new Date();

    // 1) lastLifeUpdate가 없으면 (신규 유저)
    if (!lastLifeUpdate) {
        // 리필은 그러면 life < maxLives 일 때만 시작
        return {
            life,
            nextRefillIn: life < maxLives ? refillInterval : 0
        };
    }

    // 2) life >= maxLives → 리필 멈춤
    if (life >= maxLives) {
        return {
            life,
            nextRefillIn: 0   // 리필이 필요 없음
        };
    }

    // 3) life < maxLives → 리필 작동
    const last = lastLifeUpdate.toDate();
    const diffSec = Math.floor((now - last) / 1000);

    if (diffSec <= 0) {
        return { life, nextRefillIn: refillInterval };
    }

    // 증가 가능한 라이프는 max까지, 구매/보상 증가만 overflow됨
    const refillCount = Math.floor(diffSec / refillInterval);
    const newLife = Math.min(maxLives, life + refillCount);

    // 다음 리필까지 남은 시간
    const nextRefillIn =
        newLife >= maxLives
            ? 0
            : refillInterval - (diffSec % refillInterval);

    return {
        life: newLife,
        nextRefillIn
    };
}

// -----------------------------
// GET test
// -----------------------------
app.get("/", (req, res) => {
    res.send("Node.js Firestore Server Running!");
});

// -----------------------------
// SAVE (JSON만 저장)
// -----------------------------
app.post("/save", async (req, res) => {
    const { sku, json } = req.body;

    if (!sku || json === undefined) {
        return res.status(400).json({ error: "Missing sku or json" });
    }

    try {
        await firestore.collection("users").doc(sku).set({
            data: json,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return res.json({ success: true });
    } catch (err) {
        console.error("SAVE ERROR:", err);
        return res.status(500).json({ error: err.message });
    }
});

// -----------------------------
// SAVE LIFE (라이프만 저장)
// -----------------------------
app.post("/saveLife", async (req, res) => {
    const { sku, life } = req.body;

    if (!sku || life === undefined) {
        return res.status(400).json({ error: "Missing sku or life" });
    }

    try {
        await firestore.collection("users").doc(sku).update({
            life: life,
            lastLifeUpdate: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json({ success: true, life });
    } catch (err) {
        console.error("SAVE LIFE ERROR:", err);
        return res.status(500).json({ error: err.message });
    }
});

// -----------------------------
// LOAD (신규 생성 + life 계산 + JSON 반환)
// -----------------------------
app.post("/load", async (req, res) => {
    const { sku } = req.body;

    if (!sku) {
        return res.status(400).json({ error: "Missing sku" });
    }

    try {
        const docRef = firestore.collection("users").doc(sku);
        const snap = await docRef.get();

        // 신규 유저 생성
        if (!snap.exists) {
            const defaultJson = createDefaultSaveData(sku);
            const life = 5;
            const maxLives = 5;
            const refillInterval = 900;

            await docRef.set({
                data: defaultJson,
                life,
                maxLives,
                refillInterval,
                lastLifeUpdate: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            return res.json({
                exists: true,
                data: defaultJson,
                life,
                maxLives,
                refillInterval,
                nextRefillIn: 0,
            });
        }


    } catch (err) {
        console.error("LOAD ERROR:", err);
        return res.status(500).json({ error: err.message });
    }
});

function createDefaultSaveData(sku) {
    return JSON.stringify({
        UserID: sku,
        Resources: {
            keys: ["Coins", "Life"],
            values: [10, 5]   // 시작 코인=10, 라이프=5
        },
        LastDisabledTime: "",
        MaxLife: 5,
        RefillInterval: 900,
        NextRefillRemainTime: 0,
        Level: 1,
        OpenLevel: 1,
        RewardStreak: -1,
        FreeSpin: 0
    });
}


// -----------------------------
// Render 지원 포트
// -----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});

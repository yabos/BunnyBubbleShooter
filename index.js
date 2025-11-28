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


// ------------------------------------------------------------
// LIFE 계산 함수 (쿨타임 유지 + 자연충전 시만 life 증가)
// ------------------------------------------------------------
function calculateLife(user) {
    const {
        life = 5,
        maxLives = 5,
        refillInterval = 900,
        lastLifeUpdate
    } = user;

    // 최대 생명 → 타이머 없음
    if (life >= maxLives) {
        return { life, nextRefillIn: 0, refillCount: 0 };
    }

    // lastLifeUpdate 없으면 풀 쿨타임
    if (!lastLifeUpdate) {
        return { life, nextRefillIn: refillInterval, refillCount: 0 };
    }

    const last = lastLifeUpdate.toDate();
    const now = new Date();
    let diffSec = Math.floor((now - last) / 1000);

    if (diffSec < 0) diffSec = 0;

    // 자연 충전된 개수
    const refillCount = Math.floor(diffSec / refillInterval);
    const newLife = Math.min(maxLives, life + refillCount);

    // 다음 충전까지 남은 시간
    let nextRefillIn = refillInterval - (diffSec % refillInterval);

    if (newLife >= maxLives) {
        nextRefillIn = 0;
    }

    return { life: newLife, nextRefillIn, refillCount };
}


// ------------------------------------------------------------
// SAVE API (절대 lastLifeUpdate 갱신하지 않음)
// ------------------------------------------------------------
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
        const docRef = firestore.collection("users").doc(sku);

        // Save에서는 life, json만 저장 (타이머 유지)
        await docRef.set({
            data: json,
            life,
            maxLives,
            refillInterval,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        res.json({ success: true });

    } catch (err) {
        console.error("SAVE ERROR:", err);
        res.status(500).json({ error: err.message });
    }
});


// ------------------------------------------------------------
// LOAD API (자연 충전 발생 시에만 lastLifeUpdate 갱신)
// ------------------------------------------------------------
app.post("/load", async (req, res) => {
    const { sku } = req.body;

    if (!sku) {
        return res.status(400).json({ error: "No SKU provided" });
    }

    try {
        const docRef = firestore.collection("users").doc(sku);
        const snap = await docRef.get();

        // 신규 유저 생성 -----------------------------------------------------
        if (!snap.exists) {

            const defaultJson = createDefaultSaveData(sku);
            const now = admin.firestore.FieldValue.serverTimestamp();

            await docRef.set({
                data: defaultJson,
                life: 5,
                maxLives: 5,
                refillInterval: 900,
                lastLifeUpdate: now,
                updatedAt: now
            });

            return res.json({
                exists: true,
                isNewUser: true,
                data: defaultJson,
                life: 5,
                maxLives: 5,
                refillInterval: 900,
                nextRefillIn: 0
            });
        }

        // 기존 유저 로직 -----------------------------------------------------
        const data = snap.data();
        const lifeResult = calculateLife(data);

        // refillCount > 0 → 자연충전 발생!
        if (lifeResult.refillCount > 0) {
            await docRef.update({
                life: lifeResult.life,
                lastLifeUpdate: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        else {
            // 자연충전 없었으면 life만 업데이트
            await docRef.update({
                life: lifeResult.life
            });
        }

        return res.json({
            exists: true,
            isNewUser: false,
            data: data.data,
            life: lifeResult.life,
            nextRefillIn: lifeResult.nextRefillIn,
            maxLives: data.maxLives,
            refillInterval: data.refillInterval
        });

    } catch (err) {
        console.error("LOAD ERROR:", err);
        return res.status(500).json({ error: err.message });
    }
});


// ------------------------------------------------------------
// 신규 유저 기본 JSON
// ------------------------------------------------------------
function createDefaultSaveData(sku) {
    return JSON.stringify({
        UserID: sku,
        Resources: {
            keys: ["Coins", "Life"],
            values: [10, 5]
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


// ------------------------------------------------------------
app.listen(3000, () => {
    console.log("Server running on port 3000");
});

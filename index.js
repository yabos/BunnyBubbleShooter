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

    // 최대 라이프면 남은 시간 없음
    if (life >= maxLives) {
        return { life, nextRefillIn: 0 };
    }

    // lastLifeUpdate 없음 → 풀 쿨타임
    if (!lastLifeUpdate) {
        return { life, nextRefillIn: refillInterval };
    }

    const last = lastLifeUpdate.toDate();
    const now = new Date();

    // 지난 시간
    let diffSec = Math.floor((now - last) / 1000);
    if (diffSec < 0) diffSec = 0;

    // ? remaining = 지금 refill까지 남은 시간
    let remaining = refillInterval - diffSec;
    if (remaining < 0) remaining = 0;

    // ? 핵심 1 ? diffSec이 매우 작을 때 (0~1초), remaining 유지
    // life가 감소했어도 remaining 유지되므로 쿨타임 리셋되면 안 됨
    if (diffSec === 0) {
        return { life, nextRefillIn: remaining };
    }

    // ? 경과 시간동안 채워진 하트 계산
    const refillCount = Math.floor(diffSec / refillInterval);
    const newLife = Math.min(maxLives, life + refillCount);

    // ? 다음 refill까지 남은 시간
    let nextRefillIn = refillInterval - (diffSec % refillInterval);

    // ? 하트가 꽉 찬 경우
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
        const docRef = firestore.collection("users").doc(sku);
        const snap = await docRef.get();

        let updateData = {
            data: json,
            life,
            maxLives,
            refillInterval,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (snap.exists) {
            const userData = snap.data();

            // ----- 노 변경 플래그 핵심 -----
            // life가 증가한 경우만 lastLifeUpdate 갱신
            if (life > Number(userData.life)) {
                updateData.lastLifeUpdate = admin.firestore.FieldValue.serverTimestamp();
            }
        } else {
            // 신규 데이터는 lastLifeUpdate 넣어도 OK
            updateData.lastLifeUpdate = admin.firestore.FieldValue.serverTimestamp();
        }

        await docRef.set(updateData, { merge: true });

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

        // -------------------------
        // ?? 신규 유저 로직
        // -------------------------
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
                isNewUser: true,
                data: defaultJson,
                life,
                maxLives,
                refillInterval,
                nextRefillIn: 0
            });
        }

        // -------------------------
        // ?? 기존 유저 로직
        // -------------------------
        const data = snap.data();

        // life 자동 계산
        const lifeResult = calculateLife(data);

        // 계산된 결과 업데이트
        await docRef.update({
            life: lifeResult.life            
        });

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


app.listen(3000, () => {
    console.log("Server running on port 3000");
});

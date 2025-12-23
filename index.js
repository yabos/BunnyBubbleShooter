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
// LIFE 계산 함수 (자연충전 + maxLife 도달 처리 포함)
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

    if (!lastLifeUpdate) {
        return { life, nextRefillIn: refillInterval, refillCount: 0 };
    }

    const last = lastLifeUpdate.toDate();
    const now = new Date();
    let diffSec = Math.floor((now - last) / 1000);
    if (diffSec < 0) diffSec = 0;

    // 자연 충전 개수
    const refillCount = Math.floor(diffSec / refillInterval);
    const newLife = Math.min(maxLives, life + refillCount);

    // 다음 충전까지 남은 시간
    let nextRefillIn = refillInterval - (diffSec % refillInterval);
    if (newLife >= maxLives) nextRefillIn = 0;

    return { life: newLife, nextRefillIn, refillCount };
}

// ------------------------------------------------------------
// 닉네임 생성 및 중복 체크 헬퍼
// ------------------------------------------------------------
async function generateUniqueNickname() {
    let nickname = "";
    let exists = true;
    let tryCount = 0;

    while (exists && tryCount < 10) {
        // 8자리 랜덤 숫자 생성
        const randomNum = Math.floor(Math.random() * 100000000).toString().padStart(8, '0');
        nickname = `Player${randomNum}`;

        // 중복 체크
        // 주의: nickname 필드에 인덱스가 없다면 쿼리가 느리거나 실패할 수 있음
        const snap = await admin.firestore().collection("users").where("nickname", "==", nickname).limit(1).get();
        if (snap.empty) {
            exists = false;
        }
        tryCount++;
    }
    
    // 10번 실패하면 시간 기반으로 생성 (중복 방지 최후의 수단)
    if (exists) {
        nickname = `Player${Date.now().toString().slice(-8)}`;
    }

    return nickname;
}

// ------------------------------------------------------------
// SAVE API – life 변화 저장 / 타이머는 건드리지 않음
// ------------------------------------------------------------
app.post("/save", async (req, res) => {
    let { sku, clientAppVer, json, life, maxLives, refillInterval, isPromotionRewardGranted } = req.body;

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

        // 1. 현재 저장된 데이터 가져오기 (레벨 비교를 위해)
        const docSnap = await docRef.get();
        let currentLevel = 0;
        
        if (docSnap.exists) {
            currentLevel = docSnap.data().level || 0;
        }

        // 2. 요청된 JSON에서 새 레벨 추출
        let newLevel = 0;
        try {
            const parsedData = JSON.parse(json);
            if (parsedData.Level) {
                newLevel = Number(parsedData.Level);
            }
        } catch (e) {
            console.error("JSON Parse Error for Level:", e);
        }

        // 3. 업데이트 페이로드 구성
        let updateData = {
            clientAppVer: clientAppVer ?? "", 
            data: json,            
            life,
            maxLives,
            refillInterval,
            level: newLevel, // 최상위 필드에 레벨 저장
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
			isPromotionRewardGranted: promoGranted
        };

        // ⭐ 레벨이 상승했을 때만 '달성 시간' 갱신 (먼저 깬 사람 우대)
        // 신규 유저이거나, 레벨이 올랐을 때
        if (!docSnap.exists || newLevel > currentLevel) {
            updateData.levelUpdatedAt = admin.firestore.FieldValue.serverTimestamp();
        } 
        
        await docRef.set(updateData, { merge: true });

        res.json({ success: true });

    } catch (err) {
        console.error("SAVE ERROR:", err);
        res.status(500).json({ error: err.message });
    }
});


// ------------------------------------------------------------
// LOAD API – 자연충전 / maxLife 도달 시 타이머 초기화
// ------------------------------------------------------------
app.post("/load", async (req, res) => {
    const { sku } = req.body;

    if (!sku) {
        return res.status(400).json({ error: "No SKU provided" });
    }

    try {
        const docRef = firestore.collection("users").doc(sku);
        const snap = await docRef.get();

        // 신규 유저 생성 ----------------------------------------
        if (!snap.exists) {

            const defaultJson = createDefaultSaveData(sku);
            const now = admin.firestore.FieldValue.serverTimestamp();
            const nickname = await generateUniqueNickname(); // 닉네임 생성

            await docRef.set({
                data: defaultJson,
                life: 5,
                maxLives: 5,
                refillInterval: 900,
                lastLifeUpdate: now,
                updatedAt: now,
                level: 1,
                nickname: nickname,
                isPromotionRewardGranted: false
            });

            return res.json({
                exists: true,
                isNewUser: true,
                data: defaultJson,
                life: 5,
                maxLives: 5,
                refillInterval: 900,
                nextRefillIn: 0,
                nickname: nickname,
				isPromotionRewardGranted: false
            });
        }

        // 기존 유저 ----------------------------------------------
        const data = snap.data();
        
        // 닉네임 없으면 생성 후 저장
        let nickname = data.nickname;
        if (!nickname) {
            nickname = await generateUniqueNickname();
            await docRef.update({ nickname: nickname });
        }

        const lifeResult = calculateLife(data);

        let updatePayload = {
            life: lifeResult.life
        };

        // ⭐ 자연 충전 (refillCount > 0) → 타이머 초기화
        if (lifeResult.refillCount > 0) {
            updatePayload.lastLifeUpdate = admin.firestore.FieldValue.serverTimestamp();
            updatePayload.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        }
        // ⭐ maxLife 도달 → 타이머 초기화 (중요)
        else if (lifeResult.life === data.maxLives) {
            updatePayload.lastLifeUpdate = admin.firestore.FieldValue.serverTimestamp();
            updatePayload.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        }

        // 업데이트 적용
        await docRef.update(updatePayload);

        return res.json({
            exists: true,
            isNewUser: false,
            data: data.data,
            life: lifeResult.life,
            nextRefillIn: lifeResult.nextRefillIn,
            maxLives: data.maxLives,
            refillInterval: data.refillInterval,
            nickname: nickname // 반환
			isPromotionRewardGranted: data.isPromotionRewardGranted || false
        });

    } catch (err) {
        console.error("LOAD ERROR:", err);
        return res.status(500).json({ error: err.message });
    }
});


// ------------------------------------------------------------
// RANKING API
// ------------------------------------------------------------
app.post("/ranking", async (req, res) => {
    const { sku } = req.body; // 내 순위 확인용

    try {
        // 1. 랭킹 쿼리
        // 정렬: 레벨(높은순) -> 달성시간(빠른순)
        // 인덱스 필요: level(DESC) + levelUpdatedAt(ASC)
        
        const usersRef = firestore.collection("users");
        
        // "toss : T" 필터링을 위해 넉넉히 가져옴 (limit 100~200)
        const snapshot = await usersRef
            .orderBy("level", "desc")
            .orderBy("levelUpdatedAt", "asc")
            .limit(200) 
            .get();

        let rankingList = [];
        let rankCounter = 1;

        snapshot.forEach(doc => {
            const userData = doc.data();
            
            // "toss : T" 버전 유저만 필터링
            if (userData.clientAppVer && userData.clientAppVer.includes("toss : T")) {
                rankingList.push({
                    rank: rankCounter++,
                    userId: doc.id,
                    nickname: userData.nickname || "Unknown", // 닉네임
                    level: userData.level || 1,
                    // 필요한 경우 점수나 기타 정보 추가
                });
            }
        });

        // 상위 50명 자르기
        const top50 = rankingList.slice(0, 50);

        // 2. 내 랭킹 정보 찾기
        let myRankData = null;
        
        // 1) 탑 50 안에 내가 있는가?
        const myEntry = top50.find(u => u.userId === sku);
        
        if (myEntry) {
            myRankData = myEntry;
        } else {
            // 2) 없으면 내 정보 별도 조회
            const myDoc = await usersRef.doc(sku).get();
            if (myDoc.exists) {
                const myData = myDoc.data();
                
                // 내가 "toss : T" 유저인지 확인
                const isTossUser = myData.clientAppVer && myData.clientAppVer.includes("toss : T");
                
                myRankData = {
                    rank: -1, // 순위권 밖 표기
                    userId: sku,
                    nickname: myData.nickname || "Unknown", // 닉네임
                    level: myData.level || 1,
                    isTargetVersion: isTossUser // 참고용 플래그
                };
            }
        }

        res.json({
            ranking: top50,
            myRank: myRankData
        });

    } catch (err) {
        console.error("RANKING ERROR:", err);
        res.status(500).json({ error: err.message });
    }
});


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
        RefillInterval: 30,
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

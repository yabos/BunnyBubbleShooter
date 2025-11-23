const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

// Firebase Admin key 불러오기
const serviceAccount = require("./serviceAccountKey.json");

// Firestore 초기화
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const firestore = admin.firestore();

const app = express();
app.use(express.json());
app.use(cors());

// 서버 테스트용
app.get("/", (req, res) => {
    res.send("Node.js + Firebase Firestore Server Running!");
});

// 저장 API
app.post("/save", async (req, res) => {
    const { sku, json } = req.body;

    if (!sku || !json) {
        return res.status(400).json({ error: "missing sku or json" });
    }

    try {
        await firestore.collection("users").doc(sku).set({
            data: json,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 불러오기 API
app.post("/load", async (req, res) => {
    console.log(">>> /load called:", req.body);

    const { sku } = req.body;

    if (!sku) {
        return res.status(400).json({ error: "No SKU provided" });
    }

    try {
        const docRef = firestore.collection("users").doc(sku);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            // 신규 계정
            return res.json({
                exists: false
            });
        }

        const data = docSnap.data();

        if (!data || !data.data) {
            // 데이터 구조가 없거나 비정상일 경우
            return res.json({
                exists: false
            });
        }

        return res.json({
            exists: true,
            data: data.data
        });

    } catch (err) {
        console.error("LOAD ERROR:", err);
        return res.status(500).json({ error: err.message });
    }
});


app.listen(3000, () => {
    console.log("Server running on port 3000");
});

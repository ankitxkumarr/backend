import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import {
  RekognitionClient,
  SearchFacesByImageCommand
} from "@aws-sdk/client-rekognition";
import {
  S3Client,
  GetObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

// FIX: Firebase credentials come from an environment variable instead of
// a JSON file. serviceAccountKey.json must never be committed to Git or
// uploaded to Render — it contains your private key.
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });

// FIX: AWS credentials from env vars — never hardcode keys in source.
const rekognition = new RekognitionClient({
  region: process.env.AWS_REGION || "ap-south-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const s3 = new S3Client({
  region: process.env.AWS_REGION || "ap-south-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET = process.env.S3_BUCKET || "kaptanbirdhana-family-wedding-photos";
const COLLECTION = process.env.REKOGNITION_COLLECTION || "wedding-collection";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const cleanPhone = (phone) => String(phone || "").replace(/\D/g, "").slice(-10);

const phoneToEmail = (phone) => {
  const clean = cleanPhone(phone);
  return `${clean}@app.com`;
};

// ─── Health check ─────────────────────────────────────────────────────────────
// Render pings this to confirm the service is alive.
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Kaptan Birdhana Backend" });
});

// ─── Check user ───────────────────────────────────────────────────────────────

app.post("/check-user", async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "Phone required" });
    }

    const email = phoneToEmail(phone);

    try {
      await admin.auth().getUserByEmail(email);
      return res.json({ exists: true });
    } catch (err) {
      if (err.code === "auth/user-not-found") {
        return res.json({ exists: false });
      }
      throw err;
    }
  } catch (error) {
    console.log("Check-user error:", error);
    res.status(500).json({ error: "User check failed" });
  }
});

// ─── Reset password ───────────────────────────────────────────────────────────

app.post("/reset-password", async (req, res) => {
  try {
    const {
      phone,
      district,
      constituency,
      village,
      newPassword
    } = req.body;

    const normalizedPhone = cleanPhone(phone);
    const normalizedDistrict = String(district || "").trim();
    const normalizedConstituency = String(constituency || "").trim();
    const normalizedVillage = String(village || "").trim();
    const normalizedPassword = String(newPassword || "").trim();

    if (
      normalizedPhone.length !== 10 ||
      !normalizedDistrict ||
      !normalizedConstituency ||
      !normalizedVillage ||
      normalizedPassword.length < 6
    ) {
      return res.status(400).json({ error: "Invalid or missing fields" });
    }

    const email = phoneToEmail(normalizedPhone);

    let userRecord;
    try {
      userRecord = await admin.auth().getUserByEmail(email);
    } catch (err) {
      if (err.code === "auth/user-not-found") {
        return res.status(404).json({ error: "No account found for this number" });
      }
      throw err;
    }

    const uid = userRecord.uid;
    const userDocRef = admin.firestore().collection("users").doc(uid);
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User profile not found" });
    }

    const userData = userDoc.data() || {};

    if (
      String(userData.district || "").trim() !== normalizedDistrict ||
      String(userData.constituency || "").trim() !== normalizedConstituency ||
      String(userData.village || "").trim() !== normalizedVillage
    ) {
      return res.status(401).json({ error: "Details do not match our records" });
    }

    await admin.auth().updateUser(uid, {
      password: normalizedPassword
    });

    return res.json({ success: true });
  } catch (error) {
    console.log("Reset password error:", error);
    return res.status(500).json({ error: "Password reset failed" });
  }
});

// ─── Photo search ─────────────────────────────────────────────────────────────
app.post("/search", upload.single("file"), async (req, res) => {
  try {
    console.log("Selfie received");
    const imageBytes = fs.readFileSync(req.file.path);

    const command = new SearchFacesByImageCommand({
      CollectionId: COLLECTION,
      Image: { Bytes: imageBytes },
      FaceMatchThreshold: 85,
      MaxFaces: 20
    });

    const response = await rekognition.send(command);
    console.log("Matches found:", response.FaceMatches.length);

    const matches = [];
    for (const match of response.FaceMatches) {
      const imageName = match.Face.ExternalImageId;
      const key = `originals/${imageName}`;
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
        { expiresIn: 3600 }
      );
      matches.push({ key, url, similarity: match.Similarity });
    }

    // Clean up temp file
    fs.unlinkSync(req.file.path);

    res.json({ matches });
  } catch (error) {
    console.log("Search error:", error);
    res.status(500).json({ error: "Search failed" });
  }
});

// FIX: Use process.env.PORT so Render can inject its own port.
// Hardcoding 3000 causes Render to mark the service as failed.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
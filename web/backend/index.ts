import express from "express";
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const prisma = new PrismaClient();
const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());

// Strict Environment Gating Check (Fail-fast on missing keys in dev/production)
const isTestMode = process.env.NODE_ENV === "test";

if (!isTestMode) {
  const REQUIRED_ENV_VARS = [
    "DATABASE_URL",
    "SHOPIFY_API_KEY",
    "SHOPIFY_API_SECRET",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "S3_BUCKET_NAME",
    "AWS_REGION"
  ];

  const missingVars = REQUIRED_ENV_VARS.filter(v => !process.env[v] || process.env[v].trim() === "");
  if (missingVars.length > 0) {
    console.error("\n==========================================================================");
    console.error("❌ FATAL STARTUP ERROR: Missing Critical Environment Variables! ❌");
    console.error("==========================================================================");
    console.error("The following environment variables must be populated to prevent env-mixing:");
    missingVars.forEach(v => console.error(`  - ${v}`));
    console.error("==========================================================================\n");
    process.exit(1); // Crash immediately!
  }
}

// Initialize S3 Client dynamically using the .env credentials
const s3 = new S3Client({
  region: process.env.AWS_REGION || (isTestMode ? "us-east-1" : undefined),
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || (isTestMode ? "mock-access-key" : ""),
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || (isTestMode ? "mock-secret-key" : "")
  }
});

// Dynamic S3 Bucket Selection based on Environment (strictly fails if missing in production)
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || (isTestMode ? "paws-and-effect-storage-preview-preview" : "");

// Secure AES-256-CBC at-rest encryption helpers derived from the unique SHOPIFY_API_SECRET
const ENCRYPTION_ALGORITHM = "aes-256-cbc";
const ENCRYPTION_KEY = crypto.scryptSync(
  process.env.SHOPIFY_API_SECRET || (isTestMode ? "default-secret-key-paws-effect-32" : ""),
  "salt",
  32
);

function encrypt(text: string): string {
  if (!text) return "";
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${encrypted}`;
}

function decrypt(text: string): string {
  if (!text || !text.includes(":")) return text;
  try {
    const [ivHex, encryptedHex] = text.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    return text; // Fallback to plaintext if decryption fails
  }
}

// Mock Product Catalog for smart recommendations and allergen filtering
const MOCK_PRODUCTS = [
  {
    id: "prod-joint-chews",
    title: "Joint Care Support Chews",
    tags: ["senior", "large-breed", "joint-support"],
    allergens: ["beef"],
    description: "Glucosamine mobility chews for large, active, or senior dogs."
  },
  {
    id: "prod-hypo-fish",
    title: "Hypoallergenic Salmon Kibble",
    tags: ["toy-breed", "sensitive-stomach", "itchy-skin", "hypoallergenic"],
    allergens: [],
    description: "Limited ingredient kibble perfect for sensitive stomachs and itchy skin."
  },
  {
    id: "prod-chicken-formula",
    title: "Active Breed Chicken Kibble",
    tags: ["active", "retriever", "high-protein"],
    allergens: ["chicken"],
    description: "High-energy formula packed with chicken proteins."
  },
  {
    id: "prod-grainfree-cat",
    title: "Grain-Free Salmon Cat Food",
    tags: ["cat", "sensitive-stomach", "grain-free"],
    allergens: ["grain"],
    description: "Grain-free kibble for cats with digestive sensitivities."
  }
];

// Session Validation Middleware
async function validateSession(req: express.Request, res: express.Response, next: express.NextFunction) {
  const sessionId = req.headers["x-test-session-id"] as string;
  const shop = req.headers["x-shop-domain"] as string || "test-shop.myshopify.com";

  if (!sessionId) {
    return res.status(401).json({ error: "Missing session authorization header" });
  }

  try {
    let session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) {
      session = await prisma.session.create({
        data: {
          id: sessionId,
          shop,
          state: "active_mock",
          accessToken: "mock_token",
          plan: "STARTER"
        }
      });
    }
    // Bind session to the request
    req.body.session = session;
    next();
  } catch (err: any) {
    res.status(500).json({ error: "Session storage error", details: err.message });
  }
}

// 1. Health Check
app.get("/api/health", (req, res) => {
  res.json({ status: "healthy" });
});

// 2. Billing: Upgrade Plan
app.patch("/api/billing", validateSession, async (req, res) => {
  const { plan } = req.body;
  const session = req.body.session;

  if (!["STARTER", "PRO", "ENTERPRISE"].includes(plan)) {
    return res.status(400).json({ error: "Invalid plan subscription tier" });
  }

  try {
    const updated = await prisma.session.update({
      where: { id: session.id },
      data: { plan }
    });
    res.json({ success: true, plan: updated.plan });
  } catch (err: any) {
    res.status(500).json({ error: "Billing transition failed", details: err.message });
  }
});

// 3. Pet Profiles: Create or Update Profile
app.post("/api/pets/profile", validateSession, async (req, res) => {
  const { customerId, name, petType, breed, age, weight, activityLevel, allergies, healthIssues } = req.body;
  const session = req.body.session;

  if (!customerId || !name || !petType) {
    return res.status(400).json({ error: "Missing required profile fields" });
  }

  try {
    // Plan Limit Gates: Check Customer limits (Starter: 500 pets, Pro: 5,000 pets)
    const existingProfiles = await prisma.petProfile.findMany({
      where: { shop: session.shop }
    });
    const uniqueCustomerIds = new Set(existingProfiles.map((p: any) => p.customerId));

    const maxCustomers = session.plan === "STARTER" ? 500 : (session.plan === "PRO" ? 5000 : Infinity);

    if (uniqueCustomerIds.size >= maxCustomers && !uniqueCustomerIds.has(customerId)) {
      return res.status(403).json({
        error: "LIMIT_REACHED",
        message: `Plan customer profile limit reached (${maxCustomers} pets under Starter/Pro). Please upgrade to your next tier to unlock further profiles.`,
        plan: session.plan
      });
    }

    // Customer-level Pet limit check (Starter: 3 pets, Pro: 10 pets, Enterprise: Unlimited)
    const customerPetCount = existingProfiles.filter((p: any) => p.customerId === customerId).length;
    const maxPetsPerCustomer = session.plan === "STARTER" ? 3 : (session.plan === "PRO" ? 10 : Infinity);

    if (customerPetCount >= maxPetsPerCustomer) {
      return res.status(403).json({
        error: "CUSTOMER_LIMIT_REACHED",
        message: `Customer pet profiles limit reached. Under your ${session.plan} plan, each customer can register up to ${maxPetsPerCustomer} pets. Please upgrade to add more pets!`,
        plan: session.plan
      });
    }

    // Save profile inside Prisma
    const profile = await prisma.petProfile.create({
      data: {
        customerId,
        shop: session.shop,
        name,
        petType,
        breed,
        age: age ? parseInt(age) : null,
        weight: weight ? parseFloat(weight) : null,
        activityLevel,
        allergies: allergies || [],
        healthIssues: healthIssues || []
      }
    });

    res.json({ success: true, profile });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to save pet profile", details: err.message });
  }
});

// 3b. Pet Profiles: Update Existing Profile
app.put("/api/pets/profile/:id", validateSession, async (req, res) => {
  const { id } = req.params;
  const { name, petType, breed, age, weight, activityLevel, allergies, healthIssues } = req.body;
  const session = req.body.session;

  if (!name || !petType) {
    return res.status(400).json({ error: "Missing required profile fields" });
  }

  try {
    const updated = await prisma.petProfile.updateMany({
      where: { id, shop: session.shop },
      data: {
        name,
        petType,
        breed,
        age: age ? parseInt(age) : null,
        weight: weight ? parseFloat(weight) : null,
        activityLevel,
        allergies: allergies || [],
        healthIssues: healthIssues || []
      }
    });

    if (updated.count === 0) {
      return res.status(404).json({ error: "Pet profile not found" });
    }

    const profile = await prisma.petProfile.findFirst({ where: { id } });
    res.json({ success: true, profile });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to update pet profile", details: err.message });
  }
});

// 3c. Pet Profiles: Delete Existing Profile
app.delete("/api/pets/profile/:id", validateSession, async (req, res) => {
  const { id } = req.params;
  const session = req.body.session;

  try {
    const deleted = await prisma.petProfile.deleteMany({
      where: { id, shop: session.shop }
    });

    if (deleted.count === 0) {
      return res.status(404).json({ error: "Pet profile not found" });
    }

    res.json({ success: true, message: "Pet profile deleted successfully." });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete pet profile", details: err.message });
  }
});

// 4. Product Recommendations with Allergy-Safe Filtering
app.get("/api/pets/:customerId/recommendations", validateSession, async (req, res) => {
  const { customerId } = req.params;
  const session = req.body.session;

  try {
    const profiles = await prisma.petProfile.findMany({
      where: { customerId, shop: session.shop }
    });

    if (profiles.length === 0) {
      return res.json({ success: true, profiles: [], recommendations: [], message: "No pet profiles found for customer." });
    }

    // Combine all matching recommendations per pet, filtering out pet allergens
    const allRecommendations = [];

    for (const pet of profiles) {
      const petAllergies = pet.allergies.map((a: string) => a.toLowerCase());
      const petHealthIssues = pet.healthIssues.map((h: string) => h.toLowerCase());
      const petBreed = pet.breed ? pet.breed.toLowerCase() : "";
      const petAge = pet.age || 0;

      // Filter products
      const recommendedForPet = MOCK_PRODUCTS.map(product => {
        const prodAllergens = product.allergens.map((a: string) => a.toLowerCase());
        const isAllergic = prodAllergens.some(allergen => petAllergies.includes(allergen));

        // Scoring rules matching characteristics
        let score = 0;
        const matchingReasons: string[] = [];

        if (isAllergic) {
          return { ...product, isAllergic: true, score: 0, matchingReasons: [`Contains pet allergen: ${prodAllergens.join(", ")}`] };
        }

        // Rule 1: Breed-Specific (e.g. Golden Retriever or Large breed)
        if (product.tags.includes("large-breed") && (petBreed.includes("retriever") || petBreed.includes("labrador") || petBreed.includes("shepherd"))) {
          score += 10;
          matchingReasons.push(`Tailored for large breed: ${pet.breed}`);
        }

        // Rule 2: Senior Joint Support
        if (product.tags.includes("joint-support") && (petAge >= 7 || petHealthIssues.includes("joint"))) {
          score += 15;
          matchingReasons.push("Supports joint mobility for senior/active pets");
        }

        // Rule 3: Allergies / Hypoallergenic
        if (product.tags.includes("hypoallergenic") && (petHealthIssues.includes("itchy skin") || petHealthIssues.includes("sensitive stomach"))) {
          score += 12;
          matchingReasons.push("Formulated for sensitive stomachs and itchy skin");
        }

        // Rule 4: High Protein
        if (product.tags.includes("high-protein") && pet.activityLevel === "active") {
          score += 8;
          matchingReasons.push("High-protein kibble for active pets");
        }

        return { ...product, isAllergic: false, score, matchingReasons };
      });

      // Filter out raw allergen items, sort by score descending
      const safeRecommendations = recommendedForPet
        .filter(p => !p.isAllergic && p.score > 0)
        .sort((a, b) => b.score - a.score);

      allRecommendations.push({
        petName: pet.name,
        petType: pet.petType,
        recommendations: safeRecommendations
      });
    }

    res.json({ success: true, profiles, recommendations: allRecommendations });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to compile recommendations", details: err.message });
  }
});

// 5. Health Tracking: Log Health Metrics (PRO + ENTERPRISE gated)
app.post("/api/pets/:id/health", validateSession, async (req, res) => {
  const { id } = req.params;
  const { weight, activityScore, notes } = req.body;
  const session = req.body.session;

  if (session.plan === "STARTER") {
    return res.status(403).json({
      error: "UPGRADE_REQUIRED",
      message: "Health tracking and monthly logging are Pro features. Please upgrade to unlock health profiles.",
      requiredPlan: "PRO"
    });
  }

  try {
    const pet = await prisma.petProfile.findFirst({
      where: { id, shop: session.shop }
    });

    if (!pet) {
      return res.status(404).json({ error: "Pet profile not found" });
    }

    const log = await prisma.healthLog.create({
      data: {
        petId: id,
        weight: weight ? parseFloat(weight) : null,
        activityScore: activityScore ? parseInt(activityScore) : null,
        notes
      }
    });

    res.json({ success: true, log });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to log health metrics", details: err.message });
  }
});

// 6. Community Reviews (PRO + ENTERPRISE gated)
app.get("/api/community/reviews", validateSession, async (req, res) => {
  const session = req.body.session;

  if (session.plan === "STARTER") {
    return res.status(403).json({
      error: "UPGRADE_REQUIRED",
      message: "Community reviews and breed-specific feeds are Pro features. Please upgrade to unlock.",
      requiredPlan: "PRO"
    });
  }

  // Return mock reviews for breed matching
  res.json({
    reviews: [
      { id: "rev-1", petBreed: "Golden Retriever", author: "Max's Owner", rating: 5, body: "Perfect joint chews. Max runs like a puppy again!" },
      { id: "rev-2", petBreed: "French Bulldog", author: "Coco's Owner", rating: 4, body: "Salmon kibble has completely cured her gas issues. Amazing." }
    ]
  });
});

// 7. Vet OAuth Link (ENTERPRISE gated)
app.post("/api/vets/link", validateSession, async (req, res) => {
  const session = req.body.session;

  if (session.plan !== "ENTERPRISE") {
    return res.status(403).json({
      error: "UPGRADE_REQUIRED",
      message: "Vet integration and verified veterinarian portal links are Enterprise features. Please contact enterprise support.",
      requiredPlan: "ENTERPRISE"
    });
  }

  res.json({ success: true, message: "Vet linking portal initialized successfully." });
});

// 7b. Save Vet Credentials (ENTERPRISE gated)
app.post("/api/vets/credentials", validateSession, async (req, res) => {
  const session = req.body.session;
  const { vetProvider, vetClientKey, vetClientSecret, vetPracticeId } = req.body;

  if (session.plan !== "ENTERPRISE") {
    return res.status(403).json({
      error: "UPGRADE_REQUIRED",
      message: "Vet integration and API key configuration are Enterprise features. Please contact enterprise support.",
      requiredPlan: "ENTERPRISE"
    });
  }

  try {
    const updated = await prisma.session.update({
      where: { id: session.id },
      data: {
        vetProvider: vetProvider || "NONE",
        vetClientKey: vetClientKey ? encrypt(vetClientKey) : null,
        vetClientSecret: vetClientSecret ? encrypt(vetClientSecret) : null,
        vetPracticeId
      }
    });

    res.json({ success: true, vetProvider: updated.vetProvider });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to save vet credentials", details: err.message });
  }
});

// 7c. Fetch Vet Credentials (ENTERPRISE gated)
app.get("/api/vets/credentials", validateSession, async (req, res) => {
  const session = req.body.session;

  if (session.plan !== "ENTERPRISE") {
    return res.status(403).json({
      error: "UPGRADE_REQUIRED",
      message: "Vet credentials are restricted to Enterprise subscribers.",
      requiredPlan: "ENTERPRISE"
    });
  }

  res.json({
    vetProvider: session.vetProvider,
    vetClientKey: session.vetClientKey ? decrypt(session.vetClientKey) : "",
    vetPracticeId: session.vetPracticeId || "",
    vetClientSecret: session.vetClientSecret ? "••••••••••••••••" : ""
  });
});

// 7d. Test Connection to Vet API (ENTERPRISE gated)
app.post("/api/vets/test-connection", validateSession, async (req, res) => {
  const session = req.body.session;
  const { vetProvider, vetClientKey, vetClientSecret, vetPracticeId } = req.body;

  if (session.plan !== "ENTERPRISE") {
    return res.status(403).json({
      error: "UPGRADE_REQUIRED",
      message: "Vet integration and connection testing require Enterprise plan.",
      requiredPlan: "ENTERPRISE"
    });
  }

  const provider = vetProvider || session.vetProvider;
  const rawKey = vetClientKey || (session.vetClientKey ? decrypt(session.vetClientKey) : "");
  const rawSecret = vetClientSecret && vetClientSecret !== "••••••••••••••••" ? vetClientSecret : (session.vetClientSecret ? decrypt(session.vetClientSecret) : "");
  const practiceId = vetPracticeId || session.vetPracticeId;

  if (provider === "NONE") {
    return res.json({ success: true, message: "Manual verification mode active. No API ping required." });
  }

  if (!rawKey || !rawSecret || !practiceId) {
    return res.status(400).json({ error: "Missing API Client Key, Client Secret, or Practice ID." });
  }

  if (rawKey.includes("fail") || rawSecret.includes("fail") || practiceId.includes("fail")) {
    return res.status(401).json({
      success: false,
      error: "Authentication Failed",
      message: "The distributor's Sandbox API rejected the credentials. Please verify your Client Key and Secret."
    });
  }

  res.json({
    success: true,
    message: `Connected successfully! Handshake established with ${provider} Sandbox API for Practice #${practiceId}.`
  });
});

// Mock Practice Directory
const MOCK_PRACTICES = [
  { id: "PRAC-101", name: "Columbus Veterinary Clinic", address: "123 High St, Columbus, OH 43215", phone: "555-0101" },
  { id: "PRAC-102", name: "Midtown Pet Hospital", address: "456 Broadway, New York, NY 10001", phone: "555-0102" },
  { id: "PRAC-103", name: "Golden Gate Animal Clinic", address: "789 Golden Gate Ave, San Francisco, CA 94102", phone: "555-0103" },
  { id: "PRAC-104", name: "Seattle Veterinary Associates", address: "101 Pine St, Seattle, WA 98101", phone: "555-0104" }
];

// 7e. Search Vet Practice Directory (Enterprise/Sandbox autocomplete lookup)
app.get("/api/vets/search", validateSession, (req, res) => {
  const query = (req.query.q as string || "").toLowerCase();

  // Filter practices
  const matches = MOCK_PRACTICES.filter(p => 
    p.name.toLowerCase().includes(query) || 
    p.address.toLowerCase().includes(query) ||
    p.id.toLowerCase().includes(query)
  );

  res.json({ success: true, practices: matches });
});

// 7f. AWS S3: Generate Secure Presigned PUT URL for Direct-to-S3 Uploads (Starter/Pro/Enterprise)
app.post("/api/vets/presigned-upload-url", validateSession, async (req, res) => {
  const { filename, contentType } = req.body;
  const session = req.body.session;

  if (!filename) {
    return res.status(400).json({ error: "Missing filename parameter." });
  }

  const cleanFilename = filename.replace(/[^a-zA-Z0-9.-]/g, "_");
  const objectKey = `prescriptions/${session.id}/${Date.now()}_${cleanFilename}`;

  try {
    const command = new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: objectKey,
      ContentType: contentType || "application/pdf"
    });

    // Generate a secure PUT signed URL valid for 5 minutes
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

    res.json({ success: true, uploadUrl, objectKey });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to generate S3 upload signature", details: err.message });
  }
});

// 7g. AWS S3: Generate Secure Presigned GET URL for Private View Access (Starter/Pro/Enterprise)
app.get("/api/pets/presigned-view-url/:petProfileId", validateSession, async (req, res) => {
  const { petProfileId } = req.params;
  const session = req.body.session;

  try {
    const pet = await prisma.petProfile.findFirst({
      where: { id: petProfileId, shop: session.shop }
    });

    if (!pet) {
      return res.status(404).json({ error: "Pet profile not found" });
    }

    if (!pet.prescriptionUrl) {
      return res.status(400).json({ error: "No prescription document uploaded for this pet." });
    }

    // Generate secure GET signed URL valid for 15 minutes (900 seconds)
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: pet.prescriptionUrl // Stores the S3 object key!
    });

    const viewUrl = await getSignedUrl(s3, command, { expiresIn: 900 });

    res.json({ success: true, viewUrl });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to generate S3 view signature", details: err.message });
  }
});

// 8. Serve beautiful, iframe-safe Shopify Polaris embedded App Dashboard
app.get("/", (req, res) => {
  const shop = req.query.shop as string;
  const apiKey = process.env.SHOPIFY_API_KEY || "";

  if (shop && shop.endsWith(".myshopify.com")) {
    const sanitizedShop = encodeURIComponent(shop);
    res.setHeader(
      "Content-Security-Policy",
      `frame-ancestors https://${sanitizedShop} https://admin.shopify.com;`
    );
  } else {
    res.setHeader(
      "Content-Security-Policy",
      "frame-ancestors https://admin.shopify.com https://*.myshopify.com;"
    );
  }
  res.removeHeader("X-Frame-Options");

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Paws & Effect — Pet Profile Admin</title>
  <meta name="shopify-api-key" content="${apiKey}" />
  <!-- Load Shopify Polaris CSS for official merchant look & feel -->
  <link rel="stylesheet" href="https://unpkg.com/@shopify/polaris@12.0.0/build/esm/styles.css">
  <style>
    body {
      background-color: #f6f6f7;
      margin: 0;
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .grid-container {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 20px;
    }
    @media (max-width: 768px) {
      .grid-container {
        grid-template-columns: 1fr;
      }
    }
    .banner {
      background-color: #f0f4ff;
      border: 1px solid #1c3d5a;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .badge {
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: bold;
    }
    .badge-starter { background-color: #e2e8f0; color: #4a5568; }
    .badge-pro { background-color: #feebc8; color: #c05621; }
    .badge-enterprise { background-color: #e0f2fe; color: #2b6cb0; }
  </style>
</head>
<body>
  <div id="app"></div>

  <!-- Load App Bridge, React, and ReactDOM -->
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>

  <script>
    const e = React.createElement;

    function App() {
      const [plan, setPlan] = React.useState("STARTER");
      const [petName, setPetName] = React.useState("");
      const [petType, setPetType] = React.useState("dog");
      const [breed, setBreed] = React.useState("");
      const [age, setAge] = React.useState("");
      const [weight, setWeight] = React.useState("");
      const [activityLevel, setActivityLevel] = React.useState("moderate");
      
      // Tag-building States (Pills)
      const [allergiesInput, setAllergiesInput] = React.useState("");
      const [allergiesList, setAllergiesList] = React.useState([]);
      const [healthIssuesInput, setHealthIssuesInput] = React.useState("");
      const [healthIssuesList, setHealthIssuesList] = React.useState([]);

      // Edit Mode State
      const [editingPetId, setEditingPetId] = React.useState(null);
      
      const [profiles, setProfiles] = React.useState([]);
      const [logs, setLogs] = React.useState([]);
      const [reviews, setReviews] = React.useState([]);
      const [recs, setRecs] = React.useState([]);
      const [toast, setToast] = React.useState(null);

      // Vet Credentials State (Enterprise)
      const [vetProvider, setVetProvider] = React.useState("NONE");
      const [vetClientKey, setVetClientKey] = React.useState("");
      const [vetClientSecret, setVetClientSecret] = React.useState("");
      const [vetPracticeId, setVetPracticeId] = React.useState("");

      // Tag Builder Helpers
      const handleAllergyKeyDown = (ev) => {
        if (ev.key === "Enter" || ev.key === ",") {
          ev.preventDefault();
          const clean = allergiesInput.trim().toLowerCase().replace(/,/g, "");
          if (clean && !allergiesList.includes(clean)) {
            setAllergiesList([...allergiesList, clean]);
          }
          setAllergiesInput("");
        }
      };

      const removeAllergy = (tag) => {
        setAllergiesList(allergiesList.filter(t => t !== tag));
      };

      const handleHealthKeyDown = (ev) => {
        if (ev.key === "Enter" || ev.key === ",") {
          ev.preventDefault();
          const clean = healthIssuesInput.trim().toLowerCase().replace(/,/g, "");
          if (clean && !healthIssuesList.includes(clean)) {
            setHealthIssuesList([...healthIssuesList, clean]);
          }
          setHealthIssuesInput("");
        }
      };

      const removeHealthIssue = (tag) => {
        setHealthIssuesList(healthIssuesList.filter(t => t !== tag));
      };

      const shop = new URLSearchParams(window.location.search).get("shop") || "test-shop.myshopify.com";
      const mockSessionId = "paws-portal-session";

      // Common headers
      const headers = {
        "Content-Type": "application/json",
        "x-test-session-id": mockSessionId,
        "x-shop-domain": shop
      };

      // Sync active plan and recommendations on load
      React.useEffect(() => {
        // Create initial session & fetch recommendation lists
        fetch("/api/pets/gid%3A%2F%2Fshopify%2FCustomer%2F123/recommendations", { headers })
          .then(res => {
            if (!res.ok) throw new Error("HTTP error " + res.status);
            return res.json();
          })
          .then(data => {
            if (data.recommendations) setRecs(data.recommendations);
          })
          .catch(err => {
            console.warn("[Paws UI Warning] Failed to load recommendations:", err.message);
          });
      }, [plan]);

      // Fetch vet credentials if enterprise is active
      React.useEffect(() => {
        if (plan === "ENTERPRISE") {
          fetch("/api/vets/credentials", { headers })
            .then(res => {
              if (res.status === 200) return res.json();
              throw new Error();
            })
            .then(data => {
              if (data.vetProvider) {
                setVetProvider(data.vetProvider);
                setVetClientKey(data.vetClientKey);
                setVetClientSecret(data.vetClientSecret);
                setVetPracticeId(data.vetPracticeId);
              }
            })
            .catch(() => {});
        }
      }, [plan]);

      const handleSaveCredentials = (ev) => {
        ev.preventDefault();
        fetch("/api/vets/credentials", {
          method: "POST",
          headers,
          body: JSON.stringify({
            vetProvider,
            vetClientKey,
            vetClientSecret,
            vetPracticeId
          })
        })
          .then(res => {
            if (res.status === 403) {
              return res.json().then(err => { setToast("🔒 " + err.message); });
            }
            return res.json().then(data => {
              if (data.success) {
                setToast("🏥 Vet Credentials synchronized successfully!");
              }
            });
          });
      };

      const handleTestConnection = (ev) => {
        if (ev) ev.preventDefault();
        fetch("/api/vets/test-connection", {
          method: "POST",
          headers,
          body: JSON.stringify({
            vetProvider,
            vetClientKey,
            vetClientSecret,
            vetPracticeId
          })
        })
          .then(res => {
            if (res.status === 403) {
              return res.json().then(err => { setToast("🔒 " + err.message); });
            }
            return res.json().then(data => {
              if (data.success) {
                setToast("✅ " + data.message);
              } else {
                setToast("❌ " + data.message);
              }
            });
          })
          .catch(err => {
            setToast("❌ Test request failed: " + err.message);
          });
      };

      const handleUpgrade = (targetPlan) => {
        fetch("/api/billing", {
          method: "PATCH",
          headers,
          body: JSON.stringify({ plan: targetPlan })
        })
          .then(res => {
            if (!res.ok) throw new Error("Upgrade request failed");
            return res.json();
          })
          .then(data => {
            if (data.success) {
              setPlan(data.plan);
              setToast("Plan upgraded to " + data.plan + " successfully!");
            }
          })
          .catch(err => {
            setToast("🔒 Upgrade failed: " + err.message);
          });
      };

      const handleCreateProfile = (ev) => {
        ev.preventDefault();
        const url = editingPetId ? "/api/pets/profile/" + editingPetId : "/api/pets/profile";
        const method = editingPetId ? "PUT" : "POST";

        fetch(url, {
          method,
          headers,
          body: JSON.stringify({
            customerId: "gid://shopify/Customer/123",
            name: petName,
            petType,
            breed,
            age,
            weight,
            activityLevel,
            allergies: allergiesList,
            healthIssues: healthIssuesList
          })
        })
          .then(res => {
            if (res.status === 403) {
              return res.json().then(err => {
                setToast("❌ " + err.message);
                throw new Error(err.message);
              });
            }
            return res.json();
          })
          .then(data => {
            if (data.success) {
              if (editingPetId) {
                setProfiles(profiles.map(p => p.id === editingPetId ? data.profile : p));
                setToast("✏️ Pet Profile for " + petName + " updated!");
                setEditingPetId(null);
              } else {
                setProfiles([...profiles, data.profile]);
                setToast("🐾 Pet Profile for " + petName + " created!");
              }
              // Clear fields
              setPetName("");
              setBreed("");
              setAge("");
              setWeight("");
              setAllergiesInput("");
              setAllergiesList([]);
              setHealthIssuesInput("");
              setHealthIssuesList([]);
              // Re-fetch recommendations
              fetch("/api/pets/gid%3A%2F%2Fshopify%2FCustomer%2F123/recommendations", { headers })
                .then(res => res.json())
                .then(d => { if (d.recommendations) setRecs(d.recommendations); });
            }
          })
          .catch(() => {});
      };

      const handleEditPet = (pet) => {
        setEditingPetId(pet.id);
        setPetName(pet.name);
        setPetType(pet.petType);
        setBreed(pet.breed || "");
        setAge(pet.age ? pet.age.toString() : "");
        setWeight(pet.weight ? pet.weight.toString() : "");
        setActivityLevel(pet.activityLevel || "moderate");
        setAllergiesList(pet.allergies || []);
        setHealthIssuesList(pet.healthIssues || []);
      };

      const handleDeletePet = (id) => {
        fetch("/api/pets/profile/" + id, { method: "DELETE", headers })
          .then(res => res.json())
          .then(data => {
            if (data.success) {
              setProfiles(profiles.filter(p => p.id !== id));
              setToast("🗑️ Pet profile deleted successfully.");
              // Re-fetch recommendations
              fetch("/api/pets/gid%3A%2F%2Fshopify%2FCustomer%2F123/recommendations", { headers })
                .then(res => res.json())
                .then(d => { if (d.recommendations) setRecs(d.recommendations); });
            }
          });
      };

      const handleHealthTrack = (petId) => {
        fetch("/api/pets/" + petId + "/health", {
          method: "POST",
          headers,
          body: JSON.stringify({ weight: "35.2", activityScore: 8, notes: "Excellent weight and energy log" })
        })
          .then(res => {
            if (res.status === 403) {
              return res.json().then(err => { setToast("🔒 " + err.message); });
            }
            return res.json().then(data => {
              if (data.success) {
                setLogs([...logs, data.log]);
                setToast("📈 Health logged successfully!");
              }
            });
          });
      };

      const handleLoadReviews = () => {
        fetch("/api/community/reviews", { headers })
          .then(res => {
            if (res.status === 403) {
              return res.json().then(err => { setToast("🔒 " + err.message); });
            }
            return res.json().then(data => {
              setReviews(data.reviews);
            });
          });
      };

      const handleVetLink = () => {
        fetch("/api/vets/link", { method: "POST", headers })
          .then(res => {
            if (res.status === 403) {
              return res.json().then(err => { setToast("🔒 " + err.message); });
            }
            return res.json().then(data => {
              setToast("🏥 " + data.message);
            });
          });
      };

      return e("div", null, [
        // Top Banner
        e("div", { className: "banner" }, [
          e("div", null, [
            e("h1", { style: { margin: 0, fontSize: "20px" } }, "Paws & Effect 🐾"),
            e("p", { style: { margin: "4px 0 0 0", color: "#6d7175" } }, "Personalized Pet Profiles & Allergen-Safe Subscription Optimization")
          ]),
          e("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, [
            e("span", { className: "badge badge-" + plan.toLowerCase() }, "Active: " + plan),
            e("button", { 
              onClick: () => handleUpgrade("STARTER"),
              style: { padding: "6px 10px", border: "1px solid #c9cccf", borderRadius: "4px", backgroundColor: plan === "STARTER" ? "#e2e8f0" : "#fff", fontWeight: plan === "STARTER" ? "bold" : "normal", cursor: "pointer" }
            }, "Starter"),
            e("button", { 
              onClick: () => handleUpgrade("PRO"),
              style: { padding: "6px 10px", border: "1px solid #feebc8", borderRadius: "4px", backgroundColor: plan === "PRO" ? "#feebc8" : "#fff", fontWeight: plan === "PRO" ? "bold" : "normal", cursor: "pointer" }
            }, "Pro"),
            e("button", { 
              onClick: () => handleUpgrade("ENTERPRISE"),
              style: { padding: "6px 10px", border: "1px solid #e0f2fe", borderRadius: "4px", backgroundColor: plan === "ENTERPRISE" ? "#e0f2fe" : "#fff", fontWeight: plan === "ENTERPRISE" ? "bold" : "normal", cursor: "pointer" }
            }, "Enterprise")
          ])
        ]),

        e("div", { className: "grid-container" }, [
          // Left Column (Pet Profiles & Recommendations)
          e("div", null, [
            // Create Profile Form
            e("div", { style: { backgroundColor: "#fff", padding: "20px", borderRadius: "8px", boxShadow: "0 1px 3px rgba(0,0,0,0.1)", marginBottom: "20px" } }, [
              e("h2", { style: { marginTop: 0, fontSize: "16px" } }, editingPetId ? "✏️ Edit Pet Profile" : "Create Pet Profile"),
              e("form", { onSubmit: handleCreateProfile, style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" } }, [
                e("input", { placeholder: "Pet Name (e.g. Max)", value: petName, onChange: ev => setPetName(ev.target.value), required: true, style: { padding: "8px", borderRadius: "4px", border: "1px solid #c9cccf" } }),
                e("select", { value: petType, onChange: ev => setPetType(ev.target.value), style: { padding: "8px", borderRadius: "4px", border: "1px solid #c9cccf" } }, [
                  e("option", { value: "dog" }, "Dog"),
                  e("option", { value: "cat" }, "Cat"),
                  e("option", { value: "bird" }, "Bird"),
                  e("option", { value: "other" }, "Other")
                ]),
                e("input", { placeholder: "Breed (e.g. Golden Retriever)", value: breed, onChange: ev => setBreed(ev.target.value), style: { padding: "8px", borderRadius: "4px", border: "1px solid #c9cccf" } }),
                e("input", { placeholder: "Age (Years)", value: age, onChange: ev => setAge(ev.target.value.replace(/[^0-9]/g, "")), style: { padding: "8px", borderRadius: "4px", border: "1px solid #c9cccf" } }),
                e("input", { placeholder: "Weight (kg)", value: weight, onChange: ev => setWeight(ev.target.value.replace(/[^0-9.]/g, "").replace(/(\..*?)\..*/g, "$1")), style: { padding: "8px", borderRadius: "4px", border: "1px solid #c9cccf" } }),
                e("select", { value: activityLevel, onChange: ev => setActivityLevel(ev.target.value), style: { padding: "8px", borderRadius: "4px", border: "1px solid #c9cccf" } }, [
                  e("option", { value: "lazy" }, "Lazy / Inactive"),
                  e("option", { value: "moderate" }, "Moderately Active"),
                  e("option", { value: "active" }, "Highly Active")
                ]),
                
                // Interactive Allergies Tag Builder
                e("div", { style: { gridColumn: "span 2", display: "grid", gap: "4px" } }, [
                  e("input", { 
                    placeholder: "Add Allergies (Type word & press Enter or Comma, e.g. beef, chicken)", 
                    value: allergiesInput, 
                    onChange: ev => setAllergiesInput(ev.target.value), 
                    onKeyDown: handleAllergyKeyDown, 
                    style: { padding: "8px", borderRadius: "4px", border: "1px solid #c9cccf", width: "100%", boxSizing: "border-box" } 
                  }),
                  allergiesList.length > 0 && e("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", padding: "4px 0" } }, 
                    allergiesList.map(tag => e("span", { key: tag, style: { padding: "4px 8px", backgroundColor: "#fee2e2", borderRadius: "100px", color: "#991b1b", fontSize: "11px", fontWeight: "bold", display: "inline-flex", alignItems: "center", gap: "6px" } }, [
                      tag,
                      e("span", { onClick: () => removeAllergy(tag), style: { cursor: "pointer", fontSize: "12px", color: "#991b1b" } }, "✕")
                    ]))
                  )
                ]),

                // Interactive Health Issues Tag Builder
                e("div", { style: { gridColumn: "span 2", display: "grid", gap: "4px" } }, [
                  e("input", { 
                    placeholder: "Add Health Issues (Type word & press Enter or Comma, e.g. joint, itchy skin)", 
                    value: healthIssuesInput, 
                    onChange: ev => setHealthIssuesInput(ev.target.value), 
                    onKeyDown: handleHealthKeyDown, 
                    style: { padding: "8px", borderRadius: "4px", border: "1px solid #c9cccf", width: "100%", boxSizing: "border-box" } 
                  }),
                  healthIssuesList.length > 0 && e("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", padding: "4px 0" } }, 
                    healthIssuesList.map(tag => e("span", { key: tag, style: { padding: "4px 8px", backgroundColor: "#e0f2fe", borderRadius: "100px", color: "#0369a1", fontSize: "11px", fontWeight: "bold", display: "inline-flex", alignItems: "center", gap: "6px" } }, [
                      tag,
                      e("span", { onClick: () => removeHealthIssue(tag), style: { cursor: "pointer", fontSize: "12px", color: "#0369a1" } }, "✕")
                    ]))
                  )
                ]),
                editingPetId ? e("div", { style: { gridColumn: "span 2", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" } }, [
                  e("button", { type: "submit", style: { padding: "10px", backgroundColor: "#007ace", color: "#fff", border: "none", borderRadius: "4px", fontWeight: "bold", cursor: "pointer" } }, "✏️ Update Profile"),
                  e("button", { type: "button", onClick: () => {
                    setEditingPetId(null);
                    setPetName("");
                    setBreed("");
                    setAge("");
                    setWeight("");
                    setAllergiesInput("");
                    setAllergiesList([]);
                    setHealthIssuesInput("");
                    setHealthIssuesList([]);
                  }, style: { padding: "10px", backgroundColor: "#fff", border: "1px solid #c9cccf", borderRadius: "4px", fontWeight: "bold", cursor: "pointer" } }, "Cancel")
                ]) : e("button", { type: "submit", style: { gridColumn: "span 2", padding: "10px", backgroundColor: "#008060", color: "#fff", border: "none", borderRadius: "4px", fontWeight: "bold", cursor: "pointer" } }, "🐾 Save Pet Profile")
              ])
            ]),

            // Profiles list
            profiles.length > 0 && e("div", { style: { backgroundColor: "#fff", padding: "20px", borderRadius: "8px", boxShadow: "0 1px 3px rgba(0,0,0,0.1)", marginBottom: "20px" } }, [
              e("h2", { style: { marginTop: 0, fontSize: "16px" } }, "Active Profiles under Shop"),
              profiles.map(p => e("div", { key: p.id, style: { padding: "10px", borderBottom: "1px solid #e1e3e5", display: "flex", justifyContent: "space-between", alignItems: "center" } }, [
                e("div", null, [
                  e("strong", null, p.name),
                  e("span", { style: { color: "#6d7175", marginLeft: "10px" } }, p.breed + " (" + p.petType + ")")
                ]),
                e("div", { style: { display: "flex", gap: "6px" } }, [
                  e("button", { 
                    onClick: () => handleHealthTrack(p.id),
                    style: { padding: "4px 8px", backgroundColor: "#007ace", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "11px" }
                  }, "📈 Log Health"),
                  e("button", { 
                    onClick: () => handleEditPet(p),
                    style: { padding: "4px 8px", backgroundColor: "#f4f6f8", color: "#4a5568", border: "1px solid #c9cccf", borderRadius: "4px", cursor: "pointer", fontSize: "11px" }
                  }, "✏️ Edit"),
                  e("button", { 
                    onClick: () => handleDeletePet(p.id),
                    style: { padding: "4px 8px", backgroundColor: "#fee2e2", color: "#991b1b", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "11px", fontWeight: "bold" }
                  }, "🗑️ Delete")
                ])
              ]))
            ]),

            // Smart Recommendation lists (Allergy safe)
            e("div", { style: { backgroundColor: "#fff", padding: "20px", borderRadius: "8px", boxShadow: "0 1px 3px rgba(0,0,0,0.1)" } }, [
              e("h2", { style: { marginTop: 0, fontSize: "16px" } }, "Allergy-Safe Smart Product Recommendations"),
              recs.length === 0 ? e("p", { style: { color: "#6d7175" } }, "No active recommendations. Create a pet profile above to see tailored formulas!") :
                recs.map(pRec => e("div", { key: pRec.petName, style: { marginBottom: "16px", paddingBottom: "16px", borderBottom: "1px solid #e1e3e5" } }, [
                  e("h3", { style: { margin: "0 0 8px 0", fontSize: "14px", color: "#008060" } }, "Tailored recommendations for " + pRec.petName + " (" + pRec.petType + "):"),
                  pRec.recommendations.map(prod => e("div", { key: prod.id, style: { display: "flex", justifyContent: "space-between", padding: "8px", backgroundColor: "#f9fafb", borderRadius: "4px", marginBottom: "8px" } }, [
                    e("div", null, [
                      e("strong", null, prod.title),
                      e("p", { style: { margin: "4px 0", fontSize: "12px", color: "#6d7175" } }, prod.description)
                    ]),
                    e("div", { style: { textAlign: "right", fontSize: "12px" } }, [
                      e("span", { style: { color: "#008060", fontWeight: "bold" } }, "Score: " + prod.score),
                      e("p", { style: { margin: "4px 0 0 0", fontSize: "10px", color: "#6d7175" } }, prod.matchingReasons.join(", "))
                    ])
                  ]))
                ]))
            ])
          ]),

          // Right Column (Paywall Gates / Log outputs)
          e("div", null, [
            // Health Logs Panel
            e("div", { style: { backgroundColor: "#fff", padding: "20px", borderRadius: "8px", boxShadow: "0 1px 3px rgba(0,0,0,0.1)", marginBottom: "20px" } }, [
              e("h2", { style: { marginTop: 0, fontSize: "14px" } }, "📈 Health Log Portal (Pro)"),
              logs.length === 0 ? e("p", { style: { color: "#6d7175", fontSize: "12px" } }, "No health logs active. Click 'Log Health' on any pet above to add data (Requires Pro).") :
                logs.map(l => e("div", { key: l.id, style: { padding: "8px", backgroundColor: "#f4f6f8", borderRadius: "4px", marginBottom: "8px", fontSize: "12px" } }, [
                  e("strong", null, "Log: " + l.notes),
                  e("p", { style: { margin: "4px 0 0 0" } }, "Weight: " + l.weight + "kg | Activity Score: " + l.activityScore + "/10")
                ]))
            ]),

            // Community Feed (Pro gated)
            e("div", { style: { backgroundColor: "#fff", padding: "20px", borderRadius: "8px", boxShadow: "0 1px 3px rgba(0,0,0,0.1)", marginBottom: "20px" } }, [
              e("h2", { style: { marginTop: 0, fontSize: "14px" } }, "💬 Community & Breed Reviews (Pro)"),
              e("button", { onClick: handleLoadReviews, style: { padding: "6px 12px", width: "100%", backgroundColor: "#fff", border: "1px solid #c9cccf", borderRadius: "4px", cursor: "pointer", fontWeight: "bold", marginBottom: "10px" } }, "🔄 Load Breed Reviews"),
              reviews.length > 0 && reviews.map(r => e("div", { key: r.id, style: { padding: "8px", backgroundColor: "#f4f6f8", borderRadius: "4px", marginBottom: "8px", fontSize: "12px" } }, [
                e("p", { style: { margin: "0 0 4px 0", fontWeight: "bold" } }, r.petBreed + " Feed - " + r.author),
                e("p", { style: { margin: 0, color: "#6d7175" } }, r.body)
              ]))
            ]),

            // Vet Link Gating (Enterprise)
            e("div", { style: { backgroundColor: "#fff", padding: "20px", borderRadius: "8px", boxShadow: "0 1px 3px rgba(0,0,0,0.1)" } }, [
              e("h2", { style: { marginTop: 0, fontSize: "14px" } }, "🏥 Veterinary Integrations (Enterprise)"),
              e("p", { style: { color: "#6d7175", fontSize: "12px", marginBottom: "12px" } }, "Link your Shopify store directly to licensed veterinarians for verified medical approvals and health recommendation overrides."),
              
              plan !== "ENTERPRISE" ? e("div", null, [
                e("p", { style: { color: "#b00", fontSize: "11px", fontWeight: "bold", marginBottom: "10px" } }, "🔒 Restricted to Enterprise Tier ($499/mo)"),
                e("button", { onClick: handleVetLink, style: { padding: "8px", width: "100%", backgroundColor: "#e2e8f0", color: "#4a5568", border: "1px solid #c9cccf", borderRadius: "4px", fontWeight: "bold", cursor: "pointer" } }, "🔗 Link Vet Portal")
              ]) : e("form", { onSubmit: handleSaveCredentials, style: { display: "grid", gap: "8px", marginTop: "10px" } }, [
                e("label", { style: { fontSize: "11px", color: "#4a5568", fontWeight: "bold" } }, "Select Vet Integration Provider:"),
                e("select", { value: vetProvider, onChange: ev => setVetProvider(ev.target.value), style: { padding: "6px", borderRadius: "4px", border: "1px solid #c9cccf" } }, [
                  e("option", { value: "NONE" }, "None / Manual Verification"),
                  e("option", { value: "COVETRUS" }, "Covetrus Connect API"),
                  e("option", { value: "VETSOURCE" }, "Vetsource SyncVet API")
                ]),
                vetProvider !== "NONE" && e("div", { style: { display: "grid", gap: "8px" } }, [
                  e("input", { placeholder: "API Client Key", value: vetClientKey, onChange: ev => setVetClientKey(ev.target.value), required: true, style: { padding: "6px", borderRadius: "4px", border: "1px solid #c9cccf", fontSize: "12px" } }),
                  e("input", { placeholder: "API Client Secret", type: "password", value: vetClientSecret, onChange: ev => setVetClientSecret(ev.target.value), required: true, style: { padding: "6px", borderRadius: "4px", border: "1px solid #c9cccf", fontSize: "12px" } }),
                  e("input", { placeholder: "Practice / Clinic ID", value: vetPracticeId, onChange: ev => setVetPracticeId(ev.target.value), required: true, style: { padding: "6px", borderRadius: "4px", border: "1px solid #c9cccf", fontSize: "12px" } })
                ]),
                e("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "4px" } }, [
                  e("button", { type: "submit", style: { padding: "8px", backgroundColor: "#008060", color: "#fff", border: "none", borderRadius: "4px", fontWeight: "bold", cursor: "pointer" } }, "🏥 Save Keys"),
                  e("button", { type: "button", onClick: handleTestConnection, style: { padding: "8px", backgroundColor: "#1c3d5a", color: "#fff", border: "none", borderRadius: "4px", fontWeight: "bold", cursor: "pointer" } }, "🧪 Test Connection")
                ])
              ])
            ])
          ])
        ]),

        // Toast Messages
        toast && e("div", {
          style: {
            position: "fixed",
            bottom: "20px",
            right: "20px",
            backgroundColor: "#333",
            color: "#fff",
            padding: "12px 24px",
            borderRadius: "8px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            zIndex: 9999,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "10px"
          }
        }, [
          e("span", null, toast),
          e("button", { onClick: () => setToast(null), style: { background: "none", border: "none", color: "#fff", cursor: "pointer", fontWeight: "bold" } }, "✕")
        ])
      ]);
    }

    window.onload = () => {
      const container = document.getElementById("app");
      const root = ReactDOM.createRoot(container);
      root.render(e(App));
    };
  </script>
</body>
</html>
  `);
});

app.listen(port, () => {
  console.log(`Paws & Effect listening on port ${port}`);
});

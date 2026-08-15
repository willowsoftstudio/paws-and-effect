import express from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());

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
    // Plan Limit Gates: Check Customer limits
    const existingProfiles = await prisma.petProfile.findMany({
      where: { shop: session.shop }
    });
    const uniqueCustomerIds = new Set(existingProfiles.map(p => p.customerId));

    // Starter cap: 5K, Pro cap: 50K
    const maxCustomers = session.plan === "STARTER" ? 5000 : (session.plan === "PRO" ? 50000 : Infinity);

    if (uniqueCustomerIds.size >= maxCustomers && !uniqueCustomerIds.has(customerId)) {
      return res.status(403).json({
        error: "LIMIT_REACHED",
        message: `Plan customer profile limit reached (${maxCustomers} customers). Please upgrade to unlock further profiles.`,
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

// 4. Product Recommendations with Allergy-Safe Filtering
app.get("/api/pets/:customerId/recommendations", validateSession, async (req, res) => {
  const { customerId } = req.params;
  const session = req.body.session;

  try {
    const profiles = await prisma.petProfile.findMany({
      where: { customerId, shop: session.shop }
    });

    if (profiles.length === 0) {
      return res.json({ recommendations: [], message: "No pet profiles found for customer." });
    }

    // Combine all matching recommendations per pet, filtering out pet allergens
    const allRecommendations = [];

    for (const pet of profiles) {
      const petAllergies = pet.allergies.map(a => a.toLowerCase());
      const petHealthIssues = pet.healthIssues.map(h => h.toLowerCase());
      const petBreed = pet.breed ? pet.breed.toLowerCase() : "";
      const petAge = pet.age || 0;

      // Filter products
      const recommendedForPet = MOCK_PRODUCTS.map(product => {
        const prodAllergens = product.allergens.map(a => a.toLowerCase());
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

    res.json({ recommendations: allRecommendations });
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

app.listen(port, () => {
  console.log(`Paws & Effect listening on port ${port}`);
});

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

// 8. Serve beautiful, iframe-safe Shopify Polaris embedded App Dashboard
app.get("/", (req, res) => {
  const shop = req.query.shop as string;
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
      const [allergies, setAllergies] = React.useState("");
      const [healthIssues, setHealthIssues] = React.useState("");
      
      const [profiles, setProfiles] = React.useState([]);
      const [logs, setLogs] = React.useState([]);
      const [reviews, setReviews] = React.useState([]);
      const [recs, setRecs] = React.useState([]);
      const [toast, setToast] = React.useState(null);

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
          .then(res => res.json())
          .then(data => {
            if (data.recommendations) setRecs(data.recommendations);
          });
      }, [plan]);

      const handleUpgrade = (targetPlan) => {
        fetch("/api/billing", {
          method: "PATCH",
          headers,
          body: JSON.stringify({ plan: targetPlan })
        })
          .then(res => res.json())
          .then(data => {
            if (data.success) {
              setPlan(data.plan);
              setToast("Plan upgraded to " + data.plan + " successfully!");
            }
          });
      };

      const handleCreateProfile = (ev) => {
        ev.preventDefault();
        fetch("/api/pets/profile", {
          method: "POST",
          headers,
          body: JSON.stringify({
            customerId: "gid://shopify/Customer/123",
            name: petName,
            petType,
            breed,
            age,
            weight,
            activityLevel,
            allergies: allergies ? allergies.split(",").map(s => s.trim()) : [],
            healthIssues: healthIssues ? healthIssues.split(",").map(s => s.trim()) : []
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
              setProfiles([...profiles, data.profile]);
              setToast("🐾 Pet Profile for " + petName + " created!");
              // Clear fields
              setPetName("");
              setBreed("");
              setAge("");
              setWeight("");
              setAllergies("");
              setHealthIssues("");
              // Re-fetch recommendations
              fetch("/api/pets/gid%3A%2F%2Fshopify%2FCustomer%2F123/recommendations", { headers })
                .then(res => res.json())
                .then(d => { if (d.recommendations) setRecs(d.recommendations); });
            }
          })
          .catch(() => {});
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
          e("div", { style: { display: "flex", gap: "10px", alignItems: "center" } }, [
            e("span", { className: "badge badge-" + plan.toLowerCase() }, plan),
            e("button", { 
              onClick: () => handleUpgrade(plan === "STARTER" ? "PRO" : "ENTERPRISE"),
              style: { padding: "8px 12px", border: "1px solid #1c3d5a", borderRadius: "4px", backgroundColor: "#fff", cursor: "pointer" }
            }, plan === "STARTER" ? "Upgrade to Pro" : (plan === "PRO" ? "Upgrade to Enterprise" : "Enterprise Active"))
          ])
        ]),

        e("div", { className: "grid-container" }, [
          // Left Column (Pet Profiles & Recommendations)
          e("div", null, [
            // Create Profile Form
            e("div", { style: { backgroundColor: "#fff", padding: "20px", borderRadius: "8px", boxShadow: "0 1px 3px rgba(0,0,0,0.1)", marginBottom: "20px" } }, [
              e("h2", { style: { marginTop: 0, fontSize: "16px" } }, "Create Pet Profile"),
              e("form", { onSubmit: handleCreateProfile, style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" } }, [
                e("input", { placeholder: "Pet Name (e.g. Max)", value: petName, onChange: e => setPetName(e.target.value), required: true, style: { padding: "8px", borderRadius: "4px", border: "1px solid #c9cccf" } }),
                e("select", { value: petType, onChange: e => setPetType(e.target.value), style: { padding: "8px", borderRadius: "4px", border: "1px solid #c9cccf" } }, [
                  e("option", { value: "dog" }, "Dog"),
                  e("option", { value: "cat" }, "Cat"),
                  e("option", { value: "bird" }, "Bird"),
                  e("option", { value: "other" }, "Other")
                ]),
                e("input", { placeholder: "Breed (e.g. Golden Retriever)", value: breed, onChange: e => setBreed(e.target.value), style: { padding: "8px", borderRadius: "4px", border: "1px solid #c9cccf" } }),
                e("input", { placeholder: "Age (Years)", type: "number", value: age, onChange: e => setAge(e.target.value), style: { padding: "8px", borderRadius: "4px", border: "1px solid #c9cccf" } }),
                e("input", { placeholder: "Weight (kg)", type: "number", value: weight, onChange: e => setWeight(e.target.value), style: { padding: "8px", borderRadius: "4px", border: "1px solid #c9cccf" } }),
                e("select", { value: activityLevel, onChange: e => setActivityLevel(e.target.value), style: { padding: "8px", borderRadius: "4px", border: "1px solid #c9cccf" } }, [
                  e("option", { value: "lazy" }, "Lazy / Inactive"),
                  e("option", { value: "moderate" }, "Moderately Active"),
                  e("option", { value: "active" }, "Highly Active")
                ]),
                e("input", { placeholder: "Allergies (comma separated, e.g. beef, chicken)", value: allergies, onChange: e => setAllergies(e.target.value), style: { padding: "8px", borderRadius: "4px", border: "1px solid #c9cccf", gridColumn: "span 2" } }),
                e("input", { placeholder: "Health Issues (comma separated, e.g. joint, sensitive stomach)", value: healthIssues, onChange: e => setHealthIssues(e.target.value), style: { padding: "8px", borderRadius: "4px", border: "1px solid #c9cccf", gridColumn: "span 2" } }),
                e("button", { type: "submit", style: { gridColumn: "span 2", padding: "10px", backgroundColor: "#008060", color: "#fff", border: "none", borderRadius: "4px", fontWeight: "bold", cursor: "pointer" } }, "🐾 Save Pet Profile")
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
                e("button", { 
                  onClick: () => handleHealthTrack(p.id),
                  style: { padding: "4px 8px", backgroundColor: "#007ace", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "12px" }
                }, "📈 Log Health")
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
              e("button", { onClick: handleVetLink, style: { padding: "8px", width: "100%", backgroundColor: "#1c3d5a", color: "#fff", border: "none", borderRadius: "4px", fontWeight: "bold", cursor: "pointer" } }, "🔗 Link Vet Portal")
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
            justify-content: "space-between",
            align-items: "center",
            gap: "10px"
          }
        }, [
          e("span", null, toast),
          e("button", { onClick: () => setToast(null), style: { background: "none", border: "none", color: "#fff", cursor: "pointer", fontWeight: "bold" } }, "✕")
        ])
      ]);
    }

    const container = document.getElementById("app");
    const root = ReactDOM.createRoot(container);
    root.render(e(App));
  </script>
</body>
</html>
  `);
});

app.listen(port, () => {
  console.log(`Paws & Effect listening on port ${port}`);
});

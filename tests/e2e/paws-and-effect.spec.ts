import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const testSessionId = "paws-e2e-session-id";
const shopDomain = "paws-e2e-shop.myshopify.com";

test.describe("Paws & Effect E2E Tests — Billing, Feature Gating, and Recommendations", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    // Clear out any old session and create a fresh one on the STARTER plan
    await prisma.session.deleteMany({ where: { id: testSessionId } });
    await prisma.session.create({
      data: {
        id: testSessionId,
        shop: shopDomain,
        state: "paws_e2e_active",
        accessToken: "e2e_mock_access_token",
        plan: "STARTER"
      }
    });

    // Clear out previous pet profiles under this shop
    await prisma.petProfile.deleteMany({ where: { shop: shopDomain } });
  });

  test.afterAll(async () => {
    // Clean up E2E records
    await prisma.petProfile.deleteMany({ where: { shop: shopDomain } });
    await prisma.session.deleteMany({ where: { id: testSessionId } });
  });

  test("1. Starter Plan should allow profile creations and recommendations, but gate premium features", async ({ request }) => {
    const headers = {
      "x-test-session-id": testSessionId,
      "x-shop-domain": shopDomain
    };

    // A. Create pet profile for Max (Retrievers are beef/chicken sensitive)
    const profileRes = await request.post("/api/pets/profile", {
      headers,
      data: {
        customerId: "gid://shopify/Customer/max_owner_123",
        name: "Max",
        petType: "dog",
        breed: "Golden Retriever",
        age: "8", // Senior dog
        weight: "35",
        activityLevel: "active",
        allergies: ["beef"], // Allergic to beef!
        healthIssues: ["joint"] // Has joint issues!
      }
    });

    expect(profileRes.status()).toBe(200);
    const profileBody = await profileRes.json();
    expect(profileBody.success).toBe(true);
    const petId = profileBody.profile.id;

    // B. Verify Smart recommendations filter out beef-based Joint Support chews for Max
    const encodedCustomerId = encodeURIComponent("gid://shopify/Customer/max_owner_123");
    const recsRes = await request.get(`/api/pets/${encodedCustomerId}/recommendations`, { headers });
    expect(recsRes.status()).toBe(200);
    const recsBody = await recsRes.json();
    const maxRecs = recsBody.recommendations.find((r: any) => r.petName === "Max");

    expect(maxRecs).toBeDefined();
    // Joint chews (beef-allergen) must be completely filtered out for Max!
    expect(maxRecs.recommendations.some((r: any) => r.id === "prod-joint-chews")).toBe(false);
    // Active Breed Chicken Kibble is safe and should match Retriever + Active tags!
    expect(maxRecs.recommendations.some((r: any) => r.id === "prod-chicken-formula")).toBe(true);

    // C. Verify Health Logging is gated (requires Pro)
    const healthRes = await request.post(`/api/pets/${petId}/health`, {
      headers,
      data: { weight: "36.2", activityScore: 8, notes: "Feeling playful today!" }
    });
    expect(healthRes.status()).toBe(403);
    const healthBody = await healthRes.json();
    expect(healthBody.error).toBe("UPGRADE_REQUIRED");
    expect(healthBody.requiredPlan).toBe("PRO");

    // D. Verify Community reviews is gated (requires Pro)
    const reviewsRes = await request.get("/api/community/reviews", { headers });
    expect(reviewsRes.status()).toBe(403);
    const reviewsBody = await reviewsRes.json();
    expect(reviewsBody.error).toBe("UPGRADE_REQUIRED");

    // E. Verify Vet linking is gated (requires Enterprise)
    const vetRes = await request.post("/api/vets/link", { headers });
    expect(vetRes.status()).toBe(403);
    const vetBody = await vetRes.json();
    expect(vetBody.error).toBe("UPGRADE_REQUIRED");
    expect(vetBody.requiredPlan).toBe("ENTERPRISE");
  });

  test("2. Upgrading to Pro Plan should unlock health logging and community reviews", async ({ request }) => {
    const headers = {
      "x-test-session-id": testSessionId,
      "x-shop-domain": shopDomain
    };

    // A. Call billing endpoint to upgrade to PRO
    const billingRes = await request.patch("/api/billing", {
      headers,
      data: { plan: "PRO" }
    });
    expect(billingRes.status()).toBe(200);
    expect((await billingRes.json()).plan).toBe("PRO");

    // Retrieve pet Max's ID
    const profiles = await prisma.petProfile.findMany({ where: { shop: shopDomain, name: "Max" } });
    expect(profiles.length).toBe(1);
    const petId = profiles[0].id;

    // B. Verify Health Logging is now UNLOCKED and succeeds!
    const healthRes = await request.post(`/api/pets/${petId}/health`, {
      headers,
      data: { weight: "35.8", activityScore: 7, notes: "Doing great on chicken kibble!" }
    });
    expect(healthRes.status()).toBe(200);
    expect((await healthRes.json()).success).toBe(true);

    // C. Verify Community Reviews is now UNLOCKED and succeeds!
    const reviewsRes = await request.get("/api/community/reviews", { headers });
    expect(reviewsRes.status()).toBe(200);
    const reviewsBody = await reviewsRes.json();
    expect(reviewsBody.reviews.length).toBeGreaterThan(0);

    // D. Verify Vet Linking remains gated (requires Enterprise)
    const vetRes = await request.post("/api/vets/link", { headers });
    expect(vetRes.status()).toBe(403);
  });

  test("3. Upgrading to Enterprise Plan should unlock vet linking portals", async ({ request }) => {
    const headers = {
      "x-test-session-id": testSessionId,
      "x-shop-domain": shopDomain
    };

    // A. Call billing endpoint to upgrade to ENTERPRISE
    const billingRes = await request.patch("/api/billing", {
      headers,
      data: { plan: "ENTERPRISE" }
    });
    expect(billingRes.status()).toBe(200);
    expect((await billingRes.json()).plan).toBe("ENTERPRISE");

    // B. Verify Vet Linking is now UNLOCKED and succeeds!
    const vetRes = await request.post("/api/vets/link", { headers });
    expect(vetRes.status()).toBe(200);
    expect((await vetRes.json()).success).toBe(true);
  });
});

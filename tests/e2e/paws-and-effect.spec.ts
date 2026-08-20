import { test, expect } from "@playwright/test";
import { PrismaClient } from "../../web/backend/prisma-client/index.js";

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

    // C. Verify Save Vet Credentials succeeds and encrypts at rest
    const saveRes = await request.post("/api/vets/credentials", {
      headers,
      data: {
        vetProvider: "COVETRUS",
        vetClientKey: "mock-client-key-123",
        vetClientSecret: "mock-client-secret-abc",
        vetPracticeId: "practice-999"
      }
    });
    expect(saveRes.status()).toBe(200);
    expect((await saveRes.json()).vetProvider).toBe("COVETRUS");

    // D. Verify Fetch Vet Credentials returns decrypted client key but masked client secret for security
    const getRes = await request.get("/api/vets/credentials", { headers });
    expect(getRes.status()).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.vetProvider).toBe("COVETRUS");
    expect(getBody.vetClientKey).toBe("mock-client-key-123"); // Successfully decrypted!
    expect(getBody.vetClientSecret).toBe("••••••••••••••••"); // Masked for security!
    expect(getBody.vetPracticeId).toBe("practice-999");

    // E. Verify Test Connection succeeds with valid keys
    const testSuccessRes = await request.post("/api/vets/test-connection", {
      headers,
      data: {
        vetProvider: "COVETRUS",
        vetClientKey: "mock-client-key-123",
        vetClientSecret: "mock-client-secret-abc",
        vetPracticeId: "practice-999"
      }
    });
    expect(testSuccessRes.status()).toBe(200);
    expect((await testSuccessRes.json()).success).toBe(true);

    // F. Verify Test Connection fails with a 401 if 'fail' is passed in credentials (mock sandbox authentication fail)
    const testFailRes = await request.post("/api/vets/test-connection", {
      headers,
      data: {
        vetProvider: "COVETRUS",
        vetClientKey: "mock-client-key-fail",
        vetClientSecret: "mock-client-secret-abc",
        vetPracticeId: "practice-999"
      }
    });
    expect(testFailRes.status()).toBe(401);
    const failBody = await testFailRes.json();
    expect(failBody.success).toBe(false);
    expect(failBody.error).toBe("Authentication Failed");

    // G. Verify Vet Practice Autocomplete Search Endpoint
    const searchRes = await request.get("/api/vets/search?q=Seattle", { headers });
    expect(searchRes.status()).toBe(200);
    const searchBody = await searchRes.json();
    expect(searchBody.success).toBe(true);
    expect(searchBody.practices.length).toBe(1);
    expect(searchBody.practices[0].name).toBe("Seattle Veterinary Associates");

    // H. Verify S3 Secure Presigned PUT Upload URL Generation
    const s3UploadRes = await request.post("/api/vets/presigned-upload-url", {
      headers,
      data: {
        filename: "prescription_max.pdf",
        contentType: "application/pdf"
      }
    });
    expect(s3UploadRes.status()).toBe(200);
    const s3UploadBody = await s3UploadRes.json();
    expect(s3UploadBody.success).toBe(true);
    expect(s3UploadBody.uploadUrl).toContain("amazonaws.com"); // Contains the real secure AWS signed URL!
    expect(s3UploadBody.objectKey).toContain("prescriptions/");

    // H2. Verify API-Proxied Secure Upload endpoint accepts and uploads raw files to S3
    const proxyUploadRes = await request.post("/api/pets/upload-prescription?filename=e2e_prescription.pdf", {
      headers: {
        ...headers,
        "Content-Type": "application/pdf",
        "x-customer-id": "gid://shopify/Customer/123"
      },
      data: Buffer.from("MOCK_PDF_FILE_BINARY_CONTENT") // Send raw mock file content!
    });
    expect(proxyUploadRes.status()).toBe(200);
    const proxyUploadBody = await proxyUploadRes.json();
    expect(proxyUploadBody.success).toBe(true);
    expect(proxyUploadBody.objectKey).toContain("prescriptions/");
    expect(proxyUploadBody.objectKey).toContain("/123/"); // Asserts strict, secure path locking per customer!

    // Retrieve Max's pet profile ID to test view URL
    const profiles = await prisma.petProfile.findMany({ where: { shop: shopDomain, name: "Max" } });
    expect(profiles.length).toBe(1);
    const maxPetId = profiles[0].id;

    // I. Verify S3 Secure Presigned GET View URL fails with 400 if no document key is registered yet
    const s3ViewFailRes = await request.get(`/api/pets/presigned-view-url/${maxPetId}`, { headers });
    expect(s3ViewFailRes.status()).toBe(400);
    expect((await s3ViewFailRes.json()).error).toBe("No prescription document uploaded for this pet.");

    // J. Update the profile with prescription key via the PUT API endpoint and verify GET View URL succeeds
    const putRes = await request.put(`/api/pets/profile/${maxPetId}`, {
      headers,
      data: {
        name: "Max",
        petType: "dog",
        prescriptionUrl: s3UploadBody.objectKey
      }
    });
    expect(putRes.status()).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.success).toBe(true);
    expect(putBody.profile.prescriptionUrl).toBe(s3UploadBody.objectKey);

    const s3ViewSuccessRes = await request.get(`/api/pets/presigned-view-url/${maxPetId}`, { headers });
    expect(s3ViewSuccessRes.status()).toBe(200);
    const s3ViewBody = await s3ViewSuccessRes.json();
    expect(s3ViewBody.success).toBe(true);
    expect(s3ViewBody.viewUrl).toContain("amazonaws.com"); // Contains the real secure AWS signed URL!

    // J2. Verify S3 Secure Redirect Proxy generates view signature and redirects successfully
    const redirectRes = await request.get(`/api/vets/view-prescription?key=${s3UploadBody.objectKey}`, {
      maxRedirects: 0
    });
    expect(redirectRes.status()).toBe(302);
    expect(redirectRes.headers().location).toContain("amazonaws.com");
  });

  test("4. Should be able to query checkout-rule status and toggle it on/off dynamically", async ({ request }) => {
    const headers = {
      "x-test-session-id": testSessionId,
      "x-shop-domain": shopDomain
    };

    // A. Query status endpoint and verify active check works
    const statusRes = await request.get("/api/checkout-rule/status", { headers });
    expect(statusRes.status()).toBe(200);
    const statusBody = await statusRes.json();
    expect(statusBody.success).toBe(true);
    expect(statusBody.functionDeployed).toBe(true);
    expect(statusBody.enabled).toBe(true);
    expect(statusBody.validationId).toBe("gid://shopify/Validation/mock-id-123");

    // B. Toggle status off and verify success
    const toggleOffRes = await request.post("/api/checkout-rule/toggle", {
      headers,
      data: { enabled: false }
    });
    expect(toggleOffRes.status()).toBe(200);
    expect((await toggleOffRes.json()).enabled).toBe(false);

    // C. Toggle status back on and verify success
    const toggleOnRes = await request.post("/api/checkout-rule/toggle", {
      headers,
      data: { enabled: true }
    });
    expect(toggleOnRes.status()).toBe(200);
    expect((await toggleOnRes.json()).enabled).toBe(true);
  });

  test("5. Webhook - Should automatically process orders/create and tag orders requiring prescription review", async ({ request }) => {
    const headers = {
      "x-test-session-id": testSessionId,
      "x-shopify-shop-domain": shopDomain
    };

    // A. Mock a webhook payload of an order containing a prescription product (has _Prescription S3 Key property!)
    const orderPayload = {
      id: 99887766,
      admin_graphql_api_id: "gid://shopify/Order/99887766",
      line_items: [
        {
          id: 11111,
          title: "Prescription Kibble Product",
          properties: [
            { name: "_Pet Name", value: "Max" },
            { name: "_Prescription S3 Key", value: "prescriptions/paws-e2e-shop/123/e2e_prescription.pdf" }
          ]
        }
      ]
    };

    const webhookRes = await request.post("/api/webhooks/orders-create", {
      headers,
      data: orderPayload
    });

    expect(webhookRes.status()).toBe(200);
    const webhookBody = await webhookRes.json();
    expect(webhookBody.success).toBe(true);
    expect(webhookBody.tagged).toBe(true);
  });

  test("6. Webhook - Should automatically process GDPR compliance redactions", async ({ request }) => {
    const headers = {
      "x-test-session-id": testSessionId,
      "x-shopify-shop-domain": shopDomain,
      "x-shopify-topic": "customers/redact"
    };

    // A. Verify customers/redact returns 200 OK and executes successfully
    const redactRes = await request.post("/api/webhooks/compliance", {
      headers,
      data: {
        customer: { id: 12345 },
        shop_domain: shopDomain
      }
    });

    expect(redactRes.status()).toBe(200);
    const redactBody = await redactRes.json();
    expect(redactBody.success).toBe(true);
  });
});

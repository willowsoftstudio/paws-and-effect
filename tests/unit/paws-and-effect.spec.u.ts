import { describe, it, expect } from "vitest";

// Port of matching rules for isolated unit testing
const MOCK_PRODUCTS = [
  {
    id: "prod-joint-chews",
    title: "Joint Care Support Chews",
    tags: ["senior", "large-breed", "joint-support"],
    allergens: ["beef"]
  },
  {
    id: "prod-hypo-fish",
    title: "Hypoallergenic Salmon Kibble",
    tags: ["toy-breed", "sensitive-stomach", "itchy-skin", "hypoallergenic"],
    allergens: []
  },
  {
    id: "prod-chicken-formula",
    title: "Active Breed Chicken Kibble",
    tags: ["active", "retriever", "high-protein"],
    allergens: ["chicken"]
  }
];

function getRecommendations(pet: any) {
  const petAllergies = pet.allergies.map((a: string) => a.toLowerCase());
  const petHealthIssues = pet.healthIssues.map((h: string) => h.toLowerCase());
  const petBreed = pet.breed ? pet.breed.toLowerCase() : "";
  const petAge = pet.age || 0;

  const results = MOCK_PRODUCTS.map(product => {
    const prodAllergens = product.allergens.map(a => a.toLowerCase());
    const isAllergic = prodAllergens.some(allergen => petAllergies.includes(allergen));

    if (isAllergic) {
      return { ...product, isAllergic: true, score: 0 };
    }

    let score = 0;

    if (product.tags.includes("large-breed") && (petBreed.includes("retriever") || petBreed.includes("labrador") || petBreed.includes("shepherd"))) {
      score += 10;
    }
    if (product.tags.includes("joint-support") && (petAge >= 7 || petHealthIssues.includes("joint"))) {
      score += 15;
    }
    if (product.tags.includes("hypoallergenic") && (petHealthIssues.includes("itchy skin") || petHealthIssues.includes("sensitive stomach"))) {
      score += 12;
    }
    if (product.tags.includes("high-protein") && pet.activityLevel === "active") {
      score += 8;
    }

    return { ...product, isAllergic: false, score };
  });

  return results.filter(p => !p.isAllergic && p.score > 0).sort((a, b) => b.score - a.score);
}

describe("Paws & Effect Unit Tests — Smart Recommendations & Allergy-Safe Gating", () => {
  it("should match active retrievers with high-protein and large-breed joint scores", () => {
    const activeRetriever = {
      name: "Max",
      breed: "Golden Retriever",
      age: 5,
      allergies: [],
      healthIssues: [],
      activityLevel: "active"
    };

    const recs = getRecommendations(activeRetriever);
    expect(recs.some(r => r.id === "prod-chicken-formula")).toBe(true);
    expect(recs.some(r => r.id === "prod-joint-chews")).toBe(true);
  });

  it("should block joint chews for retrievers with a beef allergy (allergy-safe filtering)", () => {
    const allergicRetriever = {
      name: "Bella",
      breed: "Labrador Retriever",
      age: 8,
      allergies: ["beef"], // Beef is in Joint Chews!
      healthIssues: ["joint"],
      activityLevel: "moderate"
    };

    const recs = getRecommendations(allergicRetriever);
    // Joint chews should be completely blocked due to the beef allergy!
    expect(recs.some(r => r.id === "prod-joint-chews")).toBe(false);
  });

  it("should highly score senior pets with joint issues on joint care support chews", () => {
    const seniorDog = {
      name: "Rocky",
      breed: "German Shepherd",
      age: 9,
      allergies: [],
      healthIssues: ["joint"],
      activityLevel: "lazy"
    };

    const recs = getRecommendations(seniorDog);
    const jointChew = recs.find(r => r.id === "prod-joint-chews");
    expect(jointChew).toBeDefined();
    // Senior (15) + large-breed (10) = 25 points!
    expect(jointChew!.score).toBe(25);
  });

  it("should recommend hypoallergenic fish kibble for toy breeds with itchy skin or sensitive stomachs", () => {
    const itchyFrenchie = {
      name: "Coco",
      breed: "French Bulldog",
      age: 3,
      allergies: [],
      healthIssues: ["itchy skin"],
      activityLevel: "moderate"
    };

    const recs = getRecommendations(itchyFrenchie);
    const fishKibble = recs.find(r => r.id === "prod-hypo-fish");
    expect(fishKibble).toBeDefined();
    expect(fishKibble!.score).toBe(12);
  });
});

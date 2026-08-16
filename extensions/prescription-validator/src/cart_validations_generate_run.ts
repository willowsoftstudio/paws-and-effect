import type {
  CartValidationsGenerateRunInput,
  CartValidationsGenerateRunResult,
  ValidationError,
} from "../generated/api.js";

export function cartValidationsGenerateRun(input: CartValidationsGenerateRunInput): CartValidationsGenerateRunResult {
  const errors: ValidationError[] = [];

  for (const line of input.cart.lines) {
    if (line.merchandise.__typename === "ProductVariant") {
      const isPrescriptionRequired = line.merchandise.product.hasAnyTag;
      const s3Key = line.attribute?.value;

      if (isPrescriptionRequired && (!s3Key || s3Key.trim() === "")) {
        errors.push({
          message: `⚕️ Verification Required: Please register your pet and upload their prescription before purchasing "${line.merchandise.product.title}".`,
          target: "$.cart",
        });
      }
    }
  }

  const operations = [
    {
      validationAdd: {
        errors
      },
    },
  ];

  return { operations };
};

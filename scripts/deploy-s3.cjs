const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const appDir = path.join(__dirname, "..");

// 1. Resolve environment variables from local .env
const env = { ...process.env };
const p = path.join(appDir, ".env");

if (fs.existsSync(p)) {
  const envContent = fs.readFileSync(p, "utf8");
  const lines = envContent.split(String.fromCharCode(10));
  lines.forEach(l => {
    const t = l.trim();
    if (t && !t.startsWith("#") && !t.startsWith("//") && t.includes("=")) {
      const parts = t.split("=");
      const key = parts[0].trim();
      let val = parts.slice(1).join("=").trim();
      if (val.startsWith('"') || val.startsWith("'")) val = val.substring(1, val.length - 1);
      env[key] = val;
    }
  });
}

// Map regional variable aliases if present
if (env.AWS_REGION && !env.AWS_DEFAULT_REGION) {
  env.AWS_DEFAULT_REGION = env.AWS_REGION;
}

// Clear any stale session or security tokens from the parent shell to prevent credential contamination
delete env.AWS_SESSION_TOKEN;
delete env.AWS_SECURITY_TOKEN;

// Log key verification safely (last 4 chars) so the developer can confirm .env keys are active
if (env.AWS_ACCESS_KEY_ID) {
  const maskedKey = "••••••••••••••••" + env.AWS_ACCESS_KEY_ID.slice(-4);
  console.log(`[AWS Deploy] Loaded AWS_ACCESS_KEY_ID from .env: ${maskedKey}`);
}

// 2. Extract targets from CLI arguments
const isProd = process.argv.includes("--prod") || process.argv.includes("--production");
const stackName = isProd ? "paws-effect-storage-production" : "paws-effect-storage-preview";

// Smart Bucket Selector: Parse process.argv for --bucket parameter
let bucketName = isProd ? "paws-effect-prescriptions-production-vault" : "paws-effect-prescriptions-preview-vault";
const bucketArgIdx = process.argv.indexOf("--bucket");
if (bucketArgIdx !== -1 && process.argv[bucketArgIdx + 1]) {
  bucketName = process.argv[bucketArgIdx + 1].trim();
}

// Check if AWS keys are present in .env
if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
  console.error("❌ Error: Missing AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY inside your local .env file.");
  process.exit(1);
}

const templatePath = path.join(appDir, "aws", "s3-prescription-bucket.yaml");

const runCommand = `aws cloudformation deploy \
  --template-file "${templatePath}" \
  --stack-name "${stackName}" \
  --parameter-overrides \
    BucketName="${bucketName}"`;

try {
  console.log(`[AWS Deploy] Spawning AWS CloudFormation deployment for ${isProd ? "Production" : "Preview"} using .env credentials...`);
  console.log(`[AWS Deploy] Target S3 Bucket Name: ${bucketName}`);
  execSync(runCommand, { stdio: "inherit", env });
  console.log("✅ [AWS Deploy] CloudFormation S3 stack deployed successfully!");
} catch (err) {
  console.error("❌ [AWS Deploy Error] S3 Bucket deployment failed:", err.message);
  process.exit(1);
}

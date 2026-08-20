const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const appDir = path.join(__dirname, "..");

// Sync backendApiUrl inside liquid blocks with application_url from shopify.app.toml / shopify.app.dev.toml
function syncLiquidApiUrls() {
  console.log("[Build Script] Synchronizing theme app extension API URLs with TOML configurations...");
  
  // Determine if we are building for production or dev
  const isProd = process.env.NODE_ENV === "production" || process.env.ENV === "prod";
  const tomlFile = isProd ? "shopify.app.toml" : (fs.existsSync(path.join(appDir, "shopify.app.dev.toml")) ? "shopify.app.dev.toml" : "shopify.app.toml");
  const tomlPath = path.join(appDir, tomlFile);
  
  if (!fs.existsSync(tomlPath)) {
    console.warn(`[Build Script Warning] Config file ${tomlFile} not found. Skipping API URL synchronization.`);
    return;
  }
  
  const tomlContent = fs.readFileSync(tomlPath, "utf8");
  const urlMatch = tomlContent.match(/application_url\s*=\s*["']([^"']*)["']/);
  if (!urlMatch) {
    console.warn(`[Build Script Warning] Could not resolve application_url from ${tomlFile}.`);
    return;
  }
  
  const appUrl = urlMatch[1].trim();
  console.log(`[Build Script] Resolved application_url from ${tomlFile}: ${appUrl}`);
  
  const extDir = path.join(appDir, "extensions");
  if (!fs.existsSync(extDir)) return;
  
  const findLiquidFiles = (dir) => {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat && stat.isDirectory()) {
        results = results.concat(findLiquidFiles(fullPath));
      } else if (file.endsWith(".liquid")) {
        results.push(fullPath);
      }
    });
    return results;
  };
  
  const liquidFiles = findLiquidFiles(extDir);
  liquidFiles.forEach(filePath => {
    let content = fs.readFileSync(filePath, "utf8");
    let modified = false;
    
    // 1. Update const backendApiUrl line to fall back to the resolved appUrl
    const backendApiPattern = /const backendApiUrl\s*=\s*["']\{\{\s*block\.settings\.api_url\s*(?:\|\s*default:\s*['"][^'"]*['"])?\s*\}\}["'];/;
    if (backendApiPattern.test(content)) {
      content = content.replace(backendApiPattern, `const backendApiUrl = "{{ block.settings.api_url | default: '${appUrl}' }}";`);
      modified = true;
    }
    
    // 2. Update schema default value
    const schemaApiUrlPattern = /\{\s*["']type["']\s*:\s*["']text["']\s*,\s*["']id["']\s*:\s*["']api_url["']\s*,\s*["']label["']\s*:\s*["']Backend API URL["'](?:,\s*["']default["']\s*:\s*["'][^"']*["'])?\s*\}/;
    if (schemaApiUrlPattern.test(content)) {
      content = content.replace(schemaApiUrlPattern, `{\n      "type": "text",\n      "id": "api_url",\n      "label": "Backend API URL",\n      "default": "${appUrl}"\n    }`);
      modified = true;
    }
    
    if (modified) {
      fs.writeFileSync(filePath, content, "utf8");
      console.log(`[Build Script] Successfully synchronized API URLs in ${path.relative(appDir, filePath)}`);
    }
  });
}

// 1. Resolve DATABASE_URL from environment or local .env file
let r = process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.PRISMA_DATABASE_URL || process.env.POSTGRES_PRISMA_URL || process.env.POSTGRES_URL;

// If the environment contains censored/masked credentials from the CLI test runner, treat it as empty to force local .env fallback
if (r === "[SENSITIVE]" || r === "SENSITIVE") {
  r = "";
}

// We check the local project directory .env strictly to avoid root-level leakage
const p = path.join(appDir, ".env");

if (!r && fs.existsSync(p)) {
  const envContent = fs.readFileSync(p, "utf8");
  const lines = envContent.split(String.fromCharCode(10));
  const dLine = lines.find(l => {
    const trimmed = l.trim();
    return trimmed.startsWith("DATABASE_URL") && !trimmed.startsWith("#") && !trimmed.startsWith("//");
  });
  if (dLine) {
    let val = dLine.split("=").slice(1).join("=").trim();
    if (val.startsWith(String.fromCharCode(34)) || val.startsWith(String.fromCharCode(39))) val = val.substring(1, val.length - 1);
    r = val.split(String.fromCharCode(13))[0].trim();
  }
}

// 2. Append the schema parameter if a valid URL is resolved
if (r) {
  try {
    const u = new URL(r);
    u.searchParams.set("schema", "pet_profile");
    r = u.toString();
  } catch (e) {
    // If not a parseable URL, keep it as-is
  }
}

// 3. Set the resolved DATABASE_URL in the environment and run the build steps inside the app directory
const env = { ...process.env };
if (r) {
  env.DATABASE_URL = r;
}

try {
  // Sync liquid API URLs with TOML config
  syncLiquidApiUrls();

  // Run Shopify App Build
  console.log("[Build Script] Running shopify app build...");
  execSync("shopify app build", { stdio: "inherit", env, cwd: appDir });

  // Run Prisma Generate
  console.log("[Build Script] Running prisma generate...");
  execSync("prisma generate", { stdio: "inherit", env, cwd: appDir });
} catch (err) {
  console.error("[Build Script Error] Build step failed:", err.message);
  process.exit(1);
}

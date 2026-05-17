import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const publicDir = path.join(projectRoot, "public");
const logoSourcePath = path.join(projectRoot, "src", "assets", "MVD-Logo.jpg");
const logoTargetPath = path.join(publicDir, "og-image.jpg");
const siteUrl = "https://www.downvid.online";
const pagePaths = ["/"];
const now = new Date().toISOString();

const robots = `User-agent: *
Allow: /

Sitemap: ${siteUrl}/sitemap.xml
`;

const sitemapEntries = pagePaths
  .map((pagePath) => {
    const loc = new URL(pagePath, `${siteUrl}/`).toString();
    return `  <url>
    <loc>${loc}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>`;
  })
  .join("\n");

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries}
</urlset>
`;

const manifest = {
  name: "Downvid",
  short_name: "DVid",
  description: "Free no-login downloader for videos, images and music.",
  id: "/",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#000000",
  theme_color: "#000000",
  icons: [
    {
      src: "/og-image.jpg",
      sizes: "512x512",
      type: "image/jpeg"
    }
  ]
};

fs.mkdirSync(publicDir, { recursive: true });
fs.writeFileSync(path.join(publicDir, "robots.txt"), robots, "utf8");
fs.writeFileSync(path.join(publicDir, "sitemap.xml"), sitemap, "utf8");
fs.writeFileSync(path.join(publicDir, "site.webmanifest"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

if (fs.existsSync(logoSourcePath)) {
  fs.copyFileSync(logoSourcePath, logoTargetPath);
}

const googleVerificationFiles = fs
  .readdirSync(projectRoot)
  .filter((name) => /^google[a-z0-9]+\.html$/i.test(name));

for (const fileName of googleVerificationFiles) {
  const sourcePath = path.join(projectRoot, fileName);
  const destinationPath = path.join(publicDir, fileName);
  fs.copyFileSync(sourcePath, destinationPath);
}

console.log(`[seo] Generated robots.txt, sitemap.xml, site.webmanifest for ${siteUrl}`);

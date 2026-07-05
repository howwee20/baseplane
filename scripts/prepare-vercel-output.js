import fs from "node:fs";
import path from "node:path";

const publicDir = path.resolve("public");

fs.mkdirSync(publicDir, { recursive: true });
fs.writeFileSync(
  path.join(publicDir, "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Atoll Control API</title>
  </head>
  <body>
    <pre>Atoll Control API. Use /health, /version, or /api/*.</pre>
  </body>
</html>
`,
  "utf8"
);

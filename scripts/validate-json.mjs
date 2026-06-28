import { readFileSync } from "node:fs";

const files = [
  "package.json",
  "tsconfig.json",
  "schemas/config.schema.json"
];

for (const file of files) {
  JSON.parse(readFileSync(file, "utf8"));
  console.log(`ok ${file}`);
}

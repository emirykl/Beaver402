import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const currentDir = dirname(fileURLToPath(import.meta.url));

export function loadTestVectors() {
  const vectorsPath = resolve(currentDir, "../../../test-vectors/vectors.json");
  const raw = readFileSync(vectorsPath, "utf-8");
  return JSON.parse(raw);
}

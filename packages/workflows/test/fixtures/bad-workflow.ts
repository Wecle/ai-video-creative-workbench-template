// Deliberately violates the determinism boundary; only bundle.test.ts reads this file.
import "node:fs";

export async function badWorkflow(): Promise<void> {}

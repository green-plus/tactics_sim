import { buildMemory, simulatePolicy } from "./sim.js?v=20260617-context";

self.addEventListener("message", async (event) => {
  try {
    const { primeText, compositeText, additionalCompositeText, request } = event.data;
    const memory = buildMemory(primeText, compositeText, additionalCompositeText);
    const report = await simulatePolicy(memory, request);
    self.postMessage({ type: "result", report, stats: memory.stats });
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message || String(error) });
  }
});

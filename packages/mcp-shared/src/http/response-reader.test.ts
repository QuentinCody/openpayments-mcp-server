import { afterEach, expect, it, vi } from "vitest";
import { decodeResponseText, readResponseBytes } from "./response-reader";

afterEach(() => vi.useRealTimers());
const options = {label:"fixture",maxBytes:6,timeoutMs:100};
it("preserves split UTF-8 and binary bytes exactly at the limit", async () => {
  const source = new TextEncoder().encode("α🧬");
  const response = new Response(new ReadableStream({start(controller) { controller.enqueue(source.slice(0,3)); controller.enqueue(source.slice(3)); controller.close(); }}));
  const bytes = await readResponseBytes(response,options);
  expect(bytes).toEqual(source); expect(decodeResponseText(bytes,"fixture")).toBe("α🧬");
  expect(await readResponseBytes(new Response(new Uint8Array([0,255,128])),options)).toEqual(new Uint8Array([0,255,128]));
});
it.each([true,false])("cancels an oversized body (advertised length: %s)", async advertised => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(7));},cancel}),{headers:advertised?{"content-length":"7"}:{}});
  await expect(readResponseBytes(response,options)).rejects.toMatchObject({status:413});expect(cancel).toHaveBeenCalledOnce();
});
it("bounds a stalled read without waiting for stalled cancellation", async () => {
  vi.useFakeTimers(); const cancel = vi.fn(() => new Promise<void>(() => {}));
  const result = readResponseBytes(new Response(new ReadableStream({cancel})),options);
  const rejection = expect(result).rejects.toMatchObject({status:504});
  await vi.advanceTimersByTimeAsync(100); await rejection; expect(cancel).toHaveBeenCalledOnce();
});
it("retains BOM evidence and rejects malformed UTF-8 without substitution", () => {
  expect(decodeResponseText(new Uint8Array([239,187,191,65]),"fixture")).toBe("\uFEFFA");
  expect(() => decodeResponseText(new Uint8Array([255]),"fixture")).toThrow("not valid UTF-8");
});
it("handles absent bodies and an exhausted caller deadline", async () => {
  expect(await readResponseBytes(new Response(null,{status:204}),options)).toEqual(new Uint8Array());
  await expect(readResponseBytes(new Response("ok"),{...options,timeoutMs:0})).rejects.toMatchObject({status:504});
});
